package appauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type credential struct {
	Salt       []byte
	Hash       []byte
	UserID     string
	EmailKey   string
	Verified   bool
	VerifiedAt sql.NullString
	CreatedAt  string
	UpdatedAt  string
}

type sessionRecord struct {
	ID           string
	CollectionID string
	UserID       string
	CreatedAt    string
	ExpiresAt    string
	LastUsedAt   sql.NullString
	RevokedAt    sql.NullString
}

func (service *Service) Login(ctx context.Context, collectionName, email, password string) (LoginResult, error) {
	emailKey, err := normalizeEmail(email)
	if err != nil {
		if len(password) <= passwordMaxBytes {
			dummyPasswordCheck(password)
		}
		return LoginResult{}, fmt.Errorf("%w: email or password is invalid", ErrUnauthenticated)
	}
	if len(password) == 0 || len(password) > passwordMaxBytes {
		return LoginResult{}, fmt.Errorf("%w: email or password is invalid", ErrUnauthenticated)
	}
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return LoginResult{}, err
	}
	var configuration AuthConfigState
	var stored credential
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		current, err := loadCollection(ctx, snapshot, collection.ID)
		if err != nil {
			return err
		}
		configuration, _, err = readConfig(ctx, snapshot, current)
		if err != nil {
			return err
		}
		stored, err = readCredential(ctx, snapshot, current.ID, emailKey)
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		dummyPasswordCheck(password)
		return LoginResult{}, ErrUnauthenticated
	}
	if err != nil {
		return LoginResult{}, err
	}
	passwordValid := verifyPassword(password, stored.Salt, stored.Hash)
	if !passwordValid || !configuration.Applied.EmailPasswordEnabled || validateAuthConfig(configuration.Applied) != nil {
		return LoginResult{}, ErrUnauthenticated
	}
	if configuration.Applied.EmailVerification == EmailVerificationRequired && !stored.Verified {
		return LoginResult{}, ErrEmailNotVerified
	}
	projection, err := service.models.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		return LoginResult{}, ErrUnauthenticated
	}
	table, err := storage.QuoteSQLiteIdentifier(projection.TableName)
	if err != nil {
		return LoginResult{}, err
	}
	token, rawToken, err := newOpaque("app_", 32)
	if err != nil {
		return LoginResult{}, err
	}
	tokenHash := sha256Bytes(rawToken)
	sessionID, _, err := newOpaque("sess_", 16)
	if err != nil {
		return LoginResult{}, err
	}
	now := service.now().UTC()
	result := LoginResult{}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		currentCollection, err := collectionByName(ctx, tx, collectionName)
		if err != nil {
			return err
		}
		if currentCollection.ID != collection.ID || currentCollection.SchemaVersion != projection.SchemaVersion {
			return fmt.Errorf("%w: Auth Collection changed during Login", ErrConflict)
		}
		currentConfig, _, err := readConfig(ctx, tx, currentCollection)
		if err != nil {
			return err
		}
		if !currentConfig.Applied.EmailPasswordEnabled || validateAuthConfig(currentConfig.Applied) != nil {
			return ErrUnauthenticated
		}
		currentCredential, err := readCredential(ctx, tx, currentCollection.ID, emailKey)
		if err != nil || currentCredential.UserID != stored.UserID || subtle.ConstantTimeCompare(currentCredential.Salt, stored.Salt) != 1 || subtle.ConstantTimeCompare(currentCredential.Hash, stored.Hash) != 1 {
			return ErrUnauthenticated
		}
		if currentConfig.Applied.EmailVerification == EmailVerificationRequired && !currentCredential.Verified {
			return ErrEmailNotVerified
		}
		var profileID string
		if err := tx.QueryRowContext(ctx, `SELECT "id" FROM `+table+` WHERE "id" = ?`, stored.UserID).Scan(&profileID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnauthenticated
			}
			return fmt.Errorf("verify App User Profile before issuing Session: %w", err)
		}
		expires := now.AddDate(0, 0, currentConfig.Applied.SessionDurationDays)
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_app_sessions (id, collection_id, user_record_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, sessionID, currentCollection.ID, stored.UserID, tokenHash, timestamp(now), timestamp(expires)); err != nil {
			return fmt.Errorf("persist application Session: %w", err)
		}
		result = LoginResult{AccessToken: token, TokenType: "Bearer", Session: ApplicationSession{ID: sessionID, CreatedAt: timestamp(now), ExpiresAt: timestamp(expires), Status: "active"}}
		return nil
	})
	if err != nil {
		return LoginResult{}, err
	}
	return result, nil
}

