package requests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	defaultLimit = 50
	maximumLimit = 100
)

type sortField struct {
	name       string
	column     string
	descending bool
	kind       scalarKind
}

type scalarKind uint8

const (
	stringKind scalarKind = iota
	integerKind
	timeKind
)

type filterSpec struct {
	field    sortField
	operator string
	value    any
}

type listCursor struct {
	Search string            `json:"q"`
	Filter string            `json:"f"`
	Sort   []string          `json:"s"`
	Values []json.RawMessage `json:"v"`
}

func (service *Service) Get(ctx context.Context, requestID string) (RequestRecord, error) {
	if !requestIDPattern.MatchString(requestID) {
		return RequestRecord{}, ErrNotFound
	}
	var result RequestRecord
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var err error
		result, err = scanRecord(snapshot.QueryRowContext(ctx, requestRecordSelect+` WHERE request_id = ?`, requestID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return RequestRecord{}, ErrNotFound
		}
		return RequestRecord{}, fmt.Errorf("%w: read Request Detail: %v", ErrStorage, err)
	}
	return result, nil
}

const requestRecordSelect = `SELECT request_id, occurred_at, occurred_unix_nano, collection_id, endpoint, method, status,
	duration_ms, response_size_bytes, authentication_outcome, authorization_outcome, error_code FROM modelry_request_records`

func scanRecord(row interface{ Scan(...any) error }) (RequestRecord, error) {
	var record RequestRecord
	var timestamp string
	var responseSizeBytes sql.NullInt64
	if err := row.Scan(&record.RequestID, &timestamp, &record.occurredAtUnixNano, &record.CollectionID, &record.Endpoint,
		&record.Method, &record.Status, &record.DurationMS, &responseSizeBytes, &record.AuthenticationOutcome, &record.AuthorizationOutcome, &record.ErrorCode); err != nil {
		return RequestRecord{}, err
	}
	if responseSizeBytes.Valid {
		value := responseSizeBytes.Int64
		record.ResponseSizeBytes = &value
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return RequestRecord{}, fmt.Errorf("decode RequestRecord time: %w", err)
	}
	record.Time = parsed.UTC()
	return record, nil
}

func (service *Service) List(ctx context.Context, options ListOptions) (Page, error) {
	limit := options.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	if limit < 1 || limit > maximumLimit || len(options.Search) > 256 || len(options.Filter) > 512 {
		return Page{}, ErrInvalidArgument
	}
	sorts, err := parseSort(options.Sort)
	if err != nil {
		return Page{}, err
	}
	filter, err := parseFilter(options.Filter)
	if err != nil {
		return Page{}, err
	}
	var after listCursor
	if options.Cursor != "" {
		after, err = decodeCursor(options.Cursor)
		if err != nil || after.Search != options.Search || after.Filter != options.Filter || !sameCursorSort(after.Sort, sorts) || len(after.Values) != len(sorts) {
			return Page{}, ErrInvalidArgument
		}
	}

	conditions := make([]string, 0, 3)
	args := make([]any, 0, 12)
	if options.Search != "" {
		pattern := "%" + escapeLike(strings.ToLower(options.Search)) + "%"
		conditions = append(conditions, `(lower(request_id) LIKE ? ESCAPE '\' OR lower(collection_id) LIKE ? ESCAPE '\' OR
			lower(endpoint) LIKE ? ESCAPE '\' OR lower(method) LIKE ? ESCAPE '\' OR
			lower(authentication_outcome) LIKE ? ESCAPE '\' OR lower(authorization_outcome) LIKE ? ESCAPE '\' OR
			lower(error_code) LIKE ? ESCAPE '\')`)
		for range 7 {
			args = append(args, pattern)
		}
	}
	if filter != nil {
		clause, value, err := compileFilter(*filter)
		if err != nil {
			return Page{}, err
		}
		conditions = append(conditions, clause)
		if value != nil {
			args = append(args, value)
		}
	}
	if options.Cursor != "" {
		clause, cursorArgs, err := compileCursor(sorts, after.Values)
		if err != nil {
			return Page{}, err
		}
		conditions = append(conditions, clause)
		args = append(args, cursorArgs...)
	}
	query := requestRecordSelect
	if len(conditions) != 0 {
		query += ` WHERE ` + strings.Join(conditions, ` AND `)
	}
	order := make([]string, len(sorts))
	for index, field := range sorts {
		direction := `ASC`
		if field.descending {
			direction = `DESC`
		}
		order[index] = field.column + ` ` + direction
	}
	query += ` ORDER BY ` + strings.Join(order, `, `) + ` LIMIT ?`
	args = append(args, limit+1)
	page := Page{Data: make([]RequestRecord, 0, limit)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			record, err := scanRecord(rows)
			if err != nil {
				return err
			}
			page.Data = append(page.Data, record)
		}
		return rows.Err()
	})
	if err != nil {
		return Page{}, fmt.Errorf("%w: list RequestRecords: %v", ErrStorage, err)
	}
	if len(page.Data) > limit {
		page.Data = page.Data[:limit]
		page.NextCursor, err = encodeCursor(options.Search, options.Filter, sorts, page.Data[len(page.Data)-1])
		if err != nil {
			return Page{}, err
		}
	}
	return page, nil
}

