package serviceaccounts

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const apiKeyPrefix = "mdl_sk_"

var (
	serviceAccountIDPattern = regexp.MustCompile(`^sa_[A-Za-z0-9_-]{22}$`)
	apiKeyIDPattern         = regexp.MustCompile(`^key_[A-Za-z0-9_-]{22}$`)
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type AuditWriter interface {
	AppendInTransaction(context.Context, storage.Executor, audit.AppendInput) error
}

type Service struct {
	store  transactionalStore
	audits AuditWriter
	now    func() time.Time
}

// NewService 初始化耐久的 Service Account 与 API Key 表，并要求 Audit Writer 一起提交安全事实。
func NewService(ctx context.Context, store transactionalStore, audits AuditWriter) (*Service, error) {
	if store == nil || audits == nil {
		return nil, fmt.Errorf("%w: SQLite store and Audit Writer are required", ErrInvalidArgument)
	}
	service := &Service{store: store, audits: audits, now: func() time.Time { return time.Now().UTC() }}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_service_accounts (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			permission TEXT NOT NULL CHECK (permission IN ('fullAccess', 'readOnly', 'custom')),
			custom_permission_version INTEGER NOT NULL,
			custom_operations_json TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
			created_at TEXT NOT NULL,
			created_unix_nano INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			last_used_at TEXT
		)`); err != nil {
			return fmt.Errorf("create Service Account table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS modelry_service_accounts_by_created ON modelry_service_accounts (created_unix_nano DESC, id DESC)`); err != nil {
			return fmt.Errorf("create Service Account list index: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_service_account_api_keys (
			id TEXT PRIMARY KEY NOT NULL,
			service_account_id TEXT NOT NULL,
			name TEXT NOT NULL,
			token_hash BLOB NOT NULL UNIQUE,
			status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
			created_at TEXT NOT NULL,
			expires_at TEXT,
			last_used_at TEXT,
			revoked_at TEXT,
			FOREIGN KEY (service_account_id) REFERENCES modelry_service_accounts(id)
		)`); err != nil {
			return fmt.Errorf("create Service Account API Key table: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS modelry_service_account_api_keys_by_owner ON modelry_service_account_api_keys (service_account_id, created_at DESC, id DESC)`); err != nil {
			return fmt.Errorf("create API Key owner index: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("%w: initialize Service Account persistence: %v", ErrStorage, err)
	}
	return service, nil
}

func (service *Service) List(ctx context.Context, options ListOptions) (Page, error) {
	if options.Limit == 0 {
		options.Limit = 50
	}
	if options.Limit < 1 || options.Limit > 100 {
		return Page{}, validationError("/limit", "OUT_OF_RANGE", "Choose a page size between 1 and 100.")
	}
	var cursorNano int64
	var cursorID string
	if options.Cursor != "" {
		var err error
		cursorNano, cursorID, err = decodeAccountCursor(options.Cursor)
		if err != nil {
			return Page{}, err
		}
	}
	page := Page{Data: make([]ServiceAccount, 0, options.Limit)}
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if _, _, err := service.requireOperation(ctx, snapshot, OperationServiceAccountsRead); err != nil {
			return err
		}
		query := accountSelect + ` FROM modelry_service_accounts`
		args := []any{}
		if options.Cursor != "" {
			query += ` WHERE created_unix_nano < ? OR (created_unix_nano = ? AND id < ?)`
			args = append(args, cursorNano, cursorNano, cursorID)
		}
		query += ` ORDER BY created_unix_nano DESC, id DESC LIMIT ?`
		args = append(args, options.Limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			row, err := scanAccount(rows)
			if err != nil {
				return err
			}
			if len(page.Data) == options.Limit {
				last := page.Data[len(page.Data)-1]
				lastNano, err := parseTimestamp(last.CreatedAt)
				if err != nil {
					return err
				}
				page.NextCursor = encodeAccountCursor(lastNano.UnixNano(), last.ID)
				break
			}
			page.Data = append(page.Data, row.Account)
		}
		return rows.Err()
	})
	if err != nil {
		return Page{}, mapStorageError(err)
	}
	return page, nil
}

