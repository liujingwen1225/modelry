package drift

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type recordedDrift struct {
	Action, ResourceID, Result string
}

type driftSink struct{ facts []recordedDrift }

func (sink *driftSink) AppendDriftFactInTransaction(_ context.Context, _ storage.Executor, action, resourceID, result string) error {
	sink.facts = append(sink.facts, recordedDrift{Action: action, ResourceID: resourceID, Result: result})
	return nil
}

func newDriftFixture(t *testing.T) (*storage.Store, *backendmodel.Service, *Service, *driftSink) {
	t.Helper()
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	sink := &driftSink{}
	service, err := NewService(store, models, sink)
	if err != nil {
		t.Fatal(err)
	}
	return store, models, service, sink
}

// TestDriftSeparatesPendingChangeFromRealInconsistencyAndRepairsTheProjection 验证 Drift 产品的核心不变量：
// Pending Change 不是 Drift；投影缺失是真 Drift 且可被 Reconcile 修复；Reconcile 写入 Audit fact。
func TestDriftSeparatesPendingChangeFromRealInconsistencyAndRepairsTheProjection(t *testing.T) {
	ctx := context.Background()
	store, models, service, sink := newDriftFixture(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}

	healthy, err := service.Report(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if healthy.State != "healthy" || len(healthy.Findings) != 0 {
		t.Fatalf("healthy report = %+v", healthy)
	}

	// 保存但未 Apply 的变更必须呈现为 expected pending change，而不是 Drift。
	if _, err := models.SaveOperation(ctx, collection.ID, backendmodel.PendingOperationInput{
		Kind: backendmodel.OperationField, Action: backendmodel.OperationAdd,
		Definition: json.RawMessage(`{"name":"summary","type":"text"}`),
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := service.Report(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if pending.State == "degraded" {
		t.Fatalf("a pending change must not degrade the runtime: %+v", pending)
	}
	expected := 0
	for _, finding := range pending.Findings {
		if finding.ExpectedPendingChange {
			expected++
			if finding.Class != ClassAppliedModel || finding.Severity != SeverityInfo {
				t.Fatalf("pending change finding = %+v", finding)
			}
		}
	}
	if expected != 1 {
		t.Fatalf("expected pending change findings = %d in %+v", expected, pending.Findings)
	}

	// 人为删除物理投影：必须出现 physicalProjection error，并能被 Reconcile 修复。
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DROP TABLE "`+storage.RecordTableName(collection.ID)+`"`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	broken, err := service.Report(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if broken.State != "degraded" {
		t.Fatalf("broken report = %+v", broken)
	}
	var finding Finding
	found := false
	for _, candidate := range broken.Findings {
		if candidate.Class == ClassPhysicalProjection {
			finding, found = candidate, true
		}
	}
	if !found {
		t.Fatalf("broken report has no physical projection finding: %+v", broken.Findings)
	}
	if finding.Code != "physicalProjection.tableMissing" || finding.Remedy != RemedyReconcile || finding.DeepLink == "" {
		t.Fatalf("table missing finding = %+v", finding)
	}
	if err := service.Reconcile(ctx, collection.ID); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(sink.facts) != 1 || sink.facts[0].Action != "drift.reconciled" || sink.facts[0].ResourceID != collection.ID {
		t.Fatalf("reconcile audit facts = %+v", sink.facts)
	}
	repaired, err := service.Report(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, remaining := range repaired.Findings {
		if remaining.Class == ClassPhysicalProjection {
			t.Fatalf("projection still differs after reconcile: %+v", remaining)
		}
	}

	if err := service.Reconcile(ctx, "col_00000000000000000000000000000000"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown collection reconcile error = %v, want ErrNotFound", err)
	}
	if err := service.Reconcile(ctx, ""); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("empty collection reconcile error = %v, want ErrInvalidArgument", err)
	}
}