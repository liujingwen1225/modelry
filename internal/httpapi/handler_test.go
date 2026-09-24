package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/diagnostics"
)

type testDiagnostics struct{}

func (testDiagnostics) RuntimeStatus() diagnostics.RuntimeStatus {
	return diagnostics.RuntimeStatus{
		State:      "ready",
		ObservedAt: time.Date(2026, 9, 24, 1, 2, 3, 0, time.UTC),
		Database:   diagnostics.Health{State: "ready", Message: "SQLite database is ready."},
		LocalStorage: diagnostics.Health{
			State:   "ready",
			Message: "Local Storage is ready.",
		},
		ProjectSource: "flag",
		Version:       "test",
	}
}

func (testDiagnostics) StorageStatus() diagnostics.StorageStatus {
	return diagnostics.StorageStatus{
		Database: diagnostics.Health{State: "ready"},
		LocalStorage: diagnostics.LocalStorageStatus{
			State:    "ready",
			Provider: "Local",
			Path:     `C:\private\project\.modelry\files`,
		},
	}
}

func TestDiagnosticsAreAnonymousSafeAndHaveCanonicalRequestIDs(t *testing.T) {
	handler := NewHandler(testDiagnostics{}, http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodGet, "/admin/api/v1/storage/status", nil)
	request.Header.Set("X-Request-Id", "req_forged-client-value")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	requestID := response.Header().Get("X-Request-Id")
	if requestID == "" || requestID == "req_forged-client-value" || !strings.HasPrefix(requestID, "req_") {
		t.Fatalf("noncanonical request ID: %q", requestID)
	}
	if strings.Contains(response.Body.String(), `C:\private`) {
		t.Fatalf("anonymous storage response leaked a local path: %s", response.Body.String())
	}
	var body StorageStatusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.LocalStorage.Path != "" || body.LocalStorage.Provider != "Local" {
		t.Fatalf("unexpected anonymous storage snapshot: %#v", body.LocalStorage)
	}
}

func TestUnknownAPIPathReturnsStructured404WithMatchingRequestID(t *testing.T) {
	handler := NewHandler(testDiagnostics{}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("SPA fallback"))
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/not-implemented", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	var body errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "NOT_FOUND" || body.Error.Details == nil {
		t.Fatalf("unexpected error body: %#v", body)
	}
	if response.Header().Get("X-Request-Id") != body.Error.RequestID {
		t.Fatalf("request ID header %q differs from body %q", response.Header().Get("X-Request-Id"), body.Error.RequestID)
	}
	if body.Error.RequestID == "" {
		t.Fatal("error body has no request ID")
	}
	if strings.Contains(response.Body.String(), "SPA fallback") {
		t.Fatal("API not-found path used the Admin SPA fallback")
	}
}

func TestUnvalidatedCredentialsDoNotFallBackToAnonymousDiagnostics(t *testing.T) {
	handler := NewHandler(testDiagnostics{}, http.NotFoundHandler())
	request := httptest.NewRequest(http.MethodGet, "/admin/api/v1/runtime/status", nil)
	request.Header.Set("Authorization", "Bearer unvalidated")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	var body errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "UNAUTHENTICATED" || body.Error.RequestID != response.Header().Get("X-Request-Id") {
		t.Fatalf("unexpected credential error: %#v", body.Error)
	}
}

func TestOnlyNonAPIGETRequestsUseSPAFallback(t *testing.T) {
	handler := NewHandler(testDiagnostics{}, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(request.URL.Path))
	}))
	request := httptest.NewRequest(http.MethodGet, "/settings", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "/settings" {
		t.Fatalf("SPA route response = %d %q", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPost, "/settings", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("non-GET UI request status = %d, want 404", response.Code)
	}
}
