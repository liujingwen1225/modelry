package accesscontrol

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maxRequestBody = 1 << 20

type Module struct {
	service *Service
}

type dataResponse[T any] struct {
	Data T `json:"data"`
}

func NewModule(service *Service) *Module { return &Module{service: service} }

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/access-rules", module.get)
	mux.HandleFunc("PUT /admin/api/v1/collections/{collectionId}/access-rules", module.save)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/access-rules/apply", module.apply)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/access-rules/discard", module.discard)
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	state, err := module.service.Get(request.Context(), request.PathValue("collectionId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[RulesState]{Data: state})
}

func (module *Module) save(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input SaveInput
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	state, err := module.service.Save(request.Context(), request.PathValue("collectionId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[RulesState]{Data: state})
}

func (module *Module) apply(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input versionRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	state, err := module.service.Apply(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[RulesState]{Data: state})
}

func (module *Module) discard(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input versionRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	state, err := module.service.Discard(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[RulesState]{Data: state})
}

type versionRequest struct {
	ExpectedVersion int `json:"expectedVersion"`
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Access Rule services are not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

type requestProblem struct {
	status  int
	code    string
	message string
}

func (problem requestProblem) Error() string { return problem.message }

func decodeRequest(w http.ResponseWriter, request *http.Request, destination any) error {
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
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain exactly one JSON value."}
	}
	return nil
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this request."}
	status := http.StatusInternalServerError
	var input requestProblem
	var violation *ValidationFailure
	switch {
	case errors.As(err, &input):
		status = input.status
		problem.Code = input.code
		problem.Message = input.message
	case errors.As(err, &violation):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "Review the Access Rule requirements and try again."
		problem.Hint = "Correct the highlighted Access Rule values, then save again."
		problem.Details = map[string]any{"violations": []Violation{violation.Violation}}
	case errors.Is(err, ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The request contains an invalid value. Review the requirements and try again."
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The requested Collection Access Rules were not found."
	case errors.Is(err, ErrConflict):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "Access Rules changed. Reload them and retry the operation."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		status = http.StatusServiceUnavailable
		problem.Code = "RUNTIME_NOT_READY"
		problem.Message = "The Runtime could not finish this request. Retry after it is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)