func (service *Service) AuthenticateSession(ctx context.Context, token string) (authorization.Principal, error) {
	row, err := service.sessionForToken(ctx, token, "")
	if err != nil {
		return authorization.Principal{}, err
	}
	return authorization.Principal{Type: authorization.PrincipalApplication, ID: row.UserID}, nil
}

func (service *Service) GetSession(ctx context.Context, collectionName, token string) (ApplicationSession, error) {
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return ApplicationSession{}, err
	}
	row, err := service.sessionForToken(ctx, token, collection.ID)
	if err != nil {
		return ApplicationSession{}, err
	}
	return sessionDTO(row, service.now()), nil
}

func (service *Service) Logout(ctx context.Context, collectionName, token string) error {
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return err
	}
	row, err := service.sessionForToken(ctx, token, collection.ID)
	if err != nil {
		return err
	}
	now := timestamp(service.now())
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND collection_id = ? AND user_record_id = ? AND revoked_at IS NULL`, now, row.ID, row.CollectionID, row.UserID)
		if err != nil {
			return fmt.Errorf("revoke current application Session: %w", err)
		}
		return expectSessionRow(result, ErrUnauthenticated)
	})
}

func (service *Service) ChangePassword(ctx context.Context, collectionName, token, currentPassword, newPassword string) error {
	if err := validatePassword(newPassword); err != nil {
		return err
	}
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return err
	}
	row, err := service.sessionForToken(ctx, token, collection.ID)
	if err != nil {
		return err
	}
	var current credential
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var err error
		current, err = readCredentialByUser(ctx, snapshot, collection.ID, row.UserID)
		return err
	})
	if err != nil || !verifyPassword(currentPassword, current.Salt, current.Hash) {
		return ErrUnauthenticated
	}
	salt, passwordHash, err := derivePassword(newPassword)
	if err != nil {
		return err
	}
	now := timestamp(service.now())
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var session sessionRecord
		if err := readSessionByID(ctx, tx, row.ID, &session); err != nil || session.RevokedAt.Valid || !sessionNotExpired(session, service.now()) {
			return ErrUnauthenticated
		}
		latest, err := readCredentialByUser(ctx, tx, collection.ID, row.UserID)
		if err != nil || subtle.ConstantTimeCompare(latest.Salt, current.Salt) != 1 || subtle.ConstantTimeCompare(latest.Hash, current.Hash) != 1 {
			return ErrUnauthenticated
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_password_credentials SET password_salt = ?, password_hash = ?, updated_at = ? WHERE collection_id = ? AND user_record_id = ?`, salt, passwordHash, now, collection.ID, row.UserID); err != nil {
			return fmt.Errorf("update Password Credential: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE collection_id = ? AND user_record_id = ?`, now, collection.ID, row.UserID); err != nil {
			return fmt.Errorf("revoke Sessions after password change: %w", err)
		}
		return nil
	})
}

func (service *Service) ListOwnSessions(ctx context.Context, collectionName, token string) ([]ApplicationSession, error) {
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return nil, err
	}
	row, err := service.sessionForToken(ctx, token, collection.ID)
	if err != nil {
		return nil, err
	}
	return service.ListUserSessions(ctx, row.CollectionID, row.UserID)
}

func (service *Service) RevokeOwnSession(ctx context.Context, collectionName, token, sessionID string) error {
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return err
	}
	caller, err := service.sessionForToken(ctx, token, collection.ID)
	if err != nil {
		return err
	}
	now := timestamp(service.now())
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND collection_id = ? AND user_record_id = ?`, now, sessionID, collection.ID, caller.UserID)
		if err != nil {
			return fmt.Errorf("revoke App User Session: %w", err)
		}
		return expectSessionRow(result, ErrNotFound)
	})
}

func (service *Service) ListUserSessions(ctx context.Context, collectionID, userID string) ([]ApplicationSession, error) {
	collection, err := service.models.GetCollection(ctx, collectionID)
	if err != nil {
		return nil, mapBackendError(err)
	}
	if err := requireAuthCollection(collection); err != nil {
		return nil, err
	}
	projection, err := service.models.GetRecordProjection(ctx, collectionID)
	if err != nil {
		return nil, mapBackendError(err)
	}
	table, err := storage.QuoteSQLiteIdentifier(projection.TableName)
	if err != nil {
		return nil, err
	}
	result := make([]ApplicationSession, 0)
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var recordID string
		if err := snapshot.QueryRowContext(ctx, `SELECT "id" FROM `+table+` WHERE "id" = ?`, userID).Scan(&recordID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return fmt.Errorf("verify App User for Session list: %w", err)
		}
		rows, err := snapshot.QueryContext(ctx, `SELECT id, collection_id, user_record_id, created_at, expires_at, last_used_at, revoked_at FROM modelry_app_sessions WHERE collection_id = ? AND user_record_id = ? ORDER BY created_at DESC, id DESC`, collectionID, userID)
		if err != nil {
			return fmt.Errorf("list App User Sessions: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var row sessionRecord
			if err := scanSession(rows, &row); err != nil {
				return err
			}
			result = append(result, sessionDTO(row, service.now()))
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("finish listing App User Sessions: %w", err)
		}
		return nil
	})
	return result, err
}

func (service *Service) RevokeUserSession(ctx context.Context, collectionID, sessionID string) error {
	collection, err := service.models.GetCollection(ctx, collectionID)
	if err != nil {
		return mapBackendError(err)
	}
	if err := requireAuthCollection(collection); err != nil {
		return err
	}
	now := timestamp(service.now())
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND collection_id = ?`, now, sessionID, collectionID)
		if err != nil {
			return fmt.Errorf("revoke App User Session: %w", err)
		}
		return expectSessionRow(result, ErrNotFound)
	})
}

