// Package permissions 定义 Modelry Control Plane 的 Permission 词表与路由映射。
package permissions

import (
	"net/http"
	"strings"
)

// SelfServiceRoute 判断 Method + Path 是否属于任何已认证身份都可使用的自有会话路由。
// 这些路由只作用于发起请求的会话本身，因此不参与 Control Plane Permission 强制。
func SelfServiceRoute(method, path string) bool {
	switch {
	case method == http.MethodGet && path == "/admin/api/v1/auth/session":
		return true
	case method == http.MethodPost && path == "/admin/api/v1/auth/logout":
		return true
	default:
		return false
	}
}

// ControlPlaneOperation 把 Control Plane 的 Method + Path 映射到一个 Permission 操作。

// 未映射的路由返回 false，调用方必须 fail closed。
func ControlPlaneOperation(method, path string) (Operation, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 4 || parts[0] != "admin" || parts[1] != "api" || parts[2] != "v1" {
		return "", false
	}
	methodIs := func(want string) bool { return method == want }
	switch {
	case len(parts) == 4 && parts[3] == "administrators" && methodIs(http.MethodGet):
		return OperationAdministratorsRead, true
	case len(parts) == 4 && parts[3] == "administrators" && methodIs(http.MethodPost):
		return OperationAdministratorsManage, true
	case len(parts) == 5 && parts[3] == "administrators" && methodIs(http.MethodGet):
		return OperationAdministratorsRead, true
	case len(parts) == 5 && parts[3] == "administrators" && (methodIs(http.MethodPatch) || methodIs(http.MethodDelete)):
		return OperationAdministratorsManage, true
	case len(parts) == 6 && parts[3] == "administrators" && parts[5] == "enable" && methodIs(http.MethodPost):
		return OperationAdministratorsManage, true
	case len(parts) == 6 && parts[3] == "administrators" && parts[5] == "disable" && methodIs(http.MethodPost):
		return OperationAdministratorsManage, true
	case len(parts) == 6 && parts[3] == "administrators" && parts[5] == "password" && methodIs(http.MethodPost):
		return OperationAdministratorsManage, true
	case len(parts) == 6 && parts[3] == "administrators" && parts[5] == "sessions" && methodIs(http.MethodGet):
		return OperationSessionsRead, true
	case len(parts) == 7 && parts[3] == "administrators" && parts[5] == "sessions" && parts[6] == "revoke-all" && methodIs(http.MethodPost):
		return OperationSessionsRevoke, true
	case len(parts) == 4 && parts[3] == "backup" && methodIs(http.MethodPost):
		return OperationBackupCreate, true
	case len(parts) == 5 && parts[3] == "restore" && parts[4] == "preflight" && methodIs(http.MethodPost):
		return OperationRestorePreflight, true
	case len(parts) == 5 && parts[3] == "developer" && parts[4] == "contract" && methodIs(http.MethodGet):
		return OperationDeveloperRead, true
	case len(parts) == 6 && parts[3] == "collections" && parts[5] == "export" && methodIs(http.MethodGet):
		return OperationRecordsExport, true
	case len(parts) == 6 && parts[3] == "collections" && parts[5] == "import" && methodIs(http.MethodPost):
		return OperationRecordsImport, true
	case len(parts) == 4 && parts[3] == "activity" && methodIs(http.MethodGet):
		return OperationActivityRead, true
	case len(parts) == 4 && parts[3] == "drift" && methodIs(http.MethodGet):
		return OperationDriftRead, true
	case len(parts) == 5 && parts[3] == "drift" && parts[4] == "reconcile" && methodIs(http.MethodPost):
		return OperationDriftReconcile, true
	case len(parts) == 4 && parts[3] == "settings" && methodIs(http.MethodGet):
		return OperationSettingsRead, true
	case len(parts) == 4 && parts[3] == "settings" && methodIs(http.MethodPut):
		return OperationSettingsWrite, true
	case len(parts) == 7 && parts[3] == "collections" && parts[5] == "access-rules" && parts[6] == "simulate" && methodIs(http.MethodPost):
		return OperationPolicySimulate, true
	case len(parts) == 4 && parts[3] == "mail" && methodIs(http.MethodGet):
		return OperationMailRead, true
	case len(parts) == 4 && parts[3] == "mail" && methodIs(http.MethodPut):
		return OperationMailManage, true
	case len(parts) == 5 && parts[3] == "mail" && parts[4] == "test" && methodIs(http.MethodPost):
		return OperationMailManage, true
	case len(parts) == 5 && parts[3] == "mail" && parts[4] == "deliveries" && methodIs(http.MethodGet):
		return OperationMailRead, true
	case len(parts) == 7 && parts[3] == "mail" && parts[4] == "deliveries" && parts[6] == "retry" && methodIs(http.MethodPost):
		return OperationMailManage, true
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
