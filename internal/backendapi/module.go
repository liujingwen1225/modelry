package backendapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const maxRequestBody = 1 << 20

var ErrConfigurationNotReady = errors.New("collection configuration service is not ready")

type Module struct {
	service               *backendmodel.Service
	collectionInitializer CollectionInitializer
}

// InitialConfiguration 是创建 Collection 时需要在同一事务写入的独立域配置。
type InitialConfiguration struct {
	Authentication json.RawMessage
	AccessRules    json.RawMessage
}

// CollectionInitializer 在 Backend Model 创建事务内持久化 Auth 与 Access 默认值。
type CollectionInitializer func(context.Context, storage.Executor, backendmodel.Collection, InitialConfiguration) error

func NewModule(service *backendmodel.Service, initializer ...CollectionInitializer) *Module {
	module := &Module{service: service}
	if len(initializer) > 0 {
		module.collectionInitializer = initializer[0]
	}
	return module
}

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/collections", module.listCollections)
	mux.HandleFunc("POST /admin/api/v1/collections", module.createCollection)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}", module.getCollection)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/schema/pending-change", module.getPendingChange)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/schema/pending-operations", module.saveOperation)
	mux.HandleFunc("PATCH /admin/api/v1/collections/{collectionId}/schema/pending-operations/{operationId}", module.updateOperation)
	mux.HandleFunc("DELETE /admin/api/v1/collections/{collectionId}/schema/pending-operations/{operationId}", module.removeOperation)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/schema/preview", module.preview)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/schema/apply", module.apply)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/schema/discard", module.discard)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/schema/history", module.history)
	mux.HandleFunc("GET /admin/api/v1/changes", module.listChanges)
	mux.HandleFunc("GET /admin/api/v1/changes/{changeSetId}", module.getChange)
}

type dataResponse[T any] struct {
	Data T `json:"data"`
}

type pageResponse[T any] struct {
	Data       []T    `json:"data"`
	NextCursor string `json:"nextCursor,omitempty"`
}

func (module *Module) listCollections(w http.ResponseWriter, request *http.Request) {
	options, err := parseListOptions(request)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	page, err := module.service.ListCollections(request.Context(), options)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, pageResponse[backendmodel.Collection]{Data: page.Data, NextCursor: page.NextCursor})
}

func (module *Module) createCollection(w http.ResponseWriter, request *http.Request) {
	var input struct {
		backendmodel.CreateCollectionInput
		Authentication json.RawMessage `json:"authentication,omitempty"`
		AccessRules    json.RawMessage `json:"accessRules,omitempty"`
	}
	if err := decodeJSON(w, request, &input); err != nil {
		writeProblem(w, request, err)
		return
	}
	var collection backendmodel.Collection
	var err error
	configuration := InitialConfiguration{Authentication: input.Authentication, AccessRules: input.AccessRules}
	if module.collectionInitializer != nil {
		collection, err = module.service.CreateCollectionWithInitializer(request.Context(), input.CreateCollectionInput, func(ctx context.Context, tx storage.Executor, collection backendmodel.Collection) error {
			return module.collectionInitializer(ctx, tx, collection, configuration)
		})
	} else {
		if input.Type == backendmodel.CollectionTypeAuth || len(input.Authentication) > 0 || len(input.AccessRules) > 0 {
			writeProblem(w, request, requestProblem{status: http.StatusServiceUnavailable, code: "RUNTIME_NOT_READY", message: "Authentication and Access Rule defaults are not ready yet. Retry after the Runtime is ready."})
			return
		}
		collection, err = module.service.CreateCollection(request.Context(), input.CreateCollectionInput)
	}
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[backendmodel.Collection]{Data: collection})
}

func (module *Module) getCollection(w http.ResponseWriter, request *http.Request) {
	collection, err := module.service.GetCollection(request.Context(), request.PathValue("collectionId"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.Collection]{Data: collection})
}

func (module *Module) getPendingChange(w http.ResponseWriter, request *http.Request) {
	change, exists, err := module.service.GetPendingChange(request.Context(), request.PathValue("collectionId"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	if !exists {
		httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[*backendmodel.PendingChange]{Data: nil})
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.PendingChange]{Data: change})
}

func (module *Module) saveOperation(w http.ResponseWriter, request *http.Request) {
	var input backendmodel.PendingOperationInput
	if err := decodeJSON(w, request, &input); err != nil {
		writeProblem(w, request, err)
		return
	}
	change, err := module.service.SaveOperation(request.Context(), request.PathValue("collectionId"), input)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[backendmodel.PendingChange]{Data: change})
}

func (module *Module) updateOperation(w http.ResponseWriter, request *http.Request) {
	var input backendmodel.PendingOperationInput
	if err := decodeJSON(w, request, &input); err != nil {
		writeProblem(w, request, err)
		return
	}
	change, err := module.service.UpdateOperation(request.Context(), request.PathValue("collectionId"), request.PathValue("operationId"), input)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.PendingChange]{Data: change})
}

