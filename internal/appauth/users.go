package appauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"strings"

	"crypto/pbkdf2"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	passwordIterations = 600_000
	passwordSaltBytes  = 16
	passwordHashBytes  = 32
	passwordMaxBytes   = 1024
)

func (service *Service) CreateUser(ctx context.Context, collectionID string, profile map[string]any, password string) (records.Record, error) {
	prepared, email, err := prepareProfile(profile)
	if err != nil {
		return records.Record{}, err
	}
	salt, passwordHash, err := derivePassword(password)
	if err != nil {
		return records.Record{}, err
	}
	var created records.Record
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		created, err = service.profiles.CreateInTransaction(ctx, tx, collection.ID, prepared)
		if err != nil {
			return fmt.Errorf("create App User Profile: %w", mapProfileError(err))
		}
		if err := insertCredential(ctx, tx, collection.ID, created.ID, email, salt, passwordHash, timestamp(service.now())); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return records.Record{}, err
	}
	publishProfileRecordEvents(service.profiles, collectionID)
	return created, nil
}

func (service *Service) Register(ctx context.Context, collectionName string, profile map[string]any, password string) (records.Record, error) {
	prepared, email, err := prepareProfile(profile)
	if err != nil {
		return records.Record{}, err
	}
	salt, passwordHash, err := derivePassword(password)
	if err != nil {
		return records.Record{}, err
	}
	var created records.Record
	var createdCollectionID string
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := collectionByName(ctx, tx, collectionName)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		createdCollectionID = collection.ID
		configuration, _, err := readConfig(ctx, tx, collection)
		if err != nil {
			return err
		}
		if err := validateAuthConfig(configuration.Applied); err != nil || !configuration.Applied.EmailPasswordEnabled {
			return ErrRegistrationDisabled
		}
		if !configuration.Applied.SelfRegistration {
			return ErrRegistrationDisabled
		}
		created, err = service.profiles.CreateInTransaction(ctx, tx, collection.ID, prepared)
		if err != nil {
			return fmt.Errorf("create registered App User Profile: %w", mapProfileError(err))
		}
		if err := insertCredential(ctx, tx, collection.ID, created.ID, email, salt, passwordHash, timestamp(service.now())); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return records.Record{}, err
	}
	publishProfileRecordEvents(service.profiles, createdCollectionID)
	return created, nil
}

func publishProfileRecordEvents(profiles ProfileWriter, collectionID string) {
	if notifier, ok := profiles.(interface{ PublishRecordEventsCommitted(string) }); ok {
		notifier.PublishRecordEventsCommitted(collectionID)
	}
}

func (service *Service) ListUsers(ctx context.Context, collectionID string, options records.ListOptions) (ApplicationUserPage, error) {
	collection, err := service.models.GetCollection(ctx, collectionID)
	if err != nil {
		return ApplicationUserPage{}, mapBackendError(err)
	}
	if err := requireAuthCollection(collection); err != nil {
		return ApplicationUserPage{}, err
	}
	page, err := service.profiles.List(ctx, collectionID, options)
	if err != nil {
		return ApplicationUserPage{}, err
	}
	result := ApplicationUserPage{Data: make([]ApplicationUser, 0, len(page.Data)), NextCursor: page.NextCursor}
	for _, record := range page.Data {
		email, ok := record.Values["email"].(string)
		if !ok {
			continue
		}
		result.Data = append(result.Data, ApplicationUser{RecordID: record.ID, Email: email})
	}
	return result, nil
}

