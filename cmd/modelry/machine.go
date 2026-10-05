package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/liujingwen1225/modelry/internal/agenttools"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const machineMaxResponseBytes = 8 << 20

var machineIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type machineAPIClient struct {
	baseURL string
	key     string
	http    *http.Client
}

type machineAPICall struct {
	method string
	path   string
	query  url.Values
	body   any
}

type machineAPIError struct {
	Status    int            `json:"status"`
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Hint      string         `json:"hint,omitempty"`
	RequestID string         `json:"requestId,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

type machineOperationInfo struct {
	method     string
	path       string
	permission string
	purpose    string
}

var machineOperationCatalog = func() map[string]machineOperationInfo {
	result := map[string]machineOperationInfo{}
	for _, action := range machineCLIActions {
		name := action.tool
		op := agenttools.Operations[name]
		result[name] = machineOperationInfo{op.Method, op.Path, op.Permission, op.Purpose}
	}
	return result
}()

func newMachineAPIClient(apiURL, apiKey string) (*machineAPIClient, error) {
	apiURL = strings.TrimRight(strings.TrimSpace(apiURL), "/")
	apiKey = strings.TrimSpace(apiKey)
	parsed, err := url.Parse(apiURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("API URL must be an absolute http(s) origin without credentials, query, fragment, or path prefix")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("API key is required; pass --api-key or set MODELRY_API_KEY")
	}
	return &machineAPIClient{
		baseURL: apiURL,
		key:     apiKey,
		http: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func machineConfig(flags map[string]string) (string, string) {
	apiURL := flags["api-url"]
	if apiURL == "" {
		apiURL = os.Getenv("MODELRY_API_URL")
	}
	apiKey := flags["api-key"]
	if apiKey == "" {
		apiKey = os.Getenv("MODELRY_API_KEY")
	}
	return apiURL, apiKey
}

func (client *machineAPIClient) execute(ctx context.Context, call machineAPICall) (any, *machineAPIError) {
	requestURL, err := url.Parse(client.baseURL + call.path)
	if err != nil {
		return nil, &machineAPIError{Code: "INVALID_API_URL", Message: "The configured Modelry API URL is invalid", Hint: "Check MODELRY_API_URL or --api-url"}
	}
	requestURL.RawQuery = call.query.Encode()
	var body io.Reader
	if call.body != nil {
		encoded, err := json.Marshal(call.body)
		if err != nil {
			return nil, &machineAPIError{Code: "INVALID_REQUEST", Message: "The request body could not be encoded as JSON"}
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, call.method, requestURL.String(), body)
	if err != nil {
		return nil, &machineAPIError{Code: "INVALID_REQUEST", Message: "The API request could not be prepared"}
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.key)
	if call.body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.http.Do(request)
	if err != nil {
		return nil, &machineAPIError{Code: "NETWORK_ERROR", Message: "Modelry could not be reached", Hint: "Check the Runtime URL and network connection"}
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, machineMaxResponseBytes+1))
	if err != nil || len(responseBody) > machineMaxResponseBytes {
		return nil, &machineAPIError{Status: response.StatusCode, Code: "RESPONSE_TOO_LARGE", Message: "The Modelry response could not be read safely", Hint: "Retry with a smaller page limit"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, decodeMachineAPIError(response.StatusCode, responseBody)
	}
	if response.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(responseBody)) == 0 {
		return map[string]any{}, nil
	}
	var result any
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		return nil, &machineAPIError{Status: response.StatusCode, Code: "INVALID_RESPONSE", Message: "Modelry returned an unreadable API response"}
	}
	return result, nil
}

func decodeMachineAPIError(status int, body []byte) *machineAPIError {
	problem := &machineAPIError{Status: status, Code: "HTTP_ERROR", Message: "Modelry rejected the request"}
	var envelope struct {
		Error struct {
			Code      string         `json:"code"`
			Message   string         `json:"message"`
			Hint      string         `json:"hint"`
			RequestID string         `json:"requestId"`
			Details   map[string]any `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error.Code != "" {
		problem.Code = envelope.Error.Code
		problem.Message = envelope.Error.Message
		problem.Hint = envelope.Error.Hint
		problem.RequestID = envelope.Error.RequestID
		problem.Details = envelope.Error.Details
	}
	if problem.Hint == "" {
		switch status {
		case http.StatusUnauthorized:
			problem.Hint = "Check the API key and whether its Service Account is active"
		case http.StatusForbidden:
			problem.Hint = "Check that the API key's Permission allows this operation"
		case http.StatusNotFound:
			problem.Hint = "Check the resource ID and confirm it exists in this Runtime"
		case http.StatusConflict:
			problem.Hint = "Read the current resource state and retry with its latest version"
		case http.StatusServiceUnavailable:
			problem.Hint = "Check Runtime and project storage health, then retry"
		}
	}
	return problem
}

