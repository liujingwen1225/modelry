package adminauth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/permissions"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	maximumAdministrators        = 32
	administratorSessionLifetime = 30 * 24 * time.Hour
	administratorPasswordMinBytes = 12
)

var (
	// ErrNotFound 表示目标 Administrator 不存在。
	ErrNotFound = errors.New("administrator not found")
	// ErrConflict 表示状态冲突（重复 email、Owner 保护、上限）。
	ErrConflict = errors.New("administrator conflict")
	// ErrInvalidArgument 表示 Administrator 输入不合法。
	ErrInvalidArgument = errors.New("invalid administrator argument")
)

// AdministratorStatus 是 Administrator 的启用状态。
type AdministratorStatus string

const (
	AdministratorActive   AdministratorStatus = "active"
	AdministratorDisabled AdministratorStatus = "disabled"
)

// Administrator 是 Owner 之外的 Control Plane 人类身份。
type Administrator struct {
	ID          string
	Email       string
	Status      AdministratorStatus
	Permission  permissions.Grant
	CreatedAt   time.Time
	UpdatedAt   time.Time
	LastLoginAt *time.Time
}

// AdministratorInput 是创建 Administrator 的领域输入。
type AdministratorInput struct {
	Email      string
	Password   string
	Permission permissions.Grant
}

// AdministratorUpdate 是局部更新输入；nil 表示保持不变。
type AdministratorUpdate struct {
	Email      *string
	Permission *permissions.Grant
}

// AdministratorSession 是一个耐久 Control Plane 会话的安全投影。
type AdministratorSession struct {
	ID         string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
	Current    bool
}

func (session AdministratorSession) Status(now time.Time) string {
	switch {
	case session.RevokedAt != nil:
		return "revoked"
	case !session.ExpiresAt.After(now):
		return "expired"
	default:
		return "active"
	}
}

const administratorSchema = `CREATE TABLE IF NOT EXISTS modelry_administrators (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	email_key TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active','disabled')),
	permission_preset TEXT NOT NULL,
	permission_version INTEGER NOT NULL DEFAULT 0,
	permission_operations TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	last_login_at INTEGER
)`

const administratorSessionSchema = `CREATE TABLE IF NOT EXISTS modelry_administrator_sessions (
	id TEXT PRIMARY KEY,
	administrator_id TEXT NOT NULL REFERENCES modelry_administrators(id),
	token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER,
	last_used_at INTEGER
)`

func validateAdministratorPassword(password string) error {
	if len(password) < administratorPasswordMinBytes {
		return validationFailure("/password", "TOO_SHORT", fmt.Sprintf("Use at least %d characters for an Administrator password.", administratorPasswordMinBytes))
	}
	if len(password) > passwordMaxBytes {
		return validationFailure("/password", "TOO_LONG", "Password must be 1024 bytes or fewer.")
	}
	return nil
}

func permissionColumns(grant permissions.Grant) (string, int, string, error) {
	encoded, err := json.Marshal(grant.Operations)
	if err != nil {
		return "", 0, "", fmt.Errorf("%w: encode Permission", ErrInvalidArgument)
	}
	return string(grant.Preset), grant.Version, string(encoded), nil
}

