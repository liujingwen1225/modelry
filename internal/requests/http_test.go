package requests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestRequestHistoryHTTPListDetailAndErrorsUseSharedEnvelope(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	for index, requestID := range []string{"req_aaaaaaaa", "req_bbbbbbbb"} {
		if err := service.Append(t.Context(), RequestRecord{
			RequestID: requestID, Time: time.Date(2026, 9, 24, 0, index, 0, 0, time.UTC),
			CollectionID: "col_posts", Endpoint: "/api/v1/posts", Method: "GET", Status: http.StatusOK,
			DurationMS: int64(index + 1), AuthenticationOutcome: AuthenticationAnonymous,
			AuthorizationOutcome: AuthorizationAllowed,
		}); err != nil {
			t.Fatal(err)
		}
	}
	server := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))

	list := httptest.NewRecorder()
	server.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/admin/api/v1/requests?limit=1", nil))
	var page struct {
		Data       []RequestRecord `json:"data"`
		NextCursor string          `json:"nextCursor"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if list.Code != http.StatusOK || len(page.Data) != 1 || page.Data[0].RequestID != "req_bbbbbbbb" || page.NextCursor == "" {
		t.Fatalf("Requests list = %d %+v", list.Code, page)
	}

	detail := httptest.NewRecorder()
	server.ServeHTTP(detail, httptest.NewRequest(http.MethodGet, "/admin/api/v1/requests/req_bbbbbbbb", nil))
	var response struct {
		Data RequestRecord `json:"data"`
	}
	if err := json.Unmarshal(detail.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if detail.Code != http.StatusOK || response.Data.RequestID != "req_bbbbbbbb" {
		t.Fatalf("Request Detail = %d %+v", detail.Code, response.Data)
	}

	badQuery := httptest.NewRecorder()
	server.ServeHTTP(badQuery, httptest.NewRequest(http.MethodGet, "/admin/api/v1/requests?limit=not-a-number", nil))
	var errorBody struct {
		Error httpapi.APIError `json:"error"`
	}
	if err := json.Unmarshal(badQuery.Body.Bytes(), &errorBody); err != nil {
		t.Fatal(err)
	}
	if badQuery.Code != http.StatusBadRequest || errorBody.Error.Code != "INVALID_ARGUMENT" ||
		errorBody.Error.RequestID == "" || errorBody.Error.RequestID != badQuery.Header().Get("X-Request-Id") {
		t.Fatalf("Request History error envelope = %d %+v", badQuery.Code, errorBody.Error)
	}
}
