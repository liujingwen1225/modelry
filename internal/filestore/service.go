package filestore

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ProviderKind 是持久化的 Provider 标识。
type ProviderKind string

const (
	ProviderLocal ProviderKind = "local"
	ProviderS3    ProviderKind = "s3"
)

// Migration 状态枚举。
const (
	MigrationPending     = "pending"
	MigrationRunning     = "running"
	MigrationCompleted   = "completed"
	MigrationFailed      = "failed"
	MigrationCancelled   = "cancelled"
	MigrationInterrupted = "interrupted"
)

// Migration 安全错误码。
const (
	ErrorProviderUnavailable   = "providerUnavailable"
	ErrorCredentialUnavailable = "credentialUnavailable"
	ErrorObjectWriteFailed     = "objectWriteFailed"
	ErrorVerificationFailed    = "verificationFailed"
	ErrorCancelled             = "cancelled"
	ErrorInterrupted           = "interrupted"
)

const (
	maximumMigrationObjects = 100000
	migrationHistoryLimit   = 50
	migrationObjectTimeout  = 30 * time.Second
	// ReconcileInterval 是后台对象回收与引用校验周期。
	ReconcileInterval = 15 * time.Minute
	// ReconcileGrace 是孤儿对象的最短保留时间。
	ReconcileGrace = time.Hour
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// SecretProvider 解析 Project Secret 的元数据与值；明文只在回调期间可见。
type SecretProvider interface {
	SecretMetadata(ctx context.Context, secretID string) (string, bool, error)
	WithSecretValue(ctx context.Context, secretID string, use func([]byte) error) error
}

// AuditWriter 在资源变更事务内写入 Control Plane 事实。
type AuditWriter interface {
	AppendInTransaction(context.Context, storage.Executor, audit.AppendInput) error
}

// ReferenceSource 提供 Durable Record 引用的对象引用。
type ReferenceSource interface {
	ReferencedFileKeys(ctx context.Context) ([]string, error)
}

// MigrationStaging 提供 Runtime 管理的迁移暂存文件。
type MigrationStaging interface {
	NewMigrationStagingFile() (*os.File, string, error)
}

// S3Settings 是持久化的 S3-compatible 配置；凭据只保存 Secret ID。
type S3Settings struct {
	Endpoint             string
	Region               string
	Bucket               string
	KeyPrefix            string
	PathStyle            bool
	AccessKeySecretID    string
	SecretKeySecretID    string
	SessionTokenSecretID string
}

// Config 是 Project 的 File Storage 配置。
type Config struct {
	Revision int
	Provider ProviderKind
	S3       *S3Settings
}

// SecretReference 是安全的 Secret 元数据投影。
type SecretReference struct {
	SecretID   string
	Name       string
	Configured bool
}

// Migration 是一次 Provider migration 的耐久状态。
type Migration struct {
	ID                 string
	SourceProvider     ProviderKind
	TargetProvider     ProviderKind
	Status             string
	TotalObjects       int64
	CopiedObjects      int64
	StartedAt          time.Time
	FinishedAt         *time.Time
	ErrorCode          string
	Message            string
	TargetEndpointHost string
	TargetBucket       string
	TargetKeyPrefix    string
}

// Status 是 Owner-only 的 File Storage 状态投影。
type Status struct {
	Config        Config
	ProviderLabel string
	ProviderState string
	Message       string
	Hint          string
	ObservedAt    time.Time
	Referenced    int
	Migration     *Migration
	MigrationBusy bool
	LocalPath     string
	S3            *S3Settings
	S3AccessKey   *SecretReference
	S3SecretKey   *SecretReference
	S3SessionKey  *SecretReference
}

// Service 拥有 Provider 配置、对象回收与 Provider migration。
type Service struct {
	store      transactionalStore
	secrets    SecretProvider
	audits     AuditWriter
	references ReferenceSource
	staging    MigrationStaging
	objectsDir string
	now        func() time.Time

	mu             sync.Mutex
	config         Config
	configLoaded   bool
	providerErr    error
	reconcileErr   string
	migrationID    string
	migrationStop  context.CancelFunc
	started        bool
	closed         bool
	runCancel      context.CancelFunc
	runDone        chan struct{}
	reconcileEvery time.Duration
}

// ServiceOptions 是 Runtime 注入的依赖。
type ServiceOptions struct {
	Store       *storage.Store
	Secrets     SecretProvider
	Audits      AuditWriter
	References  ReferenceSource
	Staging     MigrationStaging
	ObjectsDir  string
	Now         func() time.Time
	ReconcileFor time.Duration
}

var fileStorageSchema = []string{
	`CREATE TABLE IF NOT EXISTS modelry_file_storage_config (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		revision INTEGER NOT NULL CHECK (revision >= 1),
		provider TEXT NOT NULL CHECK (provider IN ('local','s3')),
		s3_endpoint TEXT NOT NULL DEFAULT '',
		s3_region TEXT NOT NULL DEFAULT '',
		s3_bucket TEXT NOT NULL DEFAULT '',
		s3_key_prefix TEXT NOT NULL DEFAULT '',
		s3_path_style INTEGER NOT NULL DEFAULT 1,
		s3_access_key_secret_id TEXT NOT NULL DEFAULT '',
		s3_secret_key_secret_id TEXT NOT NULL DEFAULT '',
		s3_session_token_secret_id TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_file_migrations (
		id TEXT PRIMARY KEY NOT NULL,
		source_provider TEXT NOT NULL,
		target_provider TEXT NOT NULL,
		status TEXT NOT NULL,
		total_objects INTEGER NOT NULL DEFAULT 0,
		copied_objects INTEGER NOT NULL DEFAULT 0,
		s3_endpoint TEXT NOT NULL DEFAULT '',
		s3_region TEXT NOT NULL DEFAULT '',
		s3_bucket TEXT NOT NULL DEFAULT '',
		s3_key_prefix TEXT NOT NULL DEFAULT '',
		s3_path_style INTEGER NOT NULL DEFAULT 1,
		s3_access_key_secret_id TEXT NOT NULL DEFAULT '',
		s3_secret_key_secret_id TEXT NOT NULL DEFAULT '',
		s3_session_token_secret_id TEXT NOT NULL DEFAULT '',
		error_code TEXT NOT NULL DEFAULT '',
		message TEXT NOT NULL DEFAULT '',
		started_at TEXT NOT NULL,
		finished_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_file_migrations_by_started ON modelry_file_migrations (started_at DESC, id DESC)`,
}

// NewService 初始化 File Storage 配置、migration 历史与默认 Provider。
func NewService(ctx context.Context, options ServiceOptions) (*Service, error) {
	if options.Store == nil || options.Secrets == nil || options.Audits == nil || options.References == nil || options.Staging == nil {
		return nil, fmt.Errorf("file storage store, Secret provider, Audit writer, Record references, and staging are required")
	}
	if options.ObjectsDir == "" {
		return nil, fmt.Errorf("%w: Local object directory is required", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	reconcileEvery := options.ReconcileFor
	if reconcileEvery <= 0 {
		reconcileEvery = ReconcileInterval
	}
	service := &Service{
		store: options.Store, secrets: options.Secrets, audits: options.Audits, references: options.References,
		staging: options.Staging, objectsDir: options.ObjectsDir, now: now, reconcileEvery: reconcileEvery,
	}
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range fileStorageSchema {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize File Storage storage: %w", err)
			}
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_file_storage_config`).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_file_storage_config(id,revision,provider,updated_at) VALUES(1,1,'local',?)`, service.timestamp()); err != nil {
				return err
			}
		}
		// 重启后未完成的 migration 必须显式变为 interrupted，绝不自动继续。
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_file_migrations SET status=?,error_code=?,message=?,finished_at=?,updated_at=? WHERE status IN (?,?)`,
			MigrationInterrupted, ErrorInterrupted, "The Runtime restarted while this migration was running. Start a new migration to continue.", service.timestamp(), service.timestamp(), MigrationPending, MigrationRunning); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := service.reloadConfig(ctx); err != nil {
		return nil, err
	}
	return service, nil
}

func (service *Service) timestamp() string { return service.now().UTC().Format(time.RFC3339Nano) }

func parseTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

// PathPrefix 返回 Provider 内的对象路径前缀；Local 实现忽略它。
func (settings S3Settings) objectPrefix() string {
	if settings.KeyPrefix == "" {
		return ""
	}
	return strings.TrimSuffix(settings.KeyPrefix, "/") + "/"
}

func (settings S3Settings) ObjectKey(objectKey string) string {
	return settings.objectPrefix() + objectKey
}

// Host 返回不含凭据的 endpoint 主机，用于安全诊断。
func (settings S3Settings) Host() string {
	parsed, err := url.Parse(settings.Endpoint)
	if err != nil {
		return ""
	}
	return parsed.Host
}

func (service *Service) reloadConfig(ctx context.Context) error {
	var config Config
	var settings S3Settings
	var pathStyle int
	var provider string
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT revision,provider,s3_endpoint,s3_region,s3_bucket,s3_key_prefix,s3_path_style,s3_access_key_secret_id,s3_secret_key_secret_id,s3_session_token_secret_id FROM modelry_file_storage_config WHERE id=1`).
			Scan(&config.Revision, &provider, &settings.Endpoint, &settings.Region, &settings.Bucket, &settings.KeyPrefix, &pathStyle, &settings.AccessKeySecretID, &settings.SecretKeySecretID, &settings.SessionTokenSecretID)
	})
	if err != nil {
		return fmt.Errorf("read File Storage configuration: %w", err)
	}
	settings.PathStyle = pathStyle == 1
	config.Provider = ProviderKind(provider)
	if config.Provider == ProviderS3 {
		config.S3 = &settings
	}
	service.mu.Lock()
	service.config = config
	service.configLoaded = true
	service.mu.Unlock()
	return nil
}

