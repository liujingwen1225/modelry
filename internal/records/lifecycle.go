package records

import (
	"bytes"
	"context"
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

var ErrLifecyclePreparationRequired = errors.New("Record lifecycle must be prepared before opening the caller transaction")

type PreparedCreate struct {
	service   *Service
	model     appliedModel
	targets   map[string]appliedModel
	values    map[string]any
	principal *authorization.Principal
	id        string
	used      bool
	record    Record
	event     recordevents.Event
}

// Values 返回 Before Hook 处理后的已验证值副本，供调用方在开启事务前执行领域校验。
func (prepared *PreparedCreate) Values() map[string]any {
	if prepared == nil {
		return nil
	}
	return cloneValues(prepared.values)
}

// SetPreparedCreateValues 允许调用方在领域归一化后替换尚未消费的值，并重新执行 Model 校验。
func (service *Service) SetPreparedCreateValues(prepared *PreparedCreate, values map[string]any) error {
	if prepared == nil || prepared.service != service || prepared.used || values == nil {
		return fmt.Errorf("%w: an unconsumed prepared Record and values are required", ErrInvalidArgument)
	}
	validated, err := backendmodel.ValidateRecordValues(prepared.model.collection, values)
	if err != nil {
		return mapModelError(err)
	}
	fillOptionalValues(prepared.model.collection, validated)
	if err := validateFileValues(prepared.model.collection, validated); err != nil {
		return err
	}
	for _, field := range prepared.model.collection.Fields {
		if field.Type == backendmodel.FieldTypeFile && validated[field.Name] != nil {
			return fmt.Errorf("%w: caller-owned Auth transactions do not accept File Fields", ErrInvalidArgument)
		}
	}
	prepared.values = validated
	return nil
}

func (service *Service) prepareCreate(ctx context.Context, collectionID string, values map[string]any, applicationWrite bool, principal *authorization.Principal) (*PreparedCreate, error) {
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return nil, err
	}
	if !applicationWrite && model.collection.Type == backendmodel.CollectionTypeAuth {
		return nil, ErrAuthCollectionWriteRequiresAuthAPI
	}
	validated, err := backendmodel.ValidateRecordValues(model.collection, values)
	if err != nil {
		return nil, mapModelError(err)
	}
	fillOptionalValues(model.collection, validated)
	if err := validateFileValues(model.collection, validated); err != nil {
		return nil, err
	}
	if principal != nil {
		if err := service.authorize(ctx, collectionID, authorization.OperationCreate, *principal, &authorization.Record{Values: validated}); err != nil {
			return nil, err
		}
	}
	if service.lifecycle != nil {
		validated, err = service.lifecycle.Before(ctx, recordlifecycle.BeforeChange{
			CollectionID: collectionID,
			Operation:    recordlifecycle.Create,
			ModelVersion: model.collection.SchemaVersion,
			Values:       cloneValues(validated),
		})
		if err != nil {
			return nil, err
		}
		validated, err = backendmodel.ValidateRecordValues(model.collection, validated)
		if err != nil {
			return nil, mapModelError(err)
		}
		fillOptionalValues(model.collection, validated)
		if err := validateFileValues(model.collection, validated); err != nil {
			return nil, err
		}
		if principal != nil {
			if err := service.authorize(ctx, collectionID, authorization.OperationCreate, *principal, &authorization.Record{Values: validated}); err != nil {
				return nil, err
			}
		}
	}
	targets, err := service.relationTargets(ctx, model)
	if err != nil {
		return nil, err
	}
	id, err := newRecordID()
	if err != nil {
		return nil, err
	}
	var preparedPrincipal *authorization.Principal
	if principal != nil {
		principalCopy := *principal
		preparedPrincipal = &principalCopy
	}
	return &PreparedCreate{service: service, model: model, targets: targets, values: validated, principal: preparedPrincipal, id: id}, nil
}

func (service *Service) PrepareCreate(ctx context.Context, collectionID string, values map[string]any) (*PreparedCreate, error) {
	prepared, err := service.prepareCreate(ctx, collectionID, values, true, nil)
	if err != nil {
		return nil, err
	}
	for _, field := range prepared.model.collection.Fields {
		if field.Type == backendmodel.FieldTypeFile && prepared.values[field.Name] != nil {
			return nil, fmt.Errorf("%w: caller-owned Auth transactions do not accept File Fields", ErrInvalidArgument)
		}
	}
	return prepared, nil
}

