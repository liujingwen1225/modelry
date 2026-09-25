package records

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func getRecord(ctx context.Context, query storage.Executor, model appliedModel, recordID string) (Record, error) {
	if recordID == "" {
		return Record{}, fmt.Errorf("%w: Record ID is required", ErrInvalidArgument)
	}
	table, err := storage.QuoteSQLiteIdentifier(model.projection.TableName)
	if err != nil {
		return Record{}, err
	}
	columns, err := projectionColumns(model)
	if err != nil {
		return Record{}, err
	}
	row := query.QueryRowContext(ctx, `SELECT `+strings.Join(columns, ", ")+` FROM `+table+` WHERE "id" = ?`, recordID)
	record, err := scanRecord(row, model)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, fmt.Errorf("%w: Record does not exist", ErrNotFound)
	}
	return record, err
}

type scanner interface {
	Scan(...any) error
}

func scanRecord(row scanner, model appliedModel) (Record, error) {
	fields := model.projection.Fields
	values := make([]any, len(fields))
	for index := range values {
		values[index] = new(any)
	}
	if err := row.Scan(values...); err != nil {
		return Record{}, err
	}
	result := Record{Values: make(map[string]any, max(0, len(fields)-3))}
	for index, field := range fields {
		if field.System {
			switch field.Name {
			case "id":
				result.ID = textValue(*(values[index].(*any)))
			case "createdAt":
				result.CreatedAt = textValue(*(values[index].(*any)))
			case "updatedAt":
				result.UpdatedAt = textValue(*(values[index].(*any)))
			}
			continue
		}
		value, err := decodeField(field, *(values[index].(*any)))
		if err != nil {
			return Record{}, fmt.Errorf("decode Record Field %q: %w", field.Name, err)
		}
		result.Values[field.Name] = value
	}
	return result, nil
}

func projectionColumns(model appliedModel) ([]string, error) {
	columns := make([]string, 0, len(model.projection.Fields))
	for _, field := range model.projection.Fields {
		column, err := storage.QuoteSQLiteIdentifier(field.ColumnName)
		if err != nil {
			return nil, fmt.Errorf("build safe Record projection column: %w", err)
		}
		columns = append(columns, column)
	}
	return columns, nil
}

func insertStatement(model appliedModel, record Record) (string, []any, error) {
	table, err := storage.QuoteSQLiteIdentifier(model.projection.TableName)
	if err != nil {
		return "", nil, err
	}
	columns, err := projectionColumns(model)
	if err != nil {
		return "", nil, err
	}
	args := make([]any, 0, len(columns))
	for _, field := range model.projection.Fields {
		var value any
		switch field.Name {
		case "id":
			value = record.ID
		case "createdAt":
			value = record.CreatedAt
		case "updatedAt":
			value = record.UpdatedAt
		default:
			var found bool
			value, found = record.Values[field.Name]
			if !found {
				value = nil
			}
			value, err = databaseValue(field, value)
			if err != nil {
				return "", nil, err
			}
		}
		args = append(args, value)
	}
	plah := make([]string, len(columns))
	for index := range columns {
		plah[index] = "?"
	}
	return `INSERT INTO ` + table + ` (` + strings.Join(columns, ", ") + `) VALUES (` + strings.Join(plah, ", ") + `)`, args, nil
}

func updateStatement(model appliedModel, record Record) (string, []any, error) {
	table, err := storage.QuoteSQLiteIdentifier(model.projection.TableName)
	if err != nil {
		return "", nil, err
	}
	assignments := make([]string, 0, len(model.projection.Fields)-1)
	args := make([]any, 0, len(model.projection.Fields))
	for _, field := range model.projection.Fields {
		if field.System && field.Name != "updatedAt" {
			continue
		}
		column, err := storage.QuoteSQLiteIdentifier(field.ColumnName)
		if err != nil {
			return "", nil, err
		}
		assignments = append(assignments, column+" = ?")
		if field.Name == "updatedAt" {
			args = append(args, record.UpdatedAt)
			continue
		}
		value, err := databaseValue(field, record.Values[field.Name])
		if err != nil {
			return "", nil, err
		}
		args = append(args, value)
	}
	args = append(args, record.ID)
	return `UPDATE ` + table + ` SET ` + strings.Join(assignments, ", ") + ` WHERE "id" = ?`, args, nil
}

func databaseValue(field backendmodel.ProjectedField, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch field.Type {
	case backendmodel.FieldTypeJSON:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("encode JSON Field %q: %w", field.Name, err)
		}
		return string(encoded), nil
	case backendmodel.FieldTypeRelation:
		if field.Relation != nil && (field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many") {
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, fmt.Errorf("encode Relation Field %q: %w", field.Name, err)
			}
			return string(encoded), nil
		}
	case backendmodel.FieldTypeFiles:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("encode files Field %q: %w", field.Name, err)
		}
		return string(encoded), nil
	case backendmodel.FieldTypeNumber:
		if number, ok := value.(json.Number); ok {
			parsed, err := number.Float64()
			if err != nil {
				return nil, fmt.Errorf("decode numeric Field %q: %w", field.Name, err)
			}
			return parsed, nil
		}
	case backendmodel.FieldTypeBoolean:
		if boolean, ok := value.(bool); ok {
			if boolean {
				return 1, nil
			}
			return 0, nil
		}
	}
	return value, nil
}

func decodeField(field backendmodel.ProjectedField, stored any) (any, error) {
	if stored == nil {
		return nil, nil
	}
	switch field.Type {
	case backendmodel.FieldTypeJSON:
		var value any
		decoder := json.NewDecoder(strings.NewReader(textValue(stored)))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		return value, nil
	case backendmodel.FieldTypeRelation:
		if field.Relation != nil && (field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many") {
			var values []any
			decoder := json.NewDecoder(strings.NewReader(textValue(stored)))
			decoder.UseNumber()
			if err := decoder.Decode(&values); err != nil {
				return nil, err
			}
			return values, nil
		}
		return textValue(stored), nil
	case backendmodel.FieldTypeFiles:
		var values []any
		decoder := json.NewDecoder(strings.NewReader(textValue(stored)))
		decoder.UseNumber()
		if err := decoder.Decode(&values); err != nil {
			return nil, err
		}
		return values, nil
	case backendmodel.FieldTypeNumber:
		switch value := stored.(type) {
		case int64:
			return json.Number(fmt.Sprint(value)), nil
		case float64:
			return json.Number(fmt.Sprint(value)), nil
		default:
			return nil, fmt.Errorf("unexpected SQLite numeric value %T", stored)
		}
	case backendmodel.FieldTypeBoolean:
		value, ok := stored.(int64)
		if !ok {
			return nil, fmt.Errorf("unexpected SQLite boolean value %T", stored)
		}
		return value != 0, nil
	default:
		return textValue(stored), nil
	}
}

func textValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprint(value)
	}
}

func mapWriteError(err error) error {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "unique constraint") || strings.Contains(message, "is not unique") {
		return fmt.Errorf("%w: a Record Field value must be unique", ErrConflict)
	}
	return fmt.Errorf("write Record: %w", err)
}

// 编译期约束：读写辅助方法只通过有界 Store 事务访问持久层。
var _ transactionalStore = (*storage.Store)(nil)
