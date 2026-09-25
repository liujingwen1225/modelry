package records

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrInvalidArgument                    = errors.New("invalid record argument")
	ErrNotFound                           = errors.New("record not found")
	ErrConflict                           = errors.New("record conflict")
	ErrForbidden                          = errors.New("record access denied")
	ErrUnauthenticated                    = errors.New("application session is invalid")
	ErrAuthCollectionWriteRequiresAuthAPI = errors.New("Auth Collection writes require the Auth User API")
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// Service 管理已经 Apply 的 Collection Records。它不持有数据库句柄，所有读写都通过 Store 边界。
type Service struct {
	store     transactionalStore
	models    *backendmodel.Service
	now       func() time.Time
	evaluator authorization.Evaluator
	sessions  authorization.SessionAuthenticator
	staging       *fileStaging
	fileProviders FileProviders
	events    *recordevents.Service
	lifecycle recordlifecycle.Hooks
}

type Option func(*Service)

func WithAuthorization(evaluator authorization.Evaluator, sessions authorization.SessionAuthenticator) Option {
	return func(service *Service) {
		service.evaluator = evaluator
		service.sessions = sessions
	}
}

// WithRecordEvents enables atomic durable Record Event writes and post-commit notifications.
func WithRecordEvents(events *recordevents.Service) Option {
	return func(service *Service) {
		service.events = events
	}
}

func WithLifecycleHooks(hooks recordlifecycle.Hooks) Option {
	return func(service *Service) {
		service.lifecycle = hooks
	}
}

// New 创建 Records Service。Backend Model 必须由 Runtime 先初始化。
func New(store *storage.Store, models *backendmodel.Service, options ...Option) (*Service, error) {
	if store == nil || models == nil {
		return nil, fmt.Errorf("%w: storage and applied Backend Model are required", ErrInvalidArgument)
	}
	service := &Service{store: store, models: models, now: func() time.Time { return time.Now().UTC() }}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

// Record 的 Values 在 JSON 中展开为 Record 的动态字段，以符合 OpenAPI Record DTO。
type Record struct {
	ID        string         `json:"-"`
	CreatedAt string         `json:"-"`
	UpdatedAt string         `json:"-"`
	Values    map[string]any `json:"-"`
	Expanded  map[string]any `json:"-"`
}

func (record Record) MarshalJSON() ([]byte, error) {
	result := make(map[string]any, len(record.Values)+3)
	result["id"] = record.ID
	result["createdAt"] = record.CreatedAt
	result["updatedAt"] = record.UpdatedAt
	for name, value := range record.Values {
		if name == "id" || name == "createdAt" || name == "updatedAt" {
			continue
		}
		result[name] = value
	}
	if record.Expanded != nil {
		result["_expand"] = record.Expanded
	}
	return json.Marshal(result)
}

type Page struct {
	Data       []Record `json:"data"`
	NextCursor string   `json:"nextCursor,omitempty"`
}

type ListOptions struct {
	Limit  int
	Cursor string
	Search string
	Filter string
	Sort   string
}

type appliedModel struct {
	collection backendmodel.Collection
	projection backendmodel.RecordProjection
	byName     map[string]backendmodel.ProjectedField
}

func (service *Service) loadModel(ctx context.Context, collectionID string) (appliedModel, error) {
	collection, err := service.models.GetCollection(ctx, collectionID)
	if err != nil {
		return appliedModel{}, mapModelError(err)
	}
	projection, err := service.models.GetRecordProjection(ctx, collectionID)
	if err != nil {
		return appliedModel{}, mapModelError(err)
	}
	if collection.SchemaVersion != projection.SchemaVersion || collection.ID != projection.CollectionID {
		return appliedModel{}, fmt.Errorf("%w: Applied Model changed while loading the Record projection; retry the request", ErrConflict)
	}
	result := appliedModel{collection: collection, projection: projection, byName: make(map[string]backendmodel.ProjectedField, len(projection.Fields))}
	for _, field := range projection.Fields {
		result.byName[field.Name] = field
	}
	return result, nil
}

func verifyModel(ctx context.Context, query storage.Executor, expected appliedModel) error {
	var encoded string
	if err := query.QueryRowContext(ctx, `SELECT model_json FROM modelry_backend_collections WHERE id = ?`, expected.collection.ID).Scan(&encoded); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: Collection does not exist", ErrNotFound)
		}
		return fmt.Errorf("read Applied Model version: %w", err)
	}
	var current backendmodel.Collection
	if err := json.Unmarshal([]byte(encoded), &current); err != nil {
		return fmt.Errorf("decode Applied Model version: %w", err)
	}
	if current.ID != expected.collection.ID || current.SchemaVersion != expected.collection.SchemaVersion {
		return fmt.Errorf("%w: Applied Model changed; retry the Record operation", ErrConflict)
	}
	return nil
}

