package accesscontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// SimulationNotice 出现在每一次模拟结果中，说明它为什么不能替代真实请求。
const SimulationNotice = "This preview is not authoritative. A real Application request evaluates stored data, the full request pipeline, and the applied rules at that moment."

const (
	maximumSimulationPayloadFields = 64
	maximumSimulationIdentifier    = 128
)

// SimulationRecordLookup 由 Runtime 注入：为模拟读取一个已提交 Record 的字段值。
type SimulationRecordLookup interface {
	SimulationRecord(ctx context.Context, collectionID, recordID string) (*authorization.Record, error)
}

// SetSimulationRecordLookup 注入 Record 读取端口。未注入时只能使用 inline payload。
func (service *Service) SetSimulationRecordLookup(lookup SimulationRecordLookup) {
	if service == nil {
		return
	}
	service.simulationRecords = lookup
}

// SimulationInput 描述一次假设请求。
type SimulationInput struct {
	Operation authorization.Operation
	Principal authorization.Principal
	RecordID  string
	Payload   map[string]any
}

// SimulationResult 是一次非权威的 Access Rule 预演结论。
type SimulationResult struct {
	Allowed           bool            `json:"allowed"`
	Code              string          `json:"code,omitempty"`
	Message           string          `json:"message,omitempty"`
	Reason            json.RawMessage `json:"reason,omitempty"`
	DecidingOperation string          `json:"decidingOperation,omitempty"`
	DecidingMode      string          `json:"decidingMode,omitempty"`
	Authoritative     bool            `json:"authoritative"`
	Notice            string          `json:"notice"`
}

// Simulate 使用与真实请求相同的 evaluator 计算一次假设请求的决策。
func (service *Service) Simulate(ctx context.Context, collectionID string, input SimulationInput) (SimulationResult, error) {
	if service == nil {
		return SimulationResult{}, fmt.Errorf("%w: Access Rule simulation is not ready", ErrStorage)
	}
	operation, err := normalizeSimulationOperation(input.Operation)
	if err != nil {
		return SimulationResult{}, err
	}
	principal, err := normalizeSimulationPrincipal(input.Principal)
	if err != nil {
		return SimulationResult{}, err
	}
	collectionID = strings.TrimSpace(collectionID)
	if collectionID == "" {
		return SimulationResult{}, fmt.Errorf("%w: collectionId is required", ErrInvalidArgument)
	}
	recordID := strings.TrimSpace(input.RecordID)
	if recordID != "" && len(input.Payload) > 0 {
		return SimulationResult{}, fmt.Errorf("%w: supply either recordId or payload, not both", ErrInvalidArgument)
	}
	if len(input.Payload) > maximumSimulationPayloadFields {
		return SimulationResult{}, fmt.Errorf("%w: payload must contain at most %d fields", ErrInvalidArgument, maximumSimulationPayloadFields)
	}
	if recordID != "" && len(recordID) > maximumSimulationIdentifier {
		return SimulationResult{}, fmt.Errorf("%w: recordId is too long", ErrInvalidArgument)
	}

	var record *authorization.Record
	if recordID != "" {
		if service.simulationRecords == nil {
			return SimulationResult{}, fmt.Errorf("%w: reading an existing Record is unavailable", ErrStorage)
		}
		loaded, err := service.simulationRecords.SimulationRecord(ctx, collectionID, recordID)
		if err != nil {
			return SimulationResult{}, err
		}
		if loaded == nil {
			return SimulationResult{}, ErrRecordNotFound
		}
		record = loaded
	} else if len(input.Payload) > 0 {
		values := make(map[string]any, len(input.Payload))
		for key, value := range input.Payload {
			trimmed := strings.TrimSpace(key)
			if trimmed == "" {
				return SimulationResult{}, fmt.Errorf("%w: payload field names must not be empty", ErrInvalidArgument)
			}
			values[trimmed] = value
		}
		record = &authorization.Record{ID: "simulated", Values: values}
	}

	var decision authorization.Decision
	mode := ""
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		collection, err := loadCollection(ctx, snapshot, collectionID)
		if err != nil {
			return err
		}
		state, _, err := readState(ctx, snapshot, collection)
		if err != nil {
			return err
		}
		mode = modeForOperation(state.Applied, operation)
		decision, err = service.EvaluateInTransaction(ctx, snapshot, collectionID, operation, principal, record)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrCollectionNotFound) || errors.Is(err, ErrNotFound) {
			return SimulationResult{}, ErrCollectionNotFound
		}
		return SimulationResult{}, err
	}
	return SimulationResult{
		Allowed: decision.Allowed, Code: decision.Code, Message: decision.Message, Reason: decision.Reason,
		DecidingOperation: string(operation), DecidingMode: mode,
		Authoritative: false, Notice: SimulationNotice,
	}, nil
}

func modeForOperation(rules []Rule, operation authorization.Operation) string {
	for _, rule := range rules {
		if rule.Operation == operation {
			return string(rule.Mode)
		}
	}
	return string(ModeNoAccess)
}

func normalizeSimulationOperation(operation authorization.Operation) (authorization.Operation, error) {
	for _, supported := range operations {
		if operation == supported {
			return operation, nil
		}
	}
	return "", fmt.Errorf("%w: operation must be list, view, create, update, or delete", ErrInvalidArgument)
}

func normalizeSimulationPrincipal(principal authorization.Principal) (authorization.Principal, error) {
	switch principal.Type {
	case authorization.PrincipalAnonymous, authorization.PrincipalOwner,
		authorization.PrincipalApplication, authorization.PrincipalServiceAccount:
	default:
		return authorization.Principal{}, fmt.Errorf("%w: principal kind is unsupported", ErrInvalidArgument)
	}
	identifier := strings.TrimSpace(principal.ID)
	if len(identifier) > maximumSimulationIdentifier {
		return authorization.Principal{}, fmt.Errorf("%w: principal id is too long", ErrInvalidArgument)
	}
	if principal.Type == authorization.PrincipalApplication || principal.Type == authorization.PrincipalServiceAccount {
		if identifier == "" {
			return authorization.Principal{}, fmt.Errorf("%w: this principal kind requires an id", ErrInvalidArgument)
		}
	}
	return authorization.Principal{Type: principal.Type, ID: identifier}, nil
}