func (service *Service) currentConfig() (Config, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if !service.configLoaded {
		return Config{}, fmt.Errorf("%w: File Storage configuration is not loaded", ErrNotConfigured)
	}
	return service.config, nil
}

// ActiveProvider 实现 records.FileProviders：它按当前配置构造 Provider。
// S3 凭据在每次调用时解密，构造完成后仅存在于该 Provider 实例的生命周期内。
func (service *Service) ActiveProvider(ctx context.Context) (Provider, error) {
	config, err := service.currentConfig()
	if err != nil {
		return nil, err
	}
	return service.buildProvider(ctx, config)
}

func (service *Service) buildProvider(ctx context.Context, config Config) (Provider, error) {
	switch config.Provider {
	case ProviderLocal:
		return NewLocal(service.objectsDir)
	case ProviderS3:
		if config.S3 == nil || !config.S3.complete() {
			return nil, ErrNotConfigured
		}
		access, secret, session, err := service.resolveCredentials(ctx, *config.S3)
		if err != nil {
			return nil, err
		}
		return NewS3(S3Config{
			Endpoint: config.S3.Endpoint, Region: config.S3.Region, Bucket: config.S3.Bucket,
			KeyPrefix: config.S3.objectPrefix(), PathStyle: config.S3.PathStyle,
			AccessKey: access, SecretKey: secret, SessionToken: session,
		})
	default:
		return nil, ErrNotConfigured
	}
}

