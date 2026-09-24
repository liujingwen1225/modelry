package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	maxConnections       = 8
	requiredSQLiteMajor  = 3
	requiredSQLiteMinor  = 51
	requiredSQLitePatch  = 3
	connectionOpenWindow = 10 * time.Second
	shutdownCheckpoint   = 5 * time.Second
)

type Store struct {
	db          *sql.DB
	database    string
	sqliteVer   string
	projectID   string
	closeOnce   sync.Once
	closeErr    error
	closedMutex sync.RWMutex
	closed      bool
}

// Executor 仅在当前事务内提供结构化数据访问。
type Executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type ConnectionSettings struct {
	ForeignKeys int64
	BusyTimeout int64
	Synchronous int64
	JournalMode string
}

func Open(databasePath string) (*Store, error) {
	dsn, err := dataSourceName(databasePath, false)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("cannot open SQLite database: %w", err)
	}
	db.SetMaxOpenConns(maxConnections)
	db.SetMaxIdleConns(maxConnections)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)

	store := &Store{db: db, database: databasePath}
	ctx, cancel := context.WithTimeout(context.Background(), connectionOpenWindow)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("cannot connect to the project SQLite database: %w", err)
	}

	version, err := sqliteVersion(ctx, db)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	store.sqliteVer = version
	if !sqliteVersionSupported(version) {
		_ = db.Close()
		return nil, fmt.Errorf("SQLite %s is unsupported; Modelry requires SQLite 3.51.3 or newer for safe WAL operation", version)
	}

	if err := enableWAL(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := verifyConnections(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	projectID, err := initializeStore(ctx, db)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	store.projectID = projectID
	return store, nil
}

func (store *Store) ProjectID() string {
	return store.projectID
}

// WithTransaction 在一个短事务中执行模块操作。
func (store *Store) WithTransaction(ctx context.Context, work func(Executor) error) error {
	if store == nil || store.db == nil || store.IsClosed() {
		return errors.New("SQLite store is not open")
	}
	if work == nil {
		return errors.New("storage transaction callback is required")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("cannot begin project data transaction: %w", err)
	}
	defer tx.Rollback()
	if err := work(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("cannot commit project data transaction: %w", err)
	}
	return nil
}

// WithReadSnapshot 在只读事务中提供一致的数据快照。
func (store *Store) WithReadSnapshot(ctx context.Context, work func(Executor) error) error {
	if store == nil || store.db == nil || store.IsClosed() {
		return errors.New("SQLite store is not open")
	}
	if work == nil {
		return errors.New("storage read callback is required")
	}
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return fmt.Errorf("cannot begin project read snapshot: %w", err)
	}
	defer tx.Rollback()
	if err := work(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("cannot close project read snapshot: %w", err)
	}
	return nil
}

func (store *Store) SQLiteVersion() string {
	return store.sqliteVer
}

func (store *Store) Ping(ctx context.Context) error {
	if store == nil || store.db == nil || store.IsClosed() {
		return errors.New("SQLite store is not open")
	}
	if err := store.db.PingContext(ctx); err != nil {
		return fmt.Errorf("SQLite database is unavailable: %w", err)
	}
	return nil
}

func (store *Store) ConnectionSettings(ctx context.Context) ([]ConnectionSettings, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("SQLite store is not open")
	}
	connections := make([]*sql.Conn, 0, maxConnections)
	for range maxConnections {
		conn, err := store.db.Conn(ctx)
		if err != nil {
			for _, opened := range connections {
				_ = opened.Close()
			}
			return nil, fmt.Errorf("cannot inspect every SQLite connection: %w", err)
		}
		connections = append(connections, conn)
	}
	defer func() {
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()

	settings := make([]ConnectionSettings, 0, len(connections))
	for _, conn := range connections {
		setting, err := readConnectionSettings(ctx, conn)
		if err != nil {
			return nil, err
		}
		settings = append(settings, setting)
	}
	return settings, nil
}

