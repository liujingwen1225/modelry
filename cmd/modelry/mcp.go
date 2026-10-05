package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/liujingwen1225/modelry/internal/agenttools"
	"io"
	"strings"
)

const mcpProtocolVersion = "2025-11-25"
const mcpMaxMessageBytes = 2 << 20

type mcpTool = agenttools.Tool

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
	sessionID          string
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

	var result any
	var problem *machineAPIError
	if params.Name == "agent_operation_get" {
		id, ok := params.Arguments["operationId"].(string)
		if !ok || !machineIDPattern.MatchString(id) || len(params.Arguments) != 1 {
			return server.reply(request.ID, nil, &mcpRPCError{Code: -32602, Message: "operationId 无效"}), true
		}
		result, problem = server.client.execute(context.Background(), machineAPICall{method: "GET", path: "/admin/api/v1/agent/operations/" + id})
	} else if params.Name == "agent_session_get" {
		if len(params.Arguments) != 0 {
			return server.reply(request.ID, nil, &mcpRPCError{Code: -32602, Message: "不接受附加参数"}), true
		}
		if server.sessionID == "" {
			result = map[string]any{"sessionId": "", "hint": "先调用任一业务工具创建会话"}
		} else {
			result, problem = server.client.execute(context.Background(), machineAPICall{method: "GET", path: "/admin/api/v1/agent/sessions/" + server.sessionID})
		}
	} else {
		if _, err := agenttools.BuildCall(params.Name, params.Arguments); err != nil {
			return server.reply(request.ID, nil, &mcpRPCError{Code: -32602, Message: err.Error()}), true
		}
		if server.sessionID == "" {
			created, createProblem := server.client.execute(context.Background(), machineAPICall{method: "POST", path: "/admin/api/v1/agent/sessions", body: map[string]any{"title": "MCP 智能体会话"}})
			if createProblem != nil {
				return server.reply(request.ID, machineResult(createProblem.output(), true), nil), true
			}
			envelope, _ := created.(map[string]any)
			data, _ := envelope["data"].(map[string]any)
			server.sessionID, _ = data["id"].(string)
			if server.sessionID == "" {
				return server.reply(request.ID, machineResult(map[string]any{"error": "无效的会话响应"}, true), nil), true
			}
		}
		result, problem = server.client.execute(context.Background(), machineAPICall{method: "POST", path: "/admin/api/v1/agent/sessions/" + server.sessionID + "/tools", body: map[string]any{"name": params.Name, "arguments": params.Arguments}})
	}
	if problem != nil {
		if problem.Details == nil {
			problem.Details = map[string]any{}
		}
		problem.Details["sessionId"] = server.sessionID
		problem.Details["reviewUrl"] = server.client.baseURL + "/agent?session=" + server.sessionID
		return server.reply(request.ID, machineResult(problem.output(), true), nil), true
	}

	if envelope, ok := result.(map[string]any); ok {
		if data, ok := envelope["data"].(map[string]any); ok {
			if review, ok := data["reviewUrl"].(string); ok && strings.HasPrefix(review, "/agent?") {
				data["reviewUrl"] = server.client.baseURL + review
			}
		}
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
	tools := agenttools.Tools()
	for i := range tools {
		tools[i].Description += " 内置 Agent 与 MCP 共用执行层；写操作依据身份策略返回 approvalRequired，需 Owner 在 reviewUrl 确认；高风险操作始终确认。"
	}
	tools = append(tools, mcpTool{Name: "agent_operation_get", Description: "查询本账号提出的操作状态与真实执行结果；不能批准操作", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"operationId": map[string]any{"type": "string"}}, "required": []string{"operationId"}, "additionalProperties": false}}, mcpTool{Name: "agent_session_get", Description: "查询本 MCP 会话及审核链接；数据授权在 Admin 完成", InputSchema: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}})
	return tools
}
