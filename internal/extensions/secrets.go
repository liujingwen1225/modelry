package extensions

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/liujingwen1225/modelry/internal/extensions/secretstore"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) ListSecrets(ctx context.Context) ([]SecretMetadata, error) {
	secrets := make([]SecretMetadata, 0)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT id,name,length(value_cipher)>0,created_at,updated_at FROM modelry_secrets ORDER BY name COLLATE NOCASE,id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item SecretMetadata
			var configured int
			var created, updated string
			if err := rows.Scan(&item.ID, &item.Name, &configured, &created, &updated); err != nil {
				return err
			}
			item.Configured = configured == 1
			item.CreatedAt = parseTime(created)
			item.UpdatedAt = parseTime(updated)
			secrets = append(secrets, item)
		}
		return rows.Err()
	})
	return secrets, err
}

func ensureSecretNameKey(ctx context.Context, tx storage.Executor) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA table_info(modelry_secrets)`)
	if err != nil {
		return err
	}
	hasNameKey := false
	for rows.Next() {
		var index, notNull, primaryKey int
		var name, dataType string
		var defaultValue sql.NullString
		if err := rows.Scan(&index, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return err
		}
		if name == "name_key" {
			hasNameKey = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if !hasNameKey {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE modelry_secrets ADD COLUMN name_key TEXT`); err != nil {
			return err
		}
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,name FROM modelry_secrets WHERE name_key IS NULL OR name_key=''`)
	if err != nil {
		return err
	}
	type item struct{ id, name string }
	var names []item
	for rows.Next() {
		var value item
		if err := rows.Scan(&value.id, &value.name); err != nil {
			rows.Close()
			return err
		}
		names = append(names, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, value := range names {
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_secrets SET name_key=? WHERE id=?`, secretNameKey(value.name), value.id); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS modelry_secrets_name_key ON modelry_secrets(name_key)`)
	return err
}

func (service *Service) CreateSecret(ctx context.Context, name, value string) (SecretMetadata, error) {
	name, err := validateSecretName(name)
	if err != nil {
		return SecretMetadata{}, err
	}
	if !utf8.ValidString(value) || len([]byte(value)) == 0 || len([]byte(value)) > 16<<10 {
		return SecretMetadata{}, invalidField("/value", "invalidSecretValue", "Secret values must contain between 1 and 16 KiB of UTF-8 data.")
	}
	id, err := newID("sec_")
	if err != nil {
		return SecretMetadata{}, err
	}
	plain := []byte(value)
	defer clear(plain)
	var metadata SecretMetadata
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := ensureSecretNameAvailable(ctx, tx, "", name); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_secrets WHERE length(value_cipher)>0`).Scan(&count); err != nil {
			return err
		}
		if err := service.secrets.EnsureKey(count > 0); err != nil {
			return mapSecretStoreError(err)
		}
		ciphertext, err := service.secrets.Encrypt(id, 1, plain)
		if err != nil {
			return mapSecretStoreError(err)
		}
		now := service.timestamp()
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_secrets(id,name,name_key,value_cipher,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`, id, name, secretNameKey(name), ciphertext, now, now); err != nil {
			return mapWriteError(err)
		}
		metadata = SecretMetadata{ID: id, Name: name, Configured: true, CreatedAt: parseTime(now), UpdatedAt: parseTime(now)}
		return nil
	})
	return metadata, err
}

func (service *Service) RenameSecret(ctx context.Context, secretID, name string) (SecretMetadata, error) {
	name, err := validateSecretName(name)
	if err != nil {
		return SecretMetadata{}, err
	}
	var metadata SecretMetadata
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := ensureSecretNameAvailable(ctx, tx, secretID, name); err != nil {
			return err
		}
		now := service.timestamp()
		result, err := tx.ExecContext(ctx, `UPDATE modelry_secrets SET name=?,name_key=?,updated_at=? WHERE id=?`, name, secretNameKey(name), now, secretID)
		if err != nil {
			return mapWriteError(err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		var configured int
		var created string
		if err := tx.QueryRowContext(ctx, `SELECT name,length(value_cipher)>0,created_at FROM modelry_secrets WHERE id=?`, secretID).Scan(&metadata.Name, &configured, &created); err != nil {
			return err
		}
		metadata.ID = secretID
		metadata.Configured = configured == 1
		metadata.CreatedAt = parseTime(created)
		metadata.UpdatedAt = parseTime(now)
		return nil
	})
	return metadata, err
}

func (service *Service) ReplaceSecretValue(ctx context.Context, secretID, value string) (SecretMetadata, error) {
	if !utf8.ValidString(value) || len([]byte(value)) == 0 || len([]byte(value)) > 16<<10 {
		return SecretMetadata{}, invalidField("/value", "invalidSecretValue", "Secret values must contain between 1 and 16 KiB of UTF-8 data.")
	}
	plain := []byte(value)
	defer clear(plain)
	var metadata SecretMetadata
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var version int64
		var created string
		if err := tx.QueryRowContext(ctx, `SELECT version,created_at FROM modelry_secrets WHERE id=?`, secretID).Scan(&version, &created); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_secrets WHERE length(value_cipher)>0`).Scan(&count); err != nil {
			return err
		}
		if err := service.secrets.EnsureKey(count > 0); err != nil {
			return mapSecretStoreError(err)
		}
		version++
		ciphertext, err := service.secrets.Encrypt(secretID, version, plain)
		if err != nil {
			return mapSecretStoreError(err)
		}
		now := service.timestamp()
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_secrets SET value_cipher=?,version=?,updated_at=? WHERE id=?`, ciphertext, version, now, secretID); err != nil {
			return err
		}
		if err := service.cancelPendingForSecret(ctx, tx, secretID); err != nil {
			return err
		}
		var name string
		var configured int
		if err := tx.QueryRowContext(ctx, `SELECT name,length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, secretID).Scan(&name, &configured); err != nil {
			return err
		}
		metadata = SecretMetadata{ID: secretID, Name: name, Configured: configured == 1, CreatedAt: parseTime(created), UpdatedAt: parseTime(now)}
		return nil
	})
	if err == nil {
		service.cancelRemovedActive("", secretID, "")
	}
	return metadata, err
}

