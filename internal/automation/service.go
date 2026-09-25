package automation

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Service struct {
	store         transactionalStore
	secrets       SecretProvider
	webhookClient *safehttp.WebhookClient
	now           func() time.Time
	retryDelays   []time.Duration
	mu            sync.Mutex
	active        map[string]activeDelivery
	wake          chan struct{}
	started       bool
	closed        bool
	runCancel     context.CancelFunc
	runDone       chan struct{}
}

type activeDelivery struct {
	webhookID  string
	sourceType string
	cancel     context.CancelFunc
}

const maximumWebhooks = 32

func NewService(ctx context.Context, store transactionalStore, options ServiceOptions) (*Service, error) {
	return newService(ctx, store, options, safehttp.NewWebhookClient())
}

func newService(ctx context.Context, store transactionalStore, options ServiceOptions, webhookClient *safehttp.WebhookClient) (*Service, error) {
	if store == nil || options.Secrets == nil || webhookClient == nil {
		return nil, fmt.Errorf("automation storage and Secret provider are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	service := &Service{store: store, secrets: options.Secrets, webhookClient: webhookClient, now: now, retryDelays: []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 3 * time.Hour, 6 * time.Hour, 12 * time.Hour}, active: make(map[string]activeDelivery), wake: make(chan struct{}, 1)}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range automationSchema {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize Webhook and Job storage: %w", err)
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := service.recoverOnStartup(ctx); err != nil {
		return nil, err
	}
	if err := service.scheduleDueJobs(ctx, now().UTC()); err != nil {
		return nil, err
	}
	return service, nil
}

var automationSchema = []string{
	`CREATE TABLE IF NOT EXISTS modelry_automation_webhooks (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL,
		target_url TEXT NOT NULL,
		signing_secret_id TEXT NOT NULL,
		enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
		revision INTEGER NOT NULL CHECK (revision >= 1),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_automation_event_hooks (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL,
		collection_id TEXT NOT NULL,
		event_type TEXT NOT NULL CHECK (event_type IN ('record.created','record.updated','record.deleted')),
		webhook_id TEXT NOT NULL,
		enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		UNIQUE (collection_id,event_type,webhook_id),
		FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id) ON DELETE CASCADE,
		FOREIGN KEY (webhook_id) REFERENCES modelry_automation_webhooks(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_automation_event_hooks_by_collection ON modelry_automation_event_hooks(collection_id,event_type,enabled)`,
	`CREATE TABLE IF NOT EXISTS modelry_automation_jobs (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL,
		webhook_id TEXT NOT NULL,
		cron TEXT NOT NULL,
		enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
		next_run_at TEXT NOT NULL,
		last_run_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (webhook_id) REFERENCES modelry_automation_webhooks(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_automation_jobs_due ON modelry_automation_jobs(enabled,next_run_at)`,
	`CREATE TABLE IF NOT EXISTS modelry_automation_deliveries (
		ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		source_type TEXT NOT NULL CHECK (source_type IN ('eventHook','job','test')),
		source_id TEXT NOT NULL,
		webhook_id TEXT NOT NULL,
		webhook_revision INTEGER NOT NULL CHECK (webhook_revision >= 1),
		event_id TEXT,
		event_type TEXT NOT NULL,
		source_slot TEXT,
		status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
		created_at TEXT NOT NULL,
		next_attempt_at TEXT,
		completed_at TEXT,
		attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 32),
		manual_redrive_count INTEGER NOT NULL DEFAULT 0 CHECK (manual_redrive_count BETWEEN 0 AND 3),
		last_http_status INTEGER,
		error_code TEXT NOT NULL DEFAULT 'none',
		payload BLOB,
		FOREIGN KEY (webhook_id) REFERENCES modelry_automation_webhooks(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_automation_deliveries_pending ON modelry_automation_deliveries(status,next_attempt_at,created_at)`,
	`CREATE INDEX IF NOT EXISTS modelry_automation_deliveries_by_webhook ON modelry_automation_deliveries(webhook_id,status)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS modelry_automation_job_delivery_slot ON modelry_automation_deliveries(source_type,source_id,source_slot) WHERE source_type='job' AND source_slot IS NOT NULL`,
	`CREATE TABLE IF NOT EXISTS modelry_automation_delivery_rounds (
		delivery_id TEXT NOT NULL,
		round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 4),
		webhook_revision INTEGER NOT NULL CHECK (webhook_revision >= 1),
		target_url TEXT NOT NULL,
		secret_id TEXT NOT NULL,
		attempts_started INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started BETWEEN 0 AND 8),
		created_at TEXT NOT NULL,
		PRIMARY KEY (delivery_id,round),
		FOREIGN KEY (delivery_id) REFERENCES modelry_automation_deliveries(id) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_automation_delivery_attempts (
		delivery_id TEXT NOT NULL,
		attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 32),
		round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 4),
		webhook_revision INTEGER NOT NULL CHECK (webhook_revision >= 1),
		status TEXT NOT NULL CHECK (status IN ('running','succeeded','retryScheduled','rejected','failed','interrupted','cancelled')),
		started_at TEXT NOT NULL,
		completed_at TEXT,
		duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
		http_status INTEGER,
		error_code TEXT NOT NULL DEFAULT 'none',
		PRIMARY KEY (delivery_id,attempt),
		FOREIGN KEY (delivery_id,round) REFERENCES modelry_automation_delivery_rounds(delivery_id,round) ON DELETE CASCADE
	)`,
}

func (service *Service) Start(parent context.Context) error {
	if parent == nil {
		parent = context.Background()
	}
	service.mu.Lock()
	if service.closed || service.started {
		service.mu.Unlock()
		return errors.New("Automation Runtime can only be started once")
	}
	service.started = true
	runCtx, cancel := context.WithCancel(parent)
	service.runCancel = cancel
	service.runDone = make(chan struct{})
	done := service.runDone
	service.mu.Unlock()
	var workers sync.WaitGroup
	workers.Add(5)
	for index := 0; index < 4; index++ {
		go func() {
			defer workers.Done()
			service.workerLoop(runCtx)
		}()
	}
	go func() {
		defer workers.Done()
		service.schedulerLoop(runCtx)
	}()
	go func() {
		workers.Wait()
		close(done)
	}()
	service.signal()
	return nil
}

func (service *Service) Close(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	service.mu.Lock()
	service.closed = true
	if service.runCancel != nil {
		service.runCancel()
	}
	for _, active := range service.active {
		active.cancel()
	}
	done := service.runDone
	service.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (service *Service) CreateWebhook(ctx context.Context, input WebhookInput) (Webhook, error) {
	input.Name = strings.TrimSpace(input.Name)
	if err := validateName(input.Name, "/name"); err != nil {
		return Webhook{}, err
	}
	targetURL, err := validateTargetURL(input.TargetURL)
	if err != nil {
		return Webhook{}, err
	}
	input.TargetURL = targetURL
	if input.SigningSecretID == "" {
		return Webhook{}, invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret.")
	}
	id, err := newResourceID("whk_")
	if err != nil {
		return Webhook{}, err
	}
	now := service.now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	secretName := ""
	if err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_webhooks`).Scan(&count); err != nil {
			return err
		}
		if count >= maximumWebhooks {
			return invalidField("/name", "tooManyWebhooks", "A Project can have at most 32 Webhooks.")
		}
		var configured int
		if err := tx.QueryRowContext(ctx, `SELECT name,length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, input.SigningSecretID).Scan(&secretName, &configured); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret.")
		} else if err != nil {
			return err
		} else if configured != 1 {
			return invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret.")
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_webhooks(id,name,target_url,signing_secret_id,enabled,revision,created_at,updated_at) VALUES(?,?,?,?,0,1,?,?)`, id, input.Name, input.TargetURL, input.SigningSecretID, stamp, stamp)
		return err
	}); err != nil {
		return Webhook{}, err
	}
	return Webhook{
		ID: id, Name: input.Name, TargetURL: input.TargetURL, SigningSecretID: input.SigningSecretID,
		SigningSecretName: secretName, SigningConfigured: true, Revision: 1, CreatedAt: now, UpdatedAt: now,
	}, nil
}

func (service *Service) GetWebhook(ctx context.Context, webhookID string) (Webhook, error) {
	var webhook Webhook
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var enabled, configured int
		var created, updated string
		err := snapshot.QueryRowContext(ctx, `SELECT w.id,w.name,w.target_url,w.signing_secret_id,w.enabled,w.revision,w.created_at,w.updated_at,COALESCE(s.name,''),COALESCE(length(s.value_cipher)>0,0)
			FROM modelry_automation_webhooks w LEFT JOIN modelry_secrets s ON s.id=w.signing_secret_id WHERE w.id=?`, webhookID).
			Scan(&webhook.ID, &webhook.Name, &webhook.TargetURL, &webhook.SigningSecretID, &enabled, &webhook.Revision, &created, &updated, &webhook.SigningSecretName, &configured)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		webhook.Enabled = enabled == 1
		webhook.SigningConfigured = configured == 1
		webhook.CreatedAt = parseTime(created)
		webhook.UpdatedAt = parseTime(updated)
		return nil
	})
	return webhook, err
}

func (service *Service) ListWebhooks(ctx context.Context) ([]Webhook, error) {
	items := make([]Webhook, 0)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT w.id,w.name,w.target_url,w.signing_secret_id,w.enabled,w.revision,w.created_at,w.updated_at,COALESCE(s.name,''),COALESCE(length(s.value_cipher)>0,0)
			FROM modelry_automation_webhooks w LEFT JOIN modelry_secrets s ON s.id=w.signing_secret_id ORDER BY w.updated_at DESC,w.id LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Webhook
			var enabled, configured int
			var created, updated string
			if err := rows.Scan(&item.ID, &item.Name, &item.TargetURL, &item.SigningSecretID, &enabled, &item.Revision, &created, &updated, &item.SigningSecretName, &configured); err != nil {
				return err
			}
			item.Enabled = enabled == 1
			item.SigningConfigured = configured == 1
			item.CreatedAt = parseTime(created)
			item.UpdatedAt = parseTime(updated)
			items = append(items, item)
		}
		return rows.Err()
	})
	return items, err
}

func validateName(value, path string) error {
	if !utf8.ValidString(value) || len([]rune(value)) == 0 || len([]rune(value)) > 120 {
		return invalidField(path, "invalidName", "Enter a name between 1 and 120 characters.")
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return invalidField(path, "invalidName", "Names cannot contain control characters.")
		}
	}
	return nil
}

func validateTargetURL(value string) (string, error) {
	if len(value) > 2048 || !utf8.ValidString(value) {
		return "", invalidField("/targetUrl", "invalidWebhookUrl", "Enter an HTTPS URL with a DNS hostname and path only.")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.Opaque != "" || !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil ||
		parsed.Host == "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" ||
		strings.ContainsAny(value, "\r\n\t") {
		return "", invalidField("/targetUrl", "invalidWebhookUrl", "Enter an HTTPS URL with a DNS hostname and path only.")
	}
	host := parsed.Hostname()
	if host == "" || net.ParseIP(host) != nil || strings.Contains(host, "*") {
		return "", invalidField("/targetUrl", "invalidWebhookUrl", "Enter an HTTPS URL with a DNS hostname and path only.")
	}
	origin, err := safehttp.NormalizeOrigin("https://" + parsed.Host)
	if err != nil {
		return "", invalidField("/targetUrl", "invalidWebhookUrl", "Enter an HTTPS URL with a DNS hostname and path only.")
	}
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	return origin + path, nil
}

func newResourceID(prefix string) (string, error) {
	value := make([]byte, 18)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("create automation identity: %w", err)
	}
	return prefix + hex.EncodeToString(value), nil
}

func parseTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}
