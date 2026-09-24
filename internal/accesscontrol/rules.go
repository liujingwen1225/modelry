package accesscontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const maxCustomExpressionBytes = 16 << 10

type ValidationFailure struct {
	Violation Violation
}

func (failure *ValidationFailure) Error() string {
	return failure.Violation.Message
}

func (failure *ValidationFailure) Unwrap() error { return ErrInvalidArgument }

// normalizeRules 校验规则，并按固定的五种操作顺序返回。
func normalizeRules(ctx context.Context, query storage.Executor, collection backendmodel.Collection, input []Rule) ([]Rule, error) {
	if len(input) != len(operations) {
		return nil, validationError("/rules", "RULE_SET_INCOMPLETE", "Provide exactly one Access Rule for each supported operation.")
	}
	byOperation := make(map[authorization.Operation]Rule, len(input))
	for index, rule := range input {
		if _, exists := byOperation[rule.Operation]; exists {
			return nil, validationError(fmt.Sprintf("/rules/%d/operation", index), "DUPLICATE_OPERATION", "Each operation can have only one Access Rule.")
		}
		if !knownOperation(rule.Operation) {
			return nil, validationError(fmt.Sprintf("/rules/%d/operation", index), "UNSUPPORTED_OPERATION", "Choose a supported Collection operation.")
		}
		if err := validateRule(ctx, query, collection, rule, fmt.Sprintf("/rules/%d", index)); err != nil {
			return nil, err
		}
		byOperation[rule.Operation] = cloneRules([]Rule{rule})[0]
	}
	ordered := make([]Rule, 0, len(operations))
	for _, operation := range operations {
		rule, exists := byOperation[operation]
		if !exists {
			return nil, validationError("/rules", "RULE_SET_INCOMPLETE", "Provide exactly one Access Rule for each supported operation.")
		}
		ordered = append(ordered, rule)
	}
	return ordered, nil
}

func knownOperation(operation authorization.Operation) bool {
	for _, candidate := range operations {
		if candidate == operation {
			return true
		}
	}
	return false
}

func validateRule(ctx context.Context, query storage.Executor, collection backendmodel.Collection, rule Rule, path string) error {
	switch rule.Mode {
	case ModeNoAccess, ModeAnyone, ModeSignedInUsers:
		if rule.OwnerFieldID != "" || len(bytes.TrimSpace(rule.Expression)) != 0 {
			return validationError(path, "UNEXPECTED_RULE_VALUE", "This Access Rule mode does not accept an owner field or expression.")
		}
	case ModeRecordOwner:
		if rule.OwnerFieldID == "" {
			return validationError(path+"/ownerFieldId", "REQUIRED", "Select a Relation field that points to an Auth Collection.")
		}
		if len(bytes.TrimSpace(rule.Expression)) != 0 {
			return validationError(path+"/expression", "UNEXPECTED_RULE_VALUE", "Record owner rules do not accept an expression.")
		}
		if !validRecordOwnerRule(ctx, query, collection, rule) {
			return validationError(path+"/ownerFieldId", "AUTH_RELATION_REQUIRED", "Choose an Applied Relation field that points to an Auth Collection.")
		}
	case ModeCustom:
		if rule.OwnerFieldID != "" {
			return validationError(path+"/ownerFieldId", "UNEXPECTED_RULE_VALUE", "Custom rules do not accept an owner field.")
		}
		if _, err := parseCustomRule(collection, rule); err != nil {
			return validationError(path+"/expression", "UNSUPPORTED_EXPRESSION", "Use the supported version 1 field-predicate expression.")
		}
	default:
		return validationError(path+"/mode", "UNSUPPORTED_MODE", "Choose a supported Access Rule mode.")
	}
	return nil
}

func validationError(path, code, message string) error {
	return &ValidationFailure{Violation: Violation{Path: path, Code: code, Message: message}}
}

type parsedPredicate struct {
	field    backendmodel.Field
	operator string
	value    any
}

func parseCustomRule(collection backendmodel.Collection, rule Rule) ([]parsedPredicate, error) {
	if len(rule.Expression) == 0 || len(rule.Expression) > maxCustomExpressionBytes || !json.Valid(rule.Expression) {
		return nil, errors.New("invalid Custom expression size or JSON")
	}
	var expression CustomExpression
	decoder := json.NewDecoder(bytes.NewReader(rule.Expression))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(&expression); err != nil {
		return nil, fmt.Errorf("decode Custom expression: %w", err)
	}
	if err := decoder.Decode(new(any)); err == nil {
		return nil, errors.New("Custom expression contains trailing JSON")
	} else if !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("read Custom expression: %w", err)
	}
	if expression.Version != 1 || len(expression.All) == 0 || len(expression.All) > 16 {
		return nil, errors.New("Custom expression version or predicate count is unsupported")
	}
	parsed := make([]parsedPredicate, 0, len(expression.All))
	for _, predicate := range expression.All {
		field, exists := findField(collection, predicate.FieldID)
		if !exists || field.System || !supportedPredicateField(field.Type) {
			return nil, errors.New("Custom expression references an unsupported Applied Field")
		}
		if predicate.Operator != "eq" && predicate.Operator != "neq" && predicate.Operator != "in" {
			return nil, errors.New("Custom expression uses an unsupported operator")
		}
		var value any
		valueDecoder := json.NewDecoder(bytes.NewReader(predicate.Value))
		valueDecoder.UseNumber()
		if len(predicate.Value) == 0 || valueDecoder.Decode(&value) != nil {
			return nil, errors.New("Custom predicate requires a JSON value")
		}
		if predicate.Operator == "in" {
			values, ok := value.([]any)
			if !ok || len(values) == 0 || len(values) > 32 {
				return nil, errors.New("in predicates require between 1 and 32 typed values")
			}
			for _, candidate := range values {
				if !validPredicateValue(field, candidate) {
					return nil, errors.New("Custom predicate value does not match its Applied Field type")
				}
			}
		} else if !validPredicateValue(field, value) {
			return nil, errors.New("Custom predicate value does not match its Applied Field type")
		}
		parsed = append(parsed, parsedPredicate{field: field, operator: predicate.Operator, value: value})
	}
	return parsed, nil
}

