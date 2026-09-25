package permissions

import (
	"errors"
	"fmt"
	"sort"
)

// Preset 是 Control Plane Permission 的预置集合。
type Preset string

const (
	PresetFullAccess Preset = "fullAccess"
	PresetReadOnly   Preset = "readOnly"
	PresetCustom     Preset = "custom"
)

// CustomPermissionVersion 是自定义 Permission 的当前版本。
const CustomPermissionVersion = 1

// Operation 是一个 Control Plane 操作标识。
type Operation string

const (
	OperationRuntimeRead Operation = "runtime.read"
	OperationStorageRead Operation = "storage.read"
	OperationCollectionsRead Operation = "collections.read"
	OperationCollectionsCreate Operation = "collections.create"
	OperationRecordsRead Operation = "records.read"
	OperationRecordsCreate Operation = "records.create"
	OperationRecordsUpdate Operation = "records.update"
	OperationRecordsDelete Operation = "records.delete"
	OperationFilesRead Operation = "files.read"
	OperationFilesWrite Operation = "files.write"
	OperationSchemaRead Operation = "schema.read"
	OperationSchemaWrite Operation = "schema.write"
	OperationSchemaApply Operation = "schema.apply"
	OperationAccessRulesRead Operation = "accessRules.read"
	OperationAccessRulesWrite Operation = "accessRules.write"
	OperationAccessRulesApply Operation = "accessRules.apply"
	OperationAuthenticationRead Operation = "authentication.read"
	OperationAuthenticationWrite Operation = "authentication.write"
	OperationAuthenticationApply Operation = "authentication.apply"
	OperationUsersRead Operation = "users.read"
	OperationUsersCreate Operation = "users.create"
	OperationUsersManagePassword Operation = "users.managePassword"
	OperationSessionsRead Operation = "sessions.read"
	OperationSessionsRevoke Operation = "sessions.revoke"
	OperationServiceAccountsRead Operation = "serviceAccounts.read"
	OperationServiceAccountsManage Operation = "serviceAccounts.manage"
	OperationAPIKeysRead Operation = "apiKeys.read"
	OperationAPIKeysCreate Operation = "apiKeys.create"
	OperationAPIKeysRevoke Operation = "apiKeys.revoke"
	OperationRequestsRead Operation = "requests.read"
	OperationAuditRead Operation = "audit.read"
	OperationAdministratorsRead Operation = "administrators.read"
	OperationAdministratorsManage Operation = "administrators.manage"
	OperationMailRead Operation = "mail.read"
	OperationMailManage Operation = "mail.manage"
	OperationActivityRead Operation = "activity.read"
	OperationDriftRead Operation = "drift.read"
	OperationDriftReconcile Operation = "drift.reconcile"
	OperationPolicySimulate Operation = "policy.simulate"
	OperationSettingsRead Operation = "settings.read"
	OperationSettingsWrite Operation = "settings.write"
	OperationBackupCreate Operation = "backup.create"
	OperationRestorePreflight Operation = "restore.preflight"
	OperationRecordsExport Operation = "records.export"
	OperationRecordsImport Operation = "records.import"
	OperationDeveloperRead Operation = "developer.read"
)

// Grant 是 Owner 之外的 Control Plane 主体持有的许可。
type Grant struct {
	Preset     Preset      `json:"permission"`
	Version    int         `json:"customPermissionVersion,omitempty"`
	Operations []Operation `json:"customOperations,omitempty"`
}

// InvalidGrant 描述一次无法接受的 Permission 声明。
type InvalidGrant struct {
	Path    string
	Code    string
	Message string
}

func (invalid *InvalidGrant) Error() string { return invalid.Message }

var allOperationsV1 = []Operation{
	Operation("runtime.read"),
	Operation("storage.read"),
	Operation("collections.read"),
	Operation("collections.create"),
	Operation("records.read"),
	Operation("records.create"),
	Operation("records.update"),
	Operation("records.delete"),
	Operation("files.read"),
	Operation("files.write"),
	Operation("schema.read"),
	Operation("schema.write"),
	Operation("schema.apply"),
	Operation("accessRules.read"),
	Operation("accessRules.write"),
	Operation("accessRules.apply"),
	Operation("authentication.read"),
	Operation("authentication.write"),
	Operation("authentication.apply"),
	Operation("users.read"),
	Operation("users.create"),
	Operation("users.managePassword"),
	Operation("sessions.read"),
	Operation("sessions.revoke"),
	Operation("serviceAccounts.read"),
	Operation("serviceAccounts.manage"),
	Operation("apiKeys.read"),
	Operation("apiKeys.create"),
	Operation("apiKeys.revoke"),
	Operation("requests.read"),
	Operation("audit.read"),
	Operation("administrators.read"),
	Operation("administrators.manage"),
	Operation("mail.read"),
	Operation("mail.manage"),
	Operation("activity.read"),
	Operation("drift.read"),
	Operation("drift.reconcile"),
	Operation("policy.simulate"),
	Operation("settings.read"),
	Operation("settings.write"),
	Operation("backup.create"),
	Operation("restore.preflight"),
	Operation("records.export"),
	Operation("records.import"),
	Operation("developer.read"),
}

