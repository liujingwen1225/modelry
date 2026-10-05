package runtime

import (
	"encoding/json"
	"github.com/liujingwen1225/modelry/internal/project"
	"net/http"
	"strings"
	"testing"
)

// 使用真实 Runtime、SQLite 与 HTTP 验证两个入口共用批准与身份边界。
func TestAgentSharedGatewayPermissionsAndDurableApproval(t *testing.T) {
	root := t.TempDir()
	options := Options{ProjectRoot: project.RootConfig{FlagPath: &root, WorkingDir: t.TempDir()}, Version: "test"}
	instance, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	baseURL, cancel, done := startRuntime(t, instance)
	stopped := false
	defer func() {
		if !stopped {
			cancel()
			<-done
		}
	}()
	cookie := bootstrapOwner(t, baseURL)
	created := postJSONWithCookie(t, baseURL+"/admin/api/v1/service-accounts", cookie, `{"name":"agent-shared","permission":"fullAccess","createAPIKey":true}`)
	if created.status != 201 {
		t.Fatalf("创建账号: %d %s", created.status, created.body)
	}
	var account struct {
		Data struct {
			ServiceAccount struct{ ID string }
			APIKeyReveal   struct{ Secret string }
		}
	}
	if err := json.Unmarshal(created.body, &account); err != nil {
		t.Fatal(err)
	}
	session := func(token string) string {
		r := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/agent/sessions", baseURL, func() string {
			if token == "" {
				return cookie
			}
			return ""
		}(), func() string {
			if token != "" {
				return "Bearer " + token
			}
			return ""
		}(), `{"title":"共享验收"}`)
		if r.status != 200 {
			t.Fatalf("创建会话: %d %s", r.status, r.body)
		}
		var v struct{ Data struct{ ID string } }
		json.Unmarshal(r.body, &v)
		return v.Data.ID
	}
	native := session("")
	external := session(account.Data.APIKeyReveal.Secret)
	propose := func(id, token, name string) string {
		r := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/agent/sessions/"+id+"/tools", baseURL, func() string {
			if token == "" {
				return cookie
			}
			return ""
		}(), func() string {
			if token != "" {
				return "Bearer " + token
			}
			return ""
		}(), `{"name":"collections_create","arguments":{"body":{"name":"`+name+`","type":"Normal","fields":[{"name":"title","type":"text"}]}}}`)
		if r.status != 200 {
			t.Fatalf("提出变更: %d %s", r.status, r.body)
		}
		var v struct {
			Data struct {
				ApprovalRequired bool
				OperationID      string
			}
		}
		json.Unmarshal(r.body, &v)
		if !v.Data.ApprovalRequired {
			t.Fatal("默认写入没有等待批准")
		}
		return v.Data.OperationID
	}
	nativeOp := propose(native, "", "native_notes")
	externalOp := propose(external, account.Data.APIKeyReveal.Secret, "mcp_notes")
	denied := sendJSONRequest(t, http.MethodPost, baseURL+"/admin/api/v1/agent/operations/"+externalOp+"/approve", "", "", "Bearer "+account.Data.APIKeyReveal.Secret, `{}`)
	if denied.status != 403 {
		t.Fatal("服务账号能够自行批准", denied.status)
	}
	approve := func(id string) string {
		r := postJSONWithCookie(t, baseURL+"/admin/api/v1/agent/operations/"+id+"/approve", cookie, `{}`)
		if r.status != 200 {
			t.Fatalf("批准失败: %d %s", r.status, r.body)
		}
		var v struct{ Data struct{ State string } }
		json.Unmarshal(r.body, &v)
		return v.Data.State
	}
	if approve(nativeOp) != "succeeded" {
		t.Fatal("内置操作未成功")
	}
	// 创建集合改变了原目标快照，外部提案必须重新复核。
	if approve(externalOp) != "stale" {
		t.Fatal("目标变化后提案没有失效")
	}
	externalOp = propose(external, account.Data.APIKeyReveal.Secret, "mcp_notes")
	if approve(externalOp) != "succeeded" {
		t.Fatal("MCP 操作未成功")
	}
	if approve(externalOp) != "succeeded" {
		t.Fatal("重复批准状态异常")
	}
	blocked := propose(external, account.Data.APIKeyReveal.Secret, "blocked_notes")
	disabled := postJSONWithCookie(t, baseURL+"/admin/api/v1/service-accounts/"+account.Data.ServiceAccount.ID+"/disable", cookie, `{}`)
	if disabled.status != 200 && disabled.status != 204 {
		t.Fatalf("停用账号失败: %d %s", disabled.status, disabled.body)
	}
	if approve(blocked) != "stale" {
		t.Fatal("失效身份仍可执行")
	}
	model := sendJSONRequest(t, http.MethodPut, baseURL+"/admin/api/v1/agent/config", baseURL, cookie, "", `{"baseUrl":"https://api.deepseek.com","model":"deepseek-flash","apiKey":"测试密钥不能回传","revision":0}`)
	if model.status != 200 {
		t.Fatalf("配置模型: %d %s", model.status, model.body)
	}
	if strings.Contains(string(model.body), "测试密钥不能回传") {
		t.Fatal("模型响应泄露明文密钥")
	}
	clear := sendJSONRequest(t, http.MethodPut, baseURL+"/admin/api/v1/agent/config", baseURL, cookie, "", `{"baseUrl":"https://api.deepseek.com","model":"deepseek-flash","clearApiKey":true,"revision":1}`)
	if clear.status != 200 {
		t.Fatalf("清除密钥: %d %s", clear.status, clear.body)
	}
	cancel()
	<-done
	stopped = true
	restarted, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	url2, cancel2, done2 := startRuntime(t, restarted)
	defer func() { cancel2(); <-done2 }()
	persisted := getResponseWithCookie(t, url2+"/admin/api/v1/agent/operations/"+externalOp, "", cookie)
	if persisted.status != 200 || !strings.Contains(string(persisted.body), `"state":"succeeded"`) {
		t.Fatalf("重启后结果丢失: %d %s", persisted.status, persisted.body)
	}
	read := getResponseWithCookie(t, url2+"/admin/api/v1/collections?limit=100", "", cookie)
	if strings.Count(string(read.body), `"name":"mcp_notes"`) != 1 || strings.Contains(string(read.body), "blocked_notes") {
		t.Fatal("重启后业务结果不正确", string(read.body))
	}
}

