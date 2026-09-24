package requests

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrInvalidArgument = errors.New("invalid request record argument")
	ErrNotFound        = errors.New("request record not found")
	ErrStorage         = errors.New("request record storage unavailable")

	requestIDPattern = regexp.MustCompile(`^req_[A-Za-z0-9_-]{8,}$`)
	errorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	methodPattern    = regexp.MustCompile(`^[A-Z]{1,16}$`)
)

const (
	AuthenticationUnknown        = "unknown"
	AuthenticationAnonymous      = "anonymous"
	AuthenticationAuthenticated  = "authenticated"
	AuthenticationRejected       = "rejected"
	AuthorizationNotEvaluated    = "notEvaluated"
	AuthorizationNotApplicable   = "notApplicable"
	AuthorizationAllowed         = "allowed"
	AuthorizationDenied          = "denied"
	AuthorizationEvaluationError = "error"
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Service struct {
	store transactionalStore
	now   func() time.Time
}

type RequestRecord struct {
	RequestID             string    `json:"requestId"`
	Time                  time.Time `json:"time"`
	CollectionID          string    `json:"collectionId,omitempty"`
	Endpoint              string    `json:"endpoint"`
	Method                string    `json:"method"`
	Status                int       `json:"status"`
	DurationMS            int64     `json:"durationMs"`
	ResponseSizeBytes     *int64    `json:"responseSizeBytes,omitempty"`
	AuthenticationOutcome string    `json:"authenticationOutcome,omitempty"`
	AuthorizationOutcome  string    `json:"authorizationOutcome,omitempty"`
	ErrorCode             string    `json:"errorCode,omitempty"`
	occurredAtUnixNano    int64
}

type ListOptions struct {
	Limit  int
	Cursor string
	Search string
	Filter string
	Sort   string
}

type Page struct {
	Data       []RequestRecord `json:"data"`
	NextCursor string          `json:"nextCursor,omitempty"`
}

func NewService(ctx context.Context, store transactionalStore) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("%w: SQLite store is required", ErrInvalidArgument)
	}
	service := &Service{store: store, now: func() time.Time { return time.Now().UTC() }}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_request_records (
			request_id TEXT PRIMARY KEY NOT NULL,
			occurred_at TEXT NOT NULL,
			occurred_unix_nano INTEGER NOT NULL,
			collection_id TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			method TEXT NOT NULL,
			status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
			duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
			response_size_bytes INTEGER CHECK (response_size_bytes >= 0),
			authentication_outcome TEXT NOT NULL,
			authorization_outcome TEXT NOT NULL,
			error_code TEXT NOT NULL
		)`); err != nil {
			return fmt.Errorf("create RequestRecord table: %w", err)
		}
		if err := ensureResponseSizeColumn(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS modelry_request_records_by_time ON modelry_request_records (occurred_unix_nano DESC, request_id DESC)`); err != nil {
			return fmt.Errorf("create RequestRecord time index: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("%w: initialize RequestRecord persistence: %v", ErrStorage, err)
	}
	return service, nil
}

func ensureResponseSizeColumn(ctx context.Context, tx storage.Executor) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA table_info(modelry_request_records)`)
	if err != nil {
		return fmt.Errorf("inspect RequestRecord columns: %w", err)
	}
	exists := false
	for rows.Next() {
		var index, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&index, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return fmt.Errorf("scan RequestRecord column: %w", err)
		}
		if name == "response_size_bytes" {
			exists = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("finish inspecting RequestRecord columns: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close RequestRecord column inspection: %w", err)
	}
	if exists {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE modelry_request_records ADD COLUMN response_size_bytes INTEGER CHECK (response_size_bytes >= 0)`); err != nil {
		return fmt.Errorf("add RequestRecord response size: %w", err)
	}
	return nil
}

func (service *Service) Append(ctx context.Context, record RequestRecord) error {
	if err := validateRequestRecord(record); err != nil {
		return err
	}
	when := record.Time.UTC()
	_, err := service.storeExec(ctx, `INSERT INTO modelry_request_records (
		request_id, occurred_at, occurred_unix_nano, collection_id, endpoint, method, status,
		duration_ms, response_size_bytes, authentication_outcome, authorization_outcome, error_code
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.RequestID, when.Format(time.RFC3339Nano), when.UnixNano(), record.CollectionID,
		record.Endpoint, record.Method, record.Status, record.DurationMS, nullableInt64(record.ResponseSizeBytes),
		record.AuthenticationOutcome, record.AuthorizationOutcome, record.ErrorCode)
	if err != nil {
		return fmt.Errorf("%w: append RequestRecord: %v", ErrStorage, err)
	}
	return nil
}

// UpdateResponseMetrics 更新流式响应完成后的请求耗时和响应大小。
func (service *Service) UpdateResponseMetrics(ctx context.Context, requestID string, durationMS, responseSizeBytes int64) error {
	if !requestIDPattern.MatchString(requestID) || durationMS < 0 || responseSizeBytes < 0 {
		return ErrInvalidArgument
	}
	result, err := service.storeExec(ctx, `UPDATE modelry_request_records SET duration_ms = ?, response_size_bytes = ? WHERE request_id = ?`, durationMS, responseSizeBytes, requestID)
	if err != nil {
		return fmt.Errorf("%w: update RequestRecord response metrics: %v", ErrStorage, err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%w: read RequestRecord update result: %v", ErrStorage, err)
	}
	if count != 1 {
		return ErrNotFound
	}
	return nil
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func (service *Service) storeExec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	var result sql.Result
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var err error
		result, err = tx.ExecContext(ctx, query, args...)
		return err
	})
	return result, err
}

func validateRequestRecord(record RequestRecord) error {
	if !requestIDPattern.MatchString(record.RequestID) || record.Time.IsZero() || record.Time.Year() < 1970 ||
		len(record.Endpoint) == 0 || len(record.Endpoint) > 1024 || (record.Endpoint != "/api/v1" && !strings.HasPrefix(record.Endpoint, "/api/v1/")) ||
		containsQueryOrFragment(record.Endpoint) || !methodPattern.MatchString(record.Method) ||
		record.Status < 100 || record.Status > 599 || record.DurationMS < 0 ||
		len(record.CollectionID) > 128 || !validAuthenticationOutcome(record.AuthenticationOutcome) ||
		!validAuthorizationOutcome(record.AuthorizationOutcome) ||
		(record.ResponseSizeBytes != nil && *record.ResponseSizeBytes < 0) ||
		(record.ErrorCode != "" && !errorCodePattern.MatchString(record.ErrorCode)) {
		return ErrInvalidArgument
	}
	return nil
}

func containsQueryOrFragment(value string) bool {
	for _, char := range value {
		if char == '?' || char == '#' || char < 0x20 || char == 0x7f {
			return true
		}
	}
	return false
}

func validAuthenticationOutcome(value string) bool {
	switch value {
	case AuthenticationUnknown, AuthenticationAnonymous, AuthenticationAuthenticated, AuthenticationRejected:
		return true
	default:
		return false
	}
}

func validAuthorizationOutcome(value string) bool {
	switch value {
	case AuthorizationNotEvaluated, AuthorizationNotApplicable, AuthorizationAllowed, AuthorizationDenied, AuthorizationEvaluationError:
		return true
	default:
		return false
	}
}