func parseSort(raw string) ([]sortField, error) {
	if strings.TrimSpace(raw) == "" {
		raw = "time desc"
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 3 {
		return nil, ErrInvalidArgument
	}
	sorts := make([]sortField, 0, len(parts)+1)
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		words := strings.Fields(part)
		if len(words) < 1 || len(words) > 2 {
			return nil, ErrInvalidArgument
		}
		field, ok := lookupSortField(words[0])
		if !ok {
			return nil, ErrInvalidArgument
		}
		if _, duplicate := seen[field.name]; duplicate {
			return nil, ErrInvalidArgument
		}
		seen[field.name] = struct{}{}
		if len(words) == 2 {
			switch strings.ToLower(words[1]) {
			case "asc":
				field.descending = false
			case "desc":
				field.descending = true
			default:
				return nil, ErrInvalidArgument
			}
		} else {
			field.descending = true
		}
		sorts = append(sorts, field)
	}
	if _, exists := seen["requestId"]; !exists {
		field, _ := lookupSortField("requestId")
		field.descending = true
		sorts = append(sorts, field)
	}
	return sorts, nil
}

func lookupSortField(name string) (sortField, bool) {
	fields := map[string]sortField{
		"requestId":             {name: "requestId", column: "request_id", kind: stringKind},
		"time":                  {name: "time", column: "occurred_unix_nano", kind: timeKind},
		"collectionId":          {name: "collectionId", column: "collection_id", kind: stringKind},
		"endpoint":              {name: "endpoint", column: "endpoint", kind: stringKind},
		"method":                {name: "method", column: "method", kind: stringKind},
		"status":                {name: "status", column: "status", kind: integerKind},
		"durationMs":            {name: "durationMs", column: "duration_ms", kind: integerKind},
		"authenticationOutcome": {name: "authenticationOutcome", column: "authentication_outcome", kind: stringKind},
		"authorizationOutcome":  {name: "authorizationOutcome", column: "authorization_outcome", kind: stringKind},
		"errorCode":             {name: "errorCode", column: "error_code", kind: stringKind},
	}
	field, ok := fields[name]
	return field, ok
}

func parseFilter(raw string) (*filterSpec, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	firstSpace := strings.IndexByte(raw, ' ')
	if firstSpace < 1 {
		return nil, ErrInvalidArgument
	}
	rest := strings.TrimSpace(raw[firstSpace+1:])
	secondSpace := strings.IndexByte(rest, ' ')
	if secondSpace < 1 {
		return nil, ErrInvalidArgument
	}
	field, ok := lookupSortField(raw[:firstSpace])
	if !ok {
		return nil, ErrInvalidArgument
	}
	operator := strings.ToLower(strings.TrimSpace(rest[:secondSpace]))
	switch operator {
	case "eq", "ne", "gt", "gte", "lt", "lte", "contains":
	default:
		return nil, ErrInvalidArgument
	}
	valueJSON := strings.TrimSpace(rest[secondSpace+1:])
	decoder := json.NewDecoder(strings.NewReader(valueJSON))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, ErrInvalidArgument
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidArgument
	}
	if _, composite := value.(map[string]any); composite {
		return nil, ErrInvalidArgument
	}
	if _, composite := value.([]any); composite {
		return nil, ErrInvalidArgument
	}
	if operator == "contains" && field.kind != stringKind {
		return nil, ErrInvalidArgument
	}
	if value == nil && operator != "eq" && operator != "ne" {
		return nil, ErrInvalidArgument
	}
	converted, err := convertFilterValue(field, value)
	if err != nil {
		return nil, err
	}
	return &filterSpec{field: field, operator: operator, value: converted}, nil
}

