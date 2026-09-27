package appauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/requests"
)

func TestAuthHTTPConfigurationAndSessionFlowsUseStructuredContracts(t *testing.T) {
	ctx := context.Background()
	store := openAuthStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Members", Type: backendmodel.CollectionTypeAuth,
		Fields: []backendmodel.Field{{Name: "displayName", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models, profiles)
	if err != nil {
		t.Fatal(err)
	}
	server := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))
	doRequest := func(method, path, body, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	authPath := "/admin/api/v1/collections/" + collection.ID + "/authentication"
	response := doRequest(http.MethodGet, authPath, "", "")
	var stateResponse dataResponse[AuthConfigState]
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &stateResponse) != nil || stateResponse.Data.Version != 1 || !stateResponse.Data.Applied.EmailPasswordEnabled || stateResponse.Data.Applied.SelfRegistration {
		t.Fatalf("Auth Configuration response did not include safe defaults and version: status=%d body=%s", response.Code, response.Body.String())
	}
	state := stateResponse.Data

	registerPath := "/api/v1/auth/" + collection.Name + "/register"
	response = doRequest(http.MethodPost, registerPath, `{"profile":{"email":"eve@example.com","displayName":"Eve"},"password":"eve-secret"}`, "")
	var problem struct {
		Error httpapi.APIError `json:"error"`
	}
	if response.Code != http.StatusForbidden || json.Unmarshal(response.Body.Bytes(), &problem) != nil || problem.Error.Code != "REGISTRATION_DISABLED" || problem.Error.RequestID == "" || problem.Error.RequestID != response.Header().Get("X-Request-Id") {
		t.Fatalf("disabled self registration did not return a correlated actionable error: status=%d body=%s", response.Code, response.Body.String())
	}

	state.Applied.SelfRegistration = true
	saveBody, err := json.Marshal(AuthConfigSaveInput{ExpectedVersion: state.Version, Configuration: state.Applied})
	if err != nil {
		t.Fatal(err)
	}
	response = doRequest(http.MethodPut, authPath, string(saveBody), "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &stateResponse) != nil || stateResponse.Data.Version != 2 || stateResponse.Data.Pending.SelfRegistration != true || stateResponse.Data.Applied.SelfRegistration {
		t.Fatalf("Auth Configuration Save did not return pending version: status=%d state=%+v body=%s", response.Code, state, response.Body.String())
	}
	state = stateResponse.Data
	response = doRequest(http.MethodPost, authPath+"/apply", `{"expectedVersion":2}`, "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &stateResponse) != nil || stateResponse.Data.Version != 3 || !stateResponse.Data.Applied.SelfRegistration || stateResponse.Data.Pending != stateResponse.Data.Applied {
		t.Fatalf("Auth Configuration Apply did not return applied state: status=%d state=%+v body=%s", response.Code, state, response.Body.String())
	}
	state = stateResponse.Data
	state.Pending.SessionDurationDays = 14
	saveBody, err = json.Marshal(AuthConfigSaveInput{ExpectedVersion: state.Version, Configuration: state.Pending})
	if err != nil {
		t.Fatal(err)
	}
	response = doRequest(http.MethodPut, authPath, string(saveBody), "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &stateResponse) != nil || stateResponse.Data.Version != 4 || stateResponse.Data.Pending.SessionDurationDays != 14 || stateResponse.Data.Applied.SessionDurationDays != 7 {
		t.Fatalf("Auth Configuration Save did not preserve separate pending state: status=%d state=%+v body=%s", response.Code, state, response.Body.String())
	}
	state = stateResponse.Data
	response = doRequest(http.MethodPost, authPath+"/discard", `{"expectedVersion":4}`, "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &stateResponse) != nil || stateResponse.Data.Version != 5 || stateResponse.Data.Pending != stateResponse.Data.Applied || stateResponse.Data.Applied.SessionDurationDays != 7 {
		t.Fatalf("Auth Configuration Discard did not restore the applied state: status=%d state=%+v body=%s", response.Code, state, response.Body.String())
	}
	state = stateResponse.Data

	response = doRequest(http.MethodPost, registerPath, `{"profile":{"email":"eve@example.com","displayName":"Eve"},"password":"eve-secret"}`, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("self registration failed after applying its configuration: status=%d body=%s", response.Code, response.Body.String())
	}
	var created struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data["email"] != "eve@example.com" || created.Data["displayName"] != "Eve" {
		t.Fatalf("registration returned an unexpected Profile: %#v", created.Data)
	}
	if _, exists := created.Data["password"]; exists {
		t.Fatal("registration response leaked the Password Credential")
	}

	loginPath := "/api/v1/auth/" + collection.Name + "/login"
	response = doRequest(http.MethodPost, loginPath, `{"email":"eve@example.com","password":"eve-secret"}`, "")
	var login LoginResult
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &login) != nil || login.AccessToken == "" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Login did not issue a non-cacheable one-time Session token: status=%d body=%s", response.Code, response.Body.String())
	}
	sessionPath := "/api/v1/auth/" + collection.Name + "/session"
	response = doRequest(http.MethodGet, sessionPath, "", login.AccessToken)
	var sessionResponse dataResponse[ApplicationSession]
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &sessionResponse) != nil || sessionResponse.Data.ID != login.Session.ID || sessionResponse.Data.Status != "active" {
		t.Fatalf("Session read did not return the current active Session: status=%d body=%s", response.Code, response.Body.String())
	}
	logoutPath := "/api/v1/auth/" + collection.Name + "/logout"
	response = doRequest(http.MethodPost, logoutPath, "", login.AccessToken)
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("Logout should revoke the Session and return empty 204: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodGet, sessionPath, "", login.AccessToken)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked Session token remained valid after Logout: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAuthHTTPAdminUsersAndSessionManagementRoutes(t *testing.T) {
	ctx := context.Background()
	store := openAuthStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Members", Type: backendmodel.CollectionTypeAuth,
		Fields: []backendmodel.Field{{Name: "displayName", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models, profiles)
	if err != nil {
		t.Fatal(err)
	}
	server := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))
	doRequest := func(method, path, body, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	adminPath := "/admin/api/v1/collections/" + collection.ID
	userPath := adminPath + "/users"
	response := doRequest(http.MethodPost, userPath, `{"profile":{"email":"http@example.com","displayName":"HTTP User"},"password":"first-secret"}`, "")
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &created) != nil || created.Data.ID == "" {
		t.Fatalf("Admin user creation did not create a Profile and Password Credential: status=%d body=%s", response.Code, response.Body.String())
	}
	userID := created.Data.ID
	response = doRequest(http.MethodGet, userPath, "", "")
	var users ApplicationUserPage
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &users) != nil || len(users.Data) != 1 || users.Data[0].RecordID != userID || users.Data[0].Email != "http@example.com" {
		t.Fatalf("Admin user list did not return the created App User: status=%d body=%s", response.Code, response.Body.String())
	}

	loginPath := "/api/v1/auth/" + collection.Name + "/login"
	login := func(password string) LoginResult {
		t.Helper()
		response := doRequest(http.MethodPost, loginPath, `{"email":"http@example.com","password":"`+password+`"}`, "")
		var result LoginResult
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.AccessToken == "" {
			t.Fatalf("App User Login failed: status=%d body=%s", response.Code, response.Body.String())
		}
		return result
	}
	first := login("first-secret")
	second := login("first-secret")
	appPath := "/api/v1/auth/" + collection.Name
	response = doRequest(http.MethodGet, appPath+"/sessions", "", first.AccessToken)
	var ownSessions dataResponse[[]ApplicationSession]
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &ownSessions) != nil || len(ownSessions.Data) != 2 {
		t.Fatalf("App User session list did not show both sessions: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodPost, appPath+"/sessions/"+second.Session.ID+"/revoke", "", first.AccessToken)
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("App User could not revoke another own session: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodGet, userPath+"/"+userID+"/sessions", "", "")
	var adminSessions dataResponse[[]ApplicationSession]
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &adminSessions) != nil || len(adminSessions.Data) != 2 {
		t.Fatalf("Admin session list did not include retained session history: status=%d body=%s", response.Code, response.Body.String())
	}
	statuses := map[string]string{}
	for _, session := range adminSessions.Data {
		statuses[session.ID] = session.Status
	}
	if statuses[second.Session.ID] != "revoked" || statuses[first.Session.ID] != "active" {
		t.Fatalf("own-session revoke was not reflected in Admin history: %#v", statuses)
	}
	response = doRequest(http.MethodPost, adminPath+"/sessions/"+first.Session.ID+"/revoke", "", "")
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("Admin could not revoke an App User session: status=%d body=%s", response.Code, response.Body.String())
	}
	third := login("first-secret")
	response = doRequest(http.MethodPost, userPath+"/"+userID+"/sessions/revoke-all", "", "")
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("Admin could not revoke all App User sessions: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodGet, appPath+"/session", "", third.AccessToken)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("Admin revoke-all left an App Session active: status=%d body=%s", response.Code, response.Body.String())
	}

	fourth := login("first-secret")
	response = doRequest(http.MethodPut, appPath+"/password", `{"currentPassword":"first-secret","newPassword":"second-secret"}`, fourth.AccessToken)
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("App User could not change the current password: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodPost, loginPath, `{"email":"http@example.com","password":"first-secret"}`, "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("old App User password remained valid after change: status=%d body=%s", response.Code, response.Body.String())
	}
	fifth := login("second-secret")
	response = doRequest(http.MethodPut, userPath+"/"+userID+"/password", `{"password":"third-secret"}`, "")
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 {
		t.Fatalf("Admin could not set an App User password: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodGet, appPath+"/session", "", fifth.AccessToken)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("Admin password reset did not revoke previous sessions: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodPost, loginPath, `{"email":"http@example.com","password":"third-secret"}`, "")
	if response.Code != http.StatusOK {
		t.Fatalf("new Admin-set password could not authenticate the App User: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAuthHTTPRequestRecordsContainAuthenticationOutcomes(t *testing.T) {
	ctx := context.Background()
	store := openAuthStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Members", Type: backendmodel.CollectionTypeAuth,
		Fields: []backendmodel.Field{{Name: "displayName", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models, profiles)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, collection.ID, map[string]any{"email": "audit@example.com", "displayName": "Audit"}, "audit-secret")
	if err != nil {
		t.Fatal(err)
	}
	requestRecords, err := requests.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	router := httpapi.NewAPIRouter(NewModule(service))
	server := httpapi.NewHandler(nil, nil, requestRecords.Middleware(router))
	doRequest := func(method, path, body, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	readRecord := func(response *httptest.ResponseRecorder) requests.RequestRecord {
		t.Helper()
		if response.Header().Get(requests.PersistedHeader) != "true" {
			t.Fatalf("Auth API request was not durably recorded: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
		}
		record, err := requestRecords.Get(ctx, response.Header().Get("X-Request-Id"))
		if err != nil {
			t.Fatal(err)
		}
		return record
	}

	registerPath := "/api/v1/auth/" + collection.Name + "/register"
	response := doRequest(http.MethodPost, registerPath, `{"profile":{"email":"new@example.com"},"password":"new-secret"}`, "")
	if response.Code != http.StatusForbidden {
		t.Fatalf("default-disabled registration response = %d, body=%s", response.Code, response.Body.String())
	}
	if record := readRecord(response); record.AuthenticationOutcome != requests.AuthenticationAnonymous {
		t.Fatalf("registration authentication outcome = %q", record.AuthenticationOutcome)
	}
	loginPath := "/api/v1/auth/" + collection.Name + "/login"
	response = doRequest(http.MethodPost, loginPath, `{"email":"audit@example.com","password":"wrong-secret"}`, "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid login response = %d, body=%s", response.Code, response.Body.String())
	}
	if record := readRecord(response); record.AuthenticationOutcome != requests.AuthenticationRejected {
		t.Fatalf("invalid login authentication outcome = %q", record.AuthenticationOutcome)
	}
	response = doRequest(http.MethodPost, loginPath, `{"email":"audit@example.com","password":"audit-secret"}`, "")
	var login LoginResult
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &login) != nil {
		t.Fatalf("valid login response = %d, body=%s", response.Code, response.Body.String())
	}
	if record := readRecord(response); record.AuthenticationOutcome != requests.AuthenticationAuthenticated {
		t.Fatalf("valid login authentication outcome = %q", record.AuthenticationOutcome)
	}
	sessionPath := "/api/v1/auth/" + collection.Name + "/session"
	response = doRequest(http.MethodGet, sessionPath, "", "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing-session response = %d, body=%s", response.Code, response.Body.String())
	}
	if record := readRecord(response); record.AuthenticationOutcome != requests.AuthenticationRejected {
		t.Fatalf("missing-session authentication outcome = %q", record.AuthenticationOutcome)
	}
	response = doRequest(http.MethodGet, sessionPath, "", login.AccessToken)
	if response.Code != http.StatusOK {
		t.Fatalf("valid-session response = %d, body=%s", response.Code, response.Body.String())
	}
	if record := readRecord(response); record.AuthenticationOutcome != requests.AuthenticationAuthenticated {
		t.Fatalf("valid-session authentication outcome = %q", record.AuthenticationOutcome)
	}
	if user.ID == "" {
		t.Fatal("created user did not have a record ID")
	}
}

func TestAuthWriteErrorExplainsDurableEventSizeLimit(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/auth/Members/me", nil)

	(&Module{}).writeError(response, request, recordevents.ErrEventTooLarge)

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
