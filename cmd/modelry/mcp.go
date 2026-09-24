package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const mcpProtocolVersion = "2025-11-25"
const mcpMaxMessageBytes = 2 << 20

type mcpTool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

type mcpContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type mcpToolResult struct {
	Content           []mcpContent `json:"content"`
	IsError           bool         `json:"isError,omitempty"`
	StructuredContent any          `json:"structuredContent,omitempty"`
}

type mcpRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpRPCError    `json:"error,omitempty"`
}

type mcpRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpServer struct {
	client             *machineAPIClient
	initializeReceived bool
	initialized        bool
	version            string
}

func runMCP(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "--help" {
		_, _ = fmt.Fprintln(stdout, "Usage: modelry mcp [--api-url URL] [--api-key KEY]")
		_, _ = fmt.Fprintln(stdout, "Runs the Modelry Core MCP server over newline-delimited JSON-RPC on stdio.")
		return 0
	}
	positionals, flags, err := parseMachineFlags(args)
	if err != nil || len(positionals) != 0 {
		message := "MCP server accepts only --api-url and --api-key"
		if err != nil {
			message = err.Error()
		}
		printMachineCLIError(stderr, "INVALID_ARGUMENT", message, "Run modelry mcp --help for usage")
		return 2
	}
	for name := range flags {
		if name != "api-url" && name != "api-key" {
			printMachineCLIError(stderr, "INVALID_ARGUMENT", "MCP server accepts only --api-url and --api-key", "Set connection options before starting stdio")
			return 2
		}
	}
	apiURL, apiKey := machineConfig(flags)
	client, err := newMachineAPIClient(apiURL, apiKey)
	if err != nil {
		printMachineCLIError(stderr, "CONFIGURATION_ERROR", err.Error(), "Set MODELRY_API_URL and MODELRY_API_KEY, or use --api-url and --api-key")
		return 2
	}
	if err := serveMCP(stdin, stdout, stderr, client, version); err != nil {
		_, _ = fmt.Fprintln(stderr, "MCP stdio server stopped after an input/output error")
		return 1
	}
	return 0
}

func serveMCP(stdin io.Reader, stdout, stderr io.Writer, client *machineAPIClient, serverVersion string) error {
	if client == nil {
		return errors.New("Modelry API client is required")
	}
	server := &mcpServer{client: client, version: serverVersion}
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 4096), mcpMaxMessageBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		response, send := server.handle(line)
		if !send {
			continue
		}
		if _, err := stdout.Write(response); err != nil {
			return err
		}
		if _, err := stdout.Write([]byte{'\n'}); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		if err == bufio.ErrTooLong {
			_, _ = fmt.Fprintln(stderr, "MCP JSON-RPC message exceeded the 2 MiB limit")
		}
		return err
	}
	return nil
}

func (server *mcpServer) handle(line []byte) ([]byte, bool) {
	var request mcpRPCRequest
	if err := json.Unmarshal(line, &request); err != nil {
		return encodeMCPResponse(mcpRPCResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &mcpRPCError{Code: -32700, Message: "Parse error"}}), true
	}
	if request.JSONRPC != "2.0" || request.Method == "" {
		return server.reply(request.ID, nil, &mcpRPCError{Code: -32600, Message: "Invalid Request"}), true
	}
	if len(request.ID) != 0 && !validMCPRequestID(request.ID) {
		return server.reply(json.RawMessage("null"), nil, &mcpRPCError{Code: -32600, Message: "Invalid Request ID"}), true
	}
	if len(request.ID) == 0 {
		if request.Method == "notifications/initialized" && server.initializeReceived {
			server.initialized = true
		}
		return nil, false
	}
	switch request.Method {
	case "initialize":
		return server.initialize(request)
	case "ping":
		return server.reply(request.ID, map[string]any{}, nil), true
	case "tools/list":
		if !server.initialized {
			return server.reply(request.ID, nil, &mcpRPCError{Code: -32002, Message: "Server not initialized"}), true
		}
		return server.reply(request.ID, map[string]any{"tools": modelryMCPTools()}, nil), true
	case "tools/call":
		if !server.initialized {
			return server.reply(request.ID, nil, &mcpRPCError{Code: -32002, Message: "Server not initialized"}), true
		}
		return server.callTool(request)
	default:
		return server.reply(request.ID, nil, &mcpRPCError{Code: -32601, Message: "Method not found"}), true
	}
}

func validMCPRequestID(raw json.RawMessage) bool {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return false
	}
	switch id := value.(type) {
	case string:
		return len(id) > 0 && len(id) <= 256
	case json.Number:
		return true
	default:
		return false
	}
}

func (server *mcpServer) initialize(request mcpRPCRequest) ([]byte, bool) {
	server.initialized = false
	server.initializeReceived = false
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if len(request.Params) == 0 || json.Unmarshal(request.Params, &params) != nil || strings.TrimSpace(params.ProtocolVersion) == "" {
		return server.reply(request.ID, nil, &mcpRPCError{Code: -32602, Message: "initialize params are invalid"}), true
	}
	server.initializeReceived = true
	return server.reply(request.ID, map[string]any{
		"protocolVersion": mcpProtocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo": map[string]any{
			"name":    "modelry",
			"version": server.version,
		},
	}, nil), true
}

