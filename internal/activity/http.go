package activity

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

// Module 暴露 Owner 或具备 activity.read 的 Control Plane 身份的 Activity 读接口。
type Module struct{ service *Service }

// NewModule 创建 Activity Admin API 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册 Activity 路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/activity", module.list)
}

func (module *Module) list(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	query := request.URL.Query()
	allowed := map[string]struct{}{"limit": {}, "cursor": {}, "kinds": {}, "collectionId": {}}
	for name, values := range query {
		if _, ok := allowed[name]; !ok || len(values) != 1 {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
	}
	options := ListOptions{Cursor: query.Get("cursor"), CollectionID: query.Get("collectionId")}
	if value := query.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > MaximumLimit {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
		options.Limit = limit
	}
	if value := query.Get("kinds"); value != "" {
		for _, raw := range strings.Split(value, ",") {
			kind := Kind(strings.TrimSpace(raw))
			if kind == "" {
				module.writeError(w, request, ErrInvalidArgument)
				return
			}
			options.Kinds = append(options.Kinds, kind)
		}
	}
	page, err := module.service.List(request.Context(), options)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, page)
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Activity is not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not read Activity."}
	switch {
	case errors.Is(err, ErrInvalidArgument):
		status, problem.Code, problem.Message = http.StatusBadRequest, "INVALID_ARGUMENT", "The Activity query is invalid."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrStorage):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Activity could not be read. Retry after the Runtime is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)