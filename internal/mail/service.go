package mail

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// AuditSink 记录 Mail Control Plane 事实；实现由 Runtime 注入。
type AuditSink interface {
	AppendMailFact(ctx context.Context, action, resourceID, result string) error
	AppendMailFactInTransaction(ctx context.Context, tx storage.Executor, action, resourceID, result string) error
}

// ServiceOptions 是 Runtime 注入的依赖。
type ServiceOptions struct {
	Store    *storage.Store
	Secrets  SecretProvider
	Payloads PayloadSource
	Audits   AuditSink
	Sender   Sender
	Now      func() time.Time
	AttemptInterval time.Duration
}

// Service 拥有 Mail Provider 配置与 durable outbox worker。
type Service struct {
	store    transactionalStore
	secrets  SecretProvider
	payloads PayloadSource
	audits   AuditSink
	sender   Sender
	now      func() time.Time
	interval time.Duration

	mu       sync.Mutex
	started  bool
	closed   bool
	runCancel context.CancelFunc
	runDone   chan struct{}
	wake      chan struct{}
	active    map[string]context.CancelFunc
}

const mailSchema = `CREATE TABLE IF NOT EXISTS modelry_mail_provider (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	revision INTEGER NOT NULL CHECK (revision >= 1),
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
	host TEXT NOT NULL DEFAULT '',
	port INTEGER NOT NULL DEFAULT 0,
	security TEXT NOT NULL DEFAULT 'startTLS',
	from_address TEXT NOT NULL DEFAULT '',
	from_name TEXT NOT NULL DEFAULT '',
	username_secret_id TEXT NOT NULL DEFAULT '',
	password_secret_id TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
)`

const mailDeliverySchema = `CREATE TABLE IF NOT EXISTS modelry_mail_deliveries (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	recipient TEXT NOT NULL,
	payload_ref TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER,
	error_code TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	completed_at INTEGER
)`

const mailDeliveryIndex = `CREATE INDEX IF NOT EXISTS modelry_mail_deliveries_queue_idx ON modelry_mail_deliveries (status, next_attempt_at, created_at)`

// NewService 初始化 Mail Provider 配置与 outbox。
func NewService(ctx context.Context, options ServiceOptions) (*Service, error) {
	if options.Store == nil || options.Secrets == nil || options.Payloads == nil {
		return nil, fmt.Errorf("%w: mail storage, Secret provider, and payload source are required", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	interval := options.AttemptInterval
	if interval <= 0 {
		interval = AttemptInterval
	}
	sender := options.Sender
	if sender == nil {
		sender = SMTPSender{}
	}
	service := &Service{store: options.Store, secrets: options.Secrets, payloads: options.Payloads, audits: options.Audits, sender: sender, now: now, interval: interval, wake: make(chan struct{}, 1), active: make(map[string]context.CancelFunc)}
	if err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range []string{mailSchema, mailDeliverySchema, mailDeliveryIndex} {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize Mail storage: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO modelry_mail_provider (singleton, revision, updated_at) VALUES (1, 1, ?)", now().Unix()); err != nil {
			return err
		}
		// 重启把进行中的投递标记为 interrupted，并归还 pending 以便 bounded 重试。
		if _, err := tx.ExecContext(ctx, "UPDATE modelry_mail_deliveries SET status = ?, error_code = ? WHERE status = ?", string(DeliveryInterrupted), ErrorInterrupted, string(DeliveryRunning)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE modelry_mail_deliveries SET status = ?, next_attempt_at = ? WHERE status = ? AND attempts < ?", string(DeliveryPending), now().Unix(), string(DeliveryInterrupted), MaximumAttemptsPerDelivery); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return service, nil
}

func (service *Service) timestamp() int64 { return service.now().UTC().Unix() }

// GetConfig 读取 Mail Provider 配置。
func (service *Service) GetConfig(ctx context.Context) (Config, error) {
	var config Config
	var enabled int
	var security string
	var updated int64
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, "SELECT revision, enabled, host, port, security, from_address, from_name, username_secret_id, password_secret_id, updated_at FROM modelry_mail_provider WHERE singleton = 1").
			Scan(&config.Revision, &enabled, &config.Host, &config.Port, &security, &config.FromAddress, &config.FromName, &config.UsernameSecretID, &config.PasswordSecretID, &updated)
	})
	if err != nil {
		return Config{}, fmt.Errorf("%w: read Mail Provider configuration: %v", ErrUnavailable, err)
	}
	config.Enabled = enabled == 1
	config.Security = ProviderSecurity(security)
	config.UpdatedAt = time.Unix(updated, 0).UTC()
	return config, nil
}