func mapModelError(err error) error {
	var valueError *backendmodel.RecordValueError
	if errors.As(err, &valueError) {
		return errors.Join(ErrInvalidArgument, err)
	}
	switch {
	case errors.Is(err, backendmodel.ErrInvalidArgument):
		return fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	case errors.Is(err, backendmodel.ErrNotFound):
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	case errors.Is(err, backendmodel.ErrConflict):
		return fmt.Errorf("%w: %v", ErrConflict, err)
	default:
		return err
	}
}

func (service *Service) Get(ctx context.Context, collectionID, recordID string) (Record, error) {
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Record{}, err
	}
	var record Record
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := verifyModel(ctx, snapshot, model); err != nil {
			return err
		}
		var err error
		record, err = getRecord(ctx, snapshot, model, recordID)
		return err
	})
	return record, err
}

func (service *Service) Create(ctx context.Context, collectionID string, values map[string]any) (Record, error) {
	return service.create(ctx, collectionID, values, false)
}

func (service *Service) create(ctx context.Context, collectionID string, values map[string]any, applicationWrite bool) (Record, error) {
	return service.createWithPrincipal(ctx, collectionID, values, applicationWrite, nil)
}

func (service *Service) createWithPrincipal(ctx context.Context, collectionID string, values map[string]any, applicationWrite bool, principal *authorization.Principal) (Record, error) {
	prepared, err := service.prepareCreate(ctx, collectionID, values, applicationWrite, principal)
	if err != nil {
		return Record{}, err
	}
	releaseFiles, err := service.prepareFileValues(ctx, prepared.model.collection, prepared.values)
	if err != nil {
		return Record{}, err
	}
	defer releaseFiles()
	var record Record
	var event recordevents.Event
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var createErr error
		record, event, createErr = service.persistPreparedCreate(ctx, tx, prepared, true)
		return createErr
	})
	if err != nil {
		return Record{}, err
	}
	service.completeCommittedMutation(ctx, event)
	return record, nil
}

// CreateInTransaction 通过调用方拥有的事务插入 Profile Record，供调用方与 Auth Collection Credential 等耐久状态原子写入。
// 此方法不会对调用方进行授权。
func (service *Service) CreateInTransaction(ctx context.Context, tx storage.Executor, collectionID string, values map[string]any) (Record, error) {
	if tx == nil {
		return Record{}, fmt.Errorf("%w: caller transaction is required", ErrInvalidArgument)
	}
	if service.lifecycle != nil {
		return Record{}, ErrLifecyclePreparationRequired
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Record{}, err
	}
	validated, err := service.validateWriteValues(model, values)
	if err != nil {
		return Record{}, err
	}
	if err := validateFileValues(model.collection, validated); err != nil {
		return Record{}, err
	}
	if hasFileFieldValue(model.collection, validated) {
		return Record{}, fmt.Errorf("%w: external transaction Record writes do not accept File Fields", ErrInvalidArgument)
	}
	targets, err := service.relationTargets(ctx, model)
	if err != nil {
		return Record{}, err
	}
	id, err := newRecordID()
	if err != nil {
		return Record{}, err
	}
	occurredAt := service.now().UTC()
	now := occurredAt.Format(time.RFC3339Nano)
	record := Record{ID: id, CreatedAt: now, UpdatedAt: now, Values: validated}
	if err := createInTransaction(ctx, tx, model, targets, record); err != nil {
		return Record{}, err
	}
	if _, err := service.appendRecordEvent(ctx, tx, model, recordevents.Created, Record{}, record, occurredAt); err != nil {
		return Record{}, err
	}
	return record, nil
}

func createInTransaction(ctx context.Context, tx storage.Executor, model appliedModel, targets map[string]appliedModel, record Record) error {
	if err := verifyModel(ctx, tx, model); err != nil {
		return err
	}
	if err := validateRelations(ctx, tx, model, record.Values, targets); err != nil {
		return err
	}
	statement, args, err := insertStatement(model, record)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, statement, args...); err != nil {
		return mapWriteError(err)
	}
	return nil
}

func (service *Service) Update(ctx context.Context, collectionID, recordID string, values map[string]any) (Record, error) {
	return service.update(ctx, collectionID, recordID, values, false)
}