func (problem *machineAPIError) Error() string { return problem.Message }

func (problem *machineAPIError) output() any {
	return map[string]any{"error": problem}
}

func buildMachineAPICall(tool string, arguments map[string]any) (machineAPICall, error) {
	call, err := agenttools.BuildCall(tool, arguments)
	return machineAPICall{method: call.Method, path: call.Path, query: call.Query, body: call.Body}, err
}

func runAdmin(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "--help" {
		printAdminUsage(stdout)
		return 0
	}
	positionals, flags, err := parseMachineFlags(args)
	if err != nil {
		printMachineCLIError(stderr, "INVALID_ARGUMENT", err.Error(), "Run modelry admin --help to see supported operations")
		return 2
	}
	tool, arguments, err := adminCommand(positionals, flags)
	if err != nil {
		printMachineCLIError(stderr, "INVALID_ARGUMENT", err.Error(), "Use a documented Modelry resource operation; arbitrary HTTP paths are not accepted")
		return 2
	}
	apiURL, apiKey := machineConfig(flags)
	client, err := newMachineAPIClient(apiURL, apiKey)
	if err != nil {
		printMachineCLIError(stderr, "CONFIGURATION_ERROR", err.Error(), "Set MODELRY_API_URL and MODELRY_API_KEY, or use --api-url and --api-key")
		return 2
	}
	call, err := buildMachineAPICall(tool, arguments)
	if err != nil {
		printMachineCLIError(stderr, "INVALID_ARGUMENT", err.Error(), "Check the operation arguments and the OpenAPI request DTO")
		return 2
	}
	result, problem := client.execute(context.Background(), call)
	if problem != nil {
		printJSON(stderr, problem.output())
		return 1
	}
	if err := printJSON(stdout, result); err != nil {
		printMachineCLIError(stderr, "OUTPUT_ERROR", "Could not print the Modelry response", "Check the output destination and retry")
		return 1
	}
	return 0
}

func printAdminUsage(writer io.Writer) {
	_, _ = fmt.Fprintln(writer, "Usage: modelry admin [--api-url URL] [--api-key KEY] [--data JSON] [query flags] <resource> <operation> [IDs]")
	_, _ = fmt.Fprintln(writer, "Resources: collections (list|get|create), records (list|get|create|update|delete), schema (pending|add|update|remove|preview|apply|discard|history), access (get|save|apply|discard), requests (list|get), audit (list|get)")
	_, _ = fmt.Fprintln(writer, "Query flags: --limit --cursor --search --filter --sort. URL and key may also come from MODELRY_API_URL and MODELRY_API_KEY.")
	_, _ = fmt.Fprintln(writer, "Each operation calls a fixed /admin/api/v1 endpoint; the Runtime checks the API key's Service Account Permission:")
	for _, action := range machineCLIActions {
		info := machineOperationCatalog[action.tool]
		_, _ = fmt.Fprintf(writer, "  %-25s %s %s (%s) — %s\n", action.command, info.method, info.path, info.permission, info.purpose)
	}
	_, _ = fmt.Fprintln(writer, "Example: modelry admin records list col_<id> --limit 25")
}

type machineCLIAction struct {
	command string
	tool    string
}

var machineCLIActions = []machineCLIAction{
	{command: "collections list", tool: "collections_list"},
	{command: "collections get <collectionId>", tool: "collections_get"},
	{command: "collections create", tool: "collections_create"},
	{command: "records list <collectionId>", tool: "records_list"},
	{command: "records get <collectionId> <recordId>", tool: "records_get"},
	{command: "records create <collectionId>", tool: "records_create"},
	{command: "records update <collectionId> <recordId>", tool: "records_update"},
	{command: "records delete <collectionId> <recordId>", tool: "records_delete"},
	{command: "schema pending <collectionId>", tool: "schema_pending_get"},
	{command: "schema add <collectionId>", tool: "schema_operation_add"},
	{command: "schema update <collectionId> <operationId>", tool: "schema_operation_update"},
	{command: "schema remove <collectionId> <operationId>", tool: "schema_operation_remove"},
	{command: "schema preview <collectionId>", tool: "schema_preview"},
	{command: "schema apply <collectionId>", tool: "schema_apply"},
	{command: "schema discard <collectionId>", tool: "schema_discard"},
	{command: "schema history <collectionId>", tool: "schema_history"},
	{command: "access get <collectionId>", tool: "access_rules_get"},
	{command: "access save <collectionId>", tool: "access_rules_save"},
	{command: "access apply <collectionId>", tool: "access_rules_apply"},
	{command: "access discard <collectionId>", tool: "access_rules_discard"},
	{command: "requests list", tool: "requests_list"},
	{command: "requests get <requestId>", tool: "requests_get"},
	{command: "audit list", tool: "audit_list"},
	{command: "audit get <auditRecordId>", tool: "audit_get"},
}

