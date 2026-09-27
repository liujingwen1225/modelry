package adminauth

import (
	"context"

	"github.com/liujingwen1225/modelry/internal/permissions"
)

// PrincipalKind 区分 Control Plane 的两种人类身份。
type PrincipalKind string

const (
	PrincipalOwner         PrincipalKind = "owner"
	PrincipalAdministrator PrincipalKind = "administrator"
)

// Principal 是一次已认证 Control Plane 请求的演员身份。
// 它同时表达身份与其 Permission；Owner 恒为 Full access。
type Principal struct {
	Kind  PrincipalKind
	ID    string
	Email string
	Grant permissions.Grant
}

// FullAccessGrant 返回 Owner 的固定许可。
func FullAccessGrant() permissions.Grant { return permissions.Grant{Preset: permissions.PresetFullAccess} }

// Allows 判断该身份是否持有某个 Control Plane 操作。
func (principal Principal) Allows(operation permissions.Operation) bool {
	if principal.Kind == PrincipalOwner {
		return permissions.KnownOperation(operation)
	}
	return permissions.GrantAllows(principal.Grant, operation)
}

// OwnerOnlyResources 列出只有 Owner 可以变更的 Control Plane 资源。
// 即使 Administrator 持有 fullAccess，也不能创建其它 Administrator 或改写邮件凭据。
func OwnerOnlyResources(operation permissions.Operation) bool {
	switch operation {
	case permissions.OperationAdministratorsManage, permissions.OperationMailManage, permissions.OperationSettingsWrite, permissions.OperationDriftReconcile,
		permissions.OperationBackupCreate, permissions.OperationRestorePreflight, permissions.OperationRecordsImport, permissions.OperationDeveloperRead:
		return true
	default:
		return false
	}
}

type principalContextKey struct{}
type administratorContextKey struct{}

func withPrincipal(ctx context.Context, principal Principal) context.Context {
	ctx = context.WithValue(ctx, principalContextKey{}, principal)
	if principal.Kind == PrincipalOwner {
		ctx = context.WithValue(ctx, ownerContextKey{}, Owner{ID: principal.ID, Email: principal.Email})
	}
	if principal.Kind == PrincipalAdministrator {
		ctx = context.WithValue(ctx, administratorContextKey{}, Administrator{ID: principal.ID, Email: principal.Email, Permission: principal.Grant})
	}
	return ctx
}

// PrincipalFromContext 返回当前 Control Plane 身份。
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	return principal, ok && principal.ID != ""
}

// AdministratorFromContext 只在当前请求由 Administrator 发起时返回其身份。
func AdministratorFromContext(ctx context.Context) (Administrator, bool) {
	principal, ok := PrincipalFromContext(ctx)
	if !ok || principal.Kind != PrincipalAdministrator {
		return Administrator{}, false
	}
	administrator, ok := ctx.Value(administratorContextKey{}).(Administrator)
	return administrator, ok
}
