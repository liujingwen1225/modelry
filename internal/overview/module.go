package overview

import (
	"context"
	"net/http"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/serviceaccounts"
)

// Module 暴露 Owner 或具备 runtime.read 的 Control Plane 身份的只读总览聚合。
//
// 它只返回计数、状态与最近集合摘要；记录内容、凭据、Secret 与请求细节一律不出现。
type Module struct {
	service *Service
	// canReadRecords / canReadSchema 复现 Collections 列表的字段级裁剪：
	// 没有对应权限时不返回记录数或待应用变更状态，而不是把它当作零。
	canReadRecords func(context.Context) bool
	canReadSchema  func(context.Context) bool
}

// NewModule 创建总览 Admin API 模块。
func NewModule(service *Service) *Module {
	return &Module{
		service:        service,
		canReadRecords: func(ctx context.Context) bool { return serviceaccounts.HasPermission(ctx, serviceaccounts.OperationRecordsRead) },
		canReadSchema:  func(ctx context.Context) bool { return serviceaccounts.HasPermission(ctx, serviceaccounts.OperationSchemaRead) },
	}
}

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/overview", module.get)
}

type snapshotResponse struct {
	Data Snapshot `json:"data"`
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if request.URL.RawQuery != "" {
		httpapi.WriteAPIError(w, request, http.StatusBadRequest, httpapi.APIError{
			Code: "INVALID_ARGUMENT", Message: "This route does not accept query parameters.",
		})
		return
	}
	if module == nil || module.service == nil {
		writeUnavailable(w, request)
		return
	}
	snapshot, err := module.service.Snapshot(request.Context(), Options{
		IncludeRecordCount:  module.canReadRecords(request.Context()),
		IncludeSchemaStatus: module.canReadSchema(request.Context()),
	})
	if err != nil {
		writeUnavailable(w, request)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, snapshotResponse{Data: snapshot})
}

func writeUnavailable(w http.ResponseWriter, request *http.Request) {
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Overview facts are not available yet. Retry after the Runtime is ready.",
	})
}

var _ httpapi.APIModule = (*Module)(nil)
