package backendapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestCollectionAndSchemaHTTPFlowUsesDurableBackendModel(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := backendmodel.NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))

	created := performJSON(t, handler, http.MethodPost, "/admin/api/v1/collections", `{"name":"posts","type":"Normal","fields":[{"name":"title","type":"text","required":true}]}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create Collection = %d %s", created.Code, created.Body.String())
	}
	if created.Header().Get("X-Request-Id") == "" {
		t.Fatal("Collection response has no canonical request ID")
	}
	collectionID := decodeID(t, created.Body)
	noPendingRequest := httptest.NewRequest(http.MethodGet, "/admin/api/v1/collections/"+collectionID+"/schema/pending-change", nil)
	noPendingResponse := httptest.NewRecorder()
	handler.ServeHTTP(noPendingResponse, noPendingRequest)
	var noPending struct {
		Data *backendmodel.PendingChange `json:"data"`
	}
	if err := json.Unmarshal(noPendingResponse.Body.Bytes(), &noPending); err != nil {
		t.Fatal(err)
	}
	if noPendingResponse.Code != http.StatusOK || noPending.Data != nil {
		t.Fatalf("initial empty Pending Change = %d %#v", noPendingResponse.Code, noPending.Data)
	}

	operation := performJSON(t, handler, http.MethodPost, "/admin/api/v1/collections/"+collectionID+"/schema/pending-operations", `{"kind":"field","action":"add","definition":{"name":"subtitle","type":"text"}}`)
	if operation.Code != http.StatusCreated {
		t.Fatalf("save Pending Operation = %d %s", operation.Code, operation.Body.String())
	}
	var saved struct {
		Data backendmodel.PendingChange `json:"data"`
	}
	if err := json.Unmarshal(operation.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Data.Version != 1 || len(saved.Data.Operations) != 1 {
		t.Fatalf("saved Pending Change = %#v", saved.Data)
	}

	preview := performJSON(t, handler, http.MethodPost, "/admin/api/v1/collections/"+collectionID+"/schema/preview", `{"expectedVersion":1}`)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview Pending Change = %d %s", preview.Code, preview.Body.String())
	}
	var previewBody struct {
		Data backendmodel.SchemaPreview `json:"data"`
	}
	if err := json.Unmarshal(preview.Body.Bytes(), &previewBody); err != nil {
		t.Fatal(err)
	}
	if previewBody.Data.Risk != backendmodel.RiskSafe {
		t.Fatalf("optional Field risk = %s, want safe", previewBody.Data.Risk)
	}

	apply := performJSON(t, handler, http.MethodPost, "/admin/api/v1/collections/"+collectionID+"/schema/apply", `{"expectedVersion":1}`)
	if apply.Code != http.StatusOK {
		t.Fatalf("apply Pending Change = %d %s", apply.Code, apply.Body.String())
	}
	get := httptest.NewRequest(http.MethodGet, "/admin/api/v1/collections/"+collectionID, nil)
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	var collection struct {
		Data backendmodel.Collection `json:"data"`
	}
	if err := json.Unmarshal(getResponse.Body.Bytes(), &collection); err != nil {
		t.Fatal(err)
	}
	if getResponse.Code != http.StatusOK || collection.Data.SchemaVersion != 2 {
		t.Fatalf("applied Collection = %d %#v", getResponse.Code, collection.Data)
	}
	if got := collection.Data.Fields[len(collection.Data.Fields)-1].Name; got != "subtitle" {
		t.Fatalf("last applied Field = %q, want subtitle", got)
	}
}

func TestCollectionListRedactsRecordAndSchemaSummariesWithoutTheirPermissions(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := backendmodel.NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(t.Context(), backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveOperation(t.Context(), collection.ID, backendmodel.PendingOperationInput{
		Kind: backendmodel.OperationField, Action: backendmodel.OperationAdd,
		Definition: json.RawMessage(`{"name":"summary","type":"text"}`),
	}); err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/admin/api/v1/collections", nil))
	var envelope struct {
		Data []map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(envelope.Data) != 1 {
		t.Fatalf("list Collections = %d %s", response.Code, response.Body.String())
	}
	item := envelope.Data[0]
	if _, exists := item["recordCount"]; exists {
		t.Fatal("Collection summary exposed Record count without records.read")
	}
	if _, exists := item["pendingChangeStatus"]; exists {
		t.Fatal("Collection summary exposed Change status without schema.read")
	}
}

func TestCollectionHTTPRejectsUnsupportedBodyAndKeepsStructuredRequestID(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := backendmodel.NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))

	request := httptest.NewRequest(http.MethodPost, "/admin/api/v1/collections", bytes.NewBufferString(`{"name":"posts"}`))
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsupported Content-Type status = %d, want 415", response.Code)
	}
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "UNSUPPORTED_MEDIA_TYPE" || envelope.Error.RequestID == "" || envelope.Error.RequestID != response.Header().Get("X-Request-Id") {
		t.Fatalf("structured error did not preserve canonical request ID: %#v", envelope.Error)
	}

	badLimitRequest := httptest.NewRequest(http.MethodGet, "/admin/api/v1/collections?limit=invalid", nil)
	badLimitResponse := httptest.NewRecorder()
	handler.ServeHTTP(badLimitResponse, badLimitRequest)
	if badLimitResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status = %d, want 400: %s", badLimitResponse.Code, badLimitResponse.Body.String())
	}
}

func performJSON(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeID(t *testing.T, reader io.Reader) string {
	t.Helper()
	var envelope struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(reader).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.ID == "" {
		t.Fatal("Collection response has no ID")
	}
	return envelope.Data.ID
}
