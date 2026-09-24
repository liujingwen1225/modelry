package serviceaccounts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestServiceAccountModuleAndCredentialBoundary(t *testing.T) {
	ctx := audit.WithActor(context.Background(), audit.Actor{Kind: audit.ActorOwner, ID: "own_test"})
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, audits)
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(ctx, CreateInput{
		Name: "Read only", Permission: PresetReadOnly,
	})
	if err != nil || created.APIKeyReveal == nil {
		t.Fatalf("Create returned %+v, err = %v", created, err)
	}
	module := NewModule(service)
	raw := httpapi.NewAPIRouter(module)
	ownerCalls := 0
	ownerProtected := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		ownerCalls++
		if _, ok := authorization.PrincipalFromContext(request.Context()); ok {
			t.Error("Owner fallback received a Service Account Principal")
		}
		w.WriteHeader(http.StatusAccepted)
	})
	handler := service.ServiceAccountMiddleware(ownerProtected, raw)

	request := httptest.NewRequest(http.MethodGet, "/admin/api/v1/service-accounts", nil)
	request.Header.Set("Authorization", "Bearer "+created.APIKeyReveal.Secret)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || ownerCalls != 0 {
		t.Fatalf("valid Service Account GET status=%d ownerCalls=%d body=%s", recorder.Code, ownerCalls, recorder.Body.String())
	}
	var page Page
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil || len(page.Data) != 1 || page.Data[0].ID != created.ServiceAccount.ID {
		t.Fatalf("Service Account list response = %+v, err = %v", page, err)
	}

	request = httptest.NewRequest(http.MethodPost, "/admin/api/v1/service-accounts", nil)
	request.Header.Set("Authorization", "Bearer "+created.APIKeyReveal.Secret)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || ownerCalls != 0 {
		t.Fatalf("read-only Service Account write status=%d ownerCalls=%d body=%s", recorder.Code, ownerCalls, recorder.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/admin/api/v1/service-accounts", nil)
	request.Header.Set("Authorization", "Basic invalid")
	request.AddCookie(&http.Cookie{Name: "modelry_admin_session", Value: "owner-cookie"})
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || ownerCalls != 0 {
		t.Fatalf("invalid Authorization downgraded to Owner cookie: status=%d ownerCalls=%d", recorder.Code, ownerCalls)
	}

	request = httptest.NewRequest(http.MethodGet, "/admin/api/v1/service-accounts", nil)
	request.Header.Add("Authorization", "Bearer "+created.APIKeyReveal.Secret)
	request.Header.Add("Authorization", "Bearer "+created.APIKeyReveal.Secret)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || ownerCalls != 0 {
		t.Fatalf("duplicate Authorization was accepted: status=%d ownerCalls=%d", recorder.Code, ownerCalls)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/posts", nil)
	request.Header.Set("Authorization", "Bearer "+created.APIKeyReveal.Secret)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || ownerCalls != 1 {
		t.Fatalf("Application path did not continue through the non-Service-Account boundary: status=%d ownerCalls=%d", recorder.Code, ownerCalls)
	}
}

func TestControlPlanePermissionMappingCoversOpenAPIRoutes(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   Operation
	}{
		{http.MethodGet, "/admin/api/v1/runtime/status", OperationRuntimeRead},
		{http.MethodGet, "/admin/api/v1/storage/status", OperationStorageRead},
		{http.MethodGet, "/admin/api/v1/collections", OperationCollectionsRead},
		{http.MethodPost, "/admin/api/v1/collections", OperationCollectionsCreate},
		{http.MethodGet, "/admin/api/v1/collections/col_123", OperationCollectionsRead},
		{http.MethodGet, "/admin/api/v1/collections/col_123/schema/pending-change", OperationSchemaRead},
		{http.MethodPost, "/admin/api/v1/collections/col_123/schema/pending-operations", OperationSchemaWrite},
		{http.MethodPatch, "/admin/api/v1/collections/col_123/schema/pending-operations/op_123", OperationSchemaWrite},
		{http.MethodDelete, "/admin/api/v1/collections/col_123/schema/pending-operations/op_123", OperationSchemaWrite},
		{http.MethodPost, "/admin/api/v1/collections/col_123/schema/preview", OperationSchemaWrite},
		{http.MethodPost, "/admin/api/v1/collections/col_123/schema/apply", OperationSchemaApply},
		{http.MethodPost, "/admin/api/v1/collections/col_123/schema/discard", OperationSchemaWrite},
		{http.MethodGet, "/admin/api/v1/collections/col_123/schema/history", OperationSchemaRead},
		{http.MethodGet, "/admin/api/v1/changes", OperationSchemaRead},
		{http.MethodGet, "/admin/api/v1/changes/chg_123", OperationSchemaRead},
		{http.MethodGet, "/admin/api/v1/collections/col_123/records", OperationRecordsRead},
		{http.MethodPost, "/admin/api/v1/collections/col_123/records", OperationRecordsCreate},
		{http.MethodGet, "/admin/api/v1/collections/col_123/records/rec_123", OperationRecordsRead},
		{http.MethodPatch, "/admin/api/v1/collections/col_123/records/rec_123", OperationRecordsUpdate},
		{http.MethodDelete, "/admin/api/v1/collections/col_123/records/rec_123", OperationRecordsDelete},
		{http.MethodPost, "/admin/api/v1/collections/col_123/files", OperationFilesWrite},
		{http.MethodGet, "/admin/api/v1/collections/col_123/records/rec_123/files/avatar", OperationFilesRead},
		{http.MethodGet, "/admin/api/v1/collections/col_123/access-rules", OperationAccessRulesRead},
		{http.MethodPut, "/admin/api/v1/collections/col_123/access-rules", OperationAccessRulesWrite},
		{http.MethodPost, "/admin/api/v1/collections/col_123/access-rules/apply", OperationAccessRulesApply},
		{http.MethodPost, "/admin/api/v1/collections/col_123/access-rules/discard", OperationAccessRulesWrite},
		{http.MethodGet, "/admin/api/v1/collections/col_123/authentication", OperationAuthenticationRead},
		{http.MethodPut, "/admin/api/v1/collections/col_123/authentication", OperationAuthenticationWrite},
		{http.MethodPost, "/admin/api/v1/collections/col_123/authentication/apply", OperationAuthenticationApply},
		{http.MethodPost, "/admin/api/v1/collections/col_123/authentication/discard", OperationAuthenticationWrite},
		{http.MethodGet, "/admin/api/v1/collections/col_123/users", OperationUsersRead},
		{http.MethodPost, "/admin/api/v1/collections/col_123/users", OperationUsersCreate},
		{http.MethodPut, "/admin/api/v1/collections/col_123/users/rec_123/password", OperationUsersManagePassword},
		{http.MethodGet, "/admin/api/v1/collections/col_123/users/rec_123/sessions", OperationSessionsRead},
		{http.MethodPost, "/admin/api/v1/collections/col_123/sessions/ses_123/revoke", OperationSessionsRevoke},
		{http.MethodPost, "/admin/api/v1/collections/col_123/users/rec_123/sessions/revoke-all", OperationSessionsRevoke},
		{http.MethodGet, "/admin/api/v1/service-accounts", OperationServiceAccountsRead},
		{http.MethodPost, "/admin/api/v1/service-accounts", OperationServiceAccountsManage},
		{http.MethodGet, "/admin/api/v1/service-accounts/sa_123", OperationServiceAccountsRead},
		{http.MethodPatch, "/admin/api/v1/service-accounts/sa_123", OperationServiceAccountsManage},
		{http.MethodPost, "/admin/api/v1/service-accounts/sa_123/disable", OperationServiceAccountsManage},
		{http.MethodPost, "/admin/api/v1/service-accounts/sa_123/enable", OperationServiceAccountsManage},
		{http.MethodGet, "/admin/api/v1/service-accounts/sa_123/api-keys", OperationAPIKeysRead},
		{http.MethodPost, "/admin/api/v1/service-accounts/sa_123/api-keys", OperationAPIKeysCreate},
		{http.MethodPost, "/admin/api/v1/api-keys/key_123/revoke", OperationAPIKeysRevoke},
		{http.MethodGet, "/admin/api/v1/requests", OperationRequestsRead},
		{http.MethodGet, "/admin/api/v1/requests/req_123", OperationRequestsRead},
		{http.MethodGet, "/admin/api/v1/audit", OperationAuditRead},
		{http.MethodGet, "/admin/api/v1/audit/aud_123", OperationAuditRead},
	}
	for _, test := range cases {
		got, ok := controlPlaneOperation(test.method, test.path)
		if !ok || got != test.want {
			t.Errorf("controlPlaneOperation(%s %s) = %s, %t; want %s", test.method, test.path, got, ok, test.want)
		}
	}
	for _, test := range []struct{ method, path string }{
		{http.MethodPost, "/admin/api/v1/auth/login"},
		{http.MethodGet, "/api/v1/posts"},
		{http.MethodDelete, "/admin/api/v1/service-accounts"},
	} {
		if _, ok := controlPlaneOperation(test.method, test.path); ok {
			t.Errorf("unexpected operation for %s %s", test.method, test.path)
		}
	}
}
