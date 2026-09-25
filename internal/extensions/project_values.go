package extensions

import (
	"context"
	"fmt"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// EncryptProjectValue 用项目密钥加密一个需要 at-rest 保护的短值（例如 Recovery token 的投递副本）。
// 它只在项目尚无加密 Secret 时创建密钥；已有 Secret 但密钥缺失时 fail closed。
func (service *Service) EncryptProjectValue(ctx context.Context, contextID string, plaintext []byte) ([]byte, error) {
	if service == nil || service.secrets == nil || contextID == "" {
		return nil, ErrSecretNotAvailable
	}
	if len(plaintext) == 0 || len(plaintext) > maximumSecretBytes {
		return nil, fmt.Errorf("%w: value is outside the supported size", ErrSecretNotAvailable)
	}
	var ciphertext []byte
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_secrets WHERE length(value_cipher)>0`).Scan(&count); err != nil {
			return err
		}
		if err := service.secrets.EnsureKey(count > 0); err != nil {
			return mapSecretStoreError(err)
		}
		value, err := service.secrets.Encrypt(contextID, 1, plaintext)
		if err != nil {
			return mapSecretStoreError(err)
		}
		ciphertext = value
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ciphertext, nil
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
