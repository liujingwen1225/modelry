package backendmodel

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var sqliteIdentifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// QuoteSQLiteIdentifier quotes only already-generated identifiers. It rejects
// arbitrary names so Records cannot turn user input into SQL syntax.
func QuoteSQLiteIdentifier(identifier string) (string, error) {
	if !sqliteIdentifierPattern.MatchString(identifier) {
		return "", fmt.Errorf("%w: unsafe SQLite projection identifier", ErrInvalidArgument)
	}
	return `"` + identifier + `"`, nil
}

func recordsTableName(collectionID string) string {
	if !validOpaqueID(collectionID, "col_") {
		return ""
	}
	return "mry_records_" + strings.TrimPrefix(collectionID, "col_")
}

func fieldColumnName(field Field) string {
	if field.System {
		return field.Name
	}
	if !validOpaqueID(field.ID, "fld_") {
		return ""
	}
	return "mry_field_" + strings.TrimPrefix(field.ID, "fld_")
}

func indexName(collectionID, indexID string, uniqueField bool) string {
	if !validOpaqueID(collectionID, "col_") {
		return ""
	}
	collectionKey := strings.TrimPrefix(collectionID, "col_")
	if uniqueField {
		if !validOpaqueID(indexID, "fld_") {
			return ""
		}
		return "mry_unique_" + collectionKey + "_" + strings.TrimPrefix(indexID, "fld_")
	}
	if !validOpaqueID(indexID, "idx_") {
		return ""
	}
	return "mry_index_" + collectionKey + "_" + strings.TrimPrefix(indexID, "idx_")
}

func createRecordProjection(ctx context.Context, tx storage.Executor, collection Collection, initial bool) error {
	tableName := recordsTableName(collection.ID)
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		return fmt.Errorf("build safe Collection record table: %w", err)
	}
	if !initial {
		return fmt.Errorf("%w: use a versioned projection rebuild for an applied Collection", ErrProjection)
	}
	statement, err := createTableStatement(tableName, collection)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("create Collection record projection %s: %w", quotedTable, err)
	}
	return createProjectionIndexes(ctx, tx, collection)
}

func rebuildRecordProjection(ctx context.Context, tx storage.Executor, previous, target Collection) error {
	tableName := recordsTableName(target.ID)
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		return fmt.Errorf("build safe Collection record table: %w", err)
	}
	tempID, err := newID("tmp_")
	if err != nil {
		return err
	}
	tempName := "mry_projection_" + strings.TrimPrefix(tempID, "tmp_")
	quotedTemp, err := QuoteSQLiteIdentifier(tempName)
	if err != nil {
		return fmt.Errorf("build safe temporary record table: %w", err)
	}
	createStatement, err := createTableStatement(tempName, target)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, createStatement); err != nil {
		return fmt.Errorf("prepare updated Collection record projection: %w", err)
	}

	insertColumns := []string{`"id"`, `"createdAt"`, `"updatedAt"`}
	selectExpressions := []string{`"id"`, `"createdAt"`, `"updatedAt"`}
	args := make([]any, 0)
	oldFields := make(map[string]Field, len(previous.Fields))
	for _, field := range previous.Fields {
		oldFields[field.ID] = field
	}
	for _, field := range target.Fields {
		if field.System {
			continue
		}
		columnName := fieldColumnName(field)
		quotedColumn, err := QuoteSQLiteIdentifier(columnName)
		if err != nil {
			return fmt.Errorf("build safe Field projection column: %w", err)
		}
		insertColumns = append(insertColumns, quotedColumn)
		if _, existed := oldFields[field.ID]; existed {
			selectExpressions = append(selectExpressions, quotedColumn)
			continue
		}
		if len(field.Default) > 0 {
			var value any
			decoder := json.NewDecoder(strings.NewReader(string(field.Default)))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil {
				return fmt.Errorf("decode schema default for projection: %w", err)
			}
			value, err = databaseDefaultValue(field, value)
			if err != nil {
				return err
			}
			selectExpressions = append(selectExpressions, "?")
			args = append(args, value)
		} else {
			selectExpressions = append(selectExpressions, "NULL")
		}
	}
	oldTable, err := QuoteSQLiteIdentifier(recordsTableName(previous.ID))
	if err != nil {
		return fmt.Errorf("build safe prior record table: %w", err)
	}
	copySQL := fmt.Sprintf("INSERT INTO %s (%s) SELECT %s FROM %s", quotedTemp, strings.Join(insertColumns, ", "), strings.Join(selectExpressions, ", "), oldTable)
	if _, err := tx.ExecContext(ctx, copySQL, args...); err != nil {
		return fmt.Errorf("copy existing Records into updated schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DROP TABLE "+quotedTable); err != nil {
		return fmt.Errorf("replace prior Collection record projection: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "ALTER TABLE "+quotedTemp+" RENAME TO "+quotedTable); err != nil {
		return fmt.Errorf("activate updated Collection record projection: %w", err)
	}
	return createProjectionIndexes(ctx, tx, target)
}

func databaseDefaultValue(field Field, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch field.Type {
	case FieldTypeJSON:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("encode JSON Field default: %w", err)
		}
		return string(encoded), nil
	case FieldTypeRelation:
		if field.Relation != nil && (field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many") {
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, fmt.Errorf("encode Relation Field default: %w", err)
			}
			return string(encoded), nil
		}
	case FieldTypeNumber:
		if number, ok := value.(json.Number); ok {
			parsed, err := number.Float64()
			if err != nil {
				return nil, fmt.Errorf("decode numeric Field default: %w", err)
			}
			return parsed, nil
		}
	}
	return value, nil
}

