package requests

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestSummaryAggregatesWindowCountsPercentileAndCoverage(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	// 20 条窗口内记录：19 条 1–19ms 加 1 条 500ms 离群值（P95 必须忽略它），
	// 其中 403/500/404 各一条；另有 1 条窗口外记录。
	durations := make([]int64, 0, 20)
	statuses := make([]int, 0, 20)
	for index := 1; index <= 19; index++ {
		durations = append(durations, int64(index))
		status := 200
		switch index {
		case 4:
			status = 403
		case 6:
			status = 500
		case 11:
			status = 404
		}
		statuses = append(statuses, status)
	}
	durations = append(durations, 500)
	statuses = append(statuses, 200)
	for index := range durations {
		entry := RequestRecord{
			RequestID:  "req_summary" + string(rune('a'+index)),
			Time:       now.Add(-time.Duration(index+1) * time.Minute),
			Endpoint:   "/api/v1/posts",
			Method:     "GET",
			Status:     statuses[index],
			DurationMS: durations[index],
			AuthenticationOutcome: AuthenticationAnonymous,
			AuthorizationOutcome:  AuthorizationAllowed,
		}
		if err := service.Append(ctx, entry); err != nil {
			t.Fatalf("append %s: %v", entry.RequestID, err)
		}
	}
	stale := RequestRecord{
		RequestID: "req_summarystale", Time: now.Add(-72 * time.Hour), Endpoint: "/api/v1/posts", Method: "GET", Status: 500,
		DurationMS: 9999, AuthenticationOutcome: AuthenticationAnonymous, AuthorizationOutcome: AuthorizationAllowed,
	}
	if err := service.Append(ctx, stale); err != nil {
		t.Fatal(err)
	}

	summary, err := service.Summary(ctx, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.RequestCount != 20 {
		t.Fatalf("window request count = %d, want 20 (the 72h-old record must be excluded)", summary.RequestCount)
	}
	if summary.ClientErrorCount != 2 || summary.ServerErrorCount != 1 {
		t.Fatalf("4xx/5xx = %d/%d, want 2/1", summary.ClientErrorCount, summary.ServerErrorCount)
	}
	if summary.P95DurationMS == nil || *summary.P95DurationMS != 19 {
		t.Fatalf("p95 = %v, want 19ms (nearest rank of 20 samples must ignore the single 500ms outlier)", summary.P95DurationMS)
	}
	if summary.WindowCoveredFrom == nil || !summary.WindowCoveredFrom.Equal(now.Add(-20*time.Minute)) {
		t.Fatalf("windowCoveredFrom = %v, want the earliest in-window record", summary.WindowCoveredFrom)
	}

	// 空窗口必须是真实零值，而不是错误，也不能编造 P95。
	empty, err := service.Summary(ctx, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if empty.RequestCount != 0 || empty.ClientErrorCount != 0 || empty.ServerErrorCount != 0 || empty.P95DurationMS != nil || empty.WindowCoveredFrom != nil {
		t.Fatalf("empty window summary = %+v, want zero counts and no percentile", empty)
	}
}
