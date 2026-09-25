package automation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) CreateEventHook(ctx context.Context, input EventHookInput) (EventHook, error) {
	input.Name = strings.TrimSpace(input.Name)
	if err := validateName(input.Name, "/name"); err != nil {
		return EventHook{}, err
	}
	if input.EventType != "record.created" && input.EventType != "record.updated" && input.EventType != "record.deleted" {
		return EventHook{}, invalidField("/eventType", "invalidEventType", "Choose a supported Record Event type.")
	}
	if input.CollectionID == "" || input.WebhookID == "" {
		return EventHook{}, invalidField("/collectionId", "invalidCollection", "Choose an existing Collection and Webhook.")
	}
	id, err := newResourceID("evh_")
	if err != nil {
		return EventHook{}, err
	}
	now := service.now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_backend_collections WHERE id=?`, input.CollectionID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/collectionId", "invalidCollection", "Choose an existing Collection.")
		} else if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_webhooks WHERE id=?`, input.WebhookID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_event_hooks`).Scan(&count); err != nil {
			return err
		}
		if count >= 64 {
			return invalidField("/name", "tooManyEventHooks", "A Project can have at most 64 Event Hooks.")
		}
		var duplicate int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_event_hooks WHERE collection_id=? AND event_type=? AND webhook_id=?`, input.CollectionID, input.EventType, input.WebhookID).Scan(&duplicate); err == nil {
			return invalidField("/eventType", "duplicateEventHook", "An Event Hook already uses this Collection, event type, and Webhook.")
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_event_hooks(id,name,collection_id,event_type,webhook_id,enabled,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)`, id, input.Name, input.CollectionID, input.EventType, input.WebhookID, stamp, stamp)
		if err != nil {
			return mapEventHookWriteError(err)
		}
		return nil
	})
	if err != nil {
		return EventHook{}, err
	}
	return service.GetEventHook(ctx, id)
}

func (service *Service) ReplaceEventHook(ctx context.Context, eventHookID string, input EventHookInput) (EventHook, error) {
	input.Name = strings.TrimSpace(input.Name)
	if err := validateName(input.Name, "/name"); err != nil {
		return EventHook{}, err
	}
	if input.EventType != "record.created" && input.EventType != "record.updated" && input.EventType != "record.deleted" {
		return EventHook{}, invalidField("/eventType", "invalidEventType", "Choose a supported Record Event type.")
	}
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_event_hooks WHERE id=?`, eventHookID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_backend_collections WHERE id=?`, input.CollectionID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/collectionId", "invalidCollection", "Choose an existing Collection.")
		} else if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_webhooks WHERE id=?`, input.WebhookID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var duplicate int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_event_hooks WHERE collection_id=? AND event_type=? AND webhook_id=? AND id<>?`, input.CollectionID, input.EventType, input.WebhookID, eventHookID).Scan(&duplicate); err == nil {
			return invalidField("/eventType", "duplicateEventHook", "An Event Hook already uses this Collection, event type, and Webhook.")
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE modelry_automation_event_hooks SET name=?,collection_id=?,event_type=?,webhook_id=?,updated_at=? WHERE id=?`, input.Name, input.CollectionID, input.EventType, input.WebhookID, service.now().UTC().Format(time.RFC3339Nano), eventHookID)
		if err != nil {
			return mapEventHookWriteError(err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return EventHook{}, err
	}
	return service.GetEventHook(ctx, eventHookID)
}

func (service *Service) EnableEventHook(ctx context.Context, eventHookID string) (EventHookStatus, error) {
	return service.setEventHookEnabled(ctx, eventHookID, true)
}

func (service *Service) DisableEventHook(ctx context.Context, eventHookID string) (EventHookStatus, error) {
	return service.setEventHookEnabled(ctx, eventHookID, false)
}

func (service *Service) setEventHookEnabled(ctx context.Context, eventHookID string, enabled bool) (EventHookStatus, error) {
	var result EventHookStatus
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		status := 0
		if enabled {
			status = 1
		}
		updated, err := tx.ExecContext(ctx, `UPDATE modelry_automation_event_hooks SET enabled=?,updated_at=? WHERE id=?`, status, service.now().UTC().Format(time.RFC3339Nano), eventHookID)
		if err != nil {
			return err
		}
		count, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		result = EventHookStatus{ID: eventHookID, Enabled: enabled}
		return nil
	})
	return result, err
}

func (service *Service) GetEventHook(ctx context.Context, eventHookID string) (EventHook, error) {
	var item EventHook
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var enabled int
		var created, updated string
		err := snapshot.QueryRowContext(ctx, `SELECT h.id,h.name,h.collection_id,c.name,h.event_type,h.webhook_id,w.name,h.enabled,h.created_at,h.updated_at
			FROM modelry_automation_event_hooks h JOIN modelry_backend_collections c ON c.id=h.collection_id JOIN modelry_automation_webhooks w ON w.id=h.webhook_id WHERE h.id=?`, eventHookID).
			Scan(&item.ID, &item.Name, &item.CollectionID, &item.CollectionName, &item.EventType, &item.WebhookID, &item.WebhookName, &enabled, &created, &updated)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		item.Enabled = enabled == 1
		item.CreatedAt, item.UpdatedAt = parseTime(created), parseTime(updated)
		return nil
	})
	return item, err
}

func (service *Service) ListEventHooks(ctx context.Context) ([]EventHook, error) {
	items := make([]EventHook, 0)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT h.id,h.name,h.collection_id,c.name,h.event_type,h.webhook_id,w.name,h.enabled,h.created_at,h.updated_at
			FROM modelry_automation_event_hooks h JOIN modelry_backend_collections c ON c.id=h.collection_id JOIN modelry_automation_webhooks w ON w.id=h.webhook_id ORDER BY h.updated_at DESC,h.id LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item EventHook
			var enabled int
			var created, updated string
			if err := rows.Scan(&item.ID, &item.Name, &item.CollectionID, &item.CollectionName, &item.EventType, &item.WebhookID, &item.WebhookName, &enabled, &created, &updated); err != nil {
				return err
			}
			item.Enabled = enabled == 1
			item.CreatedAt, item.UpdatedAt = parseTime(created), parseTime(updated)
			items = append(items, item)
		}
		return rows.Err()
	})
	return items, err
}

func mapEventHookWriteError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "unique constraint failed") {
		return invalidField("/eventType", "duplicateEventHook", "An Event Hook already uses this Collection, event type, and Webhook.")
	}
	if strings.Contains(message, "foreign key constraint failed") {
		return ErrNotFound
	}
	return fmt.Errorf("persist Event Hook: %w", err)
}
