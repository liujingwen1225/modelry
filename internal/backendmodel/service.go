package backendmodel

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// TransactionalStore is the only persistence surface used by Backend Model.
// Application code receives no database handle outside a bounded transaction.
type TransactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Service struct {
	store TransactionalStore
}

// CollectionInitializer runs inside the same transaction as the new Collection
// row and its Records projection. Domain modules can use it to seed
// independent applied configuration without coupling that state to the schema
// Pending Change.
type CollectionInitializer func(context.Context, storage.Executor, Collection) error

// NewService initializes the Backend Model-owned tables and recovers attempts
// left In Progress by a prior process. Create one Service per Runtime startup.
func NewService(ctx context.Context, store TransactionalStore) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("%w: storage is required", ErrInvalidArgument)
	}
	service := &Service{store: store}
	if err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range backendModelSchema {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("initialize Backend Model persistence: %w", err)
			}
		}
		return service.recoverInterrupted(ctx, tx)
	}); err != nil {
		return nil, err
	}
	return service, nil
}

var backendModelSchema = []string{
	`CREATE TABLE IF NOT EXISTS modelry_backend_collections (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL COLLATE NOCASE UNIQUE,
		type TEXT NOT NULL CHECK (type IN ('Normal', 'Auth')),
		model_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_backend_changes (
		id TEXT PRIMARY KEY NOT NULL,
		collection_id TEXT NOT NULL,
		version INTEGER NOT NULL CHECK (version >= 1),
		status TEXT NOT NULL,
		operations_json TEXT NOT NULL,
		recovery_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id)
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS modelry_backend_one_active_change
		ON modelry_backend_changes(collection_id)
		WHERE status IN ('ready', 'needsReview', 'failed')`,
	`CREATE TABLE IF NOT EXISTS modelry_backend_apply_attempts (
		id TEXT PRIMARY KEY NOT NULL,
		change_set_id TEXT NOT NULL,
		status TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT,
		evaluation_json TEXT NOT NULL,
		error_code TEXT,
		recovery_json TEXT,
		applied_migration_id TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_backend_attempts_by_change
		ON modelry_backend_apply_attempts(change_set_id, started_at DESC, id DESC)`,
	`CREATE TABLE IF NOT EXISTS modelry_backend_applied_migrations (
		id TEXT PRIMARY KEY NOT NULL,
		change_set_id TEXT NOT NULL,
		collection_id TEXT NOT NULL,
		apply_attempt_id TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL,
		schema_version INTEGER NOT NULL,
		diff_json TEXT NOT NULL,
		model_json TEXT NOT NULL,
		FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id),
		FOREIGN KEY (apply_attempt_id) REFERENCES modelry_backend_apply_attempts(id)
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_backend_history_by_collection
		ON modelry_backend_applied_migrations(collection_id, applied_at DESC, id DESC)`,
}

func (service *Service) recoverInterrupted(ctx context.Context, tx storage.Executor) error {
	rows, err := tx.QueryContext(ctx, `SELECT id, change_set_id, evaluation_json FROM modelry_backend_apply_attempts WHERE status = ?`, AttemptInProgress)
	if err != nil {
		return fmt.Errorf("read interrupted schema apply attempts: %w", err)
	}
	type interrupted struct {
		id, changeSetID, evaluation string
	}
	var pending []interrupted
	for rows.Next() {
		var item interrupted
		if err := rows.Scan(&item.id, &item.changeSetID, &item.evaluation); err != nil {
			rows.Close()
			return fmt.Errorf("read interrupted schema apply attempt: %w", err)
		}
		pending = append(pending, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("finish reading interrupted schema apply attempts: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close interrupted schema apply attempts: %w", err)
	}
	if len(pending) == 0 {
		return nil
	}
	now := timestamp(time.Now())
	recovery := RecoveryState{
		State:   "interrupted",
		Summary: "The previous process stopped during schema Apply. The Applied Model and Records projection were rolled back; the Pending Change is retained.",
		Actions: []string{"reviewPendingChange", "retryApply", "discardPendingChange"},
	}
	recoveryJSON, err := json.Marshal(recovery)
	if err != nil {
		return fmt.Errorf("encode schema recovery state: %w", err)
	}
	for _, item := range pending {
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_backend_apply_attempts SET status = ?, finished_at = ?, error_code = ?, recovery_json = ? WHERE id = ? AND status = ?`, AttemptInterrupted, now, "APPLY_INTERRUPTED", string(recoveryJSON), item.id, AttemptInProgress); err != nil {
			return fmt.Errorf("mark interrupted schema apply: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_backend_changes SET status = ?, recovery_json = ?, updated_at = ? WHERE id = ? AND status IN (?, ?, ?)`, ChangeFailed, string(recoveryJSON), now, item.changeSetID, ChangeReady, ChangeNeedsReview, ChangeFailed); err != nil {
			return fmt.Errorf("retain interrupted Pending Change: %w", err)
		}
	}
	return nil
}