func createTableStatement(tableName string, collection Collection) (string, error) {
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		return "", err
	}
	columns := []string{`"id" TEXT PRIMARY KEY NOT NULL`, `"createdAt" TEXT NOT NULL`, `"updatedAt" TEXT NOT NULL`}
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		quotedColumn, err := QuoteSQLiteIdentifier(fieldColumnName(field))
		if err != nil {
			return "", fmt.Errorf("build safe Field column: %w", err)
		}
		column := quotedColumn + " " + sqliteAffinity(field.Type)
		if field.Required {
			column += " NOT NULL"
		}
		columns = append(columns, column)
	}
	return "CREATE TABLE " + quotedTable + " (" + strings.Join(columns, ", ") + ")", nil
}

func sqliteAffinity(fieldType FieldType) string {
	switch fieldType {
	case FieldTypeNumber:
		return "NUMERIC"
	case FieldTypeBoolean:
		return "INTEGER"
	case FieldTypeText, FieldTypeDateTime, FieldTypeJSON, FieldTypeRelation, FieldTypeFile:
		return "TEXT"
	default:
		return "BLOB"
	}
}

func createProjectionIndexes(ctx context.Context, tx storage.Executor, collection Collection) error {
	for _, field := range collection.Fields {
		if field.System || !field.Unique {
			continue
		}
		indexID := indexName(collection.ID, field.ID, true)
		quotedIndex, err := QuoteSQLiteIdentifier(indexID)
		if err != nil {
			return fmt.Errorf("build safe unique Field index: %w", err)
		}
		quotedTable, err := QuoteSQLiteIdentifier(recordsTableName(collection.ID))
		if err != nil {
			return err
		}
		quotedColumn, err := QuoteSQLiteIdentifier(fieldColumnName(field))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "CREATE UNIQUE INDEX "+quotedIndex+" ON "+quotedTable+" ("+quotedColumn+")"); err != nil {
			return fmt.Errorf("project unique Field %q: %w", field.Name, err)
		}
	}
	for _, index := range collection.Indexes {
		indexID := indexName(collection.ID, index.ID, false)
		quotedIndex, err := QuoteSQLiteIdentifier(indexID)
		if err != nil {
			return fmt.Errorf("build safe schema Index: %w", err)
		}
		quotedTable, err := QuoteSQLiteIdentifier(recordsTableName(collection.ID))
		if err != nil {
			return err
		}
		columns := make([]string, 0, len(index.Fields))
		for _, fieldID := range index.Fields {
			field, found := fieldByID(collection.Fields, fieldID)
			if !found || field.System {
				return fmt.Errorf("%w: Index %q refers to a missing Field", ErrInvalidArgument, index.Name)
			}
			quotedColumn, err := QuoteSQLiteIdentifier(fieldColumnName(field))
			if err != nil {
				return err
			}
			columns = append(columns, quotedColumn)
		}
		kind := "CREATE INDEX "
		if index.Unique {
			kind = "CREATE UNIQUE INDEX "
		}
		if _, err := tx.ExecContext(ctx, kind+quotedIndex+" ON "+quotedTable+" ("+strings.Join(columns, ", ")+")"); err != nil {
			return fmt.Errorf("project schema Index %q: %w", index.Name, err)
		}
	}
	return nil
}

