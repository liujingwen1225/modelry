package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// RecordProjectionColumnDiff 描述一个 Physical Projection 列的差异。
type RecordProjectionColumnDiff struct {
	Column   string
	Field    string
	Required bool
	Expected string
	Actual   string
}

// RecordProjectionDiff 描述 Applied Model 与物理投影之间的差异。
type RecordProjectionDiff struct {
	TableMissing    bool
	MissingColumns  []RecordProjectionColumnDiff
	TypeMismatches  []RecordProjectionColumnDiff
	MissingIndexes  []string
	IndexTableEmpty bool
}

// HasDifferences 判断差异是否包含需要修复或人工处理的内容。
func (diff RecordProjectionDiff) HasDifferences() bool {
	return diff.TableMissing || len(diff.MissingColumns) > 0 || len(diff.TypeMismatches) > 0 || len(diff.MissingIndexes) > 0
}

func expectedProjectionColumns(collection RecordCollectionProjection) map[string]string {
	expected := map[string]string{"id": "TEXT", "createdAt": "TEXT", "updatedAt": "TEXT"}
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		column := RecordFieldColumnName(field.ID, field.Name, false)
		if column == "" {
			continue
		}
		expected[column] = sqliteAffinity(field.Type)
	}
	return expected
}

func expectedProjectionIndexes(collection RecordCollectionProjection) []string {
	names := make([]string, 0, len(collection.Fields)+len(collection.Indexes))
	for _, field := range collection.Fields {
		if field.System || !field.Unique {
			continue
		}
		if name := recordIndexName(collection.ID, field.ID, true); name != "" {
			names = append(names, name)
		}
	}
	for _, index := range collection.Indexes {
		if name := recordIndexName(collection.ID, index.ID, false); name != "" {
			names = append(names, name)
		}
	}
	return names
}

// DiffRecordProjection 比较 Applied Model 的期望投影与实际 SQLite 结构。
// 它只读取 sqlite_master 与 PRAGMA，不修改任何数据。
func DiffRecordProjection(ctx context.Context, query Executor, collection RecordCollectionProjection) (RecordProjectionDiff, error) {
	diff := RecordProjectionDiff{}
	tableName := RecordTableName(collection.ID)
	if tableName == "" {
		return diff, fmt.Errorf("Collection %q has no valid record projection", collection.ID)
	}
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		return diff, err
	}
	exists, err := RecordProjectionExists(ctx, query, collection.ID)
	if err != nil {
		return diff, err
	}
	if !exists {
		diff.TableMissing = true
		return diff, nil
	}
	actual := map[string]string{}
	rows, err := query.QueryContext(ctx, `PRAGMA table_info(`+quotedTable+`)`)
	if err != nil {
		return diff, fmt.Errorf("read Collection record projection columns: %w", err)
	}
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return diff, fmt.Errorf("read Collection record projection columns: %w", err)
		}
		actual[name] = columnType
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return diff, fmt.Errorf("read Collection record projection columns: %w", err)
	}
	rows.Close()

	expected := expectedProjectionColumns(collection)
	fieldNames := map[string]string{}
	requiredFields := map[string]bool{}
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		column := RecordFieldColumnName(field.ID, field.Name, false)
		fieldNames[column] = field.Name
		requiredFields[column] = field.Required
	}
	for column, expectedType := range expected {
		actualType, found := actual[column]
		if !found {
			diff.MissingColumns = append(diff.MissingColumns, RecordProjectionColumnDiff{
				Column: column, Field: fieldNames[column], Required: requiredFields[column], Expected: expectedType,
			})
			continue
		}
		if sqliteAffinityFromDeclared(actualType) != expectedType {
			diff.TypeMismatches = append(diff.TypeMismatches, RecordProjectionColumnDiff{
				Column: column, Field: fieldNames[column], Expected: expectedType, Actual: actualType,
			})
		}
	}

	actualIndexes := map[string]struct{}{}
	indexRows, err := query.QueryContext(ctx, `PRAGMA index_list(`+quotedTable+`)`)
	if err != nil {
		return diff, fmt.Errorf("read Collection record projection indexes: %w", err)
	}
	for indexRows.Next() {
		var seq, unique, partial int
		var name, origin string
		if err := indexRows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			indexRows.Close()
			return diff, fmt.Errorf("read Collection record projection indexes: %w", err)
		}
		actualIndexes[name] = struct{}{}
	}
	if err := indexRows.Err(); err != nil {
		indexRows.Close()
		return diff, fmt.Errorf("read Collection record projection indexes: %w", err)
	}
	indexRows.Close()
	for _, name := range expectedProjectionIndexes(collection) {
		if _, found := actualIndexes[name]; !found {
			diff.MissingIndexes = append(diff.MissingIndexes, name)
		}
	}
	if len(diff.MissingIndexes) > 0 {
		total, err := CountCollectionRecords(ctx, query, collection.ID)
		if err != nil {
			return diff, err
		}
		diff.IndexTableEmpty = total == 0
	}
	return diff, nil
}

func sqliteAffinityFromDeclared(declared string) string {
	upper := strings.ToUpper(strings.TrimSpace(declared))
	switch {
	case strings.Contains(upper, "INT"):
		return "INTEGER"
	case strings.Contains(upper, "CHAR"), strings.Contains(upper, "CLOB"), strings.Contains(upper, "TEXT"):
		return "TEXT"
	case strings.Contains(upper, "BLOB"):
		return "BLOB"
	case strings.Contains(upper, "REAL"), strings.Contains(upper, "FLOA"), strings.Contains(upper, "DOUB"):
		return "REAL"
	case strings.Contains(upper, "NUM"), strings.Contains(upper, "DEC"), strings.Contains(upper, "BOOL"), strings.Contains(upper, "DATE"):
		return "NUMERIC"
	default:
		return "NUMERIC"
	}
}

