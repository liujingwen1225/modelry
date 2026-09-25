package automation

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

func TestAutomationHTTPRequiresOwnerAndReturnsSafeWebhookMetadata(t *testing.T) {
	service, store := newServiceFixture(t)
	ownerAuth, err := adminauth.New(store)
	if err != nil {
		t.Fatal(err)
	}
	handler := ownerAuth.Middleware(httpapi.NewAPIRouter(ownerAuth, NewModule(service)))

	unauthorized := automationRequest(handler, http.MethodGet, "/admin/api/v1/webhooks", "", nil, "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated Webhook list status = %d, want 401; body=%s", unauthorized.Code, unauthorized.Body.String())
	}

	bootstrap := automationRequest(handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", `{"email":"owner@example.test","password":"secure test password"}`, nil, "http://localhost")
	if bootstrap.Code != http.StatusCreated {
		t.Fatalf("bootstrap owner status = %d; body=%s", bootstrap.Code, bootstrap.Body.String())
	}
	cookies := bootstrap.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("bootstrap returned %d cookies, want owner session", len(cookies))
	}

	created := automationRequest(handler, http.MethodPost, "/admin/api/v1/webhooks", `{"name":"primary","targetUrl":"https://hooks.example.test/events","signingSecretId":"sec_test"}`, cookies[0], "http://localhost")
	if created.Code != http.StatusCreated {
		t.Fatalf("create Webhook status = %d; body=%s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), "never-return-this") || strings.Contains(created.Body.String(), `"payload"`) {
		t.Fatalf("Webhook response disclosed Secret or payload: %s", created.Body.String())
	}
	var envelope struct {
		Data Webhook `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.ID == "" || envelope.Data.Enabled || envelope.Data.Revision != 1 {
		t.Fatalf("unexpected created Webhook response: %+v", envelope.Data)
	}
	testDelivery := automationRequest(handler, http.MethodPost, "/admin/api/v1/webhooks/"+envelope.Data.ID+"/test", "", cookies[0], "http://localhost")
	if testDelivery.Code != http.StatusAccepted || !strings.Contains(testDelivery.Body.String(), `"eventType":"webhook.test"`) {
		t.Fatalf("disabled Webhook synthetic test = %d %s, want 202 webhook.test", testDelivery.Code, testDelivery.Body.String())
	}

	listed := automationRequest(handler, http.MethodGet, "/admin/api/v1/webhooks", "", cookies[0], "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), envelope.Data.ID) {
		t.Fatalf("list Webhooks = %d %s", listed.Code, listed.Body.String())
	}
	for _, query := range []string{"limit=", "cursor=", "sourceType=", "status="} {
		response := automationRequest(handler, http.MethodGet, "/admin/api/v1/deliveries?"+query, "", cookies[0], "")
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"INVALID_ARGUMENT"`) {
			t.Errorf("empty query %q returned %d %s, want safe 400 INVALID_ARGUMENT", query, response.Code, response.Body.String())
		}
	}
}

func automationRequest(handler http.Handler, method, path, body string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
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
