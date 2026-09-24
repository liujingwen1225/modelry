package records

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) relationTargets(ctx context.Context, model appliedModel) (map[string]appliedModel, error) {
	targets := make(map[string]appliedModel)
	for _, field := range model.projection.Fields {
		if field.Type != backendmodel.FieldTypeRelation || field.Relation == nil {
			continue
		}
		targetID := field.Relation.TargetCollectionID
		if _, loaded := targets[targetID]; loaded {
			continue
		}
		target, err := service.loadModel(ctx, targetID)
		if err != nil {
			return nil, fmt.Errorf("relation Field %q target is unavailable: %w", field.Name, err)
		}
		targets[targetID] = target
	}
	return targets, nil
}

func validateRelations(ctx context.Context, tx storage.Executor, model appliedModel, values map[string]any, targets map[string]appliedModel) error {
	for _, field := range model.projection.Fields {
		if field.Type != backendmodel.FieldTypeRelation || field.Relation == nil {
			continue
		}
		value := values[field.Name]
		if value == nil {
			continue
		}
		target, exists := targets[field.Relation.TargetCollectionID]
		if !exists {
			return fmt.Errorf("%w: relation target is not part of the loaded Applied Model", ErrConflict)
		}
		if err := verifyModel(ctx, tx, target); err != nil {
			return err
		}
		ids, err := relationIDs(field, value)
		if err != nil {
			return err
		}
		table, err := storage.QuoteSQLiteIdentifier(target.projection.TableName)
		if err != nil {
			return err
		}
		for _, id := range ids {
			var exists int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM `+table+` WHERE "id" = ?`, id).Scan(&exists)
			if err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return fmt.Errorf("%w: relation Field %q refers to a missing target Record", ErrInvalidArgument, field.Name)
				}
				return fmt.Errorf("check relation Field %q target: %w", field.Name, err)
			}
		}
	}
	return nil
}

func relationIDs(field backendmodel.ProjectedField, value any) ([]string, error) {
	if field.Relation != nil && (field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many") {
		items, ok := value.([]any)
		if !ok {
			return nil, fmt.Errorf("%w: Relation Field %q must be a list of Record IDs", ErrInvalidArgument, field.Name)
		}
		ids := make([]string, len(items))
		for index, item := range items {
			id, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("%w: Relation Field %q must contain Record IDs", ErrInvalidArgument, field.Name)
			}
			ids[index] = id
		}
		return ids, nil
	}
	id, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("%w: Relation Field %q must contain a Record ID", ErrInvalidArgument, field.Name)
	}
	return []string{id}, nil
}

type relationReference struct {
	model appliedModel
	field backendmodel.ProjectedField
}

func (service *Service) relationReferences(ctx context.Context, targetCollectionID string) ([]relationReference, error) {
	var references []relationReference
	var cursor string
	for {
		page, err := service.models.ListCollections(ctx, backendmodel.ListOptions{Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, collection := range page.Data {
			model, err := service.loadModel(ctx, collection.ID)
			if err != nil {
				return nil, err
			}
			for _, field := range model.projection.Fields {
				if field.Type == backendmodel.FieldTypeRelation && field.Relation != nil && field.Relation.TargetCollectionID == targetCollectionID {
					references = append(references, relationReference{model: model, field: field})
				}
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	return references, nil
}

func ensureNoReferences(ctx context.Context, tx storage.Executor, targetCollectionID, targetRecordID string, references []relationReference) error {
	for _, reference := range references {
		if err := verifyModel(ctx, tx, reference.model); err != nil {
			return err
		}
		table, err := storage.QuoteSQLiteIdentifier(reference.model.projection.TableName)
		if err != nil {
			return err
		}
		column, err := storage.QuoteSQLiteIdentifier(reference.field.ColumnName)
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT "id", `+column+` FROM `+table+` WHERE `+column+` IS NOT NULL`)
		if err != nil {
			return fmt.Errorf("check Record relation references: %w", err)
		}
		for rows.Next() {
			var sourceID string
			var stored any
			if err := rows.Scan(&sourceID, &stored); err != nil {
				rows.Close()
				return fmt.Errorf("read Record relation references: %w", err)
			}
			if reference.model.collection.ID == targetCollectionID && sourceID == targetRecordID {
				continue
			}
			value, err := decodeField(reference.field, stored)
			if err != nil {
				rows.Close()
				return fmt.Errorf("decode Record relation references: %w", err)
			}
			ids, err := relationIDs(reference.field, value)
			if err != nil {
				rows.Close()
				return err
			}
			for _, id := range ids {
				if id == targetRecordID {
					rows.Close()
					return fmt.Errorf("%w: Record is still referenced by Collection %q Field %q", ErrConflict, reference.model.collection.ID, reference.field.Name)
				}
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("finish checking Record relation references: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close Record relation reference query: %w", err)
		}
	}
	return nil
}