func (settings S3Settings) complete() bool {
	return settings.Endpoint != "" && settings.Region != "" && settings.Bucket != "" &&
		settings.AccessKeySecretID != "" && settings.SecretKeySecretID != ""
}

func (service *Service) resolveCredentials(ctx context.Context, settings S3Settings) ([]byte, []byte, []byte, error) {
	read := func(secretID string, required bool) ([]byte, error) {
		if secretID == "" {
			if required {
				return nil, ErrCredentialUnavailable
			}
			return nil, nil
		}
		var captured []byte
		err := service.secrets.WithSecretValue(ctx, secretID, func(value []byte) error {
			captured = append([]byte(nil), value...)
			return nil
		})
		if err != nil {
			return nil, ErrCredentialUnavailable
		}
		if len(captured) == 0 {
			return nil, ErrCredentialUnavailable
		}
		return captured, nil
	}
	access, err := read(settings.AccessKeySecretID, true)
	if err != nil {
		return nil, nil, nil, err
	}
	secret, err := read(settings.SecretKeySecretID, true)
	if err != nil {
		return nil, nil, nil, err
	}
	session, err := read(settings.SessionTokenSecretID, false)
	if err != nil {
		return nil, nil, nil, err
	}
	return access, secret, session, nil
}

func (service *Service) appendAudit(ctx context.Context, tx storage.Executor, action, resourceID string) error {
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return nil
	}
	return service.audits.AppendInTransaction(ctx, tx, audit.AppendInput{
		Actor: actor, Action: action, Resource: audit.Resource{Kind: "fileStorage", ID: resourceID}, Result: "success",
	})
}

func newMigrationID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate file migration identifier: %w", err)
	}
	return "fmig_" + hex.EncodeToString(value[:]), nil
}

// ProviderHealth 返回活动 Provider 类型与其有界健康快照，供 Runtime 诊断使用。
func (service *Service) ProviderHealth(ctx context.Context) (ProviderKind, Health) {
	config, err := service.currentConfig()
	if err != nil {
		return ProviderLocal, Health{State: StateUnavailable, Message: "File Storage is not configured.", Hint: "Open Settings and choose a Provider."}
	}
	return config.Provider, service.Health(ctx)
}

// Health 是当前 Provider 的有界探测结果。
func (service *Service) Health(ctx context.Context) Health {
	config, err := service.currentConfig()
	if err != nil {
		return Health{State: StateUnavailable, Message: "File Storage is not configured.", Hint: "Open Settings → Files & storage and choose a Provider."}
	}
	provider, err := service.buildProvider(ctx, config)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotConfigured):
			return Health{State: StateUnavailable, Message: "The configured S3-compatible Provider is incomplete.", Hint: "Enter the endpoint, region, bucket, and both credential Secrets, then save again."}
		case errors.Is(err, ErrCredentialUnavailable):
			return Health{State: StateUnavailable, Message: "A File Storage credential Secret is missing or cannot be decrypted.", Hint: "Select an existing configured Secret, or restore the Project encryption key."}
		default:
			return Health{State: StateUnavailable, Message: "The File Storage Provider could not be initialized.", Hint: "Review the Provider settings and retry."}
		}
	}
	return provider.Health(ctx)
}

// ProviderLabel 返回面向 Owner 的 Provider 名称。
func ProviderLabel(kind ProviderKind) string {
	if kind == ProviderS3 {
		return "S3-compatible"
	}
	return "Local"
}

// Secrets 解析三个 Secret 引用的安全元数据；缺失引用返回 nil。
func (service *Service) secretReference(ctx context.Context, secretID string) (*SecretReference, error) {
	if secretID == "" {
		return nil, nil
	}
	name, configured, err := service.secrets.SecretMetadata(ctx, secretID)
	if err != nil {
		return &SecretReference{SecretID: secretID, Configured: false}, nil
	}
	return &SecretReference{SecretID: secretID, Name: name, Configured: configured}, nil
}

// Status 生成 Owner-only 的 File Storage 状态投影。
func (service *Service) Status(ctx context.Context) (Status, error) {
	config, err := service.currentConfig()
	if err != nil {
		return Status{}, err
	}
	health := service.Health(ctx)
	referenced := 0
	if keys, err := service.references.ReferencedFileKeys(ctx); err == nil {
		referenced = len(keys)
	}
	migration, busy, err := service.latestMigration(ctx)
	if err != nil {
		return Status{}, err
	}
	status := Status{
		Config: config, ProviderLabel: ProviderLabel(config.Provider), ProviderState: health.State,
		Message: health.Message, Hint: health.Hint, ObservedAt: service.now().UTC(),
		Referenced: referenced, Migration: migration, MigrationBusy: busy, LocalPath: service.objectsDir,
	}
	if config.S3 != nil {
		settings := *config.S3
		status.S3 = &settings
		access, err := service.secretReference(ctx, settings.AccessKeySecretID)
		if err != nil {
			return Status{}, err
		}
		secret, err := service.secretReference(ctx, settings.SecretKeySecretID)
		if err != nil {
			return Status{}, err
		}
		session, err := service.secretReference(ctx, settings.SessionTokenSecretID)
		if err != nil {
			return Status{}, err
		}
		status.S3AccessKey, status.S3SecretKey, status.S3SessionKey = access, secret, session
	}
	service.mu.Lock()
	status.Message = strings.TrimSpace(status.Message)
	if service.reconcileErr != "" && health.State == StateReady {
		status.ProviderState = StateDegraded
		status.Message = "File Storage is reachable but the last reconciliation reported a problem."
		status.Hint = service.reconcileErr
	}
	service.mu.Unlock()
	return status, nil
}

