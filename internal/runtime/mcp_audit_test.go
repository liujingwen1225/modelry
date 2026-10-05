package runtime

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/project"
)

// 真实 HTTP 验证智能体模型应用与权限拒绝的审计、请求关联和重启持久化。
func TestRuntimeMCPGovernanceAuditSurvivesRestart(t *testing.T) {
	root := t.TempDir()
	options := Options{ProjectRoot: project.RootConfig{FlagPath: &root, WorkingDir: t.TempDir()}, Version: "test"}
	instance, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	baseURL, cancel, done := startRuntime(t, instance)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			cancel()
			<-done
		}
	})
	cookie := bootstrapOwner(t, baseURL)
	createAccount := func(preset string) (string, string) {
		t.Helper()
		response := postJSONWithCookie(t, baseURL+"/admin/api/v1/service-accounts", cookie, `{"name":"agent-`+preset+`","permission":"`+preset+`","createAPIKey":true}`)
		if response.status != http.StatusCreated {
			t.Fatalf("创建测试账号失败：%d", response.status)
		}
		var value struct {
			Data struct {
				ServiceAccount struct{ ID string }
				APIKeyReveal   struct{ Secret string }
			}
		}
		if err := json.Unmarshal(response.body, &value); err != nil {
			t.Fatal(err)
		}
		return value.Data.ServiceAccount.ID, value.Data.APIKeyReveal.Secret
	}
	fullID, fullKey := createAccount("fullAccess")
	readID, readKey := createAccount("readOnly")
	created := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/collections", "", "", "Bearer "+fullKey, `{"name":"notes","type":"Normal"}`)
	if created.status != http.StatusCreated {
		t.Fatalf("创建集合失败：%d %s", created.status, created.body)
	}
	var collection struct{ Data struct{ ID string } }
	if err := json.Unmarshal(created.body, &collection); err != nil {
		t.Fatal(err)
	}
	schemaURL := baseURL + "/admin/api/v1/collections/" + collection.Data.ID + "/schema"
	staged := sendJSONRequest(t, http.MethodPost, schemaURL+"/pending-operations", "", "", "Bearer "+fullKey, `{"kind":"field","action":"add","definition":{"name":"done","type":"boolean"}}`)
	if staged.status != http.StatusCreated {
		t.Fatalf("保存变更失败：%d %s", staged.status, staged.body)
	}
	var pending struct{ Data struct{ ChangeSetID string } }
	if err := json.Unmarshal(staged.body, &pending); err != nil {
		t.Fatal(err)
	}
	applied := sendJSONRequest(t, http.MethodPost, schemaURL+"/apply", "", "", "Bearer "+fullKey, `{"expectedVersion":1,"confirmRisk":true}`)
	if applied.status != http.StatusOK {
		t.Fatalf("应用失败：%d %s", applied.status, applied.body)
	}
	denied := sendJSONRequest(t, http.MethodPost, schemaURL+"/pending-operations", "", "", "Bearer "+readKey, `{"kind":"field","action":"add","definition":{"name":"secret_value","type":"text"}}`)
	if denied.status != http.StatusForbidden {
		t.Fatalf("只读账号未拒绝：%d", denied.status)
	}
	check := func() {
		t.Helper()
		response := getResponseWithCookie(t, baseURL+"/admin/api/v1/audit?limit=100", "", cookie)
		var page audit.Page
		if response.status != http.StatusOK {
			t.Fatalf("读取审计失败：%d", response.status)
		}
		if err := json.Unmarshal(response.body, &page); err != nil {
			t.Fatal(err)
		}
		foundApply, foundDenied := false, false
		for _, record := range page.Data {
			if record.Action == "schema.apply" {
				foundApply = true
				if record.Actor.ID != fullID || record.Actor.Kind != audit.ActorServiceAccount || record.Resource.Kind != "changeSet" || record.Resource.ID != pending.Data.ChangeSetID || record.Result != "success" || record.RequestID != applied.headers.Get("X-Request-Id") {
					t.Errorf("模型应用审计不完整：%+v", record)
				}
			}
			if record.Action == "controlPlane.denied" {
				foundDenied = true
				if record.Actor.ID != readID || record.Resource.ID != "schema.write" || record.Result != "denied" || record.RequestID != denied.headers.Get("X-Request-Id") {
					t.Errorf("拒绝审计不完整：%+v", record)
				}
			}
		}
		if !foundApply {
			t.Error("缺少模型应用审计")
		}
		if !foundDenied {
			t.Error("缺少服务账号权限拒绝审计")
		}
		for _, secret := range []string{fullKey, readKey, "secret_value"} {
			if strings.Contains(string(response.body), secret) {
				t.Error("审计泄露凭证或请求正文")
			}
		}
	}
	check()
	cancel()
	stopped = true
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	instance, err = New(options)
	if err != nil {
		t.Fatal(err)
	}
	baseURL, cancel, done = startRuntime(t, instance)
	stopped = false
	check()
}
