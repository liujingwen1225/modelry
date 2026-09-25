package automation

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type testSecrets struct {
	metadata map[string]testSecretMetadata
	values   map[string][]byte
}

type testSecretMetadata struct {
	Name       string
	Configured bool
}

func (secrets *testSecrets) SecretMetadata(_ context.Context, id string) (string, bool, error) {
	item, ok := secrets.metadata[id]
	if !ok {
		return "", false, nil
	}
	return item.Name, item.Configured, nil
}

func (secrets *testSecrets) WithSecretValue(_ context.Context, id string, use func([]byte) error) error {
	value, ok := secrets.values[id]
	if !ok {
		return ErrSecretNotAvailable
	}
	return use(append([]byte(nil), value...))
}

func newServiceFixture(t *testing.T) (*Service, *storage.Store) {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		if _, err := tx.ExecContext(context.Background(), `CREATE TABLE modelry_secrets (id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,value_cipher BLOB NOT NULL)`); err != nil {
			return err
		}
		_, err := tx.ExecContext(context.Background(), `INSERT INTO modelry_secrets(id,name,value_cipher) VALUES('sec_test','signer',?)`, []byte("encrypted"))
		return err
	}); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	service, err := NewService(context.Background(), store, ServiceOptions{
		Secrets: &testSecrets{metadata: map[string]testSecretMetadata{"sec_test": {Name: "signer", Configured: true}}, values: map[string][]byte{"sec_test": []byte("never-return-this")}},
		Audits:  audits,
		Now:     func() time.Time { return time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := service.Close(context.Background()); err != nil {
			t.Errorf("close automation service: %v", err)
		}
		if err := store.Close(); err != nil {
			t.Errorf("close SQLite store: %v", err)
		}
	})
	return service, store
}

