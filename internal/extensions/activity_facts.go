package extensions

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ActivityFacts 返回 Extension Run 事实。source、payload 与 Secret 绑定永不进入 Activity。
func (service *Service) ActivityFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	if service == nil || query == nil {
		return nil, fmt.Errorf("%w: extension Activity facts are unavailable", activity.ErrStorage)
	}
	if limit <= 0 {
		return nil, nil
	}
	rows, err := query.QueryContext(ctx, `SELECT r.id, r.extension_id, r.collection_id, r.status, r.started_at, r.completed_at, COALESCE(e.name, '')
		FROM modelry_extension_runs r
		LEFT JOIN modelry_extensions e ON e.id = r.extension_id
		ORDER BY r.started_at DESC, r.id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read extension run facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, extensionID, collectionID, status, startedAt string
		var completedAt sql.NullString
		var name string
		if err := rows.Scan(&id, &extensionID, &collectionID, &status, &startedAt, &completedAt, &name); err != nil {
			return nil, fmt.Errorf("%w: read extension run facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, startedAt)
		if err != nil {
			continue
		}
		fact := activity.Fact{
			ID: "af_extension_run_" + id, Kind: activity.KindExtensionRun, Status: status,
			OccurredAt: occurred.UTC(), ResourceKind: "extensionRun", ResourceID: id,
			CollectionID: collectionID, Title: name,
			DeepLink: "/extensions/" + extensionID + "?tab=runs&run=" + id,
		}
		if completedAt.Valid {
			if finished, err := time.Parse(time.RFC3339Nano, completedAt.String); err == nil && finished.After(occurred) {
				fact.OccurredAt = finished.UTC()
			}
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read extension run facts", activity.ErrStorage)
	}
	return facts, nil
}