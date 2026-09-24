package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/liujingwen1225/modelry/internal/diagnostics"
)

type Health struct {
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
	Hint    string `json:"hint,omitempty"`
}

type RuntimeStatusResponse struct {
	State         string    `json:"state"`
	ObservedAt    time.Time `json:"observedAt"`
	Database      Health    `json:"database"`
	LocalStorage  Health    `json:"localStorage"`
	ProjectSource string    `json:"projectSource,omitempty"`
	Version       string    `json:"version,omitempty"`
}

type LocalStorageHealth struct {
	State    string `json:"state"`
	Message  string `json:"message,omitempty"`
	Hint     string `json:"hint,omitempty"`
	Provider string `json:"provider"`
	Path     string `json:"path,omitempty"`
}

type StorageStatusResponse struct {
	Database     Health             `json:"database"`
	LocalStorage LocalStorageHealth `json:"localStorage"`
}

type Diagnostics interface {
	RuntimeStatus() diagnostics.RuntimeStatus
	StorageStatus() diagnostics.StorageStatus
}

type apiError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details"`
	Hint      string         `json:"hint,omitempty"`
	RequestID string         `json:"requestId"`
}

type errorResponse struct {
	Error apiError `json:"error"`
}

type requestIDKey struct{}

var fallbackRequestID atomic.Uint64

func NewHandler(diagnostics Diagnostics, adminUI http.Handler, apiRouters ...http.Handler) http.Handler {
	if adminUI == nil {
		adminUI = http.NotFoundHandler()
	}
	var apiRouter http.Handler
	if len(apiRouters) > 0 {
		apiRouter = apiRouters[0]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requestID := newRequestID()
		w.Header().Set("X-Request-Id", requestID)
		request = request.WithContext(context.WithValue(request.Context(), requestIDKey{}, requestID))

		if apiRouter == nil && (isRuntimeStatusPath(request.URL.Path) || isStorageStatusPath(request.URL.Path)) {
			if request.Method != http.MethodGet {
				writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested API endpoint was not found.", "")
				return
			}
			if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
				writeError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "The supplied credentials could not be validated.", "")
				return
			}
			if diagnostics == nil {
				writeError(w, request, http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Runtime diagnostics are not available.", "Retry after the Runtime is ready.")
				return
			}
			if isRuntimeStatusPath(request.URL.Path) {
				writeJSON(w, http.StatusOK, runtimeStatusResponse(diagnostics.RuntimeStatus()))
				return
			}
			status := storageStatusResponse(diagnostics.StorageStatus())
			status.LocalStorage.Path = ""
			writeJSON(w, http.StatusOK, status)
			return
		}

		if isAPIPath(request.URL.Path) {
			if apiRouter != nil {
				apiRouter.ServeHTTP(w, request)
				return
			}
			writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested API endpoint was not found.", "")
			return
		}
		if request.Method == http.MethodGet {
			adminUI.ServeHTTP(w, request)
			return
		}
		writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested resource was not found.", "")
	})
}

func runtimeStatusResponse(status diagnostics.RuntimeStatus) RuntimeStatusResponse {
	return RuntimeStatusResponse{
		State:         status.State,
		ObservedAt:    status.ObservedAt,
		Database:      healthResponse(status.Database),
		LocalStorage:  healthResponse(status.LocalStorage),
		ProjectSource: status.ProjectSource,
		Version:       status.Version,
	}
}

func storageStatusResponse(status diagnostics.StorageStatus) StorageStatusResponse {
	return StorageStatusResponse{
		Database: healthResponse(status.Database),
		LocalStorage: LocalStorageHealth{
			State:    status.LocalStorage.State,
			Message:  status.LocalStorage.Message,
			Hint:     status.LocalStorage.Hint,
			Provider: status.LocalStorage.Provider,
			Path:     status.LocalStorage.Path,
		},
	}
}

func healthResponse(status diagnostics.Health) Health {
	return Health{State: status.State, Message: status.Message, Hint: status.Hint}
}

func RequestID(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	return requestID
}

func isRuntimeStatusPath(path string) bool {
	return path == "/admin/api/v1/runtime/status"
}

func isStorageStatusPath(path string) bool {
	return path == "/admin/api/v1/storage/status"
}

func isAPIPath(path string) bool {
	return path == "/admin/api/v1" || strings.HasPrefix(path, "/admin/api/v1/") || path == "/api/v1" || strings.HasPrefix(path, "/api/v1/")
}

func writeError(w http.ResponseWriter, request *http.Request, status int, code, message, hint string) {
	requestID := RequestID(request.Context())
	writeJSON(w, status, errorResponse{Error: apiError{
		Code:      code,
		Message:   message,
		Details:   map[string]any{},
		Hint:      hint,
		RequestID: requestID,
	}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return "req_" + base64.RawURLEncoding.EncodeToString(value[:])
	}
	return fmt.Sprintf("req_%d_%d", time.Now().UTC().UnixNano(), fallbackRequestID.Add(1))
}
