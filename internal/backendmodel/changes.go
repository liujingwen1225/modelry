package backendmodel

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

type pendingRow struct {
	change         PendingChange
	operationsJSON string
	recoveryJSON   sql.NullString
}

func (service *Service) GetPendingChange(ctx context.Context, collectionID string) (PendingChange, bool, error) {
	var row pendingRow
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var err error
		row, err = loadPendingForCollection(ctx, snapshot, collectionID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	})
	if err != nil {
		return PendingChange{}, false, err
	}
	if row.change.ChangeSetID == "" {
		return PendingChange{}, false, nil
	}
	return row.change, true, nil
}

func (service *Service) SaveOperation(ctx context.Context, collectionID string, input PendingOperationInput) (PendingChange, error) {
	if !validOpaqueID(collectionID, "col_") {
		return PendingChange{}, fmt.Errorf("%w: invalid Collection ID", ErrInvalidArgument)
	}
	var result PendingChange
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		row, err := loadPendingForCollection(ctx, tx, collectionID)
		if errors.Is(err, sql.ErrNoRows) {
			changeID, err := newID("chg_")
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			row = pendingRow{change: PendingChange{ChangeSetID: changeID, CollectionID: collectionID, Version: 0, Status: ChangeReady, Operations: []PendingOperation{}, CreatedAt: now, UpdatedAt: now}}
		} else if err != nil {
			return err
		}
		if err := ensureNoInProgressAttempt(ctx, tx, row.change.ChangeSetID); err != nil {
			return err
		}
		operation, err := normalizeOperationInput(ctx, tx, collection, input, "", nil)
		if err != nil {
			return err
		}
		row.change.Operations = append(row.change.Operations, operation)
		if _, err := applyOperations(collection, row.change.Operations); err != nil {
			return err
		}
		row.change.Version++
		row.change.Status = ChangeReady
		row.change.Recovery = nil
		row.change.UpdatedAt = time.Now().UTC()
		if err := persistPending(ctx, tx, &row, row.change.Version == 1); err != nil {
			return err
		}
		result = row.change
		return nil
	})
	if err != nil {
		return PendingChange{}, err
	}
	return result, nil
}

func (service *Service) UpdateOperation(ctx context.Context, collectionID, operationID string, input PendingOperationInput) (PendingChange, error) {
	if !validOpaqueID(collectionID, "col_") || !validOpaqueID(operationID, "op_") {
		return PendingChange{}, fmt.Errorf("%w: invalid Collection or Pending Operation ID", ErrInvalidArgument)
	}
	var result PendingChange
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		row, err := loadPendingForCollection(ctx, tx, collectionID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: Collection has no Pending Change", ErrNotFound)
			}
			return err
		}
		if err := ensureNoInProgressAttempt(ctx, tx, row.change.ChangeSetID); err != nil {
			return err
		}
		index := -1
		for i := range row.change.Operations {
			if row.change.Operations[i].ID == operationID {
				index = i
				break
			}
		}
		if index < 0 {
			return fmt.Errorf("%w: Pending Operation %q does not exist", ErrNotFound, operationID)
		}
		prior := row.change.Operations[index]
		updated, err := normalizeOperationInput(ctx, tx, collection, input, operationID, &prior)
		if err != nil {
			return err
		}
		updated.CreatedAt = row.change.Operations[index].CreatedAt
		row.change.Operations[index] = updated
		if _, err := applyOperations(collection, row.change.Operations); err != nil {
			return err
		}
		row.change.Version++
		row.change.Status = ChangeReady
		row.change.Recovery = nil
		row.change.UpdatedAt = time.Now().UTC()
		if err := persistPending(ctx, tx, &row, false); err != nil {
			return err
		}
		result = row.change
		return nil
	})
	if err != nil {
		return PendingChange{}, err
	}
	return result, nil
}

func (service *Service) RemoveOperation(ctx context.Context, collectionID, operationID string) (PendingChange, error) {
	if !validOpaqueID(collectionID, "col_") || !validOpaqueID(operationID, "op_") {
		return PendingChange{}, fmt.Errorf("%w: invalid Collection or Pending Operation ID", ErrInvalidArgument)
	}
	var result PendingChange
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		row, err := loadPendingForCollection(ctx, tx, collectionID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: Collection has no Pending Change", ErrNotFound)
			}
			return err
		}
		if err := ensureNoInProgressAttempt(ctx, tx, row.change.ChangeSetID); err != nil {
			return err
		}
		index := -1
		for i := range row.change.Operations {
			if row.change.Operations[i].ID == operationID {
				index = i
				break
			}
		}
		if index < 0 {
			return fmt.Errorf("%w: Pending Operation %q does not exist", ErrNotFound, operationID)
		}
		row.change.Operations = append(row.change.Operations[:index], row.change.Operations[index+1:]...)
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		if _, err := applyOperations(collection, row.change.Operations); err != nil {
			return err
		}
		row.change.Version++
		row.change.UpdatedAt = time.Now().UTC()
		row.change.Recovery = nil
		if len(row.change.Operations) == 0 {
			row.change.Status = ChangeDiscarded
		} else {
			row.change.Status = ChangeReady
		}
		if err := persistPending(ctx, tx, &row, false); err != nil {
			return err
		}
		result = row.change
		return nil
	})
	if err != nil {
		return PendingChange{}, err
	}
	return result, nil
}

