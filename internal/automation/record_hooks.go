package automation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) Before(_ context.Context, change recordlifecycle.BeforeChange) (map[string]any, error) {
	return change.Values, nil
}

// AppendIntent 在 Record 当前 SQLite 事务中写入不可变的 Event Hook Delivery 意图，不执行网络或 Secret 操作。
func (service *Service) AppendIntent(ctx context.Context, tx storage.Executor, event recordevents.Event) error {
	if service == nil || tx == nil || event.ID == "" || event.CollectionID == "" || event.RecordID == "" || event.SchemaVersion < 1 {
		return nil
	}
	if event.Type != recordevents.Created && event.Type != recordevents.Updated && event.Type != recordevents.Deleted {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT h.id,h.webhook_id FROM modelry_automation_event_hooks h
		JOIN modelry_automation_webhooks w ON w.id=h.webhook_id
		WHERE h.collection_id=? AND h.event_type=? AND h.enabled=1 AND w.enabled=1 ORDER BY h.id LIMIT 64`, event.CollectionID, string(event.Type))
	if err != nil {
		return err
	}
	type selectedHook struct{ id, webhookID string }
	hooks := make([]selectedHook, 0, 4)
	for rows.Next() {
		var hook selectedHook
		if err := rows.Scan(&hook.id, &hook.webhookID); err != nil {
			_ = rows.Close()
			return err
		}
		hooks = append(hooks, hook)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, hook := range hooks {
		id, err := newResourceID("dlv_")
		if err != nil {
			return err
		}
		body := map[string]any{
			"id": event.ID, "type": string(event.Type), "occurredAt": event.OccurredAt.UTC().Format(time.RFC3339Nano),
			"collectionId": event.CollectionID, "recordId": event.RecordID, "schemaVersion": event.SchemaVersion,
		}
		if event.Before != nil {
			body["before"] = event.Before
		}
		if event.After != nil {
			body["after"] = event.After
		}
		payload, err := json.Marshal(map[string]any{"deliveryId": id, "event": body})
		if err != nil {
			return errors.New("cannot encode immutable Webhook Event payload")
		}
		if _, err := service.createDeliveryInTransaction(ctx, tx, deliveryIntent{
			id: id, sourceType: "eventHook", sourceID: hook.id, webhookID: hook.webhookID,
			eventID: event.ID, eventType: string(event.Type), payload: payload,
		}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
	}
	return nil
}

func (service *Service) AfterCommit(_ context.Context, event recordevents.Event) {
	if service == nil || event.ID == "" {
		return
	}
	select {
	case service.wake <- struct{}{}:
	default:
	}
}

var _ recordlifecycle.Hooks = (*Service)(nil)
