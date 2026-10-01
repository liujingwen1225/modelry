package overview

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/drift"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/requests"
)

type fakeCollections struct {
	summaries []backendmodel.CollectionSummary
	changes   []backendmodel.ChangeEntry
	failList  error
	failChang error
}

func (fake *fakeCollections) ListCollectionSummaries(context.Context, backendmodel.ListOptions, backendmodel.CollectionSummaryOptions) (backendmodel.Page[backendmodel.CollectionSummary], error) {
	if fake.failList != nil {
		return backendmodel.Page[backendmodel.CollectionSummary]{}, fake.failList
	}
	return backendmodel.Page[backendmodel.CollectionSummary]{Data: fake.summaries}, nil
}

func (fake *fakeCollections) ListChanges(context.Context, backendmodel.ListOptions) (backendmodel.Page[backendmodel.ChangeEntry], error) {
	if fake.failChang != nil {
		return backendmodel.Page[backendmodel.ChangeEntry]{}, fake.failChang
	}
	return backendmodel.Page[backendmodel.ChangeEntry]{Data: fake.changes}, nil
}

type fakeRequests struct {
	summary requests.Summary
	err     error
}

func (fake fakeRequests) Summary(context.Context, time.Time) (requests.Summary, error) {
	return fake.summary, fake.err
}

type fakeAutomation struct {
	summary automation.Summary
	err     error
}

func (fake fakeAutomation) Summary(context.Context, time.Time) (automation.Summary, error) {
	return fake.summary, fake.err
}

type fakeExtensions struct {
	summary extensions.HookSummary
	err     error
}

func (fake fakeExtensions) Summary(context.Context, time.Time) (extensions.HookSummary, error) {
	return fake.summary, fake.err
}

type fakeDrift struct {
	report drift.Report
	err    error
}

func (fake fakeDrift) Report(context.Context, string) (drift.Report, error) {
	return fake.report, fake.err
}

func newTestService(t *testing.T, collections collectionSource, requestFacts requestSummarySource, automationFacts automationSummarySource, extensionFacts extensionSummarySource, driftFacts driftReportSource) *Service {
	t.Helper()
	service, err := NewService(collections, requestFacts, automationFacts, extensionFacts, driftFacts)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC) }
	return service
}

