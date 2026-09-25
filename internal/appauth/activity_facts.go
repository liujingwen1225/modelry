package appauth

import (
	"context"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ActivityFacts 返回 App User 恢复流程事实。它只引用 App User Record id，永不返回邮箱地址或 token。
func (service *Service) ActivityFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	if service == nil || query == nil {
		return nil, fmt.Errorf("%w: app auth Activity facts are unavailable", activity.ErrStorage)
	}
	if limit <= 0 {
		return nil, nil
	}
	now := time.Now().UTC()
	rows, err := query.QueryContext(ctx, `SELECT id, collection_id, user_record_id, purpose, used_at, expires_at, created_at
		FROM modelry_app_recovery_tokens
		ORDER BY created_at DESC, id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read recovery facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, collectionID, userID, purpose, createdAt string
		var usedAt, expiresAt *string
		if err := rows.Scan(&id, &collectionID, &userID, &purpose, &usedAt, &expiresAt, &createdAt); err != nil {
			return nil, fmt.Errorf("%w: read recovery facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			continue
		}
		status := "requested"
		if usedAt != nil {
			status = "confirmed"
			if confirmed, err := time.Parse(time.RFC3339Nano, *usedAt); err == nil {
				occurred = confirmed.UTC()
			}
		} else if expiresAt != nil {
			if expires, err := time.Parse(time.RFC3339Nano, *expiresAt); err == nil && !expires.After(now) {
				status = "expired"
			}
		}
		facts = append(facts, activity.Fact{
			ID: "af_recovery_" + id, Kind: activity.KindAuthRecovery, Status: status,
			OccurredAt: occurred.UTC(), ResourceKind: "appUser", ResourceID: userID,
			CollectionID: collectionID,
			DeepLink:     "/collections/" + collectionID + "/security?panel=users&user=" + userID,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read recovery facts", activity.ErrStorage)
	}
	return facts, nil
}