func convertFilterValue(field sortField, value any) (any, error) {
	if value == nil {
		if field.kind != stringKind {
			return nil, ErrInvalidArgument
		}
		return "", nil
	}
	switch field.kind {
	case stringKind:
		text, ok := value.(string)
		if !ok || len(text) > 256 {
			return nil, ErrInvalidArgument
		}
		return text, nil
	case integerKind:
		number, ok := value.(json.Number)
		if !ok {
			return nil, ErrInvalidArgument
		}
		integer, err := number.Int64()
		if err != nil {
			return nil, ErrInvalidArgument
		}
		return integer, nil
	case timeKind:
		text, ok := value.(string)
		if !ok {
			return nil, ErrInvalidArgument
		}
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return nil, ErrInvalidArgument
		}
		return parsed.UnixNano(), nil
	default:
		return nil, ErrInvalidArgument
	}
}

func compileFilter(filter filterSpec) (string, any, error) {
	if filter.value == nil {
		return "", nil, ErrInvalidArgument
	}
	if filter.operator == "contains" {
		text := strings.ToLower(filter.value.(string))
		return `lower(` + filter.field.column + `) LIKE ? ESCAPE '\'`, "%" + escapeLike(text) + "%", nil
	}
	operator := map[string]string{"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[filter.operator]
	if operator == "" {
		return "", nil, ErrInvalidArgument
	}
	return filter.field.column + ` ` + operator + ` ?`, filter.value, nil
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func compileCursor(sorts []sortField, rawValues []json.RawMessage) (string, []any, error) {
	values := make([]any, len(rawValues))
	for index, field := range sorts {
		decoder := json.NewDecoder(bytes.NewReader(rawValues[index]))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return "", nil, ErrInvalidArgument
		}
		converted, err := convertFilterValue(field, value)
		if err != nil {
			return "", nil, err
		}
		values[index] = converted
	}
	branches := make([]string, 0, len(sorts))
	args := make([]any, 0, len(sorts)*(len(sorts)+1)/2)
	for index, field := range sorts {
		parts := make([]string, 0, index+1)
		branchArgs := make([]any, 0, index+1)
		for previous := 0; previous < index; previous++ {
			parts = append(parts, sorts[previous].column+` = ?`)
			branchArgs = append(branchArgs, values[previous])
		}
		op := ">"
		if field.descending {
			op = "<"
		}
		parts = append(parts, field.column+" "+op+" ?")
		branchArgs = append(branchArgs, values[index])
		branches = append(branches, "("+strings.Join(parts, " AND ")+")")
		args = append(args, branchArgs...)
	}
	if len(branches) == 0 {
		return "", nil, ErrInvalidArgument
	}
	return "(" + strings.Join(branches, " OR ") + ")", args, nil
}

func encodeCursor(search, filter string, sorts []sortField, record RequestRecord) (string, error) {
	cursor := listCursor{Search: search, Filter: filter, Sort: cursorSort(sorts), Values: make([]json.RawMessage, len(sorts))}
	for index, field := range sorts {
		encoded, err := json.Marshal(recordSortValue(field, record))
		if err != nil {
			return "", fmt.Errorf("encode RequestRecord cursor: %w", err)
		}
		cursor.Values[index] = encoded
	}
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode RequestRecord cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func decodeCursor(raw string) (listCursor, error) {
	if len(raw) > 4096 {
		return listCursor{}, ErrInvalidArgument
	}
	encoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return listCursor{}, ErrInvalidArgument
	}
	var cursor listCursor
	if err := json.Unmarshal(encoded, &cursor); err != nil {
		return listCursor{}, ErrInvalidArgument
	}
	return cursor, nil
}

func cursorSort(sorts []sortField) []string {
	result := make([]string, len(sorts))
	for index, field := range sorts {
		direction := "asc"
		if field.descending {
			direction = "desc"
		}
		result[index] = field.name + ":" + direction
	}
	return result
}

func sameCursorSort(left []string, right []sortField) bool {
	if len(left) != len(right) {
		return false
	}
	for index, expected := range cursorSort(right) {
		if left[index] != expected {
			return false
		}
	}
	return true
}

func recordSortValue(field sortField, record RequestRecord) any {
	switch field.name {
	case "requestId":
		return record.RequestID
	case "time":
		return record.Time.Format(time.RFC3339Nano)
	case "collectionId":
		return record.CollectionID
	case "endpoint":
		return record.Endpoint
	case "method":
		return record.Method
	case "status":
		return int64(record.Status)
	case "durationMs":
		return record.DurationMS
	case "authenticationOutcome":
		return record.AuthenticationOutcome
	case "authorizationOutcome":
		return record.AuthorizationOutcome
	case "errorCode":
		return record.ErrorCode
	default:
		return ""
	}
}
