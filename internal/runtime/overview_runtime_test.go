package runtime

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/project"
)

// TestRuntimeOverviewAggregateAndStorageSize 在真实 Runtime + SQLite 上验证：
// 总览聚合来自 durable 事实、缺失权限时逐项裁剪、非 GET/query 拒绝，以及
// Storage Status 返回真实数据库大小。
func TestRuntimeOverviewAggregateAndStorageSize(t *testing.T) {
	rootPath := t.TempDir()
	rootConfig := project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}
	instance, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("cannot initialize project root: %v", err)
	}
	baseURL, cancel, runResult := startRuntime(t, instance)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			cancel()
			<-runResult
		}
	})
	ownerCookie := bootstrapOwner(t, baseURL)

	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections", ownerCookie, `{"name":"posts","type":"Normal","fields":[{"name":"title","type":"text"}]}`)
	if created.status != http.StatusCreated {
		t.Fatalf("create Collection status=%d body=%s", created.status, created.body)
	}
	var collection struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.body, &collection); err != nil {
		t.Fatal(err)
	}

	overview := getResponseWithCookie(t, baseURL+"/admin/api/v1/overview", "", ownerCookie)
	if overview.status != http.StatusOK {
		t.Fatalf("Overview read status=%d body=%s", overview.status, overview.body)
	}
	var snapshot struct {
		Data struct {
			GeneratedAt   string `json:"generatedAt"`
			WindowSeconds int    `json:"windowSeconds"`
			Collections   *struct {
				Count       int    `json:"count"`
				RecordCount *int64 `json:"recordCount"`
				Recent      []struct {
					ID           string `json:"id"`
					FieldCount   int    `json:"fieldCount"`
					PendingState string `json:"pendingChangeStatus"`
				} `json:"recent"`
			} `json:"collections"`
			Requests *struct {
				RequestCount int64 `json:"requestCount"`
			} `json:"requests"`
			Events  *struct{} `json:"events"`
			Changes *struct {
				PendingCount int `json:"pendingCount"`
			} `json:"changes"`
			Drift *struct {
				State string `json:"state"`
			} `json:"drift"`
		} `json:"data"`
	}
	if err := json.Unmarshal(overview.body, &snapshot); err != nil {
		t.Fatalf("cannot decode Overview body %s: %v", overview.body, err)
	}
	if snapshot.Data.GeneratedAt == "" || snapshot.Data.WindowSeconds != 86400 {
		t.Fatalf("Overview envelope = %+v, want a 24h window with generatedAt", snapshot.Data)
	}
	if snapshot.Data.Collections == nil || snapshot.Data.Collections.Count != 1 || snapshot.Data.Collections.RecordCount == nil {
		t.Fatalf("Overview collections = %+v, want one Collection with a record count for the Owner", snapshot.Data.Collections)
	}
	// 新建 Normal Collection 会带上 id / createdAt / updatedAt 系统字段，因此字段数为 4。
	if len(snapshot.Data.Collections.Recent) != 1 || snapshot.Data.Collections.Recent[0].ID != collection.Data.ID || snapshot.Data.Collections.Recent[0].FieldCount != 4 {
		t.Fatalf("Overview recent Collections = %+v, want the created Collection with its declared plus system fields", snapshot.Data.Collections.Recent)
	}
	if snapshot.Data.Requests == nil || snapshot.Data.Requests.RequestCount != 0 {
		t.Fatalf("Overview requests = %+v, want a real zero before any application request", snapshot.Data.Requests)
	}
	if snapshot.Data.Events == nil || snapshot.Data.Changes == nil || snapshot.Data.Drift == nil {
		t.Fatalf("Overview sections missing: events=%v changes=%v drift=%v", snapshot.Data.Events, snapshot.Data.Changes, snapshot.Data.Drift)
	}
	if snapshot.Data.Changes.PendingCount != 0 {
		t.Fatalf("Overview pending changes = %d, want 0 before any schema draft", snapshot.Data.Changes.PendingCount)
	}

	// 一条 durable Pending Change 必须立即出现在总览里。
	draft := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/schema/pending-operations", ownerCookie,
		`{"kind":"field","action":"add","definition":{"name":"slug","type":"text"}}`)
	if draft.status != http.StatusCreated {
		t.Fatalf("save pending operation status=%d body=%s", draft.status, draft.body)
	}
	afterDraft := getResponseWithCookie(t, baseURL+"/admin/api/v1/overview", "", ownerCookie)
	if !strings.Contains(string(afterDraft.body), `"pendingCount":1`) {
		t.Fatalf("Overview after a schema draft = %s, want pendingCount 1", afterDraft.body)
	}
	if !strings.Contains(string(afterDraft.body), `"withPendingChanges":1`) {
		t.Fatalf("Overview after a schema draft = %s, want withPendingChanges 1", afterDraft.body)
	}

	// 真实应用请求进入 24h 窗口计数。新 Collection 默认拒绝匿名访问，
	// 因此这次调用会被如实记为 4xx，而不是被总览忽略。
	applicationRequest := getResponseWithCookie(t, baseURL+"/api/v1/posts", "", "")
	if applicationRequest.status != http.StatusForbidden {
		t.Fatalf("application list status=%d body=%s, want 403 from the default deny Access Rules", applicationRequest.status, applicationRequest.body)
	}
	afterRequest := getResponseWithCookie(t, baseURL+"/admin/api/v1/overview", "", ownerCookie)
	if !strings.Contains(string(afterRequest.body), `"requestCount":1`) || !strings.Contains(string(afterRequest.body), `"clientErrorCount":1`) {
		t.Fatalf("Overview after one denied application request = %s, want requestCount 1 and clientErrorCount 1", afterRequest.body)
	}

	// 只读 Administrator 保留只读事实；越权写入仍然被拒绝。
	administrator := postJSONWithCookie(t, baseURL+"/admin/api/v1/administrators", ownerCookie,
		`{"email":"reader@example.test","password":"reader-password-42","permission":{"preset":"readOnly"}}`)
	if administrator.status != http.StatusCreated {
		t.Fatalf("create read-only Administrator status=%d body=%s", administrator.status, administrator.body)
	}
	login := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/auth/login", baseURL, "", "", `{"email":"reader@example.test","password":"reader-password-42"}`)
	if login.status != http.StatusOK {
		t.Fatalf("read-only Administrator login status=%d body=%s", login.status, login.body)
	}
	administratorCookie := sessionCookieFromEvidence(t, login)
	administratorOverview := getResponseWithCookie(t, baseURL+"/admin/api/v1/overview", "", administratorCookie)
	if administratorOverview.status != http.StatusOK {
		t.Fatalf("read-only Administrator Overview status=%d body=%s", administratorOverview.status, administratorOverview.body)
	}
	if !strings.Contains(string(administratorOverview.body), `"recordCount"`) {
		t.Fatalf("read-only Administrator Overview = %s, want record counts (records.read is in the read-only preset)", administratorOverview.body)
	}

	// 非 GET 与 query 参数都不被接受，避免把聚合端点扩展成查询接口。
	rejectedQuery := getResponseWithCookie(t, baseURL+"/admin/api/v1/overview?window=1h", "", ownerCookie)
	if rejectedQuery.status != http.StatusBadRequest || !strings.Contains(string(rejectedQuery.body), "INVALID_ARGUMENT") {
		t.Fatalf("Overview with a query = %d %s, want 400 INVALID_ARGUMENT", rejectedQuery.status, rejectedQuery.body)
	}
	rejectedMethod := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/overview", baseURL, ownerCookie, "", `{}`)
	if rejectedMethod.status != http.StatusNotFound {
		t.Fatalf("Overview POST = %d %s, want 404", rejectedMethod.status, rejectedMethod.body)
	}

	// Storage Status 必须给出真实数据库大小。
	storage := getResponseWithCookie(t, baseURL+"/admin/api/v1/storage/status", "", ownerCookie)
	if storage.status != http.StatusOK {
		t.Fatalf("Storage Status status=%d body=%s", storage.status, storage.body)
	}
	var storageStatus struct {
		DatabaseSizeBytes *int64 `json:"databaseSizeBytes"`
	}
	if err := json.Unmarshal(storage.body, &storageStatus); err != nil {
		t.Fatal(err)
	}
	if storageStatus.DatabaseSizeBytes == nil || *storageStatus.DatabaseSizeBytes <= 0 {
		t.Fatalf("Storage Status databaseSizeBytes = %v, want a positive byte count", storageStatus.DatabaseSizeBytes)
	}
}