func (service *Service) DeleteSecret(ctx context.Context, secretID string) error {
	observer := service.currentSecretRevocationObserver()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if observer != nil {
			if err := observer.RevokeSecretInTransaction(ctx, tx, secretID); err != nil {
				return err
			}
		}
		if err := service.cancelPendingForSecret(ctx, tx, secretID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM modelry_secrets WHERE id=?`, secretID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err == nil {
		service.cancelRemovedActive("", secretID, "")
		if observer != nil {
			observer.SecretRevoked(secretID)
		}
	}
	return err
}

// SecretMetadata 只向内部 Webhook 边界提供 Owner 配置的名称与是否已配置状态，不提供 Secret 明文。
func (service *Service) SecretMetadata(ctx context.Context, secretID string) (string, bool, error) {
	var name string
	var configured int
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		err := snapshot.QueryRowContext(ctx, `SELECT name,length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, secretID).Scan(&name, &configured)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	})
	return name, configured == 1, err
}

// WithSecretValue 解密当前 Secret 值并调用受限内部回调，返回前清空明文缓冲区。
func (service *Service) WithSecretValue(ctx context.Context, secretID string, use func([]byte) error) error {
	if use == nil || secretID == "" {
		return ErrSecretNotAvailable
	}
	var version int64
	var ciphertext []byte
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := snapshot.QueryRowContext(ctx, `SELECT version,value_cipher FROM modelry_secrets WHERE id=?`, secretID).Scan(&version, &ciphertext); errors.Is(err, sql.ErrNoRows) {
			return ErrSecretNotAvailable
		} else if err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(ciphertext) == 0 {
		return ErrSecretNotAvailable
	}
	plaintext, err := service.secrets.Decrypt(secretID, version, ciphertext)
	if err != nil {
		return mapSecretStoreError(err)
	}
	defer clear(plaintext)
	return use(plaintext)
}

func (service *Service) cancelPendingForSecret(ctx context.Context, tx storage.Executor, secretID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,secret_bindings_json FROM modelry_extension_intents WHERE status='pending'`)
	if err != nil {
		return err
	}
	type pending struct{ id, pins string }
	var intents []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.pins); err != nil {
			rows.Close()
			return err
		}
		intents = append(intents, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, intent := range intents {
		var pins []SecretBindingInput
		if err := json.Unmarshal([]byte(intent.pins), &pins); err != nil {
			return err
		}
		for _, pin := range pins {
			if pin.SecretID == secretID {
				if err := service.cancelIntentInTransaction(ctx, tx, intent.id, "secretRevoked"); err != nil {
					return err
				}
				break
			}
		}
	}
	return nil
}

func validateSecretName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || !namePattern.MatchString(name) {
		return "", invalidField("/name", "invalidName", "Enter a Secret name between 1 and 128 characters without control characters.")
	}
	return name, nil
}

func secretNameKey(name string) string {
	return strings.Map(func(value rune) rune {
		folded := unicode.SimpleFold(value)
		lowest := value
		for folded != value {
			if folded < lowest {
				lowest = folded
			}
			folded = unicode.SimpleFold(folded)
		}
		return lowest
	}, strings.TrimSpace(name))
}

func ensureSecretNameAvailable(ctx context.Context, tx storage.Executor, secretID, name string) error {
	var existingID string
	err := tx.QueryRowContext(ctx, `SELECT id FROM modelry_secrets WHERE name_key=? AND id<>? LIMIT 1`, secretNameKey(name), secretID).Scan(&existingID)
	if err == nil {
		return invalidField("/name", "duplicateName", "A Secret with this name already exists.")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func mapSecretStoreError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, secretstore.ErrKeyMissing) || errors.Is(err, secretstore.ErrKeyInvalid) || errors.Is(err, secretstore.ErrCiphertext) {
		return ErrSecretKeyUnavailable
	}
	return ErrSecretKeyUnavailable
}
