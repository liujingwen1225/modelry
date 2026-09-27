package appauth

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
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/requests"
)

const maxRequestBody = 1 << 20

type Module struct {
	service *Service
}

func NewModule(service *Service) *Module { return &Module{service: service} }

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/authentication", module.getConfiguration)
	mux.HandleFunc("PUT /admin/api/v1/collections/{collectionId}/authentication", module.saveConfiguration)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/authentication/apply", module.applyConfiguration)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/authentication/discard", module.discardConfiguration)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/users", module.listUsers)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/users", module.createUser)
	mux.HandleFunc("PUT /admin/api/v1/collections/{collectionId}/users/{recordId}/password", module.setPassword)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/users/{recordId}/sessions", module.listUserSessions)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/sessions/{sessionId}/revoke", module.revokeUserSession)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/users/{recordId}/sessions/revoke-all", module.revokeAllUserSessions)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/register", module.register)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/login", module.login)
	mux.HandleFunc("GET /api/v1/auth/{collectionName}/session", module.getSession)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/logout", module.logout)
	mux.HandleFunc("PUT /api/v1/auth/{collectionName}/password", module.changePassword)
	mux.HandleFunc("GET /api/v1/auth/{collectionName}/sessions", module.listOwnSessions)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/sessions/{sessionId}/revoke", module.revokeOwnSession)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/password-reset/request", module.requestPasswordReset)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/password-reset/confirm", module.confirmPasswordReset)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/email-verification/request", module.requestEmailVerification)
	mux.HandleFunc("POST /api/v1/auth/{collectionName}/email-verification/confirm", module.confirmEmailVerification)
}

type dataResponse[T any] struct {
	Data T `json:"data"`
}

func (module *Module) getConfiguration(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	state, err := module.service.GetConfiguration(request.Context(), request.PathValue("collectionId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[AuthConfigState]{Data: state})
}

func (module *Module) saveConfiguration(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input AuthConfigSaveInput
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	state, err := module.service.SaveConfiguration(request.Context(), request.PathValue("collectionId"), input)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[AuthConfigState]{Data: state})
}

func (module *Module) applyConfiguration(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input versionRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	state, err := module.service.ApplyConfiguration(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[AuthConfigState]{Data: state})
}

func (module *Module) discardConfiguration(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input versionRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	state, err := module.service.DiscardConfiguration(request.Context(), request.PathValue("collectionId"), input.ExpectedVersion)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[AuthConfigState]{Data: state})
}

func (module *Module) listUsers(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	options, err := parseListOptions(request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	page, err := module.service.ListUsers(request.Context(), request.PathValue("collectionId"), options)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, page)
}

func (module *Module) createUser(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input userRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	record, err := module.service.CreateUser(request.Context(), request.PathValue("collectionId"), input.Profile, input.Password)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[records.Record]{Data: record})
}

