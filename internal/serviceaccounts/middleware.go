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
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 4 || parts[0] != "admin" || parts[1] != "api" || parts[2] != "v1" {
		return "", false
	}
	methodIs := func(want string) bool { return method == want }
	switch {
	case len(parts) == 5 && parts[3] == "runtime" && parts[4] == "status" && methodIs(http.MethodGet):
		return OperationRuntimeRead, true
	case len(parts) == 5 && parts[3] == "storage" && parts[4] == "status" && methodIs(http.MethodGet):
		return OperationStorageRead, true
	case len(parts) == 4 && parts[3] == "collections" && methodIs(http.MethodGet):
		return OperationCollectionsRead, true
	case len(parts) == 4 && parts[3] == "collections" && methodIs(http.MethodPost):
		return OperationCollectionsCreate, true
	case len(parts) == 4 && parts[3] == "service-accounts" && methodIs(http.MethodGet):
		return OperationServiceAccountsRead, true
	case len(parts) == 4 && parts[3] == "service-accounts" && methodIs(http.MethodPost):
		return OperationServiceAccountsManage, true
	case len(parts) == 4 && parts[3] == "requests" && methodIs(http.MethodGet):
		return OperationRequestsRead, true
	case len(parts) == 4 && parts[3] == "audit" && methodIs(http.MethodGet):
		return OperationAuditRead, true
	case len(parts) == 4 && parts[3] == "changes" && methodIs(http.MethodGet):
		return OperationSchemaRead, true
	case len(parts) == 5 && parts[3] == "collections" && methodIs(http.MethodGet):
		return OperationCollectionsRead, true
	case len(parts) == 5 && parts[3] == "requests" && methodIs(http.MethodGet):
		return OperationRequestsRead, true
	case len(parts) == 5 && parts[3] == "audit" && methodIs(http.MethodGet):
		return OperationAuditRead, true
	case len(parts) == 5 && parts[3] == "changes" && methodIs(http.MethodGet):
		return OperationSchemaRead, true
	case len(parts) == 5 && parts[3] == "service-accounts" && methodIs(http.MethodGet):
		return OperationServiceAccountsRead, true
	case len(parts) == 5 && parts[3] == "service-accounts" && methodIs(http.MethodPatch):
		return OperationServiceAccountsManage, true
	case len(parts) == 6 && parts[3] == "service-accounts" && parts[5] == "disable" && methodIs(http.MethodPost):
		return OperationServiceAccountsManage, true
	case len(parts) == 6 && parts[3] == "service-accounts" && parts[5] == "enable" && methodIs(http.MethodPost):
		return OperationServiceAccountsManage, true
	case len(parts) == 6 && parts[3] == "service-accounts" && parts[5] == "api-keys" && methodIs(http.MethodGet):
		return OperationAPIKeysRead, true
	case len(parts) == 6 && parts[3] == "service-accounts" && parts[5] == "api-keys" && methodIs(http.MethodPost):
		return OperationAPIKeysCreate, true
	case len(parts) == 6 && parts[3] == "api-keys" && parts[5] == "revoke" && methodIs(http.MethodPost):
		return OperationAPIKeysRevoke, true
	case len(parts) == 5 && parts[3] == "collections":
		return collectionSubpathOperation(method, parts[4:])
	case len(parts) == 6 && parts[3] == "collections":
		return collectionSubpathOperation(method, parts[4:])
	case len(parts) == 7 && parts[3] == "collections":
		return collectionSubpathOperation(method, parts[4:])
	case len(parts) == 8 && parts[3] == "collections":
		return collectionSubpathOperation(method, parts[4:])
	case len(parts) == 9 && parts[3] == "collections":
		return collectionSubpathOperation(method, parts[4:])
	default:
		return "", false
	}
}