func (service *Service) update(ctx context.Context, collectionID, recordID string, values map[string]any, applicationWrite bool) (Record, error) {
	return service.updateWithPrincipal(ctx, collectionID, recordID, values, applicationWrite, nil)
}

func (service *Service) updateWithPrincipal(ctx context.Context, collectionID, recordID string, values map[string]any, applicationWrite bool, principal *authorization.Principal) (Record, error) {
	if values == nil {
		return Record{}, fmt.Errorf("%w: values are required", ErrInvalidArgument)
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Record{}, err
	}
	if !applicationWrite && model.collection.Type == backendmodel.CollectionTypeAuth {
		return Record{}, ErrAuthCollectionWriteRequiresAuthAPI
	}
	targets, err := service.relationTargets(ctx, model)
	if err != nil {
		return Record{}, err
	}
	var previous Record
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := verifyModel(ctx, snapshot, model); err != nil {
			return err
		}
		var readErr error
		previous, readErr = getRecord(ctx, snapshot, model, recordID)
		return readErr
	})
	if err != nil {
		return Record{}, err
	}
	merged := make(map[string]any, len(previous.Values)+len(values))
	for key, value := range previous.Values {
		merged[key] = value
	}
	for key, value := range values {
		merged[key] = value
	}
	validated, err := backendmodel.ValidateRecordValues(model.collection, merged)
	if err != nil {
		return Record{}, mapModelError(err)
	}
	fillOptionalValues(model.collection, validated)
	if err := validateFileValues(model.collection, validated); err != nil {
		return Record{}, err
	}
	previousSnapshot, err := recordSnapshot(previous)
	if err != nil {
		return Record{}, err
	}
	if service.lifecycle != nil {
		validated, err = service.lifecycle.Before(ctx, recordlifecycle.BeforeChange{
			CollectionID: collectionID,
			RecordID:     previous.ID,
			Operation:    recordlifecycle.Update,
			ModelVersion: model.collection.SchemaVersion,
			Values:       cloneValues(validated),
			Previous:     previousSnapshot,
		})
		if err != nil {
			return Record{}, err
		}
		validated, err = backendmodel.ValidateRecordValues(model.collection, validated)
		if err != nil {
			return Record{}, mapModelError(err)
		}
		fillOptionalValues(model.collection, validated)
		if err := validateFileValues(model.collection, validated); err != nil {
			return Record{}, err
		}
	}
	if principal != nil && service.lifecycle != nil {
		if err := service.authorize(ctx, collectionID, authorization.OperationUpdate, *principal, &authorization.Record{ID: previous.ID, Values: validated}); err != nil {
			return Record{}, err
		}
	}
	releaseFiles, err := service.prepareFileValues(ctx, model.collection, validated)
	if err != nil {
		return Record{}, err
	}
	defer releaseFiles()
	var updated Record
	var event recordevents.Event
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := verifyModel(ctx, tx, model); err != nil {
			return err
		}
		current, err := getRecord(ctx, tx, model, recordID)
		if err != nil {
			return err
		}
		if !sameRecordState(previous, current) {
			return fmt.Errorf("%w: Record changed while the lifecycle Hook was running; retry the operation", ErrConflict)
		}
		if principal != nil {
			if err := service.authorizeInTransaction(ctx, tx, collectionID, authorization.OperationUpdate, *principal, authorizedRecord(current)); err != nil {
				return err
			}
		}
		if err := validateFileValues(model.collection, validated); err != nil {
			return err
		}
		if err := validateRelations(ctx, tx, model, validated, targets); err != nil {
			return err
		}
		occurredAt := service.now().UTC()
		updated = Record{ID: previous.ID, CreatedAt: previous.CreatedAt, UpdatedAt: occurredAt.Format(time.RFC3339Nano), Values: validated}
		statement, args, err := updateStatement(model, updated)
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, statement, args...)
		if err != nil {
			return mapWriteError(err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("read Record update result: %w", err)
		}
		if count != 1 {
			return fmt.Errorf("%w: Record does not exist", ErrNotFound)
		}
		event, err = service.appendRecordEvent(ctx, tx, model, recordevents.Updated, previous, updated, occurredAt)
		if err != nil {
			return err
		}
		return service.appendAfterIntent(ctx, tx, event)
	})
	if err == nil {
		service.completeCommittedMutation(ctx, event)
	}
	return updated, err
}

func (service *Service) Delete(ctx context.Context, collectionID, recordID string) error {
	return service.delete(ctx, collectionID, recordID, false, nil)
}

