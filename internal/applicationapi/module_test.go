package applicationapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/requests"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type testEvaluator struct {
	allowed bool
	seen    []authorization.Principal
}

func (evaluator *testEvaluator) Evaluate(_ context.Context, _ string, _ authorization.Operation, principal authorization.Principal, _ *authorization.Record) (authorization.Decision, error) {
	evaluator.seen = append(evaluator.seen, principal)
	if !evaluator.allowed {
		return authorization.Decision{Code: "POLICY_DENIED", Message: "denied"}, nil
	}
	return authorization.Decision{Allowed: true}, nil
}

type testSessions struct {
	principal authorization.Principal
	err       error
}

func (sessions testSessions) AuthenticateSession(_ context.Context, token string) (authorization.Principal, error) {
	if token != "valid-test-session" {
		return authorization.Principal{}, errors.New("invalid session")
	}
	return sessions.principal, sessions.err
}

type testStack struct {
	store      *storage.Store
	models     *backendmodel.Service
	records    *records.Service
	requests   *requests.Service
	handler    http.Handler
	evaluator  *testEvaluator
	collection backendmodel.Collection
}

func newTestStack(t *testing.T, collectionInput backendmodel.CreateCollectionInput, evaluator *testEvaluator, authenticator authorization.SessionAuthenticator, fileStorage bool) testStack {
	t.Helper()
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatalf("打开真实 SQLite：%v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("关闭 SQLite：%v", err)
		}
	})
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatalf("初始化 Backend Model：%v", err)
	}
	collection, err := models.CreateCollection(ctx, collectionInput)
	if err != nil {
		t.Fatalf("创建已应用 Collection：%v", err)
	}
	var recordOptions []records.Option
	if evaluator != nil {
		recordOptions = append(recordOptions, records.WithAuthorization(evaluator, nil))
	}
	var recordService *records.Service
	if fileStorage {
		root := t.TempDir()
		tempDir := filepath.Join(root, "tmp")
		objectsDir := filepath.Join(root, "objects")
		if err := os.Mkdir(tempDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(objectsDir, 0o700); err != nil {
			t.Fatal(err)
		}
		recordService, err = records.NewWithLocalFiles(store, models, tempDir, objectsDir, recordOptions...)
	} else {
		recordService, err = records.New(store, models, recordOptions...)
	}
	if err != nil {
		t.Fatalf("初始化 Records Service：%v", err)
	}
	requestService, err := requests.NewService(ctx, store)
	if err != nil {
		t.Fatalf("初始化 RequestRecord：%v", err)
	}
	appModule := NewModule(models, recordService, WithSessionAuthenticator(authenticator))
	router := httpapi.NewAPIRouter(appModule)
	handler := httpapi.NewHandler(nil, http.NotFoundHandler(), requestService.Middleware(router))
	return testStack{store: store, models: models, records: recordService, requests: requestService, handler: handler, evaluator: evaluator, collection: collection}
}

