package runtime

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/project"
)

// TestRuntimeAppUserRegistrationRequiresRecoveryEncryptionInsideCallerTransaction 证明在真实 Runtime 上，
// 注册启用 required 邮箱验证的 App User 会写入 durable 验证邮件意图，
// 且 Recovery token 加密复用请求事务而不是打开嵌套的 SQLite 事务。
func TestRuntimeAppUserRegistrationRequiresRecoveryEncryptionInsideCallerTransaction(t *testing.T) {
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

	secretIDs := make([]string, 0, 2)
	for _, name := range []string{"SMTP username", "SMTP password"} {
		created := postJSONWithCookie(t, baseURL+"/admin/api/v1/secrets", ownerCookie, `{"name":"`+name+`","value":"runtime-test-secret-value"}`)
		if created.status != http.StatusCreated {
			t.Fatalf("create Project Secret status=%d body=%s", created.status, created.body)
		}
		var secret struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(created.body, &secret); err != nil {
			t.Fatal(err)
		}
		secretIDs = append(secretIDs, secret.Data.ID)
	}

	mailBody := `{"expectedRevision":1,"enabled":true,"host":"127.0.0.1","port":12525,"security":"plaintext","fromAddress":"modelry@example.test","fromName":"Modelry","usernameSecretId":"` + secretIDs[0] + `","passwordSecretId":"` + secretIDs[1] + `"}`
	mailConfigured := sendJSONRequest(t, http.MethodPut, baseURL+"/admin/api/v1/mail", baseURL, ownerCookie, "", mailBody)
	if mailConfigured.status != http.StatusOK {
		t.Fatalf("configure Mail Provider status=%d body=%s", mailConfigured.status, mailConfigured.body)
	}

	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/collections", ownerCookie, `{"name":"members","type":"Auth","fields":[{"name":"displayName","type":"text"}],"authentication":{"emailPasswordEnabled":true,"selfRegistration":true,"sessionDurationDays":7,"emailVerification":"required"}}`)
	if created.status != http.StatusCreated {
		t.Fatalf("create Auth Collection status=%d body=%s", created.status, created.body)
	}

	registered := sendJSONRequest(t, http.MethodPost, baseURL+"/api/v1/auth/members/register", baseURL, "", "", `{"profile":{"email":"member@example.test","displayName":"Member"},"password":"Member-Password-42!"}`)
	if registered.status != http.StatusCreated {
		t.Fatalf("App User registration status=%d body=%s", registered.status, registered.body)
	}

	blocked := sendJSONRequest(t, http.MethodPost, baseURL+"/api/v1/auth/members/login", baseURL, "", "", `{"email":"member@example.test","password":"Member-Password-42!"}`)
	if blocked.status != http.StatusForbidden || !strings.Contains(string(blocked.body), "EMAIL_NOT_VERIFIED") {
		t.Fatalf("unverified Application Login status=%d body=%s", blocked.status, blocked.body)
	}

	deliveries := getResponseWithCookie(t, baseURL+"/admin/api/v1/mail/deliveries", "", ownerCookie)
	if deliveries.status != http.StatusOK || !strings.Contains(string(deliveries.body), `"kind":"verification"`) {
		t.Fatalf("durable verification Mail Delivery status=%d body=%s", deliveries.status, deliveries.body)
	}
	if strings.Contains(string(deliveries.body), "runtime-test-secret-value") {
		t.Fatalf("Mail Delivery history exposed a Project Secret value: %s", deliveries.body)
	}
}