func (service *Service) CreateCollection(ctx context.Context, input CreateCollectionInput) (Collection, error) {
	return service.CreateCollectionWithInitializer(ctx, input, nil)
}

// CreateCollectionWithInitializer atomically creates the Collection, its
// physical Records projection, and any initial state written by initializer.
// The callback receives the active transaction after the Collection row is
// visible to reads through that transaction. Returning an error rolls back all
// three writes.
func (service *Service) CreateCollectionWithInitializer(ctx context.Context, input CreateCollectionInput, initializer CollectionInitializer) (Collection, error) {
	if err := validateCollectionInput(input); err != nil {
		return Collection{}, err
	}
	collectionID, err := newID("col_")
	if err != nil {
		return Collection{}, err
	}
	now := time.Now().UTC()
	collection := Collection{
		ID: collectionID, Name: input.Name, Description: input.Description, Type: input.Type,
		SchemaVersion: 1, CreatedAt: now, UpdatedAt: now,
		Fields:  make([]Field, 0, len(input.Fields)+3),
		Indexes: make([]Index, 0),
	}
	collection.Fields = append(collection.Fields, systemFields()...)
	seen := make(map[string]struct{}, len(input.Fields)+3)
	for _, system := range collection.Fields {
		seen[strings.ToLower(system.Name)] = struct{}{}
	}
	for _, candidate := range input.Fields {
		field := cloneField(candidate)
		if field.ID != "" || field.System {
			return Collection{}, fmt.Errorf("%w: initial fields cannot define Modelry-owned IDs or system fields", ErrInvalidArgument)
		}
		field.ID, err = newID("fld_")
		if err != nil {
			return Collection{}, err
		}
		if err := validateField(field); err != nil {
			return Collection{}, err
		}
		key := strings.ToLower(field.Name)
		if _, exists := seen[key]; exists {
			return Collection{}, fmt.Errorf("%w: field name %q is already used in this Collection", ErrInvalidArgument, field.Name)
		}
		seen[key] = struct{}{}
		collection.Fields = append(collection.Fields, field)
	}
	if collection.Type == CollectionTypeAuth {
		if err := addAuthIdentifier(&collection, seen); err != nil {
			return Collection{}, err
		}
	}
	if err := validateModel(collection); err != nil {
		return Collection{}, err
	}
	modelJSON, err := json.Marshal(collection)
	if err != nil {
		return Collection{}, fmt.Errorf("encode initial Collection model: %w", err)
	}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var existing string
		err := tx.QueryRowContext(ctx, `SELECT id FROM modelry_backend_collections WHERE name = ? COLLATE NOCASE`, input.Name).Scan(&existing)
		if err == nil {
			return fmt.Errorf("%w: a Collection named %q already exists", ErrConflict, input.Name)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("check Collection name: %w", err)
		}
		for _, field := range collection.Fields {
			if field.Type == FieldTypeRelation {
				if err := requireCollection(ctx, tx, field.Relation.TargetCollectionID); err != nil {
					return fmt.Errorf("validate initial relation %q: %w", field.Name, err)
				}
			}
		}
		if err := storage.CreateRecordProjection(ctx, tx, storageProjection(collection)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_backend_collections (id, name, type, model_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, collection.ID, collection.Name, collection.Type, string(modelJSON), timestamp(now), timestamp(now)); err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "unique") {
				return fmt.Errorf("%w: a Collection named %q already exists", ErrConflict, input.Name)
			}
			return fmt.Errorf("persist initial Collection model: %w", err)
		}
		if initializer != nil {
			if err := initializer(ctx, tx, collection); err != nil {
				return fmt.Errorf("initialize Collection domain state: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return Collection{}, err
	}
	return collection, nil
}

func addAuthIdentifier(collection *Collection, names map[string]struct{}) error {
	var email *Field
	for index := range collection.Fields {
		if strings.EqualFold(collection.Fields[index].Name, "email") {
			email = &collection.Fields[index]
			break
		}
	}
	if email == nil {
		id, err := newID("fld_")
		if err != nil {
			return err
		}
		collection.Fields = append(collection.Fields, Field{ID: id, Name: "email", Type: FieldTypeText, Required: true, Unique: true})
		if names != nil {
			names["email"] = struct{}{}
		}
		return nil
	}
	if email.Type != FieldTypeText {
		return fmt.Errorf("%w: Auth Collection email must be a text Field", ErrInvalidArgument)
	}
	email.Required = true
	email.Unique = true
	return nil
}

func systemFields() []Field {
	return []Field{
		{ID: "fld_system_id", Name: "id", Type: FieldTypeText, Required: true, System: true},
		{ID: "fld_system_created_at", Name: "createdAt", Type: FieldTypeDateTime, Required: true, System: true},
		{ID: "fld_system_updated_at", Name: "updatedAt", Type: FieldTypeDateTime, Required: true, System: true},
	}
}

func (service *Service) GetCollection(ctx context.Context, collectionID string) (Collection, error) {
	var collection Collection
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var err error
		collection, err = loadCollection(ctx, snapshot, collectionID)
		return err
	})
	return collection, err
}