// Configure 保存 Provider 配置；有引用对象时移动 Provider 或对象位置需要先做 migration。
func (service *Service) Configure(ctx context.Context, expectedRevision int, provider ProviderKind, settings *S3Settings) (Status, error) {
	if expectedRevision < 1 {
		return Status{}, fmt.Errorf("%w: expectedRevision must be a positive integer", ErrInvalidArgument)
	}
	if provider != ProviderLocal && provider != ProviderS3 {
		return Status{}, fmt.Errorf("%w: provider must be local or s3", ErrInvalidArgument)
	}
	current, err := service.currentConfig()
	if err != nil {
		return Status{}, err
	}
	if current.Revision != expectedRevision {
		return Status{}, fmt.Errorf("%w: File Storage configuration changed; reload and retry", ErrConflict)
	}
	next := Config{Revision: current.Revision + 1, Provider: provider}
	if provider == ProviderS3 {
		if settings == nil {
			return Status{}, fmt.Errorf("%w: S3-compatible settings are required", ErrInvalidArgument)
		}
		normalized, err := service.normalizeS3Settings(ctx, *settings)
		if err != nil {
			return Status{}, err
		}
		next.S3 = &normalized
	}
	if err := service.requireMigrationForMove(ctx, current, next); err != nil {
		return Status{}, err
	}
	if err := service.validateTarget(ctx, next); err != nil {
		return Status{}, err
	}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		settings := S3Settings{}
		if next.S3 != nil {
			settings = *next.S3
		}
		pathStyle := 0
		if settings.PathStyle {
			pathStyle = 1
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_file_storage_config SET revision=?,provider=?,s3_endpoint=?,s3_region=?,s3_bucket=?,s3_key_prefix=?,s3_path_style=?,s3_access_key_secret_id=?,s3_secret_key_secret_id=?,s3_session_token_secret_id=?,updated_at=? WHERE id=1`,
			next.Revision, string(next.Provider), settings.Endpoint, settings.Region, settings.Bucket, settings.KeyPrefix, pathStyle, settings.AccessKeySecretID, settings.SecretKeySecretID, settings.SessionTokenSecretID, service.timestamp()); err != nil {
			return err
		}
		return service.appendAudit(ctx, tx, "storage.providerConfigured", string(next.Provider))
	})
	if err != nil {
		return Status{}, err
	}
	if err := service.reloadConfig(ctx); err != nil {
		return Status{}, err
	}
	return service.Status(ctx)
}

// requireMigrationForMove 拒绝在有引用对象时直接移动 Provider 或对象位置。
func (service *Service) requireMigrationForMove(ctx context.Context, current, next Config) error {
	keys, err := service.references.ReferencedFileKeys(ctx)
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return nil
	}
	if current.Provider != next.Provider {
		return fmt.Errorf("%w: %d file objects are still referenced; migrate them before switching Provider", ErrMigrationRequired, len(keys))
	}
	if current.Provider == ProviderS3 && next.Provider == ProviderS3 {
		moved := current.S3 == nil || next.S3 == nil ||
			current.S3.Endpoint != next.S3.Endpoint || current.S3.Bucket != next.S3.Bucket ||
			current.S3.objectPrefix() != next.S3.objectPrefix() || current.S3.PathStyle != next.S3.PathStyle
		if moved {
			return fmt.Errorf("%w: changing the S3-compatible object location requires a migration", ErrMigrationRequired)
		}
	}
	return nil
}

// validateTarget 校验 Provider 配置可用：Local 目录安全，S3 端点与凭据可用。
func (service *Service) validateTarget(ctx context.Context, config Config) error {
	provider, err := service.buildProvider(ctx, config)
	if err != nil {
		return err
	}
	if config.Provider == ProviderS3 {
		health := provider.Health(ctx)
		if health.State != StateReady {
			return fmt.Errorf("%w: %s", ErrUnavailable, health.Message)
		}
	}
	return nil
}

func (service *Service) normalizeS3Settings(ctx context.Context, settings S3Settings) (S3Settings, error) {
	endpoint, err := ParseS3Endpoint(strings.TrimSpace(settings.Endpoint))
	if err != nil {
		return S3Settings{}, err
	}
	normalized := settings
	normalized.Endpoint = strings.TrimRight(endpoint.String(), "/")
	normalized.Region = strings.TrimSpace(settings.Region)
	normalized.Bucket = strings.TrimSpace(settings.Bucket)
	normalized.KeyPrefix = strings.TrimSpace(settings.KeyPrefix)
	if normalized.Region == "" || len(normalized.Region) > 64 {
		return S3Settings{}, fmt.Errorf("%w: region must contain 1 to 64 characters", ErrInvalidArgument)
	}
	if !validBucketName(normalized.Bucket) {
		return S3Settings{}, fmt.Errorf("%w: bucket must contain 1 to 63 characters from a-z, 0-9, dot, or hyphen", ErrInvalidArgument)
	}
	if err := validKeyPrefix(normalized.KeyPrefix); err != nil {
		return S3Settings{}, err
	}
	if normalized.AccessKeySecretID == "" || normalized.SecretKeySecretID == "" {
		return S3Settings{}, fmt.Errorf("%w: both credential Secrets are required", ErrCredentialUnavailable)
	}
	if _, _, _, err := service.resolveCredentials(ctx, normalized); err != nil {
		return S3Settings{}, err
	}
	return normalized, nil
}

func validBucketName(value string) bool {
	if len(value) < 1 || len(value) > 63 {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '.' && r != '-' {
			return false
		}
	}
	return !strings.HasPrefix(value, ".") && !strings.HasSuffix(value, ".") && !strings.Contains(value, "..")
}

func validKeyPrefix(value string) error {
	if value == "" {
		return nil
	}
	if len(value) > 128 {
		return fmt.Errorf("%w: keyPrefix must contain at most 128 characters", ErrInvalidArgument)
	}
	if strings.HasPrefix(value, "/") {
		return fmt.Errorf("%w: keyPrefix must not start with a slash", ErrInvalidArgument)
	}
	for _, segment := range strings.Split(strings.Trim(value, "/"), "/") {
		if segment == ".." || segment == "." {
			return fmt.Errorf("%w: keyPrefix must not contain relative path segments", ErrInvalidArgument)
		}
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '_' && r != '-' && r != '/' {
			return fmt.Errorf("%w: keyPrefix contains an unsupported character", ErrInvalidArgument)
		}
	}
	return nil
}

// providerSettingsForConfig 把配置折叠为持久字段，供 migration 快照使用。
func migrationSettings(settings *S3Settings) S3Settings {
	if settings == nil {
		return S3Settings{}
	}
	return *settings
}

// applyMigrationTarget 在完成 migration 时原子切换 Provider。
func (service *Service) applyMigrationTarget(ctx context.Context, tx storage.Executor, target Config, migrationID string) error {
	settings := migrationSettings(target.S3)
	pathStyle := 0
	if settings.PathStyle {
		pathStyle = 1
	}
	if _, err := tx.ExecContext(ctx, `UPDATE modelry_file_storage_config SET revision=?,provider=?,s3_endpoint=?,s3_region=?,s3_bucket=?,s3_key_prefix=?,s3_path_style=?,s3_access_key_secret_id=?,s3_secret_key_secret_id=?,s3_session_token_secret_id=?,updated_at=? WHERE id=1`,
		target.Revision, string(target.Provider), settings.Endpoint, settings.Region, settings.Bucket, settings.KeyPrefix, pathStyle, settings.AccessKeySecretID, settings.SecretKeySecretID, settings.SessionTokenSecretID, service.timestamp()); err != nil {
		return err
	}
	return service.appendAudit(ctx, tx, "storage.migrationCompleted", migrationID)
}

func (service *Service) latestMigration(ctx context.Context) (*Migration, bool, error) {
	list, err := service.Migrations(ctx, 1)
	if err != nil {
		return nil, false, err
	}
	if len(list) == 0 {
		return nil, false, nil
	}
	busy := list[0].Status == MigrationPending || list[0].Status == MigrationRunning
	return &list[0], busy, nil
}

// Migrations 返回最近的 migration 历史，最新在前。
func (service *Service) Migrations(ctx context.Context, limit int) ([]Migration, error) {
	if limit <= 0 || limit > migrationHistoryLimit {
		limit = 20
	}
	result := make([]Migration, 0, limit)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT id,source_provider,target_provider,status,total_objects,copied_objects,error_code,message,started_at,finished_at,s3_endpoint,s3_bucket,s3_key_prefix FROM modelry_file_migrations ORDER BY started_at DESC, id DESC LIMIT ?`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Migration
			var source, target, started, finished, endpoint string
			if err := rows.Scan(&item.ID, &source, &target, &item.Status, &item.TotalObjects, &item.CopiedObjects, &item.ErrorCode, &item.Message, &started, &finished, &endpoint, &item.TargetBucket, &item.TargetKeyPrefix); err != nil {
				return err
			}
			item.SourceProvider = ProviderKind(source)
			item.TargetProvider = ProviderKind(target)
			item.StartedAt = parseTime(started)
			if finished != "" {
				value := parseTime(finished)
				item.FinishedAt = &value
			}
			if parsed, err := url.Parse(endpoint); err == nil {
				item.TargetEndpointHost = parsed.Host
			}
			result = append(result, item)
		}
		return rows.Err()
	})
	return result, err
}

