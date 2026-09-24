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
	files     *LocalFileStore
}

type Option func(*Service)

func WithAuthorization(evaluator authorization.Evaluator, sessions authorization.SessionAuthenticator) Option {
	return func(service *Service) {
		service.evaluator = evaluator
		service.sessions = sessions
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
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Record{}, err
	}
	if !applicationWrite && model.collection.Type == backendmodel.CollectionTypeAuth {
		return Record{}, ErrAuthCollectionWriteRequiresAuthAPI
	}
	validated, err := backendmodel.ValidateRecordValues(model.collection, values)
	if err != nil {
		return Record{}, mapModelError(err)
	}
	fillOptionalValues(model.collection, validated)
	if err := validateFileValues(model.collection, validated); err != nil {
		return Record{}, err
	}
	releaseFiles, err := service.prepareFileValues(model.collection, validated)
	if err != nil {
		return Record{}, err
	}
	defer releaseFiles()
	targets, err := service.relationTargets(ctx, model)
	if err != nil {
		return Record{}, err
	}
	id, err := newRecordID()
	if err != nil {
		return Record{}, err
	}
	now := service.now().UTC().Format(time.RFC3339Nano)
	record := Record{ID: id, CreatedAt: now, UpdatedAt: now, Values: validated}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		return createInTransaction(ctx, tx, model, targets, record)
	})
	if err != nil {
		return Record{}, err
	}
	return record, nil
}

// CreateInTransaction 通过调用方拥有的事务插入 Profile Record，供调用方与 Auth Collection Credential 等耐久状态原子写入。
// 此方法不会对调用方进行授权。
func (service *Service) CreateInTransaction(ctx context.Context, tx storage.Executor, collectionID string, values map[string]any) (Record, error) {
	if tx == nil {
		return Record{}, fmt.Errorf("%w: caller transaction is required", ErrInvalidArgument)
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
	for _, field := range model.collection.Fields {
		if field.Type == backendmodel.FieldTypeFile && validated[field.Name] != nil {
			return Record{}, fmt.Errorf("%w: external transaction Record writes do not accept File Fields", ErrInvalidArgument)
		}
	}
	targets, err := service.relationTargets(ctx, model)
	if err != nil {
		return Record{}, err
	}
	id, err := newRecordID()
	if err != nil {
		return Record{}, err
	}
	now := service.now().UTC().Format(time.RFC3339Nano)
	record := Record{ID: id, CreatedAt: now, UpdatedAt: now, Values: validated}
	if err := createInTransaction(ctx, tx, model, targets, record); err != nil {
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
	if service.files != nil {
		service.files.mu.Lock()
		defer service.files.mu.Unlock()
	}
	var updated Record
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := verifyModel(ctx, tx, model); err != nil {
			return err
		}
		previous, err := getRecord(ctx, tx, model, recordID)
		if err != nil {
			return err
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
			return mapModelError(err)
		}
		fillOptionalValues(model.collection, validated)
		if err := validateFileValues(model.collection, validated); err != nil {
			return err
		}
		if err := service.prepareFileValuesLocked(model.collection, validated); err != nil {
			return err
		}
		if err := validateFileValues(model.collection, validated); err != nil {
			return err
		}
		if err := validateRelations(ctx, tx, model, validated, targets); err != nil {
			return err
		}
		updated = Record{ID: previous.ID, CreatedAt: previous.CreatedAt, UpdatedAt: service.now().UTC().Format(time.RFC3339Nano), Values: validated}
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
		return nil
	})
	return updated, err
}

func (service *Service) Delete(ctx context.Context, collectionID, recordID string) error {
	return service.delete(ctx, collectionID, recordID, false)
}

func (service *Service) delete(ctx context.Context, collectionID, recordID string, applicationWrite bool) error {
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
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := verifyModel(ctx, tx, model); err != nil {
			return err
		}
		if err := ensureNoReferences(ctx, tx, collectionID, recordID, references); err != nil {
			return err
		}
		table, err := backendmodel.QuoteSQLiteIdentifier(model.projection.TableName)
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
		return nil
	})
}

func newRecordID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate Record ID: %w", err)
	}
	return "rec_" + hex.EncodeToString(value[:]), nil
}