func (service *Service) ListCollections(ctx context.Context, options ListOptions) (Page[Collection], error) {
	limit, err := pageLimit(options.Limit)
	if err != nil {
		return Page[Collection]{}, err
	}
	var afterTime, afterID string
	if options.Cursor != "" {
		afterTime, afterID, err = decodeCursor(options.Cursor)
		if err != nil {
			return Page[Collection]{}, err
		}
	}
	page := Page[Collection]{Data: make([]Collection, 0, limit)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		query := `SELECT id, name, type, model_json, created_at, updated_at FROM modelry_backend_collections`
		args := []any{}
		if afterID != "" {
			query += ` WHERE created_at > ? OR (created_at = ? AND id > ?)`
			args = append(args, afterTime, afterTime, afterID)
		}
		query += ` ORDER BY created_at, id LIMIT ?`
		args = append(args, limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("list Collections: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			collection, err := scanCollection(rows)
			if err != nil {
				return err
			}
			page.Data = append(page.Data, collection)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("finish listing Collections: %w", err)
		}
		if len(page.Data) > limit {
			last := page.Data[limit-1]
			page.NextCursor = encodeCursor(timestamp(last.CreatedAt), last.ID)
			page.Data = page.Data[:limit]
		}
		return nil
	})
	return page, err
}

func (service *Service) GetRecordProjection(ctx context.Context, collectionID string) (RecordProjection, error) {
	collection, err := service.GetCollection(ctx, collectionID)
	if err != nil {
		return RecordProjection{}, err
	}
	projection := RecordProjection{
		CollectionID:  collection.ID,
		SchemaVersion: collection.SchemaVersion,
		TableName:     storage.RecordTableName(collection.ID),
		Fields:        make([]ProjectedField, 0, len(collection.Fields)),
	}
	for _, field := range collection.Fields {
		column := storage.RecordFieldColumnName(field.ID, field.Name, field.System)
		projection.Fields = append(projection.Fields, ProjectedField{
			ID: field.ID, Name: field.Name, Type: field.Type, ColumnName: column,
			Required: field.Required, Unique: field.Unique, Validation: cloneJSON(field.Validation),
			Default: cloneJSON(field.Default), Relation: cloneRelation(field.Relation), System: field.System,
		})
	}
	return projection, nil
}

