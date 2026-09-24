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
	for _, directory := range []string{instance.root.TempFiles, instance.root.Objects} {
		if err := os.Remove(directory); err != nil {
			t.Fatal(err)
		}
		degradedStorage := getResponse(t, baseURL+"/admin/api/v1/storage/status", "")
		if degradedStorage.status != http.StatusOK || !strings.Contains(string(degradedStorage.body), `"state":"unavailable"`) {
			t.Fatalf("Local Storage failure at %q was not visible over HTTP: status=%d body=%s", directory, degradedStorage.status, degradedStorage.body)
		}
		degradedRuntime := getResponse(t, baseURL+"/admin/api/v1/runtime/status", "")
		if !strings.Contains(string(degradedRuntime.body), `"state":"degraded"`) {
			t.Fatalf("Runtime did not revoke READY when Local Storage path %q became unavailable: %s", directory, degradedRuntime.body)
		}
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		recoveredRuntime := getResponse(t, baseURL+"/admin/api/v1/runtime/status", "")
		if !strings.Contains(string(recoveredRuntime.body), `"state":"ready"`) {
			t.Fatalf("Runtime did not recover readiness when Local Storage path %q became available: %s", directory, recoveredRuntime.body)
		}
	}

	unauthenticated := getResponse(t, baseURL+"/admin/api/v1/not-implemented", "")
	if unauthenticated.status != http.StatusUnauthorized {
		t.Fatalf("unimplemented Admin API route without an Owner session = %d, want 401: %s", unauthenticated.status, unauthenticated.body)
	}
	ownerCookie := bootstrapOwner(t, baseURL)
	ownerStorage := getResponseWithCookie(t, baseURL+"/admin/api/v1/storage/status", "", ownerCookie)
	var ownerStorageResponse struct {
		LocalStorage struct {
			Path string `json:"path"`
		} `json:"localStorage"`
	}
	if err := json.Unmarshal(ownerStorage.body, &ownerStorageResponse); err != nil {
		t.Fatal(err)
	}
	if ownerStorage.status != http.StatusOK || ownerStorageResponse.LocalStorage.Path != instance.root.Files {
		t.Fatalf("verified Owner storage status did not include the Local Storage path: status=%d body=%s", ownerStorage.status, ownerStorage.body)
	}
	createdCollection := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections", ownerCookie, `{"name":"notes","type":"Normal","fields":[{"name":"title","type":"text","required":true}]}`)
	if createdCollection.status != http.StatusCreated {
		t.Fatalf("Admin could not create a Normal Collection through the real Runtime: status=%d body=%s", createdCollection.status, createdCollection.body)
	}
	var collectionResponse struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(createdCollection.body, &collectionResponse); err != nil {
		t.Fatal(err)
	}
	accessRulesResponse := getResponseWithCookie(t, baseURL+"/admin/api/v1/collections/"+collectionResponse.Data.ID+"/access-rules", "", ownerCookie)
	var rulesState struct {
		Data struct {
			Applied []struct {
				Mode string `json:"mode"`
			} `json:"applied"`
			Version int `json:"version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(accessRulesResponse.body, &rulesState); err != nil {
		t.Fatal(err)
	}
	if accessRulesResponse.status != http.StatusOK || len(rulesState.Data.Applied) != 5 || rulesState.Data.Version != 1 {
		t.Fatalf("new Collection did not receive its durable fail-closed Access Rules: status=%d body=%s", accessRulesResponse.status, accessRulesResponse.body)
	}
	for _, rule := range rulesState.Data.Applied {
		if rule.Mode != "noAccess" {
			t.Fatalf("new Collection Access Rule default = %q, want noAccess", rule.Mode)
		}
	}
	errorResponse := getResponseWithCookie(t, baseURL+"/admin/api/v1/not-implemented", "req_forged-client-id", ownerCookie)
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

func TestRuntimeAuthHTTPAndApplicationSessionSurviveRestart(t *testing.T) {
	rootPath := t.TempDir()
	rootConfig := project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}
	instance, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("cannot initialize project root: %v", err)
	}
	projectID := instance.ProjectID()
	baseURL, cancel, runResult := startRuntime(t, instance)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			cancel()
			<-runResult
		}
	})
	ownerCookie := bootstrapOwner(t, baseURL)

	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections", ownerCookie, `{"name":"members","type":"Auth","fields":[{"name":"displayName","type":"text","required":true}],"authentication":{"emailPasswordEnabled":true,"selfRegistration":false,"sessionDurationDays":7}}`)
	if created.status != http.StatusCreated {
		t.Fatalf("Runtime could not create an Auth Collection with Authentication defaults: status=%d body=%s", created.status, created.body)
	}
	var collection struct {
		Data struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.body, &collection); err != nil {
		t.Fatal(err)
	}
	configurationResponse := getResponseWithCookie(t, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/authentication", "", ownerCookie)
	var configuration struct {
		Data struct {
			Applied struct {
				SelfRegistration bool `json:"selfRegistration"`
			} `json:"applied"`
			Version int `json:"version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(configurationResponse.body, &configuration); err != nil {
		t.Fatal(err)
	}
	if configurationResponse.status != http.StatusOK || configuration.Data.Version != 1 || configuration.Data.Applied.SelfRegistration {
		t.Fatalf("new Auth Collection did not expose its durable initial Authentication Configuration: status=%d body=%s", configurationResponse.status, configurationResponse.body)
	}

	const appPassword = "App-User-Password-42"
	createdUser := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/users", baseURL, ownerCookie, "", `{"profile":{"email":"alice@example.com","displayName":"Alice"},"password":"`+appPassword+`"}`)
	if createdUser.status != http.StatusCreated || strings.Contains(string(createdUser.body), appPassword) {
		t.Fatalf("Runtime did not atomically create a safe App User response: status=%d body=%s", createdUser.status, createdUser.body)
	}
	users := getResponseWithCookie(t, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/users?limit=50", "", ownerCookie)
	if users.status != http.StatusOK || strings.Contains(string(users.body), appPassword) {
		t.Fatalf("App User list was unavailable or exposed a Password Credential: status=%d body=%s", users.status, users.body)
	}
	genericWrite := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections/"+collection.Data.ID+"/records", baseURL, ownerCookie, "", `{"values":{"email":"bypass@example.com","displayName":"Bypass"}}`)
	if genericWrite.status != http.StatusForbidden || !strings.Contains(string(genericWrite.body), "AUTH_COLLECTION_WRITE_REQUIRES_AUTH_API") {
		t.Fatalf("generic Record API bypassed the atomic Auth User workflow: status=%d body=%s", genericWrite.status, genericWrite.body)
	}

	login := sendJSONRequest(t, http.MethodPost, baseURL+"/api/v1/auth/members/login", baseURL, "", "", `{"email":"ALICE@example.com","password":"`+appPassword+`"}`)
	if login.status != http.StatusOK || login.headers.Get("Cache-Control") != "no-store" {
		t.Fatalf("Application Login was unavailable or cacheable: status=%d cache-control=%q body=%s", login.status, login.headers.Get("Cache-Control"), login.body)
	}
	if login.headers.Get("X-Request-Record-Persisted") != "true" || login.requestID == "" {
		t.Fatalf("Application Login did not confirm durable RequestRecord storage: requestId=%q persisted=%q", login.requestID, login.headers.Get("X-Request-Record-Persisted"))
	}
	var loginResult struct {
		AccessToken string `json:"accessToken"`
		Session     struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	if err := json.Unmarshal(login.body, &loginResult); err != nil {
		t.Fatal(err)
	}
	if loginResult.AccessToken == "" || loginResult.Session.ID == "" {
		t.Fatalf("Application Login did not return one-time session material: %s", login.body)
	}
	loginRequestDetail := getResponseWithCookie(t, baseURL+"/admin/api/v1/requests/"+login.requestID, "", ownerCookie)
	if loginRequestDetail.status != http.StatusOK || !strings.Contains(string(loginRequestDetail.body), `"requestId":"`+login.requestID+`"`) ||
		!strings.Contains(string(loginRequestDetail.body), `"endpoint":"/api/v1/auth/members/login"`) ||
		!strings.Contains(string(loginRequestDetail.body), `"authenticationOutcome":"authenticated"`) {
		t.Fatalf("Request Detail did not reflect the canonical durable Application Login: status=%d body=%s", loginRequestDetail.status, loginRequestDetail.body)
	}
	if strings.Contains(string(loginRequestDetail.body), appPassword) || strings.Contains(string(loginRequestDetail.body), loginResult.AccessToken) {
		t.Fatalf("Application credential material leaked into Request Detail: %s", loginRequestDetail.body)
	}
	activeSession := sendRequest(t, http.MethodGet, baseURL+"/api/v1/auth/members/session", "", "Bearer "+loginResult.AccessToken, "")
	if activeSession.status != http.StatusOK {
		t.Fatalf("new Application Session was not accepted: status=%d body=%s", activeSession.status, activeSession.body)
	}
	if activeSession.headers.Get("X-Request-Record-Persisted") != "true" {
		t.Fatalf("Application Session check did not confirm durable RequestRecord storage: %q", activeSession.headers.Get("X-Request-Record-Persisted"))
	}

	cancel()
	stopErr := <-runResult
	stopped = true
	if stopErr != nil {
		t.Fatalf("Runtime did not stop cleanly: %v", stopErr)
	}

	restarted, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("Runtime could not restart: %v", err)
	}
	if restarted.ProjectID() != projectID {
		t.Fatalf("restart changed Project ID from %q to %q", projectID, restarted.ProjectID())
	}
	restartedURL, stopRestart, restartedResult := startRuntime(t, restarted)
	restartedStopped := false
	t.Cleanup(func() {
		if !restartedStopped {
			stopRestart()
			<-restartedResult
		}
	})
	restoredConfiguration := getResponseWithCookie(t, restartedURL+"/admin/api/v1/collections/"+collection.Data.ID+"/authentication", "", ownerCookie)
	if restoredConfiguration.status != http.StatusOK || !strings.Contains(string(restoredConfiguration.body), `"selfRegistration":false`) {
		t.Fatalf("Auth Configuration did not survive Runtime restart: status=%d body=%s", restoredConfiguration.status, restoredConfiguration.body)
	}
	validSession := sendRequest(t, http.MethodGet, restartedURL+"/api/v1/auth/members/session", "", "Bearer "+loginResult.AccessToken, "")
	if validSession.status != http.StatusOK {
		t.Fatalf("Application Session did not survive Runtime restart: status=%d body=%s", validSession.status, validSession.body)
	}
	restoredLoginRequest := getResponseWithCookie(t, restartedURL+"/admin/api/v1/requests/"+login.requestID, "", ownerCookie)
	if restoredLoginRequest.status != http.StatusOK || !strings.Contains(string(restoredLoginRequest.body), login.requestID) {
		t.Fatalf("Application RequestRecord did not survive Runtime restart: status=%d body=%s", restoredLoginRequest.status, restoredLoginRequest.body)
	}

	stopRestart()
	restartedStopErr := <-restartedResult
	restartedStopped = true
	if restartedStopErr != nil {
		t.Fatalf("restarted Runtime did not stop cleanly: %v", restartedStopErr)
	}
}

func TestRuntimeServiceAccountPermissionRevocationAndAuditSurviveRestart(t *testing.T) {
	rootPath := t.TempDir()
	rootConfig := project.RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()}
	instance, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("cannot initialize project root: %v", err)
	}
	projectID := instance.ProjectID()
	baseURL, cancel, runResult := startRuntime(t, instance)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			cancel()
			<-runResult
		}
	})
	ownerCookie := bootstrapOwner(t, baseURL)

	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/service-accounts", ownerCookie,
		`{"name":"ci-readonly","permission":"readOnly"}`)
	if created.status != http.StatusCreated {
		t.Fatalf("Owner could not create a Read only Service Account and API Key: status=%d body=%s", created.status, created.body)
	}
	var createResponse struct {
		Data struct {
			ServiceAccount struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"serviceAccount"`
			APIKeyReveal struct {
				APIKey struct {
					ID     string `json:"id"`
					Status string `json:"status"`
				} `json:"apiKey"`
				Secret       string `json:"secret"`
				RevealedOnce bool   `json:"revealedOnce"`
			} `json:"apiKeyReveal"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created.body, &createResponse); err != nil {
		t.Fatal(err)
	}
	accountID, keyID, secret := createResponse.Data.ServiceAccount.ID, createResponse.Data.APIKeyReveal.APIKey.ID, createResponse.Data.APIKeyReveal.Secret
	if accountID == "" || keyID == "" || secret == "" || !createResponse.Data.APIKeyReveal.RevealedOnce || createResponse.Data.ServiceAccount.Status != "active" {
		t.Fatalf("Service Account creation did not include one active, one-time API Key reveal: %s", created.body)
	}
	if strings.Contains(string(created.body), `"token"`) || !strings.Contains(string(created.body), secret) {
		t.Fatalf("API Key secret was not limited to the one-time reveal response: %s", created.body)
	}

	list := sendRequest(t, http.MethodGet, baseURL+"/admin/api/v1/collections?limit=10", "", "Bearer "+secret, "")
	if list.status != http.StatusOK || strings.Contains(string(list.body), secret) {
		t.Fatalf("Read only key could not read Collections or the response exposed the key: status=%d body=%s", list.status, list.body)
	}
	storageStatus := sendRequest(t, http.MethodGet, baseURL+"/admin/api/v1/storage/status", "", "Bearer "+secret, "")
	var storageStatusResponse struct {
		LocalStorage struct {
			Path string `json:"path"`
		} `json:"localStorage"`
	}
	if err := json.Unmarshal(storageStatus.body, &storageStatusResponse); err != nil {
		t.Fatal(err)
	}
	if storageStatus.status != http.StatusOK || storageStatusResponse.LocalStorage.Path != instance.root.Files {
		t.Fatalf("storage.read did not reveal the configured Local Storage path: status=%d body=%s", storageStatus.status, storageStatus.body)
	}
	runtimeStatus := sendRequest(t, http.MethodGet, baseURL+"/admin/api/v1/runtime/status", "", "Bearer "+secret, "")
	if runtimeStatus.status != http.StatusOK {
		t.Fatalf("runtime.read was denied to a Read only key: status=%d body=%s", runtimeStatus.status, runtimeStatus.body)
	}
	deniedWrite := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/service-accounts", baseURL, "", "Bearer "+secret,
		`{"name":"forbidden","permission":"readOnly","createAPIKey":false}`)
	if deniedWrite.status != http.StatusForbidden || !strings.Contains(string(deniedWrite.body), `"code":"FORBIDDEN"`) {
		t.Fatalf("Read only key was not denied a Service Account mutation: status=%d body=%s", deniedWrite.status, deniedWrite.body)
	}
	applicationUse := sendRequest(t, http.MethodGet, baseURL+"/api/v1/auth/members/session", "", "Bearer "+secret, "")
	if applicationUse.status != http.StatusUnauthorized {
		t.Fatalf("Control Plane API Key was accepted as an Application Session: status=%d body=%s", applicationUse.status, applicationUse.body)
	}

	disabled := sendRequest(t, http.MethodPost, baseURL+"/admin/api/v1/service-accounts/"+accountID+"/disable", ownerCookie, "", "", baseURL)
	if disabled.status != http.StatusNoContent {
		t.Fatalf("Owner could not disable the Service Account: status=%d body=%s", disabled.status, disabled.body)
	}
	if got := sendRequest(t, http.MethodGet, baseURL+"/admin/api/v1/collections", "", "Bearer "+secret, "").status; got != http.StatusUnauthorized {
		t.Fatalf("disabled Service Account key remained valid: status=%d", got)
	}
	enabled := sendRequest(t, http.MethodPost, baseURL+"/admin/api/v1/service-accounts/"+accountID+"/enable", ownerCookie, "", "", baseURL)
	if enabled.status != http.StatusNoContent {
		t.Fatalf("Owner could not re-enable the Service Account: status=%d body=%s", enabled.status, enabled.body)
	}
	if got := sendRequest(t, http.MethodGet, baseURL+"/admin/api/v1/collections", "", "Bearer "+secret, "").status; got != http.StatusOK {
		t.Fatalf("re-enabled Service Account key was not accepted: status=%d", got)
	}
	revoked := sendRequest(t, http.MethodPost, baseURL+"/admin/api/v1/api-keys/"+keyID+"/revoke", ownerCookie, "", "", baseURL)
	if revoked.status != http.StatusNoContent {
		t.Fatalf("Owner could not revoke the API Key: status=%d body=%s", revoked.status, revoked.body)
	}
	if got := sendRequest(t, http.MethodGet, baseURL+"/admin/api/v1/collections", "", "Bearer "+secret, "").status; got != http.StatusUnauthorized {
		t.Fatalf("revoked API Key remained valid: status=%d", got)
	}
	keys := getResponseWithCookie(t, baseURL+"/admin/api/v1/service-accounts/"+accountID+"/api-keys", "", ownerCookie)
	if keys.status != http.StatusOK || !strings.Contains(string(keys.body), `"status":"revoked"`) || strings.Contains(string(keys.body), secret) {
		t.Fatalf("API Key metadata did not show a safe durable revoked state: status=%d body=%s", keys.status, keys.body)
	}
	auditBeforeRestart := getResponseWithCookie(t, baseURL+"/admin/api/v1/audit?limit=100", "", ownerCookie)
	if auditBeforeRestart.status != http.StatusOK || !strings.Contains(string(auditBeforeRestart.body), "serviceAccount.created") ||
		!strings.Contains(string(auditBeforeRestart.body), "apiKey.created") || !strings.Contains(string(auditBeforeRestart.body), "serviceAccount.disabled") ||
		!strings.Contains(string(auditBeforeRestart.body), "serviceAccount.enabled") || !strings.Contains(string(auditBeforeRestart.body), "apiKey.revoked") ||
		strings.Contains(string(auditBeforeRestart.body), secret) {
		t.Fatalf("Security Audit did not capture safe durable lifecycle events: status=%d body=%s", auditBeforeRestart.status, auditBeforeRestart.body)
	}

	cancel()
	if err := <-runResult; err != nil {
		t.Fatalf("Runtime did not stop cleanly: %v", err)
	}
	stopped = true

	restarted, err := New(Options{ProjectRoot: rootConfig, Version: "test"})
	if err != nil {
		t.Fatalf("Runtime could not restart: %v", err)
	}
	if restarted.ProjectID() != projectID {
		t.Fatalf("restart changed Project ID from %q to %q", projectID, restarted.ProjectID())
	}
	restartedURL, stopRestart, restartedResult := startRuntime(t, restarted)
	restartedStopped := false
	t.Cleanup(func() {
		if !restartedStopped {
			stopRestart()
			<-restartedResult
		}
	})
	if got := sendRequest(t, http.MethodGet, restartedURL+"/admin/api/v1/collections", "", "Bearer "+secret, "").status; got != http.StatusUnauthorized {
		t.Fatalf("revoked API Key became valid after restart: status=%d", got)
	}
	restoredAccount := getResponseWithCookie(t, restartedURL+"/admin/api/v1/service-accounts/"+accountID, "", ownerCookie)
	if restoredAccount.status != http.StatusOK || !strings.Contains(string(restoredAccount.body), `"permission":"readOnly"`) || strings.Contains(string(restoredAccount.body), secret) {
		t.Fatalf("Service Account Permission did not survive restart without exposing the key: status=%d body=%s", restoredAccount.status, restoredAccount.body)
	}
	auditAfterRestart := getResponseWithCookie(t, restartedURL+"/admin/api/v1/audit?limit=100", "", ownerCookie)
	if auditAfterRestart.status != http.StatusOK || !strings.Contains(string(auditAfterRestart.body), "apiKey.revoked") || strings.Contains(string(auditAfterRestart.body), secret) {
		t.Fatalf("Audit history did not survive restart safely: status=%d body=%s", auditAfterRestart.status, auditAfterRestart.body)
	}
	stopRestart()
	if err := <-restartedResult; err != nil {
		t.Fatalf("restarted Runtime did not stop cleanly: %v", err)
	}
	restartedStopped = true
}