func permissionFromColumns(preset string, version int, encoded string) (permissions.Grant, error) {
	var operations []permissions.Operation
	if strings.TrimSpace(encoded) != "" {
		if err := json.Unmarshal([]byte(encoded), &operations); err != nil {
			return permissions.Grant{}, fmt.Errorf("%w: decode stored Permission", ErrInvalidArgument)
		}
	}
	grant, err := permissions.NormalizeGrant(permissions.Preset(preset), version, operations)
	if err != nil {
		return permissions.Grant{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	return grant, nil
}

func scanAdministrator(row interface{ Scan(...any) error }) (Administrator, error) {
	var administrator Administrator
	var status, preset, encoded string
	var version int
	var created, updated int64
	var lastLogin sql.NullInt64
	if err := row.Scan(&administrator.ID, &administrator.Email, &status, &preset, &version, &encoded, &created, &updated, &lastLogin); err != nil {
		return Administrator{}, err
	}
	grant, err := permissionFromColumns(preset, version, encoded)
	if err != nil {
		return Administrator{}, err
	}
	administrator.Status = AdministratorStatus(status)
	administrator.Permission = grant
	administrator.CreatedAt = time.Unix(created, 0).UTC()
	administrator.UpdatedAt = time.Unix(updated, 0).UTC()
	if lastLogin.Valid {
		value := time.Unix(lastLogin.Int64, 0).UTC()
		administrator.LastLoginAt = &value
	}
	return administrator, nil
}

const administratorColumns = `id,email,status,permission_preset,permission_version,permission_operations,created_at,updated_at,last_login_at`
// CreateAdministrator 创建 Administrator 与 Audit 事实；同一事务内完成。
func (service *Service) CreateAdministrator(ctx context.Context, input AdministratorInput) (Administrator, error) {
	emailKey, err := normalizeEmail(input.Email)
	if err != nil {
		return Administrator{}, validationFailure("/email", "INVALID_EMAIL", "Enter a valid email address.")
	}
	if err := validateAdministratorPassword(input.Password); err != nil {
		return Administrator{}, err
	}
	grant, err := permissions.NormalizeGrant(input.Permission.Preset, input.Permission.Version, input.Permission.Operations)
	if err != nil {
		return Administrator{}, mapGrantError(err)
	}
	passwordHash, err := derivePasswordHash(input.Password)
	if err != nil {
		return Administrator{}, fmt.Errorf("derive Administrator credential: %w", err)
	}
	id, err := newOpaque("adm_", 16)
	if err != nil {
		return Administrator{}, err
	}
	preset, version, encoded, err := permissionColumns(grant)
	if err != nil {
		return Administrator{}, err
	}
	now := time.Now().UTC().Truncate(time.Second)
	administrator := Administrator{ID: id, Email: emailKey, Status: AdministratorActive, Permission: grant, CreatedAt: now, UpdatedAt: now}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_administrators`).Scan(&count); err != nil {
			return err
		}
		if count >= maximumAdministrators {
			return fmt.Errorf("%w: this Project already has the maximum number of Administrators", ErrConflict)
		}
		if err := ensureAdministratorEmailAvailable(ctx, tx, "", emailKey); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_administrators
			(id,email,email_key,password_hash,status,permission_preset,permission_version,permission_operations,created_at,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, emailKey, emailKey, passwordHash, string(AdministratorActive), preset, version, encoded, now.Unix(), now.Unix()); err != nil {
			return mapAdministratorWriteError(err)
		}
		return service.appendControlPlaneAudit(ctx, tx, "administrator.created", id)
	})
	if err != nil {
		return Administrator{}, mapAdministratorError(err)
	}
	return administrator, nil
}

func ensureAdministratorEmailAvailable(ctx context.Context, tx storage.Executor, excludeID, emailKey string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM modelry_administrators WHERE email_key = ?`, emailKey)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		if id != excludeID {
			return fmt.Errorf("%w: another Administrator already uses this email address", ErrConflict)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var ownerEmail string
	if err := tx.QueryRowContext(ctx, `SELECT email_key FROM modelry_admin_owner WHERE singleton = 1`).Scan(&ownerEmail); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if ownerEmail == emailKey {
		return fmt.Errorf("%w: the Owner already uses this email address", ErrConflict)
	}
	return nil
}

// ListAdministrators 返回有界的 Administrator 列表。
func (service *Service) ListAdministrators(ctx context.Context) ([]Administrator, error) {
	result := make([]Administrator, 0, maximumAdministrators)
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+administratorColumns+` FROM modelry_administrators ORDER BY created_at ASC, id ASC LIMIT ?`, maximumAdministrators)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			administrator, err := scanAdministrator(rows)
			if err != nil {
				return err
			}
			result = append(result, administrator)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, unavailableError{cause: err}
	}
	return result, nil
}

// GetAdministrator 读取一个 Administrator。
func (service *Service) GetAdministrator(ctx context.Context, administratorID string) (Administrator, error) {
	var administrator Administrator
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		var scanErr error
		administrator, scanErr = scanAdministrator(tx.QueryRowContext(ctx, `SELECT `+administratorColumns+` FROM modelry_administrators WHERE id = ?`, administratorID))
		return scanErr
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Administrator{}, ErrNotFound
		}
		return Administrator{}, unavailableError{cause: err}
	}
	return administrator, nil
}
// UpdateAdministrator 修改 email 或 Permission。
func (service *Service) UpdateAdministrator(ctx context.Context, administratorID string, update AdministratorUpdate) (Administrator, error) {
	if update.Email == nil && update.Permission == nil {
		return Administrator{}, validationFailure("/", "REQUIRED", "Change the email address or the Permission.")
	}
	var emailKey *string
	if update.Email != nil {
		value, err := normalizeEmail(*update.Email)
		if err != nil {
			return Administrator{}, validationFailure("/email", "INVALID_EMAIL", "Enter a valid email address.")
		}
		emailKey = &value
	}
	var grant *permissions.Grant
	if update.Permission != nil {
		normalized, err := permissions.NormalizeGrant(update.Permission.Preset, update.Permission.Version, update.Permission.Operations)
		if err != nil {
			return Administrator{}, mapGrantError(err)
		}
		grant = &normalized
	}
	now := time.Now().UTC().Truncate(time.Second)
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := loadAdministratorForUpdate(ctx, tx, administratorID); err != nil {
			return err
		}
		if emailKey != nil {
			if err := ensureAdministratorEmailAvailable(ctx, tx, administratorID, *emailKey); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrators SET email = ?, email_key = ?, updated_at = ? WHERE id = ?`, *emailKey, *emailKey, now.Unix(), administratorID); err != nil {
				return mapAdministratorWriteError(err)
			}
		}
		if grant != nil {
			preset, version, encoded, err := permissionColumns(*grant)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrators SET permission_preset = ?, permission_version = ?, permission_operations = ?, updated_at = ? WHERE id = ?`, preset, version, encoded, now.Unix(), administratorID); err != nil {
				return mapAdministratorWriteError(err)
			}
		}
		return service.appendControlPlaneAudit(ctx, tx, "administrator.updated", administratorID)
	})
	if err != nil {
		return Administrator{}, mapAdministratorError(err)
	}
	return service.GetAdministrator(ctx, administratorID)
}