func TestAgentOwnerSessionRevocationAndOpenStreamShutdown(t *testing.T) {
	root := t.TempDir()
	instance, err := New(Options{ProjectRoot: project.RootConfig{FlagPath: &root, WorkingDir: t.TempDir()}, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	base, cancel, done := startRuntime(t, instance)
	defer func() { cancel(); <-done }()
	cookie := bootstrapOwner(t, base)
	created := postJSONWithCookie(t, base+"/admin/api/v1/agent/sessions", cookie, `{}`)
	var session struct{ Data struct{ ID string } }
	json.Unmarshal(created.body, &session)
	proposal := postJSONWithCookie(t, base+"/admin/api/v1/agent/sessions/"+session.Data.ID+"/tools", cookie, `{"name":"collections_create","arguments":{"body":{"name":"revoked_owner_notes","type":"Normal"}}}`)
	var operation struct{ Data struct{ OperationID string } }
	json.Unmarshal(proposal.body, &operation)
	logout := postJSONWithCookie(t, base+"/admin/api/v1/auth/logout", cookie, `{}`)
	if logout.status != 204 {
		t.Fatal("退出登录失败", logout.status, string(logout.body))
	}
	login := sendJSONRequest(t, http.MethodPost, base+"/admin/api/v1/auth/login", base, "", "", `{"email":"owner@example.com","password":"Sufficient-Owner-Password-42"}`)
	freshCookie := login.headers.Get("Set-Cookie")
	if freshCookie == "" {
		t.Fatal("登录未返回会话")
	}
	approved := postJSONWithCookie(t, base+"/admin/api/v1/agent/operations/"+operation.Data.OperationID+"/approve", freshCookie, `{}`)
	if approved.status != 200 || !strings.Contains(string(approved.body), `"state":"stale"`) {
		t.Fatal("原登录撤销仍可批准", approved.status, string(approved.body))
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/admin/api/v1/agent/sessions/"+session.Data.ID+"/events", nil)
	req.Header.Set("Cookie", freshCookie)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("事件流未建立", response.StatusCode)
	}
	// 保持 SSE 连接打开，关闭 Runtime 仍应正常完成而非等待排空超时。
	if err = instance.Close(); err != nil {
		t.Fatal("有 SSE 连接时不能正常关闭", err)
	}
}
