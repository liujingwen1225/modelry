package visualrules

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maximumRequestBytes = 1 << 20

// apiProblem 是模块内部携带 HTTP 状态与大写下划线错误码的结构化错误。
type apiProblem struct {
	status  int
	code    string
	message string
}

func (problem apiProblem) Error() string { return problem.message }

// RegisterRoutes 注册可视化规则的 Owner-only 端点。
// 这些路径未在 permissions.ControlPlaneOperation 中映射，Administrator 会在入口 fail closed；
// Owner 由模块内的 protect 再次强制，保证 Owner-only 不依赖外部映射。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	register := func(pattern string, handler http.HandlerFunc) {
		mux.HandleFunc(pattern, module.protect(handler))
	}
	register("GET /admin/api/v1/visual-rules", module.handleListRules)
	register("POST /admin/api/v1/visual-rules", module.handleCreateRule)
	register("GET /admin/api/v1/visual-rules/{id}", module.handleGetRule)
	register("PUT /admin/api/v1/visual-rules/{id}", module.handleReplaceRule)
	register("POST /admin/api/v1/visual-rules/{id}/enable", module.handleEnableRule)
	register("POST /admin/api/v1/visual-rules/{id}/disable", module.handleDisableRule)
	register("POST /admin/api/v1/visual-rules/{id}/test", module.handleTestRule)
	register("POST /admin/api/v1/visual-rules/{id}/run", module.handleRunRule)
	register("GET /admin/api/v1/visual-rules/{id}/runs", module.handleListRuns)
	register("POST /admin/api/v1/visual-rule-runs/{runId}/retry", module.handleRetryRun)
}

func (module *Module) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if _, ok := adminauth.OwnerFromContext(request.Context()); !ok {
			writeProblem(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "需要 Owner 会话才能访问可视化规则。")
			return
		}
		if module == nil || module.service == nil {
			writeProblem(w, request, http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "可视化规则服务尚未就绪。")
			return
		}
		next(w, request)
	}
}

func (module *Module) handleListRules(w http.ResponseWriter, request *http.Request) {
	items, err := module.service.listRules(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataEnvelope[[]rule]{Data: items})
}

func (module *Module) handleCreateRule(w http.ResponseWriter, request *http.Request) {
	input, err := decodeRuleInput(w, request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.createRule(request.Context(), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataEnvelope[rule]{Data: item})
}

func (module *Module) handleGetRule(w http.ResponseWriter, request *http.Request) {
	item, err := module.service.getRule(request.Context(), request.PathValue("id"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataEnvelope[rule]{Data: item})
}

func (module *Module) handleReplaceRule(w http.ResponseWriter, request *http.Request) {
	input, err := decodeRuleInput(w, request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.replaceRule(request.Context(), request.PathValue("id"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataEnvelope[rule]{Data: item})
}

func (module *Module) handleEnableRule(w http.ResponseWriter, request *http.Request) {
	module.handleSetEnabled(w, request, true)
}

func (module *Module) handleDisableRule(w http.ResponseWriter, request *http.Request) {
	module.handleSetEnabled(w, request, false)
}

func (module *Module) handleSetEnabled(w http.ResponseWriter, request *http.Request, enabled bool) {
	if !noBody(w, request) {
		return
	}
	item, err := module.service.setEnabled(request.Context(), request.PathValue("id"), enabled)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataEnvelope[rule]{Data: item})
}

func (module *Module) handleTestRule(w http.ResponseWriter, request *http.Request) {
	payload, err := decodeUserPayload(w, request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	result, err := module.service.testRule(request.Context(), request.PathValue("id"), payload)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataEnvelope[testResult]{Data: result})
}

func (module *Module) handleRunRule(w http.ResponseWriter, request *http.Request) {
	payload, err := decodeUserPayload(w, request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	result, err := module.service.runRule(request.Context(), request.PathValue("id"), payload)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusAccepted, dataEnvelope[run]{Data: result})
}

func (module *Module) handleListRuns(w http.ResponseWriter, request *http.Request) {
	items, err := module.service.listRuns(request.Context(), request.PathValue("id"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataEnvelope[[]run]{Data: items})
}

func (module *Module) handleRetryRun(w http.ResponseWriter, request *http.Request) {
	if !noBody(w, request) {
		return
	}
	result, err := module.service.retryRun(request.Context(), request.PathValue("runId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusAccepted, dataEnvelope[run]{Data: result})
}

func invalidJSONProblem() error {
	return apiProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "请求体必须是合法的 JSON 对象且只含受支持字段。"}
}

// decodeBody 统一做大小限制、DisallowUnknownFields 与「恰好一个 JSON 值」检查。
func decodeBody(w http.ResponseWriter, request *http.Request, destination any, allowEmpty bool) error {
	body := request.Body
	if body == nil {
		body = http.NoBody
	}
	body = http.MaxBytesReader(w, body, maximumRequestBytes)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if errors.Is(err, io.EOF) && allowEmpty {
			return nil
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return apiProblem{status: http.StatusRequestEntityTooLarge, code: "PAYLOAD_TOO_LARGE", message: "请求体超过支持的大小。"}
		}
		return invalidJSONProblem()
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return apiProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "请求体只能包含一个 JSON 值。"}
	}
	return nil
}

func decodeRuleInput(w http.ResponseWriter, request *http.Request) (ruleInput, error) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ruleInput{}, apiProblem{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", message: "请使用 application/json 发送请求。"}
	}
	var input ruleInput
	if err := decodeBody(w, request, &input, false); err != nil {
		return ruleInput{}, err
	}
	return input, nil
}

// decodeUserPayload 允许载荷整体缺省（空 body / {}），但依然拒绝未知字段。
func decodeUserPayload(w http.ResponseWriter, request *http.Request) (userPayload, error) {
	var payload userPayload
	if err := decodeBody(w, request, &payload, true); err != nil {
		return userPayload{}, err
	}
	return payload, nil
}

func noBody(w http.ResponseWriter, request *http.Request) bool {
	if request.Body == nil || request.ContentLength == 0 {
		return true
	}
	var one [1]byte
	n, err := request.Body.Read(one[:])
	if n == 0 && errors.Is(err, io.EOF) {
		return true
	}
	writeProblem(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "该操作不接受请求体。")
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	var problem apiProblem
	if errors.As(err, &problem) {
		writeProblem(w, request, problem.status, problem.code, problem.message)
		return
	}
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeProblem(w, request, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "服务暂时不可用，请重试。")
	default:
		// 不向客户端返回原始 SQLite 错误、查询细节或存储路径。
		writeProblem(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "无法完成可视化规则请求。")
	}
}

func writeProblem(w http.ResponseWriter, request *http.Request, status int, code, message string) {
	httpapi.WriteAPIError(w, request, status, httpapi.APIError{Code: code, Message: message, Details: map[string]any{}})
}

var _ httpapi.APIModule = (*Module)(nil)