// ValidateRecordValues validates input against an Applied Model and returns a
// copy containing product defaults. Callers must use the returned values.
func ValidateRecordValues(collection Collection, values map[string]any) (map[string]any, error) {
	if values == nil {
		return nil, fmt.Errorf("%w: record values are required", ErrInvalidArgument)
	}
	result := make(map[string]any, len(values)+len(collection.Fields))
	for key, value := range values {
		field, found := fieldByName(collection.Fields, key)
		if !found {
			return nil, &RecordValueError{Field: key, Code: "unknownField", Message: "is not part of the applied Collection model"}
		}
		if field.System {
			return nil, &RecordValueError{Field: key, Code: "systemField", Message: "is managed by Modelry"}
		}
		if err := validateFieldValue(field, value, true); err != nil {
			return nil, err
		}
		result[field.Name] = value
	}
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		if _, supplied := result[field.Name]; !supplied && len(field.Default) > 0 {
			var value any
			decoder := json.NewDecoder(strings.NewReader(string(field.Default)))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil {
				return nil, fmt.Errorf("decode applied default for field %q: %w", field.Name, err)
			}
			if err := validateFieldValue(field, value, true); err != nil {
				return nil, err
			}
			result[field.Name] = value
		} else if _, supplied := result[field.Name]; !supplied && field.Required {
			return nil, &RecordValueError{Field: field.Name, Code: "required", Message: "is required"}
		}
	}
	return result, nil
}

func loadCollection(ctx context.Context, query storage.Executor, collectionID string) (Collection, error) {
	if !validOpaqueID(collectionID, "col_") {
		return Collection{}, fmt.Errorf("%w: invalid Collection ID", ErrInvalidArgument)
	}
	var modelJSON string
	if err := query.QueryRowContext(ctx, `SELECT model_json FROM modelry_backend_collections WHERE id = ?`, collectionID).Scan(&modelJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Collection{}, fmt.Errorf("%w: Collection %q does not exist", ErrNotFound, collectionID)
		}
		return Collection{}, fmt.Errorf("read Collection model: %w", err)
	}
	var collection Collection
	if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
		return Collection{}, fmt.Errorf("decode persisted Collection model: %w", err)
	}
	if collection.Fields == nil {
		collection.Fields = make([]Field, 0)
	}
	if collection.Indexes == nil {
		collection.Indexes = make([]Index, 0)
	}
	return collection, nil
}

func scanCollection(rows *sql.Rows) (Collection, error) {
	var modelJSON string
	var collection Collection
	var typeName, createdAt, updatedAt string
	if err := rows.Scan(&collection.ID, &collection.Name, &typeName, &modelJSON, &createdAt, &updatedAt); err != nil {
		return Collection{}, fmt.Errorf("scan Collection model: %w", err)
	}
	if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
		return Collection{}, fmt.Errorf("decode listed Collection model: %w", err)
	}
	collection.Type = CollectionType(typeName)
	if collection.Fields == nil {
		collection.Fields = make([]Field, 0)
	}
	if collection.Indexes == nil {
		collection.Indexes = make([]Index, 0)
	}
	return collection, nil
}

func fieldByName(fields []Field, name string) (Field, bool) {
	for _, field := range fields {
		if field.Name == name {
			return field, true
		}
	}
	return Field{}, false
}

func fieldByID(fields []Field, id string) (Field, bool) {
	for _, field := range fields {
		if field.ID == id {
			return field, true
		}
	}
	return Field{}, false
}

func cloneField(field Field) Field {
	field.Validation = cloneJSON(field.Validation)
	field.Default = cloneJSON(field.Default)
	field.Relation = cloneRelation(field.Relation)
	return field
}

func cloneRelation(relation *Relation) *Relation {
	if relation == nil {
		return nil
	}
	cloned := *relation
	return &cloned
}

func cloneJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func timestamp(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTimestamp(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse persisted timestamp: %w", err)
	}
	return parsed, nil
}

func pageLimit(limit int) (int, error) {
	if limit == 0 {
		return 50, nil
	}
	if limit < 1 || limit > 100 {
		return 0, fmt.Errorf("%w: page size must be between 1 and 100", ErrInvalidArgument)
	}
	return limit, nil
}