// Migration 返回单个 migration。
func (service *Service) Migration(ctx context.Context, id string) (Migration, error) {
	var item Migration
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var source, target, started, finished, endpoint string
		err := snapshot.QueryRowContext(ctx, `SELECT id,source_provider,target_provider,status,total_objects,copied_objects,error_code,message,started_at,finished_at,s3_endpoint,s3_bucket,s3_key_prefix FROM modelry_file_migrations WHERE id=?`, id).
			Scan(&item.ID, &source, &target, &item.Status, &item.TotalObjects, &item.CopiedObjects, &item.ErrorCode, &item.Message, &started, &finished, &endpoint, &item.TargetBucket, &item.TargetKeyPrefix)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		item.SourceProvider = ProviderKind(source)
		item.TargetProvider = ProviderKind(target)
		item.StartedAt = parseTime(started)
		if finished != "" {
			value := parseTime(finished)
			item.FinishedAt = &value
		}
		if parsed, err := url.Parse(endpoint); err == nil {
			item.TargetEndpointHost = parsed.Host
		}
		return nil
	})
	if err != nil {
		return Migration{}, err
	}
	return item, nil
}

// migrationTarget 读取一次 migration 的持久目标配置。
func (service *Service) migrationTarget(ctx context.Context, id string) (Config, error) {
	var config Config
	var provider, target string
	var settings S3Settings
	var pathStyle int
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT target_provider,s3_endpoint,s3_region,s3_bucket,s3_key_prefix,s3_path_style,s3_access_key_secret_id,s3_secret_key_secret_id,s3_session_token_secret_id FROM modelry_file_migrations WHERE id=?`, id).
			Scan(&target, &settings.Endpoint, &settings.Region, &settings.Bucket, &settings.KeyPrefix, &pathStyle, &settings.AccessKeySecretID, &settings.SecretKeySecretID, &settings.SessionTokenSecretID)
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Config{}, ErrNotFound
		}
		return Config{}, err
	}
	_ = provider
	settings.PathStyle = pathStyle == 1
	config.Provider = ProviderKind(target)
	if config.Provider == ProviderS3 {
		config.S3 = &settings
	}
	return config, nil
}

// StartMigration 创建一个 durable migration 并在后台执行。
func (service *Service) StartMigration(ctx context.Context, targetProvider ProviderKind, settings *S3Settings) (Migration, error) {
	if targetProvider != ProviderLocal && targetProvider != ProviderS3 {
		return Migration{}, fmt.Errorf("%w: target provider must be local or s3", ErrInvalidArgument)
	}
	current, err := service.currentConfig()
	if err != nil {
		return Migration{}, err
	}
	if current.Provider == targetProvider {
		return Migration{}, fmt.Errorf("%w: the requested Provider is already active", ErrInvalidArgument)
	}
	service.mu.Lock()
	busy := service.migrationID != ""
	service.mu.Unlock()
	if busy {
		return Migration{}, ErrMigrationActive
	}
	var durableActive int
	if err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_file_migrations WHERE status IN (?,?)`, MigrationPending, MigrationRunning).Scan(&durableActive)
	}); err != nil {
		return Migration{}, err
	}
	if durableActive > 0 {
		return Migration{}, ErrMigrationActive
	}
	next := Config{Revision: current.Revision + 1, Provider: targetProvider}
	if targetProvider == ProviderS3 {
		if settings == nil {
			return Migration{}, fmt.Errorf("%w: S3-compatible settings are required", ErrInvalidArgument)
		}
		normalized, err := service.normalizeS3Settings(ctx, *settings)
		if err != nil {
			return Migration{}, err
		}
		next.S3 = &normalized
	}
	if err := service.validateTarget(ctx, next); err != nil {
		return Migration{}, err
	}
	keys, err := service.references.ReferencedFileKeys(ctx)
	if err != nil {
		return Migration{}, err
	}
	if len(keys) > maximumMigrationObjects {
		return Migration{}, fmt.Errorf("%w: %d referenced objects exceed the migration limit of %d", ErrInvalidArgument, len(keys), maximumMigrationObjects)
	}
	id, err := newMigrationID()
	if err != nil {
		return Migration{}, err
	}
	stored := migrationSettings(next.S3)
	pathStyle := 0
	if stored.PathStyle {
		pathStyle = 1
	}
	now := service.timestamp()
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_file_migrations(id,source_provider,target_provider,status,total_objects,copied_objects,s3_endpoint,s3_region,s3_bucket,s3_key_prefix,s3_path_style,s3_access_key_secret_id,s3_secret_key_secret_id,s3_session_token_secret_id,error_code,message,started_at,finished_at,updated_at)
			VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?,?,'','',?,?,?)`,
			id, string(current.Provider), string(targetProvider), MigrationPending, len(keys), stored.Endpoint, stored.Region, stored.Bucket, stored.KeyPrefix, pathStyle, stored.AccessKeySecretID, stored.SecretKeySecretID, stored.SessionTokenSecretID, now, now, now); err != nil {
			return err
		}
		return service.appendAudit(ctx, tx, "storage.migrationStarted", id)
	})
	if err != nil {
		return Migration{}, err
	}
	service.launchMigration(id)
	return service.Migration(ctx, id)
}

// launchMigration 启动后台复制；它使用 Service 级 context，Close 时会被取消。
func (service *Service) launchMigration(id string) {
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	service.migrationID = id
	service.migrationStop = cancel
	service.mu.Unlock()
	go func() {
		service.runMigration(ctx, id)
		cancel()
	}()
}

func (service *Service) finishMigration(ctx context.Context, id, status, errorCode, message string) {
	now := service.timestamp()
	_ = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
		_, err := tx.ExecContext(context.WithoutCancel(ctx), `UPDATE modelry_file_migrations SET status=?,error_code=?,message=?,finished_at=?,updated_at=? WHERE id=?`, status, errorCode, message, now, now, id)
		if err != nil {
			return err
		}
		if status == MigrationFailed || status == MigrationCancelled {
			return service.appendAudit(context.WithoutCancel(ctx), tx, "storage.migrationFailed", id)
		}
		return nil
	})
	service.mu.Lock()
	if service.migrationID == id {
		service.migrationID = ""
		service.migrationStop = nil
	}
	service.mu.Unlock()
}

// runMigration 逐对象复制引用对象；每个对象都有独立 deadline，失败保留当前 Provider。
func (service *Service) runMigration(ctx context.Context, id string) {
	updateStatus := func(status string) {
		_ = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
			_, err := tx.ExecContext(context.WithoutCancel(ctx), `UPDATE modelry_file_migrations SET status=?,updated_at=? WHERE id=?`, status, service.timestamp(), id)
			return err
		})
	}
	updateStatus(MigrationRunning)
	migration, err := service.Migration(context.WithoutCancel(ctx), id)
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorProviderUnavailable, "The migration record could not be read.")
		return
	}
	current, err := service.currentConfig()
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorProviderUnavailable, "The active File Storage configuration could not be read.")
		return
	}
	source, err := service.buildProvider(ctx, current)
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorCredentialUnavailable, "The active Provider credentials are unavailable.")
		return
	}
	targetConfig, err := service.migrationTarget(ctx, id)
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorProviderUnavailable, "The migration target configuration could not be read.")
		return
	}
	targetConfig.Revision = current.Revision + 1
	target, err := service.buildProvider(ctx, targetConfig)
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorCredentialUnavailable, "The target Provider credentials are unavailable.")
		return
	}
	keys, err := service.references.ReferencedFileKeys(ctx)
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorProviderUnavailable, "Referenced File objects could not be listed.")
		return
	}
	sort.Strings(keys)
	copied := int64(0)
	for _, key := range keys {
		if ctx.Err() != nil {
			service.finishMigration(ctx, id, MigrationCancelled, ErrorCancelled, "The migration was cancelled. The active Provider is unchanged.")
			return
		}
		if err := service.copyObject(ctx, source, target, key); err != nil {
			code := ErrorObjectWriteFailed
			if errors.Is(err, ErrCredentialUnavailable) {
				code = ErrorCredentialUnavailable
			} else if errors.Is(err, ErrUnavailable) {
				code = ErrorProviderUnavailable
			} else if errors.Is(err, ErrVerification) {
				code = ErrorVerificationFailed
			}
			service.finishMigration(ctx, id, MigrationFailed, code, "A File object could not be copied. The active Provider is unchanged.")
			return
		}
		copied++
		_ = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
			_, err := tx.ExecContext(context.WithoutCancel(ctx), `UPDATE modelry_file_migrations SET copied_objects=?,updated_at=? WHERE id=?`, copied, service.timestamp(), id)
			return err
		})
	}
	targetConfig.Revision = current.Revision + 1
	err = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
		var status string
		var stored int64
		if err := tx.QueryRowContext(context.WithoutCancel(ctx), `SELECT status,copied_objects FROM modelry_file_migrations WHERE id=?`, id).Scan(&status, &stored); err != nil {
			return err
		}
		if status == MigrationCancelled {
			return nil
		}
		if stored != int64(len(keys)) {
			return fmt.Errorf("migration progress is incomplete")
		}
		if err := service.applyMigrationTarget(context.WithoutCancel(ctx), tx, targetConfig, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(context.WithoutCancel(ctx), `UPDATE modelry_file_migrations SET status=?,copied_objects=?,finished_at=?,updated_at=? WHERE id=?`,
			MigrationCompleted, copied, service.timestamp(), service.timestamp(), id)
		return err
	})
	if err != nil {
		service.finishMigration(ctx, id, MigrationFailed, ErrorVerificationFailed, "The Provider switch could not be committed. The active Provider is unchanged.")
		return
	}
	_ = service.reloadConfig(context.WithoutCancel(ctx))
	service.mu.Lock()
	if service.migrationID == id {
		service.migrationID = ""
		service.migrationStop = nil
	}
	service.mu.Unlock()
	_ = migration
}

// ErrVerification 表示目标对象大小与源对象不一致。
var ErrVerification = errors.New("file object verification failed")

// copyObject 复制一个引用对象；目标已存在且大小一致时跳过，保证重试幂等。
func (service *Service) copyObject(ctx context.Context, source, target Provider, key string) error {
	objectCtx, cancel := context.WithTimeout(ctx, migrationObjectTimeout)
	defer cancel()
	sourceInfo, err := source.Stat(objectCtx, key)
	if err != nil {
		return err
	}
	if info, err := target.Stat(objectCtx, key); err == nil {
		if info.Size == sourceInfo.Size {
			return nil
		}
		return fmt.Errorf("%w: target object size differs from the source", ErrVerification)
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	reader, info, err := source.Open(objectCtx, key)
	if err != nil {
		return err
	}
	file, stagedPath, err := service.staging.NewMigrationStagingFile()
	if err != nil {
		_ = reader.Close()
		return err
	}
	_, copyErr := io.Copy(file, reader)
	closeReaderErr := reader.Close()
	if copyErr != nil || closeReaderErr != nil {
		_ = file.Close()
		_ = os.Remove(stagedPath)
		if copyErr != nil {
			return copyErr
		}
		return closeReaderErr
	}
	stagedInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		_ = os.Remove(stagedPath)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(stagedPath)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(stagedPath)
		return err
	}
	defer os.Remove(stagedPath)
	contentType := info.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if stagedInfo.Size() != sourceInfo.Size {
		return fmt.Errorf("%w: staged copy size differs from the source object", ErrVerification)
	}
	if err := target.Promote(objectCtx, key, Staged{Path: stagedPath, Size: stagedInfo.Size(), ContentType: contentType}); err != nil {
		if errors.Is(err, ErrObjectExists) {
			verify, statErr := target.Stat(objectCtx, key)
			if statErr == nil && verify.Size == sourceInfo.Size {
				return nil
			}
			return fmt.Errorf("%w: target object exists with a different size", ErrVerification)
		}
		return err
	}
	verify, err := target.Stat(objectCtx, key)
	if err != nil {
		return err
	}
	if verify.Size != sourceInfo.Size {
		return fmt.Errorf("%w: copied object size differs from the source", ErrVerification)
	}
	return nil
}

// CancelMigration 取消一个 pending/running migration；其它状态返回 MIGRATION_NOT_ACTIVE。
func (service *Service) CancelMigration(ctx context.Context, id string) (Migration, error) {
	migration, err := service.Migration(ctx, id)
	if err != nil {
		return Migration{}, err
	}
	if migration.Status != MigrationPending && migration.Status != MigrationRunning {
		return Migration{}, ErrMigrationNotActive
	}
	service.mu.Lock()
	stop := service.migrationStop
	active := service.migrationID == id
	service.mu.Unlock()
	if active && stop != nil {
		stop()
	}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_file_migrations SET status=?,error_code=?,message=?,finished_at=?,updated_at=? WHERE id=? AND status IN (?,?)`,
			MigrationCancelled, ErrorCancelled, "The migration was cancelled. The active Provider is unchanged.", service.timestamp(), service.timestamp(), id, MigrationPending, MigrationRunning)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrMigrationNotActive
		}
		return service.appendAudit(ctx, tx, "storage.migrationCancelled", id)
	})
	if err != nil {
		return Migration{}, err
	}
	return service.Migration(ctx, id)
}

