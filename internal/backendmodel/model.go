package backendmodel

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

type CollectionType string

const (
	CollectionTypeNormal CollectionType = "Normal"
	CollectionTypeAuth   CollectionType = "Auth"
)

type FieldType string

const (
	FieldTypeText     FieldType = "text"
	FieldTypeNumber   FieldType = "number"
	FieldTypeBoolean  FieldType = "boolean"
	FieldTypeDateTime FieldType = "dateTime"
	FieldTypeJSON     FieldType = "json"
	FieldTypeRelation FieldType = "relation"
	FieldTypeFile     FieldType = "file"
)

type OperationKind string

const (
	OperationField    OperationKind = "field"
	OperationRelation OperationKind = "relation"
	OperationIndex    OperationKind = "index"
)

type OperationAction string

const (
	OperationAdd    OperationAction = "add"
	OperationUpdate OperationAction = "update"
	OperationRemove OperationAction = "remove"
)

type ChangeStatus string

const (
	ChangeReady       ChangeStatus = "ready"
	ChangeNeedsReview ChangeStatus = "needsReview"
	ChangeFailed      ChangeStatus = "failed"
	ChangeApplied     ChangeStatus = "applied"
	ChangeDiscarded   ChangeStatus = "discarded"
)

type Risk string

const (
	RiskSafe    Risk = "safe"
	RiskReview  Risk = "review"
	RiskBlocked Risk = "blocked"
)

type AttemptStatus string

const (
	AttemptInProgress       AttemptStatus = "inProgress"
	AttemptSucceeded        AttemptStatus = "succeeded"
	AttemptFailed           AttemptStatus = "failed"
	AttemptRecoveryRequired AttemptStatus = "recoveryRequired"
	AttemptInterrupted      AttemptStatus = "interrupted"
)

var (
	ErrInvalidArgument            = errors.New("invalid argument")
	ErrNotFound                   = errors.New("not found")
	ErrConflict                   = errors.New("conflict")
	ErrChangeConfirmationRequired = errors.New("change confirmation required")
	ErrChangeBlocked              = errors.New("change is blocked")
	ErrProjection                 = errors.New("record projection unavailable")

	fieldNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,62}$`)
	indexNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,62}$`)
)

// Collection 是一个 Collection 当前已应用的 Backend Model。Pending Changes
// 不写入此对象，直到 Apply 的投影事务成功提交。
type Collection struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Description   string         `json:"description,omitempty"`
	Type          CollectionType `json:"type"`
	Fields        []Field        `json:"fields"`
	Indexes       []Index        `json:"indexes,omitempty"`
	SchemaVersion int            `json:"schemaVersion"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}

type Field struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Type        FieldType       `json:"type"`
	Required    bool            `json:"required,omitempty"`
	Unique      bool            `json:"unique,omitempty"`
	Description string          `json:"description,omitempty"`
	Validation  json.RawMessage `json:"validation,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	Relation    *Relation       `json:"relation,omitempty"`
	System      bool            `json:"system,omitempty"`
}

type Relation struct {
	TargetCollectionID string `json:"targetCollectionId"`
	Cardinality        string `json:"cardinality"`
}

type Index struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Fields []string `json:"fields"`
	Unique bool     `json:"unique,omitempty"`
}

type CreateCollectionInput struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Type        CollectionType `json:"type"`
	Fields      []Field        `json:"fields"`
}