func supportedPredicateField(fieldType backendmodel.FieldType) bool {
	switch fieldType {
	case backendmodel.FieldTypeText, backendmodel.FieldTypeNumber, backendmodel.FieldTypeBoolean,
		backendmodel.FieldTypeDateTime, backendmodel.FieldTypeJSON, backendmodel.FieldTypeRelation:
		return true
	default:
		return false
	}
}

func validPredicateValue(field backendmodel.Field, value any) bool {
	if value == nil {
		return true
	}
	switch field.Type {
	case backendmodel.FieldTypeText, backendmodel.FieldTypeDateTime:
		text, ok := value.(string)
		if !ok {
			return false
		}
		if field.Type == backendmodel.FieldTypeDateTime {
			_, err := timeParseRFC3339(text)
			return err == nil
		}
		return true
	case backendmodel.FieldTypeNumber:
		_, ok := numericValue(value)
		return ok
	case backendmodel.FieldTypeBoolean:
		_, ok := value.(bool)
		return ok
	case backendmodel.FieldTypeRelation:
		_, ok := value.(string)
		return ok
	case backendmodel.FieldTypeJSON:
		return true
	default:
		return false
	}
}

func evaluatePredicates(predicates []parsedPredicate, record *authorization.Record) bool {
	if record == nil {
		return false
	}
	for _, predicate := range predicates {
		actual, exists := record.Values[predicate.field.ID]
		if !exists {
			actual, exists = record.Values[predicate.field.Name]
		}
		matches := false
		if predicate.operator == "in" {
			for _, candidate := range predicate.value.([]any) {
				if typedEqual(predicate.field, actual, candidate) && exists {
					matches = true
					break
				}
			}
		} else {
			if exists {
				matches = typedEqual(predicate.field, actual, predicate.value)
				if predicate.operator == "neq" {
					matches = !matches
				}
			}
		}
		if !matches {
			return false
		}
	}
	return true
}

func typedEqual(field backendmodel.Field, actual, expected any) bool {
	if actual == nil || expected == nil {
		return actual == nil && expected == nil
	}
	if field.Type == backendmodel.FieldTypeRelation {
		if actualText, ok := actual.(string); ok {
			return actualText == expected
		}
		if values, ok := actual.([]any); ok {
			for _, value := range values {
				if text, ok := value.(string); ok && text == expected {
					return true
				}
			}
		}
		if values, ok := actual.([]string); ok {
			for _, value := range values {
				if value == expected {
					return true
				}
			}
		}
		return false
	}
	if field.Type == backendmodel.FieldTypeNumber {
		left, leftOK := numericValue(actual)
		right, rightOK := numericValue(expected)
		return leftOK && rightOK && left == right
	}
	left, leftErr := json.Marshal(actual)
	right, rightErr := json.Marshal(expected)
	return leftErr == nil && rightErr == nil && bytes.Equal(left, right)
}

func numericValue(value any) (float64, bool) {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Float64()
		return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	case float32:
		parsed := float64(number)
		return parsed, !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	default:
		return 0, false
	}
}

func isRecordOwner(ctx context.Context, query storage.Executor, collection backendmodel.Collection, rule Rule, principal authorization.Principal, record *authorization.Record) bool {
	if !isActiveUser(principal) || record == nil || !validRecordOwnerRule(ctx, query, collection, rule) {
		return false
	}
	field, _ := findField(collection, rule.OwnerFieldID)
	value, exists := record.Values[field.ID]
	if !exists {
		value, exists = record.Values[field.Name]
	}
	if !exists {
		return false
	}
	if owner, ok := value.(string); ok {
		return owner == principal.ID
	}
	if owners, ok := value.([]any); ok {
		for _, owner := range owners {
			if ownerID, ok := owner.(string); ok && ownerID == principal.ID {
				return true
			}
		}
	}
	if owners, ok := value.([]string); ok {
		for _, ownerID := range owners {
			if ownerID == principal.ID {
				return true
			}
		}
	}
	return false
}

func validRecordOwnerRule(ctx context.Context, query storage.Executor, collection backendmodel.Collection, rule Rule) bool {
	field, exists := findField(collection, rule.OwnerFieldID)
	if !exists || field.System || field.Type != backendmodel.FieldTypeRelation || field.Relation == nil {
		return false
	}
	var modelJSON string
	if err := query.QueryRowContext(ctx, `SELECT model_json FROM modelry_backend_collections WHERE id = ?`, field.Relation.TargetCollectionID).Scan(&modelJSON); err != nil {
		return false
	}
	var target backendmodel.Collection
	if err := json.Unmarshal([]byte(modelJSON), &target); err != nil {
		return false
	}
	return target.Type == backendmodel.CollectionTypeAuth
}

func findField(collection backendmodel.Collection, fieldID string) (backendmodel.Field, bool) {
	for _, field := range collection.Fields {
		if field.ID == fieldID {
			return field, true
		}
	}
	return backendmodel.Field{}, false
}

func isActiveUser(principal authorization.Principal) bool {
	return principal.Type == authorization.PrincipalApplication && strings.TrimSpace(principal.ID) != ""
}

func timeParseRFC3339(value string) (int64, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0, err
	}
	return parsed.UnixNano(), nil
}
