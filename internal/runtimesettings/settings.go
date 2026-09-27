// Package runtimesettings 提供带 value source、validation 与 restart requirement 的 durable Runtime 配置。
package runtimesettings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	// ErrInvalidArgument 表示取值不合法。
	ErrInvalidArgument = errors.New("invalid runtime setting")
	// ErrConflict 表示 revision 冲突。
	ErrConflict = errors.New("runtime settings conflict")
	// ErrStorage 表示持久化失败。
	ErrStorage = errors.New("runtime settings storage unavailable")
)

// Source 表示一个取值当前来自哪里。
type Source string

const (
	SourceFlag    Source = "flag"
	SourceProject Source = "project"
	SourceDefault Source = "default"
)

// Setting 是一项目的配置的当前视图。
type Setting struct {
	Value           string `json:"value"`
	Source          Source `json:"source"`
	RestartRequired bool   `json:"restartRequired"`
	Bounds          string `json:"bounds"`
}

// Settings 是 Runtime 配置的完整视图。
type Settings struct {
	ListenAddress        Setting   `json:"listenAddress"`
	RequestRetentionDays Setting   `json:"requestRetentionDays"`
	Revision             int       `json:"revision"`
	UpdatedAt            time.Time `json:"updatedAt"`
}

// Input 是一次保存请求。
type Input struct {
	ExpectedRevision     int
	ListenAddress        string
	RequestRetentionDays int
}

// AuditSink 由 Runtime 注入：写入 Control Plane 事实。
type AuditSink interface {
	AppendSettingsFactInTransaction(ctx context.Context, tx storage.Executor, action, resourceID, result string) error
}

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// Options 提供内建默认值与显式 runtime flag。
type Options struct {
	DefaultListenAddress        string
	FlagListenAddress           string
	DefaultRequestRetentionDays int
}

// Service 读写 Runtime Settings。
type Service struct {
	store     transactionalStore
	audits    AuditSink
	options   Options
	now       func() time.Time
	runningMu chan struct{}
	running   string
}

// 取值边界。
const (
	MinimumRequestRetentionDays = 1
	MaximumRequestRetentionDays = 3650
)

// NewService 创建 Runtime Settings 服务并保证单例行存在。
func NewService(ctx context.Context, store transactionalStore, options Options, audits AuditSink) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("%w: SQLite store is required", ErrInvalidArgument)
	}
	if options.DefaultListenAddress == "" {
		options.DefaultListenAddress = "127.0.0.1:8080"
	}
	if options.DefaultRequestRetentionDays == 0 {
		options.DefaultRequestRetentionDays = 30
	}
	if options.DefaultRequestRetentionDays < MinimumRequestRetentionDays || options.DefaultRequestRetentionDays > MaximumRequestRetentionDays {
		return nil, fmt.Errorf("%w: default request retention is out of range", ErrInvalidArgument)
	}
	service := &Service{store: store, audits: audits, options: options, now: func() time.Time { return time.Now().UTC() }}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_runtime_settings (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			revision INTEGER NOT NULL CHECK (revision >= 1),
			listen_address TEXT,
			request_retention_days INTEGER,
			updated_at TEXT NOT NULL
		)`); err != nil {
			return fmt.Errorf("create Runtime Settings table: %w", err)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_runtime_settings (singleton, revision, listen_address, request_retention_days, updated_at)
			VALUES (1, 1, NULL, NULL, ?) ON CONFLICT(singleton) DO NOTHING`, timestamp(service.now()))
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("%w: initialize Runtime Settings: %v", ErrStorage, err)
	}
	return service, nil
}

// SetRunningListen 记录当前进程实际启动时使用的监听值，用于判断是否需要重启。
func (service *Service) SetRunningListen(value string) {
	if service == nil {
		return
	}
	service.running = strings.TrimSpace(value)
}

type storedSettings struct {
	Revision             int
	ListenAddress        sql.NullString
	RequestRetentionDays sql.NullInt64
	UpdatedAt            string
}

