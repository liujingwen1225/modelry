package requests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestApplicationMiddlewarePersistsOnlyRedactedRequestMetadata(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/posts", func(w http.ResponseWriter, request *http.Request) {
		MarkCollection(request.Context(), "col_posts")
		MarkAuthentication(request.Context(), AuthenticationAuthenticated)
		MarkAuthorization(request.Context(), AuthorizationAllowed)
		httpapi.WriteAPIJSON(w, http.StatusCreated, map[string]any{"data": map[string]string{"title": "private response value"}})
	})
	mux.HandleFunc("GET /api/v1/posts/{recordId}", func(w http.ResponseWriter, request *http.Request) {
		MarkCollection(request.Context(), "col_posts")
		MarkAuthentication(request.Context(), AuthenticationRejected)
		MarkAuthorization(request.Context(), AuthorizationNotEvaluated)
		httpapi.WriteAPIError(w, request, http.StatusUnauthorized, httpapi.APIError{Code: "UNAUTHENTICATED", Message: "Session rejected"})
	})
	server := httpapi.NewHandler(nil, nil, service.Middleware(mux))

	writeRequest := httptest.NewRequest(http.MethodPost, "/api/v1/posts?search=query-secret", strings.NewReader(`{"password":"body-secret"}`))
	writeRequest.Header.Set("Authorization", "Bearer credential-secret")
	writeRequest.Header.Set("X-Request-Id", "req_forged-request-id")
	writeRequest.Header.Set("Content-Type", "application/json")
	writeResponse := httptest.NewRecorder()
	server.ServeHTTP(writeResponse, writeRequest)
	if writeResponse.Code != http.StatusCreated || writeResponse.Header().Get(PersistedHeader) != "true" {
		t.Fatalf("Application create response = %d, persistence header = %q", writeResponse.Code, writeResponse.Header().Get(PersistedHeader))
	}
	requestID := writeResponse.Header().Get("X-Request-Id")
	if !requestIDPattern.MatchString(requestID) || requestID == "req_forged-request-id" {
		t.Fatalf("canonical Request ID = %q", requestID)
	}
	created, err := service.Get(t.Context(), requestID)
	if err != nil {
		t.Fatal(err)
	}
	if created.CollectionID != "col_posts" || created.Endpoint != "/api/v1/posts" || created.Method != http.MethodPost || created.Status != http.StatusCreated ||
		created.AuthenticationOutcome != AuthenticationAuthenticated || created.AuthorizationOutcome != AuthorizationAllowed || created.Time.IsZero() {
		t.Fatalf("persisted RequestRecord = %+v", created)
	}
	encoded, err := json.Marshal(created)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"credential-secret", "query-secret", "body-secret", "private response value", "Authorization"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("RequestRecord leaked %q: %s", secret, encoded)
		}
	}

	errorRequest := httptest.NewRequest(http.MethodGet, "/api/v1/posts/rec_private?email=query-secret", nil)
	errorResponse := httptest.NewRecorder()
	server.ServeHTTP(errorResponse, errorRequest)
	if errorResponse.Code != http.StatusUnauthorized || errorResponse.Header().Get(PersistedHeader) != "true" {
		t.Fatalf("Application error response = %d, persistence header = %q", errorResponse.Code, errorResponse.Header().Get(PersistedHeader))
	}
	failed, err := service.Get(t.Context(), errorResponse.Header().Get("X-Request-Id"))
	if err != nil || failed.ErrorCode != "UNAUTHENTICATED" || failed.AuthenticationOutcome != AuthenticationRejected || failed.AuthorizationOutcome != AuthorizationNotEvaluated {
		t.Fatalf("persisted error RequestRecord = %+v, error = %v", failed, err)
	}
}

func TestApplicationMiddlewareDoesNotClaimMissingDurableDetail(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/posts", func(w http.ResponseWriter, _ *http.Request) {
		httpapi.WriteAPIJSON(w, http.StatusOK, map[string]any{"data": []any{}})
	})
	server := httpapi.NewHandler(nil, nil, service.Middleware(mux))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/posts", nil))
	if response.Code != http.StatusOK || response.Header().Get(PersistedHeader) != "false" {
		t.Fatalf("unpersisted response = %d, persistence header = %q", response.Code, response.Header().Get(PersistedHeader))
	}
	if _, err := service.Get(t.Context(), response.Header().Get("X-Request-Id")); err == nil || err == ErrNotFound {
		t.Fatalf("Request ID was presented as a durable detail after storage failure: %v", err)
	}
}
