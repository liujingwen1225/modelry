package adminauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/liujingwen1225/modelry/internal/storage"
)

type recordingAuditSink struct {
	mu    sync.Mutex
	facts []ControlPlaneFact
}

func (sink *recordingAuditSink) AppendControlPlaneFact(_ context.Context, fact ControlPlaneFact) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	sink.facts = append(sink.facts, fact)
	return nil
}

func (sink *recordingAuditSink) AppendControlPlaneFactInTransaction(_ context.Context, _ storage.Executor, fact ControlPlaneFact) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	sink.facts = append(sink.facts, fact)
	return nil
}

func (sink *recordingAuditSink) actions() []string {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	actions := make([]string, 0, len(sink.facts))
	for _, fact := range sink.facts {
		actions = append(actions, fact.Action)
	}
	return actions
}

func bootstrapOwnerSession(t *testing.T, handler http.Handler) *http.Cookie {
	t.Helper()
	response := request(t, handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", bootstrapBody(), nil, "http://localhost")
	if response.Code != http.StatusCreated {
		t.Fatalf("bootstrap owner status = %d, body = %s", response.Code, response.Body.String())
	}
	return findOwnerCookie(t, response)
}

func decodeAdministrator(t *testing.T, response *httptest.ResponseRecorder) Administrator {
	t.Helper()
	var envelope struct {
		Data administratorDTO `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return Administrator{ID: envelope.Data.ID, Email: envelope.Data.Email, Status: AdministratorStatus(envelope.Data.Status)}
}

func TestAdministratorLifecyclePermissionEnforcementAndAudit(t *testing.T) {
	_, service, handler, _ := openTestService(t)
	sink := &recordingAuditSink{}
	service.SetAuditSink(sink)
	ownerCookie := bootstrapOwnerSession(t, handler)

	createBody := `{"email":"colleague@example.test","password":"administrator-password","permission":{"preset":"custom","customPermissionVersion":1,"customOperations":["audit.read"]}}`
	created := request(t, handler, http.MethodPost, "/admin/api/v1/administrators", createBody, ownerCookie, "http://localhost")
	if created.Code != http.StatusCreated {
		t.Fatalf("create administrator status = %d, body = %s", created.Code, created.Body.String())
	}
	administrator := decodeAdministrator(t, created)
	if administrator.ID == "" || administrator.Status != AdministratorActive {
		t.Fatalf("created administrator = %+v", administrator)
}

	duplicate := request(t, handler, http.MethodPost, "/admin/api/v1/administrators", createBody, ownerCookie, "http://localhost")
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate email status = %d, body = %s", duplicate.Code, duplicate.Body.String())
	}
	shortPassword := request(t, handler, http.MethodPost, "/admin/api/v1/administrators", `{"email":"short@example.test","password":"short","permission":{"preset":"readOnly"}}`, ownerCookie, "http://localhost")
	if shortPassword.Code != http.StatusUnprocessableEntity {
		t.Fatalf("short password status = %d, body = %s", shortPassword.Code, shortPassword.Body.String())
	}

	login := request(t, handler, http.MethodPost, "/admin/api/v1/auth/login", `{"email":"colleague@example.test","password":"administrator-password"}`, nil, "http://localhost")
	if login.Code != http.StatusOK {
		t.Fatalf("administrator login status = %d, body = %s", login.Code, login.Body.String())
	}
	var sessionPayload struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &sessionPayload); err != nil || sessionPayload.Role != "administrator" {
		t.Fatalf("administrator session payload = %s", login.Body.String())
	}
	administratorCookie := findOwnerCookie(t, login)

	allowed := request(t, handler, http.MethodGet, "/admin/api/v1/audit", "", administratorCookie, "")
	if allowed.Code == http.StatusForbidden || allowed.Code == http.StatusUnauthorized {
		t.Fatalf("audit.read Permission was denied: %d %s", allowed.Code, allowed.Body.String())
	}
	deniedRead := request(t, handler, http.MethodGet, "/admin/api/v1/collections", "", administratorCookie, "")
	assertAPIError(t, deniedRead, http.StatusForbidden, "FORBIDDEN")
	deniedOwnerOnly := request(t, handler, http.MethodGet, "/admin/api/v1/administrators", "", administratorCookie, "")
	assertAPIError(t, deniedOwnerOnly, http.StatusForbidden, "FORBIDDEN")

	disabled := request(t, handler, http.MethodPost, "/admin/api/v1/administrators/"+administrator.ID+"/disable", "", ownerCookie, "http://localhost")
	if disabled.Code != http.StatusOK {
		t.Fatalf("disable administrator status = %d, body = %s", disabled.Code, disabled.Body.String())
	}
	afterDisable := request(t, handler, http.MethodGet, "/admin/api/v1/audit", "", administratorCookie, "")
	assertAPIError(t, afterDisable, http.StatusUnauthorized, "UNAUTHENTICATED")

	reLogin := request(t, handler, http.MethodPost, "/admin/api/v1/auth/login", `{"email":"colleague@example.test","password":"administrator-password"}`, nil, "http://localhost")
	assertAPIError(t, reLogin, http.StatusUnauthorized, "UNAUTHENTICATED")

	enabled := request(t, handler, http.MethodPost, "/admin/api/v1/administrators/"+administrator.ID+"/enable", "", ownerCookie, "http://localhost")
	if enabled.Code != http.StatusOK {
		t.Fatalf("enable administrator status = %d, body = %s", enabled.Code, enabled.Body.String())
	}
	password := request(t, handler, http.MethodPost, "/admin/api/v1/administrators/"+administrator.ID+"/password", `{"password":"replacement-password"}`, ownerCookie, "http://localhost")
	if password.Code != http.StatusNoContent {
		t.Fatalf("set administrator password status = %d, body = %s", password.Code, password.Body.String())
	}
	oldLogin := request(t, handler, http.MethodPost, "/admin/api/v1/auth/login", `{"email":"colleague@example.test","password":"administrator-password"}`, nil, "http://localhost")
	assertAPIError(t, oldLogin, http.StatusUnauthorized, "UNAUTHENTICATED")
	newLogin := request(t, handler, http.MethodPost, "/admin/api/v1/auth/login", `{"email":"colleague@example.test","password":"replacement-password"}`, nil, "http://localhost")
	if newLogin.Code != http.StatusOK {
		t.Fatalf("login with replacement password status = %d, body = %s", newLogin.Code, newLogin.Body.String())
	}

	list := request(t, handler, http.MethodGet, "/admin/api/v1/administrators", "", ownerCookie, "")
	if list.Code != http.StatusOK || !json.Valid(list.Body.Bytes()) {
		t.Fatalf("list administrators = %d %s", list.Code, list.Body.String())
	}
	sessions := request(t, handler, http.MethodGet, "/admin/api/v1/administrators/"+administrator.ID+"/sessions", "", ownerCookie, "")
	if sessions.Code != http.StatusOK || !json.Valid(sessions.Body.Bytes()) {
		t.Fatalf("list administrator sessions = %d %s", sessions.Code, sessions.Body.String())
	}
	deleted := request(t, handler, http.MethodDelete, "/admin/api/v1/administrators/"+administrator.ID, "", ownerCookie, "http://localhost")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete administrator status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
	missing := request(t, handler, http.MethodGet, "/admin/api/v1/administrators/"+administrator.ID, "", ownerCookie, "")
	assertAPIError(t, missing, http.StatusNotFound, "NOT_FOUND")

	actions := sink.actions()
	for _, want := range []string{"administrator.created", "administrator.disabled", "administrator.enabled", "administrator.passwordSet", "administrator.deleted", "controlPlane.denied"} {
		found := false
		for _, action := range actions {
			if action == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("audit actions %v are missing %q", actions, want)
		}
	}
}
