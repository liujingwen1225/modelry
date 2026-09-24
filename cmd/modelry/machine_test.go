package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestMachineOperationsUseOnlyFixedContractRoutes(t *testing.T) {
	tests := []struct {
		name     string
		tool     string
		args     map[string]any
		method   string
		path     string
		wantFail bool
	}{
		{name: "schema apply", tool: "schema_apply", args: map[string]any{"collectionId": "col_123", "body": map[string]any{"expectedVersion": 2}}, method: http.MethodPost, path: "/admin/api/v1/collections/col_123/schema/apply"},
		{name: "access rules save", tool: "access_rules_save", args: map[string]any{"collectionId": "col_123", "body": map[string]any{"expectedVersion": 1, "rules": []any{}}}, method: http.MethodPut, path: "/admin/api/v1/collections/col_123/access-rules"},
		{name: "request detail", tool: "requests_get", args: map[string]any{"requestId": "req_123"}, method: http.MethodGet, path: "/admin/api/v1/requests/req_123"},
		{name: "reject path injection", tool: "records_get", args: map[string]any{"collectionId": "col_123/../../audit", "recordId": "rec_123"}, wantFail: true},
		{name: "reject ignored arguments", tool: "schema_operation_add", args: map[string]any{"collectionId": "col_123", "operationId": "op_123", "body": map[string]any{}}, wantFail: true},
		{name: "reject method/path forwarding", tool: "http_request", args: map[string]any{"method": "DELETE", "path": "/admin/api/v1/service-accounts"}, wantFail: true},
		{name: "reject extra args", tool: "audit_list", args: map[string]any{"limit": 10, "path": "/secret"}, wantFail: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			call, err := buildMachineAPICall(test.tool, test.args)
			if test.wantFail {
				if err == nil {
					t.Fatalf("expected operation to be rejected, got %+v", call)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if call.method != test.method || call.path != test.path {
				t.Fatalf("route = %s %s, want %s %s", call.method, call.path, test.method, test.path)
			}
		})
	}
}

func TestMachineOperationCatalogMatchesEveryFixedRoute(t *testing.T) {
	if len(machineCLIActions) != len(machineOperationCatalog) {
		t.Fatalf("CLI actions=%d operation catalog=%d", len(machineCLIActions), len(machineOperationCatalog))
	}
	seenCLI := make(map[string]bool, len(machineCLIActions))
	for _, action := range machineCLIActions {
		if _, exists := machineOperationCatalog[action.tool]; !exists || seenCLI[action.tool] {
			t.Errorf("CLI action %q has no unique fixed route mapping", action.command)
		}
		seenCLI[action.tool] = true
	}
	for tool, info := range machineOperationCatalog {
		arguments := make(map[string]any)
		path := info.path
		if strings.Contains(path, "{collectionId}") {
			arguments["collectionId"] = "col_123"
			path = strings.ReplaceAll(path, "{collectionId}", "col_123")
		}
		if strings.Contains(path, "{recordId}") {
			arguments["recordId"] = "rec_123"
			path = strings.ReplaceAll(path, "{recordId}", "rec_123")
		}
		if strings.Contains(path, "{operationId}") {
			arguments["operationId"] = "op_123"
			path = strings.ReplaceAll(path, "{operationId}", "op_123")
		}
		if strings.Contains(path, "{requestId}") {
			arguments["requestId"] = "req_123"
			path = strings.ReplaceAll(path, "{requestId}", "req_123")
		}
		if strings.Contains(path, "{auditRecordId}") {
			arguments["auditRecordId"] = "aud_123"
			path = strings.ReplaceAll(path, "{auditRecordId}", "aud_123")
		}
		if info.method == http.MethodPost || info.method == http.MethodPut || info.method == http.MethodPatch {
			arguments["body"] = map[string]any{}
		}
		switch tool {
		case "collections_list", "records_list", "schema_history", "requests_list", "audit_list":
			arguments["limit"] = 10
		}
		call, err := buildMachineAPICall(tool, arguments)
		if err != nil {
			t.Errorf("%s rejected by its fixed operation contract: %v", tool, err)
			continue
		}
		if call.method != info.method || call.path != path || !strings.HasPrefix(call.path, "/admin/api/v1/") {
			t.Errorf("%s route=%s %s, want %s %s", tool, call.method, call.path, info.method, path)
		}
	}
}

func TestAdminCLIUsesExplicitBearerAndActionableStructuredError(t *testing.T) {
	var capturedPath, capturedAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		capturedPath = request.URL.Path + "?" + request.URL.RawQuery
		capturedAuthorization = request.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"code":"FORBIDDEN","message":"Permission denied","hint":"Check Service Account Permission","requestId":"req_12345678","details":{"requiredPermission":"accessRules.apply"}}}`)
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	code := runAdmin([]string{
		"--api-url", server.URL, "access", "apply", "col_123",
		"--api-key", "one-time-client-key", "--data", `{"expectedVersion":1}`,
	}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit code=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if capturedPath != "/admin/api/v1/collections/col_123/access-rules/apply?" || capturedAuthorization != "Bearer one-time-client-key" {
		t.Fatalf("request was not the fixed protected operation: path=%q auth=%q", capturedPath, capturedAuthorization)
	}
	if !strings.Contains(stderr.String(), `"code": "FORBIDDEN"`) || !strings.Contains(stderr.String(), "Permission denied") || !strings.Contains(stderr.String(), "Check Service Account Permission") || !strings.Contains(stderr.String(), "req_12345678") || !strings.Contains(stderr.String(), "accessRules.apply") {
		t.Fatalf("CLI lost actionable API error: %s", stderr.String())
	}
	if strings.Contains(stderr.String(), "one-time-client-key") || strings.Contains(stdout.String(), "one-time-client-key") {
		t.Fatalf("CLI leaked its API key: stdout=%s stderr=%s", stdout.String(), stderr.String())
	}
}

func TestAdminCLIRejectsArbitraryRouteAndRequiresConnectionConfig(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runAdmin([]string{"get", "/admin/api/v1/collections"}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "unsupported admin resource group") {
		t.Fatalf("arbitrary route command was not rejected: code=%d stderr=%s", code, stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAdmin([]string{"collections", "list"}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "MODELRY_API_URL") {
		t.Fatalf("missing endpoint/key did not produce configuration guidance: code=%d stderr=%s", code, stderr.String())
	}
}

func TestMainCommandExposesAdminHelpWithoutProjectRuntime(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"admin", "--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("admin help exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "collections list") || stderr.Len() != 0 {
		t.Fatalf("admin command was not exposed by the CLI: stdout=%s stderr=%s", stdout.String(), stderr.String())
	}
}

func TestMCPStdioNegotiatesToolsAndCallsCanonicalHTTPOnly(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls++
		if request.URL.Path == "/admin/api/v1/collections" {
			if request.Method != http.MethodGet || request.Header.Get("Authorization") != "Bearer mcp-secret" {
				t.Errorf("unexpected MCP API request: %s %s auth=%q", request.Method, request.URL, request.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"id":"col_123","name":"posts"}]}`)
			return
		}
		if request.URL.Path == "/admin/api/v1/collections/col_123/schema/apply" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":{"code":"FORBIDDEN","message":"Permission denied","hint":"Check Service Account Permission","requestId":"req_12345678","details":{"requiredPermission":"schema.apply"}}}`)
			return
		}
		t.Errorf("MCP called an unapproved path: %s %s", request.Method, request.URL.Path)
		http.NotFound(w, request)
	}))
	defer server.Close()
	client, err := newMachineAPIClient(server.URL, "mcp-secret")
	if err != nil {
		t.Fatal(err)
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"collections_list","arguments":{"limit":10}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"schema_apply","arguments":{"collectionId":"col_123","body":{"expectedVersion":1}}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"records_get","arguments":{"collectionId":"col_123/../../audit","recordId":"rec_123"}}}`,
	}, "\n") + "\n"
	var stdout, stderr bytes.Buffer
	if err := serveMCP(strings.NewReader(input), &stdout, &stderr, client, "test"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("HTTP call count=%d, want only the two valid fixed operations", calls)
	}
	if stderr.Len() != 0 {
		t.Fatalf("MCP diagnostics unexpectedly reported an error: %s", stderr.String())
	}
	reader := bufio.NewReader(&stdout)
	responses := make([]map[string]json.RawMessage, 0, 5)
	for index := 0; index < 5; index++ {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatalf("MCP output ended before response %d: %v", index+1, err)
		}
		var response map[string]json.RawMessage
		if err := json.Unmarshal(bytes.TrimSpace(line), &response); err != nil {
			t.Fatalf("stdout contains non-JSON-RPC data: %q: %v", line, err)
		}
		if string(response["jsonrpc"]) != `"2.0"` {
			t.Fatalf("response %d has invalid protocol marker: %s", index+1, line)
		}
		responses = append(responses, response)
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("stdio server wrote unexpected extra output: %v", err)
	}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(responses[0]["result"], &initialized); err != nil || initialized.ProtocolVersion != mcpProtocolVersion {
		t.Fatalf("unexpected MCP initialization: %#v err=%v", initialized, err)
	}
	var tools struct {
		Tools []mcpTool `json:"tools"`
	}
	if err := json.Unmarshal(responses[1]["result"], &tools); err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) < 20 {
		t.Fatalf("core MCP tool set is incomplete: %d tools", len(tools.Tools))
	}
	if len(tools.Tools) != len(machineOperationCatalog) {
		t.Fatalf("MCP tools=%d operation catalog=%d", len(tools.Tools), len(machineOperationCatalog))
	}
	for _, tool := range tools.Tools {
		info, exists := machineOperationCatalog[tool.Name]
		if !exists || !strings.Contains(tool.Description, info.method+" "+info.path) || !strings.Contains(tool.Description, info.permission) {
			t.Errorf("MCP tool %q is missing its canonical path or Permission: %q", tool.Name, tool.Description)
		}
	}
	if _, hasError := responses[2]["error"]; hasError {
		t.Fatalf("collection list tool failed: %s", responses[2]["error"])
	}
	var denied struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Error struct {
					Code      string         `json:"code"`
					Message   string         `json:"message"`
					Hint      string         `json:"hint"`
					RequestID string         `json:"requestId"`
					Details   map[string]any `json:"details"`
				} `json:"error"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(encodeRawResponse(responses[3]), &denied); err != nil {
		t.Fatal(err)
	}
	apiError := denied.Result.StructuredContent.Error
	if !denied.Result.IsError || apiError.Code != "FORBIDDEN" || apiError.Message != "Permission denied" || apiError.Hint != "Check Service Account Permission" || apiError.RequestID != "req_12345678" || apiError.Details["requiredPermission"] != "schema.apply" {
		t.Fatalf("structured API denial was not returned as an MCP tool error: %#v", denied)
	}
	if _, hasError := responses[4]["error"]; !hasError {
		t.Fatalf("invalid path argument did not return a JSON-RPC argument error: %s", encodeRawResponse(responses[4]))
	}
}

