package mail

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maximumMailRequestBytes = 32 << 10

// Module 暴露 Owner 可读写的 Mail Provider 与投递历史。
// 路由权限由 Control Plane 中间件的 operation 映射与 Service Account Permission 共同保证。
type Module struct{ service *Service }

// NewModule 创建 Mail Admin API 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册 Mail Provider 路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/mail", module.getStatus)
	mux.HandleFunc("PUT /admin/api/v1/mail", module.saveConfig)
	mux.HandleFunc("POST /admin/api/v1/mail/test", module.sendTest)
	mux.HandleFunc("GET /admin/api/v1/mail/deliveries", module.listDeliveries)
	mux.HandleFunc("POST /admin/api/v1/mail/deliveries/{deliveryId}/retry", module.retryDelivery)
}

type mailData[T any] struct {
	Data T `json:"data"`
}

type secretReferenceDTO struct {
	SecretID   string `json:"secretId"`
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
}

type mailProviderDTO struct {
	Enabled     bool                `json:"enabled"`
	Host        string              `json:"host"`
	Port        int                 `json:"port"`
	Security    string              `json:"security"`
	FromAddress string              `json:"fromAddress"`
	FromName    string              `json:"fromName"`
	Username    *secretReferenceDTO `json:"username"`
	Password    *secretReferenceDTO `json:"password"`
	Revision    int                 `json:"revision"`
	UpdatedAt   time.Time           `json:"updatedAt"`
}

type mailProviderInput struct {
	ExpectedRevision  int    `json:"expectedRevision"`
	Enabled           bool   `json:"enabled"`
	Host              string `json:"host"`
	Port              int    `json:"port"`
	Security          string `json:"security"`
	FromAddress       string `json:"fromAddress"`
	FromName          string `json:"fromName"`
	UsernameSecretID  string `json:"usernameSecretId"`
	PasswordSecretID  string `json:"passwordSecretId"`
}

type mailTestInput struct {
	Recipient string `json:"recipient"`
}

type mailTestResultDTO struct {
	State   string `json:"state"`
	Message string `json:"message"`
}

type mailDeliveryDTO struct {
	ID            string     `json:"id"`
	Kind          string     `json:"kind"`
	Recipient     string     `json:"recipient"`
	Status        string     `json:"status"`
	Attempts      int        `json:"attempts"`
	NextAttemptAt *time.Time `json:"nextAttemptAt"`
	ErrorCode     string     `json:"errorCode"`
	CreatedAt     time.Time  `json:"createdAt"`
	CompletedAt   *time.Time `json:"completedAt"`
}

func (module *Module) getStatus(w http.ResponseWriter, request *http.Request) {
	status, err := module.service.Status(request.Context())
	if err != nil {
		writeMailError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, mailData[mailProviderDTO]{Data: module.providerView(request.Context(), status)})
}

func (module *Module) providerView(ctx context.Context, status Status) mailProviderDTO {
	view := mailProviderDTO{
		Enabled: status.Config.Enabled, Host: status.Config.Host, Port: status.Config.Port,
		Security: string(status.Config.Security), FromAddress: status.Config.FromAddress,
		FromName: status.Config.FromName, Revision: status.Config.Revision, UpdatedAt: status.Config.UpdatedAt,
	}
	view.Username = module.secretView(ctx, status.Config.UsernameSecretID)
	view.Password = module.secretView(ctx, status.Config.PasswordSecretID)
	return view
}

func (module *Module) secretView(ctx context.Context, secretID string) *secretReferenceDTO {
	if secretID == "" {
		return nil
	}
	name, configured, err := module.service.secrets.SecretMetadata(ctx, secretID)
	if err != nil {
		return &secretReferenceDTO{SecretID: secretID, Configured: false}
	}
	return &secretReferenceDTO{SecretID: secretID, Name: name, Configured: configured}
}

func (module *Module) saveConfig(w http.ResponseWriter, request *http.Request) {
	var input mailProviderInput
	if err := decodeMailJSON(w, request, &input); err != nil {
		writeMailError(w, request, err)
		return
	}
	config, err := module.service.SaveConfig(request.Context(), input.ExpectedRevision, Config{
		Enabled: input.Enabled, Host: input.Host, Port: input.Port, Security: ProviderSecurity(input.Security),
		FromAddress: input.FromAddress, FromName: input.FromName,
		UsernameSecretID: input.UsernameSecretID, PasswordSecretID: input.PasswordSecretID,
	})
	if err != nil {
		writeMailError(w, request, err)
		return
	}
	status := Status{Config: config}
	httpapi.WriteAPIJSON(w, http.StatusOK, mailData[mailProviderDTO]{Data: module.providerView(request.Context(), status)})
}

