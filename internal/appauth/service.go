package appauth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrInvalidArgument      = backendmodel.ErrInvalidArgument
	ErrNotFound             = backendmodel.ErrNotFound
	ErrConflict             = backendmodel.ErrConflict
	ErrUnauthenticated      = errors.New("application authentication failed")
	ErrRegistrationDisabled = errors.New("application self registration is disabled")
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Service struct {
	store    transactionalStore
	models   *backendmodel.Service
	profiles ProfileWriter
	now      func() time.Time
}

// NewService 初始化独立的 Auth Configuration、Password Credential 与 Session 持久化边界。
func NewService(ctx context.Context, store transactionalStore, models *backendmodel.Service, profiles ProfileWriter) (*Service, error) {
	if store == nil || models == nil || profiles == nil {
		return nil, fmt.Errorf("%w: storage, Applied Model, and Profile writer are required", ErrInvalidArgument)
	}
	service := &Service{store: store, models: models, profiles: profiles, now: func() time.Time { return time.Now().UTC() }}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		statements := []string{
			`CREATE TABLE IF NOT EXISTS modelry_auth_configurations (
				collection_id TEXT PRIMARY KEY NOT NULL,
				applied_json TEXT NOT NULL,
				pending_json TEXT,
				version INTEGER NOT NULL CHECK (version >= 1),
				updated_at TEXT NOT NULL,
				FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id)
			)`,
			`CREATE TABLE IF NOT EXISTS modelry_app_password_credentials (
				collection_id TEXT NOT NULL,
				user_record_id TEXT NOT NULL,
				email_key TEXT NOT NULL,
				password_salt BLOB NOT NULL CHECK (length(password_salt) = 16),
				password_hash BLOB NOT NULL CHECK (length(password_hash) = 32),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (collection_id, user_record_id),
				UNIQUE (collection_id, email_key),
				FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id)
			)`,
			`CREATE TABLE IF NOT EXISTS modelry_app_sessions (
				id TEXT PRIMARY KEY NOT NULL,
				collection_id TEXT NOT NULL,
				user_record_id TEXT NOT NULL,
				token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				last_used_at TEXT,
				revoked_at TEXT,
				FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id)
			)`,
			`CREATE INDEX IF NOT EXISTS modelry_app_sessions_user_idx ON modelry_app_sessions (collection_id, user_record_id, created_at DESC, id DESC)`,
			`CREATE INDEX IF NOT EXISTS modelry_app_sessions_expiry_idx ON modelry_app_sessions (expires_at)`,
		}
		for _, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize application authentication storage: %w", err)
			}
		}
		rows, err := tx.QueryContext(ctx, `SELECT c.model_json FROM modelry_backend_collections c
			LEFT JOIN modelry_auth_configurations a ON a.collection_id = c.id
			WHERE a.collection_id IS NULL`)
		if err != nil {
			return fmt.Errorf("find Auth Collections without Configuration: %w", err)
		}
		var missing []backendmodel.Collection
		for rows.Next() {
			var modelJSON string
			if err := rows.Scan(&modelJSON); err != nil {
				rows.Close()
				return fmt.Errorf("read Collection for Auth Configuration defaults: %w", err)
			}
			var collection backendmodel.Collection
			if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
				rows.Close()
				return fmt.Errorf("decode Collection for Auth Configuration defaults: %w", err)
			}
			if collection.Type == backendmodel.CollectionTypeAuth {
				missing = append(missing, collection)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("finish reading Auth Configuration defaults: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close Auth Configuration defaults: %w", err)
		}
		for _, collection := range missing {
			if err := InitializeCollection(ctx, tx, collection, nil); err != nil {
				return fmt.Errorf("initialize default Auth Configuration for Collection %q: %w", collection.ID, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return service, nil
}

// InitializeCollection 在创建 Collection 的同一事务中写入 Auth Configuration；Normal Collection 不能接收认证配置。
func InitializeCollection(ctx context.Context, tx storage.Executor, collection backendmodel.Collection, configuration *AuthConfig) error {
	if collection.Type != backendmodel.CollectionTypeAuth {
		if configuration != nil {
			return fmt.Errorf("%w: Authentication Configuration can only be applied to an Auth Collection", ErrInvalidArgument)
		}
		return nil
	}
	if tx == nil || collection.ID == "" {
		return fmt.Errorf("%w: transaction and Auth Collection are required", ErrInvalidArgument)
	}
	value := defaultAuthConfig()
	if configuration != nil {
		value = *configuration
	}
	if err := validateAuthConfig(value); err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode initial Auth Configuration: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_auth_configurations (collection_id, applied_json, pending_json, version, updated_at) VALUES (?, ?, NULL, 1, ?)`, collection.ID, string(encoded), timestamp(time.Now().UTC())); err != nil {
		return fmt.Errorf("persist initial Auth Configuration: %w", err)
	}
	return nil
}

func (service *Service) GetConfiguration(ctx context.Context, collectionID string) (AuthConfigState, error) {
	var state AuthConfigState
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		collection, err := loadCollection(ctx, snapshot, collectionID)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		state, _, err = readConfig(ctx, snapshot, collection)
		return err
	})
	return state, err
}

func (service *Service) SaveConfiguration(ctx context.Context, collectionID string, input AuthConfigSaveInput) (AuthConfigState, error) {
	if input.ExpectedVersion < 1 {
		return AuthConfigState{}, validationError("/expectedVersion", "MINIMUM", "Reload the Auth Configuration and try again.")
	}
	if err := validateAuthConfig(input.Configuration); err != nil {
		return AuthConfigState{}, err
	}
	var state AuthConfigState
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		current, rowExists, err := readConfig(ctx, tx, collection)
		if err != nil {
			return err
		}
		if input.ExpectedVersion != current.Version {
			return fmt.Errorf("%w: Auth Configuration is at version %d, not %d", ErrConflict, current.Version, input.ExpectedVersion)
		}
		var pendingJSON any
		pending := input.Configuration
		if input.Configuration == current.Applied {
			pending = current.Applied
		} else {
			encoded, err := json.Marshal(input.Configuration)
			if err != nil {
				return fmt.Errorf("encode pending Auth Configuration: %w", err)
			}
			pendingJSON = string(encoded)
		}
		version := current.Version + 1
		if rowExists {
			result, err := tx.ExecContext(ctx, `UPDATE modelry_auth_configurations SET pending_json = ?, version = ?, updated_at = ? WHERE collection_id = ? AND version = ?`, pendingJSON, version, timestamp(service.now()), collectionID, current.Version)
			if err != nil {
				return fmt.Errorf("save pending Auth Configuration: %w", err)
			}
			if err := expectOneRow(result); err != nil {
				return err
			}
		} else {
			appliedJSON, err := json.Marshal(current.Applied)
			if err != nil {
				return fmt.Errorf("encode default Auth Configuration: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_auth_configurations (collection_id, applied_json, pending_json, version, updated_at) VALUES (?, ?, ?, ?, ?)`, collectionID, string(appliedJSON), pendingJSON, version, timestamp(service.now())); err != nil {
				return fmt.Errorf("create Auth Configuration: %w", err)
			}
		}
		state = AuthConfigState{Applied: current.Applied, Pending: pending, Version: version, HasPending: pendingJSON != nil}
		return nil
	})
	return state, err
}