type responseEvidence struct {
	status    int
	body      []byte
	requestID string
	headers   http.Header
}

func getResponse(t *testing.T, target, suppliedRequestID string) responseEvidence {
	return getResponseWithCookie(t, target, suppliedRequestID, "")
}

func getResponseWithCookie(t *testing.T, target, suppliedRequestID, cookie string) responseEvidence {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	if suppliedRequestID != "" {
		request.Header.Set("X-Request-Id", suppliedRequestID)
	}
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
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
	return responseEvidence{status: response.StatusCode, body: body, requestID: response.Header.Get("X-Request-Id"), headers: response.Header}
}

func postJSONWithCookie(t *testing.T, target, cookie, body string) responseEvidence {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, target, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", target[:strings.Index(target, "/admin/api")])
	request.Header.Set("Cookie", cookie)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return responseEvidence{status: response.StatusCode, body: responseBody, requestID: response.Header.Get("X-Request-Id"), headers: response.Header}
}

func sendJSONRequest(t *testing.T, method, target, origin, cookie, authorization, body string) responseEvidence {
	t.Helper()
	return sendRequest(t, method, target, cookie, authorization, body, origin)
}

func sendRequest(t *testing.T, method, target, cookie, authorization, body string, origin ...string) responseEvidence {
	t.Helper()
	var requestBody io.Reader
	if body != "" {
		requestBody = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, target, requestBody)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if len(origin) > 0 && origin[0] != "" {
		request.Header.Set("Origin", origin[0])
	}
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return responseEvidence{status: response.StatusCode, body: responseBody, requestID: response.Header.Get("X-Request-Id"), headers: response.Header}
}

func bootstrapOwner(t *testing.T, baseURL string) string {
	t.Helper()
	target := baseURL + "/admin/api/v1/bootstrap/owner"
	request, err := http.NewRequest(http.MethodPost, target, strings.NewReader(`{"email":"owner@example.com","password":"Sufficient-Owner-Password-42"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", baseURL)
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("first Owner bootstrap = %d %s", response.StatusCode, body)
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == "modelry_admin_session" && cookie.Value != "" && cookie.HttpOnly && cookie.SameSite == http.SameSiteStrictMode {
			return cookie.Name + "=" + cookie.Value
		}
	}
	t.Fatal("first Owner bootstrap did not return the protected session cookie")
	return ""
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