func (module *Module) sendTest(w http.ResponseWriter, request *http.Request) {
	var input mailTestInput
	if err := decodeMailJSON(w, request, &input); err != nil {
		writeMailError(w, request, err)
		return
	}
	delivery, err := module.service.SendTest(request.Context(), input.Recipient)
	if err != nil {
		writeMailError(w, request, err)
		return
	}
	result := mailTestResultDTO{State: "delivered", Message: "The test message was accepted by the mail provider."}
	if delivery.Status != DeliverySucceeded {
		result.State = "unavailable"
		result.Message = mailFailureMessage(delivery.ErrorCode)
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, mailData[mailTestResultDTO]{Data: result})
}

func mailFailureMessage(errorCode string) string {
	switch errorCode {
	case ErrorCredentialMissing, ErrorAuthentication:
		return "The mail provider rejected the credentials. Update the credential Secrets and retry."
	case ErrorRejected:
		return "The mail provider rejected the recipient address."
	case ErrorProviderDisabled:
		return "The mail provider is not enabled yet."
	default:
		return "The mail provider did not accept the message. Check host, port, and transport security."
	}
}

func (module *Module) listDeliveries(w http.ResponseWriter, request *http.Request) {
	deliveries, err := module.service.ListDeliveries(request.Context(), 20)
	if err != nil {
		writeMailError(w, request, err)
		return
	}
	views := make([]mailDeliveryDTO, 0, len(deliveries))
	for _, delivery := range deliveries {
		views = append(views, mailDeliveryView(delivery))
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, mailData[[]mailDeliveryDTO]{Data: views})
}

func mailDeliveryView(delivery Delivery) mailDeliveryDTO {
	return mailDeliveryDTO{
		ID: delivery.ID, Kind: string(delivery.Kind), Recipient: delivery.Recipient, Status: string(delivery.Status),
		Attempts: delivery.Attempts, NextAttemptAt: delivery.NextAttemptAt, ErrorCode: delivery.ErrorCode,
		CreatedAt: delivery.CreatedAt, CompletedAt: delivery.CompletedAt,
	}
}

func (module *Module) retryDelivery(w http.ResponseWriter, request *http.Request) {
	delivery, err := module.service.RetryDelivery(request.Context(), request.PathValue("deliveryId"))
	if err != nil {
		writeMailError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, mailData[mailDeliveryDTO]{Data: mailDeliveryView(delivery)})
}

func decodeMailJSON(w http.ResponseWriter, request *http.Request, destination any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return &mailHTTPError{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this request as application/json."}
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumMailRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return &mailHTTPError{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain one valid JSON object."}
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return &mailHTTPError{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The request body must contain exactly one JSON object."}
	}
	return nil
}

type mailHTTPError struct {
	status  int
	code    string
	message string
}

func (fault *mailHTTPError) Error() string { return fault.message }

func writeMailError(w http.ResponseWriter, request *http.Request, err error) {
	var fault *mailHTTPError
	if errors.As(err, &fault) {
		httpapi.WriteAPIError(w, request, fault.status, httpapi.APIError{Code: fault.code, Message: fault.message, Details: map[string]any{}})
		return
	}
	switch {
	case errors.Is(err, ErrNotFound):
		httpapi.WriteAPIError(w, request, http.StatusNotFound, httpapi.APIError{Code: "NOT_FOUND", Message: "The requested Mail Delivery was not found.", Details: map[string]any{}})
	case errors.Is(err, ErrConflict):
		httpapi.WriteAPIError(w, request, http.StatusConflict, httpapi.APIError{Code: "CONFLICT", Message: "The Mail configuration changed; reload and retry.", Details: map[string]any{}})
	case errors.Is(err, ErrNotConfigured):
		httpapi.WriteAPIError(w, request, http.StatusConflict, httpapi.APIError{Code: "MAIL_NOT_CONFIGURED", Message: "Enable the Mail Provider with host, port, sender address, and credential Secrets first.", Details: map[string]any{}, Hint: "Open Settings, configure Mail, and send a test message."})
	case errors.Is(err, ErrCredentialUnavailable):
		httpapi.WriteAPIError(w, request, http.StatusConflict, httpapi.APIError{Code: "MAIL_CREDENTIAL_UNAVAILABLE", Message: "A Mail credential Secret is missing or cannot be decrypted.", Details: map[string]any{}})
	case errors.Is(err, ErrCapacity):
		httpapi.WriteAPIError(w, request, http.StatusTooManyRequests, httpapi.APIError{Code: "MAIL_CAPACITY_EXCEEDED", Message: "The Mail queue is full. Wait for pending deliveries to finish.", Details: map[string]any{}})
	case errors.Is(err, ErrInvalidArgument):
		httpapi.WriteAPIError(w, request, http.StatusBadRequest, httpapi.APIError{Code: "INVALID_ARGUMENT", Message: "The Mail request contains an invalid value.", Details: map[string]any{}})
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{Code: "MAIL_UNAVAILABLE", Message: "The Mail Provider is not reachable.", Details: map[string]any{}})
	default:
		httpapi.WriteAPIError(w, request, http.StatusInternalServerError, httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this Mail request.", Details: map[string]any{}})
	}
}

var _ = context.Background
