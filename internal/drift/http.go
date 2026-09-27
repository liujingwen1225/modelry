package drift

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maximumDriftRequestBytes = 8 << 10

// Module 暴露 Drift 报告与投影修复。
type Module struct{ service *Service }

// NewModule 创建 Drift Admin API 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册 Drift 路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/drift", module.report)
	mux.HandleFunc("POST /admin/api/v1/drift/reconcile", module.reconcile)
}

func (module *Module) report(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	query := request.URL.Query()
	for name, values := range query {
		if name != "collectionId" || len(values) != 1 {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
	}
	report, err := module.service.Report(request.Context(), query.Get("collectionId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Report `json:"data"`
	}{Data: report})
}

type reconcileInput struct {
	CollectionID string `json:"collectionId"`
}

func (module *Module) reconcile(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumDriftRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input reconcileInput
	if err := decoder.Decode(&input); err != nil {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	if err := module.service.Reconcile(request.Context(), input.CollectionID); err != nil {
		module.writeError(w, request, err)
		return
	}
	report, err := module.service.Report(request.Context(), input.CollectionID)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Report `json:"data"`
	}{Data: report})
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Drift Detection is not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this Drift request."}
	switch {
	case errors.Is(err, ErrInvalidArgument):
		status, problem.Code, problem.Message = http.StatusBadRequest, "INVALID_ARGUMENT", "The Drift request is invalid."
	case errors.Is(err, ErrNotFound):
		status, problem.Code, problem.Message = http.StatusNotFound, "NOT_FOUND", "No Applied Collection matches this Drift request."
	case errors.Is(err, ErrConflict):
		status, problem.Code, problem.Message = http.StatusConflict, "CONFLICT", "This projection can no longer be reconciled as requested."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrStorage):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Drift Detection could not read or repair the project projection. Retry after the Runtime is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)