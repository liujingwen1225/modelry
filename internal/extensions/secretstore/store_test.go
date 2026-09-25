package secretstore

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestEncryptDecryptAndIdentityBinding(t *testing.T) {
	root := t.TempDir()
	managed := filepath.Join(root, ".modelry")
	if err := os.Mkdir(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := New(managed, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Encrypt("secret-a", 1, []byte("before key")); !errors.Is(err, ErrKeyMissing) {
		t.Fatalf("Encrypt without key = %v, want ErrKeyMissing", err)
	}
	if err := store.EnsureKey(false); err != nil {
		t.Fatal(err)
	}
	keyInfo, err := os.Stat(filepath.Join(managed, keyFileName))
	if err != nil {
		t.Fatal(err)
	}
	if keyInfo.Size() != keySize {
		t.Fatalf("key size = %d, want %d", keyInfo.Size(), keySize)
	}
	if os.PathSeparator != '\\' && keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("POSIX key mode = %04o, want 0600", keyInfo.Mode().Perm())
	}
	plaintext := []byte("测试值 with UTF-8")
	ciphertext, err := store.Encrypt("secret-a", 1, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, plaintext) {
		t.Fatal("密文包含明文")
	}
	decrypted, err := store.Decrypt("secret-a", 1, ciphertext)
	if err != nil || !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("Decrypt = %q, %v", decrypted, err)
	}
	if _, err := store.Decrypt("secret-b", 1, ciphertext); !errors.Is(err, ErrCiphertext) {
		t.Fatalf("Decrypt under a different Secret ID = %v, want ErrCiphertext", err)
	}
	if _, err := store.Decrypt("secret-a", 2, ciphertext); !errors.Is(err, ErrCiphertext) {
		t.Fatalf("Decrypt under a different version = %v, want ErrCiphertext", err)
	}
	otherProject, err := New(managed, "project-b")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := otherProject.Decrypt("secret-a", 1, ciphertext); !errors.Is(err, ErrCiphertext) {
		t.Fatalf("Decrypt under a different Project ID = %v, want ErrCiphertext", err)
	}
	ciphertext[len(ciphertext)-1] ^= 1
	if _, err := store.Decrypt("secret-a", 1, ciphertext); !errors.Is(err, ErrCiphertext) {
		t.Fatalf("Decrypt tampered ciphertext = %v, want ErrCiphertext", err)
	}
}

func TestKeyCreationFailsClosed(t *testing.T) {
	managed := newManagedDir(t)
	store, err := New(managed, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureKey(true); !errors.Is(err, ErrKeyMissing) {
		t.Fatalf("EnsureKey with existing Secrets = %v, want ErrKeyMissing", err)
	}
	if _, err := os.Lstat(filepath.Join(managed, keyFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("key exists after fail-closed check: %v", err)
	}
	if _, err := store.Decrypt("secret-a", 1, make([]byte, nonceSize+authTagSize)); !errors.Is(err, ErrKeyMissing) {
		t.Fatalf("Decrypt without key = %v, want ErrKeyMissing", err)
	}
	if _, err := os.Lstat(filepath.Join(managed, keyFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Decrypt created a replacement key: %v", err)
	}
	if err := store.EnsureKey(false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(managed, keyFileName), []byte("truncated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Encrypt("secret-a", 1, []byte("value")); !errors.Is(err, ErrKeyInvalid) {
		t.Fatalf("Encrypt with corrupted key = %v, want ErrKeyInvalid", err)
	}
	if err := store.EnsureKey(false); !errors.Is(err, ErrKeyInvalid) {
		t.Fatalf("EnsureKey replaced a corrupted key: %v", err)
	}
}

func TestSecretSizeAndArgumentBounds(t *testing.T) {
	store, err := New(newManagedDir(t), "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureKey(false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Encrypt("secret-a", 1, make([]byte, maximumSecretLen+1)); !errors.Is(err, ErrSecretTooLarge) {
		t.Fatalf("oversized Secret error = %v, want ErrSecretTooLarge", err)
	}
	for _, test := range []struct {
		secretID string
		version  int64
	}{
		{secretID: "", version: 1},
		{secretID: "secret-a", version: 0},
		{secretID: "secret-a", version: -1},
	} {
		if _, err := store.Encrypt(test.secretID, test.version, []byte("value")); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("Encrypt(%q,%d) error = %v, want ErrInvalidArgument", test.secretID, test.version, err)
		}
	}
	if _, err := store.Decrypt("secret-a", 1, []byte("short")); !errors.Is(err, ErrCiphertext) {
		t.Fatalf("short ciphertext error = %v, want ErrCiphertext", err)
	}
}

func TestRejectSymlinkedKeyAndManagedDirectory(t *testing.T) {
	managed := newManagedDir(t)
	store, err := New(managed, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureKey(false); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(managed, keyFileName)
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "outside-key")
	if err := os.WriteFile(target, keyBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, keyPath); err != nil {
		t.Skipf("当前平台/账户不能创建符号链接: %v", err)
	}
	if _, err := store.Encrypt("secret-a", 1, []byte("value")); !errors.Is(err, ErrKeyInvalid) {
		t.Fatalf("Encrypt with symlink key = %v, want ErrKeyInvalid", err)
	}
	managedLink := filepath.Join(t.TempDir(), ".modelry")
	if err := os.Symlink(managed, managedLink); err != nil {
		t.Skipf("当前平台/账户不能创建符号链接: %v", err)
	}
	if _, err := New(managedLink, "project-a"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("New with symlinked .modelry = %v, want ErrInvalidArgument", err)
	}
}

func TestRejectReplacedManagedDirectory(t *testing.T) {
	managed := newManagedDir(t)
	store, err := New(managed, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	retired := managed + "-retired"
	if err := os.Rename(managed, retired); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureKey(false); !errors.Is(err, ErrKeyInvalid) {
		t.Fatalf("EnsureKey after managed directory replacement = %v, want ErrKeyInvalid", err)
	}
	if _, err := os.Lstat(filepath.Join(managed, keyFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replacement directory received a key: %v", err)
	}
}

func TestConcurrentEnsureKey(t *testing.T) {
	store, err := New(newManagedDir(t), "project-a")
	if err != nil {
		t.Fatal(err)
	}
	const workers = 8
	errorsFound := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func() { errorsFound <- store.EnsureKey(false) }()
	}
	for i := 0; i < workers; i++ {
		if err := <-errorsFound; err != nil {
			t.Fatalf("concurrent EnsureKey = %v", err)
		}
	}
	if _, err := store.Encrypt("secret-a", 1, []byte("value")); err != nil {
		t.Fatal(err)
	}
}

func newManagedDir(t *testing.T) string {
	t.Helper()
	managed := filepath.Join(t.TempDir(), ".modelry")
	if err := os.Mkdir(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	return managed
}
