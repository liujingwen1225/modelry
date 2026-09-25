package automation

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// ActivityFacts 返回 Webhook Delivery 与 Job Run 事实。payload 与签名材料永不进入 Activity。
func (service *Service) ActivityFacts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	if service == nil || query == nil {
		return nil, fmt.Errorf("%w: automation Activity facts are unavailable", activity.ErrStorage)
	}
	if limit <= 0 {
		return nil, nil
	}
	rows, err := query.QueryContext(ctx, `SELECT d.id, d.source_type, d.source_id, d.status, d.created_at, d.completed_at,
			COALESCE(w.name, ''), COALESCE(j.name, '')
		FROM modelry_automation_deliveries d
		LEFT JOIN modelry_automation_webhooks w ON w.id = d.webhook_id
		LEFT JOIN modelry_automation_jobs j ON j.id = d.source_id AND d.source_type = 'job'
		ORDER BY d.created_at DESC, d.id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: read automation delivery facts", activity.ErrStorage)
	}
	defer rows.Close()
	facts := make([]activity.Fact, 0, limit)
	for rows.Next() {
		var id, sourceType, sourceID, status, createdAt string
		var completedAt sql.NullString
		var webhookName, jobName string
		if err := rows.Scan(&id, &sourceType, &sourceID, &status, &createdAt, &completedAt, &webhookName, &jobName); err != nil {
			return nil, fmt.Errorf("%w: read automation delivery facts", activity.ErrStorage)
		}
		occurred, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			continue
		}
		fact := activity.Fact{
			ID: "af_delivery_" + id, Status: status, OccurredAt: occurred.UTC(),
			ResourceKind: "delivery", ResourceID: id,
		}
		switch sourceType {
		case "job":
			fact.Kind = activity.KindJobRun
			fact.Title = jobName
			fact.DeepLink = "/automations?tab=deliveries&source=job&deliveryId=" + id
			fact.CollectionID = ""
		default:
			fact.Kind = activity.KindWebhookDelivery
			fact.Title = webhookName
			fact.DeepLink = "/automations?tab=deliveries&deliveryId=" + id
		}
		if completedAt.Valid {
			if finished, err := time.Parse(time.RFC3339Nano, completedAt.String); err == nil && finished.After(occurred) {
				fact.OccurredAt = finished.UTC()
			}
		}
		if sourceType == "job" {
			fact.ResourceKind = "jobRun"
			fact.ResourceID = sourceID
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: read automation delivery facts", activity.ErrStorage)
	}
	return facts, nil
}