func (store *Store) Close() error {
	if store == nil {
		return nil
	}
	store.closeOnce.Do(func() {
		store.closedMutex.Lock()
		store.closed = true
		store.closedMutex.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), shutdownCheckpoint)
		defer cancel()
		var busy, logFrames, checkpointed int64
		checkpointErr := store.db.QueryRowContext(ctx, "PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &logFrames, &checkpointed)
		if checkpointErr == nil && busy != 0 {
			checkpointErr = fmt.Errorf("SQLite WAL checkpoint remained busy (%d frames, %d checkpointed)", logFrames, checkpointed)
		}
		dbErr := store.db.Close()
		store.closeErr = errors.Join(checkpointErr, dbErr)
	})
	return store.closeErr
}

func (store *Store) IsClosed() bool {
	if store == nil {
		return true
	}
	store.closedMutex.RLock()
	defer store.closedMutex.RUnlock()
	return store.closed
}

func ReadProjectID(databasePath string) (string, error) {
	dsn, err := dataSourceName(databasePath, true)
	if err != nil {
		return "", err
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return "", fmt.Errorf("cannot open project SQLite database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), connectionOpenWindow)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		return "", fmt.Errorf("cannot connect to the project SQLite database: %w", err)
	}
	defer conn.Close()
	settings, err := readConnectionSettings(ctx, conn)
	if err != nil {
		return "", err
	}
	if settings.ForeignKeys != 1 || settings.BusyTimeout != 5000 || settings.Synchronous != 2 || !strings.EqualFold(settings.JournalMode, "wal") {
		return "", fmt.Errorf("project SQLite database has unsupported connection settings: foreign_keys=%d busy_timeout=%d synchronous=%d journal_mode=%s", settings.ForeignKeys, settings.BusyTimeout, settings.Synchronous, settings.JournalMode)
	}
	var projectID string
	if err := conn.QueryRowContext(ctx, "SELECT value FROM modelry_runtime_metadata WHERE key = 'project_id'").Scan(&projectID); err != nil {
		return "", fmt.Errorf("cannot read the durable project ID: %w", err)
	}
	return projectID, nil
}

func dataSourceName(databasePath string, readOnly bool) (string, error) {
	absolutePath, err := filepath.Abs(filepath.Clean(databasePath))
	if err != nil {
		return "", fmt.Errorf("cannot resolve SQLite database path: %w", err)
	}
	uriPath := filepath.ToSlash(absolutePath)
	if filepath.VolumeName(absolutePath) != "" {
		uriPath = "/" + uriPath
	}
	databaseURL := url.URL{Scheme: "file", Path: uriPath}
	query := url.Values{}
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "synchronous(FULL)")
	if readOnly {
		query.Set("mode", "ro")
	}
	databaseURL.RawQuery = query.Encode()
	return databaseURL.String(), nil
}

func sqliteVersion(ctx context.Context, db *sql.DB) (string, error) {
	var version string
	if err := db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version); err != nil {
		return "", fmt.Errorf("cannot read the bundled SQLite version: %w", err)
	}
	return version, nil
}

func sqliteVersionSupported(version string) bool {
	parts := strings.Split(version, ".")
	if len(parts) < 3 {
		return false
	}
	major, errMajor := strconv.Atoi(parts[0])
	minor, errMinor := strconv.Atoi(parts[1])
	patch, errPatch := strconv.Atoi(parts[2])
	if errMajor != nil || errMinor != nil || errPatch != nil {
		return false
	}
	if major != requiredSQLiteMajor {
		return major > requiredSQLiteMajor
	}
	if minor != requiredSQLiteMinor {
		return minor > requiredSQLiteMinor
	}
	return patch >= requiredSQLitePatch
}

func enableWAL(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("cannot acquire SQLite connection for WAL initialization: %w", err)
	}
	defer conn.Close()
	var mode string
	if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		return fmt.Errorf("cannot enable SQLite WAL mode: %w", err)
	}
	if !strings.EqualFold(mode, "wal") {
		return fmt.Errorf("SQLite returned journal mode %q; Modelry requires WAL", mode)
	}
	return nil
}

