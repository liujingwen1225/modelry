package automation

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

// TestRunJobHTTPContractRequiresOwnerAndReturnsManualDelivery 验证手动运行的 HTTP 契约：
// Owner 认证、202 + job.manual Delivery、停用 Webhook 的 422、未知 Job 的 404。
func TestRunJobHTTPContractRequiresOwnerAndReturnsManualDelivery(t *testing.T) {
	service, store := newServiceFixture(t)
	ownerAuth, err := adminauth.New(store)
	if err != nil {
		t.Fatal(err)
	}
	handler := ownerAuth.Middleware(httpapi.NewAPIRouter(ownerAuth, NewModule(service)))

	unauthorized := automationRequest(handler, http.MethodPost, "/admin/api/v1/jobs/job_missing000000/run", "", nil, "http://localhost")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated manual run status = %d, want 401", unauthorized.Code)
	}

	bootstrap := automationRequest(handler, http.MethodPost, "/admin/api/v1/bootstrap/owner", `{"email":"owner@example.test","password":"secure test password"}`, nil, "http://localhost")
	if bootstrap.Code != http.StatusCreated {
		t.Fatalf("bootstrap owner status = %d; body=%s", bootstrap.Code, bootstrap.Body.String())
	}
	cookies := bootstrap.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("bootstrap returned %d cookies, want owner session", len(cookies))
	}
	cookie := cookies[0]

	created := automationRequest(handler, http.MethodPost, "/admin/api/v1/webhooks", `{"name":"scheduler","targetUrl":"https://hooks.example.test/jobs","signingSecretId":"sec_test"}`, cookie, "http://localhost")
	if created.Code != http.StatusCreated {
		t.Fatalf("create Webhook status = %d; body=%s", created.Code, created.Body.String())
	}
	var webhookEnvelope struct {
		Data Webhook `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &webhookEnvelope); err != nil {
		t.Fatal(err)
	}

	job := automationRequest(handler, http.MethodPost, "/admin/api/v1/jobs", `{"name":"cleanup","webhookId":"`+webhookEnvelope.Data.ID+`","cron":"0 3 * * *"}`, cookie, "http://localhost")
	if job.Code != http.StatusCreated {
		t.Fatalf("create Job status = %d; body=%s", job.Code, job.Body.String())
	}
	var jobEnvelope struct {
		Data Job `json:"data"`
	}
	if err := json.Unmarshal(job.Body.Bytes(), &jobEnvelope); err != nil {
		t.Fatal(err)
	}

	// Webhook 仍停用：手动运行必须返回字段级 422，而不是排队一条永远不会发出的投递。
	disabledWebhook := automationRequest(handler, http.MethodPost, "/admin/api/v1/jobs/"+jobEnvelope.Data.ID+"/run", "", cookie, "http://localhost")
	if disabledWebhook.Code != http.StatusUnprocessableEntity || !strings.Contains(disabledWebhook.Body.String(), "invalidWebhook") {
		t.Fatalf("manual run with a disabled Webhook = %d %s, want 422 invalidWebhook", disabledWebhook.Code, disabledWebhook.Body.String())
	}

	enabled := automationRequest(handler, http.MethodPost, "/admin/api/v1/webhooks/"+webhookEnvelope.Data.ID+"/enable", "", cookie, "http://localhost")
	if enabled.Code != http.StatusOK {
		t.Fatalf("enable Webhook status = %d; body=%s", enabled.Code, enabled.Body.String())
	}

	run := automationRequest(handler, http.MethodPost, "/admin/api/v1/jobs/"+jobEnvelope.Data.ID+"/run", "", cookie, "http://localhost")
	if run.Code != http.StatusAccepted {
		t.Fatalf("manual run status = %d, want 202; body=%s", run.Code, run.Body.String())
	}
	if !strings.Contains(run.Body.String(), `"eventType":"job.manual"`) || !strings.Contains(run.Body.String(), `"sourceType":"job"`) {
		t.Fatalf("manual run body = %s, want a job.manual Job Delivery", run.Body.String())
	}
	if strings.Contains(run.Body.String(), "hooks.example.test") || strings.Contains(run.Body.String(), "never-return-this") {
		t.Fatalf("manual run response disclosed the target URL or Secret: %s", run.Body.String())
	}
	var deliveryEnvelope struct {
		Data Delivery `json:"data"`
	}
	if err := json.Unmarshal(run.Body.Bytes(), &deliveryEnvelope); err != nil {
		t.Fatal(err)
	}
	if deliveryEnvelope.Data.ID == "" || deliveryEnvelope.Data.Status != "pending" {
		t.Fatalf("manual run Delivery = %+v, want a pending Delivery", deliveryEnvelope.Data)
	}

	listed := automationRequest(handler, http.MethodGet, "/admin/api/v1/deliveries?sourceType=job", "", cookie, "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), deliveryEnvelope.Data.ID) {
		t.Fatalf("Job Delivery history = %d %s, want the manual run", listed.Code, listed.Body.String())
	}

	missing := automationRequest(handler, http.MethodPost, "/admin/api/v1/jobs/job_missing000000/run", "", cookie, "http://localhost")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("manual run for a missing Job = %d %s, want 404", missing.Code, missing.Body.String())
	}
	withQuery := automationRequest(handler, http.MethodPost, "/admin/api/v1/jobs/"+jobEnvelope.Data.ID+"/run?force=1", "", cookie, "http://localhost")
	if withQuery.Code != http.StatusBadRequest {
		t.Fatalf("manual run with a query parameter = %d, want 400", withQuery.Code)
	}
}
