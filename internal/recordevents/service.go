package recordevents

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	maximumEvents           = 10_000
	maximumEventBytes       = 64 << 20
	maximumSingleEventBytes = 1 << 20
	maximumReadBatchBytes   = 1 << 20
	maximumSubscriptions    = 64
	maximumReadBatch        = 256
)

var (
	ErrInvalidMutation = errors.New("invalid Record Event mutation")
	ErrEventTooLarge   = errors.New("Record Event exceeds its durable size limit")
	ErrInvalidCursor   = errors.New("invalid Record Event cursor")
	ErrCursorExpired   = errors.New("Record Event cursor is older than the retention watermark")
	ErrCapacityReached = errors.New("Realtime subscription capacity reached")
	ErrServiceClosed   = errors.New("Realtime event service is closed")
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// Mutation is appended in the same SQLite transaction as its Record change.
type Mutation struct {
	CollectionID  string
	RecordID      string
	Type          Type
	OccurredAt    time.Time
	SchemaVersion int
	Before        map[string]any
	After         map[string]any
}

type Type string

const (
	Created Type = "record.created"
	Updated Type = "record.updated"
	Deleted Type = "record.deleted"
)

type Event struct {
	ID            string
	CollectionID  string
	Sequence      int64
	RecordID      string
	Type          Type
	OccurredAt    time.Time
	SchemaVersion int
	Before        map[string]any
	After         map[string]any
}

type Position struct {
	Head         int64
	Watermark    int64
	HasWatermark bool
}

type Service struct {
	store transactionalStore

	mu                  sync.Mutex
	nextSubscriptionID  uint64
	subscriptions       map[uint64]*Subscription
	maximumConnections  int
	retentionEventLimit int64
	retentionByteLimit  int64
	closed              bool
}

type Subscription struct {
	service      *Service
	id           uint64
	collectionID string
	wake         chan struct{}
	ctx          context.Context
	cancel       context.CancelFunc
	closeOnce    sync.Once
}

func NewService(ctx context.Context, store transactionalStore) (*Service, error) {
	if store == nil {
		return nil, errors.New("Record Event storage is required")
	}
	service := &Service{
		store:               store,
		subscriptions:       make(map[uint64]*Subscription),
		maximumConnections:  maximumSubscriptions,
		retentionEventLimit: maximumEvents,
		retentionByteLimit:  maximumEventBytes,
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range eventSchema {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize Record Event storage: %w", err)
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return service, nil
}

var eventSchema = []string{
	`CREATE TABLE IF NOT EXISTS modelry_record_event_sequences (
		collection_id TEXT PRIMARY KEY NOT NULL,
		last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_record_events (
		ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
		event_id TEXT NOT NULL UNIQUE,
		collection_id TEXT NOT NULL,
		sequence INTEGER NOT NULL CHECK (sequence > 0),
		record_id TEXT NOT NULL,
		event_type TEXT NOT NULL CHECK (event_type IN ('record.created', 'record.updated', 'record.deleted')),
		occurred_at TEXT NOT NULL,
		schema_version INTEGER NOT NULL CHECK (schema_version > 0),
		before_json TEXT,
		after_json TEXT,
		byte_size INTEGER NOT NULL CHECK (byte_size > 0),
		UNIQUE (collection_id, sequence)
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_record_events_by_collection_sequence
		ON modelry_record_events(collection_id, sequence)`,
	`CREATE TABLE IF NOT EXISTS modelry_record_event_watermarks (
		collection_id TEXT PRIMARY KEY NOT NULL,
		pruned_sequence INTEGER NOT NULL CHECK (pruned_sequence > 0)
	)`,
}

// AppendInTransaction adds the durable Event and applies retention in the
// caller's Record transaction. Any error must roll back the whole mutation.
func (service *Service) AppendInTransaction(ctx context.Context, tx storage.Executor, mutation Mutation) error {
	_, err := service.AppendEventInTransaction(ctx, tx, mutation)
	return err
}

// AppendEventInTransaction returns the durable Event identity to the owning Record transaction.
func (service *Service) AppendEventInTransaction(ctx context.Context, tx storage.Executor, mutation Mutation) (Event, error) {
	if service == nil || tx == nil {
		return Event{}, fmt.Errorf("%w: active storage transaction is required", ErrInvalidMutation)
	}
	if err := validateMutation(mutation); err != nil {
		return Event{}, err
	}
	beforeJSON, err := encodeSnapshot(mutation.Before)
	if err != nil {
		return Event{}, fmt.Errorf("%w: encode prior authorization snapshot", ErrInvalidMutation)
	}
	afterJSON, err := encodeSnapshot(mutation.After)
	if err != nil {
		return Event{}, fmt.Errorf("%w: encode resulting authorization snapshot", ErrInvalidMutation)
	}
	eventIDTemplate, err := EventID(mutation.CollectionID, 1)
	if err != nil {
		return Event{}, err
	}
	byteSize := int64(len(eventIDTemplate) + len(mutation.CollectionID) + len(mutation.RecordID) + len(mutation.Type) + len(mutation.OccurredAt.UTC().Format(time.RFC3339Nano)) + 256 + len(beforeJSON) + len(afterJSON))
	if byteSize > maximumSingleEventBytes {
		return Event{}, fmt.Errorf("%w: maximum encoded Event size is %d bytes", ErrEventTooLarge, maximumSingleEventBytes)
	}
	var sequence int64
	if err := tx.QueryRowContext(ctx, `INSERT INTO modelry_record_event_sequences (collection_id, last_sequence)
		VALUES (?, 1)
		ON CONFLICT(collection_id) DO UPDATE SET last_sequence = last_sequence + 1
		RETURNING last_sequence`, mutation.CollectionID).Scan(&sequence); err != nil {
		return Event{}, fmt.Errorf("allocate Collection Event sequence: %w", err)
	}
	eventID, err := EventID(mutation.CollectionID, sequence)
	if err != nil {
		return Event{}, err
	}
	var beforeValue, afterValue any
	if beforeJSON != nil {
		beforeValue = string(beforeJSON)
	}
	if afterJSON != nil {
		afterValue = string(afterJSON)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_record_events
		(event_id, collection_id, sequence, record_id, event_type, occurred_at, schema_version, before_json, after_json, byte_size)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		eventID, mutation.CollectionID, sequence, mutation.RecordID, string(mutation.Type),
		mutation.OccurredAt.UTC().Format(time.RFC3339Nano), mutation.SchemaVersion, beforeValue, afterValue, byteSize); err != nil {
		return Event{}, fmt.Errorf("persist Record Event: %w", err)
	}
	if err := service.pruneInTransaction(ctx, tx); err != nil {
		return Event{}, err
	}
	return Event{
		ID: eventID, CollectionID: mutation.CollectionID, Sequence: sequence, RecordID: mutation.RecordID,
		Type: mutation.Type, OccurredAt: mutation.OccurredAt.UTC(), SchemaVersion: mutation.SchemaVersion,
		Before: mutation.Before, After: mutation.After,
	}, nil
}

func validateMutation(mutation Mutation) error {
	if mutation.CollectionID == "" || !utf8.ValidString(mutation.CollectionID) || mutation.RecordID == "" || !utf8.ValidString(mutation.RecordID) || mutation.SchemaVersion < 1 || mutation.OccurredAt.IsZero() {
		return fmt.Errorf("%w: Collection, Record, schema version and UTC occurrence time are required", ErrInvalidMutation)
	}
	if _, err := encodeCollectionID(mutation.CollectionID); err != nil {
		return fmt.Errorf("%w: Collection ID cannot be encoded", ErrInvalidMutation)
	}
	switch mutation.Type {
	case Created:
		if mutation.Before != nil || mutation.After == nil {
			return fmt.Errorf("%w: a created Event requires only the resulting Record", ErrInvalidMutation)
		}
	case Updated:
		if mutation.Before == nil || mutation.After == nil {
			return fmt.Errorf("%w: an updated Event requires both Record snapshots", ErrInvalidMutation)
		}
	case Deleted:
		if mutation.Before == nil || mutation.After != nil {
			return fmt.Errorf("%w: a deleted Event requires only the prior Record", ErrInvalidMutation)
		}
	default:
		return fmt.Errorf("%w: unsupported Event type", ErrInvalidMutation)
	}
	return nil
}

func encodeSnapshot(snapshot map[string]any) ([]byte, error) {
	if snapshot == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func (service *Service) pruneInTransaction(ctx context.Context, tx storage.Executor) error {
	var eventCount, retainedBytes int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM modelry_record_events`).Scan(&eventCount, &retainedBytes); err != nil {
		return fmt.Errorf("measure durable Record Event window: %w", err)
	}
	if eventCount <= service.retentionEventLimit && retainedBytes <= service.retentionByteLimit {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT ordinal, collection_id, sequence, byte_size
		FROM modelry_record_events ORDER BY ordinal`)
	if err != nil {
		return fmt.Errorf("read oldest Record Events for pruning: %w", err)
	}
	type prunedRow struct {
		ordinal      int64
		collectionID string
		sequence     int64
		byteSize     int64
	}
	var pruned []prunedRow
	cutoff := int64(0)
	for rows.Next() && (eventCount-int64(len(pruned)) > service.retentionEventLimit || retainedBytes > service.retentionByteLimit) {
		var row prunedRow
		if err := rows.Scan(&row.ordinal, &row.collectionID, &row.sequence, &row.byteSize); err != nil {
			_ = rows.Close()
			return fmt.Errorf("read an old Record Event for pruning: %w", err)
		}
		pruned = append(pruned, row)
		cutoff = row.ordinal
		retainedBytes -= row.byteSize
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("finish reading old Record Events: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close old Record Event rows: %w", err)
	}
	if len(pruned) == 0 {
		return errors.New("Record Event retention could not satisfy its configured bounds")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_record_events WHERE ordinal <= ?`, cutoff); err != nil {
		return fmt.Errorf("prune expired Record Events: %w", err)
	}
	watermarks := make(map[string]int64)
	for _, row := range pruned {
		if row.sequence > watermarks[row.collectionID] {
			watermarks[row.collectionID] = row.sequence
		}
	}
	for collectionID, sequence := range watermarks {
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_record_event_watermarks (collection_id, pruned_sequence)
			VALUES (?, ?) ON CONFLICT(collection_id) DO UPDATE SET pruned_sequence = MAX(pruned_sequence, excluded.pruned_sequence)`, collectionID, sequence); err != nil {
			return fmt.Errorf("advance pruned Event watermark: %w", err)
		}
	}
	return nil
}

func (service *Service) State(ctx context.Context, collectionID string) (Position, error) {
	if service == nil || collectionID == "" {
		return Position{}, ErrInvalidMutation
	}
	var position Position
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		err := snapshot.QueryRowContext(ctx, `SELECT last_sequence FROM modelry_record_event_sequences WHERE collection_id = ?`, collectionID).Scan(&position.Head)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("read Collection Event sequence: %w", err)
		}
		if errors.Is(err, sql.ErrNoRows) {
			position.Head = 0
		}
		err = snapshot.QueryRowContext(ctx, `SELECT pruned_sequence FROM modelry_record_event_watermarks WHERE collection_id = ?`, collectionID).Scan(&position.Watermark)
		if err == nil {
			position.HasWatermark = true
			return nil
		}
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("read Collection Event retention watermark: %w", err)
	})
	return position, err
}