func normalizeOperationInput(ctx context.Context, query storage.Executor, collection Collection, input PendingOperationInput, operationID string, prior *PendingOperation) (PendingOperation, error) {
	if input.Kind != OperationField && input.Kind != OperationRelation && input.Kind != OperationIndex {
		return PendingOperation{}, fmt.Errorf("%w: operation kind must be field, relation, or index", ErrInvalidArgument)
	}
	if input.Action != OperationAdd && input.Action != OperationUpdate && input.Action != OperationRemove {
		return PendingOperation{}, fmt.Errorf("%w: operation action must be add, update, or remove", ErrInvalidArgument)
	}
	if prior != nil && (prior.Kind != input.Kind || prior.Action != input.Action) {
		return PendingOperation{}, fmt.Errorf("%w: a saved operation can change its definition but not its kind or action", ErrInvalidArgument)
	}
	targetID := input.TargetID
	if prior != nil {
		if targetID != "" && targetID != prior.TargetID {
			return PendingOperation{}, fmt.Errorf("%w: an operation target cannot be changed", ErrInvalidArgument)
		}
		targetID = prior.TargetID
	}
	now := time.Now().UTC()
	operation := PendingOperation{ID: operationID, Kind: input.Kind, Action: input.Action, TargetID: targetID, CreatedAt: now, UpdatedAt: now}
	if operation.ID == "" {
		var err error
		operation.ID, err = newID("op_")
		if err != nil {
			return PendingOperation{}, err
		}
	}
	if input.Action == OperationRemove {
		if !validTargetID(input.Kind, targetID) {
			return PendingOperation{}, fmt.Errorf("%w: remove operations require a valid target ID", ErrInvalidArgument)
		}
		operation.Definition = json.RawMessage(`{}`)
		return operation, nil
	}
	if len(input.Definition) == 0 || !isJSONObject(input.Definition) || !json.Valid(input.Definition) {
		return PendingOperation{}, fmt.Errorf("%w: operation definition must be a JSON object", ErrInvalidArgument)
	}
	if input.Kind == OperationIndex {
		var definition Index
		if err := json.Unmarshal(input.Definition, &definition); err != nil {
			return PendingOperation{}, fmt.Errorf("%w: invalid Index definition", ErrInvalidArgument)
		}
		if input.Action == OperationAdd {
			if prior == nil && definition.ID != "" {
				return PendingOperation{}, fmt.Errorf("%w: Index IDs are assigned by Modelry", ErrInvalidArgument)
			}
			if prior != nil {
				if definition.ID != "" && definition.ID != prior.TargetID {
					return PendingOperation{}, fmt.Errorf("%w: saved Index ID cannot be changed", ErrInvalidArgument)
				}
				definition.ID = prior.TargetID
			} else {
				id, err := newID("idx_")
				if err != nil {
					return PendingOperation{}, err
				}
				definition.ID = id
			}
			operation.TargetID = definition.ID
		} else {
			if !validOpaqueID(targetID, "idx_") || (definition.ID != "" && definition.ID != targetID) {
				return PendingOperation{}, fmt.Errorf("%w: Index updates require the matching Index ID", ErrInvalidArgument)
			}
			definition.ID = targetID
		}
		if err := validateIndex(definition); err != nil {
			return PendingOperation{}, err
		}
		definitionJSON, err := json.Marshal(definition)
		if err != nil {
			return PendingOperation{}, fmt.Errorf("encode Index definition: %w", err)
		}
		operation.Definition = definitionJSON
		return operation, nil
	}
	var definition Field
	if err := json.Unmarshal(input.Definition, &definition); err != nil {
		return PendingOperation{}, fmt.Errorf("%w: invalid Field definition", ErrInvalidArgument)
	}
	if input.Kind == OperationRelation {
		if definition.Type == "" {
			definition.Type = FieldTypeRelation
		}
		if definition.Type != FieldTypeRelation {
			return PendingOperation{}, fmt.Errorf("%w: relation operations require a relation Field", ErrInvalidArgument)
		}
	} else if definition.Type == FieldTypeRelation {
		return PendingOperation{}, fmt.Errorf("%w: relation Fields must use relation operations", ErrInvalidArgument)
	}
	if input.Action == OperationAdd {
		if (prior == nil && definition.ID != "") || definition.System {
			return PendingOperation{}, fmt.Errorf("%w: Field IDs and system status are assigned by Modelry", ErrInvalidArgument)
		}
		if prior != nil {
			if definition.ID != "" && definition.ID != prior.TargetID {
				return PendingOperation{}, fmt.Errorf("%w: saved Field ID cannot be changed", ErrInvalidArgument)
			}
			definition.ID = prior.TargetID
		} else {
			id, err := newID("fld_")
			if err != nil {
				return PendingOperation{}, err
			}
			definition.ID = id
		}
		operation.TargetID = definition.ID
	} else {
		if !validOpaqueID(targetID, "fld_") || (definition.ID != "" && definition.ID != targetID) {
			return PendingOperation{}, fmt.Errorf("%w: Field updates require the matching Field ID", ErrInvalidArgument)
		}
		definition.ID = targetID
	}
	if err := validateField(definition); err != nil {
		return PendingOperation{}, err
	}
	if definition.Type == FieldTypeRelation {
		if err := requireCollection(ctx, query, definition.Relation.TargetCollectionID); err != nil {
			return PendingOperation{}, err
		}
	}
	definitionJSON, err := json.Marshal(definition)
	if err != nil {
		return PendingOperation{}, fmt.Errorf("encode Field definition: %w", err)
	}
	operation.Definition = definitionJSON
	return operation, nil
}