func (service *Service) Get(ctx context.Context, id string) (ServiceAccount, error) {
	if !serviceAccountIDPattern.MatchString(id) {
		return ServiceAccount{}, ErrNotFound
	}
	var account ServiceAccount
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if _, _, err := service.requireOperation(ctx, snapshot, OperationServiceAccountsRead); err != nil {
			return err
		}
		row, err := readAccount(ctx, snapshot, id)
		if err != nil {
			return err
		}
		account = row.Account
		return nil
	})
	if err != nil {
		return ServiceAccount{}, mapStorageError(err)
	}
	return account, nil
}

func (service *Service) Create(ctx context.Context, input CreateInput) (CreateResult, error) {
	name, err := normalizeName(input.Name, "/name", "Service Account")
	if err != nil {
		return CreateResult{}, err
	}
	description, err := normalizeDescription(input.Description)
	if err != nil {
		return CreateResult{}, err
	}
	grant, err := normalizeGrant(input.Permission, input.CustomPermissionVersion, input.CustomOperations)
	if err != nil {
		return CreateResult{}, err
	}
	createKey := input.CreateAPIKey == nil || *input.CreateAPIKey
	var result CreateResult
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		actor, authority, err := service.requireOperation(ctx, tx, OperationServiceAccountsManage)
		if err != nil {
			return err
		}
		if createKey {
			if _, _, err := service.requireOperation(ctx, tx, OperationAPIKeysCreate); err != nil {
				return err
			}
		}
		if !grantWithin(grant, authority) {
			return fmt.Errorf("%w: a Service Account cannot grant operations it does not hold", ErrForbidden)
		}
		id, err := newIdentifier("sa_")
		if err != nil {
			return err
		}
		now := service.now().UTC()
		operationsJSON, err := json.Marshal(grant.Operations)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_service_accounts (
			id, name, description, permission, custom_permission_version, custom_operations_json, status, created_at, created_unix_nano, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, id, name, description, string(grant.Preset), grant.Version, string(operationsJSON), timestamp(now), now.UnixNano(), timestamp(now)); err != nil {
			return err
		}
		row := accountRow{Account: ServiceAccount{
			ID: id, Name: name, Description: description, Permission: grant.Preset, Status: AccountActive,
			CreatedAt: timestamp(now), CustomPermissionVersion: grant.Version, CustomOperations: cloneOperations(grant.Operations),
		}, Grant: grant, CreatedNano: now.UnixNano()}
		if err := service.appendAudit(ctx, tx, actor, "serviceAccount.created", audit.Resource{Kind: "serviceAccount", ID: id}); err != nil {
			return err
		}
		result.ServiceAccount = row.Account
		if createKey {
			key, reveal, err := service.createAPIKeyInTransaction(ctx, tx, row, APIKeyCreateInput{Name: "Default API key"})
			if err != nil {
				return err
			}
			if err := service.appendAudit(ctx, tx, actor, "apiKey.created", audit.Resource{Kind: "apiKey", ID: key.ID}); err != nil {
				return err
			}
			result.APIKeyReveal = &reveal
		}
		return nil
	})
	if err != nil {
		return CreateResult{}, mapStorageError(err)
	}
	return result, nil
}

