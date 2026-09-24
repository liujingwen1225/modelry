package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestEmptyProjectStartsReadyServesRealHTTPAndRestartsDurably(t *testing.T) {
	rootPath := t.TempDir()
	entries, err := os.ReadDir(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("test project root is not empty: %v", entries)
	}
	rootConfig := project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}

	instance, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("cannot initialize empty project root: %v", err)
	}
	projectID := instance.ProjectID()
	if !strings.HasPrefix(projectID, "prj_") {
		t.Fatalf("unexpected project ID: %q", projectID)
	}
	if got := instance.RuntimeStatus().State; got != "starting" {
		t.Fatalf("runtime reported %q before listener bind, want starting", got)
	}
	if !storageVersionSupported(instance.SQLiteVersion()) {
		t.Fatalf("runtime opened unsupported SQLite %s", instance.SQLiteVersion())
	}
	settings, err := instance.store.ConnectionSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(settings) != 8 {
		t.Fatalf("verified %d physical SQLite connections, want 8", len(settings))
	}
	for index, setting := range settings {
		if setting.ForeignKeys != 1 || setting.BusyTimeout != 5000 || setting.Synchronous != 2 || !strings.EqualFold(setting.JournalMode, "wal") {
			t.Fatalf("SQLite connection %d has unsafe settings: %#v", index+1, setting)
		}
	}

	if _, err := New(Options{ProjectRoot: rootConfig}); err == nil || !strings.Contains(err.Error(), "already holds") {
		t.Fatalf("second Runtime was not denied the project lock: %v", err)
	}

	baseURL, cancel, runResult := startRuntime(t, instance)
	statusBody := getResponse(t, baseURL+"/admin/api/v1/runtime/status", "")
	var runtimeStatus map[string]any
	if err := json.Unmarshal(statusBody.body, &runtimeStatus); err != nil {
		t.Fatal(err)
	}
	if statusBody.status != http.StatusOK || runtimeStatus["state"] != "ready" {
		t.Fatalf("runtime status was not ready over HTTP: status=%d body=%s", statusBody.status, statusBody.body)
	}
	if strings.Contains(string(statusBody.body), rootPath) || strings.Contains(string(statusBody.body), ".modelry") {
		t.Fatalf("anonymous runtime status leaked a local path: %s", statusBody.body)
	}
	databaseHealth, ok := runtimeStatus["database"].(map[string]any)
	if !ok || databaseHealth["state"] != "ready" {
		t.Fatalf("runtime database health was not ready: %#v", runtimeStatus["database"])
	}
	localHealth, ok := runtimeStatus["localStorage"].(map[string]any)
	if !ok || localHealth["state"] != "ready" {
		t.Fatalf("runtime local storage health was not ready: %#v", runtimeStatus["localStorage"])
	}

	storageBody := getResponse(t, baseURL+"/admin/api/v1/storage/status", "")
	if storageBody.status != http.StatusOK || strings.Contains(string(storageBody.body), rootPath) {
		t.Fatalf("anonymous storage status was unsafe or unavailable: status=%d body=%s", storageBody.status, storageBody.body)
	}
	var storageStatus struct {
		Database     map[string]any `json:"database"`
		LocalStorage struct {
			State    string `json:"state"`
			Provider string `json:"provider"`
			Path     string `json:"path"`
		} `json:"localStorage"`
	}
	if err := json.Unmarshal(storageBody.body, &storageStatus); err != nil {
		t.Fatal(err)
	}
	if storageStatus.LocalStorage.State != "ready" || storageStatus.LocalStorage.Provider != "Local" || storageStatus.LocalStorage.Path != "" {
		t.Fatalf("unexpected anonymous Local Storage health: %#v", storageStatus.LocalStorage)
	}
	if err := os.Remove(instance.root.TempFiles); err != nil {
		t.Fatal(err)
	}
	degradedStorage := getResponse(t, baseURL+"/admin/api/v1/storage/status", "")
	if degradedStorage.status != http.StatusOK || !strings.Contains(string(degradedStorage.body), `"state":"unavailable"`) {
		t.Fatalf("Local Storage failure was not visible over HTTP: status=%d body=%s", degradedStorage.status, degradedStorage.body)
	}
	degradedRuntime := getResponse(t, baseURL+"/admin/api/v1/runtime/status", "")
	if !strings.Contains(string(degradedRuntime.body), `"state":"degraded"`) {
		t.Fatalf("Runtime did not revoke READY when Local Storage became unavailable: %s", degradedRuntime.body)
	}
	if err := os.Mkdir(instance.root.TempFiles, 0o700); err != nil {
		t.Fatal(err)
	}
	recoveredRuntime := getResponse(t, baseURL+"/admin/api/v1/runtime/status", "")
	if !strings.Contains(string(recoveredRuntime.body), `"state":"ready"`) {
		t.Fatalf("Runtime did not recover readiness after Local Storage became available: %s", recoveredRuntime.body)
	}

	errorResponse := getResponse(t, baseURL+"/admin/api/v1/not-implemented", "req_forged-client-id")
	if errorResponse.status != http.StatusNotFound {
		t.Fatalf("unimplemented API route status = %d, want 404: %s", errorResponse.status, errorResponse.body)
	}
	var apiError struct {
		Error struct {
			Code      string         `json:"code"`
			Details   map[string]any `json:"details"`
			RequestID string         `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(errorResponse.body, &apiError); err != nil {
		t.Fatal(err)
	}
	headerID := errorResponse.requestID
	if apiError.Error.Code != "NOT_FOUND" || apiError.Error.Details == nil || apiError.Error.RequestID != headerID || headerID == "req_forged-client-id" {
		t.Fatalf("structured error and canonical request ID did not match: header=%q body=%#v", headerID, apiError.Error)
	}

	cancel()
	if err := <-runResult; err != nil {
		t.Fatalf("graceful shutdown failed: %v", err)
	}
	if !instance.store.IsClosed() {
		t.Fatal("SQLite connection pool stayed open after shutdown")
	}

	durableProjectID, err := storage.ReadProjectID(filepath.Join(rootPath, ".modelry", "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if durableProjectID != projectID {
		t.Fatalf("shutdown changed durable project ID from %q to %q", projectID, durableProjectID)
	}

	restarted, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("Runtime could not restart after graceful shutdown: %v", err)
	}
	if restarted.ProjectID() != projectID {
		t.Fatalf("restart changed project ID from %q to %q", projectID, restarted.ProjectID())
	}
	baseURL, cancel, runResult = startRuntime(t, restarted)
	statusBody = getResponse(t, baseURL+"/admin/api/v1/runtime/status", "")
	if statusBody.status != http.StatusOK || !strings.Contains(string(statusBody.body), `"state":"ready"`) {
		t.Fatalf("restarted Runtime did not become ready: status=%d body=%s", statusBody.status, statusBody.body)
	}
	cancel()
	if err := <-runResult; err != nil {
		t.Fatalf("restarted Runtime did not stop cleanly: %v", err)
	}
}

type responseEvidence struct {
	status    int
	body      []byte
	requestID string
}

func getResponse(t *testing.T, target, suppliedRequestID string) responseEvidence {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	if suppliedRequestID != "" {
		request.Header.Set("X-Request-Id", suppliedRequestID)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return responseEvidence{status: response.StatusCode, body: body, requestID: response.Header.Get("X-Request-Id")}
}

func startRuntime(t *testing.T, instance *Runtime) (string, context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan net.Addr, 1)
	runResult := make(chan error, 1)
	go func() {
		runResult <- instance.Run(ctx, "127.0.0.1:0", func(address net.Addr) { ready <- address })
	}()
	select {
	case address := <-ready:
		return "http://" + address.String(), cancel, runResult
	case err := <-runResult:
		cancel()
		t.Fatalf("Runtime exited before READY: %v", err)
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("Runtime did not reach READY within 5 seconds")
	}
	return "", cancel, runResult
}

func storageVersionSupported(version string) bool {
	parts := strings.Split(version, ".")
	if len(parts) < 3 {
		return false
	}
	major, majorErr := strconv.Atoi(parts[0])
	minor, minorErr := strconv.Atoi(parts[1])
	patch, patchErr := strconv.Atoi(parts[2])
	if majorErr != nil || minorErr != nil || patchErr != nil {
		return false
	}
	return major > 3 || major == 3 && (minor > 51 || minor == 51 && patch >= 3)
}
