package overview

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/drift"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/requests"
)

func TestModuleReturnsSnapshotAndRejectsQueryParameters(t *testing.T) {
	service := newTestService(t, &fakeCollections{
		summaries: []backendmodel.CollectionSummary{{
			Collection: backendmodel.Collection{ID: "col_users", Name: "users", UpdatedAt: time.Now()},
			RecordCount: 3, PendingChangeStatus: backendmodel.ChangeReady,
		}},
	}, fakeRequests{}, fakeAutomation{}, fakeExtensions{}, fakeDrift{report: drift.Report{State: "ready"}})

	mux := http.NewServeMux()
	NewModule(service).RegisterRoutes(mux)

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/admin/api/v1/overview", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("overview status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data Snapshot `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.GeneratedAt.IsZero() || envelope.Data.Collections == nil || envelope.Data.Collections.Count != 1 {
		t.Fatalf("overview payload = %+v", envelope.Data)
	}

	// Owner 上下文缺失时 records.read / schema.read 判定为不允许：记录数与结构状态必须省略。
	if envelope.Data.Collections.RecordCount != nil || envelope.Data.Collections.Recent[0].PendingChangeStatus != "" {
		t.Fatalf("unauthenticated aggregate leaked record or schema status: %+v", envelope.Data.Collections)
	}

	rejected := httptest.NewRecorder()
	mux.ServeHTTP(rejected, httptest.NewRequest(http.MethodGet, "/admin/api/v1/overview?window=1h", nil))
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("overview with query = %d, want 400 so the shape stays single-purpose", rejected.Code)
	}
}

func TestModuleReportsUnavailableWhenNoFactCanBeRead(t *testing.T) {
	service := newTestService(t, &fakeCollections{failList: context.Canceled, failChang: context.Canceled},
		fakeRequests{err: context.Canceled}, fakeAutomation{err: context.Canceled},
		fakeExtensions{err: context.Canceled}, fakeDrift{err: context.Canceled})

	mux := http.NewServeMux()
	NewModule(service).RegisterRoutes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/admin/api/v1/overview", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable overview = %d, want 503; body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "RUNTIME_NOT_READY") {
		t.Fatalf("unavailable overview body = %s, want RUNTIME_NOT_READY", response.Body.String())
	}
}

func TestModuleWithoutServiceIsUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	NewModule(nil).RegisterRoutes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/admin/api/v1/overview", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("overview without a service = %d, want 503", response.Code)
	}
}

// Assignment guard: the production service must satisfy every narrow source interface we fake.
var (
	_ requestSummarySource    = fakeRequests{}
	_ automationSummarySource = fakeAutomation{}
	_ extensionSummarySource  = fakeExtensions{}
	_ driftReportSource       = fakeDrift{}
	_                         = requests.Summary{}
	_                         = automation.Summary{}
	_                         = extensions.HookSummary{}
)