func (service *Service) ApplyConfiguration(ctx context.Context, collectionID string, expectedVersion int) (AuthConfigState, error) {
	if expectedVersion < 1 {
		return AuthConfigState{}, validationError("/expectedVersion", "MINIMUM", "Reload the Auth Configuration and try again.")
	}
	var state AuthConfigState
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		current, exists, err := readConfig(ctx, tx, collection)
		if err != nil {
			return err
		}
		if !exists || !current.HasPending {
			return fmt.Errorf("%w: Auth Collection has no pending Configuration", ErrNotFound)
		}
		if expectedVersion != current.Version {
			return fmt.Errorf("%w: pending Auth Configuration is at version %d, not %d", ErrConflict, current.Version, expectedVersion)
		}
		if err := validateAuthConfig(current.Pending); err != nil {
			return err
		}
		encoded, err := json.Marshal(current.Pending)
		if err != nil {
			return fmt.Errorf("encode applied Auth Configuration: %w", err)
		}
		version := current.Version + 1
		result, err := tx.ExecContext(ctx, `UPDATE modelry_auth_configurations SET applied_json = ?, pending_json = NULL, version = ?, updated_at = ? WHERE collection_id = ? AND version = ? AND pending_json IS NOT NULL`, string(encoded), version, timestamp(service.now()), collectionID, current.Version)
		if err != nil {
			return fmt.Errorf("apply Auth Configuration: %w", err)
		}
		if err := expectOneRow(result); err != nil {
			return err
		}
		state = AuthConfigState{Applied: current.Pending, Pending: current.Pending, Version: version}
		return nil
	})
	return state, err
}