func TestAdminHelpListsFixedRoutesAndPermissions(t *testing.T) {
	var output bytes.Buffer
	printAdminUsage(&output)
	for _, required := range []string{
		"collections list",
		"GET /admin/api/v1/collections (collections.read)",
		"records create <collectionId>",
		"POST /admin/api/v1/collections/{collectionId}/records (records.create)",
		"schema apply <collectionId>",
		"POST /admin/api/v1/collections/{collectionId}/schema/apply (schema.apply)",
		"audit get <auditRecordId>",
	} {
		if !strings.Contains(output.String(), required) {
			t.Errorf("admin help does not document %q: %s", required, output.String())
		}
	}
}

func TestMCPInvalidRequestWithoutIDReturnsNullIDError(t *testing.T) {
	server := &mcpServer{version: "test"}
	response, send := server.handle([]byte(`{"jsonrpc":"1.0"}`))
	if !send {
		t.Fatal("invalid request without id did not produce a JSON-RPC error")
	}
	var parsed struct {
		ID    json.RawMessage `json:"id"`
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response, &parsed); err != nil {
		t.Fatal(err)
	}
	if string(parsed.ID) != "null" || parsed.Error.Code != -32600 {
		t.Fatalf("invalid request response = %s", response)
	}
}

func encodeRawResponse(response map[string]json.RawMessage) []byte {
	encoded, _ := json.Marshal(response)
	return encoded
}

func TestMachineURLRejectsEmbeddedCredentialsAndPathPrefixes(t *testing.T) {
	for _, value := range []string{"http://user:secret@localhost:8080", "http://localhost:8080/proxy", "file:///tmp/project"} {
		if _, err := newMachineAPIClient(value, "key"); err == nil {
			t.Errorf("accepted unsafe API URL %q", value)
		}
	}
	parsed, err := url.Parse("https://modelry.example")
	if err != nil || parsed.Host == "" {
		t.Fatalf("test URL invalid: %v", err)
	}
}
