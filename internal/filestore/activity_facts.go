package filestore

import (
	"context"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ActivityFacts 返回 File Storage Migration 事实。凭据 Secret 与对象内容永不进入 Activity。
func (service *Service) ActivityFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	if service == nil || query == nil {
		return nil, fmt.Errorf("%w: file storage Activity facts are unavailable", activity.ErrStorage)
	}
	if limit <= 0 {
		return nil, nil
	}
	rows, err := query.QueryContext(ctx, `SELECT id, status, started_at, updated_at
		FROM modelry_file_migrations
		ORDER BY started_at DESC, id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read storage migration facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, status, startedAt, updatedAt string
		if err := rows.Scan(&id, &status, &startedAt, &updatedAt); err != nil {
			return nil, fmt.Errorf("%w: read storage migration facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, startedAt)
		if err != nil {
			continue
		}
		fact := activity.Fact{
			ID: "af_storage_migration_" + id, Kind: activity.KindStorageMigration, Status: status,
			OccurredAt: occurred.UTC(), ResourceKind: "fileMigration", ResourceID: id,
			DeepLink: "/settings/storage",
		}
		if finished, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil && finished.After(occurred) {
			fact.OccurredAt = finished.UTC()
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read storage migration facts", activity.ErrStorage)
	}
	return facts, nil
}