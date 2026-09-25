package extensions

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/extensions/secretstore"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrInvalidArgument      = errors.New("invalid Extension argument")
	ErrNotFound             = errors.New("Extension resource not found")
	ErrConflict             = errors.New("Extension resource conflict")
	ErrBindingConflict      = errors.New("Extension Binding conflict")
	ErrValidation           = errors.New("Extension validation failed")
	ErrSecretKeyUnavailable = errors.New("Secret key unavailable")
	ErrSecretNotAvailable   = errors.New("Secret not available")

	namePattern  = regexp.MustCompile(`^[^\x00-\x1f\x7f]{1,128}$`)
	aliasPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
)

const maxBindingsPerExtension = 18

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type ServiceOptions struct {
	ManagedDir  string
	ProjectID   string
	Invoker     Invoker
	HTTPRequest HTTPRequest
}

// SecretRevocationObserver 将其他 Project 资源加入 Secret 删除事务，并在提交后取消相关外部任务。
type SecretRevocationObserver interface {
	RevokeSecretInTransaction(context.Context, storage.Executor, string) error
	SecretRevoked(string)
}

type Service struct {
	store                    transactionalStore
	models                   *backendmodel.Service
	secrets                  *secretstore.Store
	invoker                  Invoker
	httpRequest              HTTPRequest
	now                      func() time.Time
	ctx                      context.Context
	cancel                   context.CancelFunc
	semaphore                chan struct{}
	mu                       sync.Mutex
	cancels                  map[string]activeRun
	closed                   bool
	wg                       sync.WaitGroup
	secretRevocationObserver SecretRevocationObserver
}

type activeRun struct {
	cancel         context.CancelFunc
	extensionID    string
	bindingID      string
	secretBindings []SecretBindingInput
	secretIDs      []string
	grantIDs       []string
}

