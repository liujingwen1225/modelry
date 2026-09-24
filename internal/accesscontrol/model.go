package accesscontrol

import (
	"encoding/json"

	"github.com/liujingwen1225/modelry/internal/authorization"
)

type Mode string

const (
	ModeNoAccess      Mode = "noAccess"
	ModeAnyone        Mode = "anyone"
	ModeSignedInUsers Mode = "signedInUsers"
	ModeRecordOwner   Mode = "recordOwner"
	ModeCustom        Mode = "custom"
)

var operations = []authorization.Operation{
	authorization.OperationList,
	authorization.OperationView,
	authorization.OperationCreate,
	authorization.OperationUpdate,
	authorization.OperationDelete,
}

// Rule 表示一个 Collection 操作当前已应用或待应用的授权规则。
type Rule struct {
	Operation    authorization.Operation `json:"operation"`
	Mode         Mode                    `json:"mode"`
	OwnerFieldID string                  `json:"ownerFieldId,omitempty"`
	Expression   json.RawMessage         `json:"expression,omitempty"`
}

type SaveInput struct {
	ExpectedVersion int    `json:"expectedVersion"`
	Rules           []Rule `json:"rules"`
}

type RulesState struct {
	Applied    []Rule `json:"applied"`
	Pending    []Rule `json:"pending"`
	Version    int    `json:"version"`
	HasPending bool   `json:"-"`
}

// Violation 定位 Access Rule 输入错误，同时避免向 HTTP 调用方暴露存储或评估器内部信息。
type Violation struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type CustomExpression struct {
	Version int         `json:"version"`
	All     []Predicate `json:"all"`
}

type Predicate struct {
	FieldID  string          `json:"fieldId"`
	Operator string          `json:"operator"`
	Value    json.RawMessage `json:"value"`
}

func emptyRules() []Rule {
	rules := make([]Rule, len(operations))
	for index, operation := range operations {
		rules[index] = Rule{Operation: operation, Mode: ModeNoAccess}
	}
	return rules
}

func cloneRules(rules []Rule) []Rule {
	clone := make([]Rule, len(rules))
	for index, rule := range rules {
		clone[index] = rule
		clone[index].Expression = append(json.RawMessage(nil), rule.Expression...)
	}
	return clone
}