func loadAdministratorForUpdate(ctx context.Context, tx storage.Executor, administratorID string) (Administrator, error) {
	administrator, err := scanAdministrator(tx.QueryRowContext(ctx, `SELECT `+administratorColumns+` FROM modelry_administrators WHERE id = ?`, administratorID))
	if errors.Is(err, sql.ErrNoRows) {
		return Administrator{}, ErrNotFound
	}
	return administrator, err
}

// SetAdministratorStatus 启用或停用一个 Administrator，并在停用时撤销其全部会话。
func (service *Service) SetAdministratorStatus(ctx context.Context, administratorID string, status AdministratorStatus) (Administrator, error) {
	if status != AdministratorActive && status != AdministratorDisabled {
		return Administrator{}, fmt.Errorf("%w: status must be active or disabled", ErrInvalidArgument)
	}
	now := time.Now().UTC().Truncate(time.Second)
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := loadAdministratorForUpdate(ctx, tx, administratorID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrators SET status = ?, updated_at = ? WHERE id = ?`, string(status), now.Unix(), administratorID); err != nil {
			return mapAdministratorWriteError(err)
		}
		if status == AdministratorDisabled {
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrator_sessions SET revoked_at = ? WHERE administrator_id = ? AND revoked_at IS NULL`, now.Unix(), administratorID); err != nil {
				return err
			}
		}
		action := "administrator.disabled"
		if status == AdministratorActive {
			action = "administrator.enabled"
		}
		return service.appendControlPlaneAudit(ctx, tx, action, administratorID)
	})
	if err != nil {
		return Administrator{}, mapAdministratorError(err)
	}
	return service.GetAdministrator(ctx, administratorID)
}

// DeleteAdministrator 删除 Administrator 并撤销其全部会话。
func (service *Service) DeleteAdministrator(ctx context.Context, administratorID string) error {
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := loadAdministratorForUpdate(ctx, tx, administratorID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_administrator_sessions WHERE administrator_id = ?`, administratorID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_administrators WHERE id = ?`, administratorID); err != nil {
			return err
		}
		return service.appendControlPlaneAudit(ctx, tx, "administrator.deleted", administratorID)
	})
	if err != nil {
		return mapAdministratorError(err)
	}
	return nil
}