func (module *Module) setPassword(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	var input passwordRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	if err := module.service.SetPassword(request.Context(), request.PathValue("collectionId"), request.PathValue("recordId"), input.Password); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) listUserSessions(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	sessions, err := module.service.ListUserSessions(request.Context(), request.PathValue("collectionId"), request.PathValue("recordId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[[]ApplicationSession]{Data: sessions})
}

func (module *Module) revokeUserSession(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if err := module.service.RevokeUserSession(request.Context(), request.PathValue("collectionId"), request.PathValue("sessionId")); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) revokeAllUserSessions(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	if err := module.service.RevokeAllUserSessions(request.Context(), request.PathValue("collectionId"), request.PathValue("recordId")); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type userRequest struct {
	Profile  map[string]any `json:"profile"`
	Password string         `json:"password"`
}

type passwordRequest struct {
	Password string `json:"password"`
}

type registrationRequest struct {
	Profile  map[string]any `json:"profile"`
	Password string         `json:"password"`
}

func (module *Module) register(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
	var input registrationRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	record, err := module.service.RegisterWithOrigin(request.Context(), request.PathValue("collectionName"), input.Profile, input.Password, requestOrigin(request))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, dataResponse[records.Record]{Data: record})
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (module *Module) login(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
	var input loginRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	result, err := module.service.Login(request.Context(), request.PathValue("collectionName"), input.Email, input.Password)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAuthenticated)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	httpapi.WriteAPIJSON(w, http.StatusOK, result)
}

func (module *Module) getSession(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	token, err := module.sessionToken(request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	session, err := module.service.GetSession(request.Context(), request.PathValue("collectionName"), token)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[ApplicationSession]{Data: session})
}

func (module *Module) logout(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	token, err := module.sessionToken(request)
	if err == nil {
		err = module.service.Logout(request.Context(), request.PathValue("collectionName"), token)
	}
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (module *Module) changePassword(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	token, err := module.sessionToken(request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	var input changePasswordRequest
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	err = module.service.ChangePassword(request.Context(), request.PathValue("collectionName"), token, input.CurrentPassword, input.NewPassword)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) listOwnSessions(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	token, err := module.sessionToken(request)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	sessions, err := module.service.ListOwnSessions(request.Context(), request.PathValue("collectionName"), token)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[[]ApplicationSession]{Data: sessions})
}

func (module *Module) revokeOwnSession(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	token, err := module.sessionToken(request)
	if err == nil {
		err = module.service.RevokeOwnSession(request.Context(), request.PathValue("collectionName"), token, request.PathValue("sessionId"))
	}
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func bearerToken(request *http.Request) (string, error) {
	value := strings.TrimSpace(request.Header.Get("Authorization"))
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", ErrUnauthenticated
	}
	return parts[1], nil
}

func (module *Module) sessionToken(request *http.Request) (string, error) {
	token, err := bearerToken(request)
	if err != nil {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
		return "", err
	}
	if _, err := module.service.AuthenticateSession(request.Context(), token); err != nil {
		if errors.Is(err, ErrUnauthenticated) {
			requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
		}
		return "", err
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAuthenticated)
	return token, nil
}

type versionRequest struct {
	ExpectedVersion int `json:"expectedVersion"`
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

func parseListOptions(request *http.Request) (records.ListOptions, error) {
	options := records.ListOptions{Cursor: request.URL.Query().Get("cursor")}
	limit := request.URL.Query().Get("limit")
	if limit == "" {
		return options, nil
	}
	parsed, err := strconv.Atoi(limit)
	if err != nil || parsed < 1 || parsed > 100 {
		return records.ListOptions{}, requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "Limit must be an integer between 1 and 100."}
	}
	options.Limit = parsed
	return options, nil
}

func (module *Module) ready(w http.ResponseWriter, request *http.Request) bool {
	if module.service != nil {
		return true
	}
	httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
		Code: "RUNTIME_NOT_READY", Message: "Application Auth services are not ready yet. Retry after the Runtime is ready.",
	})
	return false
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not complete this request."}
	status := http.StatusInternalServerError
	var input requestProblem
	var violation *ValidationFailure
	var recordValueError *backendmodel.RecordValueError
	switch {
	case errors.Is(err, recordlifecycle.ErrRuntimeUnavailable):
		status = http.StatusServiceUnavailable
		problem.Code = "EXTENSION_RUNTIME_UNAVAILABLE"
		problem.Message = "A required Record lifecycle Extension is unavailable; no Profile or Credential was committed."
	case errors.Is(err, recordlifecycle.ErrRejected):
		status = http.StatusUnprocessableEntity
		problem.Code = "CHANGE_REJECTED_BY_EXTENSION"
		problem.Message = "A Record lifecycle Extension rejected this profile change."
	case errors.Is(err, recordlifecycle.ErrBudgetExceeded):
		status = http.StatusUnprocessableEntity
		problem.Code = "EXTENSION_BUDGET_EXCEEDED"
		problem.Message = "A Record lifecycle Extension exceeded its execution budget; no Profile or Credential was committed."
	case errors.Is(err, recordlifecycle.ErrInvalidOutput):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "A Record lifecycle Extension returned values that do not match the Applied Model."
	case errors.Is(err, recordevents.ErrEventTooLarge):
		status = http.StatusRequestEntityTooLarge
		problem.Code = "PAYLOAD_TOO_LARGE"
		problem.Message = "This App User Profile change exceeds the 1 MiB durable Event limit. Reduce the changed values and retry."
	case errors.As(err, &input):
		status, problem.Code, problem.Message = input.status, input.code, input.message
	case errors.As(err, &violation):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "Review the highlighted Auth values and try again."
		problem.Hint = "Correct the highlighted values, then save again."
		problem.Details = map[string]any{"violations": []Violation{violation.Violation}}
	case errors.Is(err, ErrEmailNotVerified):
		status = http.StatusForbidden
		problem.Code = "EMAIL_NOT_VERIFIED"
		problem.Message = "This Auth Collection requires a verified email address before sign-in."
		problem.Hint = "Open the verification message for this address, then confirm the code and sign in again."
	case errors.Is(err, ErrMailUnavailable):
		status = http.StatusConflict
		problem.Code = "MAIL_NOT_CONFIGURED"
		problem.Message = "Email delivery is not configured for this project yet."
		problem.Hint = "Ask a project administrator to configure Mail before using verification or password reset."
	case errors.Is(err, ErrRecoveryTokenInvalid):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "This confirmation code is invalid, expired, or already used."
		problem.Hint = "Request a new message and confirm the newest code."
	case errors.Is(err, ErrRegistrationDisabled):
		status = http.StatusForbidden
		problem.Code = "REGISTRATION_DISABLED"
		problem.Message = "Self registration is not enabled for this Auth Collection."
		problem.Hint = "Ask a project administrator to enable self registration or create an account for you."
	case errors.Is(err, ErrUnauthenticated):
		status = http.StatusUnauthorized
		problem.Code = "UNAUTHENTICATED"
		problem.Message = "The supplied Application credentials could not be validated."
	case errors.As(err, &recordValueError):
		status = http.StatusUnprocessableEntity
		problem.Code = "VALIDATION_FAILED"
		problem.Message = "Review the App User Profile fields and try again."
		problem.Details = map[string]any{"violations": []map[string]string{{"path": "/profile/" + recordValueError.Field, "code": recordValueError.Code, "message": recordValueError.Message}}}
	case errors.Is(err, ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The request contains an invalid value. Review the requirements and try again."
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The requested Auth Collection or App User was not found."
	case errors.Is(err, ErrConflict):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "The Auth state changed or conflicts with current Collection data. Reload and try again."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		status = http.StatusServiceUnavailable
		problem.Code = "RUNTIME_NOT_READY"
		problem.Message = "The Runtime could not finish this request. Retry after it is ready."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)

type recoveryRequestPayload struct {
	Email string `json:"email"`
}

type passwordResetConfirmPayload struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

type emailVerificationConfirmPayload struct {
	Token string `json:"token"`
}

type recoveryAcceptedResponse struct {
	Data struct {
		Accepted bool `json:"accepted"`
	} `json:"data"`
}

// requestOrigin 只用于记录发起恢复请求的来源，邮件正文不含绝对链接，避免 Host 欺骗重定向。
func requestOrigin(request *http.Request) string {
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	if strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto")), "https") {
		scheme = "https"
	}
	if request.Host == "" {
		return ""
	}
	return scheme + "://" + request.Host
}

func acceptedRecoveryResponse(w http.ResponseWriter) {
	response := recoveryAcceptedResponse{}
	response.Data.Accepted = true
	httpapi.WriteAPIJSON(w, http.StatusAccepted, response)
}

func (module *Module) requestPasswordReset(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
	var input recoveryRequestPayload
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	if err := module.service.RequestPasswordReset(request.Context(), request.PathValue("collectionName"), input.Email, requestOrigin(request)); err != nil {
		module.writeError(w, request, err)
		return
	}
	acceptedRecoveryResponse(w)
}

func (module *Module) confirmPasswordReset(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
	var input passwordResetConfirmPayload
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	if err := module.service.ConfirmPasswordReset(request.Context(), request.PathValue("collectionName"), input.Token, input.Password); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (module *Module) requestEmailVerification(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
	var input recoveryRequestPayload
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	if err := module.service.RequestEmailVerification(request.Context(), request.PathValue("collectionName"), input.Email, requestOrigin(request)); err != nil {
		module.writeError(w, request, err)
		return
	}
	acceptedRecoveryResponse(w)
}

func (module *Module) confirmEmailVerification(w http.ResponseWriter, request *http.Request) {
	if !module.ready(w, request) {
		return
	}
	requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
	var input emailVerificationConfirmPayload
	if err := decodeRequest(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	if err := module.service.ConfirmEmailVerification(request.Context(), request.PathValue("collectionName"), input.Token); err != nil {
		module.writeError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
