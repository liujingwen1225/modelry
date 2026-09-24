package records

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

const (
	maximumExpandedRelations = 10
	maximumExpandedRecords   = 100
)

// ParseExpandQuery validates the shared detail-read query contract.
func ParseExpandQuery(query url.Values) ([]string, error) {
	for key, values := range query {
		if key != "expand" || len(values) != 1 {
			return nil, fmt.Errorf("%w: query parameter %q is unsupported or repeated", ErrInvalidArgument, key)
		}
	}
	raw, exists := query["expand"]
	if !exists {
		return nil, nil
	}
	if len(raw[0]) == 0 || len(raw[0]) > maximumExpandedRelations*63+maximumExpandedRelations-1 {
		return nil, fmt.Errorf("%w: expand must name 1 to %d relation Fields", ErrInvalidArgument, maximumExpandedRelations)
	}
	fields := strings.Split(raw[0], ",")
	if len(fields) > maximumExpandedRelations {
		return nil, fmt.Errorf("%w: expand supports at most %d relation Fields", ErrInvalidArgument, maximumExpandedRelations)
	}
	seen := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		if !validExpandFieldName(field) {
			return nil, fmt.Errorf("%w: expand contains an invalid or repeated Field name", ErrInvalidArgument)
		}
		if _, duplicate := seen[field]; duplicate {
			return nil, fmt.Errorf("%w: expand contains an invalid or repeated Field name", ErrInvalidArgument)
		}
		seen[field] = struct{}{}
	}
	return fields, nil
}

func validExpandFieldName(name string) bool {
	if len(name) == 0 || len(name) > 63 || name[0] < 'A' || (name[0] > 'Z' && name[0] < 'a') || name[0] > 'z' {
		return false
	}
	for index := 1; index < len(name); index++ {
		char := name[index]
		if (char < 'A' || char > 'Z') && (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}
	return true
}

func (service *Service) GetExpanded(ctx context.Context, collectionID, recordID string, expands []string) (Record, error) {
	record, err := service.Get(ctx, collectionID, recordID)
	if err != nil {
		return Record{}, err
	}
	return service.expandRecord(ctx, collectionID, record, expands, nil)
}

func (service *Service) expandRecord(
	ctx context.Context,
	collectionID string,
	record Record,
	expands []string,
	authorizeTarget func(string, Record) error,
) (Record, error) {
	if len(expands) == 0 {
		return record, nil
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Record{}, err
	}
	for _, name := range expands {
		field, exists := model.byName[name]
		if !exists || field.Type != backendmodel.FieldTypeRelation || field.Relation == nil {
			return Record{}, fmt.Errorf("%w: expand Field %q is not an Applied Relation", ErrInvalidArgument, name)
		}
	}

	expandedFields := make(map[string]any, len(expands))
	for _, name := range expands {
		field := model.byName[name]
		value, present := record.Values[name]
		multiple := field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many"
		if !present || value == nil {
			if multiple {
				expandedFields[name] = []Record{}
			} else {
				expandedFields[name] = nil
			}
			continue
		}
		ids, err := relationIDs(field, value)
		if err != nil || len(ids) > maximumExpandedRecords {
			return Record{}, fmt.Errorf("%w: expand Field %q contains too many or invalid Record IDs", ErrInvalidArgument, name)
		}
		if len(ids) == 0 {
			expandedFields[name] = []Record{}
			continue
		}
		targetID := field.Relation.TargetCollectionID
		if _, err := service.loadModel(ctx, targetID); err != nil {
			continue
		}
		expanded := make([]Record, 0, len(ids))
		visible := true
		for _, id := range ids {
			target, err := service.Get(ctx, targetID, id)
			if err != nil {
				visible = false
				break
			}
			if authorizeTarget != nil && authorizeTarget(targetID, target) != nil {
				visible = false
				break
			}
			expanded = append(expanded, target)
		}
		if !visible {
			continue
		}
		if multiple {
			expandedFields[name] = expanded
		} else {
			expandedFields[name] = expanded[0]
		}
	}
	if len(expandedFields) > 0 {
		record.Expanded = expandedFields
	}
	return record, nil
}
