package audit

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

type Module struct {
	service *Service
}

func NewModule(service *Service) *Module { return &Module{service: service} }

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/audit", module.list)
	mux.HandleFunc("GET /admin/api/v1/audit/{auditRecordId}", module.get)
}

func (module *Module) list(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	options := ListOptions{Cursor: request.URL.Query().Get("cursor")}
	query := request.URL.Query()
	allowed := map[string]struct{}{
		"limit": {}, "cursor": {}, "search": {}, "actorKind": {}, "actorId": {}, "action": {},
		"resourceKind": {}, "resourceId": {}, "from": {}, "to": {},
	}
	for name, values := range query {
		if _, ok := allowed[name]; !ok || len(values) != 1 {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
	}
	options.Search = query.Get("search")
	options.ActorKind = ActorKind(query.Get("actorKind"))
	options.ActorID = query.Get("actorId")
	options.Action = query.Get("action")
	options.ResourceKind = query.Get("resourceKind")
	options.ResourceID = query.Get("resourceId")
	if value := request.URL.Query().Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
		options.Limit = limit
	}
	for name, target := range map[string]**time.Time{"from": &options.From, "to": &options.To} {
		values, supplied := query[name]
		if !supplied {
			continue
		}
		if values[0] == "" {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
		parsed, err := time.Parse(time.RFC3339Nano, values[0])
		if err != nil {
			module.writeError(w, request, ErrInvalidArgument)
			return
		}
		value := parsed.UTC()
		*target = &value
	}
	page, err := module.service.List(request.Context(), options)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, page)
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	record, err := module.service.Get(request.Context(), request.PathValue("auditRecordId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Record `json:"data"`
	}{Data: record})
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Audit is not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not read Audit history."}
	switch {
	case errors.Is(err, ErrInvalidArgument):
		status, problem.Code, problem.Message = http.StatusBadRequest, "INVALID_ARGUMENT", "The Audit query or identifier is invalid."
	case errors.Is(err, ErrNotFound):
		status, problem.Code, problem.Message = http.StatusNotFound, "NOT_FOUND", "The requested Audit record was not found."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrStorage):
		status, problem.Code, problem.Message = http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Audit history could not be read. Retry after the Runtime is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)
