package accesscontrol

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrInvalidArgument = backendmodel.ErrInvalidArgument
	ErrNotFound        = backendmodel.ErrNotFound
	ErrConflict        = backendmodel.ErrConflict
)

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Service struct {
	store  transactionalStore
	models *backendmodel.Service
	now    func() time.Time
}

// NewService 初始化耐久化的 Access Rule 边界，并为模块启动前创建的 Collection 补齐安全的 noAccess 状态。
func NewService(ctx context.Context, store transactionalStore, models *backendmodel.Service) (*Service, error) {
	if store == nil || models == nil {
		return nil, fmt.Errorf("%w: storage and Applied Model are required", ErrInvalidArgument)
	}
	service := &Service{store: store, models: models, now: func() time.Time { return time.Now().UTC() }}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_access_rules (
			collection_id TEXT PRIMARY KEY NOT NULL,
			applied_json TEXT NOT NULL,
			pending_json TEXT,
			version INTEGER NOT NULL CHECK (version >= 1),
			updated_at TEXT NOT NULL,
			FOREIGN KEY (collection_id) REFERENCES modelry_backend_collections(id)
		)`); err != nil {
			return fmt.Errorf("initialize Access Rule persistence: %w", err)
		}
		rows, err := tx.QueryContext(ctx, `SELECT c.model_json FROM modelry_backend_collections c
			LEFT JOIN modelry_access_rules a ON a.collection_id = c.id
			WHERE a.collection_id IS NULL`)
		if err != nil {
			return fmt.Errorf("find Collections without Access Rules: %w", err)
		}
		var missing []backendmodel.Collection
		for rows.Next() {
			var modelJSON string
			if err := rows.Scan(&modelJSON); err != nil {
				rows.Close()
				return fmt.Errorf("read Collection for Access Rule defaults: %w", err)
			}
			var collection backendmodel.Collection
			if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
				rows.Close()
				return fmt.Errorf("decode Collection for Access Rule defaults: %w", err)
			}
			missing = append(missing, collection)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("finish reading Collection Access Rule defaults: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close Collection Access Rule defaults: %w", err)
		}
		for _, collection := range missing {
			if err := InitializeCollection(ctx, tx, collection, nil); err != nil {
				return fmt.Errorf("initialize fail-closed Access Rules for Collection %q: %w", collection.ID, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return service, nil
}

// InitializeCollection 在 Collection 创建事务中写入五条已应用 Access Rule。rules 为 nil 时使用五条耐久化 noAccess 默认规则。
func InitializeCollection(ctx context.Context, tx storage.Executor, collection backendmodel.Collection, initial []Rule) error {
	if tx == nil || collection.ID == "" {
		return fmt.Errorf("%w: transaction and Collection are required", ErrInvalidArgument)
	}
	if initial == nil {
		initial = emptyRules()
	}
	normalized, err := normalizeRules(ctx, tx, collection, initial)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return fmt.Errorf("encode initial Access Rules: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO modelry_access_rules (collection_id, applied_json, pending_json, version, updated_at) VALUES (?, ?, NULL, 1, ?)`, collection.ID, string(encoded), timestamp(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("persist initial Access Rules: %w", err)
	}
	return nil
}

func (service *Service) Get(ctx context.Context, collectionID string) (RulesState, error) {
	var state RulesState
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		collection, err := loadCollection(ctx, snapshot, collectionID)
		if err != nil {
			return err
		}
		state, _, err = readState(ctx, snapshot, collection)
		return err
	})
	return state, err
}

func (service *Service) Save(ctx context.Context, collectionID string, input SaveInput) (RulesState, error) {
	if input.ExpectedVersion < 1 {
		return RulesState{}, validationError("/expectedVersion", "REQUIRED", "Reload Access Rules and try again.")
	}
	var state RulesState
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		current, rowExists, err := readState(ctx, tx, collection)
		if err != nil {
			return err
		}
		if input.ExpectedVersion != current.Version {
			return fmt.Errorf("%w: Access Rules are at version %d, not %d", ErrConflict, current.Version, input.ExpectedVersion)
		}
		rules, err := normalizeRules(ctx, tx, collection, input.Rules)
		if err != nil {
			return err
		}
		pending := rules
		var pendingJSON any
		if rulesEqual(rules, current.Applied) {
			pending = nil
		} else {
			encoded, err := json.Marshal(rules)
			if err != nil {
				return fmt.Errorf("encode pending Access Rules: %w", err)
			}
			pendingJSON = string(encoded)
		}
		version := current.Version + 1
		if rowExists {
			result, err := tx.ExecContext(ctx, `UPDATE modelry_access_rules SET pending_json = ?, version = ?, updated_at = ? WHERE collection_id = ? AND version = ?`, pendingJSON, version, timestamp(service.now()), collectionID, current.Version)
			if err != nil {
				return fmt.Errorf("save pending Access Rules: %w", err)
			}
			if err := expectOneRow(result, "Access Rules changed while Save was running"); err != nil {
				return err
			}
		} else {
			appliedJSON, err := json.Marshal(current.Applied)
			if err != nil {
				return fmt.Errorf("encode default Access Rules: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_access_rules (collection_id, applied_json, pending_json, version, updated_at) VALUES (?, ?, ?, ?, ?)`, collectionID, string(appliedJSON), pendingJSON, version, timestamp(service.now())); err != nil {
				return fmt.Errorf("create Access Rule configuration: %w", err)
			}
		}
		if pending == nil {
			pending = current.Applied
		}
		state = RulesState{Applied: cloneRules(current.Applied), Pending: cloneRules(pending), Version: version, HasPending: pendingJSON != nil}
		return nil
	})
	return state, err
}

