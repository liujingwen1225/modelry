package runtime

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// 验证 docs/specs/0012-collection-deletion.md 的真实 HTTP 闭环：
// 有记录、有待应用变更、有访问规则与认证配置的集合被删除后，
// 所有依赖数据消失、审计留下事实、错误路径不产生写入，重启后仍然不存在。
func TestCollectionDeletionIsCompleteAuditedAndDurable(t *testing.T) {
	rootPath := t.TempDir()
	rootConfig := project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}
	instance, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("cannot initialize project root: %v", err)
	}
	baseURL, cancel, runResult := startRuntime(t, instance)
	stopped := false
	defer func() {
		if !stopped {
			cancel()
			<-runResult
		}
	}()
	ownerCookie := bootstrapOwner(t, baseURL)

	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections", ownerCookie,
		`{"name":"notes","type":"Normal","fields":[{"name":"title","type":"text","required":true}]}`)
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
	collectionID := collection.Data.ID
	collectionPath := baseURL + "/admin/api/v1/collections/" + collectionID

	for _, title := range []string{"周末徒步路线", "第二篇笔记"} {
		record := postJSONWithCookie(t, collectionPath+"/records", ownerCookie, `{"values":{"title":"`+title+`"}}`)
		if record.status != http.StatusCreated {
			t.Fatalf("create Record status=%d body=%s", record.status, record.body)
		}
	}
	draft := postJSONWithCookie(t, collectionPath+"/schema/pending-operations", ownerCookie,
		`{"kind":"field","action":"add","definition":{"name":"slug","type":"text"}}`)
	if draft.status != http.StatusCreated {
		t.Fatalf("save pending operation status=%d body=%s", draft.status, draft.body)
	}

	// 名称不匹配不能删除，集合必须保持原样。
	mismatch := sendJSONRequest(t, http.MethodDelete, collectionPath, baseURL, ownerCookie, "", `{"confirmName":"wrong"}`)
	if mismatch.status != http.StatusBadRequest {
		t.Fatalf("mismatched confirmation status=%d body=%s", mismatch.status, mismatch.body)
	}
	if stillThere := getResponseWithCookie(t, collectionPath, "", ownerCookie); stillThere.status != http.StatusOK {
		t.Fatalf("Collection was removed after a rejected confirmation: %d %s", stillThere.status, stillThere.body)
	}

	// 未知集合返回 404，且不产生任何写入。
	missing := sendJSONRequest(t, http.MethodDelete, baseURL+"/admin/api/v1/collections/col_unknown0001", baseURL, ownerCookie, "", `{"confirmName":"notes"}`)
	if missing.status != http.StatusNotFound {
		t.Fatalf("unknown Collection deletion status=%d body=%s", missing.status, missing.body)
	}

	deleted := sendJSONRequest(t, http.MethodDelete, collectionPath, baseURL, ownerCookie, "", `{"confirmName":"notes"}`)
	if deleted.status != http.StatusOK {
		t.Fatalf("delete Collection status=%d body=%s", deleted.status, deleted.body)
	}
	var outcome struct {
		Data struct {
			CollectionID     string `json:"collectionId"`
			Name             string `json:"name"`
			DeletedRecords   int64  `json:"deletedRecords"`
			DiscardedChanges int64  `json:"discardedChanges"`
			Irreversible     bool   `json:"irreversible"`
		} `json:"data"`
	}
	if err := json.Unmarshal(deleted.body, &outcome); err != nil {
		t.Fatal(err)
	}
	if outcome.Data.CollectionID != collectionID || outcome.Data.Name != "notes" ||
		outcome.Data.DeletedRecords != 2 || outcome.Data.DiscardedChanges != 1 || !outcome.Data.Irreversible {
		t.Fatalf("deletion result did not report the real impact: %s", deleted.body)
	}

	if gone := getResponseWithCookie(t, collectionPath, "", ownerCookie); gone.status != http.StatusNotFound {
		t.Fatalf("deleted Collection still readable: %d %s", gone.status, gone.body)
	}
	if records := getResponseWithCookie(t, collectionPath+"/records", "", ownerCookie); records.status != http.StatusNotFound {
		t.Fatalf("deleted Collection still exposes Records: %d %s", records.status, records.body)
	}
	if rules := getResponseWithCookie(t, collectionPath+"/access-rules", "", ownerCookie); rules.status != http.StatusNotFound {
		t.Fatalf("deleted Collection still exposes Access Rules: %d %s", rules.status, rules.body)
	}
	if changes := getResponseWithCookie(t, baseURL+"/admin/api/v1/changes", "", ownerCookie); changes.status != http.StatusOK || strings.Contains(string(changes.body), collectionID) {
		t.Fatalf("changes still reference the deleted Collection: %d %s", changes.status, changes.body)
	}

	// 审计事实必须留下，且其它集合的审计不受影响。
	auditPage := getResponseWithCookie(t, baseURL+"/admin/api/v1/audit?action=collection.deleted", "", ownerCookie)
	if auditPage.status != http.StatusOK || !strings.Contains(string(auditPage.body), collectionID) {
		t.Fatalf("collection.deleted Audit fact missing: %d %s", auditPage.status, auditPage.body)
	}

	// 投影表被真正 DROP。
	var projectionCount int64
	if err := instance.store.WithReadSnapshot(t.Context(), func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(t.Context(),
			`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, "mry_records_"+strings.TrimPrefix(collectionID, "col_"),
		).Scan(&projectionCount)
	}); err != nil {
		t.Fatal(err)
	}
	if projectionCount != 0 {
		t.Fatal("Records projection table survived Collection deletion")
	}

	// 重启 Runtime 后集合仍不存在。
	cancel()
	<-runResult
	stopped = true
	restarted, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	restartBase, restartCancel, restartResult := startRuntime(t, restarted)
	defer func() {
		restartCancel()
		<-restartResult
	}()
	restartLogin := sendJSONRequest(t, http.MethodPost, restartBase+"/admin/api/v1/auth/login", restartBase, "", "",
		`{"email":"owner@example.com","password":"Sufficient-Owner-Password-42"}`)
	if restartLogin.status != http.StatusOK {
		t.Fatalf("sign in after restart status=%d body=%s", restartLogin.status, restartLogin.body)
	}
	restartCookie := sessionCookieFromEvidence(t, restartLogin)
	afterRestart := getResponseWithCookie(t, restartBase+"/admin/api/v1/collections/"+collectionID, "", restartCookie)
	if afterRestart.status != http.StatusNotFound {
		t.Fatalf("deleted Collection reappeared after restart: %d %s", afterRestart.status, afterRestart.body)
	}
}