// TestS3 执行一次有界、非破坏性的连接测试，不保存配置。
func (service *Service) TestS3(ctx context.Context, settings S3Settings) (Health, error) {
	normalized, err := service.normalizeS3Settings(ctx, settings)
	if err != nil {
		return Health{}, err
	}
	provider, err := service.buildProvider(ctx, Config{Provider: ProviderS3, S3: &normalized})
	if err != nil {
		return Health{}, err
	}
	health := provider.Health(ctx)
	if health.State != StateReady {
		return health, nil
	}
	if err := service.recordTest(ctx, normalized); err != nil {
		return Health{}, err
	}
	return health, nil
}

func (service *Service) recordTest(ctx context.Context, settings S3Settings) error {
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		return service.appendAudit(ctx, tx, "storage.providerTested", settings.Bucket)
	})
}

// Start 启动后台 reconcile 循环。
func (service *Service) Start(parent context.Context) error {
	if parent == nil {
		parent = context.Background()
	}
	service.mu.Lock()
	if service.started || service.closed {
		service.mu.Unlock()
		return fmt.Errorf("%w: File Storage service can only be started once", ErrInvalidArgument)
	}
	runCtx, cancel := context.WithCancel(parent)
	service.started = true
	service.runCancel = cancel
	service.runDone = make(chan struct{})
	done := service.runDone
	service.mu.Unlock()
	go func() {
		defer close(done)
		ticker := time.NewTicker(service.reconcileEvery)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				service.reconcileTracked(runCtx, ReconcileGrace)
			}
		}
	}()
	return nil
}