// SetAdministratorPassword 由 Owner 设置新密码并撤销该 Administrator 的全部会话。
func (service *Service) SetAdministratorPassword(ctx context.Context, administratorID, password string) error {
	if err := validateAdministratorPassword(password); err != nil {
		return err
	}
	passwordHash, err := derivePasswordHash(password)
	if err != nil {
		return fmt.Errorf("derive Administrator credential: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := loadAdministratorForUpdate(ctx, tx, administratorID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrators SET password_hash = ?, updated_at = ? WHERE id = ?`, passwordHash, now.Unix(), administratorID); err != nil {
			return mapAdministratorWriteError(err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrator_sessions SET revoked_at = ? WHERE administrator_id = ? AND revoked_at IS NULL`, now.Unix(), administratorID); err != nil {
			return err
		}
		return service.appendControlPlaneAudit(ctx, tx, "administrator.passwordSet", administratorID)
	})
	if err != nil {
		return mapAdministratorError(err)
	}
	return nil
}
// ListAdministratorSessions 返回该 Administrator 的会话；currentSessionID 标记当前会话。
func (service *Service) ListAdministratorSessions(ctx context.Context, administratorID, currentSessionID string) ([]AdministratorSession, error) {
	if _, err := service.GetAdministrator(ctx, administratorID); err != nil {
		return nil, err
	}
	result := make([]AdministratorSession, 0, 16)
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT id, created_at, expires_at, last_used_at, revoked_at FROM modelry_administrator_sessions WHERE administrator_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`, administratorID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var session AdministratorSession
			var created, expires int64
			var lastUsed, revoked sql.NullInt64
			if err := rows.Scan(&session.ID, &created, &expires, &lastUsed, &revoked); err != nil {
				return err
			}
			session.CreatedAt = time.Unix(created, 0).UTC()
			session.ExpiresAt = time.Unix(expires, 0).UTC()
			if lastUsed.Valid {
				value := time.Unix(lastUsed.Int64, 0).UTC()
				session.LastUsedAt = &value
			}
			if revoked.Valid {
				value := time.Unix(revoked.Int64, 0).UTC()
				session.RevokedAt = &value
			}
			session.Current = currentSessionID != "" && session.ID == currentSessionID
			result = append(result, session)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, unavailableError{cause: err}
	}
	return result, nil
}

// RevokeAdministratorSessions 撤销该 Administrator 的全部会话。
func (service *Service) RevokeAdministratorSessions(ctx context.Context, administratorID string) error {
	now := time.Now().UTC().Truncate(time.Second)
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := loadAdministratorForUpdate(ctx, tx, administratorID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_administrator_sessions SET revoked_at = ? WHERE administrator_id = ? AND revoked_at IS NULL`, now.Unix(), administratorID); err != nil {
			return err
		}
		return service.appendControlPlaneAudit(ctx, tx, "administrator.sessionsRevoked", administratorID)
	})
	if err != nil {
		return mapAdministratorError(err)
	}
	return nil
}

// loginAdministrator 校验凭据并创建 30 天会话。
func (service *Service) loginAdministrator(ctx context.Context, emailKey, password string) (Principal, durableSession, string, bool, error) {
	var administrator Administrator
	var storedHash string
	lookupErr := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		var status, preset, encoded string
		var version int
		var created, updated int64
		var lastLogin sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT `+administratorColumns+`,password_hash FROM modelry_administrators WHERE email_key = ?`, emailKey).
			Scan(&administrator.ID, &administrator.Email, &status, &preset, &version, &encoded, &created, &updated, &lastLogin, &storedHash)
		if err != nil {
			return err
		}
		grant, err := permissionFromColumns(preset, version, encoded)
		if err != nil {
			return err
		}
		administrator.Status = AdministratorStatus(status)
		administrator.Permission = grant
		return nil
	})
	if lookupErr != nil {
		if errors.Is(lookupErr, sql.ErrNoRows) {
			return Principal{}, durableSession{}, "", false, nil
		}
		return Principal{}, durableSession{}, "", false, unavailableError{cause: lookupErr}
	}
	if !verifyPassword(password, storedHash) {
		return Principal{}, durableSession{}, "", true, ErrUnauthenticated
	}
	if administrator.Status != AdministratorActive {
		return Principal{}, durableSession{}, "", true, ErrUnauthenticated
	}
	principal := Principal{Kind: PrincipalAdministrator, ID: administrator.ID, Email: administrator.Email, Grant: administrator.Permission}
	session, token, err := service.createAdministratorSession(ctx, principal)
	if err != nil {
		return Principal{}, durableSession{}, "", true, unavailableError{cause: err}
	}
	return principal, session, token, true, nil
}

func (service *Service) createAdministratorSession(ctx context.Context, principal Principal) (durableSession, string, error) {
	sessionID, err := newOpaque("ses_", 16)
	if err != nil {
		return durableSession{}, "", err
	}
	token, tokenHash, err := newSessionToken()
	if err != nil {
		return durableSession{}, "", err
	}
	now := time.Now().UTC().Truncate(time.Second)
	session := durableSession{principal: principal, sessionID: sessionID, expiresAt: now.Add(administratorSessionLifetime)}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_administrator_sessions
			(id, administrator_id, token_hash, created_at, expires_at)
			VALUES(?,?,?,?,?)`, sessionID, principal.ID, tokenHash, now.Unix(), session.expiresAt.Unix()); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE modelry_administrators SET last_login_at = ?, updated_at = ? WHERE id = ?`, now.Unix(), now.Unix(), principal.ID)
		return err
	})
	if err != nil {
		return durableSession{}, "", err
	}
	return session, token, nil
}

func mapGrantError(err error) error {
	var invalid *permissions.InvalidGrant
	if errors.As(err, &invalid) {
		return validationFailure(invalid.Path, invalid.Code, invalid.Message)
	}
	return err
}

func mapAdministratorWriteError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(strings.ToLower(err.Error()), "unique") {
		return fmt.Errorf("%w: this email address is already in use", ErrConflict)
	}
	return err
}

func mapAdministratorError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrConflict), errors.Is(err, ErrInvalidArgument):
		return err
	}
	return unavailableError{cause: err}
}
