package extensions

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// TestEncryptProjectValueRunsInsideCallerTransaction 证明 Recovery token 的加密复用调用方事务，
// 不会打开嵌套的 SQLite 事务：嵌套事务在真实 Runtime 上会直接失败。
func TestEncryptProjectValueRunsInsideCallerTransaction(t *testing.T) {
	fixture := newExtensionFixture(t, invocationFunc(func(context.Context, Invocation) (json.RawMessage, error) { return nil, errors.New("unused") }))
	ctx := context.Background()

	if _, err := fixture.service.EncryptProjectValue(ctx, nil, "rtk_missing", []byte("token")); !errors.Is(err, ErrSecretNotAvailable) {
		t.Fatalf("encrypt without a caller transaction error = %v, want ErrSecretNotAvailable", err)
	}

	var ciphertext []byte
	err := fixture.store.WithTransaction(ctx, func(tx storage.Executor) error {
		value, err := fixture.service.EncryptProjectValue(ctx, tx, "rtk_inside", []byte("token-inside-transaction"))
		if err != nil {
			return err
		}
		ciphertext = value
		return nil
	})
	if err != nil {
		t.Fatalf("encrypt inside a caller transaction: %v", err)
	}
	if len(ciphertext) == 0 {
		t.Fatal("ciphertext must not be empty")
	}
	plaintext, err := fixture.service.DecryptProjectValue(ctx, "rtk_inside", ciphertext)
	if err != nil || string(plaintext) != "token-inside-transaction" {
		t.Fatalf("decrypt = %q, %v", plaintext, err)
	}
}