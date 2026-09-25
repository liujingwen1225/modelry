package runtime

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/project"
)

// TestRuntimeOperationsSurfacesAndPermissionBoundaries 在真实 Runtime 上验证 Runtime Settings、Activity、
// Drift 与 Policy Simulation 的路由、权限边界与 fail closed 语义。
func TestRuntimeOperationsSurfacesAndPermissionBoundaries(t *testing.T) {
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

	settings := getResponseWithCookie(t, baseURL+"/admin/api/v1/settings", "", ownerCookie)
	if settings.status != http.StatusOK || !strings.Contains(string(settings.body), `"source":"default"`) || !strings.Contains(string(settings.body), `"requestRetentionDays"`) {
		t.Fatalf("Runtime Settings read status=%d body=%s", settings.status, settings.body)
	}
	savedSettings := sendJSONRequest(t, http.MethodPut, baseURL+"/admin/api/v1/settings", baseURL, ownerCookie, "", `{"expectedRevision":1,"listenAddress":"127.0.0.1:8081","requestRetentionDays":14}`)
	if savedSettings.status != http.StatusOK || !strings.Contains(string(savedSettings.body), `"revision":2`) || !strings.Contains(string(savedSettings.body), `"restartRequired":true`) {
		t.Fatalf("Runtime Settings save status=%d body=%s", savedSettings.status, savedSettings.body)
	}
	invalidSettings := sendJSONRequest(t, http.MethodPut, baseURL+"/admin/api/v1/settings", baseURL, ownerCookie, "", `{"expectedRevision":2,"listenAddress":"not-a-host-port","requestRetentionDays":14}`)
	if invalidSettings.status != http.StatusUnprocessableEntity || !strings.Contains(string(invalidSettings.body), "VALIDATION_FAILED") {
		t.Fatalf("invalid Runtime Settings status=%d body=%s", invalidSettings.status, invalidSettings.body)
	}

	activity := getResponseWithCookie(t, baseURL+"/admin/api/v1/activity?limit=10", "", ownerCookie)
	if activity.status != http.StatusOK || !strings.Contains(string(activity.body), `"data":[]`) {
		t.Fatalf("Activity read status=%d body=%s", activity.status, activity.body)
	}
	badActivity := getResponseWithCookie(t, baseURL+"/admin/api/v1/activity?kinds=debug.log", "", ownerCookie)
	if badActivity.status != http.StatusBadRequest || !strings.Contains(string(badActivity.body), "INVALID_ARGUMENT") {
		t.Fatalf("invalid Activity kind status=%d body=%s", badActivity.status, badActivity.body)
	}

	drift := getResponseWithCookie(t, baseURL+"/admin/api/v1/drift", "", ownerCookie)
	if drift.status != http.StatusOK || !strings.Contains(string(drift.body), `"state":"healthy"`) {
		t.Fatalf("Drift read status=%d body=%s", drift.status, drift.body)
	}
	reconcile := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/drift/reconcile", baseURL, ownerCookie, "", `{"collectionId":"`+collection.Data.ID+`"}`)
	if reconcile.status != http.StatusOK || !strings.Contains(string(reconcile.body), `"state":"healthy"`) {
		t.Fatalf("Drift reconcile status=%d body=%s", reconcile.status, reconcile.body)
	}

	simulation := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/access-rules/simulate", baseURL, ownerCookie, "",
		`{"operation":"list","principal":{"kind":"anonymous"},"record":{"payload":{"title":"hello"}}}`)
	if simulation.status != http.StatusOK || !strings.Contains(string(simulation.body), `"allowed":false`) || !strings.Contains(string(simulation.body), `"authoritative":false`) || !strings.Contains(string(simulation.body), "not authoritative") {
		t.Fatalf("Policy Simulation status=%d body=%s", simulation.status, simulation.body)
	}
	unknownOperation := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/access-rules/simulate", baseURL, ownerCookie, "",
		`{"operation":"purge","principal":{"kind":"anonymous"}}`)
	if unknownOperation.status != http.StatusBadRequest {
		t.Fatalf("unknown simulation operation status=%d body=%s", unknownOperation.status, unknownOperation.body)
	}

	// Read-only Administrator 可以读取运维面并模拟，但不能写入 Settings 或修复投影。
	administrator := postJSONWithCookie(t, baseURL+"/admin/api/v1/administrators", ownerCookie,
		`{"email":"operator@example.test","password":"operator-password-42","permission":{"preset":"readOnly"}}`)
	if administrator.status != http.StatusCreated {
		t.Fatalf("create read-only Administrator status=%d body=%s", administrator.status, administrator.body)
	}
	login := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/auth/login", baseURL, "", "", `{"email":"operator@example.test","password":"operator-password-42"}`)
	if login.status != http.StatusOK {
		t.Fatalf("read-only Administrator login status=%d body=%s", login.status, login.body)
	}
	administratorCookie := sessionCookieFromEvidence(t, login)

	allowed := []string{"/admin/api/v1/settings", "/admin/api/v1/activity", "/admin/api/v1/drift"}
	for _, path := range allowed {
		response := getResponseWithCookie(t, baseURL+path, "", administratorCookie)
		if response.status != http.StatusOK {
			t.Fatalf("read-only Administrator GET %s status=%d body=%s", path, response.status, response.body)
		}
	}
	deniedSettings := sendJSONRequest(t, http.MethodPut, baseURL+"/admin/api/v1/settings", baseURL, administratorCookie, "", `{"expectedRevision":2,"listenAddress":"127.0.0.1:8082","requestRetentionDays":14}`)
	if deniedSettings.status != http.StatusForbidden {
		t.Fatalf("read-only Administrator settings write status=%d body=%s", deniedSettings.status, deniedSettings.body)
	}
	deniedReconcile := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/drift/reconcile", baseURL, administratorCookie, "", `{"collectionId":"`+collection.Data.ID+`"}`)
	if deniedReconcile.status != http.StatusForbidden {
		t.Fatalf("read-only Administrator reconcile status=%d body=%s", deniedReconcile.status, deniedReconcile.body)
	}
	allowedSimulation := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/access-rules/simulate", baseURL, administratorCookie, "",
		`{"operation":"list","principal":{"kind":"anonymous"}}`)
	if allowedSimulation.status != http.StatusOK {
		t.Fatalf("read-only Administrator simulation status=%d body=%s", allowedSimulation.status, allowedSimulation.body)
	}
}

func sessionCookieFromEvidence(t *testing.T, evidence responseEvidence) string {
	t.Helper()
	for _, cookie := range evidence.headers.Values("Set-Cookie") {
		if strings.HasPrefix(cookie, "modelry_admin_session=") {
			return strings.SplitN(cookie, ";", 2)[0]
		}
	}
	t.Fatal("Control Plane login did not set the session cookie")
	return ""
}