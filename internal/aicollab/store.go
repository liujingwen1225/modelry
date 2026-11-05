package aicollab

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// transactionalStore 是 aicollab 拥有的持久化边界。*storage.Store 天然满足：
// 写操作走 WithTransaction，纯读走 WithReadSnapshot，都是短事务。
type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// 两张新表的 DDL，全部 CREATE TABLE IF NOT EXISTS，在 NewModule 的单个事务里执行。
var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS modelry_ai_proposals (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		requirement TEXT NOT NULL,
		collection_id TEXT NOT NULL,
		understanding_json TEXT NOT NULL,
		status TEXT NOT NULL,
		change_set_id TEXT NOT NULL DEFAULT '',
		field_name TEXT NOT NULL DEFAULT '',
		error_code TEXT NOT NULL DEFAULT '',
		error_message TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS modelry_ai_share_links (
		id TEXT PRIMARY KEY,
		token TEXT NOT NULL UNIQUE,
		proposal_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		revoked_at TEXT NOT NULL DEFAULT '',
		scope TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS modelry_ai_share_links_proposal_idx
		ON modelry_ai_share_links (proposal_id)`,
}

const proposalColumns = `id, title, requirement, collection_id, understanding_json, status,
	change_set_id, field_name, error_code, error_message, created_at, updated_at`

const shareColumns = `id, token, proposal_id, created_at, expires_at, revoked_at, scope`

// scanner 同时兼容 *sql.Row 与 *sql.Rows 的 Scan。
type scanner interface {
	Scan(dest ...any) error
}

// repository 封装两张表的参数化 SQL 访问；所有 SQL 均使用占位符。
type repository struct {
	store transactionalStore
}

// initSchema 在一个事务里建好两张表（及一个查询索引）。
func (r *repository) initSchema(ctx context.Context) error {
	return r.store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, statement := range schemaStatements {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("初始化 AI 协作存储结构失败: %w", err)
			}
		}
		return nil
	})
}

func scanProposal(s scanner, p *Proposal) error {
	var understanding string
	if err := s.Scan(
		&p.ID, &p.Title, &p.Requirement, &p.CollectionID, &understanding, &p.Status,
		&p.ChangeSetID, &p.FieldName, &p.ErrorCode, &p.ErrorMessage, &p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return err
	}
	p.UnderstandingJSON = json.RawMessage(understanding)
	return nil
}

func scanShare(s scanner, item *shareRecord) error {
	return s.Scan(&item.ID, &item.Token, &item.ProposalID, &item.CreatedAt,
		&item.ExpiresAt, &item.RevokedAt, &item.Scope)
}

func (r *repository) insertProposal(ctx context.Context, p Proposal) error {
	return r.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_ai_proposals
			(id, title, requirement, collection_id, understanding_json, status,
			 change_set_id, field_name, error_code, error_message, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			p.ID, p.Title, p.Requirement, p.CollectionID, string(p.UnderstandingJSON), p.Status,
			p.ChangeSetID, p.FieldName, p.ErrorCode, p.ErrorMessage, p.CreatedAt, p.UpdatedAt)
		return err
	})
}

// updateProposal 只更新创建后可变的字段：状态、变更集、错误与更新时间。
func (r *repository) updateProposal(ctx context.Context, p Proposal) error {
	return r.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_ai_proposals
			SET status = ?, change_set_id = ?, error_code = ?, error_message = ?, updated_at = ?
			WHERE id = ?`,
			p.Status, p.ChangeSetID, p.ErrorCode, p.ErrorMessage, p.UpdatedAt, p.ID)
		return err
	})
}

func (r *repository) getProposal(ctx context.Context, id string) (Proposal, bool, error) {
	var p Proposal
	found := false
	err := r.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		err := scanProposal(tx.QueryRowContext(ctx,
			`SELECT `+proposalColumns+` FROM modelry_ai_proposals WHERE id = ?`, id), &p)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	return p, found, err
}

func (r *repository) listProposals(ctx context.Context) ([]Proposal, error) {
	items := make([]Proposal, 0)
	err := r.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT `+proposalColumns+` FROM modelry_ai_proposals ORDER BY created_at DESC, id DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p Proposal
			if err := scanProposal(rows, &p); err != nil {
				return err
			}
			items = append(items, p)
		}
		return rows.Err()
	})
	return items, err
}

func (r *repository) insertShare(ctx context.Context, item shareRecord) error {
	return r.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_ai_share_links
			(id, token, proposal_id, created_at, expires_at, revoked_at, scope)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			item.ID, item.Token, item.ProposalID, item.CreatedAt, item.ExpiresAt, item.RevokedAt, item.Scope)
		return err
	})
}

func (r *repository) getShareByID(ctx context.Context, id string) (shareRecord, bool, error) {
	return r.getShare(ctx, `SELECT `+shareColumns+` FROM modelry_ai_share_links WHERE id = ?`, id)
}

func (r *repository) getShareByToken(ctx context.Context, token string) (shareRecord, bool, error) {
	return r.getShare(ctx, `SELECT `+shareColumns+` FROM modelry_ai_share_links WHERE token = ?`, token)
}

func (r *repository) getShare(ctx context.Context, query, key string) (shareRecord, bool, error) {
	var item shareRecord
	found := false
	err := r.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		err := scanShare(tx.QueryRowContext(ctx, query, key), &item)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	return item, found, err
}

func (r *repository) listShares(ctx context.Context, proposalID string) ([]shareRecord, error) {
	items := make([]shareRecord, 0)
	err := r.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT `+shareColumns+` FROM modelry_ai_share_links WHERE proposal_id = ? ORDER BY created_at DESC, id DESC`, proposalID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item shareRecord
			if err := scanShare(rows, &item); err != nil {
				return err
			}
			items = append(items, item)
		}
		return rows.Err()
	})
	return items, err
}

// revokeShare 写入 revoked_at，仅在尚未撤销时生效，保证重复调用幂等。
func (r *repository) revokeShare(ctx context.Context, id, at string) error {
	return r.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx,
			`UPDATE modelry_ai_share_links SET revoked_at = ? WHERE id = ? AND revoked_at = ''`, at, id)
		return err
	})
}
