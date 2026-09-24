package records

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	defaultLimit = 50
	maximumLimit = 100
)

type sortField struct {
	name       string
	descending bool
}

type listCursor struct {
	CollectionID string            `json:"c"`
	Sort         []string          `json:"s"`
	Values       []json.RawMessage `json:"v"`
}

func (service *Service) List(ctx context.Context, collectionID string, options ListOptions) (Page, error) {
	limit := options.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	if limit < 1 || limit > maximumLimit {
		return Page{}, fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalidArgument, maximumLimit)
	}
	if len(options.Search) > 256 {
		return Page{}, fmt.Errorf("%w: search must be at most 256 characters", ErrInvalidArgument)
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Page{}, err
	}
	sorts, err := parseSort(model, options.Sort)
	if err != nil {
		return Page{}, err
	}
	filters, err := parseFilter(model, options.Filter)
	if err != nil {
		return Page{}, err
	}
	var after listCursor
	if options.Cursor != "" {
		after, err = decodeListCursor(options.Cursor)
		if err != nil {
			return Page{}, err
		}
		if after.CollectionID != collectionID || !sameSort(after.Sort, sorts) || len(after.Values) != cursorValueCount(sorts) {
			return Page{}, fmt.Errorf("%w: cursor does not belong to this Collection query", ErrInvalidArgument)
		}
	}
	page := Page{Data: make([]Record, 0, limit)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := verifyModel(ctx, snapshot, model); err != nil {
			return err
		}
		where, args, err := compileWhere(model, options.Search, filters)
		if err != nil {
			return err
		}
		if options.Cursor != "" {
			clause, cursorArgs, err := compileAfterCursor(model, sorts, after)
			if err != nil {
				return err
			}
			if where != "" {
				where += " AND "
			}
			where += clause
			args = append(args, cursorArgs...)
		}
		table, err := backendmodel.QuoteSQLiteIdentifier(model.projection.TableName)
		if err != nil {
			return err
		}
		columns, err := projectionColumns(model)
		if err != nil {
			return err
		}
		order, err := compileOrder(model, sorts)
		if err != nil {
			return err
		}
		query := `SELECT ` + strings.Join(columns, ", ") + ` FROM ` + table
		if where != "" {
			query += ` WHERE ` + where
		}
		query += ` ORDER BY ` + order + ` LIMIT ?`
		args = append(args, limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("list Records: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			record, err := scanRecord(rows, model)
			if err != nil {
				return err
			}
			page.Data = append(page.Data, record)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("finish listing Records: %w", err)
		}
		if len(page.Data) > limit {
			last := page.Data[limit-1]
			page.Data = page.Data[:limit]
			page.NextCursor, err = encodeListCursor(collectionID, sorts, cursorValues(last, sorts))
			if err != nil {
				return err
			}
		}
		return nil
	})
	return page, err
}

func parseSort(model appliedModel, raw string) ([]sortField, error) {
	if strings.TrimSpace(raw) == "" {
		return []sortField{{name: "createdAt", descending: true}, {name: "id", descending: true}}, nil
	}
	parts := strings.Split(raw, ",")
	result := make([]sortField, 0, len(parts)+1)
	seen := make(map[string]bool)
	for _, part := range parts {
		bits := strings.Fields(strings.TrimSpace(part))
		if len(bits) < 1 || len(bits) > 2 {
			return nil, fmt.Errorf("%w: sort entries use 'field [asc|desc]'", ErrInvalidArgument)
		}
		name := bits[0]
		if _, ok := model.byName[name]; !ok {
			return nil, fmt.Errorf("%w: sort field %q is not in the Applied Model", ErrInvalidArgument, name)
		}
		if seen[name] {
			return nil, fmt.Errorf("%w: sort field %q is repeated", ErrInvalidArgument, name)
		}
		seen[name] = true
		field := sortField{name: name}
		if len(bits) == 2 {
			switch strings.ToLower(bits[1]) {
			case "asc":
			case "desc":
				field.descending = true
			default:
				return nil, fmt.Errorf("%w: sort direction must be asc or desc", ErrInvalidArgument)
			}
		}
		result = append(result, field)
	}
	if !seen["id"] {
		result = append(result, sortField{name: "id"})
	}
	return result, nil
}