func TestSnapshotAggregatesSectionsAndRecentCollections(t *testing.T) {
	recordCount := int64(1204)
	updated := time.Date(2026, 10, 1, 11, 0, 0, 0, time.UTC)
	p95 := int64(34)
	collections := &fakeCollections{
		summaries: []backendmodel.CollectionSummary{
			{
				Collection: backendmodel.Collection{
					ID: "col_users", Name: "users", Type: backendmodel.CollectionTypeAuth, UpdatedAt: updated,
					Fields: []backendmodel.Field{
						{Name: "id", Type: backendmodel.FieldTypeText},
						{Name: "profile", Type: backendmodel.FieldTypeRelation, Relation: &backendmodel.Relation{TargetCollectionID: "col_profiles", Cardinality: "many-to-one"}},
					},
					Indexes: []backendmodel.Index{{Name: "idx_users_email", Fields: []string{"email"}}},
				},
				RecordCount: recordCount, PendingChangeStatus: backendmodel.ChangeReady,
			},
			{
				Collection: backendmodel.Collection{ID: "col_old", Name: "audit_events", Type: backendmodel.CollectionTypeNormal, UpdatedAt: updated.Add(-time.Hour)},
				RecordCount: 10, PendingChangeStatus: backendmodel.ChangeFailed,
			},
		},
		changes: []backendmodel.ChangeEntry{
			{PendingChange: &backendmodel.PendingChange{ChangeSetID: "chg_1", Status: backendmodel.ChangeReady}},
			{PendingChange: &backendmodel.PendingChange{ChangeSetID: "chg_2", Status: backendmodel.ChangeNeedsReview}},
			{PendingChange: &backendmodel.PendingChange{ChangeSetID: "chg_3", Status: backendmodel.ChangeFailed}},
			{AppliedMigration: &backendmodel.AppliedMigration{ID: "mig_1"}},
		},
	}
	service := newTestService(t, collections,
		fakeRequests{summary: requests.Summary{RequestCount: 18400, ClientErrorCount: 42, ServerErrorCount: 3, P95DurationMS: &p95}},
		fakeAutomation{summary: automation.Summary{EnabledWebhooks: 2, EnabledEventHooks: 1, EnabledJobs: 2, DeliveryCount: 284, FailedDeliveryCount: 2, PendingDeliveryCount: 1}},
		fakeExtensions{summary: extensions.HookSummary{Enabled: 4, RunCount: 12, FailedRunCount: 1}},
		fakeDrift{report: drift.Report{State: "drift", Findings: []drift.Finding{{Code: "columnType"}}, DetectedAt: updated}},
	)

	snapshot, err := service.Snapshot(context.Background(), Options{IncludeRecordCount: true, IncludeSchemaStatus: true})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.WindowSeconds != int(DefaultWindow.Seconds()) {
		t.Fatalf("window = %d, want %d", snapshot.WindowSeconds, int(DefaultWindow.Seconds()))
	}
	if snapshot.Collections == nil || snapshot.Collections.Count != 2 || snapshot.Collections.RecordCount == nil || *snapshot.Collections.RecordCount != 1214 {
		t.Fatalf("collections section = %+v", snapshot.Collections)
	}
	if snapshot.Collections.WithPendingChanges != 2 || snapshot.Collections.WithFailedChanges != 1 {
		t.Fatalf("collection change counts = %d/%d, want 2/1", snapshot.Collections.WithPendingChanges, snapshot.Collections.WithFailedChanges)
	}
	if len(snapshot.Collections.Recent) != 2 || snapshot.Collections.Recent[0].ID != "col_users" {
		t.Fatalf("recent collections = %+v, want the most recently updated first", snapshot.Collections.Recent)
	}
	recent := snapshot.Collections.Recent[0]
	if recent.FieldCount != 2 || recent.RelationCount != 1 || recent.IndexCount != 1 || recent.RecordCount == nil || *recent.RecordCount != 1204 {
		t.Fatalf("recent collection detail = %+v", recent)
	}
	if snapshot.Requests == nil || snapshot.Requests.RequestCount != 18400 || snapshot.Requests.P95DurationMS == nil || *snapshot.Requests.P95DurationMS != 34 {
		t.Fatalf("requests section = %+v", snapshot.Requests)
	}
	if snapshot.Events == nil || snapshot.Events.EnabledHooks != 4 || snapshot.Events.EnabledJobs != 2 || snapshot.Events.RunCount != 12 || snapshot.Events.FailedDeliveryCount != 2 {
		t.Fatalf("events section = %+v", snapshot.Events)
	}
	if snapshot.Changes == nil || snapshot.Changes.PendingCount != 3 || snapshot.Changes.NeedsReviewCount != 1 || snapshot.Changes.FailedCount != 1 {
		t.Fatalf("changes section = %+v (applied migrations must not count as pending)", snapshot.Changes)
	}
	if snapshot.Drift == nil || snapshot.Drift.DifferenceCount != 1 || snapshot.Drift.State != "drift" {
		t.Fatalf("drift section = %+v", snapshot.Drift)
	}
}

func TestSnapshotOmitsUnreadableSectionsAndTrimsWithoutPermission(t *testing.T) {
	collections := &fakeCollections{
		summaries: []backendmodel.CollectionSummary{{
			Collection: backendmodel.Collection{ID: "col_users", Name: "users", UpdatedAt: time.Now()},
			PendingChangeStatus: backendmodel.ChangeReady,
		}},
		failChang: errors.New("changes unavailable"),
	}
	service := newTestService(t, collections,
		fakeRequests{err: errors.New("requests unavailable")},
		fakeAutomation{summary: automation.Summary{EnabledJobs: 1}},
		fakeExtensions{summary: extensions.HookSummary{Enabled: 1}},
		fakeDrift{err: errors.New("drift unavailable")},
	)

	// 没有 records.read / schema.read：记录数与待应用变更状态都必须省略，而不是显示 0。
	snapshot, err := service.Snapshot(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Collections == nil || snapshot.Collections.RecordCount != nil {
		t.Fatalf("record count must be omitted without records.read: %+v", snapshot.Collections)
	}
	if len(snapshot.Collections.Recent) != 1 || snapshot.Collections.Recent[0].PendingChangeStatus != "" {
		t.Fatalf("pending change status must be omitted without schema.read: %+v", snapshot.Collections.Recent)
	}
	if snapshot.Requests != nil || snapshot.Drift != nil || snapshot.Changes != nil {
		t.Fatalf("unreadable sections must be omitted, got requests=%v drift=%v changes=%v", snapshot.Requests, snapshot.Drift, snapshot.Changes)
	}
	if snapshot.Events == nil {
		t.Fatal("readable sections must survive another section's failure")
	}
}

func TestSnapshotFailsWhenNothingCanBeRead(t *testing.T) {
	failure := errors.New("storage unavailable")
	service := newTestService(t, &fakeCollections{failList: failure, failChang: failure},
		fakeRequests{err: failure}, fakeAutomation{err: failure}, fakeExtensions{err: failure}, fakeDrift{err: failure})
	if _, err := service.Snapshot(context.Background(), Options{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Snapshot() error = %v, want ErrUnavailable so the UI can show Unavailable instead of an empty project", err)
	}
}