func (service *Service) delete(ctx context.Context, collectionID, recordID string, applicationWrite bool, principal *authorization.Principal) error {
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return err
	}
	if !applicationWrite && model.collection.Type == backendmodel.CollectionTypeAuth {
		return ErrAuthCollectionWriteRequiresAuthAPI
	}
	references, err := service.relationReferences(ctx, collectionID)
	if err != nil {
		return err
	}
	var previous Record
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := verifyModel(ctx, snapshot, model); err != nil {
			return err
		}
		var readErr error
		previous, readErr = getRecord(ctx, snapshot, model, recordID)
		return readErr
	})
	if err != nil {
		return err
	}
	previousSnapshot, err := recordSnapshot(previous)
	if err != nil {
		return err
	}
	if service.lifecycle != nil {
		if _, err := service.lifecycle.Before(ctx, recordlifecycle.BeforeChange{
			CollectionID: collectionID,
			RecordID:     previous.ID,
			Operation:    recordlifecycle.Delete,
			ModelVersion: model.collection.SchemaVersion,
			Previous:     previousSnapshot,
		}); err != nil {
			return err
		}
	}
	var event recordevents.Event
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := verifyModel(ctx, tx, model); err != nil {
			return err
		}
		current, err := getRecord(ctx, tx, model, recordID)
		if err != nil {
			return err
		}
		if !sameRecordState(previous, current) {
			return fmt.Errorf("%w: Record changed while the lifecycle Hook was running; retry the operation", ErrConflict)
		}
		if principal != nil {
			if err := service.authorizeInTransaction(ctx, tx, collectionID, authorization.OperationDelete, *principal, authorizedRecord(current)); err != nil {
				return err
			}
		}
		if err := ensureNoReferences(ctx, tx, collectionID, recordID, references); err != nil {
			return err
		}
		table, err := storage.QuoteSQLiteIdentifier(model.projection.TableName)
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE "id" = ?`, recordID)
		if err != nil {
			return fmt.Errorf("delete Record: %w", err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("read Record delete result: %w", err)
		}
		if count != 1 {
			return fmt.Errorf("%w: Record does not exist", ErrNotFound)
		}
		event, err = service.appendRecordEvent(ctx, tx, model, recordevents.Deleted, previous, Record{}, service.now().UTC())
		if err != nil {
			return err
		}
		return service.appendAfterIntent(ctx, tx, event)
	})
	if err == nil {
		service.completeCommittedMutation(ctx, event)
	}
	return err
}

func (service *Service) appendRecordEvent(ctx context.Context, tx storage.Executor, model appliedModel, eventType recordevents.Type, before, after Record, occurredAt time.Time) (recordevents.Event, error) {
	if service.events == nil {
		return recordevents.Event{}, nil
	}
	var beforeSnapshot, afterSnapshot map[string]any
	var err error
	if before.ID != "" {
		beforeSnapshot, err = recordSnapshot(before)
		if err != nil {
			return recordevents.Event{}, err
		}
	}
	if after.ID != "" {
		afterSnapshot, err = recordSnapshot(after)
		if err != nil {
			return recordevents.Event{}, err
		}
	}
	recordID := after.ID
	if recordID == "" {
		recordID = before.ID
	}
	return service.events.AppendEventInTransaction(ctx, tx, recordevents.Mutation{
		CollectionID:  model.collection.ID,
		RecordID:      recordID,
		Type:          eventType,
		OccurredAt:    occurredAt,
		SchemaVersion: model.collection.SchemaVersion,
		Before:        beforeSnapshot,
		After:         afterSnapshot,
	})
}

func recordSnapshot(record Record) (map[string]any, error) {
	encoded, err := json.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("encode Record Event authorization snapshot: %w", err)
	}
	var snapshot map[string]any
	if err := json.Unmarshal(encoded, &snapshot); err != nil {
		return nil, fmt.Errorf("decode Record Event authorization snapshot: %w", err)
	}
	if snapshot == nil {
		return nil, errors.New("Record Event authorization snapshot is not an object")
	}
	return snapshot, nil
}

// PublishRecordEventsCommitted wakes subscribers after a caller-owned Record transaction commits.
func (service *Service) PublishRecordEventsCommitted(collectionID string) {
	if service != nil && service.events != nil {
		service.events.PublishCommitted(collectionID)
	}
}

func newRecordID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate Record ID: %w", err)
	}
	return "rec_" + hex.EncodeToString(value[:]), nil
}
