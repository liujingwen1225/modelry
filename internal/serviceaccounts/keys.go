package serviceaccounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type apiKeyRow struct {
	APIKey
	ServiceAccountID string
	TokenHash        []byte
	ExpiresAtNull    sql.NullString
	RevokedAt        sql.NullString
}

func (service *Service) ListAPIKeys(ctx context.Context, serviceAccountID string) ([]APIKey, error) {
	if !serviceAccountIDPattern.MatchString(serviceAccountID) {
		return nil, ErrNotFound
	}
	result := make([]APIKey, 0)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if _, _, err := service.requireOperation(ctx, snapshot, OperationAPIKeysRead); err != nil {
			return err
		}
		account, err := readAccount(ctx, snapshot, serviceAccountID)
		if err != nil {
			return err
		}
		if err := service.requireTargetWithinActor(ctx, snapshot, account.Grant); err != nil {
			return err
		}
		rows, err := snapshot.QueryContext(ctx, `SELECT id, name, status, created_at, expires_at, last_used_at
			FROM modelry_service_account_api_keys WHERE service_account_id = ? ORDER BY created_at DESC, id DESC`, serviceAccountID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var key APIKey
			var status string
			var expiresAt, lastUsed sql.NullString
			if err := rows.Scan(&key.ID, &key.Name, &status, &key.CreatedAt, &expiresAt, &lastUsed); err != nil {
				return err
			}
			key.Status = APIKeyStatus(status)
			if expiresAt.Valid {
				value := expiresAt.String
				key.ExpiresAt = &value
			}
			if lastUsed.Valid {
				value := lastUsed.String
				key.LastUsedAt = &value
			}
			result = append(result, key)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, mapStorageError(err)
	}
	return result, nil
}

func (service *Service) CreateAPIKey(ctx context.Context, serviceAccountID string, input APIKeyCreateInput) (APIKeyReveal, error) {
	if !serviceAccountIDPattern.MatchString(serviceAccountID) {
		return APIKeyReveal{}, ErrNotFound
	}
	keyName := input.Name
	if strings.TrimSpace(keyName) == "" {
		keyName = "API key"
	}
	keyName, err := normalizeName(keyName, "/name", "API Key")
	if err != nil {
		return APIKeyReveal{}, err
	}
	var expiresAt *time.Time
	if input.ExpiresAt != "" {
		value, err := time.Parse(time.RFC3339Nano, input.ExpiresAt)
		if err != nil || !value.After(service.now()) {
			return APIKeyReveal{}, validationError("/expiresAt", "INVALID_EXPIRATION", "Choose a future expiration time in RFC 3339 format.")
		}
		value = value.UTC()
		expiresAt = &value
	}
	var reveal APIKeyReveal
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		actor, _, err := service.requireOperation(ctx, tx, OperationAPIKeysCreate)
		if err != nil {
			return err
		}
		account, err := readAccount(ctx, tx, serviceAccountID)
		if err != nil {
			return err
		}
		if account.Account.Status != AccountActive {
			return fmt.Errorf("%w: a key cannot be issued for a disabled Service Account", ErrConflict)
		}
		if err := service.requireTargetWithinActor(ctx, tx, account.Grant); err != nil {
			return err
		}
		key, createdReveal, err := service.createAPIKeyInTransaction(ctx, tx, account, APIKeyCreateInput{Name: keyName}, expiresAt)
		if err != nil {
			return err
		}
		if err := service.appendAudit(ctx, tx, actor, "apiKey.created", audit.Resource{Kind: "apiKey", ID: key.ID}); err != nil {
			return err
		}
		reveal = createdReveal
		return nil
	})
	if err != nil {
		return APIKeyReveal{}, mapStorageError(err)
	}
	return reveal, nil
}

func (service *Service) RevokeAPIKey(ctx context.Context, apiKeyID string) error {
	if !apiKeyIDPattern.MatchString(apiKeyID) {
		return ErrNotFound
	}
	return mapStorageError(service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		actor, _, err := service.requireOperation(ctx, tx, OperationAPIKeysRevoke)
		if err != nil {
			return err
		}
		key, err := readAPIKey(ctx, tx, apiKeyID)
		if err != nil {
			return err
		}
		account, err := readAccount(ctx, tx, key.ServiceAccountID)
		if err != nil {
			return err
		}
		if err := service.requireTargetWithinActor(ctx, tx, account.Grant); err != nil {
			return err
		}
		if key.Status == APIKeyRevoked {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_service_account_api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'`, timestamp(service.now()), apiKeyID); err != nil {
			return err
		}
		return service.appendAudit(ctx, tx, actor, "apiKey.revoked", audit.Resource{Kind: "apiKey", ID: apiKeyID})
	}))
}

