package httpapi

import (
	"context"
	"net/http"
)

// DiagnosticsModule 提供匿名可读的安全健康快照，并仅对已验证的 Owner 返回 Local Storage 路径。
type DiagnosticsModule struct {
	diagnostics Diagnostics
	isOwner     func(context.Context) bool
}

func NewDiagnosticsModule(service Diagnostics, isOwner func(context.Context) bool) *DiagnosticsModule {
	return &DiagnosticsModule{diagnostics: service, isOwner: isOwner}
}

func (module *DiagnosticsModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/runtime/status", module.runtimeStatus)
	mux.HandleFunc("GET /admin/api/v1/storage/status", module.storageStatus)
}

func (module *DiagnosticsModule) runtimeStatus(w http.ResponseWriter, request *http.Request) {
	if module == nil || module.diagnostics == nil {
		WriteAPIError(w, request, http.StatusServiceUnavailable, APIError{
			Code: "RUNTIME_NOT_READY", Message: "Runtime diagnostics are not available.",
			Details: map[string]any{}, Hint: "Retry after the Runtime is ready.",
		})
		return
	}
	WriteAPIJSON(w, http.StatusOK, runtimeStatusResponse(module.diagnostics.RuntimeStatus()))
}

func (module *DiagnosticsModule) storageStatus(w http.ResponseWriter, request *http.Request) {
	if module == nil || module.diagnostics == nil {
		WriteAPIError(w, request, http.StatusServiceUnavailable, APIError{
			Code: "RUNTIME_NOT_READY", Message: "Runtime diagnostics are not available.",
			Details: map[string]any{}, Hint: "Retry after the Runtime is ready.",
		})
		return
	}
	status := storageStatusResponse(module.diagnostics.StorageStatus())
	if module.isOwner == nil || !module.isOwner(request.Context()) {
		status.LocalStorage.Path = ""
	}
	WriteAPIJSON(w, http.StatusOK, status)
}