func (service *Service) SetPassword(ctx context.Context, collectionID, recordID, password string) error {
	if err := validatePassword(password); err != nil {
		return err
	}
	salt, passwordHash, err := derivePassword(password)
	if err != nil {
		return err
	}
	projection, err := service.models.GetRecordProjection(ctx, collectionID)
	if err != nil {
		return mapBackendError(err)
	}
	var emailField backendmodel.ProjectedField
	for _, field := range projection.Fields {
		if field.Name == "email" && !field.System {
			emailField = field
			break
		}
	}
	if emailField.ID == "" {
		return fmt.Errorf("%w: Auth Collection email identifier is unavailable", ErrInvalidArgument)
	}
	table, err := storage.QuoteSQLiteIdentifier(projection.TableName)
	if err != nil {
		return err
	}
	column, err := storage.QuoteSQLiteIdentifier(emailField.ColumnName)
	if err != nil {
		return err
	}
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		if collection.SchemaVersion != projection.SchemaVersion {
			return fmt.Errorf("%w: Auth Collection schema changed; reload and retry", ErrConflict)
		}
		var email string
		if err := tx.QueryRowContext(ctx, `SELECT `+column+` FROM `+table+` WHERE "id" = ?`, recordID).Scan(&email); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: App User was not found", ErrNotFound)
			}
			return fmt.Errorf("read App User email identifier: %w", err)
		}
		emailKey, err := normalizeEmail(email)
		if err != nil {
			return fmt.Errorf("%w: App User email identifier is invalid", ErrInvalidArgument)
		}
		now := timestamp(service.now())
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_app_password_credentials (collection_id, user_record_id, email_key, password_salt, password_hash, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(collection_id, user_record_id) DO UPDATE SET email_key = excluded.email_key, password_salt = excluded.password_salt, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
			collectionID, recordID, emailKey, salt, passwordHash, now, now); err != nil {
			return mapCredentialWriteError(err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE collection_id = ? AND user_record_id = ?`, now, collectionID, recordID); err != nil {
			return fmt.Errorf("revoke Sessions after password change: %w", err)
		}
		return nil
	})
}

func prepareProfile(profile map[string]any) (map[string]any, string, error) {
	if profile == nil {
		return nil, "", validationError("/profile", "REQUIRED", "Profile values are required.")
	}
	if _, exists := profile["password"]; exists {
		return nil, "", validationError("/profile/password", "CREDENTIAL_NOT_FIELD", "Password is a Credential and cannot be included in Profile values.")
	}
	emailValue, ok := profile["email"].(string)
	if !ok {
		return nil, "", validationError("/profile/email", "REQUIRED", "Email is required.")
	}
	emailKey, err := normalizeEmail(emailValue)
	if err != nil {
		return nil, "", validationError("/profile/email", "FORMAT", "Enter a valid email address.")
	}
	prepared := make(map[string]any, len(profile))
	for key, value := range profile {
		if key == "password" {
			continue
		}
		prepared[key] = value
	}
	prepared["email"] = emailKey
	return prepared, emailKey, nil
}

func validatePassword(password string) error {
	if len(password) == 0 {
		return validationError("/password", "REQUIRED", "Password is required.")
	}
	if len(password) > passwordMaxBytes {
		return validationError("/password", "TOO_LONG", "Password must be 1024 bytes or fewer.")
	}
	return nil
}

func derivePassword(password string) ([]byte, []byte, error) {
	if err := validatePassword(password); err != nil {
		return nil, nil, err
	}
	salt := make([]byte, passwordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return nil, nil, fmt.Errorf("generate Password Credential salt: %w", err)
	}
	derived, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, passwordHashBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("derive Password Credential: %w", err)
	}
	return salt, derived, nil
}

func verifyPassword(password string, salt, expected []byte) bool {
	if len(password) == 0 || len(password) > passwordMaxBytes || len(salt) != passwordSaltBytes || len(expected) != passwordHashBytes {
		return false
	}
	actual, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, passwordHashBytes)
	return err == nil && subtle.ConstantTimeCompare(actual, expected) == 1
}

func insertCredential(ctx context.Context, tx storage.Executor, collectionID, userID, email string, salt, passwordHash []byte, now string) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_app_password_credentials (collection_id, user_record_id, email_key, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, collectionID, userID, email, salt, passwordHash, now, now); err != nil {
		return mapCredentialWriteError(err)
	}
	return nil
}

func mapCredentialWriteError(err error) error {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "unique constraint") || strings.Contains(message, "primary key") {
		return fmt.Errorf("%w: an App User with this email already exists", ErrConflict)
	}
	return fmt.Errorf("persist Password Credential: %w", err)
}

func normalizeEmail(email string) (string, error) {
	trimmed := strings.TrimSpace(email)
	address, err := mail.ParseAddress(trimmed)
	if err != nil || address.Address != trimmed || !strings.Contains(trimmed, "@") || len(trimmed) > 320 {
		return "", errors.New("invalid email address")
	}
	return strings.ToLower(trimmed), nil
}

func mapBackendError(err error) error {
	switch {
	case errors.Is(err, backendmodel.ErrInvalidArgument):
		return fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	case errors.Is(err, backendmodel.ErrNotFound):
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	case errors.Is(err, backendmodel.ErrConflict):
		return fmt.Errorf("%w: %v", ErrConflict, err)
	default:
		return err
	}
}

func mapProfileError(err error) error {
	switch {
	case errors.Is(err, records.ErrInvalidArgument):
		return errors.Join(ErrInvalidArgument, err)
	case errors.Is(err, records.ErrNotFound):
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	case errors.Is(err, records.ErrConflict):
		return fmt.Errorf("%w: %v", ErrConflict, err)
	case errors.Is(err, records.ErrUnauthenticated):
		return ErrUnauthenticated
	default:
		return err
	}
}

func dummyPasswordCheck(password string) {
	var salt [passwordSaltBytes]byte
	var expected [passwordHashBytes]byte
	derived, err := pbkdf2.Key(sha256.New, password, salt[:], passwordIterations, passwordHashBytes)
	if err == nil {
		_ = subtle.ConstantTimeCompare(expected[:], derived)
	}
}

func newOpaque(prefix string, bytesCount int) (string, []byte, error) {
	value := make([]byte, bytesCount)
	if _, err := rand.Read(value); err != nil {
		return "", nil, fmt.Errorf("generate opaque Session token: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value), value, nil
}

func tokenDigest(token string) ([]byte, error) {
	const prefix = "app_"
	if !strings.HasPrefix(token, prefix) {
		return nil, ErrUnauthenticated
	}
	encoded := strings.TrimPrefix(token, prefix)
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return nil, ErrUnauthenticated
	}
	digest := sha256.Sum256(raw)
	return digest[:], nil
}
