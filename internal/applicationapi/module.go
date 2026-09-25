package applicationapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/requests"
)

const maximumRecordBody = 1 << 20

type Module struct {
	models   *backendmodel.Service
	records  *records.Service
	sessions authorization.SessionAuthenticator
}

type Option func(*Module)

// WithSessionAuthenticator 为 Application Bearer Session 验证器注入认证能力。
func WithSessionAuthenticator(authenticator authorization.SessionAuthenticator) Option {
	return func(module *Module) { module.sessions = authenticator }
}

// NewModule 创建 Application Records API。Access Rule Evaluator 由 Records Service 持有；
// 未配置时，Records Service 会对 Application 请求 fail closed。
func NewModule(models *backendmodel.Service, recordService *records.Service, options ...Option) *Module {
	module := &Module{models: models, records: recordService}
	for _, option := range options {
		if option != nil {
			option(module)
		}
	}
	return module
}

// RegisterRoutes 注册 Application Records REST routes。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/{collectionName}", module.handleList)
	mux.HandleFunc("POST /api/v1/{collectionName}", module.handleCreate)
	mux.HandleFunc("GET /api/v1/{collectionName}/{recordId}", module.handleGet)
	mux.HandleFunc("PATCH /api/v1/{collectionName}/{recordId}", module.handleUpdate)
	mux.HandleFunc("DELETE /api/v1/{collectionName}/{recordId}", module.handleDelete)
	mux.HandleFunc("GET /api/v1/{collectionName}/{recordId}/files/{fieldName}", module.handleFileRead)
}

type recordWriteRequest struct {
	Values map[string]any `json:"values"`
}

type recordResponse struct {
	Data records.Record `json:"data"`
}

type recordListResponse struct {
	Data       []records.Record `json:"data"`
	NextCursor string           `json:"nextCursor,omitempty"`
}