func (service *Service) AuthenticateAPIKey(ctx context.Context, token string) (authorization.Principal, Grant, error) {
	keyID, _, err := parseAPIKey(token)
	if err != nil {
		return authorization.Principal{}, Grant{}, ErrUnauthenticated
	}
	expectedHash := sha256.Sum256([]byte(token))
	var principal authorization.Principal
	var grant Grant
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var accountID string
		var storedHash []byte
		var keyStatus string
		var expiresAt sql.NullString
		var accountStatus string
		var preset string
		var version int
		var operationsJSON string
		if err := tx.QueryRowContext(ctx, `SELECT k.service_account_id, k.token_hash, k.status, k.expires_at,
			a.status, a.permission, a.custom_permission_version, a.custom_operations_json
			FROM modelry_service_account_api_keys k JOIN modelry_service_accounts a ON a.id = k.service_account_id WHERE k.id = ?`, keyID).
			Scan(&accountID, &storedHash, &keyStatus, &expiresAt, &accountStatus, &preset, &version, &operationsJSON); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnauthenticated
			}
			return err
		}
		if keyStatus != string(APIKeyActive) || accountStatus != string(AccountActive) || subtle.ConstantTimeCompare(storedHash, expectedHash[:]) != 1 {
			return ErrUnauthenticated
		}
		if expiresAt.Valid {
			expires, err := parseTimestamp(expiresAt.String)
			if err != nil {
				return fmt.Errorf("%w: decode API Key expiry: %v", ErrStorage, err)
			}
			if !expires.After(service.now()) {
				return ErrUnauthenticated
			}
		}
		grant, err = grantFromColumns(preset, version, operationsJSON)
		if err != nil {
			return err
		}
		now := timestamp(service.now())
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_service_account_api_keys SET last_used_at = ? WHERE id = ? AND status = 'active'`, now, keyID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_service_accounts SET last_used_at = ? WHERE id = ? AND status = 'active'`, now, accountID); err != nil {
			return err
		}
		principal = authorization.Principal{Type: authorization.PrincipalServiceAccount, ID: accountID}
		return nil
	})
	if errors.Is(err, ErrUnauthenticated) {
		return authorization.Principal{}, Grant{}, ErrUnauthenticated
	}
	if err != nil {
		return authorization.Principal{}, Grant{}, mapStorageError(err)
	}
	return principal, grant, nil
}

func (service *Service) createAPIKeyInTransaction(ctx context.Context, tx storage.Executor, account accountRow, input APIKeyCreateInput, expiresAtValue ...*time.Time) (APIKey, APIKeyReveal, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "API key"
	}
	name, err := normalizeName(name, "/name", "API Key")
	if err != nil {
		return APIKey{}, APIKeyReveal{}, err
	}
	keyID, err := newIdentifier("key_")
	if err != nil {
		return APIKey{}, APIKeyReveal{}, err
	}
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(secretBytes); err != nil {
		return APIKey{}, APIKeyReveal{}, fmt.Errorf("generate API Key secret: %w", err)
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	plaintext := apiKeyPrefix + keyID + "." + secret
	hash := sha256.Sum256([]byte(plaintext))
	now := service.now().UTC()
	var expiresAt *time.Time
	if len(expiresAtValue) > 0 {
		expiresAt = expiresAtValue[0]
	}
	if expiresAt == nil && input.ExpiresAt != "" {
		parsed, err := time.Parse(time.RFC3339Nano, input.ExpiresAt)
		if err != nil || !parsed.After(now) {
			return APIKey{}, APIKeyReveal{}, validationError("/expiresAt", "INVALID_EXPIRATION", "Choose a future expiration time in RFC 3339 format.")
		}
		parsed = parsed.UTC()
		expiresAt = &parsed
	}
	var expiresAtString any
	var expiresAtPointer *string
	if expiresAt != nil {
		value := timestamp(*expiresAt)
		expiresAtString = value
		expiresAtPointer = &value
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_service_account_api_keys (
		id, service_account_id, name, token_hash, status, created_at, expires_at
	) VALUES (?, ?, ?, ?, 'active', ?, ?)`, keyID, account.Account.ID, name, hash[:], timestamp(now), expiresAtString); err != nil {
		return APIKey{}, APIKeyReveal{}, err
	}
	key := APIKey{ID: keyID, Name: name, Status: APIKeyActive, CreatedAt: timestamp(now), ExpiresAt: expiresAtPointer}
	return key, APIKeyReveal{APIKey: key, Secret: plaintext, RevealedOnce: true}, nil
}

func readAPIKey(ctx context.Context, query storage.Executor, id string) (apiKeyRow, error) {
	var row apiKeyRow
	var status string
	var lastUsedAt sql.NullString
	if err := query.QueryRowContext(ctx, `SELECT id, service_account_id, name, token_hash, status, created_at, expires_at, last_used_at, revoked_at
		FROM modelry_service_account_api_keys WHERE id = ?`, id).Scan(
		&row.ID, &row.ServiceAccountID, &row.Name, &row.TokenHash, &status, &row.CreatedAt, &row.ExpiresAtNull, &lastUsedAt, &row.RevokedAt); err != nil {
		return apiKeyRow{}, err
	}
	row.Status = APIKeyStatus(status)
	if row.ExpiresAtNull.Valid {
		value := row.ExpiresAtNull.String
		row.ExpiresAt = &value
	}
	if lastUsedAt.Valid {
		value := lastUsedAt.String
		row.APIKey.LastUsedAt = &value
	}
	return row, nil
}

func parseAPIKey(value string) (string, []byte, error) {
	if len(value) < len(apiKeyPrefix)+10 || len(value) > 256 || !strings.HasPrefix(value, apiKeyPrefix) {
		return "", nil, ErrUnauthenticated
	}
	keyID, secret, ok := strings.Cut(strings.TrimPrefix(value, apiKeyPrefix), ".")
	if !ok || !apiKeyIDPattern.MatchString(keyID) {
		return "", nil, ErrUnauthenticated
	}
	decoded, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil || len(decoded) != 32 {
		return "", nil, ErrUnauthenticated
	}
	return keyID, decoded, nil
}
