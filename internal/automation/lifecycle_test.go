package automation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestRecordEventDeliveryIntentIsAtomicAndContainsOnlyApplicableSnapshots(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	hook, err := service.CreateEventHook(ctx, EventHookInput{Name: "on update", CollectionID: collection.ID, EventType: "record.updated", WebhookID: webhook.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableEventHook(ctx, hook.ID); err != nil {
		t.Fatal(err)
	}
	event := recordevents.Event{ID: "evt_posts_00000000000000000001", CollectionID: collection.ID, RecordID: "rec_1", Type: recordevents.Updated,
		OccurredAt: time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC), SchemaVersion: 3,
		Before: map[string]any{"title": "Before"}, After: map[string]any{"title": "After"}}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error { return service.AppendIntent(ctx, tx, event) }); err != nil {
		t.Fatal(err)
	}
	var deliveryID, status string
	var payload []byte
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT id,status,payload FROM modelry_automation_deliveries WHERE source_type='eventHook' AND source_id=?`, hook.ID).Scan(&deliveryID, &status, &payload)
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(deliveryID, "dlv_") || status != "pending" {
		t.Fatalf("atomic Event Hook intent = id %q status %q", deliveryID, status)
	}
	var envelope map[string]any
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["deliveryId"] != deliveryID {
		t.Fatalf("payload deliveryId %v does not match %q", envelope["deliveryId"], deliveryID)
	}
	body, ok := envelope["event"].(map[string]any)
	if !ok || body["before"] == nil || body["after"] == nil || body["id"] != event.ID || body["type"] != "record.updated" {
		t.Fatalf("Update envelope lost committed Event fields: %#v", envelope)
	}
	if strings.Contains(string(payload), "never-return-this") || strings.Contains(string(payload), webhook.TargetURL) {
		t.Fatal("Delivery payload contains a Secret value or target URL")
	}

	rolledBack := event
	rolledBack.ID = "evt_posts_00000000000000000002"
	rollback := errors.New("rollback test")
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := service.AppendIntent(ctx, tx, rolledBack); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatalf("transaction rollback result = %v", err)
	}
	var count int
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_deliveries WHERE event_id=?`, rolledBack.ID).Scan(&count)
	}); err != nil || count != 0 {
		t.Fatalf("rolled-back Record Event left %d deliveries, err=%v", count, err)
	}
}

func TestAfterCommitOnlySignalsBoundedDispatcher(t *testing.T) {
	service, _ := newServiceFixture(t)
	event := recordevents.Event{ID: "evt_collection_00000000000000000001", CollectionID: "col_1"}
	service.AfterCommit(context.Background(), event)
	select {
	case <-service.wake:
	default:
		t.Fatal("AfterCommit did not non-blockingly signal the dispatcher")
	}
}

func TestRestartMarksRunningAttemptInterruptedAndQueuesSameDelivery(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	delivery, err := service.CreateTestDelivery(ctx, webhook.ID)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, 9, 25, 11, 59, 58, 0, time.UTC).Format(time.RFC3339Nano)
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='running',attempt_count=1,next_attempt_at=NULL WHERE id=?`, delivery.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_delivery_rounds SET attempts_started=1 WHERE delivery_id=? AND round=1`, delivery.ID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_attempts(delivery_id,attempt,round,webhook_revision,status,started_at,completed_at,duration_ms,error_code) VALUES(?,1,1,1,'running',?,NULL,0,'none')`, delivery.ID, started)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.Close(ctx); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(ctx, store, ServiceOptions{Secrets: service.secrets, Now: service.now})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Close(context.Background()) })
	detail, err := restarted.GetDelivery(ctx, delivery.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "pending" || detail.ErrorCode != "attemptInterrupted" || detail.AttemptCount != 1 || detail.NextAttemptAt == nil {
		t.Fatalf("restart recovery Delivery = %+v; want same pending Delivery with attemptInterrupted", detail)
	}
	if len(detail.Attempts) != 1 || detail.Attempts[0].Status != "interrupted" || detail.Attempts[0].ErrorCode != "attemptInterrupted" || detail.Attempts[0].CompletedAt == nil {
		t.Fatalf("restart recovery Attempt = %+v; want durable interrupted record", detail.Attempts)
	}
}