func verifyConnections(ctx context.Context, db *sql.DB) error {
	connections := make([]*sql.Conn, 0, maxConnections)
	for range maxConnections {
		conn, err := db.Conn(ctx)
		if err != nil {
			for _, opened := range connections {
				_ = opened.Close()
			}
			return fmt.Errorf("cannot initialize all SQLite connections: %w", err)
		}
		connections = append(connections, conn)
	}
	defer func() {
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()
	for index, conn := range connections {
		settings, err := readConnectionSettings(ctx, conn)
		if err != nil {
			return fmt.Errorf("cannot verify SQLite connection %d: %w", index+1, err)
		}
		if settings.ForeignKeys != 1 || settings.BusyTimeout != 5000 || settings.Synchronous != 2 || !strings.EqualFold(settings.JournalMode, "wal") {
			return fmt.Errorf("SQLite connection %d has unsafe settings: foreign_keys=%d busy_timeout=%d synchronous=%d journal_mode=%s", index+1, settings.ForeignKeys, settings.BusyTimeout, settings.Synchronous, settings.JournalMode)
		}
	}
	return nil
}

func readConnectionSettings(ctx context.Context, conn *sql.Conn) (ConnectionSettings, error) {
	var settings ConnectionSettings
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&settings.ForeignKeys); err != nil {
		return settings, fmt.Errorf("cannot read SQLite foreign_keys: %w", err)
	}
	if err := conn.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&settings.BusyTimeout); err != nil {
		return settings, fmt.Errorf("cannot read SQLite busy_timeout: %w", err)
	}
	if err := conn.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&settings.Synchronous); err != nil {
		return settings, fmt.Errorf("cannot read SQLite synchronous: %w", err)
	}
	if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&settings.JournalMode); err != nil {
		return settings, fmt.Errorf("cannot read SQLite journal_mode: %w", err)
	}
	return settings, nil
}

func initializeStore(ctx context.Context, db *sql.DB) (string, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("cannot begin Modelry internal schema migration: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_internal_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return "", fmt.Errorf("cannot prepare Modelry internal migration state: %w", err)
	}
	var currentVersion int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM modelry_internal_migrations").Scan(&currentVersion); err != nil {
		return "", fmt.Errorf("cannot read Modelry internal schema version: %w", err)
	}
	if currentVersion > 1 {
		return "", fmt.Errorf("project database uses unsupported Modelry internal schema version %d", currentVersion)
	}
	if currentVersion == 0 {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE modelry_runtime_metadata (
			key TEXT PRIMARY KEY NOT NULL,
			value TEXT NOT NULL
		)`); err != nil {
			return "", fmt.Errorf("cannot create Modelry runtime metadata: %w", err)
		}
		projectID, err := newProjectID()
		if err != nil {
			return "", fmt.Errorf("cannot generate a stable project ID: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO modelry_runtime_metadata (key, value) VALUES ('project_id', ?)", projectID); err != nil {
			return "", fmt.Errorf("cannot persist the stable project ID: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO modelry_internal_migrations (version, applied_at) VALUES (1, ?)", time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return "", fmt.Errorf("cannot record Modelry internal schema migration: %w", err)
		}
	}
	var projectID string
	if err := tx.QueryRowContext(ctx, "SELECT value FROM modelry_runtime_metadata WHERE key = 'project_id'").Scan(&projectID); err != nil {
		return "", fmt.Errorf("project database has no valid durable project ID: %w", err)
	}
	if !strings.HasPrefix(projectID, "prj_") || len(projectID) < 12 {
		return "", errors.New("project database contains an invalid durable project ID")
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("cannot commit Modelry internal schema migration: %w", err)
	}
	return projectID, nil
}

func newProjectID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return "prj_" + hex.EncodeToString(value[:]), nil
}
