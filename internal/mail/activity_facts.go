package mail

import (
	"context"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ActivityFacts 返回 Mail Delivery 事实。收件地址、正文与 token 永不进入 Activity。
func (service *Service) ActivityFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	if service == nil || query == nil {
		return nil, fmt.Errorf("%w: mail Activity facts are unavailable", activity.ErrStorage)
	}
	if limit <= 0 {
		return nil, nil
	}
	rows, err := query.QueryContext(ctx, `SELECT id, status, created_at, completed_at
		FROM modelry_mail_deliveries
		ORDER BY created_at DESC, id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read mail delivery facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, status, createdAt string
		var completedAt *string
		if err := rows.Scan(&id, &status, &createdAt, &completedAt); err != nil {
			return nil, fmt.Errorf("%w: read mail delivery facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			continue
		}
		fact := activity.Fact{
			ID: "af_mail_delivery_" + id, Kind: activity.KindMailDelivery, Status: status,
			OccurredAt: occurred.UTC(), ResourceKind: "mailDelivery", ResourceID: id,
			DeepLink: "/settings/mail",
		}
		if completedAt != nil {
			if finished, err := time.Parse(time.RFC3339Nano, *completedAt); err == nil && finished.After(occurred) {
				fact.OccurredAt = finished.UTC()
			}
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read mail delivery facts", activity.ErrStorage)
	}
	return facts, nil
}