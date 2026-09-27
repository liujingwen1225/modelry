package adminauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/permissions"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const maxAuthRequestBytes = 16 << 10

type apiFault struct {
	status  int
	code    string
	message string
	hint    string
	details map[string]any
}

func (fault *apiFault) Error() string { return fault.message }

type unavailableError struct{ cause error }

func (err unavailableError) Error() string { return err.cause.Error() }
func (err unavailableError) Unwrap() error { return err.cause }

func validationFailure(path, code, message string) error {
	return &apiFault{
		status:  http.StatusUnprocessableEntity,
		code:    "VALIDATION_FAILED",
		message: "Check the highlighted information and try again.",
		details: map[string]any{
			"violations": []map[string]string{{"path": path, "code": code, "message": message}},
		},
	}
}

type bootstrapStatusResponse struct {
	State string `json:"state"`
}

type authCredentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type ownerSession struct {
	ExpiresAt time.Time `json:"expiresAt"`
}

// permissionDTO 是 Permission 的 API 视图；它只包含 operation 名称，不含任何凭据。
type permissionDTO struct {
	Preset                  string   `json:"preset"`
	CustomPermissionVersion int      `json:"customPermissionVersion,omitempty"`
	CustomOperations        []string `json:"customOperations,omitempty"`
}

func permissionView(grant permissions.Grant) permissionDTO {
	view := permissionDTO{Preset: string(grant.Preset), CustomPermissionVersion: grant.Version}
	if len(grant.Operations) > 0 {
		view.CustomOperations = make([]string, 0, len(grant.Operations))
		for _, operation := range grant.Operations {
			view.CustomOperations = append(view.CustomOperations, string(operation))
		}
	}
	return view
}

func sessionResponse(principal Principal, session durableSession) ownerResponse {
	return ownerResponse{
		Owner: Owner{ID: principal.ID, Email: principal.Email}, Session: ownerSession{ExpiresAt: session.expiresAt},
		Role: string(principal.Kind), Permission: permissionView(principal.Grant),
	}
}

type ownerResponse struct {
	Owner      Owner         `json:"owner"`
	Session    ownerSession  `json:"session"`
	Role       string        `json:"role"`
	Permission permissionDTO `json:"permission"`
}

type currentOwnerSessionResponse struct {
	Owner      Owner         `json:"owner"`
	ExpiresAt  time.Time     `json:"expiresAt"`
	Role       string        `json:"role"`
	Permission permissionDTO `json:"permission"`
}

func (service *Service) handleBootstrapStatus(w http.ResponseWriter, request *http.Request) {
	if err := service.validateOptionalOwnerCredential(request); err != nil {
		writeAuthError(w, request, err)
		return
	}
	var closed int
	err := service.store.WithReadSnapshot(request.Context(), func(tx storage.Executor) error {
		return tx.QueryRowContext(request.Context(), `SELECT closed FROM modelry_admin_bootstrap WHERE singleton = ?`, ownerSingleton).Scan(&closed)
	})
	if err != nil {
		writeAuthError(w, request, unavailableError{cause: err})
		return
	}
	state := "required"
	if closed != 0 {
		state = "closed"
	}
	w.Header().Set("Cache-Control", "no-store")
	httpapi.WriteAPIJSON(w, http.StatusOK, bootstrapStatusResponse{State: state})
}

func (service *Service) handleBootstrapOwner(w http.ResponseWriter, request *http.Request) {
	if err := requireSameOrigin(request); err != nil {
		writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "This request must come from the same origin.", hint: "Open Modelry directly and retry setup."})
		return
	}
	if !isLocalRequest(request) {
		writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "Owner setup is available only from this computer.", hint: "Open Modelry from the computer running the Runtime."})
		return
	}
	if request.Header.Get("Authorization") != "" {
		writeAuthError(w, request, ErrUnauthenticated)
		return
	}
	if err := service.validateOptionalOwnerCookie(request); err != nil {
		writeAuthError(w, request, err)
		return
	}
	var input authCredentialsRequest
	if err := decodeJSONRequest(w, request, &input); err != nil {
		writeAuthError(w, request, err)
		return
	}
	owner, session, token, err := service.bootstrap(request.Context(), input.Email, input.Password)
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	setOwnerCookie(w, request, token, session.expiresAt)
	httpapi.WriteAPIJSON(w, http.StatusCreated, ownerResponse{Owner: owner, Session: ownerSession{ExpiresAt: session.expiresAt}})
}

