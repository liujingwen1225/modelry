package runtime

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"io"
	"path/filepath"
	"time"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/project"
)

// TestRuntimePortabilitySurfacesCreateBackupValidateRestoreAndExportRecords 在真实 Runtime 上验证
// Backup 是产品操作（manifest + 一致性快照）、preflight 可读、Export/Import 走 Record 语义、
// 以及 developer contract 与 Owner-only 权限边界。
func TestRuntimePortabilitySurfacesCreateBackupValidateRestoreAndExportRecords(t *testing.T) {
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

	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections", ownerCookie, `{"name":"posts","type":"Normal","fields":[{"name":"title","type":"text","required":true}]}`)
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
	record := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/records", baseURL, ownerCookie, "", `{"values":{"title":"exported"}}`)
	if record.status != http.StatusCreated {
		t.Fatalf("create Record status=%d body=%s", record.status, record.body)
	}

	// Backup：一致快照 + manifest。
	backupResponse := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/backup", baseURL, ownerCookie, "", "")
	if backupResponse.status != http.StatusOK {
		t.Fatalf("backup status=%d body=%s", backupResponse.status, backupResponse.body)
	}
	if !strings.Contains(backupResponse.headers.Get("Content-Disposition"), "modelry-backup-") {
		t.Fatalf("backup did not set a bundle file name: %q", backupResponse.headers.Get("Content-Disposition"))
	}
	archivePath := filepath.Join(t.TempDir(), "bundle.tar")
	if err := os.WriteFile(archivePath, backupResponse.body, 0o600); err != nil {
		t.Fatal(err)
	}
	if len(backupResponse.body) == 0 {
		t.Fatal("backup returned an empty bundle")
	}

	// Preflight：从 HTTP 上传同一个 bundle。
	preflight := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/restore/preflight", baseURL, ownerCookie, "application/x-tar", backupResponse.body)
	if preflight.status != http.StatusOK || !strings.Contains(string(preflight.body), `"compatible":true`) || !strings.Contains(string(preflight.body), `"records":1`) {
		t.Fatalf("restore preflight status=%d body=%s", preflight.status, preflight.body)
	}
	tampered := append([]byte(nil), backupResponse.body...)
	index := bytes.Index(tampered, []byte("exported"))
	if index < 0 {
		t.Fatal("fixture Record was not found inside the bundle")
	}
	tampered[index] = 'x'
	badPreflight := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/restore/preflight", baseURL, ownerCookie, "application/x-tar", tampered)
	if badPreflight.status != http.StatusOK || !strings.Contains(string(badPreflight.body), `"compatible":false`) {
		t.Fatalf("tampered preflight status=%d body=%s", badPreflight.status, badPreflight.body)
	}

	// Export：NDJSON header + Record。
	exported := getResponseWithCookie(t, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/export", "", ownerCookie)
	if exported.status != http.StatusOK || !strings.Contains(string(exported.body), `"kind":"collection"`) || !strings.Contains(string(exported.body), "exported") {
		t.Fatalf("export status=%d body=%s", exported.status, exported.body)
	}

	// Import：合法记录被创建，缺少必填字段的记录被逐条报告。
	importBody := strings.Split(strings.TrimSpace(string(exported.body)), "\n")[0] + "\n" +
		`{"kind":"record","values":{"title":"imported"}}` + "\n" +
		`{"kind":"record","values":{}}` + "\n"
	imported := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/import", baseURL, ownerCookie, "application/x-ndjson", []byte(importBody))
	if imported.status != http.StatusOK {
		t.Fatalf("import status=%d body=%s", imported.status, imported.body)
	}
	var summary struct {
		Data struct {
			Created int64 `json:"created"`
			Failed  int64 `json:"failed"`
			Results []struct {
				Status string `json:"status"`
				Code   string `json:"code"`
			} `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(imported.body, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Data.Created != 1 || summary.Data.Failed != 1 || summary.Data.Results[1].Status != "failed" || summary.Data.Results[1].Code != "VALIDATION_FAILED" {
		t.Fatalf("import summary = %s", imported.body)
	}

	// Developer contract：Typed Application API + content hash。
	contract := getResponseWithCookie(t, baseURL+"/admin/api/v1/developer/contract", "", ownerCookie)
	if contract.status != http.StatusOK || !strings.Contains(string(contract.body), `"contentHash"`) || !strings.Contains(string(contract.body), "GET /api/v1/posts") {
		t.Fatalf("developer contract status=%d body=%s", contract.status, contract.body)
	}

	// 权限边界：read-only Administrator 只能导出，不能 backup/import/contract。
	administrator := postJSONWithCookie(t, baseURL+"/admin/api/v1/administrators", ownerCookie,
		`{"email":"porter@example.test","password":"porter-password-42","permission":{"preset":"readOnly"}}`)
	if administrator.status != http.StatusCreated {
		t.Fatalf("create read-only Administrator status=%d body=%s", administrator.status, administrator.body)
	}
	login := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/auth/login", baseURL, "", "", `{"email":"porter@example.test","password":"porter-password-42"}`)
	if login.status != http.StatusOK {
		t.Fatalf("administrator login status=%d body=%s", login.status, login.body)
	}
	administratorCookie := sessionCookieFromEvidence(t, login)

	if exportedForAdministrator := getResponseWithCookie(t, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/export", "", administratorCookie); exportedForAdministrator.status != http.StatusOK {
		t.Fatalf("read-only Administrator export status=%d body=%s", exportedForAdministrator.status, exportedForAdministrator.body)
	}
	deniedBackup := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/backup", baseURL, administratorCookie, "", "")
	if deniedBackup.status != http.StatusForbidden {
		t.Fatalf("read-only Administrator backup status=%d body=%s", deniedBackup.status, deniedBackup.body)
	}
	deniedContract := getResponseWithCookie(t, baseURL+"/admin/api/v1/developer/contract", "", administratorCookie)
	if deniedContract.status != http.StatusForbidden {
		t.Fatalf("read-only Administrator contract status=%d body=%s", deniedContract.status, deniedContract.body)
	}
	deniedImport := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/import", baseURL, administratorCookie, "application/x-ndjson", []byte(importBody))
	if deniedImport.status != http.StatusForbidden {
		t.Fatalf("read-only Administrator import status=%d body=%s", deniedImport.status, deniedImport.body)
	}
}

// sendRawRequest 发送一个带原始字节载荷与显式 Content-Type 的请求。
func sendRawRequest(t *testing.T, method, target, origin, cookie, contentType string, payload []byte) responseEvidence {
	t.Helper()
	request, err := http.NewRequest(method, target, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Origin", origin)
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return responseEvidence{status: response.StatusCode, body: body, requestID: response.Header.Get("X-Request-Id"), headers: response.Header}
}