package requests

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// TestRetentionPruneDeletesOnlyOlderRequestRecords 证明保留期清理只删除超期 RequestRecord。
func TestRetentionPruneDeletesOnlyOlderRequestRecords(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return base }
	records := []RequestRecord{
		{RequestID: "req_old000000000001", Time: base.AddDate(0, 0, -40), CollectionID: "col_a", Endpoint: "/api/v1/x", Method: "GET", Status: 200, AuthenticationOutcome: AuthenticationAnonymous, AuthorizationOutcome: AuthorizationAllowed},
		{RequestID: "req_old000000000002", Time: base.AddDate(0, 0, -20), CollectionID: "col_a", Endpoint: "/api/v1/x", Method: "GET", Status: 200, AuthenticationOutcome: AuthenticationAnonymous, AuthorizationOutcome: AuthorizationAllowed},
		{RequestID: "req_new000000000003", Time: base.Add(-time.Hour), CollectionID: "col_a", Endpoint: "/api/v1/x", Method: "GET", Status: 200, AuthenticationOutcome: AuthenticationAnonymous, AuthorizationOutcome: AuthorizationAllowed},
	}
	for _, record := range records {
		if err := service.Append(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := service.PruneOlderThan(ctx, base.AddDate(0, 0, -30), MaximumRequestRecordsPerPrune)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	page, err := service.List(ctx, ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 2 {
		t.Fatalf("retained records = %d, want 2", len(page.Data))
	}
	for _, record := range page.Data {
		if record.RequestID == "req_old000000000001" {
			t.Fatalf("expired RequestRecord survived retention: %+v", record)
		}
	}
	if _, err := service.PruneOlderThan(ctx, time.Time{}, 10); err == nil {
		t.Fatal("prune without a cutoff must fail")
	}
}