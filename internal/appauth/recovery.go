package appauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	// ErrEmailNotVerified 表示 required 验证模式下 App User 尚未验证邮箱。
	ErrEmailNotVerified = errors.New("application email is not verified")
	// ErrMailUnavailable 表示 Mail Provider 未配置或不可用，恢复流程 fail closed。
	ErrMailUnavailable = errors.New("application mail is unavailable")
	// ErrRecoveryFlowDisabled 表示该 Collection 关闭了对应恢复流程。
	ErrRecoveryFlowDisabled = errors.New("application recovery flow is disabled")
)

// 恢复流程的固定上限。
const (
	recoveryTokenLifetimeMinutes = 30
	maximumRecoveryTokens         = 1024
	recoveryRequestHourlyLimit    = 16
	maximumOriginBytes            = 200
)

type recoveryPurpose string

const (
	purposePasswordReset     recoveryPurpose = "passwordReset"
	purposeEmailVerification recoveryPurpose = "emailVerification"
)

// MailEnqueuer 由 Runtime 注入：在调用方事务内写入 durable Mail Delivery 意图。
type MailEnqueuer interface {
	EnqueueRecoveryMail(ctx context.Context, tx storage.Executor, kind string, recipient, payloadRef string) error
	MailConfigured(ctx context.Context) (bool, error)
}

// ValueCipher 由 Runtime 注入的项目密钥边界，用于加密 Recovery token 的投递副本。
type ValueCipher interface {
	EncryptProjectValue(ctx context.Context, contextID string, plaintext []byte) ([]byte, error)
	DecryptProjectValue(ctx context.Context, contextID string, ciphertext []byte) ([]byte, error)
}

// AuditSink 由 Runtime 注入：记录 App User 的恢复流程事实。
type AuditSink interface {
	AppendAuthFactInTransaction(ctx context.Context, tx storage.Executor, actorKind, actorID, action, resourceKind, resourceID string) error
}

// SetRecoveryDependencies 在 Runtime 启动阶段注入 Mail、项目密钥与 Audit 边界。
func (service *Service) SetRecoveryDependencies(mail MailEnqueuer, cipher ValueCipher, audits AuditSink) {
	if service == nil {
		return
	}
	service.mail = mail
	service.cipher = cipher
	service.audits = audits
}

// sanitizeOrigin 只接受 http(s) 的 scheme://host 形式，避免把外部内容写入邮件正文。
func sanitizeOrigin(origin string) string {
	trimmed := strings.TrimSpace(origin)
	if trimmed == "" || len(trimmed) > maximumOriginBytes {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func newRecoveryToken(prefix string) (string, []byte, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", nil, fmt.Errorf("generate Recovery token: %w", err)
	}
	token := prefix + hex.EncodeToString(value)
	hash := sha256.Sum256([]byte(token))
	return token, hash[:], nil
}

func newRecoveryTokenID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate Recovery token identifier: %w", err)
	}
	return "rtk_" + hex.EncodeToString(value), nil
}

func (service *Service) mailConfigured(ctx context.Context) (bool, error) {
	if service.mail == nil {
		return false, nil
	}
	return service.mail.MailConfigured(ctx)
}

// issueRecoveryToken 在调用方事务内写入 Recovery token 与 Mail Delivery 意图。
// 超出速率上限时安静跳过（返回 false），调用方仍然返回同样的接受响应，避免账号枚举。
func (service *Service) issueRecoveryToken(ctx context.Context, tx storage.Executor, collectionID, userID, emailKey, origin string, purpose recoveryPurpose) (bool, error) {
	if service.cipher == nil || service.mail == nil {
		return false, ErrMailUnavailable
	}
	cutoff := timestamp(service.now().Add(-time.Hour))
	var recent int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_app_recovery_tokens WHERE collection_id = ? AND email_key = ? AND purpose = ? AND created_at >= ?`, collectionID, emailKey, string(purpose), cutoff).Scan(&recent); err != nil {
		return false, fmt.Errorf("check Recovery request rate: %w", err)
	}
	if recent >= recoveryRequestHourlyLimit {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_app_recovery_tokens WHERE id IN (SELECT id FROM modelry_app_recovery_tokens ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`, maximumRecoveryTokens); err != nil {
		return false, fmt.Errorf("prune Recovery tokens: %w", err)
	}
	tokenID, err := newRecoveryTokenID()
	if err != nil {
		return false, err
	}
	prefix := "rst_"
	mailKind := "passwordReset"
	if purpose == purposeEmailVerification {
		prefix = "vfy_"
		mailKind = "verification"
	}
	token, hash, err := newRecoveryToken(prefix)
	if err != nil {
		return false, err
	}
	ciphertext, err := service.cipher.EncryptProjectValue(ctx, tokenID, []byte(token))
	if err != nil {
		return false, err
	}
	now := service.now().UTC()
	expiresAt := now.Add(recoveryTokenLifetimeMinutes * time.Minute)
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_app_recovery_tokens (id, collection_id, user_record_id, email_key, purpose, token_hash, token_cipher, origin, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		tokenID, collectionID, userID, emailKey, string(purpose), hash, ciphertext, sanitizeOrigin(origin), timestamp(expiresAt), timestamp(now)); err != nil {
		return false, fmt.Errorf("persist Recovery token: %w", err)
	}
	if err := service.mail.EnqueueRecoveryMail(ctx, tx, mailKind, emailKey, tokenID); err != nil {
		return false, err
	}
	if service.audits != nil {
		action := "auth.passwordResetRequested"
		if purpose == purposeEmailVerification {
			action = "auth.emailVerificationRequested"
		}
		if err := service.audits.AppendAuthFactInTransaction(ctx, tx, "appUser", userID, action, "authCollection", collectionID); err != nil {
			return false, err
		}
	}
	return true, nil
}