func (service *Service) RevokeAllUserSessions(ctx context.Context, collectionID, userID string) error {
	collection, err := service.models.GetCollection(ctx, collectionID)
	if err != nil {
		return mapBackendError(err)
	}
	if err := requireAuthCollection(collection); err != nil {
		return err
	}
	projection, err := service.models.GetRecordProjection(ctx, collectionID)
	if err != nil {
		return mapBackendError(err)
	}
	table, err := storage.QuoteSQLiteIdentifier(projection.TableName)
	if err != nil {
		return err
	}
	now := timestamp(service.now())
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var recordID string
		if err := tx.QueryRowContext(ctx, `SELECT "id" FROM `+table+` WHERE "id" = ?`, userID).Scan(&recordID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return fmt.Errorf("verify App User for Session revoke: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE collection_id = ? AND user_record_id = ?`, now, collectionID, userID); err != nil {
			return fmt.Errorf("revoke App User Sessions: %w", err)
		}
		return nil
	})
}

func (service *Service) sessionForToken(ctx context.Context, token, collectionID string) (sessionRecord, error) {
	digest, err := tokenDigest(token)
	if err != nil {
		return sessionRecord{}, ErrUnauthenticated
	}
	var row sessionRecord
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := readSessionByToken(ctx, snapshot, digest, &row); err != nil {
			return err
		}
		if row.RevokedAt.Valid || !sessionNotExpired(row, service.now()) || (collectionID != "" && row.CollectionID != collectionID) {
			return ErrUnauthenticated
		}
		collection, err := loadCollection(ctx, snapshot, row.CollectionID)
		if err != nil || collection.Type != backendmodel.CollectionTypeAuth {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, ErrNotFound) {
			return sessionRecord{}, ErrUnauthenticated
		}
		return sessionRecord{}, err
	}
	projection, err := service.models.GetRecordProjection(ctx, row.CollectionID)
	if err != nil {
		return sessionRecord{}, ErrUnauthenticated
	}
	table, err := storage.QuoteSQLiteIdentifier(projection.TableName)
	if err != nil {
		return sessionRecord{}, ErrUnauthenticated
	}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var current sessionRecord
		if err := readSessionByID(ctx, snapshot, row.ID, &current); err != nil {
			return err
		}
		if current.CollectionID != row.CollectionID || current.UserID != row.UserID || current.RevokedAt.Valid || !sessionNotExpired(current, service.now()) {
			return ErrUnauthenticated
		}
		var recordID string
		if err := snapshot.QueryRowContext(ctx, `SELECT "id" FROM `+table+` WHERE "id" = ?`, row.UserID).Scan(&recordID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnauthenticated
			}
			return fmt.Errorf("verify current App User Profile: %w", err)
		}
		row = current
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrUnauthenticated) || errors.Is(err, sql.ErrNoRows) {
			return sessionRecord{}, ErrUnauthenticated
		}
		return sessionRecord{}, err
	}
	return row, nil
}

func (service *Service) findAuthCollection(ctx context.Context, name string) (backendmodel.Collection, error) {
	var collection backendmodel.Collection
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var err error
		collection, err = collectionByName(ctx, snapshot, name)
		return err
	})
	return collection, err
}