func validTargetID(kind OperationKind, id string) bool {
	switch kind {
	case OperationField, OperationRelation:
		return validOpaqueID(id, "fld_")
	case OperationIndex:
		return validOpaqueID(id, "idx_")
	default:
		return false
	}
}

func validateIndex(index Index) error {
	if !validOpaqueID(index.ID, "idx_") {
		return fmt.Errorf("%w: Index ID is invalid", ErrInvalidArgument)
	}
	if !indexNamePattern.MatchString(index.Name) {
		return fmt.Errorf("%w: Index name must start with a letter and contain only letters, numbers, or underscores", ErrInvalidArgument)
	}
	if len(index.Fields) == 0 || len(index.Fields) > 16 {
		return fmt.Errorf("%w: Index must reference 1 to 16 Fields", ErrInvalidArgument)
	}
	seen := make(map[string]struct{}, len(index.Fields))
	for _, fieldID := range index.Fields {
		if !validOpaqueID(fieldID, "fld_") || strings.HasPrefix(fieldID, "fld_system_") {
			return fmt.Errorf("%w: Index Fields must refer to ordinary Fields", ErrInvalidArgument)
		}
		if _, exists := seen[fieldID]; exists {
			return fmt.Errorf("%w: Index cannot reference a Field more than once", ErrInvalidArgument)
		}
		seen[fieldID] = struct{}{}
	}
	return nil
}

func requireCollection(ctx context.Context, query storage.Executor, collectionID string) error {
	if !validOpaqueID(collectionID, "col_") {
		return fmt.Errorf("%w: relation target Collection ID is invalid", ErrInvalidArgument)
	}
	var id string
	if err := query.QueryRowContext(ctx, `SELECT id FROM modelry_backend_collections WHERE id = ?`, collectionID).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: relation target Collection does not exist", ErrInvalidArgument)
		}
		return fmt.Errorf("read relation target Collection: %w", err)
	}
	return nil
}

func loadPendingForCollection(ctx context.Context, query storage.Executor, collectionID string) (pendingRow, error) {
	if !validOpaqueID(collectionID, "col_") {
		return pendingRow{}, fmt.Errorf("%w: invalid Collection ID", ErrInvalidArgument)
	}
	statement := `SELECT id, version, status, operations_json, recovery_json, created_at, updated_at FROM modelry_backend_changes WHERE collection_id = ? AND status IN ('ready', 'needsReview', 'failed')`
	statement += ` ORDER BY updated_at DESC, id DESC LIMIT 1`
	var row pendingRow
	var status, createdAt, updatedAt string
	if err := query.QueryRowContext(ctx, statement, collectionID).Scan(&row.change.ChangeSetID, &row.change.Version, &status, &row.operationsJSON, &row.recoveryJSON, &createdAt, &updatedAt); err != nil {
		return pendingRow{}, err
	}
	row.change.CollectionID = collectionID
	row.change.Status = ChangeStatus(status)
	row.change.CreatedAt, _ = parseTimestamp(createdAt)
	row.change.UpdatedAt, _ = parseTimestamp(updatedAt)
	if err := json.Unmarshal([]byte(row.operationsJSON), &row.change.Operations); err != nil {
		return pendingRow{}, fmt.Errorf("decode durable Pending Operations: %w", err)
	}
	if row.change.Operations == nil {
		row.change.Operations = make([]PendingOperation, 0)
	}
	if row.recoveryJSON.Valid {
		var recovery RecoveryState
		if err := json.Unmarshal([]byte(row.recoveryJSON.String), &recovery); err != nil {
			return pendingRow{}, fmt.Errorf("decode durable schema recovery: %w", err)
		}
		row.change.Recovery = &recovery
	}
	return row, nil
}