// Get 返回当前生效的 Runtime Settings，并标注每个值的来源。
func (service *Service) Get(ctx context.Context) (Settings, error) {
	if service == nil || service.store == nil {
		return Settings{}, fmt.Errorf("%w: Runtime Settings service is not ready", ErrStorage)
	}
	var stored storedSettings
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT revision, listen_address, request_retention_days, updated_at FROM modelry_runtime_settings WHERE singleton = 1`).
			Scan(&stored.Revision, &stored.ListenAddress, &stored.RequestRetentionDays, &stored.UpdatedAt)
	})
	if err != nil {
		return Settings{}, fmt.Errorf("%w: read Runtime Settings: %v", ErrStorage, err)
	}
	return service.view(stored)
}

func (service *Service) view(stored storedSettings) (Settings, error) {
	updatedAt, err := time.Parse(time.RFC3339Nano, stored.UpdatedAt)
	if err != nil {
		updatedAt = service.now().UTC()
	}
	listen := Setting{Value: service.options.DefaultListenAddress, Source: SourceDefault, Bounds: "host:port"}
	switch {
	case service.options.FlagListenAddress != "":
		listen = Setting{Value: service.options.FlagListenAddress, Source: SourceFlag, Bounds: listen.Bounds}
	case stored.ListenAddress.Valid && stored.ListenAddress.String != "":
		listen = Setting{Value: stored.ListenAddress.String, Source: SourceProject, Bounds: listen.Bounds}
	}
	if service.running != "" && listen.Value != service.running {
		listen.RestartRequired = true
	}
	retention := Setting{
		Value:  strconv.Itoa(service.options.DefaultRequestRetentionDays),
		Source: SourceDefault,
		Bounds: fmt.Sprintf("%d..%d days", MinimumRequestRetentionDays, MaximumRequestRetentionDays),
	}
	if stored.RequestRetentionDays.Valid {
		retention.Value = strconv.FormatInt(stored.RequestRetentionDays.Int64, 10)
		retention.Source = SourceProject
	}
	return Settings{
		ListenAddress: listen, RequestRetentionDays: retention,
		Revision: stored.Revision, UpdatedAt: updatedAt.UTC(),
	}, nil
}

// Save 校验并持久化 Runtime Settings；需要重启的取值只报告要求，不改变正在运行的 Runtime。
func (service *Service) Save(ctx context.Context, input Input) (Settings, error) {
	if service == nil || service.store == nil {
		return Settings{}, fmt.Errorf("%w: Runtime Settings service is not ready", ErrStorage)
	}
	listen, err := normalizeListenAddress(input.ListenAddress)
	if err != nil {
		return Settings{}, err
	}
	if input.RequestRetentionDays < MinimumRequestRetentionDays || input.RequestRetentionDays > MaximumRequestRetentionDays {
		return Settings{}, fmt.Errorf("%w: requestRetentionDays must be between %d and %d", ErrInvalidArgument, MinimumRequestRetentionDays, MaximumRequestRetentionDays)
	}
	if input.ExpectedRevision < 1 {
		return Settings{}, fmt.Errorf("%w: expectedRevision is required", ErrInvalidArgument)
	}
	var stored storedSettings
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		current, err := readStored(ctx, tx)
		if err != nil {
			return err
		}
		if current.Revision != input.ExpectedRevision {
			return ErrConflict
		}
		listenValue := sql.NullString{}
		if listen != "" {
			listenValue = sql.NullString{String: listen, Valid: true}
		}
		now := timestamp(service.now())
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_runtime_settings
			SET revision = ?, listen_address = ?, request_retention_days = ?, updated_at = ? WHERE singleton = 1`,
			current.Revision+1, listenValue, sql.NullInt64{Int64: int64(input.RequestRetentionDays), Valid: true}, now); err != nil {
			return err
		}
		if service.audits != nil {
			if err := service.audits.AppendSettingsFactInTransaction(ctx, tx, "runtimeSettings.updated", "runtime", "success"); err != nil {
				return err
			}
		}
		stored = storedSettings{
			Revision: current.Revision + 1, ListenAddress: listenValue,
			RequestRetentionDays: sql.NullInt64{Int64: int64(input.RequestRetentionDays), Valid: true}, UpdatedAt: now,
		}
		return nil
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrConflict), errors.Is(err, ErrInvalidArgument):
			return Settings{}, err
		default:
			return Settings{}, fmt.Errorf("%w: save Runtime Settings: %v", ErrStorage, err)
		}
	}
	return service.view(stored)
}

func readStored(ctx context.Context, query storage.Executor) (storedSettings, error) {
	var stored storedSettings
	if err := query.QueryRowContext(ctx, `SELECT revision, listen_address, request_retention_days, updated_at FROM modelry_runtime_settings WHERE singleton = 1`).
		Scan(&stored.Revision, &stored.ListenAddress, &stored.RequestRetentionDays, &stored.UpdatedAt); err != nil {
		return storedSettings{}, err
	}
	return stored, nil
}

func normalizeListenAddress(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	if len(trimmed) > 256 {
		return "", fmt.Errorf("%w: listenAddress is too long", ErrInvalidArgument)
	}
	host, port, err := net.SplitHostPort(trimmed)
	if err != nil {
		return "", fmt.Errorf("%w: listenAddress must be a host:port pair", ErrInvalidArgument)
	}
	if strings.ContainsAny(host, " \t") {
		return "", fmt.Errorf("%w: listenAddress host is invalid", ErrInvalidArgument)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 0 || number > 65535 {
		return "", fmt.Errorf("%w: listenAddress port must be between 0 and 65535", ErrInvalidArgument)
	}
	return trimmed, nil
}

// RequestRetentionDaysValue 返回当前生效的保留天数，供 Request log pruner 使用。
func (settings Settings) RequestRetentionDaysValue() int {
	value, err := strconv.Atoi(settings.RequestRetentionDays.Value)
	if err != nil || value < MinimumRequestRetentionDays || value > MaximumRequestRetentionDays {
		return 30
	}
	return value
}

func timestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }