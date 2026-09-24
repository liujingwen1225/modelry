package requests

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

type Module struct {
	service *Service
}

func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册受 Admin Owner Middleware 保护的 RequestRecord 只读端点。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/requests", module.list)
	mux.HandleFunc("GET /admin/api/v1/requests/{requestId}", module.get)
}

type recordResponse struct {
	Data RequestRecord `json:"data"`
}

type listResponse struct {
	Data       []RequestRecord `json:"data"`
	NextCursor string          `json:"nextCursor,omitempty"`
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
	httpapi.WriteAPIJSON(w, http.StatusOK, listResponse{Data: page.Data, NextCursor: page.NextCursor})
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	entry, err := module.service.Get(request.Context(), request.PathValue("requestId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, recordResponse{Data: entry})
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Request History is not ready yet. Retry after the Runtime finishes initializing.",
	})
	return false
}

func parseListOptions(request *http.Request) (ListOptions, error) {
	query := request.URL.Query()
	allowed := map[string]struct{}{"limit": {}, "cursor": {}, "search": {}, "filter": {}, "sort": {}}
	for name, values := range query {
		if _, ok := allowed[name]; !ok || len(values) != 1 {
			return ListOptions{}, ErrInvalidArgument
		}
	}
	options := ListOptions{Cursor: query.Get("cursor"), Search: query.Get("search"), Filter: query.Get("filter"), Sort: query.Get("sort")}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > maximumLimit {
			return ListOptions{}, ErrInvalidArgument
		}
		options.Limit = limit
	}
	return options, nil
}

type httpProblem struct {
	status  int
	code    string
	message string
	more    string
}

func (problem httpProblem) Error() string { return problem.message }

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "Request History could not complete this request."}
	status := http.StatusInternalServerError
	var input httpProblem
	switch {
	case errors.As(err, &input):
		status = input.status
		problem.Code = input.code
		problem.Message = input.message
		problem.Hint = input.more
	case errors.Is(err, ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The Request History query is invalid."
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The Request Detail was not found."
	case errors.Is(err, ErrStorage):
		status = http.StatusServiceUnavailable
		problem.Code = "STORAGE_UNAVAILABLE"
		problem.Message = "Request History is temporarily unavailable. Retry after project storage recovers."
	default:
		if strings.Contains(strings.ToLower(err.Error()), "busy") || strings.Contains(strings.ToLower(err.Error()), "locked") {
			status = http.StatusServiceUnavailable
			problem.Code = "STORAGE_BUSY"
			problem.Message = "Project storage is busy. Retry the operation."
		}
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)
