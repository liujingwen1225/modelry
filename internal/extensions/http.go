package extensions

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

const maximumAdminBodyBytes = (1 << 20) + (64 << 10)

type AdminService interface {
	List(context.Context) ([]Summary, error)
	Get(context.Context, string) (Detail, error)
	Create(context.Context, ConfigInput) (Detail, error)
	Replace(context.Context, string, ConfigInput) (Detail, error)
	Enable(context.Context, string) (bool, error)
	Disable(context.Context, string) (bool, error)
	ListRuns(context.Context, string, RunListOptions) (RunPage, error)
	GetRun(context.Context, string, string) (Run, error)
	ListSecrets(context.Context) ([]SecretMetadata, error)
	CreateSecret(context.Context, string, string) (SecretMetadata, error)
	RenameSecret(context.Context, string, string) (SecretMetadata, error)
	ReplaceSecretValue(context.Context, string, string) (SecretMetadata, error)
	DeleteSecret(context.Context, string) error
}

type Module struct{ service AdminService }

func NewModule(service AdminService) *Module { return &Module{service: service} }

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/extensions", module.list)
	mux.HandleFunc("POST /admin/api/v1/extensions", module.create)
	mux.HandleFunc("GET /admin/api/v1/extensions/{extensionId}", module.get)
	mux.HandleFunc("PUT /admin/api/v1/extensions/{extensionId}", module.replace)
	mux.HandleFunc("POST /admin/api/v1/extensions/{extensionId}/enable", module.enable)
	mux.HandleFunc("POST /admin/api/v1/extensions/{extensionId}/disable", module.disable)
	mux.HandleFunc("GET /admin/api/v1/extensions/{extensionId}/runs", module.listRuns)
	mux.HandleFunc("GET /admin/api/v1/extensions/{extensionId}/runs/{runId}", module.getRun)
	mux.HandleFunc("GET /admin/api/v1/secrets", module.listSecrets)
	mux.HandleFunc("POST /admin/api/v1/secrets", module.createSecret)
	mux.HandleFunc("PATCH /admin/api/v1/secrets/{secretId}", module.renameSecret)
	mux.HandleFunc("PUT /admin/api/v1/secrets/{secretId}/value", module.replaceSecretValue)
	mux.HandleFunc("DELETE /admin/api/v1/secrets/{secretId}", module.deleteSecret)
}

type dataResponse[T any] struct {
	Data T `json:"data"`
}

func (module *Module) list(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if request.URL.RawQuery != "" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	value, err := module.service.List(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[[]Summary]{Data: value})
}

