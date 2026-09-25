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
	if created.CollectionID != "col_posts" || created.Endpoint != "/api/v1/{collectionName}" || created.Method != http.MethodPost || created.Status != http.StatusCreated ||
		created.AuthenticationOutcome != AuthenticationAuthenticated || created.AuthorizationOutcome != AuthorizationAllowed || created.Time.IsZero() {
		t.Fatalf("persisted RequestRecord = %+v", created)
	}
	if created.ResponseSizeBytes == nil || *created.ResponseSizeBytes != int64(writeResponse.Body.Len()) {
		t.Fatalf("persisted response size = %v, want %d bytes", created.ResponseSizeBytes, writeResponse.Body.Len())
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

	credentialMux := http.NewServeMux()
	credentialMux.HandleFunc("GET /api/v1/{collectionName}/events", func(w http.ResponseWriter, request *http.Request) {
		httpapi.WriteAPIError(w, request, http.StatusNotFound, httpapi.APIError{Code: "NOT_FOUND", Message: "The requested Collection was not found."})
	})
	credentialServer := httpapi.NewHandler(nil, nil, service.Middleware(credentialMux))
	pathCredentialRequest := httptest.NewRequest(http.MethodGet, "/api/v1/path-credential-secret/events", nil)
	pathCredentialResponse := httptest.NewRecorder()
	credentialServer.ServeHTTP(pathCredentialResponse, pathCredentialRequest)
	if pathCredentialResponse.Code != http.StatusNotFound || pathCredentialResponse.Header().Get(PersistedHeader) != "true" {
		t.Fatalf("unknown Collection response = %d, persistence header = %q", pathCredentialResponse.Code, pathCredentialResponse.Header().Get(PersistedHeader))
	}
	pathCredentialRecord, err := service.Get(t.Context(), pathCredentialResponse.Header().Get("X-Request-Id"))
	if err != nil {
		t.Fatal(err)
	}
	if pathCredentialRecord.Endpoint != "/api/v1/{collectionName}/events" {
		t.Fatalf("path credential endpoint = %q", pathCredentialRecord.Endpoint)
	}
	encodedPathCredentialRecord, err := json.Marshal(pathCredentialRecord)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedPathCredentialRecord), "path-credential-secret") {
		t.Fatalf("RequestRecord leaked path credential: %s", encodedPathCredentialRecord)
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

func TestApplicationStreamingResponsesPersistBeforeHeadersCommit(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		body        []byte
	}{
		{
			name:        "large JSON",
			contentType: "application/json",
			body:        []byte(`{"data":"` + strings.Repeat("x", maximumBufferedJSON) + `"}`),
		},
		{
			name:        "text stream",
			contentType: "text/plain",
			body:        []byte("streamed response"),
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
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
			mux.HandleFunc("GET /api/v1/{responseType}", func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", testCase.contentType)
				if _, err := w.Write(testCase.body); err != nil {
					t.Errorf("write response: %v", err)
				}
			})
			server := httpapi.NewHandler(nil, nil, service.Middleware(mux))
			response := &commitHeaderRecorder{ResponseRecorder: httptest.NewRecorder()}
			server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil))
			if response.Code != http.StatusOK || response.persistedHeaderAtCommit != "true" {
				t.Fatalf("response commit = %d, persisted header = %q; want 200 and true", response.Code, response.persistedHeaderAtCommit)
			}
			if response.trailerHeaderAtCommit != "" {
				t.Fatalf("persistence header was deferred as a trailer: %q", response.trailerHeaderAtCommit)
			}
			if response.Header().Get(PersistedHeader) != "true" || !strings.EqualFold(response.Header().Get("Content-Type"), testCase.contentType) {
				t.Fatalf("response headers = %v", response.Header())
			}
			requestID := response.Header().Get("X-Request-Id")
			record, err := service.Get(t.Context(), requestID)
			if err != nil || record.ResponseSizeBytes == nil || *record.ResponseSizeBytes != int64(len(testCase.body)) {
				t.Fatalf("durable stream size = %v, error = %v; want %d bytes", record.ResponseSizeBytes, err, len(testCase.body))
			}
		})
	}
}

type commitHeaderRecorder struct {
	*httptest.ResponseRecorder
	persistedHeaderAtCommit string
	trailerHeaderAtCommit   string
}

func (recorder *commitHeaderRecorder) WriteHeader(status int) {
	recorder.persistedHeaderAtCommit = recorder.Header().Get(PersistedHeader)
	recorder.trailerHeaderAtCommit = recorder.Header().Get("Trailer")
	recorder.ResponseRecorder.WriteHeader(status)
}

func TestSafeEndpointKeepsFileRoutesParameterised(t *testing.T) {
	cases := map[string]string{
		"/api/v1/posts": "/api/v1/{collectionName}",
		"/api/v1/posts/rec_abc": "/api/v1/{collectionName}/{recordId}",
		"/api/v1/posts/rec_abc/files/attachment": "/api/v1/{collectionName}/{recordId}/files/{fieldName}",
		"/api/v1/posts/rec_abc/files/attachments/2": "/api/v1/{collectionName}/{recordId}/files/{fieldName}/{fileIndex}",
		"/api/v1/posts/rec_abc/files/attachments/2/extra": "/api/v1/{unmatched}",
	}
	for path, want := range cases {
		if got := safeEndpoint(path); got != want {
			t.Errorf("safeEndpoint(%q) = %q, want %q", path, got, want)
		}
	}
}