func persistPending(ctx context.Context, tx storage.Executor, row *pendingRow, insert bool) error {
	operationsJSON, err := json.Marshal(row.change.Operations)
	if err != nil {
		return fmt.Errorf("encode durable Pending Operations: %w", err)
	}
	var recoveryJSON any
	if row.change.Recovery != nil {
		encoded, err := json.Marshal(row.change.Recovery)
		if err != nil {
			return fmt.Errorf("encode schema recovery state: %w", err)
		}
		recoveryJSON = string(encoded)
	}
	if insert {
		_, err = tx.ExecContext(ctx, `INSERT INTO modelry_backend_changes (id, collection_id, version, status, operations_json, recovery_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, row.change.ChangeSetID, row.change.CollectionID, row.change.Version, row.change.Status, string(operationsJSON), recoveryJSON, timestamp(row.change.CreatedAt), timestamp(row.change.UpdatedAt))
	} else {
		result, updateErr := tx.ExecContext(ctx, `UPDATE modelry_backend_changes SET version = ?, status = ?, operations_json = ?, recovery_json = ?, updated_at = ? WHERE id = ? AND version = ?`, row.change.Version, row.change.Status, string(operationsJSON), recoveryJSON, timestamp(row.change.UpdatedAt), row.change.ChangeSetID, row.change.Version-1)
		err = updateErr
		if err == nil {
			count, countErr := result.RowsAffected()
			if countErr != nil {
				return fmt.Errorf("verify Pending Change version update: %w", countErr)
			}
			if count != 1 {
				return fmt.Errorf("%w: Pending Change changed while it was being edited", ErrConflict)
			}
		}
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return fmt.Errorf("%w: this Collection already has an active Pending Change", ErrConflict)
		}
		return fmt.Errorf("persist Pending Change: %w", err)
	}
	return nil
}

func ensureNoInProgressAttempt(ctx context.Context, query storage.Executor, changeSetID string) error {
	var exists int
	err := query.QueryRowContext(ctx, `SELECT 1 FROM modelry_backend_apply_attempts WHERE change_set_id = ? AND status = ? LIMIT 1`, changeSetID, AttemptInProgress).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("check schema apply status: %w", err)
	}
	return fmt.Errorf("%w: a schema Apply is already in progress", ErrConflict)
}

func (service *Service) Preview(ctx context.Context, collectionID string, expectedVersion int) (SchemaPreview, error) {
	if expectedVersion < 1 {
		return SchemaPreview{}, fmt.Errorf("%w: expected schema version must be positive", ErrInvalidArgument)
	}
	var preview SchemaPreview
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		collection, err := loadCollection(ctx, snapshot, collectionID)
		if err != nil {
			return err
		}
		row, err := loadPendingForCollection(ctx, snapshot, collectionID)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: Collection has no Pending Change", ErrNotFound)
		}
		if err != nil {
			return err
		}
		if row.change.Version != expectedVersion {
			return fmt.Errorf("%w: Pending Change is at version %d, not %d", ErrConflict, row.change.Version, expectedVersion)
		}
		preview, err = evaluateChange(ctx, snapshot, collection, row.change)
		return err
	})
	return preview, err
}

func evaluateChange(ctx context.Context, query storage.Executor, current Collection, change PendingChange) (SchemaPreview, error) {
	preview := SchemaPreview{Risk: RiskSafe, Diff: make([]DiffItem, 0, len(change.Operations)), Preconditions: make([]Precondition, 0), Version: change.Version}
	target, err := applyOperations(current, change.Operations)
	if err != nil {
		preview.Risk = RiskBlocked
		preview.Preconditions = append(preview.Preconditions, Precondition{Code: "INVALID_MODEL", Status: "failed", Message: err.Error()})
		preview.Impact = Impact{AffectedCollections: 1, Summary: "Pending schema changes cannot be applied until the model is valid."}
		return preview, nil
	}
	preview.Diff = buildDiff(current, target, change.Operations)
	count, err := countCollectionRecords(ctx, query, current.ID)
	if err != nil {
		return SchemaPreview{}, err
	}
	preview.Impact = Impact{AffectedCollections: 1, AffectedRecords: count, AffectedFields: countChangedFields(preview.Diff), AffectedIndexes: countChangedIndexes(preview.Diff), Summary: impactSummary(preview.Diff, count)}
	preconditions, err := checkTargetPreconditions(ctx, query, current, target, count)
	if err != nil {
		return SchemaPreview{}, err
	}
	preview.Preconditions = preconditions
	for _, item := range preview.Diff {
		if diffNeedsReview(current, target, item) {
			preview.Risk = RiskReview
			break
		}
	}
	for _, precondition := range preconditions {
		if precondition.Status == "failed" {
			preview.Risk = RiskBlocked
			break
		}
	}
	return preview, nil
}

func checkTargetPreconditions(ctx context.Context, query storage.Executor, current, target Collection, recordCount int64) ([]Precondition, error) {
	result := make([]Precondition, 0)
	oldFields := make(map[string]Field, len(current.Fields))
	for _, field := range current.Fields {
		oldFields[field.ID] = field
	}
	for _, field := range target.Fields {
		if field.System {
			continue
		}
		if field.Type == FieldTypeRelation {
			if err := requireCollection(ctx, query, field.Relation.TargetCollectionID); err != nil {
				result = append(result, Precondition{Code: "RELATION_TARGET_MISSING", Status: "failed", Message: fmt.Sprintf("Relation field %q points to a Collection that no longer exists.", field.Name)})
			}
		}
		previous, existed := oldFields[field.ID]
		if !existed {
			if recordCount > 0 && field.Required && (len(field.Default) == 0 || string(field.Default) == "null") {
				result = append(result, Precondition{Code: "REQUIRED_FIELD_NEEDS_DEFAULT", Status: "failed", Message: fmt.Sprintf("Required field %q needs a default because %d existing Records have no value for it.", field.Name, recordCount)})
			}
			continue
		}
		if field.System || sameField(previous, field) {
			continue
		}
		precondition, err := checkExistingFieldValues(ctx, query, current, previous, field)
		if err != nil {
			return nil, err
		}
		if precondition != nil {
			result = append(result, *precondition)
		}
	}
	conflicts, err := uniqueConflictCountForModel(ctx, query, current, target)
	if err != nil {
		return nil, err
	}
	if conflicts > 0 {
		result = append(result, Precondition{Code: "UNIQUE_VALUES_CONFLICT", Status: "failed", Message: fmt.Sprintf("%d duplicate value group(s) prevent the requested unique constraint.", conflicts)})
	}
	if len(result) == 0 {
		result = append(result, Precondition{Code: "MODEL_COMPATIBLE", Status: "passed", Message: "The pending model is compatible with current Records and relation targets."})
	}
	return result, nil
}

func checkExistingFieldValues(ctx context.Context, query storage.Executor, current Collection, previous, target Field) (*Precondition, error) {
	quotedTable, err := QuoteSQLiteIdentifier(recordsTableName(current.ID))
	if err != nil {
		return nil, err
	}
	quotedColumn, err := QuoteSQLiteIdentifier(fieldColumnName(previous))
	if err != nil {
		return nil, err
	}
	rows, err := query.QueryContext(ctx, "SELECT "+quotedColumn+" FROM "+quotedTable)
	if err != nil {
		return nil, fmt.Errorf("inspect existing values for Field %q: %w", target.Name, err)
	}
	defer rows.Close()
	for rows.Next() {
		var raw any
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("read existing values for Field %q: %w", target.Name, err)
		}
		value, err := decodeStoredValue(target, raw)
		if err != nil {
			return &Precondition{Code: "FIELD_VALUE_INCOMPATIBLE", Status: "failed", Message: fmt.Sprintf("Existing values in field %q do not match the updated type.", target.Name)}, nil
		}
		if err := validateFieldValue(target, value, true); err != nil {
			return &Precondition{Code: "FIELD_VALUE_INCOMPATIBLE", Status: "failed", Message: fmt.Sprintf("Existing values in field %q do not satisfy the updated type or validation.", target.Name)}, nil
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("finish checking existing Field values: %w", err)
	}
	return nil, nil
}

func decodeStoredValue(field Field, raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	text := ""
	switch value := raw.(type) {
	case string:
		text = value
	case []byte:
		text = string(value)
	case int64:
		switch field.Type {
		case FieldTypeBoolean:
			if value != 0 && value != 1 {
				return nil, errors.New("boolean value is outside its domain")
			}
			return value == 1, nil
		case FieldTypeNumber:
			return json.Number(strconv.FormatInt(value, 10)), nil
		default:
			text = strconv.FormatInt(value, 10)
		}
	case float64:
		if field.Type == FieldTypeNumber {
			return json.Number(strconv.FormatFloat(value, 'g', -1, 64)), nil
		}
		text = strconv.FormatFloat(value, 'g', -1, 64)
	default:
		return nil, fmt.Errorf("unsupported stored value %T", raw)
	}
	switch field.Type {
	case FieldTypeText, FieldTypeDateTime, FieldTypeFile:
		return text, nil
	case FieldTypeNumber:
		if _, err := strconv.ParseFloat(text, 64); err != nil {
			return nil, err
		}
		return json.Number(text), nil
	case FieldTypeBoolean:
		switch text {
		case "0", "false":
			return false, nil
		case "1", "true":
			return true, nil
		default:
			return nil, errors.New("boolean value is outside its domain")
		}
	case FieldTypeJSON, FieldTypeRelation:
		var value any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err == nil {
			return value, nil
		}
		if field.Type == FieldTypeRelation {
			return text, nil
		}
		return nil, errors.New("stored JSON is invalid")
	default:
		return nil, fmt.Errorf("unsupported field type %q", field.Type)
	}
}

func uniqueConflictCountForModel(ctx context.Context, query storage.Executor, current, target Collection) (int64, error) {
	quotedTable, err := QuoteSQLiteIdentifier(recordsTableName(current.ID))
	if err != nil {
		return 0, err
	}
	oldFields := make(map[string]Field, len(current.Fields))
	for _, field := range current.Fields {
		oldFields[field.ID] = field
	}
	var total int64
	check := func(fields []Field) error {
		selectExprs, groups, nonNull := make([]string, 0, len(fields)), make([]string, 0, len(fields)), make([]string, 0, len(fields))
		for i, field := range fields {
			if old, ok := oldFields[field.ID]; ok {
				quoted, err := QuoteSQLiteIdentifier(fieldColumnName(old))
				if err != nil {
					return err
				}
				alias := fmt.Sprintf("k%d", i)
				selectExprs = append(selectExprs, quoted+" AS "+alias)
				groups = append(groups, alias)
				nonNull = append(nonNull, alias+" IS NOT NULL")
			} else {
				literal, err := defaultLiteral(field)
				if err != nil {
					return err
				}
				alias := fmt.Sprintf("k%d", i)
				selectExprs = append(selectExprs, literal+" AS "+alias)
				groups = append(groups, alias)
				nonNull = append(nonNull, alias+" IS NOT NULL")
			}
		}
		sqlText := "SELECT COUNT(*) FROM (SELECT " + strings.Join(selectExprs, ", ") + " FROM " + quotedTable + " GROUP BY " + strings.Join(groups, ", ") + " HAVING COUNT(*) > 1 AND " + strings.Join(nonNull, " AND ") + ")"
		var conflicts int64
		if err := query.QueryRowContext(ctx, sqlText).Scan(&conflicts); err != nil {
			return fmt.Errorf("check pending unique constraints: %w", err)
		}
		total += conflicts
		return nil
	}
	for _, field := range target.Fields {
		if !field.System && field.Unique {
			if err := check([]Field{field}); err != nil {
				return total, err
			}
		}
	}
	for _, index := range target.Indexes {
		if !index.Unique {
			continue
		}
		fields := make([]Field, 0, len(index.Fields))
		for _, fieldID := range index.Fields {
			field, found := fieldByID(target.Fields, fieldID)
			if !found || field.System {
				return total, fmt.Errorf("%w: Index %q refers to a missing Field", ErrInvalidArgument, index.Name)
			}
			fields = append(fields, field)
		}
		if err := check(fields); err != nil {
			return total, err
		}
	}
	return total, nil
}

func defaultLiteral(field Field) (string, error) {
	if len(field.Default) == 0 {
		return "NULL", nil
	}
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(field.Default)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return "", fmt.Errorf("decode Field default: %w", err)
	}
	switch typed := value.(type) {
	case nil:
		return "NULL", nil
	case string:
		return "'" + strings.ReplaceAll(typed, "'", "''") + "'", nil
	case bool:
		if typed {
			return "1", nil
		}
		return "0", nil
	case json.Number:
		if _, err := typed.Float64(); err != nil {
			return "", fmt.Errorf("invalid numeric default: %w", err)
		}
		return typed.String(), nil
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return "", fmt.Errorf("invalid numeric default")
		}
		return strconv.FormatFloat(typed, 'g', -1, 64), nil
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "", fmt.Errorf("encode structured Field default: %w", err)
		}
		return "'" + strings.ReplaceAll(string(encoded), "'", "''") + "'", nil
	}
}

func applyOperations(current Collection, operations []PendingOperation) (Collection, error) {
	target := cloneCollection(current)
	for _, operation := range operations {
		if operation.Action == OperationRemove {
			switch operation.Kind {
			case OperationField, OperationRelation:
				field, found := fieldByID(target.Fields, operation.TargetID)
				if !found || field.System {
					return Collection{}, fmt.Errorf("%w: Field %q cannot be removed", ErrInvalidArgument, operation.TargetID)
				}
				if target.Type == CollectionTypeAuth && field.Name == "email" {
					return Collection{}, fmt.Errorf("%w: Auth Collection email is a locked identifier Field", ErrInvalidArgument)
				}
				for i := range target.Fields {
					if target.Fields[i].ID == operation.TargetID {
						target.Fields = append(target.Fields[:i], target.Fields[i+1:]...)
						break
					}
				}
			case OperationIndex:
				_, found := indexByID(target.Indexes, operation.TargetID)
				if !found {
					return Collection{}, fmt.Errorf("%w: Index %q does not exist", ErrNotFound, operation.TargetID)
				}
				for i := range target.Indexes {
					if target.Indexes[i].ID == operation.TargetID {
						target.Indexes = append(target.Indexes[:i], target.Indexes[i+1:]...)
						break
					}
				}
			}
			continue
		}
		if operation.Kind == OperationIndex {
			var definition Index
			if err := json.Unmarshal(operation.Definition, &definition); err != nil {
				return Collection{}, fmt.Errorf("decode Pending Index definition: %w", err)
			}
			_, found := indexByID(target.Indexes, operation.TargetID)
			if operation.Action == OperationAdd {
				if found {
					return Collection{}, fmt.Errorf("%w: Index %q already exists", ErrConflict, operation.TargetID)
				}
				target.Indexes = append(target.Indexes, definition)
			} else {
				if !found {
					return Collection{}, fmt.Errorf("%w: Index %q does not exist", ErrNotFound, operation.TargetID)
				}
				for i := range target.Indexes {
					if target.Indexes[i].ID == operation.TargetID {
						target.Indexes[i] = definition
						break
					}
				}
			}
			continue
		}
		var definition Field
		if err := json.Unmarshal(operation.Definition, &definition); err != nil {
			return Collection{}, fmt.Errorf("decode Pending Field definition: %w", err)
		}
		field, found := fieldByID(target.Fields, operation.TargetID)
		if operation.Action == OperationAdd {
			if found {
				return Collection{}, fmt.Errorf("%w: Field %q already exists", ErrConflict, operation.TargetID)
			}
			target.Fields = append(target.Fields, definition)
		} else {
			if !found || field.System {
				return Collection{}, fmt.Errorf("%w: Field %q does not exist or is locked", ErrNotFound, operation.TargetID)
			}
			if target.Type == CollectionTypeAuth && field.Name == "email" && (definition.Name != "email" || definition.Type != FieldTypeText || !definition.Required || !definition.Unique) {
				return Collection{}, fmt.Errorf("%w: Auth Collection email must remain required, unique, and text", ErrInvalidArgument)
			}
			for i := range target.Fields {
				if target.Fields[i].ID == operation.TargetID {
					target.Fields[i] = definition
					break
				}
			}
		}
	}
	if err := validateModel(target); err != nil {
		return Collection{}, err
	}
	return target, nil
}

func validateModel(collection Collection) error {
	if !validOpaqueID(collection.ID, "col_") {
		return fmt.Errorf("%w: Collection ID is invalid", ErrInvalidArgument)
	}
	if collection.Type != CollectionTypeNormal && collection.Type != CollectionTypeAuth {
		return fmt.Errorf("%w: Collection type is invalid", ErrInvalidArgument)
	}
	fieldIDs := make(map[string]struct{}, len(collection.Fields))
	fieldNames := make(map[string]struct{}, len(collection.Fields))
	systemCount := 0
	for _, field := range collection.Fields {
		if field.System {
			systemCount++
			switch field.Name {
			case "id", "createdAt", "updatedAt":
			default:
				return fmt.Errorf("%w: unknown system field", ErrInvalidArgument)
			}
			continue
		}
		if !validOpaqueID(field.ID, "fld_") {
			return fmt.Errorf("%w: Field ID is invalid", ErrInvalidArgument)
		}
		if _, exists := fieldIDs[field.ID]; exists {
			return fmt.Errorf("%w: Field ID %q is duplicated", ErrInvalidArgument, field.ID)
		}
		fieldIDs[field.ID] = struct{}{}
		if err := validateField(field); err != nil {
			return err
		}
		key := strings.ToLower(field.Name)
		if _, exists := fieldNames[key]; exists {
			return fmt.Errorf("%w: duplicate Field name %q", ErrInvalidArgument, field.Name)
		}
		fieldNames[key] = struct{}{}
	}
	if systemCount != 3 {
		return fmt.Errorf("%w: the three locked system fields are required", ErrInvalidArgument)
	}
	if collection.Type == CollectionTypeAuth {
		email, found := fieldByName(collection.Fields, "email")
		if !found || email.System || email.Type != FieldTypeText || !email.Required || !email.Unique {
			return fmt.Errorf("%w: Auth Collection requires a unique, required text email Field", ErrInvalidArgument)
		}
	}
	indexIDs := make(map[string]struct{}, len(collection.Indexes))
	indexNames := make(map[string]struct{}, len(collection.Indexes))
	for _, index := range collection.Indexes {
		if err := validateIndex(index); err != nil {
			return err
		}
		if _, exists := indexIDs[index.ID]; exists {
			return fmt.Errorf("%w: Index ID %q is duplicated", ErrInvalidArgument, index.ID)
		}
		indexIDs[index.ID] = struct{}{}
		key := strings.ToLower(index.Name)
		if _, exists := indexNames[key]; exists {
			return fmt.Errorf("%w: duplicate Index name %q", ErrInvalidArgument, index.Name)
		}
		indexNames[key] = struct{}{}
		for _, fieldID := range index.Fields {
			if _, found := fieldIDs[fieldID]; !found {
				return fmt.Errorf("%w: Index %q refers to a missing Field", ErrInvalidArgument, index.Name)
			}
		}
	}
	return nil
}

func cloneCollection(collection Collection) Collection {
	cloned := collection
	cloned.Fields = make([]Field, len(collection.Fields))
	for i, field := range collection.Fields {
		cloned.Fields[i] = cloneField(field)
	}
	cloned.Indexes = make([]Index, len(collection.Indexes))
	for i, index := range collection.Indexes {
		cloned.Indexes[i] = index
		cloned.Indexes[i].Fields = append([]string(nil), index.Fields...)
	}
	return cloned
}

func indexByID(indexes []Index, id string) (Index, bool) {
	for _, index := range indexes {
		if index.ID == id {
			return index, true
		}
	}
	return Index{}, false
}

func sameField(left, right Field) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func buildDiff(current, target Collection, operations []PendingOperation) []DiffItem {
	diff := make([]DiffItem, 0, len(operations))
	for _, operation := range operations {
		item := DiffItem{Kind: operation.Kind, Action: operation.Action, TargetID: operation.TargetID}
		switch operation.Kind {
		case OperationField, OperationRelation:
			before, beforeFound := fieldByID(current.Fields, operation.TargetID)
			after, afterFound := fieldByID(target.Fields, operation.TargetID)
			if beforeFound {
				item.Name = before.Name
				item.Before, _ = json.Marshal(before)
			}
			if afterFound {
				item.Name = after.Name
				item.After, _ = json.Marshal(after)
			}
		case OperationIndex:
			before, beforeFound := indexByID(current.Indexes, operation.TargetID)
			after, afterFound := indexByID(target.Indexes, operation.TargetID)
			if beforeFound {
				item.Name = before.Name
				item.Before, _ = json.Marshal(before)
			}
			if afterFound {
				item.Name = after.Name
				item.After, _ = json.Marshal(after)
			}
		}
		diff = append(diff, item)
	}
	return diff
}

func diffNeedsReview(current, target Collection, diff DiffItem) bool {
	if diff.Kind == OperationIndex {
		return false
	}
	before, beforeFound := fieldByID(current.Fields, diff.TargetID)
	after, afterFound := fieldByID(target.Fields, diff.TargetID)
	if !beforeFound || !afterFound {
		return beforeFound && !afterFound
	}
	return before.Type != after.Type || before.Name != after.Name || before.Required != after.Required || before.Unique != after.Unique || !bytesEqual(before.Validation, after.Validation) || !bytesEqual(before.RelationJSON(), after.RelationJSON())
}

func (field Field) RelationJSON() json.RawMessage {
	if field.Relation == nil {
		return nil
	}
	encoded, _ := json.Marshal(field.Relation)
	return encoded
}

func bytesEqual(left, right []byte) bool {
	return string(left) == string(right)
}

func countChangedFields(diff []DiffItem) int {
	count := 0
	for _, item := range diff {
		if item.Kind == OperationField || item.Kind == OperationRelation {
			count++
		}
	}
	return count
}

func countChangedIndexes(diff []DiffItem) int {
	count := 0
	for _, item := range diff {
		if item.Kind == OperationIndex {
			count++
		}
	}
	return count
}

func impactSummary(diff []DiffItem, records int64) string {
	return fmt.Sprintf("%d schema operation(s) affect this Collection and its %d existing Record(s).", len(diff), records)
}

func encodeCursor(timeValue, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(timeValue + "\x00" + id))
}

func decodeCursor(cursor string) (string, string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", fmt.Errorf("%w: invalid pagination cursor", ErrInvalidArgument)
	}
	parts := strings.SplitN(string(decoded), "\x00", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("%w: invalid pagination cursor", ErrInvalidArgument)
	}
	if _, err := parseTimestamp(parts[0]); err != nil {
		return "", "", fmt.Errorf("%w: invalid pagination cursor", ErrInvalidArgument)
	}
	return parts[0], parts[1], nil
}