type filterExpression struct {
	field    backendmodel.ProjectedField
	operator string
	value    any
}

func parseFilter(model appliedModel, raw string) ([]filterExpression, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	space := strings.IndexAny(raw, " \t")
	if space <= 0 {
		return nil, fmt.Errorf("%w: filter uses 'field operator JSON-value'", ErrInvalidArgument)
	}
	name := raw[:space]
	remainder := strings.TrimSpace(raw[space:])
	operatorEnd := strings.IndexAny(remainder, " \t")
	if operatorEnd <= 0 {
		return nil, fmt.Errorf("%w: filter uses 'field operator JSON-value'", ErrInvalidArgument)
	}
	field, ok := model.byName[name]
	if !ok {
		return nil, fmt.Errorf("%w: filter field %q is not in the Applied Model", ErrInvalidArgument, name)
	}
	operator := strings.ToLower(remainder[:operatorEnd])
	switch operator {
	case "eq", "ne", "gt", "gte", "lt", "lte", "contains":
	default:
		return nil, fmt.Errorf("%w: unsupported filter operator %q", ErrInvalidArgument, operator)
	}
	encoded := strings.TrimSpace(remainder[operatorEnd:])
	if err := validateFilterOperator(field, operator); err != nil {
		return nil, err
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: filter value must be a JSON scalar", ErrInvalidArgument)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: filter value must be one JSON scalar", ErrInvalidArgument)
	}
	if err := requireJSONScalar(value); err != nil {
		return nil, fmt.Errorf("%w: filter value must be a JSON scalar", ErrInvalidArgument)
	}
	if _, err := databaseValue(field, value); err != nil {
		return nil, fmt.Errorf("%w: invalid filter value for %q", ErrInvalidArgument, name)
	}
	if err := validateFilterValue(field, value); err != nil {
		return nil, err
	}
	return []filterExpression{{field: field, operator: operator, value: value}}, nil
}

func validateFilterValue(field backendmodel.ProjectedField, value any) error {
	valid := false
	switch field.Type {
	case backendmodel.FieldTypeText, backendmodel.FieldTypeDateTime, backendmodel.FieldTypeFile:
		_, valid = value.(string)
	case backendmodel.FieldTypeNumber:
		switch number := value.(type) {
		case json.Number:
			_, err := number.Float64()
			valid = err == nil
		case float64:
			valid = true
		}
	case backendmodel.FieldTypeBoolean:
		_, valid = value.(bool)
	case backendmodel.FieldTypeRelation:
		if field.Relation != nil && (field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many") {
			valid = true
		} else {
			_, valid = value.(string)
		}
	case backendmodel.FieldTypeJSON:
		valid = true
	}
	if value == nil {
		valid = true
	}
	if !valid {
		return fmt.Errorf("%w: filter value type does not match field %q", ErrInvalidArgument, field.Name)
	}
	if field.Type == backendmodel.FieldTypeDateTime {
		if value == nil {
			return nil
		}
		if _, err := time.Parse(time.RFC3339Nano, value.(string)); err != nil {
			return fmt.Errorf("%w: date-time filter value must be RFC 3339", ErrInvalidArgument)
		}
	}
	return nil
}

func validateFilterOperator(field backendmodel.ProjectedField, operator string) error {
	if operator == "contains" && field.Type != backendmodel.FieldTypeText {
		return fmt.Errorf("%w: contains is only supported for text fields", ErrInvalidArgument)
	}
	if operator == "gt" || operator == "gte" || operator == "lt" || operator == "lte" {
		if field.Type != backendmodel.FieldTypeText && field.Type != backendmodel.FieldTypeNumber && field.Type != backendmodel.FieldTypeDateTime {
			return fmt.Errorf("%w: ordered comparisons are not supported for %s fields", ErrInvalidArgument, field.Type)
		}
	}
	return nil
}