// RequestPasswordReset 始终返回 nil（除非 Mail 未配置），因此无法用于枚举 App User。
func (service *Service) RequestPasswordReset(ctx context.Context, collectionName, email, origin string) error {
	return service.requestRecovery(ctx, collectionName, email, origin, purposePasswordReset)
}

// RequestEmailVerification 与密码重置采用同样的不可枚举语义。
func (service *Service) RequestEmailVerification(ctx context.Context, collectionName, email, origin string) error {
	return service.requestRecovery(ctx, collectionName, email, origin, purposeEmailVerification)
}

func (service *Service) requestRecovery(ctx context.Context, collectionName, email, origin string, purpose recoveryPurpose) error {
	configured, err := service.mailConfigured(ctx)
	if err != nil {
		return err
	}
	if !configured {
		return ErrMailUnavailable
	}
	emailKey, err := normalizeEmail(email)
	if err != nil {
		return validationError("/email", "FORMAT", "Enter a valid email address.")
	}
	if _, err := service.findAuthCollection(ctx, collectionName); err != nil {
		return err
	}
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		current, err := collectionByName(ctx, tx, collectionName)
		if err != nil {
			return err
		}
		configuration, _, err := readConfig(ctx, tx, current)
		if err != nil {
			return err
		}
		mode := normalizeEmailVerification(configuration.Applied.EmailVerification)
		if purpose == purposeEmailVerification && mode == EmailVerificationOff {
			return nil
		}
		if purpose == purposePasswordReset && !configuration.Applied.EmailPasswordEnabled {
			return nil
		}
		credential, err := readCredential(ctx, tx, current.ID, emailKey)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if purpose == purposeEmailVerification && credential.Verified {
			return nil
		}
		_, err = service.issueRecoveryToken(ctx, tx, current.ID, credential.UserID, emailKey, origin, purpose)
		return err
	})
}

type recoveryTokenRow struct {
	ID           string
	CollectionID string
	UserID       string
	EmailKey     string
	Purpose      recoveryPurpose
	Cipher       []byte
	Origin       string
	ExpiresAt    string
	UsedAt       sql.NullString
}

func readRecoveryToken(ctx context.Context, query storage.Executor, collectionID string, digest []byte) (recoveryTokenRow, error) {
	var row recoveryTokenRow
	var purpose string
	err := query.QueryRowContext(ctx, `SELECT id, collection_id, user_record_id, email_key, purpose, token_cipher, origin, expires_at, used_at FROM modelry_app_recovery_tokens WHERE collection_id = ? AND token_hash = ?`, collectionID, digest).
		Scan(&row.ID, &row.CollectionID, &row.UserID, &row.EmailKey, &purpose, &row.Cipher, &row.Origin, &row.ExpiresAt, &row.UsedAt)
	row.Purpose = recoveryPurpose(purpose)
	return row, err
}

func recoveryDigest(token string) ([]byte, bool) {
	trimmed := strings.TrimSpace(token)
	if len(trimmed) != 36 {
		return nil, false
	}
	if !strings.HasPrefix(trimmed, "rst_") && !strings.HasPrefix(trimmed, "vfy_") {
		return nil, false
	}
	if _, err := hex.DecodeString(trimmed[4:]); err != nil {
		return nil, false
	}
	hash := sha256.Sum256([]byte(trimmed))
	return hash[:], true
}

// ErrRecoveryTokenInvalid 表示链接未知、过期、已使用或用途不匹配。
var ErrRecoveryTokenInvalid = errors.New("recovery token is invalid")

func (service *Service) ConfirmPasswordReset(ctx context.Context, collectionName, token, password string) error {
	return service.confirmRecovery(ctx, collectionName, token, purposePasswordReset, password)
}

func (service *Service) ConfirmEmailVerification(ctx context.Context, collectionName, token string) error {
	return service.confirmRecovery(ctx, collectionName, token, purposeEmailVerification, "")
}