// SaveConfig 保存 Mail Provider 配置；启用时必须提供完整且可解析的凭据 Secret。
func (service *Service) SaveConfig(ctx context.Context, expectedRevision int, next Config) (Config, error) {
	if expectedRevision < 1 {
		return Config{}, fmt.Errorf("%w: expectedRevision must be positive", ErrInvalidArgument)
	}
	normalized, err := service.normalizeConfig(ctx, next)
	if err != nil {
		return Config{}, err
	}
	current, err := service.GetConfig(ctx)
	if err != nil {
		return Config{}, err
	}
	if current.Revision != expectedRevision {
		return Config{}, fmt.Errorf("%w: Mail configuration changed; reload and retry", ErrConflict)
	}
	now := service.timestamp()
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		enabled := 0
		if normalized.Enabled {
			enabled = 1
		}
		if _, err := tx.ExecContext(ctx, "UPDATE modelry_mail_provider SET revision = ?, enabled = ?, host = ?, port = ?, security = ?, from_address = ?, from_name = ?, username_secret_id = ?, password_secret_id = ?, updated_at = ? WHERE singleton = 1",
			current.Revision+1, enabled, normalized.Host, normalized.Port, string(normalized.Security), normalized.FromAddress, normalized.FromName, normalized.UsernameSecretID, normalized.PasswordSecretID, now); err != nil {
			return err
		}
		return service.appendAudit(ctx, tx, "mail.providerConfigured", "provider")
	})
	if err != nil {
		return Config{}, err
	}
	return service.GetConfig(ctx)
}

func (service *Service) normalizeConfig(ctx context.Context, next Config) (Config, error) {
	normalized := next
	normalized.Host = strings.TrimSpace(next.Host)
	normalized.FromName = strings.TrimSpace(next.FromName)
	normalized.FromAddress = strings.TrimSpace(next.FromAddress)
	switch normalized.Security {
	case SecurityStartTLS, SecurityTLS:
	case SecurityPlaintext:
	case "":
		normalized.Security = SecurityStartTLS
	default:
		return Config{}, fmt.Errorf("%w: transport security must be startTLS, tls, or plaintext", ErrInvalidArgument)
	}
	if !normalized.Enabled {
		return normalized, nil
	}
	if normalized.Host == "" || normalized.Port < 1 || normalized.Port > 65535 {
		return Config{}, fmt.Errorf("%w: host and port are required to enable mail", ErrInvalidArgument)
	}
	// 明文 SMTP 只用于 loopback，例如本机 Mailpit 或 MailHog。
	if normalized.Security == SecurityPlaintext && !isLoopbackHost(normalized.Host) {
		return Config{}, fmt.Errorf("%w: plaintext SMTP is only accepted for a loopback host", ErrInvalidArgument)
	}
	address, err := mail.ParseAddress(normalized.FromAddress)
	if err != nil || address.Address != normalized.FromAddress {
		return Config{}, fmt.Errorf("%w: a single valid sender address is required", ErrInvalidArgument)
	}
	if normalized.UsernameSecretID == "" || normalized.PasswordSecretID == "" {
		return Config{}, fmt.Errorf("%w: both credential Secrets are required", ErrNotConfigured)
	}
	for _, secretID := range []string{normalized.UsernameSecretID, normalized.PasswordSecretID} {
		if _, configured, err := service.secrets.SecretMetadata(ctx, secretID); err != nil || !configured {
			return Config{}, ErrCredentialUnavailable
		}
	}
	return normalized, nil
}

func (service *Service) appendAudit(ctx context.Context, tx storage.Executor, action, resourceID string) error {
	if service.audits == nil {
		return nil
	}
	return service.audits.AppendMailFactInTransaction(ctx, tx, action, resourceID, "success")
}

func mapWriteError(err error) error {
	if err == nil {
		return nil
	}
	return err
}

var _ = sql.ErrNoRows
var _ = errors.Is
