package agenttools

import (
	"net/http"
	"sort"
	"strings"
)

// 工具定义是内置 Agent、MCP 与权限界面的共同来源。
func init() {
	add := func(name, method, path, permission, purpose string) {
		Operations[name] = Operation{method, "/admin/api/v1/" + path, permission, purpose}
	}
	for _, item := range []struct{ prefix, route, permission string }{
		{"hooks", "extensions", "hooks"}, {"webhooks", "webhooks", "webhooks"},
		{"event_hooks", "event-hooks", "eventHooks"}, {"jobs", "jobs", "jobs"},
	} {
		id := map[string]string{"hooks": "extensionId", "webhooks": "webhookId", "event_hooks": "eventHookId", "jobs": "jobId"}[item.prefix]
		for _, verb := range []string{"list", "get", "create", "update", "enable", "disable"} {
			method, path, permission := http.MethodGet, item.route, item.permission+".read"
			if verb != "list" && verb != "create" {
				path += "/{" + id + "}"
			}
			if verb == "create" {
				method, permission = http.MethodPost, item.permission+".write"
			}
			if verb == "update" {
				method, permission = http.MethodPut, item.permission+".write"
			}
			if verb == "enable" || verb == "disable" {
				method, permission = http.MethodPost, item.permission+".write"
				path += "/" + verb
			}
			add(item.prefix+"_"+verb, method, path, permission, "管理"+item.route+"，配置 DTO 与该正式 API 相同")
		}
	}
	add("hooks_runs", http.MethodGet, "extensions/{extensionId}/runs", "hooks.read", "查看 Hook 执行历史")
	add("webhooks_test", http.MethodPost, "webhooks/{webhookId}/test", "webhooks.execute", "发送测试 Webhook，产生外部副作用")
	add("jobs_run", http.MethodPost, "jobs/{jobId}/run", "jobs.execute", "运行定时任务，产生外部副作用")
	add("deliveries_list", http.MethodGet, "deliveries", "webhooks.read", "查看投递历史")
	add("deliveries_get", http.MethodGet, "deliveries/{deliveryId}", "webhooks.read", "查看投递结果")
	add("deliveries_retry", http.MethodPost, "deliveries/{deliveryId}/retry", "webhooks.execute", "重试投递，产生外部副作用")
	for _, verb := range []string{"get", "save", "apply", "discard"} {
		method, path, permission := http.MethodGet, "collections/{collectionId}/authentication", "authentication.read"
		if verb == "save" {
			method, permission = http.MethodPut, "authentication.write"
		}
		if verb == "apply" || verb == "discard" {
			method = http.MethodPost
			path += "/" + verb
			permission = "authentication.apply"
			if verb == "discard" {
				permission = "authentication.write"
			}
		}
		add("authentication_"+verb, method, path, permission, "通过应用认证配置的标准变更生命周期操作")
	}
}

func routeParameters(path string) []string {
	var names []string
	for _, part := range strings.Split(path, "/") {
		if strings.HasPrefix(part, "{") {
			names = append(names, strings.Trim(part, "{}"))
		}
	}
	return names
}

func additionalTools() []Tool {
	var names []string
	for name := range Operations {
		if strings.HasPrefix(name, "authentication_") || strings.HasPrefix(name, "hooks_") || strings.HasPrefix(name, "webhooks_") || strings.HasPrefix(name, "event_hooks_") || strings.HasPrefix(name, "jobs_") || strings.HasPrefix(name, "deliveries_") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var tools []Tool
	for _, name := range names {
		op := Operations[name]
		properties := map[string]any{}
		required := []string{}
		for _, parameter := range routeParameters(op.Path) {
			properties[parameter] = map[string]any{"type": "string", "pattern": idPattern.String()}
			required = append(required, parameter)
		}
		if name == "hooks_runs" || name == "deliveries_list" {
			properties["limit"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 100}
			properties["cursor"] = map[string]any{"type": "string"}
			if name == "deliveries_list" {
				properties["sourceType"] = map[string]any{"type": "string"}
				properties["status"] = map[string]any{"type": "string"}
			}
		}
		if needsBody(name, op) {
			properties["body"] = bodySchema(name)
			required = append(required, "body")
		}
		tools = append(tools, Tool{Name: name, Title: op.Purpose, Description: op.Purpose, InputSchema: map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}, Annotations: map[string]any{"readOnlyHint": op.Method == http.MethodGet, "destructiveHint": op.Method != http.MethodGet, "idempotentHint": op.Method == http.MethodGet}})
	}
	return tools
}