func (service *Service) Apply(ctx context.Context, collectionID string, expectedVersion int) (RulesState, error) {
	if expectedVersion < 1 {
		return RulesState{}, validationError("/expectedVersion", "REQUIRED", "Reload Access Rules and try again.")
	}
	var state RulesState
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		current, rowExists, err := readState(ctx, tx, collection)
		if err != nil {
			return err
		}
		if !rowExists || !current.HasPending {
			return fmt.Errorf("%w: Collection has no pending Access Rule changes", ErrNotFound)
		}
		if expectedVersion != current.Version {
			return fmt.Errorf("%w: pending Access Rules are at version %d, not %d", ErrConflict, current.Version, expectedVersion)
		}
		rules, err := normalizeRules(ctx, tx, collection, current.Pending)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(rules)
		if err != nil {
			return fmt.Errorf("encode applied Access Rules: %w", err)
		}
		version := current.Version + 1
		result, err := tx.ExecContext(ctx, `UPDATE modelry_access_rules SET applied_json = ?, pending_json = NULL, version = ?, updated_at = ? WHERE collection_id = ? AND version = ? AND pending_json IS NOT NULL`, string(encoded), version, timestamp(service.now()), collectionID, current.Version)
		if err != nil {
			return fmt.Errorf("apply Access Rules: %w", err)
		}
		if err := expectOneRow(result, "Access Rules changed while Apply was running"); err != nil {
			return err
		}
		state = RulesState{Applied: cloneRules(rules), Pending: cloneRules(rules), Version: version}
		return nil
	})
	return state, err
}

func (service *Service) Discard(ctx context.Context, collectionID string, expectedVersion int) (RulesState, error) {
	if expectedVersion < 1 {
		return RulesState{}, validationError("/expectedVersion", "REQUIRED", "Reload Access Rules and try again.")
	}
	var state RulesState
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		current, rowExists, err := readState(ctx, tx, collection)
		if err != nil {
			return err
		}
		if !rowExists || !current.HasPending {
			return fmt.Errorf("%w: Collection has no pending Access Rule changes", ErrNotFound)
		}
		if expectedVersion != current.Version {
			return fmt.Errorf("%w: pending Access Rules are at version %d, not %d", ErrConflict, current.Version, expectedVersion)
		}
		version := current.Version + 1
		result, err := tx.ExecContext(ctx, `UPDATE modelry_access_rules SET pending_json = NULL, version = ?, updated_at = ? WHERE collection_id = ? AND version = ? AND pending_json IS NOT NULL`, version, timestamp(service.now()), collectionID, current.Version)
		if err != nil {
			return fmt.Errorf("discard pending Access Rules: %w", err)
		}
		if err := expectOneRow(result, "Access Rules changed while Discard was running"); err != nil {
			return err
		}
		state = RulesState{Applied: cloneRules(current.Applied), Pending: cloneRules(current.Applied), Version: version}
		return nil
	})
	return state, err
}

// Evaluate 实现 authorization.Evaluator。它始终使用已应用规则和当前 Applied Model；策略不可用或格式错误时拒绝授权。
func (service *Service) Evaluate(ctx context.Context, collectionID string, operation authorization.Operation, principal authorization.Principal, record *authorization.Record) (authorization.Decision, error) {
	var decision authorization.Decision
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		collection, err := loadCollection(ctx, snapshot, collectionID)
		if err != nil {
			return err
		}
		state, _, err := readState(ctx, snapshot, collection)
		if err != nil {
			return err
		}
		applied, err := normalizeRules(ctx, snapshot, collection, state.Applied)
		if err != nil {
			decision = deniedDecision(operation, "ACCESS_RULE_INVALID", "The applied Access Rules could not be validated and access was denied.")
			return nil
		}
		decision = evaluateRule(ctx, snapshot, collection, applied, operation, principal, record)
		return nil
	})
	if err != nil {
		return authorization.Decision{}, err
	}
	return decision, nil
}

