package adminauth

import (
	"net/http"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/permissions"
)

type administratorPermissionInput struct {
	Preset                  string   `json:"preset"`
	CustomPermissionVersion int      `json:"customPermissionVersion"`
	CustomOperations        []string `json:"customOperations"`
}

func (input administratorPermissionInput) grant() permissions.Grant {
	operations := make([]permissions.Operation, 0, len(input.CustomOperations))
	for _, operation := range input.CustomOperations {
		operations = append(operations, permissions.Operation(operation))
	}
	return permissions.Grant{Preset: permissions.Preset(input.Preset), Version: input.CustomPermissionVersion, Operations: operations}
}

type administratorCreateRequest struct {
	Email      string                       `json:"email"`
	Password   string                       `json:"password"`
	Permission administratorPermissionInput `json:"permission"`
}

type administratorUpdateRequest struct {
	Email      *string                       `json:"email,omitempty"`
	Permission *administratorPermissionInput `json:"permission,omitempty"`
}

type administratorPasswordRequest struct {
	Password string `json:"password"`
}

type administratorDTO struct {
	ID          string        `json:"id"`
	Email       string        `json:"email"`
	Status      string        `json:"status"`
	Permission  permissionDTO `json:"permission"`
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
	LastLoginAt *time.Time    `json:"lastLoginAt"`
}

func administratorView(administrator Administrator) administratorDTO {
	return administratorDTO{
		ID: administrator.ID, Email: administrator.Email, Status: string(administrator.Status),
		Permission: permissionView(administrator.Permission), CreatedAt: administrator.CreatedAt,
		UpdatedAt: administrator.UpdatedAt, LastLoginAt: administrator.LastLoginAt,
	}
}

type administratorSessionDTO struct {
	ID         string     `json:"id"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
	Status     string     `json:"status"`
	Current    bool       `json:"current"`
}

type administratorData[T any] struct {
	Data T `json:"data"`
}

// RegisterAdministratorRoutes 注册 Owner-only 的 Administrator 管理路由。
func (service *Service) RegisterAdministratorRoutes(mux *http.ServeMux) {
	owner := func(next http.HandlerFunc) http.Handler {
		return service.RequireOwner(methodHandlerAny(next))
	}
	mux.Handle("/admin/api/v1/administrators", owner(service.handleListAdministrators))
	mux.Handle("/admin/api/v1/administrators/{administratorId}", owner(service.handleAdministrator))
	mux.Handle("/admin/api/v1/administrators/{administratorId}/enable", owner(service.handleEnableAdministrator))
	mux.Handle("/admin/api/v1/administrators/{administratorId}/disable", owner(service.handleDisableAdministrator))
	mux.Handle("/admin/api/v1/administrators/{administratorId}/password", owner(service.handleAdministratorPassword))
	mux.Handle("/admin/api/v1/administrators/{administratorId}/sessions", owner(service.handleAdministratorSessions))
	mux.Handle("/admin/api/v1/administrators/{administratorId}/sessions/revoke-all", owner(service.handleRevokeAdministratorSessions))
}

func methodHandlerAny(next http.HandlerFunc) http.Handler { return next }
func (service *Service) handleListAdministrators(w http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodPost {
		service.handleCreateAdministrator(w, request)
		return
	}
	if request.Method != http.MethodGet {
		writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
		return
	}
	administrators, err := service.ListAdministrators(request.Context())
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	views := make([]administratorDTO, 0, len(administrators))
	for _, administrator := range administrators {
		views = append(views, administratorView(administrator))
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, administratorData[[]administratorDTO]{Data: views})
}

func (service *Service) handleAdministrator(w http.ResponseWriter, request *http.Request) {
	administratorID := request.PathValue("administratorId")
	switch request.Method {
	case http.MethodGet:
		administrator, err := service.GetAdministrator(request.Context(), administratorID)
		if err != nil {
			writeAuthError(w, request, err)
			return
		}
		httpapi.WriteAPIJSON(w, http.StatusOK, administratorData[administratorDTO]{Data: administratorView(administrator)})
	case http.MethodPatch:
		var input administratorUpdateRequest
		if err := decodeJSONRequest(w, request, &input); err != nil {
			writeAuthError(w, request, err)
			return
		}
		update := AdministratorUpdate{Email: input.Email}
		if input.Permission != nil {
			grant := input.Permission.grant()
			update.Permission = &grant
		}
		administrator, err := service.UpdateAdministrator(request.Context(), administratorID, update)
		if err != nil {
			writeAuthError(w, request, err)
			return
		}
		httpapi.WriteAPIJSON(w, http.StatusOK, administratorData[administratorDTO]{Data: administratorView(administrator)})
	case http.MethodDelete:
		if err := service.DeleteAdministrator(request.Context(), administratorID); err != nil {
			writeAuthError(w, request, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
	}
}

func (service *Service) handleAdministratorStatus(w http.ResponseWriter, request *http.Request, status AdministratorStatus) {
	if request.Method != http.MethodPost {
		writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
		return
	}
	administrator, err := service.SetAdministratorStatus(request.Context(), request.PathValue("administratorId"), status)
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, administratorData[administratorDTO]{Data: administratorView(administrator)})
}

func (service *Service) handleEnableAdministrator(w http.ResponseWriter, request *http.Request) {
	service.handleAdministratorStatus(w, request, AdministratorActive)
}

func (service *Service) handleDisableAdministrator(w http.ResponseWriter, request *http.Request) {
	service.handleAdministratorStatus(w, request, AdministratorDisabled)
}

func (service *Service) handleAdministratorPassword(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
		return
	}
	var input administratorPasswordRequest
	if err := decodeJSONRequest(w, request, &input); err != nil {
		writeAuthError(w, request, err)
		return
	}
	if err := service.SetAdministratorPassword(request.Context(), request.PathValue("administratorId"), input.Password); err != nil {
		writeAuthError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (service *Service) handleAdministratorSessions(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
		return
	}
	sessions, err := service.ListAdministratorSessions(request.Context(), request.PathValue("administratorId"), "")
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	views := make([]administratorSessionDTO, 0, len(sessions))
	now := time.Now().UTC()
	for _, session := range sessions {
		views = append(views, administratorSessionDTO{
			ID: session.ID, CreatedAt: session.CreatedAt, ExpiresAt: session.ExpiresAt,
			LastUsedAt: session.LastUsedAt, RevokedAt: session.RevokedAt, Status: session.Status(now), Current: session.Current,
		})
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, administratorData[[]administratorSessionDTO]{Data: views})
}

func (service *Service) handleRevokeAdministratorSessions(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
		return
	}
	if err := service.RevokeAdministratorSessions(request.Context(), request.PathValue("administratorId")); err != nil {
		writeAuthError(w, request, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (service *Service) handleCreateAdministrator(w http.ResponseWriter, request *http.Request) {
	var input administratorCreateRequest
	if err := decodeJSONRequest(w, request, &input); err != nil {
		writeAuthError(w, request, err)
		return
	}
	administrator, err := service.CreateAdministrator(request.Context(), AdministratorInput{
		Email: input.Email, Password: input.Password, Permission: input.Permission.grant(),
	})
	if err != nil {
		writeAuthError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, administratorData[administratorDTO]{Data: administratorView(administrator)})
}