func collectionSubpathOperation(method string, parts []string) (Operation, bool) {
	if len(parts) == 1 && method == http.MethodGet {
		return OperationCollectionsRead, true
	}
	if len(parts) < 2 {
		return "", false
	}
	if len(parts) == 2 {
		switch parts[1] {
		case "records":
			if method == http.MethodGet {
				return OperationRecordsRead, true
			}
			if method == http.MethodPost {
				return OperationRecordsCreate, true
			}
		case "files":
			if method == http.MethodPost {
				return OperationFilesWrite, true
			}
		case "access-rules":
			if method == http.MethodGet {
				return OperationAccessRulesRead, true
			}
			if method == http.MethodPut || method == http.MethodPost {
				return OperationAccessRulesWrite, true
			}
		case "authentication":
			if method == http.MethodGet {
				return OperationAuthenticationRead, true
			}
			if method == http.MethodPut {
				return OperationAuthenticationWrite, true
			}
		case "users":
			if method == http.MethodGet {
				return OperationUsersRead, true
			}
			if method == http.MethodPost {
				return OperationUsersCreate, true
			}
		}
	}
	if len(parts) == 3 {
		switch parts[1] {
		case "records":
			if method == http.MethodGet {
				return OperationRecordsRead, true
			}
			if method == http.MethodPatch {
				return OperationRecordsUpdate, true
			}
			if method == http.MethodDelete {
				return OperationRecordsDelete, true
			}
		case "schema":
			switch parts[2] {
			case "pending-change", "history":
				if method == http.MethodGet {
					return OperationSchemaRead, true
				}
			case "pending-operations", "preview", "discard":
				if method == http.MethodPost || method == http.MethodPatch || method == http.MethodDelete {
					return OperationSchemaWrite, true
				}
			case "apply":
				if method == http.MethodPost {
					return OperationSchemaApply, true
				}
			}
		case "access-rules":
			if parts[2] == "apply" && method == http.MethodPost {
				return OperationAccessRulesApply, true
			}
			if parts[2] == "discard" && method == http.MethodPost {
				return OperationAccessRulesWrite, true
			}
		case "authentication":
			if parts[2] == "apply" && method == http.MethodPost {
				return OperationAuthenticationApply, true
			}
			if parts[2] == "discard" && method == http.MethodPost {
				return OperationAuthenticationWrite, true
			}
		case "users":
			if method == http.MethodGet {
				return OperationUsersRead, true
			}
			if method == http.MethodPost {
				return OperationUsersCreate, true
			}
		}
	}
	if len(parts) == 4 {
		if parts[1] == "records" && parts[3] == "files" && method == http.MethodGet {
			return OperationFilesRead, true
		}
		if parts[1] == "schema" && parts[2] == "pending-operations" && (method == http.MethodPatch || method == http.MethodDelete) {
			return OperationSchemaWrite, true
		}
		if parts[1] == "users" && parts[3] == "password" && method == http.MethodPut {
			return OperationUsersManagePassword, true
		}
		if parts[1] == "users" && parts[3] == "sessions" && method == http.MethodGet {
			return OperationSessionsRead, true
		}
	}
	if len(parts) == 4 && parts[1] == "sessions" && parts[3] == "revoke" && method == http.MethodPost {
		return OperationSessionsRevoke, true
	}
	if len(parts) == 4 && parts[1] == "users" && parts[3] == "sessions" && method == http.MethodPost {
		return OperationSessionsRevoke, true
	}
	if len(parts) == 5 && parts[1] == "users" && parts[3] == "sessions" && parts[4] == "revoke-all" && method == http.MethodPost {
		return OperationSessionsRevoke, true
	}
	if len(parts) == 5 && parts[1] == "records" && parts[3] == "files" && method == http.MethodGet {
		return OperationFilesRead, true
	}
	return "", false
}

func writeMiddlewareError(w http.ResponseWriter, request *http.Request, status int, code, message string) {
	httpapi.WriteAPIError(w, request, status, httpapi.APIError{Code: code, Message: message})
}