func (module *Module) create(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input struct {
		Name     string   `json:"name"`
		Language Language `json:"language"`
		Source   string   `json:"source"`
	}
	if err := decodeAdminJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	detail, err := module.service.Create(request.Context(), ConfigInput{Name: input.Name, Language: input.Language, Source: input.Source})
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[Detail]{Data: detail})
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if request.URL.RawQuery != "" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	detail, err := module.service.Get(request.Context(), request.PathValue("extensionId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[Detail]{Data: detail})
}

func (module *Module) replace(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input ConfigInput
	if err := decodeAdminJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	detail, err := module.service.Replace(request.Context(), request.PathValue("extensionId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[Detail]{Data: detail})
}

type extensionStatus struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

func (module *Module) enable(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if !emptyAdminBody(request) {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	enabled, err := module.service.Enable(request.Context(), request.PathValue("extensionId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[extensionStatus]{Data: extensionStatus{ID: request.PathValue("extensionId"), Enabled: enabled}})
}
func (module *Module) disable(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if !emptyAdminBody(request) {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	enabled, err := module.service.Disable(request.Context(), request.PathValue("extensionId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[extensionStatus]{Data: extensionStatus{ID: request.PathValue("extensionId"), Enabled: enabled}})
}

func (module *Module) listRuns(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	options, err := parseRunListOptions(request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	page, err := module.service.ListRuns(request.Context(), request.PathValue("extensionId"), options)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, page)
}

func (module *Module) getRun(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if request.URL.RawQuery != "" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	run, err := module.service.GetRun(request.Context(), request.PathValue("extensionId"), request.PathValue("runId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[Run]{Data: run})
}

func (module *Module) listSecrets(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if request.URL.RawQuery != "" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	value, err := module.service.ListSecrets(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[[]SecretMetadata]{Data: value})
}

func (module *Module) createSecret(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}
	if err := decodeAdminJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	value, err := module.service.CreateSecret(request.Context(), input.Name, input.Value)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[SecretMetadata]{Data: value})
}
func (module *Module) renameSecret(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeAdminJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	value, err := module.service.RenameSecret(request.Context(), request.PathValue("secretId"), input.Name)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[SecretMetadata]{Data: value})
}
func (module *Module) replaceSecretValue(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input struct {
		Value string `json:"value"`
	}
	if err := decodeAdminJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	value, err := module.service.ReplaceSecretValue(request.Context(), request.PathValue("secretId"), input.Value)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[SecretMetadata]{Data: value})
}
func (module *Module) deleteSecret(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if request.URL.RawQuery != "" {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	if err := module.service.DeleteSecret(request.Context(), request.PathValue("secretId")); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module != nil && module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{Code: "RUNTIME_NOT_READY", Message: "Extension Runtime is not ready yet. Retry after the Runtime finishes initializing."})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Extension request could not be completed safely."}
	var validation *ValidationError
	var bindingConflict *BindingConflictError
	switch {
	case errors.Is(err, ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The Extension request is invalid."
	case errors.As(err, &validation):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "The Extension configuration or Secret did not pass validation."
		problem.Details = map[string]any{"violations": validation.Violations}
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The Extension resource was not found."
	case errors.As(err, &bindingConflict):
		status = http.StatusConflict
		problem.Code = "BINDING_CONFLICT"
		problem.Message = "Another enabled Extension already uses this Collection operation and phase."
		problem.Details = map[string]any{
			"collectionId": bindingConflict.CollectionID,
			"operation":    bindingConflict.Operation,
			"phase":        bindingConflict.Phase,
		}
	case errors.Is(err, ErrConflict):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "The Extension resource conflicts with its current state."
	case errors.Is(err, ErrSecretKeyUnavailable):
		status = http.StatusServiceUnavailable
		problem.Code = "SECRET_KEY_UNAVAILABLE"
		problem.Message = "The Project Secret key is unavailable. Restore the original key before using configured Secrets."
	case errors.Is(err, ErrSecretNotAvailable):
		status = http.StatusUnprocessableEntity
		problem.Code = "SECRET_NOT_AVAILABLE"
		problem.Message = "The configured Secret is not available to this Extension."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

func decodeAdminJSON(w http.ResponseWriter, request *http.Request, destination any) error {
	if request.URL.RawQuery != "" {
		return ErrInvalidArgument
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		return ErrInvalidArgument
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumAdminBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return ErrInvalidArgument
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidArgument
	}
	return nil
}

func emptyAdminBody(request *http.Request) bool {
	if request.URL.RawQuery != "" {
		return false
	}
	if request.Body == nil || request.Body == http.NoBody {
		return true
	}
	if request.ContentLength > 0 {
		return false
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, 1))
	return err == nil && len(data) == 0
}

func parseRunListOptions(request *http.Request) (RunListOptions, error) {
	query := request.URL.Query()
	for name, values := range query {
		if (name != "limit" && name != "cursor") || len(values) != 1 {
			return RunListOptions{}, ErrInvalidArgument
		}
	}
	options := RunListOptions{Cursor: query.Get("cursor")}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return RunListOptions{}, ErrInvalidArgument
		}
		options.Limit = limit
	}
	return options, nil
}

var _ httpapi.APIModule = (*Module)(nil)
var _ AdminService = (*Service)(nil)