func TestFinishAttemptRetriesPersistenceWithoutChangingDeliveryIntent(t *testing.T) {
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
	claim, found, err := service.claimDelivery(ctx)
	if err != nil || !found || claim.id != delivery.ID {
		t.Fatalf("claimDelivery() = %+v, found=%v, err=%v", claim, found, err)
	}
	flaky := &transactionFailureStore{base: store}
	flaky.failures.Store(2)
	service.store = flaky

	service.finishAttempt(claim, attemptResult{status: "succeeded", httpStatus: 204}, time.Millisecond)

	detail, err := service.GetDelivery(ctx, delivery.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "succeeded" || len(detail.Attempts) != 1 || detail.Attempts[0].Status != "succeeded" {
		t.Fatalf("finishAttempt did not persist outcome after transient storage errors: %+v", detail)
	}
	if got := flaky.calls.Load(); got != 3 {
		t.Fatalf("finishAttempt made %d persistence attempts, want 3", got)
	}
}

func TestExhaustedFinishRetriesRecoverOutcomeWithoutReclaimingDelivery(t *testing.T) {
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
	claim, found, err := service.claimDelivery(ctx)
	if err != nil || !found || claim.id != delivery.ID {
		t.Fatalf("claimDelivery() = %+v, found=%v, err=%v", claim, found, err)
	}
	flaky := &transactionFailureStore{base: store}
	service.store = flaky
	if err := service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	claimDeadline := time.Now().Add(time.Second)
	for flaky.calls.Load() < maximumWorkers && time.Now().Before(claimDeadline) {
		time.Sleep(time.Millisecond)
	}
	if got := flaky.calls.Load(); got < maximumWorkers {
		t.Fatalf("workers made only %d claim transactions before the recovery scenario", got)
	}
	flaky.failures.Store(finishPersistenceTries)
	service.persistAttemptOutcome(ctx, claim, attemptResult{status: "succeeded", httpStatus: 204}, time.Millisecond)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detail, err := service.GetDelivery(ctx, delivery.ID)
		if err != nil {
			t.Fatal(err)
		}
		if detail.Status == "succeeded" {
			if detail.AttemptCount != 1 || len(detail.Attempts) != 1 || detail.Attempts[0].Status != "succeeded" {
				t.Fatalf("outcome recovery changed the Delivery attempt count or history: %+v", detail)
			}
			if got := flaky.calls.Load(); got <= maximumWorkers+finishPersistenceTries {
				t.Fatalf("outcome recovery made %d writes, want a later persistence attempt", got)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("exhausted outcome writes were not recovered while the Runtime remained active")
}

func TestWebhookMutationRollsBackWhenAuditWriteFails(t *testing.T) {
	service, _ := newServiceFixture(t)
	service.audits = rejectedAuditWriter{}
	ctx := audit.WithActor(context.Background(), audit.Actor{Kind: audit.ActorOwner, ID: "own_test"})
	if _, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"}); err == nil {
		t.Fatal("CreateWebhook succeeded when the required AuditRecord could not be written")
	}
	items, err := service.ListWebhooks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("Webhook mutation committed without its AuditRecord: %+v", items)
	}
}

func TestAutomationConfigurationAndDeliveryActionsAppendSafeAuditRecords(t *testing.T) {
	ctx := audit.WithActor(context.Background(), audit.Actor{Kind: audit.ActorOwner, ID: "own_test"})
	service, store := newServiceFixture(t)
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "posts", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReplaceWebhook(ctx, webhook.ID, WebhookInput{Name: "updated", TargetURL: "https://hooks.example.test/updated", SigningSecretID: "sec_test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}

	hook, err := service.CreateEventHook(ctx, EventHookInput{Name: "created posts", CollectionID: collection.ID, EventType: "record.created", WebhookID: webhook.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReplaceEventHook(ctx, hook.ID, EventHookInput{Name: "updated posts", CollectionID: collection.ID, EventType: "record.updated", WebhookID: webhook.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableEventHook(ctx, hook.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.DisableEventHook(ctx, hook.ID); err != nil {
		t.Fatal(err)
	}

	job, err := service.CreateJob(ctx, JobInput{Name: "every minute", WebhookID: webhook.ID, Cron: "* * * * *"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReplaceJob(ctx, job.ID, JobInput{Name: "every two minutes", WebhookID: webhook.ID, Cron: "*/2 * * * *"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableJob(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.DisableJob(ctx, job.ID); err != nil {
		t.Fatal(err)
	}

	delivery, err := service.CreateTestDelivery(ctx, webhook.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='failed',completed_at=?,error_code='externalRequestFailed' WHERE id=?`, service.now().UTC().Format(time.RFC3339Nano), delivery.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RetryDelivery(ctx, delivery.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.DisableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}

	audits, err := audit.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	page, err := audits.List(context.Background(), audit.ListOptions{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{
		"webhook.created": 1, "webhook.updated": 1, "webhook.enabled": 1, "webhook.disabled": 1,
		"eventHook.created": 1, "eventHook.updated": 1, "eventHook.enabled": 1, "eventHook.disabled": 1,
		"job.created": 1, "job.updated": 1, "job.enabled": 1, "job.disabled": 1,
		"delivery.testRequested": 1, "delivery.redriven": 1,
	}
	for _, record := range page.Data {
		want[record.Action]--
		if record.Actor != (audit.Actor{Kind: audit.ActorOwner, ID: "own_test"}) || record.Result != "success" {
			t.Errorf("Automation AuditRecord actor/result = %+v/%q", record.Actor, record.Result)
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "hooks.example.test") || strings.Contains(string(encoded), "never-return-this") {
			t.Errorf("Automation AuditRecord exposed target URL or Secret: %s", encoded)
		}
	}
	for action, remaining := range want {
		if remaining != 0 {
			t.Errorf("AuditRecord count for %q = %d, want 1", action, 1-remaining)
		}
	}
}

type rejectedAuditWriter struct{}

func (rejectedAuditWriter) AppendInTransaction(context.Context, storage.Executor, audit.AppendInput) error {
	return errors.New("injected Audit storage failure")
}

type transactionFailureStore struct {
	base     transactionalStore
	failures atomic.Int32
	calls    atomic.Int32
}

func (store *transactionFailureStore) WithTransaction(ctx context.Context, work func(storage.Executor) error) error {
	store.calls.Add(1)
	for {
		remaining := store.failures.Load()
		if remaining <= 0 {
			return store.base.WithTransaction(ctx, work)
		}
		if store.failures.CompareAndSwap(remaining, remaining-1) {
			return errors.New("injected temporary SQLite write failure")
		}
	}
}

func (store *transactionFailureStore) WithReadSnapshot(ctx context.Context, work func(storage.Executor) error) error {
	return store.base.WithReadSnapshot(ctx, work)
}

func TestCreateWebhookReturnsSafeDisabledMetadata(t *testing.T) {
	service, _ := newServiceFixture(t)
	webhook, err := service.CreateWebhook(context.Background(), WebhookInput{
		Name:            "primary",
		TargetURL:       "https://hooks.example.test/v1/events",
		SigningSecretID: "sec_test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if webhook.ID == "" || webhook.Name != "primary" || webhook.SigningSecretName != "signer" || !webhook.SigningConfigured {
		t.Fatalf("unexpected safe Webhook metadata: %+v", webhook)
	}
	if webhook.Enabled || webhook.Revision != 1 || webhook.TargetURL != "https://hooks.example.test/v1/events" {
		t.Fatalf("new Webhook must be disabled at revision one: %+v", webhook)
	}
	if strings.Contains(strings.ToLower(webhookJSON(t, webhook)), "never-return-this") {
		t.Fatal("Webhook metadata exposed its signing Secret value")
	}
	stored, err := service.GetWebhook(context.Background(), webhook.ID)
	if err != nil || stored.ID != webhook.ID || stored.Enabled {
		t.Fatalf("persisted Webhook was not returned safely: item=%+v err=%v", stored, err)
	}
}

func TestCreateWebhookRejectsUnsafeTargetURL(t *testing.T) {
	service, _ := newServiceFixture(t)
	for _, target := range []string{
		"http://hooks.example.test/events",
		"https://127.0.0.1/events",
		"https://hooks.example.test/events?token=secret",
		"https://user:password@hooks.example.test/events",
		"https://hooks.example.test/events#fragment",
	} {
		t.Run(target, func(t *testing.T) {
			_, err := service.CreateWebhook(context.Background(), WebhookInput{
				Name: "primary", TargetURL: target, SigningSecretID: "sec_test",
			})
			var validation *ValidationError
			if err == nil || !errors.As(err, &validation) || !hasViolation(validation, "invalidWebhookUrl") {
				t.Fatalf("unsafe URL %q returned err=%v, want invalidWebhookUrl validation", target, err)
			}
		})
	}
}

func TestWebhookConfigReplacementAdvancesRevisionAndEnableChecksSecret(t *testing.T) {
	service, _ := newServiceFixture(t)
	created, err := service.CreateWebhook(context.Background(), WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/v1", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReplaceWebhook(context.Background(), created.ID, WebhookInput{Name: "updated", TargetURL: "https://hooks.example.test/v2", SigningSecretID: "missing"}); !hasViolationForCode(err, "invalidSecretReference") {
		t.Fatalf("replace with unavailable Secret error = %v", err)
	}
	enabled, err := service.EnableWebhook(context.Background(), created.ID)
	if err != nil || enabled.ID != created.ID || !enabled.Enabled {
		t.Fatalf("EnableWebhook() = %+v, %v", enabled, err)
	}
	replaced, err := service.ReplaceWebhook(context.Background(), created.ID, WebhookInput{Name: "updated", TargetURL: "https://hooks.example.test/v2", SigningSecretID: "sec_test"})
	if err != nil || replaced.Revision != 2 || !replaced.Enabled || replaced.TargetURL != "https://hooks.example.test/v2" {
		t.Fatalf("ReplaceWebhook() = %+v, %v", replaced, err)
	}
	disabled, err := service.DisableWebhook(context.Background(), created.ID)
	if err != nil || disabled.Enabled || disabled.ID != created.ID {
		t.Fatalf("DisableWebhook() = %+v, %v", disabled, err)
	}
}

func TestWebhookCreateAndReplaceValidateSecretInWriteTransaction(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM modelry_secrets WHERE id='sec_test'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	input := WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"}
	if _, err := service.CreateWebhook(ctx, input); !hasViolationForCode(err, "invalidSecretReference") {
		t.Fatalf("CreateWebhook with missing durable Secret error = %v, want invalidSecretReference", err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_secrets(id,name,value_cipher) VALUES('sec_test','signer',?)`, []byte("encrypted"))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	webhook, err := service.CreateWebhook(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM modelry_secrets WHERE id='sec_test'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	input.TargetURL = "https://hooks.example.test/changed"
	if _, err := service.ReplaceWebhook(ctx, webhook.ID, input); !hasViolationForCode(err, "invalidSecretReference") {
		t.Fatalf("ReplaceWebhook with revoked durable Secret error = %v, want invalidSecretReference", err)
	}
	stored, err := service.GetWebhook(ctx, webhook.ID)
	if err != nil || stored.Revision != webhook.Revision || stored.TargetURL != webhook.TargetURL {
		t.Fatalf("failed replacement changed Webhook: %+v, err=%v", stored, err)
	}
}

func TestProjectWebhookLimitIsThirtyTwo(t *testing.T) {
	service, _ := newServiceFixture(t)
	for index := 0; index < 32; index++ {
		_, err := service.CreateWebhook(context.Background(), WebhookInput{
			Name: "endpoint " + strconv.Itoa(index), TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test",
		})
		if err != nil {
			t.Fatalf("CreateWebhook #%d failed before the 32 endpoint limit: %v", index+1, err)
		}
	}
	_, err := service.CreateWebhook(context.Background(), WebhookInput{
		Name: "endpoint 33", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test",
	})
	if !hasViolationForCode(err, "tooManyWebhooks") {
		t.Fatalf("CreateWebhook #33 error = %v, want tooManyWebhooks", err)
	}
}

func TestDisablingWebhookPreservesActiveTestButSecretRevocationCancelsIt(t *testing.T) {
	ctx := context.Background()
	service, _ := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	testCtx, cancelTest := context.WithCancel(ctx)
	defer cancelTest()
	eventCtx, cancelEvent := context.WithCancel(ctx)
	defer cancelEvent()
	service.registerActive("dlv_test", webhook.ID, "test", cancelTest)
	service.registerActive("dlv_event", webhook.ID, "eventHook", cancelEvent)
	if _, err := service.DisableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-eventCtx.Done():
	default:
		t.Fatal("Webhook disable did not cancel an active Record Delivery")
	}
	select {
	case <-testCtx.Done():
		t.Fatal("Webhook disable cancelled an explicit synthetic test Delivery")
	default:
	}
	service.SecretRevoked("sec_test")
	select {
	case <-testCtx.Done():
	default:
		t.Fatal("Secret revocation did not cancel an active synthetic test Delivery")
	}
}

func TestSyntheticTestAndDeliveryDetailsKeepPayloadPrivate(t *testing.T) {
	ctx := context.Background()
	service, _ := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/private/path", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	delivery, err := service.CreateTestDelivery(ctx, webhook.ID)
	if err != nil {
		t.Fatal(err)
	}
	if delivery.Status != "pending" || delivery.EventType != "webhook.test" || delivery.SourceType != "test" || delivery.WebhookRevision != webhook.Revision {
		t.Fatalf("synthetic test Delivery metadata = %+v", delivery)
	}
	detail, err := service.GetDelivery(ctx, delivery.ID)
	if err != nil || detail.ID != delivery.ID || len(detail.Attempts) != 0 {
		t.Fatalf("GetDelivery() = %+v, %v", detail, err)
	}
	encoded := deliveryJSON(t, detail)
	if strings.Contains(encoded, webhook.TargetURL) || strings.Contains(encoded, "never-return-this") || strings.Contains(strings.ToLower(encoded), "payload") {
		t.Fatalf("Delivery DTO exposed URL, Secret, or payload: %s", encoded)
	}
	var storedType string
	if err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT event_type FROM modelry_automation_deliveries WHERE id=?`, delivery.ID).Scan(&storedType)
	}); err != nil || storedType != "webhook.test" {
		t.Fatalf("persisted test Delivery event type=%q err=%v", storedType, err)
	}
}

func TestSyntheticTestRequiresExistingWebhookAndConfiguredSecretInOneTransaction(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	if _, err := service.CreateTestDelivery(ctx, "missing_webhook"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("test delivery for missing Webhook error = %v, want ErrNotFound", err)
	}
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM modelry_secrets WHERE id='sec_test'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateTestDelivery(ctx, webhook.ID); !hasViolationForCode(err, "invalidSecretReference") {
		t.Fatalf("test delivery with revoked Secret error = %v, want invalidSecretReference", err)
	}
	var count int
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_deliveries WHERE webhook_id=?`, webhook.ID).Scan(&count)
	}); err != nil || count != 0 {
		t.Fatalf("failed test delivery persisted %d rows, err=%v", count, err)
	}
}

func TestDeliveryCursorUsesStableCreationOrdinalAcrossTimestampPrecision(t *testing.T) {
	ctx := context.Background()
	service, _ := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	times := []time.Time{
		time.Date(2026, 9, 25, 12, 0, 0, 100_000_000, time.UTC),
		time.Date(2026, 9, 25, 12, 0, 0, 100_000_001, time.UTC),
	}
	for index := range times {
		service.now = func() time.Time { return times[index] }
		if _, err := service.CreateTestDelivery(ctx, webhook.ID); err != nil {
			t.Fatal(err)
		}
	}
	service.now = func() time.Time { return times[1] }
	page, err := service.ListDeliveries(ctx, DeliveryListOptions{Limit: 1})
	if err != nil || len(page.Data) != 1 || page.Data[0].CreatedAt != times[1] || page.NextCursor == "" {
		t.Fatalf("first cursor page = %+v, %v; want newest ordinal at %v", page, err, times[1])
	}
	second, err := service.ListDeliveries(ctx, DeliveryListOptions{Limit: 1, Cursor: page.NextCursor})
	if err != nil || len(second.Data) != 1 || !second.Data[0].CreatedAt.Equal(times[0]) || second.NextCursor != "" {
		t.Fatalf("second cursor page = %+v, %v; want prior ordinal at %v", second, err, times[0])
	}
}

func TestDeliveryAttemptNumbersRestartAtOneForEachRetryRound(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	delivery, err := service.CreateTestDelivery(ctx, webhook.ID)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_attempts(delivery_id,attempt,round,webhook_revision,status,started_at,completed_at,duration_ms,error_code) VALUES(?,1,1,1,'failed',?,?,4,'externalRequestFailed')`, delivery.ID, started, started); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_rounds(delivery_id,round,webhook_revision,target_url,secret_id,attempts_started,created_at) VALUES(?,2,1,'https://hooks.example.test/events','sec_test',1,?)`, delivery.ID, started); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_attempts(delivery_id,attempt,round,webhook_revision,status,started_at,completed_at,duration_ms,error_code) VALUES(?,9,2,1,'succeeded',?,?,4,'none')`, delivery.ID, started, started)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	detail, err := service.GetDelivery(ctx, delivery.ID)
	if err != nil || len(detail.Attempts) != 2 {
		t.Fatalf("GetDelivery() = %+v, %v", detail, err)
	}
	if detail.Attempts[0].Round != 1 || detail.Attempts[0].Attempt != 1 || detail.Attempts[1].Round != 2 || detail.Attempts[1].Attempt != 1 {
		t.Fatalf("attempt numbers must be one-based within each round: %+v", detail.Attempts)
	}
}

func TestEventHookCreationStartsDisabledAndRejectsDuplicateTrigger(t *testing.T) {
	service, store := newServiceFixture(t)
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(context.Background(), backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	webhook, err := service.CreateWebhook(context.Background(), WebhookInput{Name: "primary", TargetURL: "https://hooks.example.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	input := EventHookInput{Name: "new posts", CollectionID: collection.ID, EventType: "record.created", WebhookID: webhook.ID}
	hook, err := service.CreateEventHook(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if hook.Enabled || hook.CollectionName != "posts" || hook.WebhookName != "primary" || hook.EventType != input.EventType {
		t.Fatalf("new Event Hook metadata = %+v", hook)
	}
	if _, err := service.CreateEventHook(context.Background(), input); !hasViolationForCode(err, "duplicateEventHook") {
		t.Fatalf("duplicate Event Hook error = %v, want duplicateEventHook", err)
	}
	enabled, err := service.EnableEventHook(context.Background(), hook.ID)
	if err != nil || enabled.ID != hook.ID || !enabled.Enabled {
		t.Fatalf("EnableEventHook() = %+v, %v", enabled, err)
	}
	input.Name = "edited"
	replaced, err := service.ReplaceEventHook(context.Background(), hook.ID, input)
	if err != nil || !replaced.Enabled || replaced.Name != "edited" {
		t.Fatalf("ReplaceEventHook() = %+v, %v", replaced, err)
	}
	disabled, err := service.DisableEventHook(context.Background(), hook.ID)
	if err != nil || disabled.Enabled {
		t.Fatalf("DisableEventHook() = %+v, %v", disabled, err)
	}
}

func TestJobScheduleIsDurableUTCAndDisabledJobsRetainDueSlot(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	now := time.Date(2026, 9, 25, 12, 0, 5, 0, time.UTC)
	service.now = func() time.Time { return now }
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "scheduler", TargetURL: "https://hooks.example.test/jobs", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	job, err := service.CreateJob(ctx, JobInput{Name: "minute task", WebhookID: webhook.ID, Cron: "* * * * *"})
	if err != nil {
		t.Fatal(err)
	}
	wantFirst := time.Date(2026, 9, 25, 12, 1, 0, 0, time.UTC)
	if job.Enabled || !job.NextRunAt.Equal(wantFirst) {
		t.Fatalf("new Job = %+v, want disabled next run %s", job, wantFirst)
	}
	if _, err := service.CreateJob(ctx, JobInput{Name: "invalid", WebhookID: webhook.ID, Cron: "*/5 * * * * *"}); !hasViolationForCode(err, "invalidCron") {
		t.Fatalf("seconds Cron error = %v, want invalidCron", err)
	}
	if _, err := service.CreateJob(ctx, JobInput{Name: "unreachable", WebhookID: webhook.ID, Cron: "0 0 31 FEB *"}); !hasViolationForCode(err, "invalidCron") {
		t.Fatalf("unreachable Cron error = %v, want invalidCron", err)
	}
	if _, err := service.EnableJob(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.DisableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 9, 25, 12, 3, 0, 0, time.UTC)
	if err := service.scheduleDueJobs(ctx, now); err != nil {
		t.Fatal(err)
	}
	consumed, err := service.GetJob(ctx, job.ID)
	if err != nil || !consumed.NextRunAt.After(now) {
		t.Fatalf("enabled Job did not consume disabled-Webhook due slot: job=%+v err=%v", consumed, err)
	}
	var deliveries int
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_deliveries WHERE source_type='job'`).Scan(&deliveries)
	}); err != nil || deliveries != 0 {
		t.Fatalf("disabled Webhook generated a Job Delivery: count=%d err=%v", deliveries, err)
	}
	if _, err := service.DisableJob(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	retained, err := service.GetJob(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	now = retained.NextRunAt.Add(5 * time.Minute)
	if err := service.scheduleDueJobs(ctx, now); err != nil {
		t.Fatal(err)
	}
	stillRetained, err := service.GetJob(ctx, job.ID)
	if err != nil || !stillRetained.NextRunAt.Equal(retained.NextRunAt) {
		t.Fatalf("disabled Job due slot changed: before=%s after=%s err=%v", retained.NextRunAt, stillRetained.NextRunAt, err)
	}
	if _, err := service.EnableJob(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.scheduleDueJobs(ctx, now); err != nil {
		t.Fatal(err)
	}
	reenabled, err := service.GetJob(ctx, job.ID)
	if err != nil || !reenabled.NextRunAt.After(now) {
		t.Fatalf("reenabled Job did not consume due slot: job=%+v err=%v", reenabled, err)
	}
}

func webhookJSON(t *testing.T, value Webhook) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func deliveryJSON(t *testing.T, value Delivery) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func hasViolation(validation *ValidationError, code string) bool {
	if validation == nil {
		return false
	}
	for _, violation := range validation.Violations {
		if violation.Code == code {
			return true
		}
	}
	return false
}

func hasViolationForCode(err error, code string) bool {
	var validation *ValidationError
	if !errors.As(err, &validation) {
		return false
	}
	return hasViolation(validation, code)
}