// Reconcile 执行一次对象回收与引用校验，并记录最近一次失败供诊断展示。
func (service *Service) Reconcile(ctx context.Context, grace time.Duration) error {
	err := service.reconcileTracked(ctx, grace)
	service.mu.Lock()
	if err != nil {
		service.reconcileErr = "Reconciliation reported a problem with the active Provider or a referenced File object."
	} else {
		service.reconcileErr = ""
	}
	service.mu.Unlock()
	return err
}

func (service *Service) reconcileTracked(ctx context.Context, grace time.Duration) error {
	if grace <= 0 {
		grace = ReconcileGrace
	}
	provider, err := service.ActiveProvider(ctx)
	if err != nil {
		return err
	}
	keys, err := service.references.ReferencedFileKeys(ctx)
	if err != nil {
		return err
	}
	referenced := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		referenced[key] = struct{}{}
	}
	cutoff := service.now().UTC().Add(-grace)
	page, err := provider.List(ctx, "", MaxListPage)
	if err != nil {
		return err
	}
	for _, object := range page.Objects {
		if _, keep := referenced[object.Key]; keep {
			continue
		}
		if !object.ModifiedAt.Before(cutoff) {
			continue
		}
		if err := provider.Delete(ctx, object.Key); err != nil {
			return err
		}
	}
	for index, key := range keys {
		if index >= MaxListPage {
			break
		}
		objectCtx, cancel := context.WithTimeout(ctx, RequestTimeout)
		_, err := provider.Stat(objectCtx, key)
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

// Close 停止后台循环并取消进行中的 migration，但不改变 Provider。
func (service *Service) Close(ctx context.Context) error {
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return nil
	}
	service.closed = true
	cancel := service.runCancel
	stop := service.migrationStop
	done := service.runDone
	service.mu.Unlock()
	if stop != nil {
		stop()
	}
	if cancel != nil {
		cancel()
	}
	if done != nil {
		if ctx == nil {
			<-done
		} else {
			select {
			case <-done:
			case <-ctx.Done():
			}
		}
	}
	return nil
}