func (service *Service) DiscardConfiguration(ctx context.Context, collectionID string, expectedVersion int) (AuthConfigState, error) {
	if expectedVersion < 1 {
		return AuthConfigState{}, validationError("/expectedVersion", "MINIMUM", "Reload the Auth Configuration and try again.")
	}
	var state AuthConfigState
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		if err := requireAuthCollection(collection); err != nil {
			return err
		}
		current, exists, err := readConfig(ctx, tx, collection)
		if err != nil {
			return err
		}
		if !exists || !current.HasPending {
			return fmt.Errorf("%w: Auth Collection has no pending Configuration", ErrNotFound)
		}
		if expectedVersion != current.Version {
			return fmt.Errorf("%w: pending Auth Configuration is at version %d, not %d", ErrConflict, current.Version, expectedVersion)
		}
		version := current.Version + 1
		result, err := tx.ExecContext(ctx, `UPDATE modelry_auth_configurations SET pending_json = NULL, version = ?, updated_at = ? WHERE collection_id = ? AND version = ? AND pending_json IS NOT NULL`, version, timestamp(service.now()), collectionID, current.Version)
		if err != nil {
			return fmt.Errorf("discard pending Auth Configuration: %w", err)
		}
		if err := expectOneRow(result); err != nil {
			return err
		}
		state = AuthConfigState{Applied: current.Applied, Pending: current.Applied, Version: version}
		return nil
	})
	return state, err
}

func defaultAuthConfig() AuthConfig {
	return AuthConfig{EmailPasswordEnabled: true, SelfRegistration: false, SessionDurationDays: 7}
}

func validateAuthConfig(configuration AuthConfig) error {
	if configuration.SessionDurationDays < 1 {
		return &ValidationFailure{Violation: Violation{Path: "/configuration/sessionDurationDays", Code: "MINIMUM", Message: "Session duration must be at least one day."}}
	}
	return nil
}

func validationError(path, code, message string) error {
	return &ValidationFailure{Violation: Violation{Path: path, Code: code, Message: message}}
}

func requireAuthCollection(collection backendmodel.Collection) error {
	if collection.Type != backendmodel.CollectionTypeAuth {
		return fmt.Errorf("%w: Authentication Configuration requires an Auth Collection", ErrInvalidArgument)
	}
	return nil
}

func readConfig(ctx context.Context, query storage.Executor, collection backendmodel.Collection) (AuthConfigState, bool, error) {
	var appliedJSON string
	var pendingJSON sql.NullString
	var version int
	err := query.QueryRowContext(ctx, `SELECT applied_json, pending_json, version FROM modelry_auth_configurations WHERE collection_id = ?`, collection.ID).Scan(&appliedJSON, &pendingJSON, &version)
	if errors.Is(err, sql.ErrNoRows) {
		defaults := defaultAuthConfig()
		return AuthConfigState{Applied: defaults, Pending: defaults, Version: 1}, false, nil
	}
	if err != nil {
		return AuthConfigState{}, false, fmt.Errorf("read Auth Configuration: %w", err)
	}
	var applied AuthConfig
	if err := json.Unmarshal([]byte(appliedJSON), &applied); err != nil {
		return AuthConfigState{}, false, fmt.Errorf("decode applied Auth Configuration: %w", err)
	}
	state := AuthConfigState{Applied: applied, Pending: applied, Version: version}
	if pendingJSON.Valid {
		if err := json.Unmarshal([]byte(pendingJSON.String), &state.Pending); err != nil {
			return AuthConfigState{}, false, fmt.Errorf("decode pending Auth Configuration: %w", err)
		}
		state.HasPending = true
	}
	return state, true, nil
}

func loadCollection(ctx context.Context, query storage.Executor, collectionID string) (backendmodel.Collection, error) {
	if collectionID == "" {
		return backendmodel.Collection{}, fmt.Errorf("%w: collectionId is required", ErrInvalidArgument)
	}
	var modelJSON string
	if err := query.QueryRowContext(ctx, `SELECT model_json FROM modelry_backend_collections WHERE id = ?`, collectionID).Scan(&modelJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return backendmodel.Collection{}, fmt.Errorf("%w: Collection was not found", ErrNotFound)
		}
		return backendmodel.Collection{}, fmt.Errorf("read Collection Applied Model: %w", err)
	}
	var collection backendmodel.Collection
	if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
		return backendmodel.Collection{}, fmt.Errorf("decode Collection Applied Model: %w", err)
	}
	return collection, nil
}

func timestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func expectOneRow(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("verify Auth Configuration transition: %w", err)
	}
	if count != 1 {
		return fmt.Errorf("%w: Auth Configuration changed during the operation", ErrConflict)
	}
	return nil
}

var _ ProfileWriter = (*records.Service)(nil)
