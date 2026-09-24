package serviceaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maxRequestBody = 1 << 20

type Module struct {
	service *Service
}

// NewModule 创建 Service Account 与 API Key 的 Admin HTTP 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册仅供 Control Plane 使用的 Service Account 管理路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/service-accounts", module.list)
	mux.HandleFunc("POST /admin/api/v1/service-accounts", module.create)
	mux.HandleFunc("GET /admin/api/v1/service-accounts/{serviceAccountId}", module.get)
	mux.HandleFunc("PATCH /admin/api/v1/service-accounts/{serviceAccountId}", module.update)
	mux.HandleFunc("POST /admin/api/v1/service-accounts/{serviceAccountId}/disable", module.disable)
	mux.HandleFunc("POST /admin/api/v1/service-accounts/{serviceAccountId}/enable", module.enable)
	mux.HandleFunc("GET /admin/api/v1/service-accounts/{serviceAccountId}/api-keys", module.listAPIKeys)
	mux.HandleFunc("POST /admin/api/v1/service-accounts/{serviceAccountId}/api-keys", module.createAPIKey)
	mux.HandleFunc("POST /admin/api/v1/api-keys/{apiKeyId}/revoke", module.revokeAPIKey)
}

type dataResponse[T any] struct {
	Data T `json:"data"`
}

func (module *Module) list(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	options, err := parseListOptions(request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	page, err := module.service.List(request.Context(), options)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, page)
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	account, err := module.service.Get(request.Context(), request.PathValue("serviceAccountId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[ServiceAccount]{Data: account})
}

func (module *Module) create(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input CreateInput
	if err := decodeJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	result, err := module.service.Create(request.Context(), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[CreateResult]{Data: result})
}

func (module *Module) update(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input UpdateInput
	if err := decodeJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	account, err := module.service.Update(request.Context(), request.PathValue("serviceAccountId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[ServiceAccount]{Data: account})
}

func (module *Module) disable(w http.ResponseWriter, request *http.Request) {
	module.setStatus(w, request, module.service.Disable)
}

func (module *Module) enable(w http.ResponseWriter, request *http.Request) {
	module.setStatus(w, request, module.service.Enable)
}

func (module *Module) setStatus(w http.ResponseWriter, request *http.Request, change func(context.Context, string) error) {
	if !module.ready(w, request) {
		return
	}
	if err := change(request.Context(), request.PathValue("serviceAccountId")); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) listAPIKeys(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	keys, err := module.service.ListAPIKeys(request.Context(), request.PathValue("serviceAccountId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[[]APIKey]{Data: keys})
}

func (module *Module) createAPIKey(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input APIKeyCreateInput
	if err := decodeJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	reveal, err := module.service.CreateAPIKey(request.Context(), request.PathValue("serviceAccountId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[APIKeyReveal]{Data: reveal})
}

func (module *Module) revokeAPIKey(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if err := module.service.RevokeAPIKey(request.Context(), request.PathValue("apiKeyId")); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module != nil && module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Service Account services are not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

type requestProblem struct {
	status  int
	code    string
	message string
}

func (problem requestProblem) Error() string { return problem.message }

func decodeJSON(w http.ResponseWriter, request *http.Request, destination any) error {
	if !strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "application/json") {
		return requestProblem{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this request as application/json."}
	}
	request.Body = http.MaxBytesReader(w, request.Body, maxRequestBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if errors.Is(err, io.EOF) {
			return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "A JSON request body is required."}
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return requestProblem{status: http.StatusRequestEntityTooLarge, code: "PAYLOAD_TOO_LARGE", message: "The request body exceeds the supported size."}
		}
		return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain valid JSON with supported fields."}
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain exactly one JSON value."}
	}
	return nil
}

func parseListOptions(request *http.Request) (ListOptions, error) {
	query := request.URL.Query()
	for name, values := range query {
		if (name != "limit" && name != "cursor") || len(values) != 1 {
			return ListOptions{}, ErrInvalidArgument
		}
	}
	options := ListOptions{Cursor: query.Get("cursor")}
	if value := query.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			return ListOptions{}, ErrInvalidArgument
		}
		options.Limit = limit
	}
	return options, nil
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this Service Account request."}
	status := http.StatusInternalServerError
	var input requestProblem
	var validation *ValidationFailure
	switch {
	case errors.As(err, &input):
		status = input.status
		problem.Code = input.code
		problem.Message = input.message
	case errors.As(err, &validation):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "Review the highlighted Service Account values and try again."
		problem.Hint = "Correct the highlighted values, then retry the request."
		problem.Details = map[string]any{"violations": []map[string]string{{
			"path": validation.Path, "code": validation.Code, "message": validation.Message,
		}}}
	case errors.Is(err, ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The Service Account request contains an invalid value."
	case errors.Is(err, ErrUnauthenticated):
		status = http.StatusUnauthorized
		problem.Code = "UNAUTHENTICATED"
		problem.Message = "A valid Owner or Service Account credential is required."
	case errors.Is(err, ErrForbidden):
		status = http.StatusForbidden
		problem.Code = "FORBIDDEN"
		problem.Message = "This credential does not have Permission for the requested operation."
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The requested Service Account or API Key was not found."
	case errors.Is(err, ErrConflict):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "The Service Account state changed. Reload it and retry the operation."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrStorage):
		status = http.StatusServiceUnavailable
		problem.Code = "STORAGE_UNAVAILABLE"
		problem.Message = "Service Account storage is temporarily unavailable. Retry after project storage recovers."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)