func fieldByID(fields []Field, id string) (Field, bool) {
	for _, field := range fields {
		if field.ID == id {
			return field, true
		}
	}
	return Field{}, false
}

func countCollectionRecords(ctx context.Context, query storage.Executor, collectionID string) (int64, error) {
	quotedTable, err := QuoteSQLiteIdentifier(recordsTableName(collectionID))
	if err != nil {
		return 0, err
	}
	var count int64
	if err := query.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quotedTable).Scan(&count); err != nil {
		return 0, fmt.Errorf("count Records in Collection: %w", err)
	}
	return count, nil
}

func uniqueConflictCount(ctx context.Context, query storage.Executor, collection Collection) (int64, error) {
	var total int64
	quotedTable, err := QuoteSQLiteIdentifier(recordsTableName(collection.ID))
	if err != nil {
		return 0, err
	}
	check := func(columns []string) error {
		quotedColumns := make([]string, 0, len(columns))
		for _, column := range columns {
			quoted, err := QuoteSQLiteIdentifier(column)
			if err != nil {
				return err
			}
			quotedColumns = append(quotedColumns, quoted)
		}
		nullFilter := make([]string, 0, len(quotedColumns))
		for _, column := range quotedColumns {
			nullFilter = append(nullFilter, column+" IS NOT NULL")
		}
		querySQL := "SELECT COUNT(*) FROM (SELECT " + strings.Join(quotedColumns, ", ") + " FROM " + quotedTable + " WHERE " + strings.Join(nullFilter, " AND ") + " GROUP BY " + strings.Join(quotedColumns, ", ") + " HAVING COUNT(*) > 1)"
		var conflicts int64
		if err := query.QueryRowContext(ctx, querySQL).Scan(&conflicts); err != nil {
			return err
		}
		total += conflicts
		return nil
	}
	for _, field := range collection.Fields {
		if !field.System && field.Unique {
			if err := check([]string{fieldColumnName(field)}); err != nil {
				return total, fmt.Errorf("check unique Field values: %w", err)
			}
		}
	}
	for _, index := range collection.Indexes {
		if index.Unique {
			columns := make([]string, 0, len(index.Fields))
			for _, fieldID := range index.Fields {
				field, found := fieldByID(collection.Fields, fieldID)
				if !found {
					return total, fmt.Errorf("%w: Index %q has a missing Field", ErrInvalidArgument, index.Name)
				}
				columns = append(columns, fieldColumnName(field))
			}
			if err := check(columns); err != nil {
				return total, fmt.Errorf("check unique Index values: %w", err)
			}
		}
	}
	return total, nil
}

func projectionExists(ctx context.Context, query storage.Executor, collectionID string) (bool, error) {
	var name string
	err := query.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, recordsTableName(collectionID)).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check Collection record projection: %w", err)
	}
	return name != "", nil
}