func needsBody(name string, op Operation) bool {
	return op.Method == http.MethodPut || strings.HasSuffix(name, "_create") || name == "authentication_apply" || name == "authentication_discard"
}

func ReadOnly(name string) bool {
	op, ok := Operations[name]
	return ok && (op.Method == http.MethodGet || name == "schema_preview")
}

// 高风险操作不能通过自动执行策略豁免。
func AlwaysConfirm(name string) bool {
	return strings.HasSuffix(name, "_delete") || strings.HasSuffix(name, "_discard") || strings.HasSuffix(name, "_remove") || strings.HasSuffix(name, "_apply") || strings.HasSuffix(name, "_enable") || strings.HasSuffix(name, "_run") || strings.HasSuffix(name, "_test") || strings.HasSuffix(name, "_retry")
}

func bodySchema(name string) map[string]any {
	text := map[string]any{"type": "string"}
	properties := map[string]any{}
	required := []string{}
	switch {
	case strings.HasPrefix(name, "hooks_"):
		properties = map[string]any{"name": text, "language": map[string]any{"type": "string", "enum": []string{"javascript", "typescript"}}, "source": text, "bindings": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{"collectionId": text, "operation": map[string]any{"type": "string", "enum": []string{"create", "update", "delete"}}, "phase": map[string]any{"type": "string", "enum": []string{"before", "afterCommit"}}}, "required": []string{"collectionId", "operation", "phase"}, "additionalProperties": false}}, "secretBindings": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{"alias": text, "secretId": text}, "required": []string{"alias", "secretId"}, "additionalProperties": false}}, "allowedOrigins": map[string]any{"type": "array", "items": text}}
		required = []string{"name", "language", "source", "bindings"}
		if name == "hooks_create" {
			properties = map[string]any{"name": text, "language": map[string]any{"type": "string", "enum": []string{"javascript", "typescript"}}, "source": text}
			required = []string{"name", "language", "source"}
		}
	case strings.HasPrefix(name, "webhooks_"):
		properties = map[string]any{"name": text, "targetUrl": text, "signingSecretId": text}
		required = []string{"name", "targetUrl", "signingSecretId"}
	case strings.HasPrefix(name, "event_hooks_"):
		properties = map[string]any{"name": text, "collectionId": text, "eventType": text, "webhookId": text}
		required = []string{"name", "collectionId", "eventType", "webhookId"}
	case strings.HasPrefix(name, "jobs_"):
		properties = map[string]any{"name": text, "webhookId": text, "cron": text}
		required = []string{"name", "webhookId", "cron"}
	case strings.HasPrefix(name, "authentication_"):
		properties["expectedVersion"] = map[string]any{"type": "integer", "minimum": 1}
		required = []string{"expectedVersion"}
		if name == "authentication_save" {
			properties["configuration"] = map[string]any{"type": "object", "properties": map[string]any{"emailPasswordEnabled": map[string]any{"type": "boolean"}, "selfRegistration": map[string]any{"type": "boolean"}, "sessionDurationDays": map[string]any{"type": "integer", "minimum": 1}, "emailVerification": map[string]any{"type": "string", "enum": []string{"off", "optional", "required"}}}, "required": []string{"emailPasswordEnabled", "selfRegistration", "sessionDurationDays"}, "additionalProperties": false}
			required = append(required, "configuration")
		}
	}
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}