func (service *Service) ReadAfter(ctx context.Context, collectionID string, sequence int64, limit int) ([]Event, error) {
	if service == nil || collectionID == "" || sequence < 0 || limit < 1 || limit > maximumReadBatch {
		return nil, fmt.Errorf("%w: invalid Event read boundary", ErrInvalidMutation)
	}
	events := make([]Event, 0, limit)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var watermark int64
		watermarkErr := snapshot.QueryRowContext(ctx, `SELECT pruned_sequence FROM modelry_record_event_watermarks WHERE collection_id = ?`, collectionID).Scan(&watermark)
		if watermarkErr != nil && !errors.Is(watermarkErr, sql.ErrNoRows) {
			return fmt.Errorf("read Collection Event retention watermark: %w", watermarkErr)
		}
		if watermarkErr == nil && sequence < watermark {
			return ErrCursorExpired
		}
		rows, err := snapshot.QueryContext(ctx, `SELECT event_id, sequence, record_id, event_type, occurred_at,
			schema_version, before_json, after_json, byte_size
			FROM modelry_record_events WHERE collection_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, collectionID, sequence, limit)
		if err != nil {
			return fmt.Errorf("read retained Collection Events: %w", err)
		}
		defer rows.Close()
		var batchBytes int64
		for rows.Next() {
			var event Event
			var occurredAt string
			var beforeJSON, afterJSON sql.NullString
			var byteSize int64
			if err := rows.Scan(&event.ID, &event.Sequence, &event.RecordID, &event.Type, &occurredAt,
				&event.SchemaVersion, &beforeJSON, &afterJSON, &byteSize); err != nil {
				return fmt.Errorf("read retained Record Event: %w", err)
			}
			if byteSize < 1 || byteSize > maximumSingleEventBytes {
				return errors.New("retained Record Event exceeds the maximum single Event size")
			}
			if batchBytes+byteSize > maximumReadBatchBytes {
				if len(events) == 0 {
					return errors.New("retained Record Event exceeds the maximum replay page size")
				}
				break
			}
			event.CollectionID = collectionID
			event.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
			if err != nil {
				return fmt.Errorf("decode retained Record Event time: %w", err)
			}
			if beforeJSON.Valid {
				if err := json.Unmarshal([]byte(beforeJSON.String), &event.Before); err != nil {
					return fmt.Errorf("decode retained Record Event prior snapshot: %w", err)
				}
			}
			if afterJSON.Valid {
				if err := json.Unmarshal([]byte(afterJSON.String), &event.After); err != nil {
					return fmt.Errorf("decode retained Record Event resulting snapshot: %w", err)
				}
			}
			events = append(events, event)
			batchBytes += byteSize
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("finish reading retained Collection Events: %w", err)
		}
		return nil
	})
	return events, err
}

func (service *Service) Subscribe(collectionID string) (*Subscription, error) {
	if service == nil || collectionID == "" {
		return nil, ErrInvalidMutation
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.closed {
		return nil, ErrServiceClosed
	}
	if len(service.subscriptions) >= service.maximumConnections {
		return nil, ErrCapacityReached
	}
	service.nextSubscriptionID++
	subscriptionContext, cancel := context.WithCancel(context.Background())
	subscription := &Subscription{
		service:      service,
		id:           service.nextSubscriptionID,
		collectionID: collectionID,
		wake:         make(chan struct{}, 1),
		ctx:          subscriptionContext,
		cancel:       cancel,
	}
	service.subscriptions[subscription.id] = subscription
	return subscription, nil
}

func (subscription *Subscription) Wake() <-chan struct{} {
	if subscription == nil {
		return nil
	}
	return subscription.wake
}

func (subscription *Subscription) Context() context.Context {
	if subscription == nil {
		return context.Background()
	}
	return subscription.ctx
}

func (subscription *Subscription) Close() {
	if subscription == nil || subscription.service == nil {
		return
	}
	subscription.closeOnce.Do(func() {
		subscription.service.mu.Lock()
		delete(subscription.service.subscriptions, subscription.id)
		subscription.service.mu.Unlock()
		subscription.cancel()
	})
}

// Close cancels live subscribers and rejects new subscriptions during shutdown.
func (service *Service) Close() {
	if service == nil {
		return
	}
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return
	}
	service.closed = true
	for _, subscription := range service.subscriptions {
		subscription.cancel()
	}
	service.mu.Unlock()
}

func (service *Service) PublishCommitted(collectionID string) {
	if service == nil || collectionID == "" {
		return
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, subscription := range service.subscriptions {
		if subscription.collectionID != collectionID {
			continue
		}
		select {
		case subscription.wake <- struct{}{}:
		default:
		}
	}
}

func EventID(collectionID string, sequence int64) (string, error) {
	if sequence < 1 {
		return "", fmt.Errorf("%w: Event sequence must be positive", ErrInvalidCursor)
	}
	encoded, err := encodeCollectionID(collectionID)
	if err != nil {
		return "", err
	}
	return "evt_" + encoded + "_" + fmt.Sprintf("%020d", sequence), nil
}

func Cursor(collectionID string, sequence int64) (string, error) {
	if sequence < 0 {
		return "", fmt.Errorf("%w: cursor sequence cannot be negative", ErrInvalidCursor)
	}
	encoded, err := encodeCollectionID(collectionID)
	if err != nil {
		return "", err
	}
	return "cur_" + encoded + "_" + fmt.Sprintf("%020d", sequence), nil
}

func ParseResumePosition(raw, collectionID string) (int64, error) {
	if raw == "" || len(raw) > 4096 || collectionID == "" {
		return 0, ErrInvalidCursor
	}
	var prefix string
	allowZero := false
	switch {
	case strings.HasPrefix(raw, "evt_"):
		prefix = "evt_"
	case strings.HasPrefix(raw, "cur_"):
		prefix = "cur_"
		allowZero = true
	default:
		return 0, ErrInvalidCursor
	}
	if len(raw) < len(prefix)+1+1+20 {
		return 0, ErrInvalidCursor
	}
	separator := len(raw) - 21
	if raw[separator] != '_' {
		return 0, ErrInvalidCursor
	}
	encodedCollection := raw[len(prefix):separator]
	decoded, err := base64.RawURLEncoding.DecodeString(encodedCollection)
	if err != nil || !utf8.Valid(decoded) || string(decoded) != collectionID || base64.RawURLEncoding.EncodeToString(decoded) != encodedCollection {
		return 0, ErrInvalidCursor
	}
	sequenceText := raw[separator+1:]
	if len(sequenceText) != 20 {
		return 0, ErrInvalidCursor
	}
	for _, character := range sequenceText {
		if character < '0' || character > '9' {
			return 0, ErrInvalidCursor
		}
	}
	sequence, err := strconv.ParseInt(sequenceText, 10, 64)
	if err != nil || sequence < 0 || (!allowZero && sequence == 0) {
		return 0, ErrInvalidCursor
	}
	return sequence, nil
}

func encodeCollectionID(collectionID string) (string, error) {
	if collectionID == "" || !utf8.ValidString(collectionID) {
		return "", fmt.Errorf("%w: Collection ID must be non-empty valid UTF-8", ErrInvalidCursor)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(collectionID)), nil
}
