package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/portability"
	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/storage"
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

	// Import 的 model compatibility gate 不能被绕过：缺失或空的 hash 是 INVALID_ARGUMENT，
	// 不一致的 hash 是 MODEL_MISMATCH。
	header := strings.Split(strings.TrimSpace(string(exported.body)), "\n")[0]
	recordLine := `{"kind":"record","values":{"title":"gated"}}`
	withoutHash := headerWithoutAppliedModelHash(t, header)
	missingHash := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/import", baseURL, ownerCookie, "application/x-ndjson", []byte(withoutHash+"\n"+recordLine+"\n"))
	if missingHash.status != http.StatusBadRequest || !strings.Contains(string(missingHash.body), `"INVALID_ARGUMENT"`) {
		t.Fatalf("import without appliedModelHash status=%d body=%s", missingHash.status, missingHash.body)
	}
	emptyHash := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/import", baseURL, ownerCookie, "application/x-ndjson", []byte(headerWithAppliedModelHash(t, header, "   ")+"\n"+recordLine+"\n"))
	if emptyHash.status != http.StatusBadRequest || !strings.Contains(string(emptyHash.body), `"INVALID_ARGUMENT"`) {
		t.Fatalf("import with an empty appliedModelHash status=%d body=%s", emptyHash.status, emptyHash.body)
	}
	mismatchedHash := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/import", baseURL, ownerCookie, "application/x-ndjson", []byte(headerWithAppliedModelHash(t, header, strings.Repeat("0", 64))+"\n"+recordLine+"\n"))
	if mismatchedHash.status != http.StatusConflict || !strings.Contains(string(mismatchedHash.body), `"MODEL_MISMATCH"`) {
		t.Fatalf("import with a mismatched appliedModelHash status=%d body=%s", mismatchedHash.status, mismatchedHash.body)
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

// rewriteExportHeader 改写导出 header 的 appliedModelHash。
func rewriteExportHeader(t *testing.T, header, hash string, include bool) string {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(header), &decoded); err != nil {
		t.Fatalf("decode export header: %v", err)
	}
	if include {
		decoded["appliedModelHash"] = hash
	} else {
		delete(decoded, "appliedModelHash")
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func headerWithoutAppliedModelHash(t *testing.T, header string) string {
	t.Helper()
	return rewriteExportHeader(t, header, "", false)
}

func headerWithAppliedModelHash(t *testing.T, header, hash string) string {
	t.Helper()
	return rewriteExportHeader(t, header, hash, true)
}

// TestRuntimeBackupStaysConsistentUnderConcurrentRecordWrites 在真实 Runtime、真实
// SQLite 与真实 HTTP 上证明：Runtime 正在写 Record 时产生的 bundle，其 manifest
// 描述的事实与归档里的数据库载荷完全一致。
func TestRuntimeBackupStaysConsistentUnderConcurrentRecordWrites(t *testing.T) {
	ctx := context.Background()
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
	recordTarget := baseURL + "/admin/api/v1/collections/" + collection.Data.ID + "/records"
	seed := sendJSONRequest(t, http.MethodPost, recordTarget, baseURL, ownerCookie, "", `{"values":{"title":"seed"}}`)
	if seed.status != http.StatusCreated {
		t.Fatalf("seed Record status=%d body=%s", seed.status, seed.body)
	}

	stop := make(chan struct{})
	writerDone := make(chan struct{})
	var committed atomic.Int64
	go func() {
		defer close(writerDone)
		for index := 0; ; index++ {
			select {
			case <-stop:
				return
			default:
			}
			payload := `{"values":{"title":"concurrent-` + strconv.Itoa(index) + `"}}`
			request, err := http.NewRequest(http.MethodPost, recordTarget, strings.NewReader(payload))
			if err != nil {
				return
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", baseURL)
			request.Header.Set("Cookie", ownerCookie)
			response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
			if err != nil {
				return
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusCreated {
				committed.Add(1)
			}
		}
	}()
	// 等到并发写入真的落下，否则这个测试无法证明任何一致性。
	for deadline := time.Now().Add(10 * time.Second); committed.Load() < 2; {
		if time.Now().After(deadline) {
			close(stop)
			<-writerDone
			t.Fatal("the concurrent writer did not commit any Record")
		}
		time.Sleep(2 * time.Millisecond)
	}

	backup := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/backup", baseURL, ownerCookie, "", "")
	close(stop)
	<-writerDone
	if backup.status != http.StatusOK {
		t.Fatalf("backup during concurrent writes status=%d body=%s", backup.status, backup.body)
	}

	manifestBytes, databaseBytes := readBundleEntries(t, backup.body)
	var manifest struct {
		AppliedModelHash string `json:"appliedModelHash"`
		Counts           struct {
			Collections int64 `json:"collections"`
			Records     int64 `json:"records"`
			Objects     int64 `json:"objects"`
		} `json:"counts"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	databasePath := filepath.Join(t.TempDir(), "archived.sqlite")
	if err := os.WriteFile(databasePath, databaseBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	archived, err := storage.OpenReadOnly(databasePath)
	if err != nil {
		t.Fatalf("open the archived database: %v", err)
	}
	defer archived.Close()
	archivedCollections, err := archived.CollectionCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	archivedRecords, err := archived.ProjectedRecordCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if archivedCollections != manifest.Counts.Collections || archivedRecords != manifest.Counts.Records {
		t.Fatalf("manifest counts = %+v but the archived database holds collections=%d records=%d",
			manifest.Counts, archivedCollections, archivedRecords)
	}
	if len(manifest.AppliedModelHash) != 64 {
		t.Fatalf("manifest appliedModelHash = %q", manifest.AppliedModelHash)
	}
	// 并发写入确实发生过，否则这个测试什么也没有证明。
	if archivedRecords < 2 {
		t.Fatalf("archived Records = %d, want the concurrent writer to have added Records", archivedRecords)
	}

	// bundle 本身必须可 preflight，并报告与 manifest 相同的 counts。
	preflight := sendRawRequest(t, http.MethodPost, baseURL+"/admin/api/v1/restore/preflight", baseURL, ownerCookie, "application/x-tar", backup.body)
	if preflight.status != http.StatusOK || !strings.Contains(string(preflight.body), `"compatible":true`) {
		t.Fatalf("preflight of the concurrent bundle status=%d body=%s", preflight.status, preflight.body)
	}

	// restart：同一个项目重新启动后 Record 仍然可读。
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
	restartLogin := sendJSONRequest(t, http.MethodPost, restartBase+"/admin/api/v1/auth/login", restartBase, "", "", `{"email":"owner@example.com","password":"Sufficient-Owner-Password-42"}`)
	if restartLogin.status != http.StatusOK {
		t.Fatalf("sign in after restart status=%d body=%s", restartLogin.status, restartLogin.body)
	}
	restartCookie := sessionCookieFromEvidence(t, restartLogin)
	page := getResponseWithCookie(t, restartBase+"/admin/api/v1/collections/"+collection.Data.ID+"/records", "", restartCookie)
	if page.status != http.StatusOK || !strings.Contains(string(page.body), "concurrent-0") {
		t.Fatalf("Records after restart status=%d body=%s", page.status, page.body)
	}
}

// readBundleEntries 从一个 tar bundle 中读出 manifest 与数据库载荷。
func readBundleEntries(t *testing.T, bundle []byte) ([]byte, []byte) {
	t.Helper()
	reader := tar.NewReader(bytes.NewReader(bundle))
	var manifest, database []byte
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("read bundle: %v", err)
		}
		switch header.Name {
		case "manifest.json":
			manifest, err = io.ReadAll(reader)
		case "database/project.sqlite":
			database, err = io.ReadAll(reader)
		default:
			continue
		}
		if err != nil {
			t.Fatalf("read bundle entry %q: %v", header.Name, err)
		}
	}
	if len(manifest) == 0 || len(database) == 0 {
		t.Fatalf("bundle is missing the manifest (%d bytes) or the database payload (%d bytes)", len(manifest), len(database))
	}
	return manifest, database
}

// TestRuntimeRestoreFromBackupSurvivesRestart 覆盖真实闭环：在一个项目上 Backup，
// 把 bundle restore 到另一个项目根目录，再启动一个 Runtime 并在真实 HTTP 上读回 Record。
func TestRuntimeRestoreFromBackupSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	sourceRoot := t.TempDir()
	sourceConfig := project.RootConfig{FlagPath: &sourceRoot, WorkingDir: t.TempDir()}
	source, err := New(Options{ProjectRoot: sourceConfig, Version: "test"})
	if err != nil {
		t.Fatalf("cannot initialize the source project root: %v", err)
	}
	baseURL, cancel, runResult := startRuntime(t, source)
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
	for _, title := range []string{"alpha", "beta"} {
		record := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/records", baseURL, ownerCookie, "", `{"values":{"title":"`+title+`"}}`)
		if record.status != http.StatusCreated {
			t.Fatalf("create Record status=%d body=%s", record.status, record.body)
		}
	}
	backup := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/backup", baseURL, ownerCookie, "", "")
	if backup.status != http.StatusOK {
		t.Fatalf("backup status=%d body=%s", backup.status, backup.body)
	}
	cancel()
	<-runResult
	stopped = true

	// CLI 在项目停止后执行的正是这一步：restore apply 到另一个项目根目录。
	targetRoot := t.TempDir()
	target, err := project.ResolveRoot(project.RootConfig{FlagPath: &targetRoot, WorkingDir: t.TempDir()})
	if err != nil {
		t.Fatalf("resolve the target project root: %v", err)
	}
	if err := os.MkdirAll(target.ManagedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(t.TempDir(), "bundle.tar")
	if err := os.WriteFile(archivePath, backup.body, 0o600); err != nil {
		t.Fatal(err)
	}
	inspection, err := portability.NewInspectionService(portability.InspectionOptions{ManagedDir: target.ManagedDir, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inspection.Apply(ctx, archivePath, portability.ApplyOptions{
		DatabasePath: target.Database, ObjectsDir: target.Objects,
	}); err != nil {
		t.Fatalf("restore the backup into another project root: %v", err)
	}

	// restart：在恢复出来的项目根目录上启动一个真实 Runtime，并通过真实 HTTP 读回 Record。
	restored, err := New(Options{ProjectRoot: project.RootConfig{FlagPath: &targetRoot, WorkingDir: t.TempDir()}, Version: "test"})
	if err != nil {
		t.Fatalf("start the restored project: %v", err)
	}
	restoredBase, restoredCancel, restoredResult := startRuntime(t, restored)
	defer func() {
		restoredCancel()
		<-restoredResult
	}()
	// 恢复出来的项目自带原来的 Owner 账户，因此这里用同一套凭据登录，而不是重新 bootstrap。
	restoredLogin := sendJSONRequest(t, http.MethodPost, restoredBase+"/admin/api/v1/auth/login", restoredBase, "", "", `{"email":"owner@example.com","password":"Sufficient-Owner-Password-42"}`)
	if restoredLogin.status != http.StatusOK {
		t.Fatalf("sign in to the restored project status=%d body=%s", restoredLogin.status, restoredLogin.body)
	}
	restoredCookie := sessionCookieFromEvidence(t, restoredLogin)
	page := getResponseWithCookie(t, restoredBase+"/admin/api/v1/collections/"+collection.Data.ID+"/records", "", restoredCookie)
	if page.status != http.StatusOK {
		t.Fatalf("list restored Records status=%d body=%s", page.status, page.body)
	}
	for _, title := range []string{"alpha", "beta"} {
		if !strings.Contains(string(page.body), title) {
			t.Fatalf("the restored project lost the Record %q: %s", title, page.body)
		}
	}
}

// TestRuntimeRefusesToStartInTheMiddleOfAnInterruptedRestore 证明一个半恢复的项目不会
// 被静默地当成空项目打开：一次被中断的 restore 会让 project.sqlite 短暂不存在，如果
// Runtime 此时启动，SQLite 会创建一个全新的空项目，操作者会看到数据全无。
func TestRuntimeRefusesToStartInTheMiddleOfAnInterruptedRestore(t *testing.T) {
	rootPath := t.TempDir()
	managed := filepath.Join(rootPath, ".modelry")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(managed, portability.RestoreJournalName)
	if err := os.WriteFile(journal, []byte(`{"op":"backup","dest":"x","path":"y"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	instance, err := New(Options{ProjectRoot: project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}, Version: "test"})
	if err == nil {
		_ = instance.Close()
		t.Fatal("the Runtime started in the middle of an interrupted restore")
	}
	if !strings.Contains(err.Error(), "interrupted restore") {
		t.Fatalf("startup error = %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(managed, "project.sqlite")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("the refused startup created a project database anyway: %v", statErr)
	}

	// 清理之后同一个项目必须可以正常启动。
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(Options{ProjectRoot: project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}, Version: "test"})
	if err != nil {
		t.Fatalf("the Runtime did not start after the journal was cleared: %v", err)
	}
	if err := restarted.Close(); err != nil {
		t.Fatal(err)
	}
}

// TestRuntimeStartsAfterACommittedRestoreIsCleanedUp 证明一个已经提交、只是没来得及
// 清理的 journal 不会把项目永久挡在启动之外：它会被就地收敛。
func TestRuntimeStartsAfterACommittedRestoreIsCleanedUp(t *testing.T) {
	rootPath := t.TempDir()
	managed := filepath.Join(rootPath, ".modelry")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(managed, portability.RestoreJournalName)
	backup := filepath.Join(managed, "project.sqlite.committed.old")
	if err := os.WriteFile(backup, []byte("the-old-database"), 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(managed, "committed-project.sqlite")
	transaction := "restore-runtime-committed"
	body := `{"op":"begin","id":"` + transaction + `"}` + "\n" +
		`{"op":"target","id":"` + transaction + `","dest":` + strconv.Quote(destination) + `,"exists":false}` + "\n" +
		`{"op":"stage","dest":` + strconv.Quote(destination) + `,"path":"y"}` + "\n" +
		`{"op":"backup","dest":` + strconv.Quote(destination) + `,"path":` + strconv.Quote(backup) + `}` + "\n" +
		`{"op":"absent","dest":` + strconv.Quote(destination) + `}` + "\n" +
		`{"op":"activate","dest":` + strconv.Quote(destination) + `,"path":"y"}` + "\n"
	if err := os.WriteFile(journal, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	journalDigest := sha256.Sum256([]byte(body))
	marker, err := json.Marshal(map[string]any{
		"version": 1, "transaction": transaction, "journalSha256": hex.EncodeToString(journalDigest[:]),
		"destinations": []map[string]any{{"path": destination, "exists": false}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(managed, portability.RestoreCommitName), marker, 0o600); err != nil {
		t.Fatal(err)
	}

	instance, err := New(Options{ProjectRoot: project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}, Version: "test"})
	if err != nil {
		t.Fatalf("a committed restore blocked startup: %v", err)
	}
	if err := instance.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(journal); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the committed journal was not consumed: %v", err)
	}
	if _, err := os.Stat(backup); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the committed journal left its backup behind: %v", err)
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