func (service *Service) handleLogin(w http.ResponseWriter, request *http.Request) {
	if err := requireSameOrigin(request); err != nil {
		writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "This request must come from the same origin.", hint: "Open Modelry directly and retry signing in."})
		return
	}
	if request.Header.Get("Authorization") != "" {
		writeAuthError(w, request, ErrUnauthenticated)
		return
	}
	var input authCredentialsRequest
	if err := decodeJSONRequest(w, request, &input); err != nil {
		writeAuthError(w, request, err)
		return
	}
	principal, session, token, err := service.login(request.Context(), input.Email, input.Password)
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	setOwnerCookie(w, request, token, session.expiresAt)
	httpapi.WriteAPIJSON(w, http.StatusOK, sessionResponse(principal, session))
}

func (service *Service) handleSession(w http.ResponseWriter, request *http.Request) {
	session, ok := request.Context().Value(ownerSessionContextKey{}).(durableSession)
	if !ok {
		token, err := ownerCookie(request)
		if err != nil {
			writeAuthError(w, request, ErrUnauthenticated)
			return
		}
		session, err = service.authenticate(request.Context(), token)
		if err != nil {
			writeAuthError(w, request, err)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	if session.principal.Kind == PrincipalAdministrator {
		if _, err := service.GetAdministrator(request.Context(), session.principal.ID); err != nil {
			writeAuthError(w, request, err)
			return
		}
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, currentOwnerSessionResponse{
		Owner: Owner{ID: session.principal.ID, Email: session.principal.Email}, ExpiresAt: session.expiresAt,
		Role: string(session.principal.Kind), Permission: permissionView(session.principal.Grant),
	})
}

func (service *Service) handleLogout(w http.ResponseWriter, request *http.Request) {
	token, err := ownerCookie(request)
	if err == nil {
		err = service.revoke(request.Context(), token)
	}
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	clearOwnerCookie(w, request)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (service *Service) validateOptionalOwnerCredential(request *http.Request) error {
	if request.Header.Get("Authorization") != "" {
		return ErrUnauthenticated
	}
	return service.validateOptionalOwnerCookie(request)
}

func (service *Service) validateOptionalOwnerCookie(request *http.Request) error {
	token, err := optionalOwnerCookie(request)
	if err != nil || token == "" {
		return err
	}
	_, err = service.authenticate(request.Context(), token)
	if err != nil && !errors.Is(err, ErrUnauthenticated) {
		return unavailableError{cause: err}
	}
	return err
}

func optionalOwnerCookie(request *http.Request) (string, error) {
	var token string
	count := 0
	for _, cookie := range request.Cookies() {
		if cookie.Name == ownerCookieName {
			token = cookie.Value
			count++
		}
	}
	if count == 0 {
		return "", nil
	}
	if count != 1 || token == "" {
		return "", ErrUnauthenticated
	}
	return token, nil
}

func decodeJSONRequest(w http.ResponseWriter, request *http.Request, value any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return &apiFault{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this request as JSON."}
	}
	request.Body = http.MaxBytesReader(w, request.Body, maxAuthRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &apiFault{status: http.StatusRequestEntityTooLarge, code: "PAYLOAD_TOO_LARGE", message: "This request is too large."}
		}
		return &apiFault{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The JSON request could not be read."}
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return &apiFault{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "Send one JSON object per request."}
	}
	return nil
}

func setOwnerCookie(w http.ResponseWriter, request *http.Request, token string, expiresAt time.Time) {
	w.Header().Set("Cache-Control", "no-store")
	http.SetCookie(w, &http.Cookie{
		Name:     ownerCookieName,
		Value:    token,
		Path:     ownerCookiePath,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
		HttpOnly: true,
		Secure:   secureRequest(request),
		SameSite: http.SameSiteStrictMode,
	})
}

func clearOwnerCookie(w http.ResponseWriter, request *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     ownerCookieName,
		Value:    "",
		Path:     ownerCookiePath,
		Expires:  time.Unix(1, 0).UTC(),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secureRequest(request),
		SameSite: http.SameSiteStrictMode,
	})
}

func secureRequest(request *http.Request) bool {
	if request.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto")), "https")
}

func writeAuthError(w http.ResponseWriter, request *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	var fault *apiFault
	if errors.As(err, &fault) {
		httpapi.WriteAPIError(w, request, fault.status, httpapi.APIError{
			Code: fault.code, Message: fault.message, Details: fault.details, Hint: fault.hint,
		})
		return
	}
	if errors.Is(err, ErrUnauthenticated) {
		httpapi.WriteAPIError(w, request, http.StatusUnauthorized, httpapi.APIError{
			Code: "UNAUTHENTICATED", Message: "The supplied credentials could not be validated.",
			Details: map[string]any{}, Hint: "Sign in again to continue.",
		})
		return
	}
	if errors.Is(err, ErrInvalidArgument) {
		httpapi.WriteAPIError(w, request, http.StatusBadRequest, httpapi.APIError{
			Code: "INVALID_ARGUMENT", Message: "The request contains an invalid value.", Details: map[string]any{}, Hint: "Review the values and try again.",
		})
		return
	}
	if errors.Is(err, ErrNotFound) {
		httpapi.WriteAPIError(w, request, http.StatusNotFound, httpapi.APIError{
			Code: "NOT_FOUND", Message: "The requested Administrator was not found.", Details: map[string]any{}, Hint: "Reload the Administrators list.",
		})
		return
	}
	if errors.Is(err, ErrConflict) {
		httpapi.WriteAPIError(w, request, http.StatusConflict, httpapi.APIError{
			Code: "CONFLICT", Message: "This change conflicts with the current Administrators state.", Details: map[string]any{}, Hint: "Reload the Administrators list and retry.",
		})
		return
	}
	if errors.Is(err, ErrBootstrapClosed) {
		httpapi.WriteAPIError(w, request, http.StatusConflict, httpapi.APIError{
			Code: "BOOTSTRAP_CLOSED", Message: "Owner setup has already been completed.",
			Details: map[string]any{}, Hint: "Sign in with the existing Owner account.",
		})
		return
	}
	var unavailable unavailableError
	if errors.As(err, &unavailable) {
		httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
			Code: "STORAGE_UNAVAILABLE", Message: "Project storage is temporarily unavailable.",
			Details: map[string]any{}, Hint: "Retry after project storage is available.",
		})
		return
	}
	httpapi.WriteAPIError(w, request, http.StatusInternalServerError, httpapi.APIError{
		Code: "INTERNAL_ERROR", Message: "The request could not be completed.", Details: map[string]any{},
	})
}