type PendingOperation struct {
	ID         string          `json:"id"`
	Kind       OperationKind   `json:"kind"`
	Action     OperationAction `json:"action"`
	TargetID   string          `json:"targetId,omitempty"`
	Definition json.RawMessage `json:"definition"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

type PendingOperationInput struct {
	Kind       OperationKind   `json:"kind"`
	Action     OperationAction `json:"action"`
	TargetID   string          `json:"targetId,omitempty"`
	Definition json.RawMessage `json:"definition"`
}

type PendingChange struct {
	ChangeSetID  string             `json:"changeSetId"`
	CollectionID string             `json:"collectionId"`
	Version      int                `json:"version"`
	Status       ChangeStatus       `json:"status"`
	Operations   []PendingOperation `json:"operations"`
	Recovery     *RecoveryState     `json:"recoveryState,omitempty"`
	CreatedAt    time.Time          `json:"createdAt"`
	UpdatedAt    time.Time          `json:"updatedAt"`
}

type DiffItem struct {
	Kind     OperationKind   `json:"kind"`
	Action   OperationAction `json:"action"`
	TargetID string          `json:"targetId"`
	Name     string          `json:"name,omitempty"`
	Before   json.RawMessage `json:"before,omitempty"`
	After    json.RawMessage `json:"after,omitempty"`
}

type Precondition struct {
	Code    string `json:"code"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

type Impact struct {
	AffectedCollections int    `json:"affectedCollections"`
	AffectedFields      int    `json:"affectedFields"`
	AffectedIndexes     int    `json:"affectedIndexes"`
	AffectedRecords     int64  `json:"affectedRecords"`
	Summary             string `json:"summary"`
}

type SchemaPreview struct {
	Risk          Risk           `json:"risk"`
	Diff          []DiffItem     `json:"diff"`
	Preconditions []Precondition `json:"preconditions"`
	Impact        Impact         `json:"impact"`
	Version       int            `json:"version"`
}

type RecoveryState struct {
	State   string   `json:"state"`
	Summary string   `json:"summary,omitempty"`
	Actions []string `json:"actions,omitempty"`
}

type ApplyAttempt struct {
	ID                 string         `json:"id"`
	ChangeSetID        string         `json:"changeSetId"`
	Status             AttemptStatus  `json:"status"`
	StartedAt          time.Time      `json:"startedAt"`
	FinishedAt         *time.Time     `json:"finishedAt,omitempty"`
	Evaluation         SchemaPreview  `json:"evaluation"`
	ErrorCode          string         `json:"errorCode,omitempty"`
	Recovery           *RecoveryState `json:"recoveryState,omitempty"`
	AppliedMigrationID string         `json:"appliedMigrationId,omitempty"`
}

type AppliedMigration struct {
	ID             string     `json:"id"`
	ChangeSetID    string     `json:"changeSetId"`
	CollectionID   string     `json:"collectionId"`
	ApplyAttemptID string     `json:"applyAttemptId"`
	AppliedAt      time.Time  `json:"appliedAt"`
	SchemaVersion  int        `json:"schemaVersion"`
	Diff           []DiffItem `json:"diff"`
	Model          Collection `json:"-"`
}

type ApplyResult struct {
	State              string         `json:"state"`
	AppliedMigrationID string         `json:"appliedMigrationId,omitempty"`
	ApplyAttemptID     string         `json:"applyAttemptId,omitempty"`
	Recovery           *RecoveryState `json:"recovery,omitempty"`
}

type ChangeDetail struct {
	ChangeSetID      string             `json:"changeSetId"`
	CollectionID     string             `json:"collectionId"`
	Status           ChangeStatus       `json:"status"`
	Version          int                `json:"version"`
	Operations       []PendingOperation `json:"operations,omitempty"`
	ApplyAttempts    []ApplyAttempt     `json:"applyAttempts"`
	AppliedMigration *AppliedMigration  `json:"appliedMigration,omitempty"`
	RecoveryState    *RecoveryState     `json:"recoveryState,omitempty"`
}

type Page[T any] struct {
	Data       []T    `json:"data"`
	NextCursor string `json:"nextCursor,omitempty"`
}

type ListOptions struct {
	Limit  int
	Cursor string
}

type ProjectedField struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Type       FieldType       `json:"type"`
	ColumnName string          `json:"columnName"`
	Required   bool            `json:"required"`
	Unique     bool            `json:"unique"`
	Validation json.RawMessage `json:"validation,omitempty"`
	Default    json.RawMessage `json:"default,omitempty"`
	Relation   *Relation       `json:"relation,omitempty"`
	System     bool            `json:"system"`
}