func (service *Service) CreatePreparedInTransaction(ctx context.Context, tx storage.Executor, prepared *PreparedCreate) (Record, error) {
	record, _, err := service.persistPreparedCreate(ctx, tx, prepared, false)
	return record, err
}

func (service *Service) persistPreparedCreate(ctx context.Context, tx storage.Executor, prepared *PreparedCreate, allowFiles bool) (Record, recordevents.Event, error) {
	if tx == nil || prepared == nil || prepared.service != service || prepared.used {
		return Record{}, recordevents.Event{}, fmt.Errorf("%w: a new prepared Record and caller transaction are required", ErrInvalidArgument)
	}
	validated, err := backendmodel.ValidateRecordValues(prepared.model.collection, prepared.values)
	if err != nil {
		return Record{}, recordevents.Event{}, mapModelError(err)
	}
	fillOptionalValues(prepared.model.collection, validated)
	if !allowFiles {
		for _, field := range prepared.model.collection.Fields {
			if field.Type == backendmodel.FieldTypeFile && validated[field.Name] != nil {
				return Record{}, recordevents.Event{}, fmt.Errorf("%w: caller-owned Auth transactions do not accept File Fields", ErrInvalidArgument)
			}
		}
	}
	if err := validateFileValues(prepared.model.collection, validated); err != nil {
		return Record{}, recordevents.Event{}, err
	}
	if err := verifyModel(ctx, tx, prepared.model); err != nil {
		return Record{}, recordevents.Event{}, err
	}
	if prepared.principal != nil {
		if err := service.authorizeInTransaction(ctx, tx, prepared.model.collection.ID, authorization.OperationCreate, *prepared.principal, &authorization.Record{Values: validated}); err != nil {
			return Record{}, recordevents.Event{}, err
		}
	}
	occurredAt := service.now().UTC()
	now := occurredAt.Format(time.RFC3339Nano)
	record := Record{ID: prepared.id, CreatedAt: now, UpdatedAt: now, Values: validated}
	if err := createInTransaction(ctx, tx, prepared.model, prepared.targets, record); err != nil {
		return Record{}, recordevents.Event{}, err
	}
	event, err := service.appendRecordEvent(ctx, tx, prepared.model, recordevents.Created, Record{}, record, occurredAt)
	if err != nil {
		return Record{}, recordevents.Event{}, err
	}
	if err := service.appendAfterIntent(ctx, tx, event); err != nil {
		return Record{}, recordevents.Event{}, err
	}
	prepared.used = true
	prepared.record = record
	prepared.event = event
	return record, event, nil
}

func (service *Service) CompletePreparedCommit(ctx context.Context, prepared *PreparedCreate) {
	if prepared == nil || prepared.service != service || !prepared.used || prepared.event.ID == "" {
		return
	}
	service.completeCommittedMutation(ctx, prepared.event)
}

func cloneValues(values map[string]any) map[string]any {
	encoded, err := json.Marshal(values)
	if err != nil {
		return nil
	}
	var cloned map[string]any
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		return nil
	}
	return cloned
}

func sameRecordState(left, right Record) bool {
	if left.ID != right.ID || left.CreatedAt != right.CreatedAt || left.UpdatedAt != right.UpdatedAt {
		return false
	}
	leftValues, leftErr := json.Marshal(left.Values)
	rightValues, rightErr := json.Marshal(right.Values)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftValues, rightValues)
}

func (service *Service) appendAfterIntent(ctx context.Context, tx storage.Executor, event recordevents.Event) error {
	if service.lifecycle == nil || event.ID == "" {
		return nil
	}
	return service.lifecycle.AppendIntent(ctx, tx, event)
}

func (service *Service) completeCommittedMutation(ctx context.Context, event recordevents.Event) {
	if event.ID == "" {
		return
	}
	service.PublishRecordEventsCommitted(event.CollectionID)
	if service.lifecycle != nil {
		service.lifecycle.AfterCommit(ctx, event)
	}
}
