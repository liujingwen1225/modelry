package runtimesettings

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maximumSettingsRequestBytes = 8 << 10

// Module 暴露 Runtime Settings 的读写接口。
type Module struct{ service *Service }

// NewModule 创建 Runtime Settings Admin API 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册 Runtime Settings 路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/settings", module.get)
	mux.HandleFunc("PUT /admin/api/v1/settings", module.put)
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if len(request.URL.Query()) != 0 {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	settings, err := module.service.Get(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Settings `json:"data"`
	}{Data: settings})
}

type settingsInput struct {
	ExpectedRevision     int    `json:"expectedRevision"`
	ListenAddress        string `json:"listenAddress"`
	RequestRetentionDays int    `json:"requestRetentionDays"`
}

func (module *Module) put(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumSettingsRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input settingsInput
	if err := decoder.Decode(&input); err != nil {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	settings, err := module.service.Save(request.Context(), Input{
		ExpectedRevision:     input.ExpectedRevision,
		ListenAddress:        input.ListenAddress,
		RequestRetentionDays: input.RequestRetentionDays,
	})
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Settings `json:"data"`
	}{Data: settings})
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Runtime Settings are not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this Runtime Settings request."}
	switch {
	case errors.Is(err, ErrInvalidArgument):
		status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Review the Runtime Settings values and try again."
	case errors.Is(err, ErrConflict):
		status, problem.Code, problem.Message = http.StatusConflict, "CONFLICT", "Runtime Settings changed in another session. Reload and try again."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrStorage):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Runtime Settings could not be saved. Retry after the Runtime is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)