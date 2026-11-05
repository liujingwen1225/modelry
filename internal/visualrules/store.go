package visualrules

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// transactionalStore 是本模块唯一使用的持久化边界，*storage.Store 天然满足。
// 应用代码在短事务之外拿不到任何数据库句柄。
type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// collectionLookup 让规则校验可以读取真实的目标集合模型；*backendmodel.Service 满足。
type collectionLookup interface {
	GetCollection(context.Context, string) (backendmodel.Collection, error)
}

// recordCreator 抽象「往集合写入一条真实 Record」；*records.Service.Create 满足。
type recordCreator interface {
	Create(context.Context, string, map[string]any) (records.Record, error)
}

// rulesService 持有事务边界与两个外部能力，不直接依赖 Runtime。
type rulesService struct {
	store       transactionalStore
	collections collectionLookup
	creator     recordCreator
}

var (
	errRuleNotFound     = errors.New("visual rule not found")
	errRunNotFound      = errors.New("visual rule run not found")
	errRuleNameConflict = errors.New("visual rule name already exists")
)

// 建表与索引在 NewModule 的同一个事务内完成，全部使用 IF NOT EXISTS，可重复启动。
var visualRulesSchema = []string{
	`CREATE TABLE IF NOT EXISTS modelry_visual_rules (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		trigger_collection_id TEXT NOT NULL,
		trigger_event TEXT NOT NULL,
		target_collection_id TEXT NOT NULL,
		values_json TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		retry_enabled INTEGER NOT NULL DEFAULT 0,
		timeout_ms INTEGER NOT NULL DEFAULT 3000,
		revision INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_visual_rule_runs (
		id TEXT PRIMARY KEY NOT NULL,
		rule_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		values_json TEXT NOT NULL,
		record_id TEXT NOT NULL DEFAULT '',
		error_code TEXT NOT NULL DEFAULT '',
		error_message TEXT NOT NULL DEFAULT '',
		attempt_of TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		finished_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_visual_rule_runs_by_rule
		ON modelry_visual_rule_runs(rule_id, created_at DESC, id DESC)`,
}

const (
	selectRuleColumns = `id, name, trigger_collection_id, trigger_event, target_collection_id, values_json, enabled, retry_enabled, timeout_ms, revision, created_at, updated_at`
	selectRunColumns  = `id, rule_id, kind, status, payload_json, values_json, record_id, error_code, error_message, attempt_of, created_at, finished_at`
)