func (module *Module) removeOperation(w http.ResponseWriter, request *http.Request) {
	_, err := module.service.RemoveOperation(request.Context(), request.PathValue("collectionId"), request.PathValue("operationId"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) preview(w http.ResponseWriter, request *http.Request) {
	var input versionRequest
	if err := decodeJSON(w, request, &input); err != nil {
		writeProblem(w, request, err)
		return
	}
	preview, err := module.service.Preview(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.SchemaPreview]{Data: preview})
}

type versionRequest struct {
	ExpectedVersion int `json:"expectedVersion"`
}

func (module *Module) apply(w http.ResponseWriter, request *http.Request) {
	var input struct {
		ExpectedVersion int  `json:"expectedVersion"`
		ConfirmRisk     bool `json:"confirmRisk"`
	}
	if err := decodeJSON(w, request, &input); err != nil {
		writeProblem(w, request, err)
		return
	}
	result, err := module.service.Apply(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion, input.ConfirmRisk)
	if err != nil {
		details := map[string]any{}
		if result.Recovery != nil {
			details["recovery"] = result.Recovery
			details["applyAttemptId"] = result.ApplyAttemptID
		} else if errors.Is(err, backendmodel.ErrChangeConfirmationRequired) || errors.Is(err, backendmodel.ErrChangeBlocked) {
			preview, previewErr := module.service.Preview(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
			if previewErr == nil {
				details["preview"] = preview
			}
		}
		writeProblemDetails(w, request, err, details)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.ApplyResult]{Data: result})
}

func (module *Module) discard(w http.ResponseWriter, request *http.Request) {
	var input versionRequest
	if err := decodeJSON(w, request, &input); err != nil {
		writeProblem(w, request, err)
		return
	}
	change, err := module.service.Discard(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.PendingChange]{Data: change})
}

func (module *Module) history(w http.ResponseWriter, request *http.Request) {
	options, err := parseListOptions(request)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	page, err := module.service.History(request.Context(), request.PathValue("collectionId"), options)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, pageResponse[backendmodel.AppliedMigration]{Data: page.Data, NextCursor: page.NextCursor})
}

func (module *Module) listChanges(w http.ResponseWriter, request *http.Request) {
	options, err := parseListOptions(request)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	page, err := module.service.ListChanges(request.Context(), options)
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	changes := make([]any, 0, len(page.Data))
	for _, entry := range page.Data {
		if entry.PendingChange != nil {
			changes = append(changes, entry.PendingChange)
		}
		if entry.AppliedMigration != nil {
			changes = append(changes, entry.AppliedMigration)
		}
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, pageResponse[any]{Data: changes, NextCursor: page.NextCursor})
}

func (module *Module) getChange(w http.ResponseWriter, request *http.Request) {
	change, err := module.service.GetChange(request.Context(), request.PathValue("changeSetId"))
	if err != nil {
		writeProblem(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[backendmodel.ChangeDetail]{Data: change})
}

func parseListOptions(request *http.Request) (backendmodel.ListOptions, error) {
	options := backendmodel.ListOptions{Cursor: request.URL.Query().Get("cursor")}
	limit := request.URL.Query().Get("limit")
	if limit == "" {
		return options, nil
	}
	parsed, err := strconv.Atoi(limit)
	if err != nil || parsed < 1 || parsed > 100 {
		return backendmodel.ListOptions{}, requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "Limit must be an integer between 1 and 100."}
	}
	options.Limit = parsed
	return options, nil
}

func decodeJSON(w http.ResponseWriter, request *http.Request, destination any) error {
	if !strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "application/json") {
		return requestProblem{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this request as application/json."}
	}
	request.Body = http.MaxBytesReader(w, request.Body, maxRequestBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if errors.Is(err, io.EOF) {
			return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "A JSON request body is required."}
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return requestProblem{status: http.StatusRequestEntityTooLarge, code: "PAYLOAD_TOO_LARGE", message: "The request body exceeds the supported size."}
		}
		return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain valid JSON with supported fields."}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain exactly one JSON value."}
	}
	return nil
}

type requestProblem struct {
	status  int
	code    string
	message string
}

func (problem requestProblem) Error() string { return problem.message }

func writeProblem(w http.ResponseWriter, request *http.Request, err error) {
	writeProblemDetails(w, request, err, nil)
}

func writeProblemDetails(w http.ResponseWriter, request *http.Request, err error, details map[string]any) {
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this request."}
	status := http.StatusInternalServerError
	var input requestProblem
	var applyFailure *backendmodel.ApplyFailure
	switch {
	case errors.As(err, &input):
		status = input.status
		problem.Code = input.code
		problem.Message = input.message
	case errors.Is(err, ErrConfigurationNotReady):
		status = http.StatusServiceUnavailable
		problem.Code = "RUNTIME_NOT_READY"
		problem.Message = "This Collection type is not ready yet. Retry after the Runtime finishes initializing its authentication services."
	case errors.As(err, &applyFailure):
		problem.Code = applyFailure.Code
		problem.Message = applyFailure.Message
		if applyFailure.Code == "CHANGE_CONFIRMATION_REQUIRED" {
			status = http.StatusConflict
		} else if applyFailure.Code == "CONFLICT" {
			status = http.StatusConflict
		} else if applyFailure.Code == "VALIDATION_FAILED" {
			status = http.StatusUnprocessableEntity
		} else {
			status = http.StatusInternalServerError
		}
	case errors.Is(err, backendmodel.ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The request contains an invalid value. Review the field requirements and try again."
	case errors.Is(err, backendmodel.ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The requested resource was not found."
	case errors.Is(err, backendmodel.ErrConflict):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "The resource changed or conflicts with current project state. Reload and try again."
	case errors.Is(err, backendmodel.ErrChangeConfirmationRequired):
		status = http.StatusConflict
		problem.Code = "CHANGE_CONFIRMATION_REQUIRED"
		problem.Message = "Review the current impact and confirm the schema change before applying."
	case errors.Is(err, backendmodel.ErrChangeBlocked):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "The schema change is blocked by current records or a missing relation target."
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		status = http.StatusServiceUnavailable
		problem.Code = "RUNTIME_NOT_READY"
		problem.Message = "The Runtime could not finish this request. Retry after it is ready."
	}
	if details != nil {
		problem.Details = details
	}
	httpapi.WriteAPIError(w, request, status, problem)
}
