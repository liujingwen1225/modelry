package automation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	maximumPendingDeliveries  = 1000
	maximumRetainedDeliveries = 5000
	maximumRetainedPayloads   = 64 << 20
	maximumDeliveryPayload    = 1 << 20
)

type deliveryIntent struct {
	id         string
	sourceType string
	sourceID   string
	webhookID  string
	eventID    string
	eventType  string
	sourceSlot string
	payload    []byte
	allowOff   bool
}

func (service *Service) createDeliveryInTransaction(ctx context.Context, tx storage.Executor, intent deliveryIntent) (Delivery, error) {
	if intent.id == "" {
		id, err := newResourceID("dlv_")
		if err != nil {
			return Delivery{}, err
		}
		intent.id = id
	}
	var webhookName, targetURL, secretID string
	var enabled int
	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT name,target_url,signing_secret_id,enabled,revision FROM modelry_automation_webhooks WHERE id=?`, intent.webhookID).
		Scan(&webhookName, &targetURL, &secretID, &enabled, &revision); errors.Is(err, sql.ErrNoRows) {
		return Delivery{}, ErrNotFound
	} else if err != nil {
		return Delivery{}, err
	}
	if enabled != 1 && !intent.allowOff {
		return Delivery{}, invalidField("/webhookId", "invalidWebhook", "Enable the selected Webhook before creating this Delivery.")
	}
	now := service.now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	status, errorCode := "pending", "none"
	retainPayload := len(intent.payload) > 0 && len(intent.payload) <= maximumDeliveryPayload
	var pendingCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_deliveries WHERE status IN ('pending','running')`).Scan(&pendingCount); err != nil {
		return Delivery{}, err
	}
	var retainedCount int
	var retainedBytes int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(length(payload)),0) FROM modelry_automation_deliveries`).Scan(&retainedCount, &retainedBytes); err != nil {
		return Delivery{}, err
	}
	capacityExceeded := pendingCount >= maximumPendingDeliveries || !retainPayload || retainedBytes+int64(len(intent.payload)) > maximumRetainedPayloads
	for retainedCount >= maximumRetainedDeliveries {
		result, err := tx.ExecContext(ctx, `DELETE FROM modelry_automation_deliveries WHERE ordinal IN (SELECT ordinal FROM modelry_automation_deliveries WHERE status IN ('succeeded','failed','cancelled') ORDER BY ordinal LIMIT 1)`)
		if err != nil {
			return Delivery{}, err
		}
		deleted, err := result.RowsAffected()
		if err != nil {
			return Delivery{}, err
		}
		if deleted == 0 {
			capacityExceeded = true
			break
		}
		retainedCount--
	}
	if capacityExceeded {
		status, errorCode, retainPayload = "failed", "capacityExceeded", false
	}
	if !retainPayload {
		intent.payload = nil
	}
	var eventIDValue, slotValue any
	if intent.eventID != "" {
		eventIDValue = intent.eventID
	}
	if intent.sourceSlot != "" {
		slotValue = intent.sourceSlot
	}
	var nextValue, completeValue any
	if status == "pending" {
		nextValue = stamp
	} else {
		completeValue = stamp
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_deliveries(id,source_type,source_id,webhook_id,webhook_revision,event_id,event_type,source_slot,status,created_at,next_attempt_at,completed_at,attempt_count,manual_redrive_count,error_code,payload)
		VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,0,0,?,?)`, intent.id, intent.sourceType, intent.sourceID, intent.webhookID, revision, eventIDValue, intent.eventType, slotValue, status, stamp, nextValue, completeValue, errorCode, intent.payload)
	if err != nil {
		return Delivery{}, fmt.Errorf("persist Delivery intent: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_rounds(delivery_id,round,webhook_revision,target_url,secret_id,attempts_started,created_at) VALUES(?,1,?,?,?,0,?)`, intent.id, revision, targetURL, secretID, stamp); err != nil {
		return Delivery{}, err
	}
	item := Delivery{ID: intent.id, SourceType: intent.sourceType, SourceID: intent.sourceID, WebhookID: intent.webhookID, WebhookName: webhookName, WebhookRevision: revision,
		EventID: intent.eventID, EventType: intent.eventType, Status: status, CreatedAt: now, ErrorCode: errorCode}
	if nextValue != nil {
		item.NextAttemptAt = &now
	}
	if completeValue != nil {
		item.CompletedAt = &now
	}
	return item, nil
}

func (service *Service) createJobDeliveryInTransaction(ctx context.Context, tx storage.Executor, job dueJob) error {
	id, err := newResourceID("dlv_")
	if err != nil {
		return err
	}
	scheduledAt := job.scheduled.UTC()
	payload := []byte(fmt.Sprintf(`{"deliveryId":%q,"event":{"type":"job.scheduled","jobId":%q,"scheduledAt":%q}}`, id, job.id, scheduledAt.Format(time.RFC3339Nano)))
	_, err = service.createDeliveryInTransaction(ctx, tx, deliveryIntent{
		id: id, sourceType: "job", sourceID: job.id, webhookID: job.webhookID, eventType: "job.scheduled",
		sourceSlot: scheduledAt.Format(time.RFC3339Nano), payload: payload,
	})
	return err
}

func nullableTime(value sql.NullString) *time.Time {
	if !value.Valid {
		return nil
	}
	parsed := parseTime(value.String)
	return &parsed
}