func requireJSONScalar(value any) error {
	switch value.(type) {
	case nil, string, bool, json.Number:
		return nil
	default:
		return fmt.Errorf("not scalar")
	}
}

func compileWhere(model appliedModel, search string, filters []filterExpression) (string, []any, error) {
	clauses := make([]string, 0, 2)
	args := make([]any, 0)
	if search != "" {
		quotedID, err := backendmodel.QuoteSQLiteIdentifier("id")
		if err != nil {
			return "", nil, err
		}
		searchColumns := []string{quotedID}
		for _, field := range model.projection.Fields {
			if field.Type != backendmodel.FieldTypeText || field.System {
				continue
			}
			column, err := backendmodel.QuoteSQLiteIdentifier(field.ColumnName)
			if err != nil {
				return "", nil, err
			}
			searchColumns = append(searchColumns, column)
		}
		parts := make([]string, 0, len(searchColumns))
		needle := "%" + escapeLike(search) + "%"
		for range searchColumns {
			parts = append(parts, `CAST(`+searchColumns[len(parts)]+` AS TEXT) LIKE ? ESCAPE '\' COLLATE NOCASE`)
			args = append(args, needle)
		}
		clauses = append(clauses, `(`+strings.Join(parts, " OR ")+`)`)
	}
	for _, filter := range filters {
		column, err := backendmodel.QuoteSQLiteIdentifier(filter.field.ColumnName)
		if err != nil {
			return "", nil, err
		}
		value, err := databaseValue(filter.field, filter.value)
		if err != nil {
			return "", nil, err
		}
		if filter.operator == "contains" {
			clauses = append(clauses, `CAST(`+column+` AS TEXT) LIKE ? ESCAPE '\' COLLATE NOCASE`)
			args = append(args, "%"+escapeLike(filter.value.(string))+"%")
			continue
		}
		operator := map[string]string{"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[filter.operator]
		if value == nil {
			if filter.operator == "eq" {
				clauses = append(clauses, column+" IS NULL")
			} else if filter.operator == "ne" {
				clauses = append(clauses, column+" IS NOT NULL")
			} else {
				return "", nil, fmt.Errorf("%w: null supports only eq and ne filters", ErrInvalidArgument)
			}
			continue
		}
		clauses = append(clauses, column+" "+operator+" ?")
		args = append(args, value)
	}
	return strings.Join(clauses, " AND "), args, nil
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func compileOrder(model appliedModel, sorts []sortField) (string, error) {
	parts := make([]string, 0, len(sorts))
	for _, item := range sorts {
		field, ok := model.byName[item.name]
		if !ok {
			return "", fmt.Errorf("%w: invalid sort field", ErrInvalidArgument)
		}
		column, err := backendmodel.QuoteSQLiteIdentifier(field.ColumnName)
		if err != nil {
			return "", err
		}
		direction := " ASC"
		if item.descending {
			direction = " DESC"
		}
		parts = append(parts, column+direction)
	}
	return strings.Join(parts, ", "), nil
}

func cursorValueCount(sorts []sortField) int { return len(sorts) }

func sameSort(encoded []string, parsed []sortField) bool {
	if len(encoded) != len(parsed) {
		return false
	}
	for index, item := range parsed {
		want := item.name + " asc"
		if item.descending {
			want = item.name + " desc"
		}
		if encoded[index] != want {
			return false
		}
	}
	return true
}

func normalizedSort(sorts []sortField) []string {
	values := make([]string, len(sorts))
	for index, item := range sorts {
		values[index] = item.name + " asc"
		if item.descending {
			values[index] = item.name + " desc"
		}
	}
	return values
}

func encodeListCursor(collectionID string, sorts []sortField, values []any) (string, error) {
	encodedValues := make([]json.RawMessage, len(values))
	for index, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", fmt.Errorf("encode Record cursor value: %w", err)
		}
		encodedValues[index] = encoded
	}
	payload, err := json.Marshal(listCursor{CollectionID: collectionID, Sort: normalizedSort(sorts), Values: encodedValues})
	if err != nil {
		return "", fmt.Errorf("encode Record cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeListCursor(raw string) (listCursor, error) {
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return listCursor{}, fmt.Errorf("%w: cursor is invalid", ErrInvalidArgument)
	}
	var cursor listCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.CollectionID == "" || len(cursor.Sort) == 0 {
		return listCursor{}, fmt.Errorf("%w: cursor is invalid", ErrInvalidArgument)
	}
	return cursor, nil
}

func cursorValues(record Record, sorts []sortField) []any {
	values := make([]any, len(sorts))
	for index, item := range sorts {
		if item.name == "id" {
			values[index] = record.ID
		} else if item.name == "createdAt" {
			values[index] = record.CreatedAt
		} else if item.name == "updatedAt" {
			values[index] = record.UpdatedAt
		} else {
			values[index] = record.Values[item.name]
		}
	}
	return values
}

func compileAfterCursor(model appliedModel, sorts []sortField, cursor listCursor) (string, []any, error) {
	values := make([]any, len(cursor.Values))
	for index, raw := range cursor.Values {
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.UseNumber()
		if err := decoder.Decode(&values[index]); err != nil {
			return "", nil, fmt.Errorf("%w: cursor value is invalid", ErrInvalidArgument)
		}
	}
	branches := make([]string, 0, len(sorts))
	args := make([]any, 0, len(sorts)*len(sorts))
	for index, item := range sorts {
		field := model.byName[item.name]
		column, err := backendmodel.QuoteSQLiteIdentifier(field.ColumnName)
		if err != nil {
			return "", nil, err
		}
		parts := make([]string, 0, index+1)
		branchArgs := make([]any, 0, index+1)
		for prior := 0; prior < index; prior++ {
			priorField := model.byName[sorts[prior].name]
			priorColumn, err := backendmodel.QuoteSQLiteIdentifier(priorField.ColumnName)
			if err != nil {
				return "", nil, err
			}
			if values[prior] == nil {
				parts = append(parts, priorColumn+" IS NULL")
			} else {
				priorValue, err := databaseValue(priorField, values[prior])
				if err != nil {
					return "", nil, fmt.Errorf("%w: cursor value type is invalid", ErrInvalidArgument)
				}
				parts = append(parts, priorColumn+" = ?")
				branchArgs = append(branchArgs, priorValue)
			}
		}
		if values[index] == nil {
			// SQLite 在升序时将 NULL 排在前面、降序时排在后面；后续排序字段仍用于打破平局。
			continue
		}
		value, err := databaseValue(field, values[index])
		if err != nil {
			return "", nil, fmt.Errorf("%w: cursor value type is invalid", ErrInvalidArgument)
		}
		op := ">"
		if item.descending {
			op = "<"
		}
		parts = append(parts, column+" "+op+" ?")
		branchArgs = append(branchArgs, value)
		branches = append(branches, "("+strings.Join(parts, " AND ")+")")
		args = append(args, branchArgs...)
	}
	if len(branches) == 0 {
		return "", nil, fmt.Errorf("%w: cursor has no sortable values", ErrInvalidArgument)
	}
	return "(" + strings.Join(branches, " OR ") + ")", args, nil
}

// parseQueryValues 在路由处理器将 URL 查询参数转换为 ListOptions 前先完成校验。
func parseQueryValues(query url.Values) (ListOptions, error) {
	options := ListOptions{Limit: defaultLimit, Cursor: query.Get("cursor"), Search: query.Get("search"), Filter: query.Get("filter"), Sort: query.Get("sort")}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			return ListOptions{}, fmt.Errorf("%w: limit must be an integer", ErrInvalidArgument)
		}
		options.Limit = limit
	}
	return options, nil
}