func evaluateRule(ctx context.Context, query storage.Executor, collection backendmodel.Collection, rules []Rule, operation authorization.Operation, principal authorization.Principal, record *authorization.Record) authorization.Decision {
	var rule *Rule
	for index := range rules {
		if rules[index].Operation == operation {
			rule = &rules[index]
			break
		}
	}
	if rule == nil {
		return deniedDecision(operation, "ACCESS_RULE_MISSING", "No applied Access Rule exists for this operation.")
	}
	allowed := false
	reasonCode := "ACCESS_RULE_DENIED"
	switch rule.Mode {
	case ModeNoAccess:
	case ModeAnyone:
		allowed = true
	case ModeSignedInUsers:
		allowed = isActiveUser(principal)
	case ModeRecordOwner:
		if operation == authorization.OperationList && record == nil && validRecordOwnerRule(ctx, query, collection, *rule) {
			return authorization.Decision{Allowed: true, Code: "ALLOW", Message: "The list request may proceed to per-record owner checks.", Reason: reasonJSON("ACCESS_RULE_ROW_FILTER_REQUIRED", operation, string(rule.Mode))}
		}
		allowed = isRecordOwner(ctx, query, collection, *rule, principal, record)
		if !allowed {
			reasonCode = "RECORD_OWNER_MISMATCH"
		}
	case ModeCustom:
		predicates, err := parseCustomRule(collection, *rule)
		if err != nil {
			return deniedDecision(operation, "CUSTOM_RULE_INVALID", "The applied Custom rule is unavailable and access was denied.")
		}
		if operation == authorization.OperationList && record == nil {
			return authorization.Decision{Allowed: true, Code: "ALLOW", Message: "The list request may proceed to per-record Custom rule checks.", Reason: reasonJSON("ACCESS_RULE_ROW_FILTER_REQUIRED", operation, string(rule.Mode))}
		}
		allowed = evaluatePredicates(predicates, record)
		if !allowed {
			reasonCode = "CUSTOM_RULE_NOT_MATCHED"
		}
	default:
		return deniedDecision(operation, "ACCESS_RULE_INVALID", "The applied Access Rule is unsupported and access was denied.")
	}
	if allowed {
		return authorization.Decision{Allowed: true, Code: "ALLOW", Message: "The applied Access Rule allows this operation.", Reason: reasonJSON("ACCESS_RULE_ALLOWED", operation, string(rule.Mode))}
	}
	return deniedDecision(operation, reasonCode, "The applied Access Rule does not allow this operation.")
}

func readState(ctx context.Context, query storage.Executor, collection backendmodel.Collection) (RulesState, bool, error) {
	var appliedJSON string
	var pendingJSON sql.NullString
	var version int
	err := query.QueryRowContext(ctx, `SELECT applied_json, pending_json, version FROM modelry_access_rules WHERE collection_id = ?`, collection.ID).Scan(&appliedJSON, &pendingJSON, &version)
	if errors.Is(err, sql.ErrNoRows) {
		rules := emptyRules()
		return RulesState{Applied: rules, Pending: cloneRules(rules), Version: 1}, false, nil
	}
	if err != nil {
		return RulesState{}, false, fmt.Errorf("read Access Rule state: %w", err)
	}
	var applied []Rule
	if err := json.Unmarshal([]byte(appliedJSON), &applied); err != nil {
		return RulesState{}, false, fmt.Errorf("decode applied Access Rules: %w", err)
	}
	if applied == nil {
		return RulesState{}, false, errors.New("persisted applied Access Rules are empty")
	}
	state := RulesState{Applied: applied, Version: version}
	if pendingJSON.Valid {
		if err := json.Unmarshal([]byte(pendingJSON.String), &state.Pending); err != nil {
			return RulesState{}, false, fmt.Errorf("decode pending Access Rules: %w", err)
		}
		if state.Pending == nil {
			return RulesState{}, false, errors.New("persisted pending Access Rules are empty")
		}
		state.HasPending = true
	} else {
		state.Pending = cloneRules(applied)
	}
	return state, true, nil
}

func loadCollection(ctx context.Context, query storage.Executor, collectionID string) (backendmodel.Collection, error) {
	if collectionID == "" {
		return backendmodel.Collection{}, validationError("/collectionId", "REQUIRED", "Select a Collection and try again.")
	}
	var modelJSON string
	if err := query.QueryRowContext(ctx, `SELECT model_json FROM modelry_backend_collections WHERE id = ?`, collectionID).Scan(&modelJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return backendmodel.Collection{}, fmt.Errorf("%w: Collection was not found", ErrNotFound)
		}
		return backendmodel.Collection{}, fmt.Errorf("read Collection Applied Model: %w", err)
	}
	var collection backendmodel.Collection
	if err := json.Unmarshal([]byte(modelJSON), &collection); err != nil {
		return backendmodel.Collection{}, fmt.Errorf("decode Collection Applied Model: %w", err)
	}
	return collection, nil
}

func timestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func expectOneRow(result sql.Result, message string) error {
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("verify Access Rule transition: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("%w: %s", ErrConflict, message)
	}
	return nil
}

func rulesEqual(left, right []Rule) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func deniedDecision(operation authorization.Operation, code, message string) authorization.Decision {
	return authorization.Decision{Allowed: false, Code: "FORBIDDEN", Message: message, Reason: reasonJSON(code, operation, "")}
}

func reasonJSON(code string, operation authorization.Operation, mode string) json.RawMessage {
	value := map[string]string{"code": code, "operation": string(operation)}
	if mode != "" {
		value["mode"] = mode
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

var _ authorization.Evaluator = (*Service)(nil)