func collectionByName(ctx context.Context, query storage.Executor, name string) (backendmodel.Collection, error) {
	if strings.TrimSpace(name) == "" {
		return backendmodel.Collection{}, fmt.Errorf("%w: collectionName is required", ErrInvalidArgument)
	}
	var collection backendmodel.Collection
	var modelJSON string
	var storedType backendmodel.CollectionType
	if err := query.QueryRowContext(ctx, `SELECT id, type, model_json FROM modelry_backend_collections WHERE name = ? COLLATE NOCASE`, name).Scan(&collection.ID, &storedType, &modelJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return backendmodel.Collection{}, fmt.Errorf("%w: Collection was not found", ErrNotFound)
		}
		return backendmodel.Collection{}, fmt.Errorf("read Collection by name: %w", err)
	}
	if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
		return backendmodel.Collection{}, fmt.Errorf("decode Collection by name: %w", err)
	}
	collection.Type = storedType
	if err := requireAuthCollection(collection); err != nil {
		return backendmodel.Collection{}, fmt.Errorf("%w: Auth Collection was not found", ErrNotFound)
	}
	return collection, nil
}

func readCredential(ctx context.Context, query storage.Executor, collectionID, emailKey string) (credential, error) {
	var value credential
	var verified int
	err := query.QueryRowContext(ctx, `SELECT user_record_id, email_key, password_salt, password_hash, email_verified, verified_at, created_at, updated_at FROM modelry_app_password_credentials WHERE collection_id = ? AND email_key = ?`, collectionID, emailKey).Scan(&value.UserID, &value.EmailKey, &value.Salt, &value.Hash, &verified, &value.VerifiedAt, &value.CreatedAt, &value.UpdatedAt)
	if err != nil {
		return credential{}, err
	}
	value.Verified = verified == 1
	return value, nil
}

func readCredentialByUser(ctx context.Context, query storage.Executor, collectionID, userID string) (credential, error) {
	var value credential
	var verified int
	err := query.QueryRowContext(ctx, `SELECT user_record_id, email_key, password_salt, password_hash, email_verified, verified_at, created_at, updated_at FROM modelry_app_password_credentials WHERE collection_id = ? AND user_record_id = ?`, collectionID, userID).Scan(&value.UserID, &value.EmailKey, &value.Salt, &value.Hash, &verified, &value.VerifiedAt, &value.CreatedAt, &value.UpdatedAt)
	value.Verified = verified == 1
	return value, err
}

func readSessionByToken(ctx context.Context, query storage.Executor, digest []byte, value *sessionRecord) error {
	return query.QueryRowContext(ctx, `SELECT id, collection_id, user_record_id, created_at, expires_at, last_used_at, revoked_at FROM modelry_app_sessions WHERE token_hash = ?`, digest).Scan(&value.ID, &value.CollectionID, &value.UserID, &value.CreatedAt, &value.ExpiresAt, &value.LastUsedAt, &value.RevokedAt)
}

func readSessionByID(ctx context.Context, query storage.Executor, sessionID string, value *sessionRecord) error {
	return query.QueryRowContext(ctx, `SELECT id, collection_id, user_record_id, created_at, expires_at, last_used_at, revoked_at FROM modelry_app_sessions WHERE id = ?`, sessionID).Scan(&value.ID, &value.CollectionID, &value.UserID, &value.CreatedAt, &value.ExpiresAt, &value.LastUsedAt, &value.RevokedAt)
}

type rowScanner interface {
	Scan(...any) error
}

func scanSession(scanner rowScanner, value *sessionRecord) error {
	return scanner.Scan(&value.ID, &value.CollectionID, &value.UserID, &value.CreatedAt, &value.ExpiresAt, &value.LastUsedAt, &value.RevokedAt)
}

func sessionNotExpired(row sessionRecord, now time.Time) bool {
	expires, err := time.Parse(time.RFC3339Nano, row.ExpiresAt)
	return err == nil && now.Before(expires)
}

func sessionDTO(row sessionRecord, now time.Time) ApplicationSession {
	status := "active"
	if row.RevokedAt.Valid {
		status = "revoked"
	} else if !sessionNotExpired(row, now) {
		status = "expired"
	}
	result := ApplicationSession{ID: row.ID, CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt, Status: status}
	if row.LastUsedAt.Valid {
		value := row.LastUsedAt.String
		result.LastUsedAt = &value
	}
	return result
}

func expectSessionRow(result sql.Result, missing error) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("verify Session state transition: %w", err)
	}
	if count != 1 {
		return fmt.Errorf("%w: Session was not found in the requested scope", missing)
	}
	return nil
}

func sha256Bytes(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}

var _ authorization.SessionAuthenticator = (*Service)(nil)
