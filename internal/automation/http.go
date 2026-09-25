package automation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maximumAutomationRequestBytes = 1 << 20

type Module struct {
	service *Service
}

// NewModule 创建 Webhook、Event Hook、Job 与 Delivery Admin API 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册只供已认证 Owner 使用的自动化路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	register := func(pattern string, handler http.HandlerFunc) {
		mux.HandleFunc(pattern, module.protect(handler))
	}
	register("GET /admin/api/v1/webhooks", module.listWebhooks)
	register("POST /admin/api/v1/webhooks", module.createWebhook)
	register("GET /admin/api/v1/webhooks/{webhookId}", module.getWebhook)
	register("PUT /admin/api/v1/webhooks/{webhookId}", module.replaceWebhook)
	register("POST /admin/api/v1/webhooks/{webhookId}/enable", module.enableWebhook)
	register("POST /admin/api/v1/webhooks/{webhookId}/disable", module.disableWebhook)
	register("POST /admin/api/v1/webhooks/{webhookId}/test", module.testWebhook)
	register("GET /admin/api/v1/event-hooks", module.listEventHooks)
	register("POST /admin/api/v1/event-hooks", module.createEventHook)
	register("GET /admin/api/v1/event-hooks/{eventHookId}", module.getEventHook)
	register("PUT /admin/api/v1/event-hooks/{eventHookId}", module.replaceEventHook)
	register("POST /admin/api/v1/event-hooks/{eventHookId}/enable", module.enableEventHook)
	register("POST /admin/api/v1/event-hooks/{eventHookId}/disable", module.disableEventHook)
	register("GET /admin/api/v1/jobs", module.listJobs)
	register("POST /admin/api/v1/jobs", module.createJob)
	register("GET /admin/api/v1/jobs/{jobId}", module.getJob)
	register("PUT /admin/api/v1/jobs/{jobId}", module.replaceJob)
	register("POST /admin/api/v1/jobs/{jobId}/enable", module.enableJob)
	register("POST /admin/api/v1/jobs/{jobId}/disable", module.disableJob)
	register("GET /admin/api/v1/deliveries", module.listDeliveries)
	register("GET /admin/api/v1/deliveries/{deliveryId}", module.getDelivery)
	register("POST /admin/api/v1/deliveries/{deliveryId}/retry", module.retryDelivery)
}

func (module *Module) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if _, ok := adminauth.OwnerFromContext(request.Context()); !ok {
			automationHTTPError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "An active Owner session is required.", nil)
			return
		}
		if module == nil || module.service == nil {
			automationHTTPError(w, request, http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Automation services are not ready yet. Retry after the Runtime is ready.", nil)
			return
		}
		next(w, request)
	}
}

type automationData[T any] struct {
	Data T `json:"data"`
}

func (module *Module) listWebhooks(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	items, err := module.service.ListWebhooks(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[[]Webhook]{Data: items})
}

func (module *Module) createWebhook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	var input WebhookInput
	if err := decodeAutomationJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.CreateWebhook(request.Context(), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, automationData[Webhook]{Data: item})
}