func (service *Service) Update(ctx context.Context, id string, input UpdateInput) (ServiceAccount, error) {
	if !serviceAccountIDPattern.MatchString(id) {
		return ServiceAccount{}, ErrNotFound
	}
	if input.Name == nil && input.Description == nil && input.Permission == nil && input.CustomPermissionVersion == nil && input.CustomOperations == nil {
		return ServiceAccount{}, validationError("/", "REQUIRED", "Provide at least one Service Account change.")
	}
	var result ServiceAccount
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		actor, authority, err := service.requireOperation(ctx, tx, OperationServiceAccountsManage)
		if err != nil {
			return err
		}
		current, err := readAccount(ctx, tx, id)
		if err != nil {
			return err
		}
		name := current.Account.Name
		if input.Name != nil {
			name, err = normalizeName(*input.Name, "/name", "Service Account")
			if err != nil {
				return err
			}
		}
		description := current.Account.Description
		if input.Description != nil {
			description, err = normalizeDescription(*input.Description)
			if err != nil {
				return err
			}
		}
		if err := service.requireTargetWithinActor(ctx, tx, current.Grant); err != nil {
			return err
		}
		grant, err := updateGrant(current.Grant, input)
		if err != nil {
			return err
		}
		if !grantWithin(grant, authority) {
			return fmt.Errorf("%w: a Service Account cannot grant operations it does not hold", ErrForbidden)
		}
		operationsJSON, err := json.Marshal(grant.Operations)
		if err != nil {
			return err
		}
		now := timestamp(service.now())
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_service_accounts SET name = ?, description = ?, permission = ?, custom_permission_version = ?, custom_operations_json = ?, updated_at = ? WHERE id = ?`, name, description, string(grant.Preset), grant.Version, string(operationsJSON), now, id); err != nil {
			return err
		}
		if err := service.appendAudit(ctx, tx, actor, "serviceAccount.updated", audit.Resource{Kind: "serviceAccount", ID: id}); err != nil {
			return err
		}
		result = current.Account
		result.Name, result.Description, result.Permission = name, description, grant.Preset
		result.CustomPermissionVersion, result.CustomOperations = grant.Version, cloneOperations(grant.Operations)
		return nil
	})
	if err != nil {
		return ServiceAccount{}, mapStorageError(err)
	}
	return result, nil
}

func (service *Service) Disable(ctx context.Context, id string) error {
	return service.setStatus(ctx, id, AccountDisabled)
}

func (service *Service) Enable(ctx context.Context, id string) error {
	return service.setStatus(ctx, id, AccountActive)
}

func (service *Service) setStatus(ctx context.Context, id string, status AccountStatus) error {
	if !serviceAccountIDPattern.MatchString(id) {
		return ErrNotFound
	}
	return mapStorageError(service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		actor, _, err := service.requireOperation(ctx, tx, OperationServiceAccountsManage)
		if err != nil {
			return err
		}
		current, err := readAccount(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := service.requireTargetWithinActor(ctx, tx, current.Grant); err != nil {
			return err
		}
		if current.Account.Status == status {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_service_accounts SET status = ?, updated_at = ? WHERE id = ?`, string(status), timestamp(service.now()), id); err != nil {
			return err
		}
		action := "serviceAccount.enabled"
		if status == AccountDisabled {
			action = "serviceAccount.disabled"
		}
		return service.appendAudit(ctx, tx, actor, action, audit.Resource{Kind: "serviceAccount", ID: id})
	}))
}

func (service *Service) requireOperation(ctx context.Context, query storage.Executor, operation Operation) (audit.Actor, Grant, error) {
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return audit.Actor{}, Grant{}, ErrUnauthenticated
	}
	if actor.Kind == audit.ActorOwner {
		return actor, Grant{Preset: PresetFullAccess}, nil
	}
	if actor.Kind != audit.ActorServiceAccount {
		return audit.Actor{}, Grant{}, ErrUnauthenticated
	}
	row, err := readAccount(ctx, query, actor.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return audit.Actor{}, Grant{}, ErrUnauthenticated
	}
	if err != nil {
		return audit.Actor{}, Grant{}, err
	}
	if row.Account.Status != AccountActive {
		return audit.Actor{}, Grant{}, ErrUnauthenticated
	}
	if !grantAllows(row.Grant, operation) {
		return audit.Actor{}, Grant{}, ErrForbidden
	}
	return actor, row.Grant, nil
}

func (service *Service) requireTargetWithinActor(ctx context.Context, query storage.Executor, target Grant) error {
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return ErrUnauthenticated
	}
	if actor.Kind == audit.ActorOwner {
		return nil
	}
	if actor.Kind != audit.ActorServiceAccount {
		return ErrUnauthenticated
	}
	current, err := readAccount(ctx, query, actor.ID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && current.Account.Status != AccountActive) {
		return ErrUnauthenticated
	}
	if err != nil {
		return err
	}
	if !grantWithin(target, current.Grant) {
		return ErrForbidden
	}
	return nil
}

func (service *Service) appendAudit(ctx context.Context, tx storage.Executor, actor audit.Actor, action string, resource audit.Resource) error {
	return service.audits.AppendInTransaction(ctx, tx, audit.AppendInput{Actor: actor, Action: action, Resource: resource, Result: "success"})
}