func (module *Module) handleList(w http.ResponseWriter, request *http.Request) {
	principal, err := module.authenticate(request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		writeError(w, request, err)
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	options, err := parseListOptions(request.URL.Query())
	if err != nil {
		writeError(w, request, err)
		return
	}
	page, err := module.records.ListApplication(request.Context(), collection.ID, options, principal)
	if err != nil {
		markAuthorization(request, err)
		writeError(w, request, err)
		return
	}
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	httpapi.WriteAPIJSON(w, http.StatusOK, recordListResponse{Data: page.Data, NextCursor: page.NextCursor})
}

func (module *Module) handleCreate(w http.ResponseWriter, request *http.Request) {
	principal, err := module.authenticate(request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		writeError(w, request, err)
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	body, err := decodeRecordWrite(w, request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	record, err := module.records.CreateApplication(request.Context(), collection.ID, body.Values, principal)
	if err != nil {
		markAuthorization(request, err)
		writeError(w, request, err)
		return
	}
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	httpapi.WriteAPIJSON(w, http.StatusCreated, recordResponse{Data: record})
}

func (module *Module) handleGet(w http.ResponseWriter, request *http.Request) {
	principal, err := module.authenticate(request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		writeError(w, request, err)
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	expands, err := records.ParseExpandQuery(request.URL.Query())
	if err != nil {
		writeError(w, request, err)
		return
	}
	record, err := module.records.GetApplicationExpanded(request.Context(), collection.ID, request.PathValue("recordId"), principal, expands)
	if err != nil {
		markAuthorization(request, err)
		writeError(w, request, err)
		return
	}
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	httpapi.WriteAPIJSON(w, http.StatusOK, recordResponse{Data: record})
}

func (module *Module) handleUpdate(w http.ResponseWriter, request *http.Request) {
	principal, err := module.authenticate(request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		writeError(w, request, err)
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	body, err := decodeRecordWrite(w, request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	record, err := module.records.UpdateApplication(request.Context(), collection.ID, request.PathValue("recordId"), body.Values, principal)
	if err != nil {
		markAuthorization(request, err)
		writeError(w, request, err)
		return
	}
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	httpapi.WriteAPIJSON(w, http.StatusOK, recordResponse{Data: record})
}

func (module *Module) handleDelete(w http.ResponseWriter, request *http.Request) {
	principal, err := module.authenticate(request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		writeError(w, request, err)
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	if err := module.records.DeleteApplication(request.Context(), collection.ID, request.PathValue("recordId"), principal); err != nil {
		markAuthorization(request, err)
		writeError(w, request, err)
		return
	}
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) handleFileRead(w http.ResponseWriter, request *http.Request) {
	principal, err := module.authenticate(request)
	if err != nil {
		writeError(w, request, err)
		return
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		writeError(w, request, err)
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	file, info, err := module.records.OpenFileApplication(request.Context(), collection.ID, request.PathValue("recordId"), request.PathValue("fieldName"), principal)
	if err != nil {
		markAuthorization(request, err)
		writeError(w, request, err)
		return
	}
	defer file.Close()
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	contentType := info.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if parsed, _, parseErr := mime.ParseMediaType(contentType); parseErr == nil {
		contentType = parsed
	} else {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	requests.PersistBeforeResponse(request.Context(), http.StatusOK, "")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}

func (module *Module) authenticate(request *http.Request) (authorization.Principal, error) {
	values := request.Header.Values("Authorization")
	if len(values) == 0 {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
		return authorization.Principal{Type: authorization.PrincipalAnonymous}, nil
	}
	if len(values) != 1 {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
		return authorization.Principal{}, records.ErrUnauthenticated
	}
	parts := strings.Fields(strings.TrimSpace(values[0]))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 4096 || module.sessions == nil {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
		return authorization.Principal{}, records.ErrUnauthenticated
	}
	principal, err := module.sessions.AuthenticateSession(request.Context(), parts[1])
	if err != nil || principal.Type != authorization.PrincipalApplication || principal.ID == "" {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
		return authorization.Principal{}, records.ErrUnauthenticated
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAuthenticated)
	return principal, nil
}

func (module *Module) resolveCollection(ctx context.Context, name string) (backendmodel.Collection, error) {
	if module.models == nil || module.records == nil || name == "" || len(name) > 80 {
		return backendmodel.Collection{}, backendmodel.ErrNotFound
	}
	options := backendmodel.ListOptions{Limit: 100}
	for {
		page, err := module.models.ListCollections(ctx, options)
		if err != nil {
			return backendmodel.Collection{}, err
		}
		for _, collection := range page.Data {
			if strings.EqualFold(collection.Name, name) {
				if _, err := module.models.GetRecordProjection(ctx, collection.ID); err != nil {
					return backendmodel.Collection{}, err
				}
				return collection, nil
			}
		}
		if page.NextCursor == "" {
			return backendmodel.Collection{}, backendmodel.ErrNotFound
		}
		options.Cursor = page.NextCursor
	}
}

func parseListOptions(query url.Values) (records.ListOptions, error) {
	allowed := map[string]bool{"limit": true, "cursor": true, "search": true, "filter": true, "sort": true}
	for key, values := range query {
		if !allowed[key] || len(values) != 1 {
			return records.ListOptions{}, fmt.Errorf("%w: query parameter %q is unsupported or repeated", records.ErrInvalidArgument, key)
		}
	}
	options := records.ListOptions{Limit: 50, Cursor: query.Get("cursor"), Search: query.Get("search"), Filter: query.Get("filter"), Sort: query.Get("sort")}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return records.ListOptions{}, fmt.Errorf("%w: limit must be between 1 and 100", records.ErrInvalidArgument)
		}
		options.Limit = limit
	}
	if len(options.Cursor) > 4096 || len(options.Search) > 256 || len(options.Filter) > 4096 || len(options.Sort) > 1024 {
		return records.ListOptions{}, fmt.Errorf("%w: a query parameter exceeds its size limit", records.ErrInvalidArgument)
	}
	return options, nil
}

func decodeRecordWrite(w http.ResponseWriter, request *http.Request) (recordWriteRequest, error) {
	if request.Body == nil {
		return recordWriteRequest{}, fmt.Errorf("%w: JSON request body is required", records.ErrInvalidArgument)
	}
	if contentType := request.Header.Get("Content-Type"); contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "application/json" {
			return recordWriteRequest{}, errUnsupportedMediaType
		}
	} else {
		return recordWriteRequest{}, errUnsupportedMediaType
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumRecordBody)
	decoder := json.NewDecoder(request.Body)
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	var body recordWriteRequest
	if err := decoder.Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return recordWriteRequest{}, errPayloadTooLarge
		}
		return recordWriteRequest{}, fmt.Errorf("%w: body must be one valid Record write object", records.ErrInvalidArgument)
	}
	if body.Values == nil {
		return recordWriteRequest{}, fmt.Errorf("%w: values are required", records.ErrInvalidArgument)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return recordWriteRequest{}, errPayloadTooLarge
		}
		return recordWriteRequest{}, fmt.Errorf("%w: body must contain one JSON object", records.ErrInvalidArgument)
	}
	return body, nil
}

var errUnsupportedMediaType = errors.New("unsupported media type")
var errPayloadTooLarge = errors.New("payload too large")

func markAuthorization(request *http.Request, err error) {
	var denied *records.PolicyDeniedError
	if errors.As(err, &denied) || errors.Is(err, records.ErrForbidden) {
		requests.MarkAuthorization(request.Context(), requests.AuthorizationDenied)
	} else if errors.Is(err, records.ErrPolicyEvaluation) {
		requests.MarkAuthorization(request.Context(), requests.AuthorizationEvaluationError)
	}
}

func writeError(w http.ResponseWriter, request *http.Request, err error) {
	problem := httpapi.APIError{Message: "Application request could not be completed", Details: map[string]any{}}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, recordlifecycle.ErrRuntimeUnavailable):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "EXTENSION_RUNTIME_UNAVAILABLE", "A required Record lifecycle Extension is unavailable; no Record change was committed."
	case errors.Is(err, recordlifecycle.ErrRejected):
		status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "CHANGE_REJECTED_BY_EXTENSION", "A Record lifecycle Extension rejected this change."
	case errors.Is(err, recordlifecycle.ErrBudgetExceeded):
		status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "EXTENSION_BUDGET_EXCEEDED", "A Record lifecycle Extension exceeded its execution budget; no Record change was committed."
	case errors.Is(err, recordlifecycle.ErrInvalidOutput):
		status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "VALIDATION_FAILED", "A Record lifecycle Extension returned values that do not match the Applied Model."
	case errors.Is(err, recordevents.ErrEventTooLarge):
		status, problem.Code, problem.Message = http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "This Record change exceeds the 1 MiB durable Event limit. Reduce the changed values and retry."
	case errors.Is(err, errPayloadTooLarge):
		status, problem.Code, problem.Message = http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Record request body exceeds the 1 MiB limit"
	case errors.Is(err, errUnsupportedMediaType):
		status, problem.Code, problem.Message = http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "Send Record values as application/json"
	case errors.Is(err, records.ErrUnauthenticated):
		status, problem.Code, problem.Message = http.StatusUnauthorized, "UNAUTHENTICATED", "The supplied Application Session is invalid"
	case errors.Is(err, records.ErrInvalidArgument), errors.Is(err, backendmodel.ErrInvalidArgument):
		status, problem.Code, problem.Message = http.StatusBadRequest, "INVALID_ARGUMENT", "Record request is invalid"
		var fieldError *backendmodel.RecordValueError
		if errors.As(err, &fieldError) {
			status, problem.Code, problem.Message = http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Record values do not match the Applied Model"
			problem.Details["violations"] = []map[string]string{{"path": fieldError.Field, "code": fieldError.Code, "message": fieldError.Message}}
		}
	case errors.Is(err, records.ErrForbidden):
		status, problem.Code, problem.Message = http.StatusForbidden, "FORBIDDEN", "The applied Access Rules denied this operation"
	case errors.Is(err, records.ErrNotFound), errors.Is(err, backendmodel.ErrNotFound):
		status, problem.Code, problem.Message = http.StatusNotFound, "NOT_FOUND", "The requested Collection or Record was not found"
	case errors.Is(err, records.ErrConflict), errors.Is(err, backendmodel.ErrConflict):
		status, problem.Code, problem.Message = http.StatusConflict, "CONFLICT", "The Record conflicts with durable data"
	case errors.Is(err, records.ErrFileStorageUnavailable):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "Local File Storage is unavailable; check project storage and retry"
	case errors.Is(err, records.ErrFileNotFound):
		status, problem.Code, problem.Message = http.StatusNotFound, "NOT_FOUND", "The requested File was not found"
	default:
		problem.Code = "INTERNAL_ERROR"
	}
	httpapi.WriteAPIError(w, request, status, problem)
}
