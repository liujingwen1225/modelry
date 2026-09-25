package adminauth

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const testPassword = "a secure sample password"

type testModule struct{}

func (testModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/protected-test", func(w http.ResponseWriter, request *http.Request) {
		if _, ok := OwnerFromContext(request.Context()); !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /admin/api/v1/protected-test", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/v1/app-test", func(w http.ResponseWriter, request *http.Request) {
		if _, ok := OwnerFromContext(request.Context()); ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func openTestService(t *testing.T) (*storage.Store, *Service, http.Handler, string) {
	t.Helper()
	root := t.TempDir()
	databasePath := filepath.Join(root, ".modelry", "project.sqlite")
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	apiRouter := httpapi.NewAPIRouter(service, testModule{})
	handler := httpapi.NewHandler(nil, http.NotFoundHandler(), service.Middleware(apiRouter))
	return store, service, handler, databasePath
}

func request(t *testing.T, handler http.Handler, method, path, body string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:43210"
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertAPIError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, status, response.Body.String())
	}
	var envelope struct {
		Error httpapi.APIError `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode structured error: %v; body=%s", err, response.Body.String())
	}
	requestID := response.Header().Get("X-Request-Id")
	if envelope.Error.Code != code || envelope.Error.Details == nil || requestID == "" || envelope.Error.RequestID != requestID {
		t.Fatalf("unexpected structured error: %#v, header requestId=%q", envelope.Error, requestID)
	}
}

func bootstrapBody() string {
	return `{"email":"Owner@Modelry.dev","password":"` + testPassword + `"}`
}

func TestBootstrapOwnerLoginLogoutAndSessionSurviveRestart(t *testing.T) {
	store, _, handler, databasePath := openTestService(t)
	status := request(t, handler, http.MethodGet, "/admin/api/v1/bootstrap/status", "", nil, "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"state":"required"`) {
		t.Fatalf("initial bootstrap status = %d %s", status.Code, status.Body.String())
	}

	created := request(t, handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", bootstrapBody(), nil, "http://localhost")
	if created.Code != http.StatusCreated {
		t.Fatalf("bootstrap = %d %s", created.Code, created.Body.String())
	}
	var result ownerResponse
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Owner.ID == "" || result.Owner.Email != "owner@modelry.dev" || result.Session.ExpiresAt.IsZero() {
		t.Fatalf("unexpected bootstrap response: %#v", result)
	}
	cookie := findOwnerCookie(t, created)
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != ownerCookiePath || cookie.Secure {
		t.Fatalf("unexpected local session cookie: %#v", cookie)
	}
	if strings.Contains(created.Body.String(), testPassword) || strings.Contains(created.Body.String(), cookie.Value) {
		t.Fatalf("bootstrap response disclosed a credential: %s", created.Body.String())
	}
	if created.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("auth response cache policy = %q", created.Header().Get("Cache-Control"))
	}

	var storedPasswordHash string
	var storedTokenHash []byte
	err := store.WithReadSnapshot(t.Context(), func(tx storage.Executor) error {
		if err := tx.QueryRowContext(t.Context(), `SELECT password_hash FROM modelry_admin_owner WHERE singleton = 1`).Scan(&storedPasswordHash); err != nil {
			return err
		}
		return tx.QueryRowContext(t.Context(), `SELECT token_hash FROM modelry_admin_sessions WHERE owner_id = ?`, result.Owner.ID).Scan(&storedTokenHash)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(storedPasswordHash, "pbkdf2-sha256$600000$") || strings.Contains(storedPasswordHash, testPassword) {
		t.Fatalf("password is not stored as a password hash: %q", storedPasswordHash)
	}
	storedDigest := sha256.Sum256([]byte(cookie.Value))
	if len(storedTokenHash) != len(storedDigest) || string(storedTokenHash) != string(storedDigest[:]) {
		t.Fatal("session storage does not contain only the token hash")
	}

	current := request(t, handler, http.MethodGet, "/admin/api/v1/auth/session", "", cookie, "")
	if current.Code != http.StatusOK || !strings.Contains(current.Body.String(), result.Owner.ID) {
		t.Fatalf("current owner session = %d %s", current.Code, current.Body.String())
	}
	closed := request(t, handler, http.MethodGet, "/admin/api/v1/bootstrap/status", "", cookie, "")
	if closed.Code != http.StatusOK || !strings.Contains(closed.Body.String(), `"state":"closed"`) {
		t.Fatalf("closed bootstrap status = %d %s", closed.Code, closed.Body.String())
	}
	replayed := request(t, handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", bootstrapBody(), nil, "http://localhost")
	assertAPIError(t, replayed, http.StatusConflict, "BOOTSTRAP_CLOSED")

	logout := request(t, handler, http.MethodPost, "/admin/api/v1/auth/logout", "", cookie, "http://localhost")
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout = %d %s", logout.Code, logout.Body.String())
	}
	cleared := logout.Result().Cookies()
	if len(cleared) != 1 || cleared[0].Name != ownerCookieName || cleared[0].MaxAge >= 0 {
		t.Fatalf("logout did not expire the cookie: %#v", cleared)
	}
	assertAPIError(t, request(t, handler, http.MethodGet, "/admin/api/v1/auth/session", "", cookie, ""), http.StatusUnauthorized, "UNAUTHENTICATED")

	login := request(t, handler, http.MethodPost, "/admin/api/v1/auth/login", `{"email":"OWNER@MODElry.dev","password":"`+testPassword+`"}`, nil, "http://localhost")
	if login.Code != http.StatusOK {
		t.Fatalf("login = %d %s", login.Code, login.Body.String())
	}
	loginCookie := findOwnerCookie(t, login)
	wrongPassword := request(t, handler, http.MethodPost, "/admin/api/v1/auth/login", `{"email":"owner@modelry.dev","password":"wrong password"}`, nil, "http://localhost")
	assertAPIError(t, wrongPassword, http.StatusUnauthorized, "UNAUTHENTICATED")
	if strings.Contains(wrongPassword.Body.String(), "wrong password") {
		t.Fatalf("login error disclosed password: %s", wrongPassword.Body.String())
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restartedStore, err := storage.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restartedStore.Close() })
	restartedService, err := New(restartedStore)
	if err != nil {
		t.Fatal(err)
	}
	restartedRouter := httpapi.NewAPIRouter(restartedService, testModule{})
	restartedHandler := httpapi.NewHandler(nil, http.NotFoundHandler(), restartedService.Middleware(restartedRouter))
	afterRestart := request(t, restartedHandler, http.MethodGet, "/admin/api/v1/auth/session", "", loginCookie, "")
	if afterRestart.Code != http.StatusOK || !strings.Contains(afterRestart.Body.String(), result.Owner.ID) {
		t.Fatalf("session after restart = %d %s", afterRestart.Code, afterRestart.Body.String())
	}
}

func TestBootstrapRequiresSameOriginAndLoopbackAndValidationIsActionable(t *testing.T) {
	_, _, handler, _ := openTestService(t)
	crossOrigin := request(t, handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", bootstrapBody(), nil, "http://attacker.invalid")
	assertAPIError(t, crossOrigin, http.StatusForbidden, "FORBIDDEN")

	remote := httptest.NewRequest(http.MethodPost, "http://localhost/admin/api/v1/bootstrap/owner", strings.NewReader(bootstrapBody()))
	remote.RemoteAddr = "192.0.2.45:43210"
	remote.Header.Set("Content-Type", "application/json")
	remote.Header.Set("Origin", "http://localhost")
	remoteResponse := httptest.NewRecorder()
	handler.ServeHTTP(remoteResponse, remote)
	assertAPIError(t, remoteResponse, http.StatusForbidden, "FORBIDDEN")

	boundHost := httptest.NewRequest(http.MethodPost, "http://attacker.invalid/admin/api/v1/bootstrap/owner", strings.NewReader(bootstrapBody()))
	boundHost.RemoteAddr = "127.0.0.1:43210"
	boundHost.Header.Set("Content-Type", "application/json")
	boundHost.Header.Set("Origin", "http://attacker.invalid")
	boundHostResponse := httptest.NewRecorder()
	handler.ServeHTTP(boundHostResponse, boundHost)
	assertAPIError(t, boundHostResponse, http.StatusForbidden, "FORBIDDEN")

	invalid := request(t, handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", `{"email":"owner@modelry.dev","password":""}`, nil, "http://localhost")
	assertAPIError(t, invalid, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	if !strings.Contains(invalid.Body.String(), `"path":"/password"`) {
		t.Fatalf("password validation has no field path: %s", invalid.Body.String())
	}
	status := request(t, handler, http.MethodGet, "/admin/api/v1/bootstrap/status", "", nil, "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"state":"required"`) {
		t.Fatalf("rejected bootstrap changed the durable state: %d %s", status.Code, status.Body.String())
	}
}

func TestMiddlewareProtectsControlPlaneOnlyAndRejectsSuppliedInvalidCredentials(t *testing.T) {
	_, service, handler, _ := openTestService(t)
	created := request(t, handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", bootstrapBody(), nil, "http://localhost")
	cookie := findOwnerCookie(t, created)

	noSession := request(t, handler, http.MethodGet, "/admin/api/v1/protected-test", "", nil, "")
	assertAPIError(t, noSession, http.StatusUnauthorized, "UNAUTHENTICATED")
	invalidBearer := httptest.NewRequest(http.MethodGet, "http://localhost/admin/api/v1/protected-test", nil)
	invalidBearer.Header.Set("Authorization", "Bearer not-an-owner-session")
	invalidResponse := httptest.NewRecorder()
	httpapi.NewHandler(nil, http.NotFoundHandler(), service.Middleware(httpapi.NewAPIRouter(service, testModule{}))).ServeHTTP(invalidResponse, invalidBearer)
	assertAPIError(t, invalidResponse, http.StatusUnauthorized, "UNAUTHENTICATED")

	protected := request(t, handler, http.MethodGet, "/admin/api/v1/protected-test", "", cookie, "")
	if protected.Code != http.StatusNoContent {
		t.Fatalf("Owner-protected route = %d %s", protected.Code, protected.Body.String())
	}
	app := request(t, handler, http.MethodGet, "/api/v1/app-test", "", cookie, "")
	if app.Code != http.StatusNoContent {
		t.Fatalf("Application route was affected by the Admin session: %d %s", app.Code, app.Body.String())
	}

	crossSiteWrite := request(t, handler, http.MethodPost, "/admin/api/v1/protected-test", "", cookie, "http://attacker.invalid")
	assertAPIError(t, crossSiteWrite, http.StatusForbidden, "FORBIDDEN")
}

func TestOwnerCookieSecureFollowsHTTPS(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "https://localhost/admin/api/v1/auth/login", nil)
	if request.TLS == nil || !secureRequest(request) {
		t.Fatal("HTTPS request did not produce a Secure owner cookie")
	}
	response := httptest.NewRecorder()
	setOwnerCookie(response, request, "test-token", time.Now().Add(sessionLifetime))
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure {
		t.Fatalf("HTTPS response cookie is not Secure: %#v", cookies)
	}
	forwarded := httptest.NewRequest(http.MethodPost, "http://localhost/admin/api/v1/auth/login", nil)
	forwarded.Header.Set("X-Forwarded-Proto", "https")
	if !secureRequest(forwarded) {
		t.Fatal("HTTPS-terminated proxy request did not produce a Secure owner cookie")
	}
}

func TestConcurrentBootstrapCreatesOnlyOneOwner(t *testing.T) {
	store, service, _, _ := openTestService(t)
	type result struct {
		owner Owner
		err   error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			owner, _, _, err := service.bootstrap(t.Context(), "owner@modelry.dev", testPassword)
			results <- result{owner: owner, err: err}
		}()
	}
	created := 0
	closed := 0
	for range 2 {
		result := <-results
		switch {
		case result.err == nil:
			created++
		case result.err == ErrBootstrapClosed:
			closed++
		default:
			t.Fatalf("concurrent bootstrap returned unexpected error: %v", result.err)
		}
	}
	if created != 1 || closed != 1 {
		t.Fatalf("concurrent bootstrap outcomes: created=%d closed=%d", created, closed)
	}
	var owners, sessions int
	if err := store.WithReadSnapshot(t.Context(), func(tx storage.Executor) error {
		if err := tx.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM modelry_admin_owner`).Scan(&owners); err != nil {
			return err
		}
		return tx.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM modelry_admin_sessions`).Scan(&sessions)
	}); err != nil {
		t.Fatal(err)
	}
	if owners != 1 || sessions != 1 {
		t.Fatalf("durable bootstrap state has owners=%d sessions=%d", owners, sessions)
	}
}

func findOwnerCookie(t *testing.T, response *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == ownerCookieName {
			return cookie
		}
	}
	t.Fatalf("response has no %q cookie", ownerCookieName)
	return nil
}

func TestOnlyTheRuntimeOwnerSchemaIsCreated(t *testing.T) {
	store, _, _, _ := openTestService(t)
	var tableCount int
	if err := store.WithReadSnapshot(t.Context(), func(tx storage.Executor) error {
		return tx.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'modelry_admin_%'`).Scan(&tableCount)
	}); err != nil {
		t.Fatal(err)
	}
	if tableCount != 5 {
		t.Fatalf("admin-auth created %d tables, want owner/bootstrap/session plus administrator identity and sessions", tableCount)
	}
}

func TestSchemaCanBeReopenedFromAnExistingProjectRoot(t *testing.T) {
	root := t.TempDir()
	managed := filepath.Join(root, ".modelry")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(filepath.Join(managed, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(store); err != nil {
		t.Fatalf("reinitializing auth schema failed: %v", err)
	}
	if err := service.store.WithReadSnapshot(t.Context(), func(tx storage.Executor) error {
		var closed int
		if err := tx.QueryRowContext(t.Context(), `SELECT closed FROM modelry_admin_bootstrap WHERE singleton = 1`).Scan(&closed); err != nil {
			return err
		}
		if closed != 0 {
			t.Errorf("empty project bootstrap should remain open, got closed=%d", closed)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
}
