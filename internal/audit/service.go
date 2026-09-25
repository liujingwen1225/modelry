package audit

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	auditIDPattern   = regexp.MustCompile(`^aud_[A-Za-z0-9_-]{16,}$`)
	requestIDPattern = regexp.MustCompile(`^req_[A-Za-z0-9_-]{8,}$`)
	actorIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	resourcePattern  = regexp.MustCompile(`^[a-z][A-Za-z0-9_-]{0,63}$`)
	actionPattern    = regexp.MustCompile(`^[a-z][A-Za-z0-9]*(?:[._-][a-zA-Z0-9]+)*$`)
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Service struct {
	store transactionalStore
	now   func() time.Time
}

// NewService 创建耐久的追加式 Audit 存储，并安装防止修改历史记录的触发器。
func NewService(ctx context.Context, store transactionalStore) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("%w: SQLite store is required", ErrInvalidArgument)
	}
	service := &Service{store: store, now: func() time.Time { return time.Now().UTC() }}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_audit_records (
			id TEXT PRIMARY KEY NOT NULL,
			request_id TEXT NOT NULL,
			occurred_at TEXT NOT NULL,
			occurred_unix_nano INTEGER NOT NULL,
			actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'serviceAccount')),
			actor_id TEXT NOT NULL,
			action TEXT NOT NULL,
			resource_json TEXT NOT NULL,
			result TEXT NOT NULL
		)`); err != nil {
			return fmt.Errorf("create AuditRecord table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS modelry_audit_records_by_time ON modelry_audit_records (occurred_unix_nano DESC, id DESC)`); err != nil {
			return fmt.Errorf("create AuditRecord time index: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `CREATE TRIGGER IF NOT EXISTS modelry_audit_records_no_update
			BEFORE UPDATE ON modelry_audit_records BEGIN SELECT RAISE(ABORT, 'AuditRecord is append-only'); END`); err != nil {
			return fmt.Errorf("protect AuditRecord updates: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `CREATE TRIGGER IF NOT EXISTS modelry_audit_records_no_delete
			BEFORE DELETE ON modelry_audit_records BEGIN SELECT RAISE(ABORT, 'AuditRecord is append-only'); END`); err != nil {
			return fmt.Errorf("protect AuditRecord deletion: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("%w: initialize Audit persistence: %v", ErrStorage, err)
	}
	return service, nil
}

// ActorFromContext 返回已通过 Owner 或 Service Account 认证边界建立的 Actor。
func ActorFromContext(ctx context.Context) (Actor, bool) {
	if actor, ok := ctx.Value(contextActorKey{}).(Actor); ok && validActor(actor) {
		return actor, true
	}
	if principal, ok := authorization.PrincipalFromContext(ctx); ok {
		switch principal.Type {
		case authorization.PrincipalOwner:
			actor := Actor{Kind: ActorOwner, ID: principal.ID}
			return actor, validActor(actor)
		case authorization.PrincipalServiceAccount:
			actor := Actor{Kind: ActorServiceAccount, ID: principal.ID}
			return actor, validActor(actor)
		}
	}
	if principal, ok := adminauth.PrincipalFromContext(ctx); ok {
		kind := ActorOwner
		if principal.Kind == adminauth.PrincipalAdministrator {
			kind = ActorAdministrator
		}
		actor := Actor{Kind: kind, ID: principal.ID}
		if validActor(actor) {
			return actor, true
		}
	}
	if owner, ok := adminauth.OwnerFromContext(ctx); ok {
		actor := Actor{Kind: ActorOwner, ID: owner.ID}
		return actor, validActor(actor)
	}
	return Actor{}, false
}

// Append 在独立事务中追加 AuditRecord；受审计 mutation 应使用 AppendInTransaction。
func (service *Service) Append(ctx context.Context, input AppendInput) error {
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		return service.AppendInTransaction(ctx, tx, input)
	})
}

// AppendInTransaction 在调用方事务中追加一条不可变 AuditRecord。
func (service *Service) AppendInTransaction(ctx context.Context, tx storage.Executor, input AppendInput) error {
	if tx == nil {
		return fmt.Errorf("%w: SQLite transaction is required", ErrInvalidArgument)
	}
	if input.ID == "" {
		id, err := newAuditID()
		if err != nil {
			return fmt.Errorf("generate AuditRecord ID: %w", err)
		}
		input.ID = id
	}
	when := input.Time.UTC()
	if input.Time.IsZero() {
		when = service.now().UTC()
	}
	if input.RequestID == "" {
		input.RequestID = httpapi.RequestID(ctx)
	}
	if err := validateAppendInput(input, when); err != nil {
		return err
	}
	resourceJSON, err := json.Marshal(input.Resource)
	if err != nil {
		return fmt.Errorf("encode safe Audit resource: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO modelry_audit_records (
		id, request_id, occurred_at, occurred_unix_nano, actor_kind, actor_id, action, resource_json, result
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.ID, input.RequestID, when.Format(time.RFC3339Nano), when.UnixNano(),
		string(input.Actor.Kind), input.Actor.ID, input.Action, string(resourceJSON), input.Result)
	if err != nil {
		return fmt.Errorf("append AuditRecord: %w", err)
	}
	return nil
}

func (service *Service) Get(ctx context.Context, id string) (Record, error) {
	if !auditIDPattern.MatchString(id) {
		return Record{}, ErrNotFound
	}
	var record Record
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		row := snapshot.QueryRowContext(ctx, `SELECT id, request_id, occurred_at, actor_kind, actor_id, action, resource_json, result
			FROM modelry_audit_records WHERE id = ?`, id)
		var resourceJSON string
		var actorKind string
		var occurredAt string
		if err := row.Scan(&record.ID, &record.RequestID, &occurredAt, &actorKind, &record.Actor.ID, &record.Action, &resourceJSON, &record.Result); err != nil {
			return err
		}
		parsed, err := time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return fmt.Errorf("decode AuditRecord time: %w", err)
		}
		record.Time = parsed.UTC()
		record.Actor.Kind = ActorKind(actorKind)
		if err := json.Unmarshal([]byte(resourceJSON), &record.Resource); err != nil {
			return fmt.Errorf("decode AuditRecord resource: %w", err)
		}
		return nil
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, fmt.Errorf("%w: read AuditRecord: %v", ErrStorage, err)
	}
	return record, nil
}

func (service *Service) List(ctx context.Context, options ListOptions) (Page, error) {
	if options.Limit == 0 {
		options.Limit = 50
	}
	if options.Limit < 1 || options.Limit > 100 {
		return Page{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalidArgument)
	}
	options, err := normalizeListOptions(options)
	if err != nil {
		return Page{}, err
	}
	var cursorTime int64
	var cursorID string
	if options.Cursor != "" {
		cursorTime, cursorID, err = decodeCursor(options.Cursor, filterFingerprint(options))
		if err != nil {
			return Page{}, err
		}
	}
	page := Page{Data: make([]Record, 0, options.Limit)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		query := `SELECT id, request_id, occurred_at, actor_kind, actor_id, action, resource_json, result
			FROM modelry_audit_records`
		conditions, args := filterConditions(options)
		if options.Cursor != "" {
			conditions = append(conditions, `(occurred_unix_nano < ? OR (occurred_unix_nano = ? AND id < ?))`)
			args = append(args, cursorTime, cursorTime, cursorID)
		}
		if len(conditions) > 0 {
			query += ` WHERE ` + strings.Join(conditions, ` AND `)
		}
		query += ` ORDER BY occurred_unix_nano DESC, id DESC LIMIT ?`
		args = append(args, options.Limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var record Record
			var occurredAt string
			var actorKind string
			var resourceJSON string
			if err := rows.Scan(&record.ID, &record.RequestID, &occurredAt, &actorKind, &record.Actor.ID, &record.Action, &resourceJSON, &record.Result); err != nil {
				return err
			}
			record.Time, err = time.Parse(time.RFC3339Nano, occurredAt)
			if err != nil {
				return fmt.Errorf("decode AuditRecord time: %w", err)
			}
			record.Time = record.Time.UTC()
			record.Actor.Kind = ActorKind(actorKind)
			if err := json.Unmarshal([]byte(resourceJSON), &record.Resource); err != nil {
				return fmt.Errorf("decode AuditRecord resource: %w", err)
			}
			if len(page.Data) == options.Limit {
				last := page.Data[len(page.Data)-1]
				page.NextCursor = encodeCursor(last.Time.UnixNano(), last.ID, filterFingerprint(options))
				break
			}
			page.Data = append(page.Data, record)
		}
		return rows.Err()
	})
	if err != nil {
		return Page{}, fmt.Errorf("%w: list AuditRecords: %v", ErrStorage, err)
	}
	return page, nil
}

func validateAppendInput(input AppendInput, when time.Time) error {
	if (input.ID != "" && !auditIDPattern.MatchString(input.ID)) || when.IsZero() || when.Year() < 1970 || !validActor(input.Actor) ||
		!actionPattern.MatchString(input.Action) || !resourcePattern.MatchString(input.Resource.Kind) || !actorIDPattern.MatchString(input.Resource.ID) ||
		(input.RequestID != "" && !requestIDPattern.MatchString(input.RequestID)) || !validResult(input.Result) {
		return ErrInvalidArgument
	}
	return nil
}

func validActor(actor Actor) bool {
	switch actor.Kind {
	case ActorOwner, ActorAdministrator, ActorServiceAccount:
		return actorIDPattern.MatchString(actor.ID)
	default:
		return false
	}
}

func validResult(result string) bool {
	switch result {
	case "success", "denied", "failure":
		return true
	default:
		return false
	}
}

func normalizeListOptions(options ListOptions) (ListOptions, error) {
	options.Search = strings.TrimSpace(options.Search)
	if !utf8.ValidString(options.Search) || len(options.Search) > 128 {
		return ListOptions{}, fmt.Errorf("%w: search must be 128 UTF-8 bytes or fewer", ErrInvalidArgument)
	}
	if options.ActorKind != "" && options.ActorKind != ActorOwner && options.ActorKind != ActorServiceAccount {
		return ListOptions{}, fmt.Errorf("%w: actorKind is unsupported", ErrInvalidArgument)
	}
	if (options.ActorID != "" && !actorIDPattern.MatchString(options.ActorID)) ||
		(options.Action != "" && (len(options.Action) > 128 || !actionPattern.MatchString(options.Action))) ||
		(options.ResourceKind != "" && !resourcePattern.MatchString(options.ResourceKind)) ||
		(options.ResourceID != "" && !actorIDPattern.MatchString(options.ResourceID)) {
		return ListOptions{}, fmt.Errorf("%w: Audit filter value is invalid", ErrInvalidArgument)
	}
	if options.From != nil && !validFilterTime(*options.From) {
		return ListOptions{}, fmt.Errorf("%w: from must be an RFC 3339 time supported by the Audit store", ErrInvalidArgument)
	}
	if options.To != nil && !validFilterTime(*options.To) {
		return ListOptions{}, fmt.Errorf("%w: to must be an RFC 3339 time supported by the Audit store", ErrInvalidArgument)
	}
	if options.From != nil && options.To != nil && options.From.After(*options.To) {
		return ListOptions{}, fmt.Errorf("%w: from must not be later than to", ErrInvalidArgument)
	}
	if options.From != nil {
		value := options.From.UTC()
		options.From = &value
	}
	if options.To != nil {
		value := options.To.UTC()
		options.To = &value
	}
	return options, nil
}

func validFilterTime(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 1970 && value.Year() <= 2262
}

func filterConditions(options ListOptions) ([]string, []any) {
	conditions := make([]string, 0, 8)
	args := make([]any, 0, 10)
	if options.Search != "" {
		pattern := "%" + escapeLike(strings.ToLower(options.Search)) + "%"
		conditions = append(conditions, `(LOWER(actor_kind) LIKE ? ESCAPE '\' OR LOWER(actor_id) LIKE ? ESCAPE '\' OR LOWER(action) LIKE ? ESCAPE '\' OR LOWER(resource_json) LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern, pattern, pattern)
	}
	if options.ActorKind != "" {
		conditions = append(conditions, `actor_kind = ?`)
		args = append(args, string(options.ActorKind))
	}
	if options.ActorID != "" {
		conditions = append(conditions, `actor_id = ?`)
		args = append(args, options.ActorID)
	}
	if options.Action != "" {
		conditions = append(conditions, `action = ?`)
		args = append(args, options.Action)
	}
	if options.ResourceKind != "" {
		conditions = append(conditions, `json_extract(resource_json, '$.kind') = ?`)
		args = append(args, options.ResourceKind)
	}
	if options.ResourceID != "" {
		conditions = append(conditions, `json_extract(resource_json, '$.id') = ?`)
		args = append(args, options.ResourceID)
	}
	if options.From != nil {
		conditions = append(conditions, `occurred_unix_nano >= ?`)
		args = append(args, options.From.UnixNano())
	}
	if options.To != nil {
		conditions = append(conditions, `occurred_unix_nano <= ?`)
		args = append(args, options.To.UnixNano())
	}
	return conditions, args
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func filterFingerprint(options ListOptions) string {
	from, to := "", ""
	if options.From != nil {
		from = options.From.UTC().Format(time.RFC3339Nano)
	}
	if options.To != nil {
		to = options.To.UTC().Format(time.RFC3339Nano)
	}
	canonical := strings.Join([]string{
		options.Search, string(options.ActorKind), options.ActorID, options.Action,
		options.ResourceKind, options.ResourceID, from, to,
	}, "\x00")
	hash := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(hash[:12])
}

func newAuditID() (string, error) {
	value, err := randomToken(16)
	if err != nil {
		return "", err
	}
	return "aud_" + value, nil
}

func randomToken(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func encodeCursor(occurredNano int64, id, fingerprint string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(occurredNano, 10) + "\x00" + id + "\x00" + fingerprint))
}

func decodeCursor(value, expectedFingerprint string) (int64, string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, "", ErrInvalidArgument
	}
	parts := strings.SplitN(string(decoded), "\x00", 3)
	if len(parts) != 3 || !auditIDPattern.MatchString(parts[1]) || parts[2] != expectedFingerprint {
		return 0, "", ErrInvalidArgument
	}
	when, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || when < 0 {
		return 0, "", ErrInvalidArgument
	}
	return when, parts[1], nil
}
