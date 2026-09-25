package secretstore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	keyFileName      = "secrets.key"
	keySize          = 32
	maximumSecretLen = 16 << 10
	nonceSize        = 12
	authTagSize      = 16
)

var (
	ErrInvalidArgument = errors.New("无效的密钥存储参数")
	ErrKeyMissing      = errors.New("项目密钥不存在")
	ErrKeyInvalid      = errors.New("项目密钥无效")
	ErrCiphertext      = errors.New("Secret 密文无效")
	ErrSecretTooLarge  = errors.New("Secret 超过 16 KiB 限制")
)

// Store 使用项目本地密钥加密 Secret，并将项目与 Secret 身份绑定到认证数据中。
type Store struct {
	managedDir  string
	managedInfo os.FileInfo
	keyPath     string
	projectID   string
	keyMu       sync.RWMutex
}

// New 需要 Runtime 已创建且验证过的 .modelry 目录。
func New(managedDir, projectID string) (*Store, error) {
	if strings.TrimSpace(managedDir) == "" || strings.TrimSpace(projectID) == "" || len(projectID) > 1024 || strings.ContainsRune(projectID, '\x00') {
		return nil, ErrInvalidArgument
	}
	absolute, err := filepath.Abs(filepath.Clean(managedDir))
	if err != nil {
		return nil, ErrInvalidArgument
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: .modelry 目录缺失或不安全", ErrInvalidArgument)
	}
	directory, err := os.Open(absolute)
	if err != nil {
		return nil, ErrInvalidArgument
	}
	managedInfo, statErr := directory.Stat()
	closeErr := directory.Close()
	if statErr != nil || closeErr != nil || !os.SameFile(info, managedInfo) {
		return nil, fmt.Errorf("%w: .modelry 目录无法安全验证", ErrInvalidArgument)
	}
	return &Store{managedDir: absolute, managedInfo: managedInfo, keyPath: filepath.Join(absolute, keyFileName), projectID: projectID}, nil
}

// EnsureKey 仅允许在数据库中还没有加密 Secret 时创建缺失的项目密钥。
// 调用方必须在持有相应数据库写锁/事务时依据 Secret 行数传入准确值。
// 文件创建不属于 SQLite 事务；即使数据库事务回滚，已创建的空闲项目密钥也会保留。
func (store *Store) EnsureKey(hasEncryptedSecrets bool) error {
	if store == nil {
		return ErrInvalidArgument
	}
	store.keyMu.Lock()
	defer store.keyMu.Unlock()
	key, err := store.readKey()
	if err == nil {
		clear(key)
		return nil
	}
	if !errors.Is(err, ErrKeyMissing) || hasEncryptedSecrets {
		return err
	}
	return store.createKey()
}

// Encrypt 使用 AES-256-GCM 加密 Secret；创建密钥须先调用 EnsureKey(false)。
func (store *Store) Encrypt(secretID string, version int64, plaintext []byte) ([]byte, error) {
	if err := validateContext(store, secretID, version); err != nil {
		return nil, err
	}
	if len(plaintext) > maximumSecretLen {
		return nil, ErrSecretTooLarge
	}
	store.keyMu.RLock()
	key, err := store.readKey()
	store.keyMu.RUnlock()
	if err != nil {
		return nil, err
	}
	defer clear(key)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrKeyInvalid
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrKeyInvalid
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, errors.New("无法生成 Secret 加密随机数")
	}
	return gcm.Seal(nonce, nonce, plaintext, associatedData(store.projectID, secretID, version)), nil
}

// Decrypt 解密 Secret；缺失或不安全的密钥会直接失败，不会创建替代密钥。
func (store *Store) Decrypt(secretID string, version int64, ciphertext []byte) ([]byte, error) {
	if err := validateContext(store, secretID, version); err != nil {
		return nil, err
	}
	if len(ciphertext) < nonceSize+authTagSize || len(ciphertext) > nonceSize+authTagSize+maximumSecretLen {
		return nil, ErrCiphertext
	}
	store.keyMu.RLock()
	key, err := store.readKey()
	store.keyMu.RUnlock()
	if err != nil {
		return nil, err
	}
	defer clear(key)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrKeyInvalid
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrKeyInvalid
	}
	nonce, body := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, body, associatedData(store.projectID, secretID, version))
	if err != nil {
		return nil, ErrCiphertext
	}
	return plaintext, nil
}

