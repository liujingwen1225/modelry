package automation

import (
	"context"
	"errors"
	"testing"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestRunJobOnceCreatesManualDeliveryWithoutChangingSchedule(t *testing.T) {
	// Audit 事实只在存在 actor 的请求上下文里写入（appendAudit fail-closed），
	// 因此这里显式带上 Owner actor，与真实 Admin 请求路径一致。
	ctx := audit.WithActor(context.Background(), audit.Actor{Kind: audit.ActorOwner, ID: "adm_fixtureowner"})
	service, store := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "scheduler", TargetURL: "https://hooks.example.test/jobs", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	job, err := service.CreateJob(ctx, JobInput{Name: "cleanup", WebhookID: webhook.ID, Cron: "0 3 * * *"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableJob(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	before, err := service.GetJob(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}

	delivery, err := service.RunJobOnce(ctx, job.ID)
	if err != nil {
		t.Fatalf("RunJobOnce() error = %v", err)
	}
	if delivery.ID == "" || delivery.SourceType != "job" || delivery.SourceID != job.ID || delivery.EventType != "job.manual" {
		t.Fatalf("manual run delivery = %+v, want a job.manual Delivery for the Job", delivery)
	}
	if delivery.Status != "pending" || delivery.ErrorCode != "none" {
		t.Fatalf("manual run delivery status = %q/%q, want pending/none", delivery.Status, delivery.ErrorCode)
	}

	after, err := service.GetJob(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.NextRunAt.Equal(before.NextRunAt) {
		t.Fatalf("manual run moved nextRunAt from %v to %v", before.NextRunAt, after.NextRunAt)
	}
	if (before.LastRunAt == nil) != (after.LastRunAt == nil) {
		t.Fatalf("manual run changed lastRunAt from %v to %v", before.LastRunAt, after.LastRunAt)
	}

	page, err := service.ListDeliveries(ctx, DeliveryListOptions{SourceType: "job", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].ID != delivery.ID {
		t.Fatalf("Job Delivery history = %+v, want exactly the manual run", page.Data)
	}

	audits, err := audit.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	auditPage, err := audits.List(ctx, audit.ListOptions{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range auditPage.Data {
		if record.Action == "job.runRequested" {
			found = true
		}
	}
	if !found {
		t.Fatal("manual Job run was not audited as job.runRequested")
	}
}

func TestRunJobOnceRequiresEnabledWebhookAndConfiguredSecret(t *testing.T) {
	ctx := context.Background()
	service, store := newServiceFixture(t)
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "scheduler", TargetURL: "https://hooks.example.test/jobs", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	job, err := service.CreateJob(ctx, JobInput{Name: "cleanup", WebhookID: webhook.ID, Cron: "0 3 * * *"})
	if err != nil {
		t.Fatal(err)
	}

	// Webhook 仍处于停用状态：手动运行必须给出字段级校验错误，而不是静默排队。
	if _, err := service.RunJobOnce(ctx, job.ID); err == nil {
		t.Fatal("manual run against a disabled Webhook must fail")
	} else {
		var validation *ValidationError
		if !errors.As(err, &validation) || len(validation.Violations) == 0 || validation.Violations[0].Path != "/webhookId" {
			t.Fatalf("disabled Webhook error = %v, want a /webhookId validation violation", err)
		}
	}

	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM modelry_secrets WHERE id='sec_test'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobOnce(ctx, job.ID); err == nil {
		t.Fatal("manual run without a configured signing Secret must fail")
	} else {
		var validation *ValidationError
		if !errors.As(err, &validation) || validation.Violations[0].Path != "/signingSecretId" {
			t.Fatalf("unconfigured Secret error = %v, want a /signingSecretId validation violation", err)
		}
	}

	if _, err := service.RunJobOnce(ctx, "job_missing000000"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("manual run for a missing Job = %v, want ErrNotFound", err)
	}
}
