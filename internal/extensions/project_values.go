package extensions

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// EncryptProjectValue 用项目密钥加密一个需要 at-rest 保护的短值（例如 Recovery token 的投递副本）。
// 它复用调用方事务：SQLite 事务不可嵌套。项目尚无 Project-key ciphertext 时会创建密钥；
// 已有受保护耐久值但密钥缺失时 fail closed。
func (service *Service) EncryptProjectValue(ctx context.Context, tx storage.Executor, contextID string, plaintext []byte) ([]byte, error) {
	if service == nil || service.secrets == nil || contextID == "" || tx == nil {
		return nil, ErrSecretNotAvailable
	}
	if len(plaintext) == 0 || len(plaintext) > maximumSecretBytes {
		return nil, fmt.Errorf("%w: value is outside the supported size", ErrSecretNotAvailable)
	}
	keyInUse, err := projectKeyInUse(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := service.secrets.EnsureKey(keyInUse); err != nil {
		return nil, mapSecretStoreError(err)
	}
	value, err := service.secrets.Encrypt(contextID, 1, plaintext)
	if err != nil {
		return nil, mapSecretStoreError(err)
	}
	return value, nil
}

// ProjectCiphertextProbe identifies one durable value protected by the stable
// Project key. Ciphertext is included only for authenticated backup pairing.
type ProjectCiphertextProbe struct {
	ContextID  string
	Version    int64
	Ciphertext []byte
}

type projectCiphertextSource struct {
	table      string
	contextID  string
	version    string
	ciphertext string
	orderBy    string
}

// Keep the durable Project-key ciphertext inventory in one place. Both key
// recreation checks and Backup snapshot probes use this registry.
var projectCiphertextSources = [...]projectCiphertextSource{
	{table: "modelry_secrets", contextID: "id", version: "version", ciphertext: "value_cipher", orderBy: "id"},
	{table: "modelry_app_recovery_tokens", contextID: "id", version: "1", ciphertext: "token_cipher", orderBy: "id"},
}

// FirstProjectCiphertext returns one durable Project-key ciphertext from tx.
// The caller controls the transaction or snapshot that gives the read meaning.
func FirstProjectCiphertext(ctx context.Context, tx storage.Executor) (ProjectCiphertextProbe, bool, error) {
	if tx == nil {
		return ProjectCiphertextProbe{}, false, ErrSecretNotAvailable
	}
	for _, source := range projectCiphertextSources {
		exists, err := projectCiphertextTableExists(ctx, tx, source.table)
		if err != nil {
			return ProjectCiphertextProbe{}, false, err
		}
		if !exists {
			continue
		}
		query := fmt.Sprintf(`SELECT %s,%s,%s FROM %s WHERE length(%s)>0 ORDER BY %s LIMIT 1`, source.contextID, source.version, source.ciphertext, source.table, source.ciphertext, source.orderBy)
		var probe ProjectCiphertextProbe
		if err := tx.QueryRowContext(ctx, query).Scan(&probe.ContextID, &probe.Version, &probe.Ciphertext); err != nil {
			if err == sql.ErrNoRows {
				continue
			}
			return ProjectCiphertextProbe{}, false, err
		}
		return probe, true, nil
	}
	return ProjectCiphertextProbe{}, false, nil
}

func projectKeyInUse(ctx context.Context, tx storage.Executor) (bool, error) {
	probe, found, err := FirstProjectCiphertext(ctx, tx)
	clear(probe.Ciphertext)
	return found, err
}

func projectCiphertextTableExists(ctx context.Context, tx storage.Executor, table string) (bool, error) {
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)`, table).Scan(&exists); err != nil {
		return false, err
	}
	return exists != 0, nil
}

// DecryptProjectValue 解密由 EncryptProjectValue 写入的值；密钥缺失或无效时 fail closed。
func (service *Service) DecryptProjectValue(ctx context.Context, contextID string, ciphertext []byte) ([]byte, error) {
	if service == nil || service.secrets == nil || contextID == "" {
		return nil, ErrSecretNotAvailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	plaintext, err := service.secrets.Decrypt(contextID, 1, ciphertext)
	if err != nil {
		return nil, mapSecretStoreError(err)
	}
	return plaintext, nil
}