func validateContext(store *Store, secretID string, version int64) error {
	if store == nil || store.projectID == "" || secretID == "" || len(secretID) > 1024 || strings.ContainsRune(secretID, '\x00') || version < 1 {
		return ErrInvalidArgument
	}
	return nil
}

func associatedData(projectID, secretID string, version int64) []byte {
	data := make([]byte, 0, len(projectID)+len(secretID)+32)
	data = appendField(data, []byte("modelry.secret.v1"))
	data = appendField(data, []byte(projectID))
	data = appendField(data, []byte(secretID))
	var encodedVersion [8]byte
	binary.BigEndian.PutUint64(encodedVersion[:], uint64(version))
	data = appendField(data, encodedVersion[:])
	return data
}

func appendField(destination, value []byte) []byte {
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(value)))
	destination = append(destination, size[:]...)
	return append(destination, value...)
}

func (store *Store) readKey() ([]byte, error) {
	if err := store.verifyManagedDirectory(); err != nil {
		return nil, ErrKeyInvalid
	}
	info, err := os.Lstat(store.keyPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrKeyMissing
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrKeyInvalid
	}
	if err := verifyKeyAccess(store.keyPath, nil); err != nil {
		return nil, ErrKeyInvalid
	}
	file, err := os.Open(store.keyPath)
	if err != nil {
		return nil, ErrKeyInvalid
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return nil, ErrKeyInvalid
	}
	if err := store.verifyManagedDirectory(); err != nil {
		return nil, ErrKeyInvalid
	}
	if err := verifyKeyAccess(store.keyPath, file); err != nil {
		return nil, ErrKeyInvalid
	}
	key := make([]byte, keySize)
	if _, err := io.ReadFull(file, key); err != nil {
		clear(key)
		return nil, ErrKeyInvalid
	}
	var extra [1]byte
	if count, err := file.Read(extra[:]); count != 0 || !errors.Is(err, io.EOF) {
		clear(key)
		return nil, ErrKeyInvalid
	}
	if err := verifyKeyAccess(store.keyPath, file); err != nil {
		clear(key)
		return nil, ErrKeyInvalid
	}
	return key, nil
}

func (store *Store) createKey() error {
	if err := store.verifyManagedDirectory(); err != nil {
		return ErrKeyInvalid
	}
	key := make([]byte, keySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		clear(key)
		return errors.New("无法生成项目密钥")
	}
	defer clear(key)

	file, err := os.OpenFile(store.keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		// 并发创建方可能已写入成功；只接受完整且权限正确的密钥。
		existing, readErr := store.readKey()
		clear(existing)
		return readErr
	}
	if err != nil {
		return ErrKeyInvalid
	}
	created := true
	defer func() {
		if created && store.verifyManagedDirectory() == nil {
			_ = os.Remove(store.keyPath)
		}
	}()
	if err := store.verifyManagedDirectory(); err != nil {
		_ = file.Close()
		return ErrKeyInvalid
	}
	if err := secureNewKeyFile(store.keyPath, file); err != nil {
		_ = file.Close()
		return ErrKeyInvalid
	}
	if _, err := file.Write(key); err != nil {
		_ = file.Close()
		return ErrKeyInvalid
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return ErrKeyInvalid
	}
	if err := file.Close(); err != nil {
		return ErrKeyInvalid
	}
	if err := store.verifyManagedDirectory(); err != nil {
		return ErrKeyInvalid
	}
	info, err := os.Lstat(store.keyPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || verifyKeyAccess(store.keyPath, nil) != nil {
		return ErrKeyInvalid
	}
	created = false
	return nil
}

func (store *Store) verifyManagedDirectory() error {
	info, err := os.Lstat(store.managedDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(store.managedInfo, info) {
		return ErrKeyInvalid
	}
	return nil
}
