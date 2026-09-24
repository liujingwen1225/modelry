package httpapi

import "net/http"

// APIError 是所有 Runtime API 模块共用的结构化错误。
type APIError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details"`
	Hint      string         `json:"hint,omitempty"`
	RequestID string         `json:"requestId"`
}

type apiErrorEnvelope struct {
	Error APIError `json:"error"`
}

// WriteAPIError 使用 Runtime 入口创建的 requestId 写入统一错误响应。
func WriteAPIError(w http.ResponseWriter, request *http.Request, status int, problem APIError) {
	problem.RequestID = RequestID(request.Context())
	if problem.Details == nil {
		problem.Details = map[string]any{}
	}
	writeJSON(w, status, apiErrorEnvelope{Error: problem})
}

// WriteAPIJSON 写入共享 API 的 JSON 响应。
func WriteAPIJSON(w http.ResponseWriter, status int, value any) {
	writeJSON(w, status, value)
}