func parseMachineFlags(args []string) ([]string, map[string]string, error) {
	allowed := map[string]bool{"api-url": true, "api-key": true, "data": true, "limit": true, "cursor": true, "search": true, "filter": true, "sort": true}
	positionals := make([]string, 0, len(args))
	flags := make(map[string]string)
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if !strings.HasPrefix(argument, "--") {
			positionals = append(positionals, argument)
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimPrefix(argument, "--"), "=")
		if !allowed[name] {
			return nil, nil, fmt.Errorf("unknown flag --%s", name)
		}
		if !hasValue {
			index++
			if index >= len(args) || strings.HasPrefix(args[index], "--") {
				return nil, nil, fmt.Errorf("flag --%s requires a value", name)
			}
			value = args[index]
		}
		if _, exists := flags[name]; exists {
			return nil, nil, fmt.Errorf("flag --%s was supplied more than once", name)
		}
		flags[name] = value
	}
	return positionals, flags, nil
}

func adminCommand(positionals []string, flags map[string]string) (string, map[string]any, error) {
	if len(positionals) < 2 {
		return "", nil, errors.New("expected a resource group and operation")
	}
	group, action := positionals[0], positionals[1]
	remaining := positionals[2:]
	tool := ""
	arguments := make(map[string]any)
	usedQueryFlags := make(map[string]bool)
	putID := func(name string, index int) error {
		if len(remaining) <= index || !machineIDPattern.MatchString(remaining[index]) {
			return fmt.Errorf("%s is required and must be a valid Modelry ID", name)
		}
		arguments[name] = remaining[index]
		return nil
	}
	queryFlags := func(names ...string) error {
		accepted := map[string]bool{}
		for _, name := range names {
			accepted[name] = true
			usedQueryFlags[name] = true
			if value, exists := flags[name]; exists {
				if name == "limit" {
					limit, err := strconv.Atoi(value)
					if err != nil || limit < 1 || limit > 100 {
						return errors.New("--limit must be between 1 and 100")
					}
					arguments[name] = limit
				} else {
					arguments[name] = value
				}
			}
		}
		for name := range flags {
			if isQueryFlag(name) && !accepted[name] {
				return fmt.Errorf("--%s is not supported for this operation", name)
			}
		}
		return nil
	}
	setBody := func(required bool) error {
		value, exists := flags["data"]
		if !exists {
			if required {
				return errors.New("--data JSON is required for this operation")
			}
			return nil
		}
		var body map[string]any
		decoder := json.NewDecoder(strings.NewReader(value))
		decoder.UseNumber()
		if err := decoder.Decode(&body); err != nil || body == nil {
			return errors.New("--data must be one JSON object matching the documented request DTO")
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return errors.New("--data must contain exactly one JSON object")
		}
		arguments["body"] = body
		return nil
	}
	noRemaining := func() error {
		if len(remaining) != 0 {
			return errors.New("too many positional arguments")
		}
		return nil
	}
	switch group {
	case "collections":
		switch action {
		case "list":
			tool = "collections_list"
			if err := noRemaining(); err != nil {
				return "", nil, err
			}
			if err := queryFlags("limit", "cursor"); err != nil {
				return "", nil, err
			}
		case "get":
			tool = "collections_get"
			if err := putID("collectionId", 0); err != nil || len(remaining) != 1 {
				return "", nil, errors.New("usage: collections get <collectionId>")
			}
			if err := noRemaining(); err != nil {
				return "", nil, err
			}
		case "create":
			tool = "collections_create"
			if err := noRemaining(); err != nil {
				return "", nil, err
			}
			if err := setBody(true); err != nil {
				return "", nil, err
			}
		default:
			return "", nil, errors.New("collections supports list, get, and create")
		}
	case "records":
		switch action {
		case "list":
			tool = "records_list"
			if err := putID("collectionId", 0); err != nil || len(remaining) != 1 {
				return "", nil, errors.New("usage: records list <collectionId>")
			}
			if err := queryFlags("limit", "cursor", "search", "filter", "sort"); err != nil {
				return "", nil, err
			}
		case "get", "create", "update", "delete":
			if err := putID("collectionId", 0); err != nil {
				return "", nil, errors.New("a valid collectionId is required")
			}
			arguments["collectionId"] = remaining[0]
			switch action {
			case "create":
				tool = "records_create"
				if len(remaining) != 1 {
					return "", nil, errors.New("usage: records create <collectionId> --data '{\"values\":{...}}'")
				}
				if err := setBody(true); err != nil {
					return "", nil, err
				}
			case "get", "update", "delete":
				if len(remaining) != 2 || !machineIDPattern.MatchString(remaining[1]) {
					return "", nil, fmt.Errorf("usage: records %s <collectionId> <recordId>", action)
				}
				arguments["recordId"] = remaining[1]
				tool = "records_" + action
				if action == "update" {
					if err := setBody(true); err != nil {
						return "", nil, err
					}
				} else if _, exists := flags["data"]; exists {
					return "", nil, errors.New("--data is not accepted for this operation")
				}
			}
		default:
			return "", nil, errors.New("records supports list, get, create, update, and delete")
		}
	case "schema":
		if len(remaining) == 0 || !machineIDPattern.MatchString(remaining[0]) {
			return "", nil, errors.New("schema operation requires a collectionId")
		}
		arguments["collectionId"] = remaining[0]
		rest := remaining[1:]
		switch action {
		case "pending":
			tool = "schema_pending_get"
		case "add":
			tool = "schema_operation_add"
		case "update", "remove":
			if len(rest) != 1 || !machineIDPattern.MatchString(rest[0]) {
				return "", nil, fmt.Errorf("usage: schema %s <collectionId> <operationId>", action)
			}
			arguments["operationId"] = rest[0]
			tool = "schema_operation_" + action
		case "preview", "apply", "discard":
			tool = "schema_" + action
		case "history":
			tool = "schema_history"
		default:
			return "", nil, errors.New("schema supports pending, add, update, remove, preview, apply, discard, and history")
		}
		if action == "pending" || action == "add" || action == "preview" || action == "apply" || action == "discard" || action == "history" {
			if len(rest) != 0 {
				return "", nil, errors.New("too many positional arguments")
			}
		}
		if action == "add" || action == "update" || action == "preview" || action == "apply" || action == "discard" {
			if err := setBody(true); err != nil {
				return "", nil, err
			}
		} else if _, exists := flags["data"]; exists {
			return "", nil, errors.New("--data is not accepted for this operation")
		}
		if action == "history" {
			if err := queryFlags("limit", "cursor"); err != nil {
				return "", nil, err
			}
		}
	case "access":
		if len(remaining) != 1 || !machineIDPattern.MatchString(remaining[0]) {
			return "", nil, errors.New("usage: access <get|save|apply|discard> <collectionId>")
		}
		arguments["collectionId"] = remaining[0]
		switch action {
		case "get":
			tool = "access_rules_get"
		case "save", "apply", "discard":
			tool = "access_rules_" + action
			if err := setBody(true); err != nil {
				return "", nil, err
			}
		default:
			return "", nil, errors.New("access supports get, save, apply, and discard")
		}
	case "requests":
		switch action {
		case "list":
			tool = "requests_list"
			if err := noRemaining(); err != nil {
				return "", nil, err
			}
			if err := queryFlags("limit", "cursor", "search", "filter", "sort"); err != nil {
				return "", nil, err
			}
		case "get":
			tool = "requests_get"
			if len(remaining) != 1 || !machineIDPattern.MatchString(remaining[0]) {
				return "", nil, errors.New("usage: requests get <requestId>")
			}
			arguments["requestId"] = remaining[0]
		default:
			return "", nil, errors.New("requests supports list and get")
		}
	case "audit":
		switch action {
		case "list":
			tool = "audit_list"
			if err := noRemaining(); err != nil {
				return "", nil, err
			}
			if err := queryFlags("limit", "cursor"); err != nil {
				return "", nil, err
			}
		case "get":
			tool = "audit_get"
			if len(remaining) != 1 || !machineIDPattern.MatchString(remaining[0]) {
				return "", nil, errors.New("usage: audit get <auditRecordId>")
			}
			arguments["auditRecordId"] = remaining[0]
		default:
			return "", nil, errors.New("audit supports list and get")
		}
	default:
		return "", nil, fmt.Errorf("unsupported admin resource group %q", group)
	}
	if _, exists := flags["data"]; exists {
		if _, accepted := arguments["body"]; !accepted {
			return "", nil, errors.New("--data is not accepted for this operation")
		}
	}
	for name := range flags {
		if isQueryFlag(name) && !usedQueryFlags[name] {
			return "", nil, fmt.Errorf("--%s is not supported for this operation", name)
		}
		if name != "api-url" && name != "api-key" && name != "data" && !isQueryFlag(name) {
			return "", nil, fmt.Errorf("unsupported flag --%s", name)
		}
	}
	return tool, arguments, nil
}

func isQueryFlag(name string) bool {
	switch name {
	case "limit", "cursor", "search", "filter", "sort":
		return true
	default:
		return false
	}
}

func printJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func printMachineCLIError(writer io.Writer, code, message, hint string) {
	_ = printJSON(writer, map[string]any{"error": map[string]any{"code": code, "message": message, "hint": hint}})
}
