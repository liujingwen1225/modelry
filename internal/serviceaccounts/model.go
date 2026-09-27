package serviceaccounts

import (
	"github.com/liujingwen1225/modelry/internal/permissions"
	"errors"
)

var (
	ErrInvalidArgument = errors.New("invalid Service Account argument")
	ErrNotFound        = errors.New("Service Account or API Key not found")
	ErrUnauthenticated = errors.New("Service Account API Key is unauthenticated")
	ErrForbidden       = errors.New("Service Account Permission denied")
	ErrConflict        = errors.New("Service Account state conflict")
	ErrStorage         = errors.New("Service Account storage unavailable")
)

// Preset、Operation 与 Grant 由 internal/permissions 共享，保证 Control Plane 主体使用同一词表。
type Preset = permissions.Preset

const (
	PresetFullAccess = permissions.PresetFullAccess
	PresetReadOnly   = permissions.PresetReadOnly
	PresetCustom     = permissions.PresetCustom
)
// CustomPermissionVersion 是自定义 Permission 的当前版本。
const CustomPermissionVersion = permissions.CustomPermissionVersion
type Operation = permissions.Operation
const (
	OperationRuntimeRead           = permissions.OperationRuntimeRead
	OperationStorageRead           = permissions.OperationStorageRead
	OperationCollectionsRead       = permissions.OperationCollectionsRead
	OperationCollectionsCreate     = permissions.OperationCollectionsCreate
	OperationRecordsRead           = permissions.OperationRecordsRead
	OperationRecordsCreate         = permissions.OperationRecordsCreate
	OperationRecordsUpdate         = permissions.OperationRecordsUpdate
	OperationRecordsDelete         = permissions.OperationRecordsDelete
	OperationFilesRead             = permissions.OperationFilesRead
	OperationFilesWrite            = permissions.OperationFilesWrite
	OperationSchemaRead            = permissions.OperationSchemaRead
	OperationSchemaWrite           = permissions.OperationSchemaWrite
	OperationSchemaApply           = permissions.OperationSchemaApply
	OperationAccessRulesRead       = permissions.OperationAccessRulesRead
	OperationAccessRulesWrite      = permissions.OperationAccessRulesWrite
	OperationAccessRulesApply      = permissions.OperationAccessRulesApply
	OperationAuthenticationRead    = permissions.OperationAuthenticationRead
	OperationAuthenticationWrite   = permissions.OperationAuthenticationWrite
	OperationAuthenticationApply   = permissions.OperationAuthenticationApply
	OperationUsersRead             = permissions.OperationUsersRead
	OperationUsersCreate           = permissions.OperationUsersCreate
	OperationUsersManagePassword   = permissions.OperationUsersManagePassword
	OperationSessionsRead          = permissions.OperationSessionsRead
	OperationSessionsRevoke        = permissions.OperationSessionsRevoke
	OperationServiceAccountsRead   = permissions.OperationServiceAccountsRead
	OperationServiceAccountsManage = permissions.OperationServiceAccountsManage
	OperationAPIKeysRead           = permissions.OperationAPIKeysRead
	OperationAPIKeysCreate         = permissions.OperationAPIKeysCreate
	OperationAPIKeysRevoke         = permissions.OperationAPIKeysRevoke
	OperationRequestsRead          = permissions.OperationRequestsRead
	OperationAuditRead             = permissions.OperationAuditRead
	OperationAdministratorsRead    = permissions.OperationAdministratorsRead
	OperationAdministratorsManage  = permissions.OperationAdministratorsManage
	OperationMailRead              = permissions.OperationMailRead
	OperationMailManage            = permissions.OperationMailManage
)

type AccountStatus string

const (
	AccountActive   AccountStatus = "active"
	AccountDisabled AccountStatus = "disabled"
)

type APIKeyStatus string

const (
	APIKeyActive  APIKeyStatus = "active"
	APIKeyRevoked APIKeyStatus = "revoked"
)

type ServiceAccount struct {
	ID                      string        `json:"id"`
	Name                    string        `json:"name"`
	Description             string        `json:"description,omitempty"`
	Permission              Preset        `json:"permission"`
	CustomPermissionVersion int           `json:"customPermissionVersion,omitempty"`
	CustomOperations        []Operation   `json:"customOperations,omitempty"`
	Status                  AccountStatus `json:"status"`
	CreatedAt               string        `json:"createdAt"`
	LastUsedAt              *string       `json:"lastUsedAt,omitempty"`
}

type APIKey struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Status     APIKeyStatus `json:"status"`
	CreatedAt  string       `json:"createdAt"`
	ExpiresAt  *string      `json:"expiresAt,omitempty"`
	LastUsedAt *string      `json:"lastUsedAt,omitempty"`
}

type APIKeyReveal struct {
	APIKey       APIKey `json:"apiKey"`
	Secret       string `json:"secret"`
	RevealedOnce bool   `json:"revealedOnce"`
}

type CreateInput struct {
	Name                    string      `json:"name"`
	Description             string      `json:"description,omitempty"`
	Permission              Preset      `json:"permission"`
	CustomPermissionVersion int         `json:"customPermissionVersion,omitempty"`
	CustomOperations        []Operation `json:"customOperations,omitempty"`
	CreateAPIKey            *bool       `json:"createAPIKey,omitempty"`
}

type UpdateInput struct {
	Name                    *string      `json:"name,omitempty"`
	Description             *string      `json:"description,omitempty"`
	Permission              *Preset      `json:"permission,omitempty"`
	CustomPermissionVersion *int         `json:"customPermissionVersion,omitempty"`
	CustomOperations        *[]Operation `json:"customOperations,omitempty"`
}

type CreateResult struct {
	ServiceAccount ServiceAccount `json:"serviceAccount"`
	APIKeyReveal   *APIKeyReveal  `json:"apiKeyReveal,omitempty"`
}

type APIKeyCreateInput struct {
	Name      string `json:"name,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type ListOptions struct {
	Limit  int
	Cursor string
}

type Page struct {
	Data       []ServiceAccount `json:"data"`
	NextCursor string           `json:"nextCursor,omitempty"`
}

type Grant = permissions.Grant

type ValidationFailure struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (failure *ValidationFailure) Error() string { return failure.Message }

func (failure *ValidationFailure) Unwrap() error { return ErrInvalidArgument }
