package serviceaccounts

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/permissions"
)

type grantContextKey struct{}

type permissionGrant struct {
	accountID string
	grant     Grant
}

// HasPermission 检查 Owner 或当前已认证 Service Account 是否持有 Control Plane 操作许可。
func HasPermission(ctx context.Context, operation Operation) bool {
	if owner, ok := adminauth.OwnerFromContext(ctx); ok && owner.ID != "" {
		return true
	}
	if principal, ok := adminauth.PrincipalFromContext(ctx); ok {
		switch principal.Kind {
		case adminauth.PrincipalOwner:
			return true
		case adminauth.PrincipalAdministrator:
			return permissions.GrantAllows(principal.Grant, operation)
		}
	}
	principal, ok := authorization.PrincipalFromContext(ctx)
	if !ok || principal.ID == "" {
		return false
	}
	if principal.Type == authorization.PrincipalOwner {
		return true
	}
	if principal.Type != authorization.PrincipalServiceAccount {
		return false
	}
	permission, ok := ctx.Value(grantContextKey{}).(permissionGrant)
	return ok && permission.accountID == principal.ID && grantAllows(permission.grant, operation)
}

// ServiceAccountMiddleware 只为 Admin Control Plane API 接受 Service Account API Key。
// Owner Cookie 仍经 ownerProtected 验证，Application 路由不会接受此凭证。
func (service *Service) ServiceAccountMiddleware(ownerProtected, rawAdminAPI http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !isAdminAPIPath(request.URL.Path) || !hasAuthorizationHeader(request) {
			ownerProtected.ServeHTTP(w, request)
			return
		}
		token, ok := strictBearerToken(request)
		if !ok || service == nil {
			writeMiddlewareError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "A valid Service Account API Key is required.")
			return
		}
		principal, grant, err := service.AuthenticateAPIKey(request.Context(), token)
		if err != nil {
			if errors.Is(err, ErrUnauthenticated) {
				writeMiddlewareError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "A valid Service Account API Key is required.")
				return
			}
			writeMiddlewareError(w, request, http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "Service Account authentication is temporarily unavailable.")
			return
		}
		operation, found := controlPlaneOperation(request.Method, request.URL.Path)
		if !found || !grantAllows(grant, operation) {
			writeMiddlewareError(w, request, http.StatusForbidden, "FORBIDDEN", "This Service Account does not have Permission for this Control Plane operation.")
			return
		}
		ctx := authorization.WithPrincipal(request.Context(), principal)
		ctx = context.WithValue(ctx, grantContextKey{}, permissionGrant{accountID: principal.ID, grant: grant})
		ctx = audit.WithActor(ctx, audit.Actor{Kind: audit.ActorServiceAccount, ID: principal.ID})
		rawAdminAPI.ServeHTTP(w, request.WithContext(ctx))
	})
}

func isAdminAPIPath(path string) bool {
	return path == "/admin/api/v1" || strings.HasPrefix(path, "/admin/api/v1/")
}

func hasAuthorizationHeader(request *http.Request) bool {
	for name := range request.Header {
		if strings.EqualFold(name, "Authorization") {
			return true
		}
	}
	return false
}

func strictBearerToken(request *http.Request) (string, bool) {
	values := request.Header.Values("Authorization")
	if len(values) != 1 {
		return "", false
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

func controlPlaneOperation(method, path string) (Operation, bool) {
	return permissions.ControlPlaneOperation(method, path)
}

func writeMiddlewareError(w http.ResponseWriter, request *http.Request, status int, code, message string) {
	httpapi.WriteAPIError(w, request, status, httpapi.APIError{Code: code, Message: message})
}
