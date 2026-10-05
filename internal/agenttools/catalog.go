package agenttools

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type Operation struct{ Method, Path, Permission, Purpose string }
type Call struct {
	Method, Path string
	Query        url.Values
	Body         any
}
type Tool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var Operations = map[string]Operation{
	"collections_list":        {Method: http.MethodGet, Path: "/admin/api/v1/collections", Permission: "collections.read", Purpose: "列出当前 Project 的 Collections"},
	"collections_get":         {Method: http.MethodGet, Path: "/admin/api/v1/collections/{collectionId}", Permission: "collections.read", Purpose: "读取 Collection 与其 Applied Model 摘要"},
	"collections_create":      {Method: http.MethodPost, Path: "/admin/api/v1/collections", Permission: "collections.create", Purpose: "创建 Collection 及初始 Model"},
	"records_list":            {Method: http.MethodGet, Path: "/admin/api/v1/collections/{collectionId}/records", Permission: "records.read", Purpose: "按 Applied Model 查询、过滤、排序和分页 Records"},
	"records_get":             {Method: http.MethodGet, Path: "/admin/api/v1/collections/{collectionId}/records/{recordId}", Permission: "records.read", Purpose: "读取一个 Record"},
	"records_create":          {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/records", Permission: "records.create", Purpose: "按 Applied Model 创建 Record"},
	"records_update":          {Method: http.MethodPatch, Path: "/admin/api/v1/collections/{collectionId}/records/{recordId}", Permission: "records.update", Purpose: "按 Applied Model 更新 Record"},
	"records_delete":          {Method: http.MethodDelete, Path: "/admin/api/v1/collections/{collectionId}/records/{recordId}", Permission: "records.delete", Purpose: "删除 Record"},
	"schema_pending_get":      {Method: http.MethodGet, Path: "/admin/api/v1/collections/{collectionId}/schema/pending-change", Permission: "schema.read", Purpose: "读取耐久保存的 Schema Pending Change"},
	"schema_operation_add":    {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/schema/pending-operations", Permission: "schema.write", Purpose: "向 Pending Change 添加一个 Schema operation"},
	"schema_operation_update": {Method: http.MethodPatch, Path: "/admin/api/v1/collections/{collectionId}/schema/pending-operations/{operationId}", Permission: "schema.write", Purpose: "修改 Pending Change 中的 Schema operation"},
	"schema_operation_remove": {Method: http.MethodDelete, Path: "/admin/api/v1/collections/{collectionId}/schema/pending-operations/{operationId}", Permission: "schema.write", Purpose: "从 Pending Change 移除 Schema operation"},
	"schema_preview":          {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/schema/preview", Permission: "schema.read", Purpose: "预览指定版本的 Pending Change"},
	"schema_apply":            {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/schema/apply", Permission: "schema.apply", Purpose: "通过标准 Change lifecycle 应用 Schema"},
	"schema_discard":          {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/schema/discard", Permission: "schema.write", Purpose: "丢弃指定版本的 Schema Pending Change"},
	"schema_history":          {Method: http.MethodGet, Path: "/admin/api/v1/collections/{collectionId}/schema/history", Permission: "schema.read", Purpose: "读取 Applied Model history"},
	"access_rules_get":        {Method: http.MethodGet, Path: "/admin/api/v1/collections/{collectionId}/access-rules", Permission: "accessRules.read", Purpose: "读取 Applied 与 Pending Access Rules"},
	"access_rules_save":       {Method: http.MethodPut, Path: "/admin/api/v1/collections/{collectionId}/access-rules", Permission: "accessRules.write", Purpose: "保存版本化 Access Rule Pending Change"},
	"access_rules_apply":      {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/access-rules/apply", Permission: "accessRules.apply", Purpose: "应用指定版本的 Access Rules"},
	"access_rules_discard":    {Method: http.MethodPost, Path: "/admin/api/v1/collections/{collectionId}/access-rules/discard", Permission: "accessRules.write", Purpose: "丢弃指定版本的 Access Rule Pending Change"},
	"requests_list":           {Method: http.MethodGet, Path: "/admin/api/v1/requests", Permission: "requests.read", Purpose: "查询已脱敏的 Application RequestRecord metadata"},
	"requests_get":            {Method: http.MethodGet, Path: "/admin/api/v1/requests/{requestId}", Permission: "requests.read", Purpose: "读取一个已脱敏的 Application Request Detail"},
	"audit_list":              {Method: http.MethodGet, Path: "/admin/api/v1/audit", Permission: "audit.read", Purpose: "查询耐久 Control Plane AuditRecords"},
	"audit_get":               {Method: http.MethodGet, Path: "/admin/api/v1/audit/{auditRecordId}", Permission: "audit.read", Purpose: "读取一个 Control Plane AuditRecord"},
}

func BuildCall(tool string, arguments map[string]any) (Call, error) {
	operation, supported := Operations[tool]
	if !supported {
		return Call{}, fmt.Errorf("不支持的工具 %q", tool)
	}
	if arguments == nil {
		arguments = map[string]any{}
	}
	call := Call{Method: operation.Method, Path: operation.Path, Query: make(url.Values)}
	addListQuery := func(allowed ...string) error {
		return addMachineListQuery(&call, arguments, nil, allowed...)
	}
	addListQueryWithRouteIDs := func(routeIDs []string, allowed ...string) error {
		return addMachineListQuery(&call, arguments, routeIDs, allowed...)
	}
	addID := func(name string) (string, error) {
		value, ok := arguments[name].(string)
		if !ok || !idPattern.MatchString(value) {
			return "", fmt.Errorf("%s must be a valid Modelry ID", name)
		}
		return url.PathEscape(value), nil
	}
	getBody := func() (any, error) {
		body, ok := arguments["body"].(map[string]any)
		if !ok || body == nil {
			return nil, errors.New("body must be a JSON object matching the documented API request DTO")
		}
		return body, nil
	}
	checkArgs := func(names ...string) error {
		allowed := make(map[string]bool, len(names))
		for _, name := range names {
			allowed[name] = true
		}
		for name := range arguments {
			if !allowed[name] {
				return fmt.Errorf("unsupported argument %q", name)
			}
		}
		return nil
	}
	setRouteID := func(name string) error {
		id, err := addID(name)
		if err != nil {
			return err
		}
		placeholder := "{" + name + "}"
		if !strings.Contains(call.Path, placeholder) {
			return fmt.Errorf("operation %q does not define route parameter %q", tool, name)
		}
		call.Path = strings.Replace(call.Path, placeholder, id, 1)
		return nil
	}
	setBody := func() error {
		body, err := getBody()
		if err != nil {
			return err
		}
		call.Body = body
		return nil
	}

	switch tool {
	case "collections_list":
		if err := addListQuery("limit", "cursor"); err != nil {
			return Call{}, err
		}
	case "collections_get":
		if err := checkArgs("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
	case "collections_create":
		if err := checkArgs("body"); err != nil {
			return Call{}, err
		}
		if body, ok := arguments["body"].(map[string]any); ok {
			if kind, exists := body["type"]; exists && kind != "Normal" && kind != "Auth" {
				return Call{}, errors.New("集合类型只能是 Normal 或 Auth")
			}
		}
		if err := setBody(); err != nil {
			return Call{}, err
		}
	case "records_list":
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := addListQueryWithRouteIDs([]string{"collectionId"}, "limit", "cursor", "search", "filter", "sort"); err != nil {
			return Call{}, err
		}
	case "records_create":
		if err := checkArgs("collectionId", "body"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setBody(); err != nil {
			return Call{}, err
		}
	case "records_get", "records_update", "records_delete":
		if err := checkArgs("collectionId", "recordId", "body"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("recordId"); err != nil {
			return Call{}, err
		}
		switch tool {
		case "records_get":
			if _, exists := arguments["body"]; exists {
				return Call{}, errors.New("body is not accepted for records_get")
			}
		case "records_update":
			if err := setBody(); err != nil {
				return Call{}, err
			}
		case "records_delete":
			if _, exists := arguments["body"]; exists {
				return Call{}, errors.New("body is not accepted for records_delete")
			}
		}
	case "schema_pending_get":
		if err := checkArgs("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
	case "schema_operation_add", "schema_operation_update":
		allowedArgs := []string{"collectionId", "body"}
		if tool == "schema_operation_update" {
			allowedArgs = append(allowedArgs, "operationId")
		}
		if err := checkArgs(allowedArgs...); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if tool == "schema_operation_update" {
			if err := setRouteID("operationId"); err != nil {
				return Call{}, err
			}
		}
		if err := setBody(); err != nil {
			return Call{}, err
		}
	case "schema_operation_remove":
		if err := checkArgs("collectionId", "operationId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("operationId"); err != nil {
			return Call{}, err
		}
	case "schema_preview", "schema_apply", "schema_discard":
		if err := checkArgs("collectionId", "body"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setBody(); err != nil {
			return Call{}, err
		}
	case "schema_history":
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := addListQueryWithRouteIDs([]string{"collectionId"}, "limit", "cursor"); err != nil {
			return Call{}, err
		}
	case "access_rules_get":
		if err := checkArgs("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
	case "access_rules_save", "access_rules_apply", "access_rules_discard":
		if err := checkArgs("collectionId", "body"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("collectionId"); err != nil {
			return Call{}, err
		}
		if err := setBody(); err != nil {
			return Call{}, err
		}
	case "requests_list":
		if err := addListQuery("limit", "cursor", "search", "filter", "sort"); err != nil {
			return Call{}, err
		}
	case "requests_get":
		if err := checkArgs("requestId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("requestId"); err != nil {
			return Call{}, err
		}
	case "audit_list":
		if err := addListQuery("limit", "cursor"); err != nil {
			return Call{}, err
		}
	case "audit_get":
		if err := checkArgs("auditRecordId"); err != nil {
			return Call{}, err
		}
		if err := setRouteID("auditRecordId"); err != nil {
			return Call{}, err
		}
	default:
		if tool == "hooks_runs" || tool == "deliveries_list" {
			queries := []string{"limit", "cursor"}
			if tool == "deliveries_list" {
				queries = append(queries, "sourceType", "status")
			}
			if err := addMachineListQuery(&call, arguments, routeParameters(operation.Path), queries...); err != nil {
				return Call{}, err
			}
			for _, parameter := range routeParameters(operation.Path) {
				if err := setRouteID(parameter); err != nil {
					return Call{}, err
				}
			}
			break
		}
		allowed := []string{}
		for _, name := range routeParameters(operation.Path) {
			allowed = append(allowed, name)
			if err := setRouteID(name); err != nil {
				return Call{}, err
			}
		}
		if operation.Method == http.MethodPut || (operation.Method == http.MethodPost && strings.HasSuffix(operation.Path, "authentication")) {
			allowed = append(allowed, "body")
			if err := setBody(); err != nil {
				return Call{}, err
			}
		} else if operation.Method == http.MethodPost && (tool == "hooks_create" || tool == "webhooks_create" || tool == "event_hooks_create" || tool == "jobs_create") {
			allowed = append(allowed, "body")
			if err := setBody(); err != nil {
				return Call{}, err
			}
		}
		if err := checkArgs(allowed...); err != nil {
			return Call{}, err
		}
	}
	if strings.Contains(call.Path, "{") {
		return Call{}, fmt.Errorf("operation %q has an unresolved route parameter", tool)
	}
	return call, nil
}

func addMachineListQuery(call *Call, arguments map[string]any, allowedRouteIDs []string, allowedQuery ...string) error {
	accepted := make(map[string]bool, len(allowedRouteIDs)+len(allowedQuery))
	for _, name := range allowedRouteIDs {
		accepted[name] = true
	}
	for _, name := range allowedQuery {
		accepted[name] = true
		if value, exists := arguments[name]; exists {
			text := ""
			switch typed := value.(type) {
			case string:
				text = typed
			case json.Number:
				if name != "limit" {
					return fmt.Errorf("%s must be a string no longer than 4096 characters", name)
				}
				text = typed.String()
			case int:
				if name != "limit" {
					return fmt.Errorf("%s must be a string no longer than 4096 characters", name)
				}
				text = strconv.Itoa(typed)
			default:
				return fmt.Errorf("%s must be a string no longer than 4096 characters", name)
			}
			if len(text) > 4096 {
				return fmt.Errorf("%s must be a string no longer than 4096 characters", name)
			}
			if name == "limit" {
				limit, err := strconv.Atoi(text)
				if err != nil || limit < 1 || limit > 100 {
					return errors.New("limit must be between 1 and 100")
				}
			}
			call.Query.Set(name, text)
		}
	}
	for name := range arguments {
		if !accepted[name] {
			return fmt.Errorf("unsupported argument %q", name)
		}
	}
	return nil
}

func Tools() []Tool {
	read := map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true}
	write := map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false}
	destructive := map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}
	id := map[string]any{"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"}
	stringField := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	object := func(properties map[string]any, required ...string) map[string]any {
		if required == nil {
			required = []string{}
		}
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	bodyObject := map[string]any{"type": "object", "additionalProperties": true}
	fieldBody := map[string]any{"type": "object", "properties": map[string]any{
		"name": stringField("Field name"), "type": map[string]any{"type": "string", "enum": []string{"text", "number", "boolean", "dateTime", "json", "relation", "file", "files"}},
		"required": map[string]any{"type": "boolean"}, "unique": map[string]any{"type": "boolean"}, "description": stringField("Field description"), "default": map[string]any{}, "validation": bodyObject, "relation": bodyObject}, "required": []string{"name", "type"}, "additionalProperties": true}
	collectionBody := object(map[string]any{"name": stringField("Collection name"), "type": map[string]any{"type": "string", "enum": []string{"Normal", "Auth"}}, "description": stringField("Collection description"), "fields": map[string]any{"type": "array", "items": fieldBody}, "omitSystemFields": map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": []string{"createdAt", "updatedAt"}}}}, "name", "type")
	operationBody := object(map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"field", "index", "relation"}}, "action": map[string]any{"type": "string", "enum": []string{"add", "update", "remove"}}, "targetId": id, "definition": map[string]any{"type": "object", "description": "Use Field, Index or Relation definition from the formal API; targetId selects existing objects", "additionalProperties": true}}, "kind", "action", "definition")
	listProperties := map[string]any{
		"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
		"cursor": stringField("Opaque cursor returned by the previous page"),
	}
	listTool := func(name, description string, extra map[string]any, required ...string) Tool {
		properties := make(map[string]any, len(listProperties)+len(extra))
		for key, value := range listProperties {
			properties[key] = value
		}
		for key, value := range extra {
			properties[key] = value
		}
		return Tool{Name: name, Description: description, InputSchema: object(properties, required...), Annotations: read}
	}
	collection := map[string]any{"collectionId": id}
	record := map[string]any{"collectionId": id, "recordId": id}
	pageFilters := map[string]any{
		"search": stringField("Applied Model-aware text search"),
		"filter": stringField("One supported field operator and JSON scalar"),
		"sort":   stringField("Comma-separated Applied Field names with optional asc or desc"),
	}
	recordWrite := object(map[string]any{"values": map[string]any{"type": "object", "additionalProperties": true}}, "values")
	versionBody := object(map[string]any{"expectedVersion": map[string]any{"type": "integer", "minimum": 1}}, "expectedVersion")
	applyBody := object(map[string]any{
		"expectedVersion": map[string]any{"type": "integer", "minimum": 1},
		"confirmRisk":     map[string]any{"type": "boolean"},
	}, "expectedVersion")
	tools := []Tool{
		listTool("collections_list", "List Collections in the current Project.", nil),
		{Name: "collections_get", Description: "Read a Collection by ID.", InputSchema: object(collection, "collectionId"), Annotations: read},
		{Name: "collections_create", Description: "Create a Collection with its initial Model. Collection type is case-sensitive: Normal or Auth.", InputSchema: object(map[string]any{"body": collectionBody}, "body"), Annotations: write},
		listTool("records_list", "List Records in a Collection with bounded search, filter, sort, and paging.", mergeSchemaProperties(collection, pageFilters), "collectionId"),
		{Name: "records_get", Description: "Read a Record from a Collection.", InputSchema: object(record, "collectionId", "recordId"), Annotations: read},
		{Name: "records_create", Description: "Create a Record using the Applied Model; Runtime-managed fields are not writable.", InputSchema: object(map[string]any{"collectionId": id, "body": recordWrite}, "collectionId", "body"), Annotations: write},
		{Name: "records_update", Description: "Update a Record through the applied Record API.", InputSchema: object(map[string]any{"collectionId": id, "recordId": id, "body": recordWrite}, "collectionId", "recordId", "body"), Annotations: write},
		{Name: "records_delete", Description: "Delete a Record through the applied Record API.", InputSchema: object(record, "collectionId", "recordId"), Annotations: destructive},
		{Name: "schema_pending_get", Description: "Read the durable Schema Pending Change for a Collection.", InputSchema: object(collection, "collectionId"), Annotations: read},
		{Name: "schema_operation_add", Description: "Add a Field, Relation, or Index operation to the durable Pending Change.", InputSchema: object(map[string]any{"collectionId": id, "body": operationBody}, "collectionId", "body"), Annotations: write},
		{Name: "schema_operation_update", Description: "Update an operation in the durable Schema Pending Change.", InputSchema: object(map[string]any{"collectionId": id, "operationId": id, "body": operationBody}, "collectionId", "operationId", "body"), Annotations: write},
		{Name: "schema_operation_remove", Description: "Remove an operation from the durable Schema Pending Change.", InputSchema: object(map[string]any{"collectionId": id, "operationId": id}, "collectionId", "operationId"), Annotations: destructive},
		{Name: "schema_preview", Description: "Preview the durable Pending Change at an expected version.", InputSchema: object(map[string]any{"collectionId": id, "body": versionBody}, "collectionId", "body"), Annotations: read},
		{Name: "schema_apply", Description: "Apply the reviewed Schema Pending Change through the standard Change lifecycle.", InputSchema: object(map[string]any{"collectionId": id, "body": applyBody}, "collectionId", "body"), Annotations: destructive},
		{Name: "schema_discard", Description: "Discard the Schema Pending Change using its expected version.", InputSchema: object(map[string]any{"collectionId": id, "body": versionBody}, "collectionId", "body"), Annotations: destructive},
		listTool("schema_history", "List Applied Model history for a Collection.", collection, "collectionId"),
		{Name: "access_rules_get", Description: "Read applied and pending Access Rules for a Collection.", InputSchema: object(collection, "collectionId"), Annotations: read},
		{Name: "access_rules_save", Description: "Save a versioned Access Rule Pending Change; rules continue to govern Application Data Plane access.", InputSchema: object(map[string]any{"collectionId": id, "body": bodyObject}, "collectionId", "body"), Annotations: write},
		{Name: "access_rules_apply", Description: "Apply saved Access Rule changes at the expected version.", InputSchema: object(map[string]any{"collectionId": id, "body": versionBody}, "collectionId", "body"), Annotations: destructive},
		{Name: "access_rules_discard", Description: "Discard Access Rule changes at the expected version.", InputSchema: object(map[string]any{"collectionId": id, "body": versionBody}, "collectionId", "body"), Annotations: destructive},
		listTool("requests_list", "List safe Application RequestRecord metadata.", pageFilters),
		{Name: "requests_get", Description: "Read one safe Application Request Detail by canonical request ID.", InputSchema: object(map[string]any{"requestId": id}, "requestId"), Annotations: read},
		listTool("audit_list", "List durable Control Plane AuditRecords.", nil),
		{Name: "audit_get", Description: "Read one durable Control Plane AuditRecord.", InputSchema: object(map[string]any{"auditRecordId": id}, "auditRecordId"), Annotations: read},
	}
	tools = append(tools, additionalTools()...)
	for index := range tools {
		if info, exists := Operations[tools[index].Name]; exists {
			tools[index].Description = strings.TrimSpace(tools[index].Description) + " Canonical API: `" + info.Method + " " + info.Path + "`. Required Permission: `" + info.Permission + "`. Purpose: " + info.Purpose + ". The Modelry Runtime enforces this Permission and returns structured denial details when access is denied."
		}
	}
	return tools
}

func mergeSchemaProperties(first, second map[string]any) map[string]any {
	result := make(map[string]any, len(first)+len(second))
	for key, value := range first {
		result[key] = value
	}
	for key, value := range second {
		result[key] = value
	}
	return result
}