// RecordProjection 向 Records 模块提供 Applied Model 到当前物理列的映射。
// TableName/ColumnName 仅由 Modelry 生成的 opaque IDs 派生，绝不可替换为用户输入。
type RecordProjection struct {
	CollectionID  string           `json:"collectionId"`
	SchemaVersion int              `json:"schemaVersion"`
	TableName     string           `json:"tableName"`
	Fields        []ProjectedField `json:"fields"`
}

type RecordValueError struct {
	Field   string
	Code    string
	Message string
}

func (e *RecordValueError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func newID(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate durable %s identifier: %w", prefix, err)
	}
	return prefix + hex.EncodeToString(value[:]), nil
}

func validOpaqueID(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) || len(value) != len(prefix)+32 {
		return false
	}
	_, err := hex.DecodeString(value[len(prefix):])
	return err == nil
}

func validateCollectionInput(input CreateCollectionInput) error {
	if strings.TrimSpace(input.Name) == "" || len([]rune(input.Name)) > 80 || strings.TrimSpace(input.Name) != input.Name {
		return fmt.Errorf("%w: collection name must contain 1 to 80 characters with no surrounding whitespace", ErrInvalidArgument)
	}
	for _, r := range input.Name {
		if r == 0 || r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: collection name contains a control character", ErrInvalidArgument)
		}
	}
	if input.Type != CollectionTypeNormal && input.Type != CollectionTypeAuth {
		return fmt.Errorf("%w: collection type must be Normal or Auth", ErrInvalidArgument)
	}
	if len(input.Description) > 4000 {
		return fmt.Errorf("%w: collection description is too long", ErrInvalidArgument)
	}
	return nil
}

func validateField(field Field) error {
	if !fieldNamePattern.MatchString(field.Name) {
		return fmt.Errorf("%w: field name %q must start with a letter and contain only letters, numbers, or underscores", ErrInvalidArgument, field.Name)
	}
	if strings.EqualFold(field.Name, "password") {
		return fmt.Errorf("%w: password is a Credential and cannot be a Field", ErrInvalidArgument)
	}
	switch field.Type {
	case FieldTypeText, FieldTypeNumber, FieldTypeBoolean, FieldTypeDateTime, FieldTypeJSON, FieldTypeRelation, FieldTypeFile:
	default:
		return fmt.Errorf("%w: unsupported field type %q", ErrInvalidArgument, field.Type)
	}
	if field.System {
		return fmt.Errorf("%w: system fields are managed by Modelry", ErrInvalidArgument)
	}
	if len(field.Validation) > 0 && (!json.Valid(field.Validation) || !isJSONObject(field.Validation)) {
		return fmt.Errorf("%w: field validation must be a JSON object", ErrInvalidArgument)
	}
	if len(field.Default) > 0 && !json.Valid(field.Default) {
		return fmt.Errorf("%w: field default must be valid JSON", ErrInvalidArgument)
	}
	if field.Type == FieldTypeRelation {
		if field.Relation == nil || !validOpaqueID(field.Relation.TargetCollectionID, "col_") {
			return fmt.Errorf("%w: relation fields require a target collection", ErrInvalidArgument)
		}
		if !validCardinality(field.Relation.Cardinality) {
			return fmt.Errorf("%w: unsupported relation cardinality %q", ErrInvalidArgument, field.Relation.Cardinality)
		}
	} else if field.Relation != nil {
		return fmt.Errorf("%w: only relation fields can define a relation", ErrInvalidArgument)
	}
	if len(field.Default) > 0 {
		var value any
		decoder := json.NewDecoder(bytes.NewReader(field.Default))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return fmt.Errorf("%w: invalid field default: %v", ErrInvalidArgument, err)
		}
		if err := validateFieldValue(field, value, false); err != nil {
			return fmt.Errorf("%w: field default: %v", ErrInvalidArgument, err)
		}
		if field.Required && value == nil {
			return fmt.Errorf("%w: a required Field cannot have a null default", ErrInvalidArgument)
		}
	}
	return nil
}