func TestApplicationRecordHTTPCRUDAndDurableSafeRequestRecord(t *testing.T) {
	evaluator := &testEvaluator{allowed: true}
	principal := authorization.Principal{Type: authorization.PrincipalApplication, ID: "prf_0123456789abcdef0123456789abcdef"}
	stack := newTestStack(t, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}},
	}, evaluator, testSessions{principal: principal}, false)

	createdResponse := perform(stack.handler, http.MethodPost, "/api/v1/posts", `{"values":{"title":"first"}}`, "application/json", "")
	if createdResponse.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createdResponse.Code, createdResponse.Body.String())
	}
	var createdBody struct {
		Data struct {
			ID    string         `json:"id"`
			Title string         `json:"title"`
			Extra map[string]any `json:"-"`
		} `json:"data"`
	}
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	if createdBody.Data.ID == "" || createdBody.Data.Title != "first" {
		t.Fatalf("unexpected created Record: %#v", createdBody)
	}
	requestID := createdResponse.Header().Get("X-Request-Id")
	if requestID == "" || requestID != createdResponse.Header().Get("X-Request-Id") {
		t.Fatalf("missing canonical request ID: %q", requestID)
	}
	if createdResponse.Header().Get(requests.PersistedHeader) != "true" {
		t.Fatalf("RequestRecord persistence header=%q", createdResponse.Header().Get(requests.PersistedHeader))
	}
	stored, err := stack.requests.Get(context.Background(), requestID)
	if err != nil {
		t.Fatalf("RequestRecord was not durable: %v", err)
	}
	if stored.Endpoint != "/api/v1/{collectionName}" || stored.Method != http.MethodPost || stored.Status != http.StatusCreated || stored.CollectionID != stack.collection.ID || stored.AuthenticationOutcome != requests.AuthenticationAnonymous || stored.AuthorizationOutcome != requests.AuthorizationAllowed {
		t.Fatalf("unexpected safe RequestRecord: %+v", stored)
	}
	authenticatedResponse := perform(stack.handler, http.MethodGet, "/api/v1/posts?search=first", "", "", "Bearer valid-test-session")
	if authenticatedResponse.Code != http.StatusOK {
		t.Fatalf("authenticated list status=%d body=%s", authenticatedResponse.Code, authenticatedResponse.Body.String())
	}
	authenticatedRequest, err := stack.requests.Get(context.Background(), authenticatedResponse.Header().Get("X-Request-Id"))
	if err != nil {
		t.Fatalf("authenticated RequestRecord was not durable: %v", err)
	}
	if authenticatedRequest.Endpoint != "/api/v1/{collectionName}" || authenticatedRequest.AuthenticationOutcome != requests.AuthenticationAuthenticated || strings.Contains(authenticatedRequest.Endpoint, "search") {
		t.Fatalf("RequestRecord captured query or missed auth outcome: %+v", authenticatedRequest)
	}
	encodedRequest, _ := json.Marshal(authenticatedRequest)
	if strings.Contains(string(encodedRequest), "valid-test-session") || strings.Contains(string(encodedRequest), "Authorization") {
		t.Fatalf("RequestRecord leaked a credential: %s", encodedRequest)
	}

	getResponse := perform(stack.handler, http.MethodGet, "/api/v1/posts/"+createdBody.Data.ID, "", "", "")
	if getResponse.Code != http.StatusOK || !strings.Contains(getResponse.Body.String(), `"title":"first"`) {
		t.Fatalf("get status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	patchResponse := perform(stack.handler, http.MethodPatch, "/api/v1/posts/"+createdBody.Data.ID, `{"values":{"title":"updated"}}`, "application/json", "")
	if patchResponse.Code != http.StatusOK || !strings.Contains(patchResponse.Body.String(), `"title":"updated"`) {
		t.Fatalf("patch status=%d body=%s", patchResponse.Code, patchResponse.Body.String())
	}
	listResponse := perform(stack.handler, http.MethodGet, "/api/v1/posts?sort=title+asc", "", "", "")
	if listResponse.Code != http.StatusOK || !strings.Contains(listResponse.Body.String(), `"title":"updated"`) {
		t.Fatalf("list status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}
	deleteResponse := perform(stack.handler, http.MethodDelete, "/api/v1/posts/"+createdBody.Data.ID, "", "", "")
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	if len(evaluator.seen) != 8 {
		t.Fatalf("Access Evaluator calls=%d, want 8 including List gates and row checks", len(evaluator.seen))
	}
}

func TestApplicationRecordDetailRejectsUnsupportedExpandFieldsAndQueries(t *testing.T) {
	evaluator := &testEvaluator{allowed: true}
	principal := authorization.Principal{Type: authorization.PrincipalApplication, ID: "prf_0123456789abcdef0123456789abcdef"}
	stack := newTestStack(t, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	}, evaluator, testSessions{principal: principal}, false)
	record, err := stack.records.Create(context.Background(), stack.collection.ID, map[string]any{"title": "first"})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/v1/posts/" + record.ID + "?expand=title",
		"/api/v1/posts/" + record.ID + "?expand=missing",
		"/api/v1/posts/" + record.ID + "?unsupported=true",
		"/api/v1/posts/" + record.ID + "?expand=title&expand=title",
	} {
		response := perform(stack.handler, http.MethodGet, path, "", "", "Bearer valid-test-session")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"INVALID_ARGUMENT"`) {
			t.Errorf("detail query %q status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}

func TestApplicationRejectsInvalidBearerWithoutAnonymousFallback(t *testing.T) {
	evaluator := &testEvaluator{allowed: true}
	stack := newTestStack(t, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	}, evaluator, testSessions{principal: authorization.Principal{Type: authorization.PrincipalApplication, ID: "prf_0123456789abcdef0123456789abcdef"}}, false)
	response := perform(stack.handler, http.MethodGet, "/api/v1/posts", "", "", "Bearer invalid-token")
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), `"code":"UNAUTHENTICATED"`) {
		t.Fatalf("invalid Bearer response status=%d body=%s", response.Code, response.Body.String())
	}
	if len(evaluator.seen) != 0 {
		t.Fatalf("invalid Bearer fell through to Access Rules as an anonymous request: %#v", evaluator.seen)
	}
	var apiError struct {
		Error struct {
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &apiError); err != nil {
		t.Fatal(err)
	}
	requestRecord, err := stack.requests.Get(context.Background(), apiError.Error.RequestID)
	if err != nil {
		t.Fatalf("rejected request was not durably recorded: %v", err)
	}
	if requestRecord.AuthenticationOutcome != requests.AuthenticationRejected || requestRecord.AuthorizationOutcome != requests.AuthorizationNotEvaluated {
		t.Fatalf("unexpected rejection metadata: %+v", requestRecord)
	}
	encoded, _ := json.Marshal(requestRecord)
	if strings.Contains(string(encoded), "invalid-token") || strings.Contains(string(encoded), "Authorization") {
		t.Fatalf("RequestRecord leaked credential: %s", encoded)
	}
}

func TestApplicationPolicyDenialAndMissingEvaluatorFailClosed(t *testing.T) {
	for _, test := range []struct {
		name      string
		evaluator *testEvaluator
	}{
		{name: "denied", evaluator: &testEvaluator{allowed: false}},
		{name: "evaluator unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			stack := newTestStack(t, backendmodel.CreateCollectionInput{
				Name: "posts", Type: backendmodel.CollectionTypeNormal,
				Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
			}, test.evaluator, nil, false)
			response := perform(stack.handler, http.MethodGet, "/api/v1/posts", "", "", "")
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"FORBIDDEN"`) {
				t.Fatalf("denied response status=%d body=%s", response.Code, response.Body.String())
			}
			var apiError struct {
				Error struct {
					RequestID string `json:"requestId"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &apiError); err != nil {
				t.Fatal(err)
			}
			stored, err := stack.requests.Get(context.Background(), apiError.Error.RequestID)
			if err != nil || stored.AuthorizationOutcome != requests.AuthorizationDenied {
				t.Fatalf("denied request record=%+v err=%v", stored, err)
			}
		})
	}
}

func TestWriteErrorExplainsDurableEventSizeLimit(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/posts", nil)

	writeError(response, request, recordevents.ErrEventTooLarge)

	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if response.Code != http.StatusRequestEntityTooLarge || json.Unmarshal(response.Body.Bytes(), &envelope) != nil {
		t.Fatalf("oversized Event response = %d %s", response.Code, response.Body.String())
	}
	if envelope.Error.Code != "PAYLOAD_TOO_LARGE" || !strings.Contains(envelope.Error.Message, "1 MiB") || !strings.Contains(envelope.Error.Message, "retry") {
		t.Fatalf("oversized Event error was not actionable: %+v", envelope.Error)
	}
}

func TestApplicationFileReadRequiresViewAndUsesSafeDownloadHeaders(t *testing.T) {
	evaluator := &testEvaluator{allowed: true}
	stack := newTestStack(t, backendmodel.CreateCollectionInput{
		Name: "documents", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "file", Type: backendmodel.FieldTypeFile}},
	}, evaluator, nil, true)
	temporary, err := stack.records.UploadFile(context.Background(), stack.collection.ID, "file", strings.NewReader("private report"), records.FilePolicy{MaxBytes: 1024, AllowedMIMETypes: []string{"text/plain"}})
	if err != nil {
		t.Fatalf("stage local file: %v", err)
	}
	created, err := stack.records.CreateApplication(context.Background(), stack.collection.ID, map[string]any{"file": temporary.TemporaryID}, authorization.Principal{Type: authorization.PrincipalAnonymous})
	if err != nil {
		t.Fatalf("create File Record: %v", err)
	}
	server := httptest.NewServer(stack.handler)
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/api/v1/documents/" + created.ID + "/files/file")
	if err != nil {
		t.Fatalf("HTTP file request: %v", err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK || string(body) != "private report" {
		t.Fatalf("file response status=%d body=%q error=%v", response.StatusCode, body, readErr)
	}
	if response.Header.Get("Content-Type") != "text/plain" || response.Header.Get("Content-Disposition") != "attachment" || response.Header.Get("Cache-Control") != "private, no-store" || response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Content-Length") != "14" {
		t.Fatalf("unsafe file headers: %#v", response.Header)
	}
	if response.Header.Get(requests.PersistedHeader) != "true" || response.Header.Get("Trailer") != "" {
		t.Fatalf("file RequestRecord must be a normal response header: %#v", response.Header)
	}
	stored, err := stack.requests.Get(context.Background(), response.Header.Get("X-Request-Id"))
	if err != nil || stored.ResponseSizeBytes == nil || *stored.ResponseSizeBytes != int64(len(body)) {
		t.Fatalf("durable file response size = %v, error = %v; want %d bytes", stored.ResponseSizeBytes, err, len(body))
	}

	evaluator.allowed = false
	denied := perform(stack.handler, http.MethodGet, "/api/v1/documents/"+created.ID+"/files/file", "", "", "")
	if denied.Code != http.StatusForbidden || strings.Contains(denied.Body.String(), "private report") {
		t.Fatalf("View denial exposed file: status=%d body=%q", denied.Code, denied.Body.String())
	}
}

func perform(handler http.Handler, method, path, body, contentType, authorizationHeader string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if authorizationHeader != "" {
		request.Header.Set("Authorization", authorizationHeader)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
