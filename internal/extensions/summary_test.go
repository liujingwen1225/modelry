package extensions

import (
	"context"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestHookSummaryCountsEnabledExtensionsAndWindowRuns(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, nil)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Profiles", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	created, err := fixture.service.Create(ctx, ConfigInput{
		Name: "Normalize", Language: LanguageJavaScript,
		Source: "export function beforeCreate(){return {action:'allow'};}",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Replace(ctx, created.ID, ConfigInput{
		Name: "Normalize", Language: LanguageJavaScript,
		Source:   "export function beforeCreate(){return {action:'allow'};}",
		Bindings: []Binding{{CollectionID: collection.ID, Operation: "create", Phase: "before"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Enable(ctx, created.ID); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	// 两条窗口内运行（一条成功、一条失败）+ 一条窗口外运行。
	insertRun := func(id, startedAt, status string) {
		t.Helper()
		if err := fixture.store.WithTransaction(ctx, func(tx storage.Executor) error {
			_, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_runs(id,extension_id,revision,binding_id,collection_id,record_id,event_id,operation,phase,status,started_at,duration_ms,error_code,correlation_id)
				VALUES(?,?,1,'bnd_fixture',?,'','','create','before',?,?,1,'none','corr_fixture')`, id, created.ID, collection.ID, status, startedAt)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	insertRun("run_recent1", now.Add(-2*time.Hour).Format(time.RFC3339Nano), "succeeded")
	insertRun("run_recent2", now.Add(-90*time.Minute).Format(time.RFC3339Nano), "failed")
	insertRun("run_old1", now.Add(-72*time.Hour).Format(time.RFC3339Nano), "failed")

	summary, err := fixture.service.Summary(ctx, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Enabled != 1 {
		t.Fatalf("enabled Hook count = %d, want 1", summary.Enabled)
	}
	if summary.RunCount != 2 || summary.FailedRunCount != 1 {
		t.Fatalf("window runs = %d (failed %d), want 2 (failed 1); the 72h-old run must be excluded", summary.RunCount, summary.FailedRunCount)
	}
}