func validCardinality(value string) bool {
	switch value {
	case "one-to-one", "many-to-one", "one-to-many", "many-to-many":
		return true
	default:
		return false
	}
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

func validateFieldValue(field Field, value any, enforceRequired bool) error {
	if value == nil {
		if enforceRequired && field.Required {
			return &RecordValueError{Field: field.Name, Code: "required", Message: "is required"}
		}
		return nil
	}
	switch field.Type {
	case FieldTypeText, FieldTypeDateTime, FieldTypeFile:
		text, ok := value.(string)
		if !ok {
			return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a string"}
		}
		if field.Type == FieldTypeDateTime {
			if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
				return &RecordValueError{Field: field.Name, Code: "format", Message: "must be an RFC 3339 date-time"}
			}
		}
		if field.Type == FieldTypeText {
			if err := validateText(field, text); err != nil {
				return err
			}
		}
	case FieldTypeNumber:
		var number float64
		switch v := value.(type) {
		case json.Number:
			n, err := v.Float64()
			if err != nil {
				return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a finite number"}
			}
			number = n
		case float64:
			number = v
		case float32:
			number = float64(v)
		case int:
			number = float64(v)
		case int64:
			number = float64(v)
		default:
			return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a number"}
		}
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a finite number"}
		}
		if err := validateNumber(field, number); err != nil {
			return err
		}
	case FieldTypeBoolean:
		if _, ok := value.(bool); !ok {
			return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a boolean"}
		}
	case FieldTypeJSON:
		// Any JSON value is accepted unless a future accepted contract adds constraints.
	case FieldTypeRelation:
		if field.Relation == nil {
			return &RecordValueError{Field: field.Name, Code: "relation", Message: "has no relation definition"}
		}
		many := field.Relation.Cardinality == "one-to-many" || field.Relation.Cardinality == "many-to-many"
		if many {
			values, ok := value.([]any)
			if !ok {
				return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a list of record IDs"}
			}
			for _, item := range values {
				if _, ok := item.(string); !ok {
					return &RecordValueError{Field: field.Name, Code: "type", Message: "must contain only record IDs"}
				}
			}
		} else if _, ok := value.(string); !ok {
			return &RecordValueError{Field: field.Name, Code: "type", Message: "must be a record ID"}
		}
	default:
		return &RecordValueError{Field: field.Name, Code: "type", Message: "has an unsupported field type"}
	}
	return nil
}

func validateText(field Field, value string) error {
	var rules map[string]any
	if len(field.Validation) == 0 {
		return nil
	}
	if err := json.Unmarshal(field.Validation, &rules); err != nil {
		return &RecordValueError{Field: field.Name, Code: "validation", Message: "has invalid validation rules"}
	}
	if min, ok := numberRule(rules["minLength"]); ok && float64(len([]rune(value))) < min {
		return &RecordValueError{Field: field.Name, Code: "minLength", Message: fmt.Sprintf("must contain at least %d characters", int(min))}
	}
	if max, ok := numberRule(rules["maxLength"]); ok && float64(len([]rune(value))) > max {
		return &RecordValueError{Field: field.Name, Code: "maxLength", Message: fmt.Sprintf("must contain at most %d characters", int(max))}
	}
	if rawEnum, ok := rules["enum"].([]any); ok {
		found := false
		for _, item := range rawEnum {
			if item == value {
				found = true
				break
			}
		}
		if !found {
			return &RecordValueError{Field: field.Name, Code: "enum", Message: "is not an allowed value"}
		}
	}
	return nil
}

func validateNumber(field Field, value float64) error {
	if len(field.Validation) == 0 {
		return nil
	}
	var rules map[string]any
	if err := json.Unmarshal(field.Validation, &rules); err != nil {
		return &RecordValueError{Field: field.Name, Code: "validation", Message: "has invalid validation rules"}
	}
	if min, ok := numberRule(rules["min"]); ok && value < min {
		return &RecordValueError{Field: field.Name, Code: "min", Message: fmt.Sprintf("must be at least %s", rules["min"])}
	}
	if max, ok := numberRule(rules["max"]); ok && value > max {
		return &RecordValueError{Field: field.Name, Code: "max", Message: fmt.Sprintf("must be at most %s", rules["max"])}
	}
	return nil
}

func numberRule(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	case int:
		return float64(v), true
	default:
		return 0, false
	}
}