func isLocalRequest(request *http.Request) bool {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	address := net.ParseIP(strings.Trim(host, "[]"))
	if address == nil || !address.IsLoopback() {
		return false
	}
	parsedHost, err := url.Parse("http://" + request.Host)
	if err != nil || parsedHost.Host == "" || parsedHost.User != nil {
		return false
	}
	hostName := strings.ToLower(strings.TrimSuffix(parsedHost.Hostname(), "."))
	hostAddress := net.ParseIP(hostName)
	return hostName == "localhost" || (hostAddress != nil && hostAddress.IsLoopback())
}

func requireSameOrigin(request *http.Request) error {
	if len(request.Header.Values("Origin")) > 1 || len(request.Header.Values("Referer")) > 1 {
		return errors.New("ambiguous browser origin")
	}
	source := request.Header.Get("Origin")
	if source == "" {
		source = request.Header.Get("Referer")
	}
	if source == "" || source == "null" {
		return errors.New("browser origin is required")
	}
	parsedSource, err := url.Parse(source)
	if err != nil || parsedSource.User != nil || parsedSource.Host == "" || parsedSource.Opaque != "" {
		return errors.New("browser origin is invalid")
	}
	if request.Header.Get("Origin") != "" && (parsedSource.Path != "" || parsedSource.RawQuery != "" || parsedSource.Fragment != "") {
		return errors.New("Origin must not contain a path")
	}
	requestScheme := "http"
	if request.TLS != nil || strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto")), "https") {
		requestScheme = "https"
	}
	expectedURL, err := url.Parse(requestScheme + "://" + request.Host)
	if err != nil || expectedURL.Host == "" || expectedURL.User != nil {
		return errors.New("request origin is invalid")
	}
	if originKey(parsedSource) != originKey(expectedURL) {
		return errors.New("request origin does not match")
	}
	if fetchSite := request.Header.Get("Sec-Fetch-Site"); fetchSite != "" && !strings.EqualFold(fetchSite, "same-origin") {
		return errors.New("request is not same-origin")
	}
	return nil
}

func originKey(value *url.URL) string {
	scheme := strings.ToLower(value.Scheme)
	host := strings.ToLower(strings.TrimSuffix(value.Hostname(), "."))
	port := value.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else if scheme == "http" {
			port = "80"
		}
	}
	return fmt.Sprintf("%s://%s:%s", scheme, host, port)
}