func updateGrant(current Grant, input UpdateInput) (Grant, error) {
	preset := current.Preset
	if input.Permission != nil {
		preset = *input.Permission
	}
	version := 0
	operations := []Operation(nil)
	if preset == PresetCustom {
		if current.Preset == PresetCustom {
			version, operations = current.Version, cloneOperations(current.Operations)
		}
		if input.CustomPermissionVersion != nil {
			version = *input.CustomPermissionVersion
		}
		if input.CustomOperations != nil {
			operations = cloneOperations(*input.CustomOperations)
		}
	} else if input.CustomPermissionVersion != nil || input.CustomOperations != nil {
		return Grant{}, validationError("/customOperations", "NOT_ALLOWED", "Custom operations can only be updated for a Custom Permission.")
	}
	return normalizeGrant(preset, version, operations)
}

type accountRow struct {
	Account     ServiceAccount
	Grant       Grant
	CreatedNano int64
}

const accountSelect = `SELECT id, name, description, permission, custom_permission_version, custom_operations_json, status, created_at, created_unix_nano, last_used_at`

func readAccount(ctx context.Context, query storage.Executor, id string) (accountRow, error) {
	return scanAccount(query.QueryRowContext(ctx, accountSelect+` FROM modelry_service_accounts WHERE id = ?`, id))
}

type rowScanner interface {
	Scan(...any) error
}

func scanAccount(scanner rowScanner) (accountRow, error) {
	var row accountRow
	var preset string
	var status string
	var operationsJSON string
	var createdAt string
	var lastUsed sql.NullString
	if err := scanner.Scan(&row.Account.ID, &row.Account.Name, &row.Account.Description, &preset, &row.Account.CustomPermissionVersion, &operationsJSON, &status, &createdAt, &row.CreatedNano, &lastUsed); err != nil {
		return accountRow{}, err
	}
	grant, err := grantFromColumns(preset, row.Account.CustomPermissionVersion, operationsJSON)
	if err != nil {
		return accountRow{}, err
	}
	row.Grant = grant
	row.Account.Permission = grant.Preset
	row.Account.Status = AccountStatus(status)
	row.Account.CreatedAt = createdAt
	row.Account.CustomPermissionVersion = grant.Version
	row.Account.CustomOperations = cloneOperations(grant.Operations)
	if lastUsed.Valid {
		value := lastUsed.String
		row.Account.LastUsedAt = &value
	}
	return row, nil
}

func mapStorageError(err error) error {
	if err == nil || errors.Is(err, ErrInvalidArgument) || errors.Is(err, ErrNotFound) || errors.Is(err, ErrUnauthenticated) || errors.Is(err, ErrForbidden) || errors.Is(err, ErrConflict) || errors.Is(err, ErrStorage) {
		return err
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return fmt.Errorf("%w: %v", ErrStorage, err)
}

func normalizeName(value, path, noun string) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || len(value) == 0 || len(value) > 128 {
		return "", validationError(path, "OUT_OF_RANGE", noun+" name must contain between 1 and 128 UTF-8 bytes.")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", validationError(path, "INVALID_CHARACTER", noun+" name cannot contain control characters.")
		}
	}
	return value, nil
}

func normalizeDescription(value string) (string, error) {
	if !utf8.ValidString(value) || len(value) > 1024 {
		return "", validationError("/description", "OUT_OF_RANGE", "Description must be 1024 UTF-8 bytes or fewer.")
	}
	return strings.TrimSpace(value), nil
}

func cloneOperations(values []Operation) []Operation {
	return append([]Operation(nil), values...)
}

func timestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func parseTimestamp(value string) (time.Time, error) { return time.Parse(time.RFC3339Nano, value) }

func newIdentifier(prefix string) (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value), nil
}

func encodeAccountCursor(createdNano int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(createdNano, 10) + "\x00" + id))
}

func decodeAccountCursor(value string) (int64, string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, "", validationError("/cursor", "INVALID_CURSOR", "Reload the Service Account list and try again.")
	}
	parts := strings.SplitN(string(decoded), "\x00", 2)
	if len(parts) != 2 || !serviceAccountIDPattern.MatchString(parts[1]) {
		return 0, "", validationError("/cursor", "INVALID_CURSOR", "Reload the Service Account list and try again.")
	}
	nano, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || nano < 0 {
		return 0, "", validationError("/cursor", "INVALID_CURSOR", "Reload the Service Account list and try again.")
	}
	return nano, parts[1], nil
}
