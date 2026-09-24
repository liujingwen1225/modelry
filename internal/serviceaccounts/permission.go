package serviceaccounts

import (
	"encoding/json"
	"fmt"
	"sort"
)

var customPermissionOperationsV1 = []Operation{
	OperationRuntimeRead,
	OperationStorageRead,
	OperationCollectionsRead,
	OperationCollectionsCreate,
	OperationRecordsRead,
	OperationRecordsCreate,
	OperationRecordsUpdate,
	OperationRecordsDelete,
	OperationFilesRead,
	OperationFilesWrite,
	OperationSchemaRead,
	OperationSchemaWrite,
	OperationSchemaApply,
	OperationAccessRulesRead,
	OperationAccessRulesWrite,
	OperationAccessRulesApply,
	OperationAuthenticationRead,
	OperationAuthenticationWrite,
	OperationAuthenticationApply,
	OperationUsersRead,
	OperationUsersCreate,
	OperationUsersManagePassword,
	OperationSessionsRead,
	OperationSessionsRevoke,
	OperationServiceAccountsRead,
	OperationServiceAccountsManage,
	OperationAPIKeysRead,
	OperationAPIKeysCreate,
	OperationAPIKeysRevoke,
	OperationRequestsRead,
	OperationAuditRead,
}

var readOnlyOperations = map[Operation]struct{}{
	OperationRuntimeRead: {}, OperationStorageRead: {}, OperationCollectionsRead: {},
	OperationRecordsRead: {}, OperationFilesRead: {}, OperationSchemaRead: {},
	OperationAccessRulesRead: {}, OperationAuthenticationRead: {}, OperationUsersRead: {},
	OperationSessionsRead: {}, OperationServiceAccountsRead: {}, OperationAPIKeysRead: {},
	OperationRequestsRead: {}, OperationAuditRead: {},
}

// CustomOperationsV1 返回当前受支持的自定义 Permission 操作枚举副本。
func CustomOperationsV1() []Operation {
	return append([]Operation(nil), customPermissionOperationsV1...)
}

func normalizeGrant(preset Preset, version int, operations []Operation) (Grant, error) {
	switch preset {
	case PresetFullAccess, PresetReadOnly:
		if version != 0 || len(operations) != 0 {
			return Grant{}, validationError("/customOperations", "NOT_ALLOWED", "Only a Custom Permission can contain custom operations.")
		}
		return Grant{Preset: preset}, nil
	case PresetCustom:
		if version != CustomPermissionVersion {
			return Grant{}, validationError("/customPermissionVersion", "UNSUPPORTED_VERSION", "Choose the current Custom Permission version and try again.")
		}
		if len(operations) == 0 {
			return Grant{}, validationError("/customOperations", "REQUIRED", "Select at least one supported operation for a Custom Permission.")
		}
		allowed := make(map[Operation]struct{}, len(customPermissionOperationsV1))
		for _, operation := range customPermissionOperationsV1 {
			allowed[operation] = struct{}{}
		}
		seen := make(map[Operation]struct{}, len(operations))
		result := Grant{Preset: PresetCustom, Version: CustomPermissionVersion, Operations: make([]Operation, 0, len(operations))}
		for _, operation := range operations {
			if _, ok := allowed[operation]; !ok {
				return Grant{}, validationError("/customOperations", "UNSUPPORTED_OPERATION", "The Custom Permission contains an unsupported operation.")
			}
			if _, duplicate := seen[operation]; duplicate {
				return Grant{}, validationError("/customOperations", "DUPLICATE_OPERATION", "The Custom Permission contains the same operation more than once.")
			}
			seen[operation] = struct{}{}
			result.Operations = append(result.Operations, operation)
		}
		sort.Slice(result.Operations, func(i, j int) bool { return result.Operations[i] < result.Operations[j] })
		return result, nil
	default:
		return Grant{}, validationError("/permission", "UNSUPPORTED_PERMISSION", "Choose Full access, Read only, or a supported Custom Permission.")
	}
}

func grantAllows(grant Grant, operation Operation) bool {
	switch grant.Preset {
	case PresetFullAccess:
		return knownOperation(operation)
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

func grantWithin(candidate, authority Grant) bool {
	for _, operation := range customPermissionOperationsV1 {
		if grantAllows(candidate, operation) && !grantAllows(authority, operation) {
			return false
		}
	}
	return true
}

func knownOperation(operation Operation) bool {
	for _, supported := range customPermissionOperationsV1 {
		if operation == supported {
			return true
		}
	}
	return false
}

func validationError(path, code, message string) error {
	return &ValidationFailure{Path: path, Code: code, Message: message}
}

func grantFromColumns(preset string, version int, encoded string) (Grant, error) {
	var operations []Operation
	if err := json.Unmarshal([]byte(encoded), &operations); err != nil {
		return Grant{}, fmt.Errorf("%w: decode persisted Service Account Permission: %v", ErrStorage, err)
	}
	grant, err := normalizeGrant(Preset(preset), version, operations)
	if err != nil {
		return Grant{}, fmt.Errorf("%w: validate persisted Service Account Permission: %v", ErrStorage, err)
	}
	return grant, nil
}