func NewService(ctx context.Context, store transactionalStore, models *backendmodel.Service, options ServiceOptions) (*Service, error) {
	if store == nil || models == nil || options.ManagedDir == "" || options.ProjectID == "" {
		return nil, fmt.Errorf("%w: storage, Applied Model, managed directory and Project ID are required", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	secretManager, err := secretstore.New(options.ManagedDir, options.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Extension Secret storage: %w", err)
	}
	serviceCtx, cancel := context.WithCancel(context.Background())
	service := &Service{
		store: store, models: models, secrets: secretManager,
		invoker: options.Invoker, httpRequest: options.HTTPRequest, now: func() time.Time { return time.Now().UTC() },
		ctx: serviceCtx, cancel: cancel, semaphore: make(chan struct{}, 4), cancels: make(map[string]activeRun),
	}
	if err := service.initialize(ctx); err != nil {
		cancel()
		return nil, err
	}
	return service, nil
}

func (service *Service) initialize(ctx context.Context) error {
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range extensionSchema {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize Extension storage: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET error_code='none' WHERE error_code=''`); err != nil {
			return fmt.Errorf("normalize Extension Run error categories: %w", err)
		}
		if err := ensureSecretNameKey(ctx, tx); err != nil {
			return fmt.Errorf("initialize normalized Secret names: %w", err)
		}
		return service.interruptPending(ctx, tx)
	})
}

var extensionSchema = []string{
	`CREATE TABLE IF NOT EXISTS modelry_extensions (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL COLLATE NOCASE UNIQUE,
		language TEXT NOT NULL CHECK (language IN ('javascript', 'typescript')),
		active_revision INTEGER NOT NULL CHECK (active_revision >= 1),
		enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_extension_revisions (
		extension_id TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision >= 1),
		language TEXT NOT NULL CHECK (language IN ('javascript', 'typescript')),
		source TEXT NOT NULL,
		compiled_source TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (extension_id, revision),
		FOREIGN KEY (extension_id) REFERENCES modelry_extensions(id) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_extension_bindings (
		id TEXT PRIMARY KEY NOT NULL,
		extension_id TEXT NOT NULL,
		collection_id TEXT NOT NULL,
		operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
		phase TEXT NOT NULL CHECK (phase IN ('before', 'afterCommit')),
		UNIQUE (extension_id, collection_id, operation, phase),
		FOREIGN KEY (extension_id) REFERENCES modelry_extensions(id) ON DELETE CASCADE,
		FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_extension_bindings_slot ON modelry_extension_bindings(collection_id, operation, phase)`,
	`CREATE TABLE IF NOT EXISTS modelry_secrets (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL COLLATE NOCASE UNIQUE,
		name_key TEXT NOT NULL,
		value_cipher BLOB NOT NULL,
		version INTEGER NOT NULL CHECK (version >= 1),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_extension_secret_bindings (
		extension_id TEXT NOT NULL,
		alias TEXT NOT NULL,
		secret_id TEXT NOT NULL,
		PRIMARY KEY (extension_id, alias),
		FOREIGN KEY (extension_id) REFERENCES modelry_extensions(id) ON DELETE CASCADE,
		FOREIGN KEY (secret_id) REFERENCES modelry_secrets(id) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_extension_origin_grants (
		id TEXT PRIMARY KEY NOT NULL,
		extension_id TEXT NOT NULL,
		origin TEXT NOT NULL,
		UNIQUE (extension_id, origin),
		FOREIGN KEY (extension_id) REFERENCES modelry_extensions(id) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_extension_intents (
		id TEXT PRIMARY KEY NOT NULL,
		extension_id TEXT NOT NULL,
		revision INTEGER NOT NULL,
		binding_id TEXT NOT NULL,
		collection_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		event_id TEXT NOT NULL UNIQUE,
		operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
		schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
		secret_bindings_json TEXT NOT NULL,
		origin_grants_json TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_extension_intents_pending ON modelry_extension_intents(status, created_at)`,
	`CREATE TABLE IF NOT EXISTS modelry_extension_runs (
		id TEXT PRIMARY KEY NOT NULL,
		intent_id TEXT,
		extension_id TEXT NOT NULL,
		revision INTEGER NOT NULL,
		binding_id TEXT NOT NULL,
		collection_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		event_id TEXT NOT NULL,
		operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
		phase TEXT NOT NULL CHECK (phase IN ('before', 'afterCommit')),
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'rejected', 'failed', 'interrupted', 'cancelled')),
		started_at TEXT NOT NULL,
		completed_at TEXT,
		duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
		error_code TEXT NOT NULL,
		correlation_id TEXT NOT NULL,
		FOREIGN KEY (extension_id) REFERENCES modelry_extensions(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_extension_runs_by_extension ON modelry_extension_runs(extension_id, started_at DESC, id DESC)`,
}

func (service *Service) LifecycleHooks() recordlifecycle.Hooks { return service }

func (service *Service) SetSecretRevocationObserver(observer SecretRevocationObserver) {
	service.mu.Lock()
	service.secretRevocationObserver = observer
	service.mu.Unlock()
}

func (service *Service) currentSecretRevocationObserver() SecretRevocationObserver {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.secretRevocationObserver
}

func (service *Service) Close(ctx context.Context) error {
	if service == nil {
		return nil
	}
	service.mu.Lock()
	if !service.closed {
		service.closed = true
		service.cancel()
		for _, active := range service.cancels {
			active.cancel()
		}
	}
	service.mu.Unlock()
	done := make(chan struct{})
	go func() { service.wg.Wait(); close(done) }()
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (service *Service) List(ctx context.Context) ([]Summary, error) {
	page := make([]Summary, 0)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT e.id, e.name, e.language, e.active_revision, e.enabled, e.created_at, e.updated_at,
			(SELECT COUNT(*) FROM modelry_extension_bindings b WHERE b.extension_id = e.id),
			(SELECT COUNT(*) FROM modelry_extension_secret_bindings s WHERE s.extension_id = e.id),
			(SELECT COUNT(*) FROM modelry_extension_origin_grants g WHERE g.extension_id = e.id)
			FROM modelry_extensions e ORDER BY e.updated_at DESC, e.id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanSummary(rows)
			if err != nil {
				return err
			}
			page = append(page, item)
		}
		return rows.Err()
	})
	return page, err
}

func (service *Service) Get(ctx context.Context, extensionID string) (Detail, error) {
	var detail Detail
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		row := snapshot.QueryRowContext(ctx, `SELECT e.id, e.name, e.language, e.active_revision, e.enabled, e.created_at, e.updated_at,
			(SELECT COUNT(*) FROM modelry_extension_bindings b WHERE b.extension_id = e.id),
			(SELECT COUNT(*) FROM modelry_extension_secret_bindings s WHERE s.extension_id = e.id),
			(SELECT COUNT(*) FROM modelry_extension_origin_grants g WHERE g.extension_id = e.id), r.source
			FROM modelry_extensions e JOIN modelry_extension_revisions r ON r.extension_id=e.id AND r.revision=e.active_revision WHERE e.id=?`, extensionID)
		var err error
		detail.Summary, err = scanSummaryWithSource(row, &detail.Source)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		detail.CreatedAt = detail.Summary.CreatedAt
		detail.Bindings = make([]Binding, 0)
		rows, err := snapshot.QueryContext(ctx, `SELECT collection_id, operation, phase FROM modelry_extension_bindings WHERE extension_id=? ORDER BY collection_id, operation, phase`, extensionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var binding Binding
			if err := rows.Scan(&binding.CollectionID, &binding.Operation, &binding.Phase); err != nil {
				rows.Close()
				return err
			}
			detail.Bindings = append(detail.Bindings, binding)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		detail.SecretBindings = make([]SecretBinding, 0)
		rows, err = snapshot.QueryContext(ctx, `SELECT b.alias,s.id,s.name,1 FROM modelry_extension_secret_bindings b JOIN modelry_secrets s ON s.id=b.secret_id WHERE b.extension_id=? ORDER BY b.alias`, extensionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var binding SecretBinding
			var configured int
			if err := rows.Scan(&binding.Alias, &binding.SecretID, &binding.SecretName, &configured); err != nil {
				rows.Close()
				return err
			}
			binding.Configured = configured == 1
			detail.SecretBindings = append(detail.SecretBindings, binding)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		detail.AllowedOrigins = make([]string, 0)
		rows, err = snapshot.QueryContext(ctx, `SELECT origin FROM modelry_extension_origin_grants WHERE extension_id=? ORDER BY origin`, extensionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var origin string
			if err := rows.Scan(&origin); err != nil {
				rows.Close()
				return err
			}
			detail.AllowedOrigins = append(detail.AllowedOrigins, origin)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		return rows.Close()
	})
	return detail, err
}

func (service *Service) Create(ctx context.Context, input ConfigInput) (Detail, error) {
	validated, compiled, err := validateConfig(input, false)
	if err != nil {
		return Detail{}, err
	}
	id, err := newID("ext_")
	if err != nil {
		return Detail{}, err
	}
	now := service.timestamp()
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := service.validateConfigInTransaction(ctx, tx, validated, false); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extensions(id,name,language,active_revision,enabled,created_at,updated_at) VALUES(?,?,?,1,0,?,?)`, id, validated.Name, validated.Language, now, now); err != nil {
			return mapWriteError(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_revisions(extension_id,revision,language,source,compiled_source,created_at) VALUES(?,1,?,?,?,?)`, id, validated.Language, validated.Source, compiled, now); err != nil {
			return err
		}
		return service.replaceConfigurationRows(ctx, tx, id, validated)
	})
	if err != nil {
		return Detail{}, err
	}
	return service.Get(ctx, id)
}

func (service *Service) Replace(ctx context.Context, extensionID string, input ConfigInput) (Detail, error) {
	validated, compiled, err := validateConfig(input, true)
	if err != nil {
		return Detail{}, err
	}
	var enabled bool
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var currentLanguage string
		var currentSource string
		var revision int64
		if err := tx.QueryRowContext(ctx, `SELECT e.enabled,e.language,e.active_revision,r.source FROM modelry_extensions e JOIN modelry_extension_revisions r ON r.extension_id=e.id AND r.revision=e.active_revision WHERE e.id=?`, extensionID).Scan(&enabled, &currentLanguage, &revision, &currentSource); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if err := service.validateConfigInTransaction(ctx, tx, validated, enabled); err != nil {
			return err
		}
		if enabled {
			if err := service.ensureSlotsFree(ctx, tx, extensionID, validated.Bindings); err != nil {
				return err
			}
		}
		now := service.timestamp()
		language := string(validated.Language)
		if language != currentLanguage || validated.Source != currentSource {
			revision++
			if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_revisions(extension_id,revision,language,source,compiled_source,created_at) VALUES(?,?,?,?,?,?)`, extensionID, revision, language, validated.Source, compiled, now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_extensions SET language=?,active_revision=? WHERE id=?`, language, revision, extensionID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_extensions SET name=?,updated_at=? WHERE id=?`, validated.Name, now, extensionID); err != nil {
			return mapWriteError(err)
		}
		if err := service.replaceConfigurationRows(ctx, tx, extensionID, validated); err != nil {
			return err
		}
		return service.cancelRemovedPending(ctx, tx, extensionID)
	})
	if err != nil {
		return Detail{}, err
	}
	service.cancelIncompatibleActive(extensionID)
	return service.Get(ctx, extensionID)
}

func (service *Service) Enable(ctx context.Context, extensionID string) (bool, error) {
	var enabled bool
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		bindings, err := readBindings(ctx, tx, extensionID)
		if err != nil {
			return err
		}
		if err := service.validateConfigInTransaction(ctx, tx, ConfigInput{Bindings: bindings}, true); err != nil {
			return err
		}
		if err := service.ensureSlotsFree(ctx, tx, extensionID, bindings); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE modelry_extensions SET enabled=1,updated_at=? WHERE id=?`, service.timestamp(), extensionID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		enabled = true
		return nil
	})
	return enabled, err
}

func (service *Service) Disable(ctx context.Context, extensionID string) (bool, error) {
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_extensions SET enabled=0,updated_at=? WHERE id=?`, service.timestamp(), extensionID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		_, err = tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='cancelled',updated_at=? WHERE extension_id=? AND status='pending'`, service.timestamp(), extensionID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status='cancelled',completed_at=?,error_code='extensionDisabled' WHERE extension_id=? AND phase='afterCommit' AND status='pending'`, service.timestamp(), extensionID)
		return err
	})
	if err == nil {
		service.cancelActive(extensionID, "", "")
	}
	return false, err
}

func (service *Service) ListRuns(ctx context.Context, extensionID string, options RunListOptions) (RunPage, error) {
	limit := options.Limit
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 100 {
		return RunPage{}, ErrInvalidArgument
	}
	afterTime, afterID := "", ""
	if options.Cursor != "" {
		var err error
		afterTime, afterID, err = decodeRunCursor(options.Cursor)
		if err != nil {
			return RunPage{}, err
		}
	}
	page := RunPage{Data: make([]Run, 0, limit)}
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var exists int
		if err := snapshot.QueryRowContext(ctx, `SELECT 1 FROM modelry_extensions WHERE id=?`, extensionID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		query := `SELECT id,extension_id,revision,collection_id,record_id,event_id,operation,phase,status,started_at,completed_at,duration_ms,error_code,correlation_id FROM modelry_extension_runs WHERE extension_id=?`
		args := []any{extensionID}
		if afterID != "" {
			query += ` AND (started_at < ? OR (started_at = ? AND id < ?))`
			args = append(args, afterTime, afterTime, afterID)
		}
		query += ` ORDER BY started_at DESC,id DESC LIMIT ?`
		args = append(args, limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			run, err := scanRun(rows)
			if err != nil {
				return err
			}
			page.Data = append(page.Data, run)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(page.Data) > limit {
			last := page.Data[limit-1]
			page.NextCursor = encodeRunCursor(last.StartedAt.Format(time.RFC3339Nano), last.RunID)
			page.Data = page.Data[:limit]
		}
		return nil
	})
	return page, err
}

func (service *Service) GetRun(ctx context.Context, extensionID, runID string) (Run, error) {
	var run Run
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var err error
		run, err = scanRun(snapshot.QueryRowContext(ctx, `SELECT id,extension_id,revision,collection_id,record_id,event_id,operation,phase,status,started_at,completed_at,duration_ms,error_code,correlation_id FROM modelry_extension_runs WHERE extension_id=? AND id=?`, extensionID, runID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	})
	return run, err
}

func (service *Service) timestamp() string { return service.now().UTC().Format(time.RFC3339Nano) }

func newID(prefix string) (string, error) {
	var b [18]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b[:]), nil
}

func mapWriteError(err error) error {
	if err == nil {
		return nil
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "unique constraint") || strings.Contains(text, "constraint failed") {
		return ErrConflict
	}
	return err
}

func validateConfig(input ConfigInput, includeBindings bool) (ConfigInput, string, error) {
	input.Name = strings.TrimSpace(input.Name)
	if !utf8.ValidString(input.Name) || !namePattern.MatchString(input.Name) {
		return ConfigInput{}, "", invalidField("/name", "invalidName", "Enter a name between 1 and 128 characters without control characters.")
	}
	if strings.TrimSpace(input.Source) == "" {
		return ConfigInput{}, "", invalidField("/source", "required", "Extension source is required.")
	}
	if input.Language != LanguageJavaScript && input.Language != LanguageTypeScript {
		return ConfigInput{}, "", invalidField("/language", "unsupportedLanguage", "Choose JavaScript or TypeScript.")
	}
	compiled, err := CompileSource(input.Language, input.Source)
	if err != nil {
		return ConfigInput{}, "", invalidField("/source", "invalidSource", "Extension source could not be validated.")
	}
	if !includeBindings {
		input.Bindings = nil
		input.SecretBindings = nil
		input.AllowedOrigins = nil
		return input, compiled, nil
	}
	if len(input.Bindings) > maxBindingsPerExtension {
		return ConfigInput{}, "", invalidField("/bindings", "tooManyBindings", "Use no more than 18 bindings for one Extension.")
	}
	seenSlots := make(map[string]struct{}, len(input.Bindings))
	for index, binding := range input.Bindings {
		if binding.CollectionID == "" || len(binding.CollectionID) > 128 {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/bindings/%d/collectionId", index), "invalidCollection", "Choose an available Collection.")
		}
		if binding.Operation != OperationCreate && binding.Operation != OperationUpdate && binding.Operation != OperationDelete {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/bindings/%d/operation", index), "invalidOperation", "Choose a supported Record operation.")
		}
		if binding.Phase != PhaseBefore && binding.Phase != PhaseAfterCommit {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/bindings/%d/phase", index), "invalidPhase", "Choose a supported Hook phase.")
		}
		key := string(binding.Operation) + "\x00" + string(binding.Phase) + "\x00" + binding.CollectionID
		if _, ok := seenSlots[key]; ok {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/bindings/%d", index), "duplicateBinding", "A Collection, operation, and phase can appear only once.")
		}
		seenSlots[key] = struct{}{}
	}
	seenAliases := map[string]struct{}{}
	for index, binding := range input.SecretBindings {
		if !aliasPattern.MatchString(binding.Alias) {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/secretBindings/%d/alias", index), "invalidAlias", "Use a letter first, then letters, numbers, or underscores.")
		}
		if binding.SecretID == "" || len(binding.SecretID) > 128 {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/secretBindings/%d/secretId", index), "invalidSecretReference", "Choose an available Project Secret.")
		}
		if _, ok := seenAliases[binding.Alias]; ok {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/secretBindings/%d/alias", index), "duplicateAlias", "Each Secret alias must be unique within this Extension.")
		}
		seenAliases[binding.Alias] = struct{}{}
	}
	if len(input.AllowedOrigins) > 32 {
		return ConfigInput{}, "", invalidField("/allowedOrigins", "tooManyOrigins", "Use no more than 32 HTTPS origins.")
	}
	seenOrigins := map[string]struct{}{}
	for i, origin := range input.AllowedOrigins {
		normalized, err := normalizeOrigin(origin)
		if err != nil {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/allowedOrigins/%d", i), "invalidOrigin", "Enter an exact HTTPS origin without a path, query, fragment, or credentials.")
		}
		if _, ok := seenOrigins[normalized]; ok {
			return ConfigInput{}, "", invalidField(fmt.Sprintf("/allowedOrigins/%d", i), "duplicateOrigin", "Each HTTPS origin must be unique.")
		}
		seenOrigins[normalized] = struct{}{}
		input.AllowedOrigins[i] = normalized
	}
	sort.Strings(input.AllowedOrigins)
	return input, compiled, nil
}

func normalizeOrigin(raw string) (string, error) {
	normalized, err := safehttp.NormalizeOrigin(raw)
	if err != nil {
		return "", ErrValidation
	}
	return normalized, nil
}

func (service *Service) validateConfigInTransaction(ctx context.Context, tx storage.Executor, input ConfigInput, requireSecrets bool) error {
	for index, binding := range input.Bindings {
		var raw string
		if err := tx.QueryRowContext(ctx, `SELECT model_json FROM modelry_backend_collections WHERE id=?`, binding.CollectionID).Scan(&raw); errors.Is(err, sql.ErrNoRows) {
			return invalidField(fmt.Sprintf("/bindings/%d/collectionId", index), "invalidCollection", "Choose an available Collection.")
		} else if err != nil {
			return err
		}
		var collection backendmodel.Collection
		if err := json.Unmarshal([]byte(raw), &collection); err != nil {
			return fmt.Errorf("decode Collection model for Extension validation: %w", err)
		}
		if collection.Type == backendmodel.CollectionTypeAuth && binding.Operation != OperationCreate {
			return invalidField(fmt.Sprintf("/bindings/%d/operation", index), "unsupportedOperation", "Auth Collections support create bindings only.")
		}
	}
	if requireSecrets {
		for index, binding := range input.SecretBindings {
			var found int
			if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_secrets WHERE id=?`, binding.SecretID).Scan(&found); errors.Is(err, sql.ErrNoRows) {
				return invalidField(fmt.Sprintf("/secretBindings/%d/secretId", index), "invalidSecretReference", "Choose an available Project Secret.")
			} else if err != nil {
				return err
			}
		}
	}
	return nil
}

func (service *Service) ensureSlotsFree(ctx context.Context, tx storage.Executor, extensionID string, bindings []Binding) error {
	for _, binding := range bindings {
		var owner string
		err := tx.QueryRowContext(ctx, `SELECT extension_id FROM modelry_extension_bindings b JOIN modelry_extensions e ON e.id=b.extension_id WHERE e.enabled=1 AND b.collection_id=? AND b.operation=? AND b.phase=? AND b.extension_id<>?`, binding.CollectionID, binding.Operation, binding.Phase, extensionID).Scan(&owner)
		if err == nil {
			return &BindingConflictError{CollectionID: binding.CollectionID, Operation: binding.Operation, Phase: binding.Phase}
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	return nil
}

func (service *Service) replaceConfigurationRows(ctx context.Context, tx storage.Executor, extensionID string, input ConfigInput) error {
	oldBindings := map[string]string{}
	rows, err := tx.QueryContext(ctx, `SELECT id,collection_id,operation,phase FROM modelry_extension_bindings WHERE extension_id=?`, extensionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, collection, operation, phase string
		if err := rows.Scan(&id, &collection, &operation, &phase); err != nil {
			rows.Close()
			return err
		}
		oldBindings[slotKey(Binding{CollectionID: collection, Operation: Operation(operation), Phase: Phase(phase)})] = id
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	oldOrigins := map[string]string{}
	rows, err = tx.QueryContext(ctx, `SELECT id,origin FROM modelry_extension_origin_grants WHERE extension_id=?`, extensionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, origin string
		if err := rows.Scan(&id, &origin); err != nil {
			rows.Close()
			return err
		}
		oldOrigins[origin] = id
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_extension_bindings WHERE extension_id=?`, extensionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_extension_secret_bindings WHERE extension_id=?`, extensionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_extension_origin_grants WHERE extension_id=?`, extensionID); err != nil {
		return err
	}
	for _, binding := range input.Bindings {
		id := oldBindings[slotKey(binding)]
		if id == "" {
			id, err = newID("bnd_")
			if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_bindings(id,extension_id,collection_id,operation,phase) VALUES(?,?,?,?,?)`, id, extensionID, binding.CollectionID, binding.Operation, binding.Phase); err != nil {
			return mapWriteError(err)
		}
	}
	for _, binding := range input.SecretBindings {
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_secret_bindings(extension_id,alias,secret_id) VALUES(?,?,?)`, extensionID, binding.Alias, binding.SecretID); err != nil {
			return mapWriteError(err)
		}
	}
	for _, origin := range input.AllowedOrigins {
		id := oldOrigins[origin]
		if id == "" {
			id, err = newID("org_")
			if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_origin_grants(id,extension_id,origin) VALUES(?,?,?)`, id, extensionID, origin); err != nil {
			return err
		}
	}
	return nil
}

func slotKey(binding Binding) string {
	return binding.CollectionID + "\x00" + string(binding.Operation) + "\x00" + string(binding.Phase)
}

func readBindings(ctx context.Context, tx storage.Executor, extensionID string) ([]Binding, error) {
	rows, err := tx.QueryContext(ctx, `SELECT collection_id,operation,phase FROM modelry_extension_bindings WHERE extension_id=? ORDER BY collection_id,operation,phase`, extensionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Binding, 0)
	for rows.Next() {
		var b Binding
		if err := rows.Scan(&b.CollectionID, &b.Operation, &b.Phase); err != nil {
			return nil, err
		}
		result = append(result, b)
	}
	return result, rows.Err()
}

func (service *Service) cancelRemovedPending(ctx context.Context, tx storage.Executor, extensionID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT i.id,i.binding_id,i.secret_bindings_json,i.origin_grants_json FROM modelry_extension_intents i WHERE i.extension_id=? AND i.status='pending'`, extensionID)
	if err != nil {
		return err
	}
	type item struct{ id, binding, secrets, origins string }
	pending := []item{}
	for rows.Next() {
		var x item
		if err := rows.Scan(&x.id, &x.binding, &x.secrets, &x.origins); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, x)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, intent := range pending {
		var binding int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_extension_bindings WHERE id=? AND extension_id=?`, intent.binding, extensionID).Scan(&binding)
		cancelled := errors.Is(err, sql.ErrNoRows)
		if err != nil && !cancelled {
			return err
		}
		var secrets []SecretBindingInput
		if json.Unmarshal([]byte(intent.secrets), &secrets) != nil {
			return ErrValidation
		}
		for _, pin := range secrets {
			var id string
			err := tx.QueryRowContext(ctx, `SELECT secret_id FROM modelry_extension_secret_bindings WHERE extension_id=? AND alias=?`, extensionID, pin.Alias).Scan(&id)
			if errors.Is(err, sql.ErrNoRows) || id != pin.SecretID {
				cancelled = true
			} else if err != nil {
				return err
			}
		}
		var grants []string
		if json.Unmarshal([]byte(intent.origins), &grants) != nil {
			return ErrValidation
		}
		for _, id := range grants {
			var exists int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_extension_origin_grants WHERE id=? AND extension_id=?`, id, extensionID).Scan(&exists)
			if errors.Is(err, sql.ErrNoRows) {
				cancelled = true
			} else if err != nil {
				return err
			}
		}
		if cancelled {
			if err := service.cancelIntentInTransaction(ctx, tx, intent.id, "bindingOrGrantRevoked"); err != nil {
				return err
			}
		}
	}
	return nil
}

func (service *Service) cancelRemovedActive(extensionID, secretID, grantID string) {
	service.mu.Lock()
	defer service.mu.Unlock()
	for id, active := range service.cancels {
		if (extensionID != "" && active.extensionID == extensionID) || (secretID != "" && contains(active.secretIDs, secretID)) || (grantID != "" && contains(active.grantIDs, grantID)) {
			active.cancel()
			delete(service.cancels, id)
		}
	}
}

func (service *Service) cancelIncompatibleActive(extensionID string) {
	ctx, cancel := context.WithTimeout(service.ctx, time.Second)
	defer cancel()
	bindings := map[string]struct{}{}
	secrets := map[string]string{}
	grants := map[string]struct{}{}
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		for _, item := range []struct {
			query  string
			target map[string]struct{}
		}{
			{`SELECT id FROM modelry_extension_bindings WHERE extension_id=?`, bindings},
			{`SELECT id FROM modelry_extension_origin_grants WHERE extension_id=?`, grants},
		} {
			rows, err := snapshot.QueryContext(ctx, item.query, extensionID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				item.target[id] = struct{}{}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			if err := rows.Close(); err != nil {
				return err
			}
		}
		rows, err := snapshot.QueryContext(ctx, `SELECT alias,secret_id FROM modelry_extension_secret_bindings WHERE extension_id=?`, extensionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var alias, id string
			if err := rows.Scan(&alias, &id); err != nil {
				return err
			}
			secrets[alias] = id
		}
		return rows.Err()
	})
	if err != nil {
		// 配置已经持久化，无法确认活动调用使用的授权是否仍有效时，取消该扩展的全部活动调用。
		service.cancelRemovedActive(extensionID, "", "")
		return
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	for id, active := range service.cancels {
		if active.extensionID != extensionID {
			continue
		}
		_, bindingExists := bindings[active.bindingID]
		cancelled := !bindingExists
		for _, pin := range active.secretBindings {
			if secrets[pin.Alias] != pin.SecretID {
				cancelled = true
			}
		}
		for _, grantID := range active.grantIDs {
			if _, exists := grants[grantID]; !exists {
				cancelled = true
			}
		}
		if cancelled {
			active.cancel()
			delete(service.cancels, id)
		}
	}
}
func (service *Service) cancelActive(extensionID, secretID, grantID string) {
	service.cancelRemovedActive(extensionID, secretID, grantID)
}
func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func scanSummary(row interface{ Scan(...any) error }) (Summary, error) {
	var item Summary
	var language string
	var enabled int
	var created, updated string
	if err := row.Scan(&item.ID, &item.Name, &language, &item.ActiveRevision, &enabled, &created, &updated, &item.BindingCount, &item.SecretBindingCount, &item.OriginGrantCount); err != nil {
		return Summary{}, err
	}
	item.Language = Language(language)
	item.Enabled = enabled == 1
	item.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	item.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	return item, nil
}
func scanSummaryWithSource(row interface{ Scan(...any) error }, source *string) (Summary, error) {
	var item Summary
	var language string
	var enabled int
	var created, updated string
	if err := row.Scan(&item.ID, &item.Name, &language, &item.ActiveRevision, &enabled, &created, &updated, &item.BindingCount, &item.SecretBindingCount, &item.OriginGrantCount, source); err != nil {
		return Summary{}, err
	}
	item.Language = Language(language)
	item.Enabled = enabled == 1
	item.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	item.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	return item, nil
}
func scanRun(row interface{ Scan(...any) error }) (Run, error) {
	var run Run
	var operation, phase, status, started string
	var completed sql.NullString
	if err := row.Scan(&run.RunID, &run.ExtensionID, &run.Revision, &run.CollectionID, &run.RecordID, &run.EventID, &operation, &phase, &status, &started, &completed, &run.DurationMS, &run.ErrorCode, &run.CorrelationID); err != nil {
		return Run{}, err
	}
	run.Operation = Operation(operation)
	run.Phase = Phase(phase)
	run.Status = RunStatus(status)
	run.StartedAt, _ = time.Parse(time.RFC3339Nano, started)
	if completed.Valid {
		parsed, _ := time.Parse(time.RFC3339Nano, completed.String)
		run.CompletedAt = &parsed
	}
	return run, nil
}

func encodeRunCursor(timestamp, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(timestamp + "\n" + id))
}
func decodeRunCursor(value string) (string, string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", "", ErrInvalidArgument
	}
	parts := strings.Split(string(decoded), "\n")
	if len(parts) != 2 || parts[1] == "" {
		return "", "", ErrInvalidArgument
	}
	if _, err := time.Parse(time.RFC3339Nano, parts[0]); err != nil {
		return "", "", ErrInvalidArgument
	}
	return parts[0], parts[1], nil
}

var _ recordlifecycle.Hooks = (*Service)(nil)