func (module *Module) getWebhook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	item, err := module.service.GetWebhook(request.Context(), request.PathValue("webhookId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[Webhook]{Data: item})
}

func (module *Module) replaceWebhook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	var input WebhookInput
	if err := decodeAutomationJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.ReplaceWebhook(request.Context(), request.PathValue("webhookId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[Webhook]{Data: item})
}

func (module *Module) enableWebhook(w http.ResponseWriter, request *http.Request) {
	module.webhookStatus(w, request, module.service.EnableWebhook)
}

func (module *Module) disableWebhook(w http.ResponseWriter, request *http.Request) {
	module.webhookStatus(w, request, module.service.DisableWebhook)
}

func (module *Module) webhookStatus(w http.ResponseWriter, request *http.Request, change func(context.Context, string) (WebhookStatus, error)) {
	if !noQuery(w, request) || !noBody(w, request) {
		return
	}
	item, err := change(request.Context(), request.PathValue("webhookId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[WebhookStatus]{Data: item})
}

func (module *Module) testWebhook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) || !noBody(w, request) {
		return
	}
	item, err := module.service.CreateTestDelivery(request.Context(), request.PathValue("webhookId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusAccepted, automationData[Delivery]{Data: item})
}

func (module *Module) listEventHooks(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	items, err := module.service.ListEventHooks(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[[]EventHook]{Data: items})
}

func (module *Module) createEventHook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	var input EventHookInput
	if err := decodeAutomationJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.CreateEventHook(request.Context(), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, automationData[EventHook]{Data: item})
}

func (module *Module) getEventHook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	item, err := module.service.GetEventHook(request.Context(), request.PathValue("eventHookId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[EventHook]{Data: item})
}

func (module *Module) replaceEventHook(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	var input EventHookInput
	if err := decodeAutomationJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.ReplaceEventHook(request.Context(), request.PathValue("eventHookId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[EventHook]{Data: item})
}

func (module *Module) enableEventHook(w http.ResponseWriter, request *http.Request) {
	module.eventHookStatus(w, request, module.service.EnableEventHook)
}

func (module *Module) disableEventHook(w http.ResponseWriter, request *http.Request) {
	module.eventHookStatus(w, request, module.service.DisableEventHook)
}

func (module *Module) eventHookStatus(w http.ResponseWriter, request *http.Request, change func(context.Context, string) (EventHookStatus, error)) {
	if !noQuery(w, request) || !noBody(w, request) {
		return
	}
	item, err := change(request.Context(), request.PathValue("eventHookId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[EventHookStatus]{Data: item})
}

func (module *Module) listJobs(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	items, err := module.service.ListJobs(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[[]Job]{Data: items})
}

func (module *Module) createJob(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	var input JobInput
	if err := decodeAutomationJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.CreateJob(request.Context(), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, automationData[Job]{Data: item})
}

func (module *Module) getJob(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	item, err := module.service.GetJob(request.Context(), request.PathValue("jobId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[Job]{Data: item})
}

func (module *Module) replaceJob(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	var input JobInput
	if err := decodeAutomationJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	item, err := module.service.ReplaceJob(request.Context(), request.PathValue("jobId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[Job]{Data: item})
}

func (module *Module) enableJob(w http.ResponseWriter, request *http.Request) {
	module.jobStatus(w, request, module.service.EnableJob)
}

func (module *Module) disableJob(w http.ResponseWriter, request *http.Request) {
	module.jobStatus(w, request, module.service.DisableJob)
}

func (module *Module) jobStatus(w http.ResponseWriter, request *http.Request, change func(context.Context, string) (JobStatus, error)) {
	if !noQuery(w, request) || !noBody(w, request) {
		return
	}
	item, err := change(request.Context(), request.PathValue("jobId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[JobStatus]{Data: item})
}

func (module *Module) listDeliveries(w http.ResponseWriter, request *http.Request) {
	options, err := parseDeliveryListQuery(request.URL.Query())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	page, err := module.service.ListDeliveries(request.Context(), options)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, page)
}

func (module *Module) getDelivery(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) {
		return
	}
	item, err := module.service.GetDelivery(request.Context(), request.PathValue("deliveryId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, automationData[Delivery]{Data: item})
}

func (module *Module) retryDelivery(w http.ResponseWriter, request *http.Request) {
	if !noQuery(w, request) || !noBody(w, request) {
		return
	}
	item, err := module.service.RetryDelivery(request.Context(), request.PathValue("deliveryId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusAccepted, automationData[Delivery]{Data: item})
}

type automationRequestProblem struct {
	status int
	code   string
	text   string
}

func (problem automationRequestProblem) Error() string { return problem.text }

func noQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery == "" {
		return true
	}
	automationHTTPError(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "This route does not accept query parameters.", nil)
	return false
}

func noBody(w http.ResponseWriter, request *http.Request) bool {
	if request.Body == nil || request.ContentLength == 0 {
		return true
	}
	var one [1]byte
	n, err := request.Body.Read(one[:])
	if n == 0 && errors.Is(err, io.EOF) {
		return true
	}
	automationHTTPError(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "This action does not accept a request body.", nil)
	return false
}

func decodeAutomationJSON(w http.ResponseWriter, request *http.Request, destination any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return automationRequestProblem{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", text: "Send this request as application/json."}
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumAutomationRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return automationRequestProblem{status: http.StatusRequestEntityTooLarge, code: "PAYLOAD_TOO_LARGE", text: "The request body exceeds the supported size."}
		}
		return automationRequestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", text: "The request body must contain one valid JSON object with supported fields."}
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return automationRequestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", text: "The request body must contain exactly one JSON value."}
	}
	return nil
}

func parseDeliveryListQuery(query url.Values) (DeliveryListOptions, error) {
	for key, values := range query {
		if (key != "cursor" && key != "limit" && key != "sourceType" && key != "status") || len(values) != 1 {
			return DeliveryListOptions{}, ErrInvalidArgument
		}
	}
	options := DeliveryListOptions{Cursor: query.Get("cursor"), SourceType: query.Get("sourceType"), Status: query.Get("status")}
	if raw := query.Get("limit"); raw != "" {
		if raw[0] < '0' || raw[0] > '9' {
			return DeliveryListOptions{}, ErrInvalidArgument
		}
		for _, character := range raw {
			if character < '0' || character > '9' {
				return DeliveryListOptions{}, ErrInvalidArgument
			}
		}
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return DeliveryListOptions{}, ErrInvalidArgument
		}
		options.Limit = limit
	} else if query.Has("limit") {
		return DeliveryListOptions{}, ErrInvalidArgument
	}
	if options.Cursor == "" && query.Has("cursor") || options.SourceType == "" && query.Has("sourceType") || options.Status == "" && query.Has("status") {
		return DeliveryListOptions{}, ErrInvalidArgument
	}
	return options, nil
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	var requestProblem automationRequestProblem
	if errors.As(err, &requestProblem) {
		automationHTTPError(w, request, requestProblem.status, requestProblem.code, requestProblem.text, nil)
		return
	}
	var validation *ValidationError
	if errors.As(err, &validation) {
		violations := make([]map[string]string, 0, len(validation.Violations))
		for _, violation := range validation.Violations {
			violations = append(violations, map[string]string{"path": violation.Path, "code": violation.Code, "message": violation.Message})
		}
		automationHTTPError(w, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Review the highlighted automation values and try again.", map[string]any{"violations": violations})
		return
	}
	switch {
	case errors.Is(err, ErrNotFound):
		automationHTTPError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested automation resource was not found.", nil)
	case errors.Is(err, ErrDeliveryCapacity):
		automationHTTPError(w, request, http.StatusTooManyRequests, "DELIVERY_CAPACITY_EXCEEDED", "Delivery capacity is full. Retry after pending work completes.", nil)
	case errors.Is(err, ErrNotRetryable):
		automationHTTPError(w, request, http.StatusConflict, "DELIVERY_NOT_RETRYABLE", "This Delivery is not eligible for another attempt.", nil)
	case errors.Is(err, ErrInvalidArgument):
		automationHTTPError(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "The automation request contains an invalid value.", nil)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		automationHTTPError(w, request, http.StatusServiceUnavailable, "AUTOMATION_UNAVAILABLE", "Automation storage is temporarily unavailable. Retry the request.", nil)
	default:
		automationHTTPError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "The Runtime could not complete this automation request.", nil)
	}
}

func automationHTTPError(w http.ResponseWriter, request *http.Request, status int, code, message string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	httpapi.WriteAPIError(w, request, status, httpapi.APIError{Code: code, Message: message, Details: details})
}

var _ httpapi.APIModule = (*Module)(nil)
