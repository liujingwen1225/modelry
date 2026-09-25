package portability

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"

	"github.com/liujingwen1225/modelry/internal/records"
	"os"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const (
	maximumImportRequestBytes = 8 << 20
	maximumRestoreUploadBytes = 1 << 30
)

// AuditSink 由 Runtime 注入：写入 Portability Control Plane 事实。
type AuditSink interface {
	AppendPortabilityFact(ctx context.Context, action, resourceID, result string) error
}

// Module 暴露 Backup、Restore preflight、Export、Import 与 Developer contract 路由。
type Module struct {
	service      *Service
	records      RecordSource
	resolver     CollectionResolver
	rules        RuleSummarySource
	audits       AuditSink
}

// ModuleOptions 组装 Portability Admin API 模块。
type ModuleOptions struct {
	Service  *Service
	Records  RecordSource
	Resolver CollectionResolver
	Rules    RuleSummarySource
	Audits   AuditSink
}

// NewModule 创建 Portability Admin API 模块。
func NewModule(options ModuleOptions) *Module {
	return &Module{service: options.Service, records: options.Records, resolver: options.Resolver, rules: options.Rules, audits: options.Audits}
}

// RegisterRoutes 注册 Portability 路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /admin/api/v1/backup", module.backup)
	mux.HandleFunc("POST /admin/api/v1/restore/preflight", module.preflight)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/export", module.export)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/import", module.importRecords)
	mux.HandleFunc("GET /admin/api/v1/developer/contract", module.contract)
}

func (module *Module) backup(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if len(request.URL.Query()) != 0 {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	file, err := os.CreateTemp(module.service.managed, "bundle-*.tar")
	if err != nil {
		module.writeError(w, request, ErrStorage)
		return
	}
	bundlePath := file.Name()
	_ = file.Close()
	_ = os.Remove(bundlePath)
	defer os.Remove(bundlePath)

	result, err := module.service.CreateBackup(request.Context(), BackupOptions{Destination: bundlePath})
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	if module.audits != nil {
		_ = module.audits.AppendPortabilityFact(request.Context(), "backup.created", result.Digest, "success")
	}
	handle, err := os.Open(bundlePath)
	if err != nil {
		module.writeError(w, request, ErrStorage)
		return
	}
	defer handle.Close()
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+bundleFileName(result.Digest)+`"`)
	w.Header().Set("Content-Length", fmt.Sprint(result.Bytes))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, handle)
}

func bundleFileName(digest string) string {
	short := digest
	if len(short) > 12 {
		short = short[:12]
	}
	return "modelry-backup-" + short + ".tar"
}

func (module *Module) preflight(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/x-tar" && mediaType != "application/octet-stream") {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumRestoreUploadBytes)
	result, err := module.service.PreflightReader(request.Context(), request.Body)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	if module.audits != nil {
		_ = module.audits.AppendPortabilityFact(request.Context(), "restore.preflight", result.ProjectID, resultSeverity(result))
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Preflight `json:"data"`
	}{Data: result})
}

func resultSeverity(result Preflight) string {
	if result.Compatible {
		return "success"
	}
	return "failure"
}

func (module *Module) export(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if len(request.URL.Query()) != 0 {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	if err := module.service.ExportStream(request.Context(), module.records, module.resolver, request.PathValue("collectionId"), w); err != nil {
		// 响应已经开始写出；记录错误由客户端通过截断的 NDJSON 感知。
		return
	}
}

func (module *Module) importRecords(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/x-ndjson" && mediaType != "application/json") {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumImportRequestBytes)
	summary, err := module.service.ImportStream(request.Context(), module.records, module.resolver, request.PathValue("collectionId"), request.Body)
	if err != nil {
		if summary.Created > 0 || summary.Failed > 0 {
			httpapi.WriteAPIJSON(w, http.StatusOK, struct {
				Data ImportSummary `json:"data"`
			}{Data: summary})
			return
		}
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data ImportSummary `json:"data"`
	}{Data: summary})
}

func (module *Module) contract(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if len(request.URL.Query()) != 0 {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	contract, err := module.service.BuildContract(request.Context(), module.rules)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data ApplicationAPIContract `json:"data"`
	}{Data: contract})
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil && module.records != nil && module.resolver != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Portability is not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this Portability request."}
	switch {
	case errors.Is(err, ErrInvalidArgument):
		status, problem.Code, problem.Message = http.StatusBadRequest, "INVALID_ARGUMENT", "The Portability request is invalid."
	case errors.Is(err, ErrInvalidBundle):
		status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "VALIDATION_FAILED", "This archive is not a readable Modelry Backup bundle."
	case errors.Is(err, ErrIncompatibleBundle):
		status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "VALIDATION_FAILED", "This Backup bundle is not compatible with the running Runtime."
	case errors.Is(err, ErrProjectInUse):
		status, problem.Code, problem.Message = http.StatusConflict, "PROJECT_IN_USE", "Stop the Runtime before restoring this project."
	case errors.Is(err, ErrProjectNotEmpty):
		status, problem.Code, problem.Message = http.StatusConflict, "PROJECT_NOT_EMPTY", "This project already contains state. Pass --force to replace it."
	case errors.Is(err, ErrModelMismatch):
		status, problem.Code, problem.Message = http.StatusConflict, "MODEL_MISMATCH", "The imported model does not match this project's applied model."
	case errors.Is(err, records.ErrNotFound):
		status, problem.Code, problem.Message = http.StatusNotFound, "NOT_FOUND", "The requested Collection or Record was not found."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrStorage):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Portability could not read or write project state. Retry after the Runtime is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)
