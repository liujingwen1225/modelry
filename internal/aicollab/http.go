package aicollab

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

// Module 是 AI 协作的 HTTP 模块；由 Runtime 通过 NewModule 接线并注册到共享 mux。
type Module struct {
	service    *Service
	checkOwner func(context.Context) bool
}

// NewModule 在一个事务里建好两张表，并组装依赖真实 backendmodel.Service 的模块。
func NewModule(store transactionalStore, models *backendmodel.Service) (*Module, error) {
	if store == nil {
		return nil, errors.New("aicollab: 需要可用的项目存储")
	}
	if models == nil {
		return nil, errors.New("aicollab: 需要 backendmodel.Service")
	}
	repo := &repository{store: store}
	if err := repo.initSchema(context.Background()); err != nil {
		return nil, err
	}
	return &Module{
		service:    &Service{repo: repo, models: models},
		checkOwner: defaultOwnerGuard,
	}, nil
}

// defaultOwnerGuard 与 internal/automation/http.go 一致：显式要求 Owner 身份。
// Administrator 命中未映射的 /admin/api/v1/ai/* 路由时会在 Middleware 里 fail closed。
func defaultOwnerGuard(ctx context.Context) bool {
	_, ok := adminauth.OwnerFromContext(ctx)
	return ok
}

// RegisterRoutes 注册管理面（Owner-only）与公开只读端点。
// 公开端点刻意放在 /api/v1/public/... 下且不加 protect（不带管理面鉴权）。
func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	register := func(pattern string, handler http.HandlerFunc) {
		mux.HandleFunc(pattern, m.protect(handler))
	}
	register("GET /admin/api/v1/ai/proposals", m.handleListProposals)
	register("POST /admin/api/v1/ai/proposals", m.handleCreateProposal)
	register("GET /admin/api/v1/ai/proposals/{id}", m.handleGetProposal)
	register("POST /admin/api/v1/ai/proposals/{id}/plan", m.handlePlan)
	register("POST /admin/api/v1/ai/proposals/{id}/apply", m.handleApply)
	register("POST /admin/api/v1/ai/proposals/{id}/verify", m.handleVerify)
	register("POST /admin/api/v1/ai/proposals/{id}/shares", m.handleCreateShare)
	register("GET /admin/api/v1/ai/proposals/{id}/shares", m.handleListShares)
	register("DELETE /admin/api/v1/ai/shares/{id}", m.handleRevokeShare)

	// 公开只读：路径在 /api/v1/ 下但避开集合路由；不加任何管理面鉴权。
	mux.HandleFunc("GET /api/v1/public/ai/shares/{token}", m.handlePublicShare)
}

// protect 是管理面端点的 Owner-only 守卫；checkOwner 可在单测中替换以构造已认证上下文。
func (m *Module) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if m == nil || m.service == nil {
			httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
				Code: "RUNTIME_NOT_READY", Message: "AI 协作服务尚未就绪，请稍后重试。", Details: map[string]any{},
			})
			return
		}
		if !m.checkOwner(request.Context()) {
			httpapi.WriteAPIError(w, request, http.StatusUnauthorized, httpapi.APIError{
				Code: "UNAUTHENTICATED", Message: "需要有效的 Owner 会话。", Details: map[string]any{},
			})
			return
		}
		next(w, request)
	}
}

type dataEnvelope[T any] struct {
	Data T `json:"data"`
}

func writeData[T any](w http.ResponseWriter, status int, value T) {
	httpapi.WriteAPIJSON(w, status, dataEnvelope[T]{Data: value})
}

func (m *Module) handleListProposals(w http.ResponseWriter, request *http.Request) {
	items, err := m.service.listProposals(request.Context())
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusOK, items)
}

func (m *Module) handleCreateProposal(w http.ResponseWriter, request *http.Request) {
	var input createProposalInput
	if err := decodeJSON(w, request, &input, false); err != nil {
		writeProblem(w, request, err)
		return
	}
	p, err := m.service.createProposal(request.Context(), input)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusCreated, p)
}

func (m *Module) handleGetProposal(w http.ResponseWriter, request *http.Request) {
	detail, err := m.service.detail(request.Context(), request.PathValue("id"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusOK, detail)
}

func (m *Module) handlePlan(w http.ResponseWriter, request *http.Request) {
	p, err := m.service.plan(request.Context(), request.PathValue("id"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusOK, p)
}

func (m *Module) handleApply(w http.ResponseWriter, request *http.Request) {
	var input struct {
		ConfirmRisk bool `json:"confirmRisk"`
	}
	if err := decodeJSON(w, request, &input, true); err != nil {
		writeProblem(w, request, err)
		return
	}
	p, err := m.service.apply(request.Context(), request.PathValue("id"), input.ConfirmRisk)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusOK, p)
}

func (m *Module) handleVerify(w http.ResponseWriter, request *http.Request) {
	detail, err := m.service.verify(request.Context(), request.PathValue("id"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusOK, detail)
}

func (m *Module) handleCreateShare(w http.ResponseWriter, request *http.Request) {
	var input struct {
		ExpiresInHours *int `json:"expiresInHours"`
	}
	if err := decodeJSON(w, request, &input, true); err != nil {
		writeProblem(w, request, err)
		return
	}
	created, err := m.service.createShare(request.Context(), request.PathValue("id"), input.ExpiresInHours)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusCreated, created)
}

func (m *Module) handleListShares(w http.ResponseWriter, request *http.Request) {
	items, err := m.service.listShares(request.Context(), request.PathValue("id"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	writeData(w, http.StatusOK, items)
}

func (m *Module) handleRevokeShare(w http.ResponseWriter, request *http.Request) {
	if err := m.service.revokeShare(request.Context(), request.PathValue("id")); err != nil {
		writeProblem(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePublicShare 返回裸对象（不带 {data:...} 包裹），仅提案摘要。
func (m *Module) handlePublicShare(w http.ResponseWriter, request *http.Request) {
	view, err := m.service.publicShare(request.Context(), request.PathValue("token"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, view)
}

// writeProblem 把领域错误写成统一错误响应；未知错误一律降级为通用 500，
// 绝不把底层 SQLite 细节暴露给调用方。
func writeProblem(w http.ResponseWriter, request *http.Request, err error) {
	var p *problem
	if errors.As(err, &p) {
		httpapi.WriteAPIError(w, request, p.status, httpapi.APIError{
			Code: p.code, Message: p.message, Details: map[string]any{},
		})
		return
	}
	httpapi.WriteAPIError(w, request, http.StatusInternalServerError, httpapi.APIError{
		Code: "INTERNAL_ERROR", Message: "AI 协作服务无法完成该请求。", Details: map[string]any{},
	})
}

// decodeJSON 要求 application/json、≤1MiB、DisallowUnknownFields、恰好一个 JSON 值。
// allowEmpty 用于可选请求体（apply / shares）的空体场景。
func decodeJSON(w http.ResponseWriter, request *http.Request, destination any, allowEmpty bool) error {
	if request.Body == nil || request.ContentLength == 0 {
		if allowEmpty {
			return nil
		}
		return newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "需要 JSON 请求体。")
	}
	if !strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "application/json") {
		return newProblem(http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "请以 application/json 提交请求。")
	}
	request.Body = http.MaxBytesReader(w, request.Body, maxRequestBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if errors.Is(err, io.EOF) && allowEmpty {
			return nil
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return newProblem(http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "请求体超过 1MiB 上限。")
		}
		return newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "请求体必须是合法 JSON，且只包含受支持字段。")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "请求体必须只包含一个 JSON 值。")
	}
	return nil
}

var _ httpapi.APIModule = (*Module)(nil)