func (service *Service) confirmRecovery(ctx context.Context, collectionName, token string, purpose recoveryPurpose, password string) error {
	digest, ok := recoveryDigest(token)
	if !ok {
		return ErrRecoveryTokenInvalid
	}
	collection, err := service.findAuthCollection(ctx, collectionName)
	if err != nil {
		return err
	}
	var salt, passwordHash []byte
	if purpose == purposePasswordReset {
		salt, passwordHash, err = derivePassword(password)
		if err != nil {
			return err
		}
	}
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		row, err := readRecoveryToken(ctx, tx, collection.ID, digest)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrRecoveryTokenInvalid
		}
		if err != nil {
			return err
		}
		if row.Purpose != purpose || row.UsedAt.Valid {
			return ErrRecoveryTokenInvalid
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, row.ExpiresAt)
		if err != nil || !expiresAt.After(service.now().UTC()) {
			return ErrRecoveryTokenInvalid
		}
		now := timestamp(service.now())
		switch purpose {
		case purposePasswordReset:
			result, err := tx.ExecContext(ctx, `UPDATE modelry_app_password_credentials SET password_salt = ?, password_hash = ?, updated_at = ? WHERE collection_id = ? AND user_record_id = ?`, salt, passwordHash, now, row.CollectionID, row.UserID)
			if err != nil {
				return err
			}
			if count, err := result.RowsAffected(); err != nil || count != 1 {
				return ErrRecoveryTokenInvalid
			}
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE collection_id = ? AND user_record_id = ?`, now, row.CollectionID, row.UserID); err != nil {
				return fmt.Errorf("revoke Sessions after password reset: %w", err)
			}
		case purposeEmailVerification:
			result, err := tx.ExecContext(ctx, `UPDATE modelry_app_password_credentials SET email_verified = 1, verified_at = ?, updated_at = ? WHERE collection_id = ? AND user_record_id = ?`, now, now, row.CollectionID, row.UserID)
			if err != nil {
				return err
			}
			if count, err := result.RowsAffected(); err != nil || count != 1 {
				return ErrRecoveryTokenInvalid
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_recovery_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`, now, row.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_app_recovery_tokens SET used_at = COALESCE(used_at, ?) WHERE collection_id = ? AND user_record_id = ?`, now, row.CollectionID, row.UserID); err != nil {
			return err
		}
		if service.audits != nil {
			action := "auth.passwordResetCompleted"
			if purpose == purposeEmailVerification {
				action = "auth.emailVerificationCompleted"
			}
			if err := service.audits.AppendAuthFactInTransaction(ctx, tx, "appUser", row.UserID, action, "authCollection", row.CollectionID); err != nil {
				return err
			}
		}
		return nil
	})
}

// RenderDeliveryPayload 实现 Mail PayloadSource：它在投递时解密 token 并渲染正文。
func (service *Service) RenderDeliveryPayload(ctx context.Context, kind string, payloadRef, recipient string) (string, string, error) {
	if service.cipher == nil || strings.TrimSpace(payloadRef) == "" {
		return "", "", ErrRecoveryTokenInvalid
	}
	var row recoveryTokenRow
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var purpose string
		var digest []byte
		return snapshot.QueryRowContext(ctx, `SELECT id, collection_id, user_record_id, email_key, purpose, token_cipher, origin, expires_at, used_at, token_hash FROM modelry_app_recovery_tokens WHERE id = ?`, payloadRef).
			Scan(&row.ID, &row.CollectionID, &row.UserID, &row.EmailKey, &purpose, &row.Cipher, &row.Origin, &row.ExpiresAt, &row.UsedAt, &digest)
	})
	if err != nil {
		return "", "", fmt.Errorf("%w: recovery payload is unavailable", ErrRecoveryTokenInvalid)
	}
	if row.UsedAt.Valid {
		return "", "", ErrRecoveryTokenInvalid
	}
	var token []byte
	if err := func() error {
		value, err := service.cipher.DecryptProjectValue(ctx, row.ID, row.Cipher)
		if err != nil {
			return err
		}
		token = value
		return nil
	}(); err != nil {
		return "", "", err
}
	name, err := service.collectionName(ctx, row.CollectionID)
	if err != nil {
		return "", "", err
	}
	switch kind {
	case "passwordReset":
		body := "A password reset was requested for your " + name + " account.\n\nUse this single-use code in Modelry to choose a new password:\n\n" + string(token) + "\n\nThe code expires in 30 minutes. If you did not request it, ignore this message.\n"
		return "Reset your Modelry password", body, nil
	case "verification":
		body := "Confirm this email address for your " + name + " account.\n\nUse this single-use code in Modelry:\n\n" + string(token) + "\n\nThe code expires in 30 minutes.\n"
		return "Verify your Modelry email address", body, nil
	default:
		return "", "", ErrRecoveryTokenInvalid
	}
}

func renderRecoveryLink(origin, collectionName, kind, token string) string {
	base := strings.TrimSuffix(origin, "/")
	parameter := "resetToken"
	if kind == "verification" {
		parameter = "verifyToken"
	}
	path := "/login?" + parameter + "=" + url.QueryEscape(token) + "&collection=" + url.QueryEscape(collectionName)
	if base == "" {
		return path
	}
	return base + path
}

func (service *Service) collectionName(ctx context.Context, collectionID string) (string, error) {
	var name string
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT name FROM modelry_backend_collections WHERE id = ?`, collectionID).Scan(&name)
	})
	if err != nil {
		return "", fmt.Errorf("read Auth Collection name: %w", err)
	}
	return name, nil
}