// newService 建表并返回一个尚未接线的 rulesService，供 NewModule 与单元测试复用。
func newService(store transactionalStore) (*rulesService, error) {
	if store == nil {
		return nil, errors.New("visualrules: storage is required")
	}
	ctx := context.Background()
	service := &rulesService{store: store}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range visualRulesSchema {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("初始化可视化规则持久化表: %w", err)
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return service, nil
}

// rowScanner 同时覆盖 *sql.Row 与 *sql.Rows 的 Scan。
type rowScanner interface {
	Scan(dest ...any) error
}

func scanRule(scanner rowScanner) (rule, error) {
	var item rule
	var valuesJSON string
	var enabled, retryEnabled int
	err := scanner.Scan(
		&item.ID, &item.Name, &item.TriggerCollectionID, &item.TriggerEvent, &item.TargetCollectionID,
		&valuesJSON, &enabled, &retryEnabled, &item.TimeoutMs, &item.Revision, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return rule{}, err
	}
	values, err := decodeStringMap(valuesJSON)
	if err != nil {
		return rule{}, err
	}
	item.Values = values
	item.Enabled = intToBool(enabled)
	item.RetryEnabled = intToBool(retryEnabled)
	return item, nil
}

func scanRun(scanner rowScanner) (run, error) {
	var item run
	var payloadJSON, valuesJSON string
	err := scanner.Scan(
		&item.ID, &item.RuleID, &item.Kind, &item.Status, &payloadJSON, &valuesJSON,
		&item.RecordID, &item.ErrorCode, &item.ErrorMessage, &item.AttemptOf, &item.CreatedAt, &item.FinishedAt,
	)
	if err != nil {
		return run{}, err
	}
	payload, err := decodePayload(payloadJSON)
	if err != nil {
		return run{}, err
	}
	values, err := decodeStringMap(valuesJSON)
	if err != nil {
		return run{}, err
	}
	item.Payload = payload
	item.Values = values
	return item, nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique")
}

// loadRule 读取单条规则，不存在时返回可识别的哨兵错误。
func (service *rulesService) loadRule(ctx context.Context, id string) (rule, error) {
	var item rule
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		scanned, err := scanRule(tx.QueryRowContext(ctx, `SELECT `+selectRuleColumns+` FROM `+tableRules+` WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return errRuleNotFound
		}
		if err != nil {
			return fmt.Errorf("读取可视化规则: %w", err)
		}
		item = scanned
		return nil
	})
	return item, err
}

func (service *rulesService) listRuleRows(ctx context.Context) ([]rule, error) {
	items := make([]rule, 0)
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+selectRuleColumns+` FROM `+tableRules+` ORDER BY created_at, id`)
		if err != nil {
			return fmt.Errorf("列出可视化规则: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanRule(rows)
			if err != nil {
				return fmt.Errorf("扫描可视化规则: %w", err)
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("结束列出可视化规则: %w", err)
		}
		return rows.Close()
	})
	return items, err
}

func (service *rulesService) insertRule(ctx context.Context, item rule) error {
	valuesJSON, err := encodeStringMap(item.Values)
	if err != nil {
		return err
	}
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO `+tableRules+` (
			id, name, trigger_collection_id, trigger_event, target_collection_id, values_json,
			enabled, retry_enabled, timeout_ms, revision, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			item.ID, item.Name, item.TriggerCollectionID, item.TriggerEvent, item.TargetCollectionID, valuesJSON,
			boolToInt(item.Enabled), boolToInt(item.RetryEnabled), item.TimeoutMs, item.Revision, item.CreatedAt, item.UpdatedAt,
		)
		if isUniqueViolation(err) {
			return errRuleNameConflict
		}
		if err != nil {
			return fmt.Errorf("写入可视化规则: %w", err)
		}
		return nil
	})
}

func (service *rulesService) updateRule(ctx context.Context, item rule) error {
	valuesJSON, err := encodeStringMap(item.Values)
	if err != nil {
		return err
	}
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE `+tableRules+` SET
			name = ?, trigger_collection_id = ?, trigger_event = ?, target_collection_id = ?, values_json = ?,
			enabled = ?, retry_enabled = ?, timeout_ms = ?, revision = ?, updated_at = ? WHERE id = ?`,
			item.Name, item.TriggerCollectionID, item.TriggerEvent, item.TargetCollectionID, valuesJSON,
			boolToInt(item.Enabled), boolToInt(item.RetryEnabled), item.TimeoutMs, item.Revision, item.UpdatedAt, item.ID,
		)
		if isUniqueViolation(err) {
			return errRuleNameConflict
		}
		if err != nil {
			return fmt.Errorf("更新可视化规则: %w", err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("读取可视化规则更新结果: %w", err)
		}
		if count != 1 {
			return errRuleNotFound
		}
		return nil
	})
}

// setRuleEnabled 在一个事务里更新开关并回读，保证返回值与落盘一致。
func (service *rulesService) setRuleEnabled(ctx context.Context, id string, enabled bool) (rule, error) {
	var item rule
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE `+tableRules+` SET enabled = ?, updated_at = ? WHERE id = ?`, boolToInt(enabled), nowText(), id)
		if err != nil {
			return fmt.Errorf("更新可视化规则开关: %w", err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("读取可视化规则开关更新结果: %w", err)
		}
		if count != 1 {
			return errRuleNotFound
		}
		scanned, err := scanRule(tx.QueryRowContext(ctx, `SELECT `+selectRuleColumns+` FROM `+tableRules+` WHERE id = ?`, id))
		if err != nil {
			return fmt.Errorf("回读可视化规则: %w", err)
		}
		item = scanned
		return nil
	})
	return item, err
}

func (service *rulesService) insertRun(ctx context.Context, item run) error {
	payloadJSON, err := encodePayload(item.Payload)
	if err != nil {
		return err
	}
	valuesJSON, err := encodeStringMap(item.Values)
	if err != nil {
		return err
	}
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO `+tableRuns+` (
			id, rule_id, kind, status, payload_json, values_json, record_id,
			error_code, error_message, attempt_of, created_at, finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			item.ID, item.RuleID, item.Kind, item.Status, payloadJSON, valuesJSON, item.RecordID,
			item.ErrorCode, item.ErrorMessage, item.AttemptOf, item.CreatedAt, item.FinishedAt,
		)
		if err != nil {
			return fmt.Errorf("写入可视化规则执行记录: %w", err)
		}
		return nil
	})
}

func (service *rulesService) loadRun(ctx context.Context, id string) (run, error) {
	var item run
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		scanned, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+selectRunColumns+` FROM `+tableRuns+` WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return errRunNotFound
		}
		if err != nil {
			return fmt.Errorf("读取可视化规则执行记录: %w", err)
		}
		item = scanned
		return nil
	})
	return item, err
}

func (service *rulesService) listRunRows(ctx context.Context, ruleID string) ([]run, error) {
	items := make([]run, 0)
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+selectRunColumns+` FROM `+tableRuns+` WHERE rule_id = ? ORDER BY created_at DESC, id DESC`, ruleID)
		if err != nil {
			return fmt.Errorf("列出可视化规则执行记录: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanRun(rows)
			if err != nil {
				return fmt.Errorf("扫描可视化规则执行记录: %w", err)
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("结束列出可视化规则执行记录: %w", err)
		}
		return rows.Close()
	})
	return items, err
}