// AddMissingRecordProjectionColumns 只为 Applied Model 补齐缺失列。
// 它不删除任何列，也不修改已有列；非空且无默认值的 Required Field 在表非空时无法补齐，会返回 blocked。
func AddMissingRecordProjectionColumns(ctx context.Context, tx Executor, collection RecordCollectionProjection) (added []string, blocked []string, err error) {
	tableName := RecordTableName(collection.ID)
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		return nil, nil, err
	}
	exists, err := RecordProjectionExists(ctx, tx, collection.ID)
	if err != nil {
		return nil, nil, err
	}
	if !exists {
		return nil, nil, fmt.Errorf("Collection %q has no record projection to add columns to", collection.ID)
	}
	total, err := CountCollectionRecords(ctx, tx, collection.ID)
	if err != nil {
		return nil, nil, err
	}
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		column := RecordFieldColumnName(field.ID, field.Name, false)
		if column == "" {
			continue
		}
		quotedColumn, err := QuoteSQLiteIdentifier(column)
		if err != nil {
			return nil, nil, err
		}
		present, err := columnExists(ctx, tx, quotedTable, column)
		if err != nil {
			return nil, nil, err
		}
		if present {
			continue
		}
		if field.Required && total > 0 {
			blocked = append(blocked, column)
			continue
		}
		statement := "ALTER TABLE " + quotedTable + " ADD COLUMN " + quotedColumn + " " + sqliteAffinity(field.Type)
		if field.Required {
			statement += " NOT NULL"
		}
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return added, blocked, fmt.Errorf("add missing Collection record column: %w", err)
		}
		added = append(added, column)
	}
	return added, blocked, nil
}

func columnExists(ctx context.Context, query Executor, quotedTable, column string) (bool, error) {
	rows, err := query.QueryContext(ctx, `PRAGMA table_info(`+quotedTable+`)`)
	if err != nil {
		return false, fmt.Errorf("read Collection record projection columns: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, fmt.Errorf("read Collection record projection columns: %w", err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("read Collection record projection columns: %w", err)
	}
	return false, nil
}

// CreateMissingRecordProjectionIndexes 只创建 Applied Model 期望但缺失的索引。
func CreateMissingRecordProjectionIndexes(ctx context.Context, tx Executor, collection RecordCollectionProjection) (created []string, err error) {
	tableName := RecordTableName(collection.ID)
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		return nil, err
	}
	exists, err := RecordProjectionExists(ctx, tx, collection.ID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("Collection %q has no record projection to index", collection.ID)
	}
	present := map[string]struct{}{}
	rows, err := tx.QueryContext(ctx, `PRAGMA index_list(`+quotedTable+`)`)
	if err != nil {
		return nil, fmt.Errorf("read Collection record projection indexes: %w", err)
	}
	for rows.Next() {
		var seq, unique, partial int
		var name, origin string
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read Collection record projection indexes: %w", err)
		}
		present[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("read Collection record projection indexes: %w", err)
	}
	rows.Close()

	for _, field := range collection.Fields {
		if field.System || !field.Unique {
			continue
		}
		name := recordIndexName(collection.ID, field.ID, true)
		if _, found := present[name]; found || name == "" {
			continue
		}
		quotedIndex, err := QuoteSQLiteIdentifier(name)
		if err != nil {
			return created, err
		}
		quotedColumn, err := QuoteSQLiteIdentifier(RecordFieldColumnName(field.ID, field.Name, false))
		if err != nil {
			return created, err
		}
		if _, err := tx.ExecContext(ctx, "CREATE UNIQUE INDEX "+quotedIndex+" ON "+quotedTable+" ("+quotedColumn+")"); err != nil {
			if isDuplicateColumnIndexError(err) {
				continue
			}
			return created, fmt.Errorf("create missing unique Field index: %w", err)
		}
		created = append(created, name)
	}
	for _, index := range collection.Indexes {
		name := recordIndexName(collection.ID, index.ID, false)
		if _, found := present[name]; found || name == "" {
			continue
		}
		quotedIndex, err := QuoteSQLiteIdentifier(name)
		if err != nil {
			return created, err
		}
		columns := make([]string, 0, len(index.Fields))
		for _, fieldID := range index.Fields {
			field, found := projectionFieldByID(collection.Fields, fieldID)
			if !found || field.System {
				return created, fmt.Errorf("Index %q refers to a missing Field", index.Name)
			}
			quotedColumn, err := QuoteSQLiteIdentifier(RecordFieldColumnName(field.ID, field.Name, false))
			if err != nil {
				return created, err
			}
			columns = append(columns, quotedColumn)
		}
		kind := "CREATE INDEX "
		if index.Unique {
			kind = "CREATE UNIQUE INDEX "
		}
		if _, err := tx.ExecContext(ctx, kind+quotedIndex+" ON "+quotedTable+" ("+strings.Join(columns, ", ")+")"); err != nil {
			return created, fmt.Errorf("create missing schema Index: %w", err)
		}
		created = append(created, name)
	}
	return created, nil
}

func isDuplicateColumnIndexError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "duplicate") || strings.Contains(message, "already exists")
}

var _ = errors.Is