var readOnlyOperations = map[Operation]struct{}{
	Operation("runtime.read"): {},
	Operation("storage.read"): {},
	Operation("collections.read"): {},
	Operation("records.read"): {},
	Operation("files.read"): {},
	Operation("schema.read"): {},
	Operation("accessRules.read"): {},
	Operation("authentication.read"): {},
	Operation("users.read"): {},
	Operation("sessions.read"): {},
	Operation("serviceAccounts.read"): {},
	Operation("apiKeys.read"): {},
	Operation("requests.read"): {},
	Operation("audit.read"): {},
	Operation("administrators.read"): {},
	Operation("mail.read"): {},
	Operation("activity.read"): {},
	Operation("drift.read"): {},
	Operation("policy.simulate"): {},
	Operation("settings.read"): {},
	Operation("records.export"): {},
}

// AllOperations 返回当前受支持的 Control Plane 操作枚举副本。
func AllOperations() []Operation { return append([]Operation(nil), allOperationsV1...) }

// KnownOperation 判断 operation 是否属于当前支持集合。
func KnownOperation(operation Operation) bool {
	for _, supported := range allOperationsV1 {
		if operation == supported {
			return true
		}
	}
	return false
}

// GrantAllows 判断一个 Grant 是否覆盖某个操作；未识别的操作一律拒绝。
func GrantAllows(grant Grant, operation Operation) bool {
	switch grant.Preset {
	case PresetFullAccess:
		return KnownOperation(operation)
	case PresetReadOnly:
		_, ok := readOnlyOperations[operation]
		return ok
	case PresetCustom:
		if grant.Version != CustomPermissionVersion {
			return false
		}
		for _, allowed := range grant.Operations {
			if allowed == operation {
				return true
			}
		}
	}
	return false
}

// GrantWithin 判断 candidate 是否是 authority 的子集。
func GrantWithin(candidate, authority Grant) bool {
	for _, operation := range allOperationsV1 {
		if GrantAllows(candidate, operation) && !GrantAllows(authority, operation) {
			return false
		}
	}
	return true
}

// NormalizeGrant 校验并归一化一个 Permission 声明。
func NormalizeGrant(preset Preset, version int, operations []Operation) (Grant, error) {
	switch preset {
	case PresetFullAccess, PresetReadOnly:
		if version != 0 || len(operations) != 0 {
			return Grant{}, &InvalidGrant{Path: "/customOperations", Code: "NOT_ALLOWED", Message: "Only a Custom Permission can contain custom operations."}
		}
		return Grant{Preset: preset}, nil
	case PresetCustom:
		if version != CustomPermissionVersion {
			return Grant{}, &InvalidGrant{Path: "/customPermissionVersion", Code: "UNSUPPORTED_VERSION", Message: "Choose the current Custom Permission version and try again."}
		}
		if len(operations) == 0 {
			return Grant{}, &InvalidGrant{Path: "/customOperations", Code: "REQUIRED", Message: "Select at least one supported operation for a Custom Permission."}
		}
		sorted := append([]Operation(nil), operations...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		result := Grant{Preset: PresetCustom, Version: CustomPermissionVersion, Operations: make([]Operation, 0, len(sorted))}
		for _, operation := range sorted {
			if !KnownOperation(operation) {
				return Grant{}, &InvalidGrant{Path: "/customOperations", Code: "UNSUPPORTED_OPERATION", Message: "The Custom Permission contains an unsupported operation."}
			}
			if len(result.Operations) > 0 && result.Operations[len(result.Operations)-1] == operation {
				return Grant{}, &InvalidGrant{Path: "/customOperations", Code: "DUPLICATE_OPERATION", Message: "The Custom Permission contains the same operation more than once."}
			}
			result.Operations = append(result.Operations, operation)
		}
		return result, nil
	default:
		return Grant{}, &InvalidGrant{Path: "/permission", Code: "UNSUPPORTED_PERMISSION", Message: "Choose Full access, Read only, or a supported Custom Permission."}
	}
}

// ErrInvalidGrant 让调用方用一个 errors.Is 判断处理所有非法 Permission。
var ErrInvalidGrant = errors.New("invalid control plane permission")

func (invalid *InvalidGrant) Unwrap() error { return ErrInvalidGrant }

// DescribeGrant 返回便于诊断的稳定描述，不含凭据。
func DescribeGrant(grant Grant) string {
	switch grant.Preset {
	case PresetCustom:
		return fmt.Sprintf("custom(%d operations)", len(grant.Operations))
	default:
		return string(grant.Preset)
	}
}
