package backendmodel

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ActivityFacts 返回 Model Change 相关事实：已应用迁移、待应用变更与失败变更。
// 它只读取 backend model 自己的表，并使用调用方提供的只读快照。
func (service *Service) ActivityFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	if service == nil || query == nil {
		return nil, fmt.Errorf("%w: backend model Activity facts are unavailable", activity.ErrStorage)
	}
	if limit <= 0 {
		return nil, nil
	}
	facts := make([]activity.Fact, 0, limit)
	applied, err := service.activityAppliedFacts(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	facts = append(facts, applied...)
	changes, err := service.activityChangeFacts(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	facts = append(facts, changes...)
	return facts, nil
}

func (service *Service) activityAppliedFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	rows, err := query.QueryContext(ctx, `SELECT m.id, m.change_set_id, m.collection_id, m.applied_at, c.name
		FROM modelry_backend_applied_migrations m
		LEFT JOIN modelry_backend_collections c ON c.id = m.collection_id
		ORDER BY m.applied_at DESC, m.id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read applied migration facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, changeSetID, collectionID, appliedAt string
		var name sql.NullString
		if err := rows.Scan(&id, &changeSetID, &collectionID, &appliedAt, &name); err != nil {
			return nil, fmt.Errorf("%w: read applied migration facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, appliedAt)
		if err != nil {
			continue
		}
		fact := activity.Fact{
			ID: "af_change_applied_" + id, Kind: activity.KindChangeApplied, Status: "applied",
			OccurredAt: occurred.UTC(), ResourceKind: "changeSet", ResourceID: changeSetID,
			CollectionID: collectionID, DeepLink: "/changes?changeSet=" + changeSetID,
		}
		if name.Valid {
			fact.Title = name.String
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: read applied migration facts", activity.ErrStorage)
	}
	return facts, nil
}

func (service *Service) activityChangeFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	rows, err := query.QueryContext(ctx, `SELECT ch.id, ch.collection_id, ch.status, ch.updated_at, c.name
		FROM modelry_backend_changes ch
		LEFT JOIN modelry_backend_collections c ON c.id = ch.collection_id
		ORDER BY ch.updated_at DESC, ch.id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read change set facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, collectionID, status, updatedAt string
		var name sql.NullString
		if err := rows.Scan(&id, &collectionID, &status, &updatedAt, &name); err != nil {
			return nil, fmt.Errorf("%w: read change set facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, updatedAt)
		if err != nil {
			continue
		}
		fact := activity.Fact{
			ID: "af_change_" + id, Status: status, OccurredAt: occurred.UTC(),
			ResourceKind: "changeSet", ResourceID: id, CollectionID: collectionID,
			DeepLink: "/changes?changeSet=" + id,
		}
		switch status {
		case "ready", "needsReview", "pending":
			fact.Kind = activity.KindChangePending
			fact.DeepLink = "/collections/" + collectionID + "/schema"
		case "failed":
			fact.Kind = activity.KindChangeFailed
		default:
			continue
		}
		if name.Valid {
			fact.Title = name.String
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read change set facts", activity.ErrStorage)
	}
	return facts, nil
}