func (server *mcpServer) callTool(request mcpRPCRequest) ([]byte, bool) {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	decoder := json.NewDecoder(bytes.NewReader(request.Params))
	decoder.UseNumber()
	if len(request.Params) == 0 || decoder.Decode(&params) != nil || params.Name == "" {
		return server.reply(request.ID, nil, &mcpRPCError{Code: -32602, Message: "tools/call requires a tool name and object arguments"}), true
	}
	if params.Arguments == nil {
		params.Arguments = map[string]any{}
	}
	call, err := buildMachineAPICall(params.Name, params.Arguments)
	if err != nil {
		return server.reply(request.ID, nil, &mcpRPCError{Code: -32602, Message: err.Error()}), true
	}
	result, problem := server.client.execute(context.Background(), call)
	var payload any
	if problem != nil {
		payload = problem.output()
		return server.reply(request.ID, machineResult(payload, true), nil), true
	}
	return server.reply(request.ID, machineResult(result, false), nil), true
}

func machineResult(value any, failed bool) mcpToolResult {
	encoded, err := json.Marshal(value)
	if err != nil {
		encoded = []byte(`{"error":{"code":"OUTPUT_ERROR","message":"The tool result could not be encoded"}}`)
		failed = true
	}
	return mcpToolResult{
		Content:           []mcpContent{{Type: "text", Text: string(encoded)}},
		IsError:           failed,
		StructuredContent: value,
	}
}

func (server *mcpServer) reply(id json.RawMessage, result any, rpcError *mcpRPCError) []byte {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return encodeMCPResponse(mcpRPCResponse{JSONRPC: "2.0", ID: id, Result: result, Error: rpcError})
}

func encodeMCPResponse(response mcpRPCResponse) []byte {
	encoded, err := json.Marshal(response)
	if err != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}`)
	}
	return encoded
}

func modelryMCPTools() []mcpTool {
	read := map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true}
	write := map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false}
	destructive := map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false}
	id := map[string]any{"type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$"}
	stringField := func(description string) map[string]any {
		return map[string]any{"type": "string", "description": description}
	}
	object := func(properties map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	bodyObject := map[string]any{"type": "object", "additionalProperties": true}
	listProperties := map[string]any{
		"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100},
		"cursor": stringField("Opaque cursor returned by the previous page"),
	}
	listTool := func(name, description string, extra map[string]any, required ...string) mcpTool {
		properties := make(map[string]any, len(listProperties)+len(extra))
		for key, value := range listProperties {
			properties[key] = value
		}
		for key, value := range extra {
			properties[key] = value
		}
		return mcpTool{Name: name, Description: description, InputSchema: object(properties, required...), Annotations: read}
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
	tools := []mcpTool{
		listTool("collections_list", "List Collections in the current Project.", nil),
		{Name: "collections_get", Description: "Read a Collection by ID.", InputSchema: object(collection, "collectionId"), Annotations: read},
		{Name: "collections_create", Description: "Create a Collection with its initial Model.", InputSchema: object(map[string]any{"body": bodyObject}, "body"), Annotations: write},
		listTool("records_list", "List Records in a Collection with bounded search, filter, sort, and paging.", mergeSchemaProperties(collection, pageFilters), "collectionId"),
		{Name: "records_get", Description: "Read a Record from a Collection.", InputSchema: object(record, "collectionId", "recordId"), Annotations: read},
		{Name: "records_create", Description: "Create a Record using the Applied Model; Runtime-managed fields are not writable.", InputSchema: object(map[string]any{"collectionId": id, "body": recordWrite}, "collectionId", "body"), Annotations: write},
		{Name: "records_update", Description: "Update a Record through the applied Record API.", InputSchema: object(map[string]any{"collectionId": id, "recordId": id, "body": recordWrite}, "collectionId", "recordId", "body"), Annotations: write},
		{Name: "records_delete", Description: "Delete a Record through the applied Record API.", InputSchema: object(record, "collectionId", "recordId"), Annotations: destructive},
		{Name: "schema_pending_get", Description: "Read the durable Schema Pending Change for a Collection.", InputSchema: object(collection, "collectionId"), Annotations: read},
		{Name: "schema_operation_add", Description: "Add a Field, Relation, or Index operation to the durable Pending Change.", InputSchema: object(map[string]any{"collectionId": id, "body": bodyObject}, "collectionId", "body"), Annotations: write},
		{Name: "schema_operation_update", Description: "Update an operation in the durable Schema Pending Change.", InputSchema: object(map[string]any{"collectionId": id, "operationId": id, "body": bodyObject}, "collectionId", "operationId", "body"), Annotations: write},
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
	for index := range tools {
		if info, exists := machineOperationCatalog[tools[index].Name]; exists {
			tools[index].Description = strings.TrimSpace(tools[index].Description) + " Canonical API: `" + info.method + " " + info.path + "`. Required Permission: `" + info.permission + "`. Purpose: " + info.purpose + ". The Modelry Runtime enforces this Permission and returns structured denial details when access is denied."
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
