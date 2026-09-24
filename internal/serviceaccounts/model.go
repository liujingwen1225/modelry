package serviceaccounts

import (
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

type Preset string

const (
	PresetFullAccess Preset = "fullAccess"
	PresetReadOnly   Preset = "readOnly"
	PresetCustom     Preset = "custom"
)

const CustomPermissionVersion = 1

type Operation string

const (
	OperationRuntimeRead           Operation = "runtime.read"
	OperationStorageRead           Operation = "storage.read"
	OperationCollectionsRead       Operation = "collections.read"
	OperationCollectionsCreate     Operation = "collections.create"
	OperationRecordsRead           Operation = "records.read"
	OperationRecordsCreate         Operation = "records.create"
	OperationRecordsUpdate         Operation = "records.update"
	OperationRecordsDelete         Operation = "records.delete"
	OperationFilesRead             Operation = "files.read"
	OperationFilesWrite            Operation = "files.write"
	OperationSchemaRead            Operation = "schema.read"
	OperationSchemaWrite           Operation = "schema.write"
	OperationSchemaApply           Operation = "schema.apply"
	OperationAccessRulesRead       Operation = "accessRules.read"
	OperationAccessRulesWrite      Operation = "accessRules.write"
	OperationAccessRulesApply      Operation = "accessRules.apply"
	OperationAuthenticationRead    Operation = "authentication.read"
	OperationAuthenticationWrite   Operation = "authentication.write"
	OperationAuthenticationApply   Operation = "authentication.apply"
	OperationUsersRead             Operation = "users.read"
	OperationUsersCreate           Operation = "users.create"
	OperationUsersManagePassword   Operation = "users.managePassword"
	OperationSessionsRead          Operation = "sessions.read"
	OperationSessionsRevoke        Operation = "sessions.revoke"
	OperationServiceAccountsRead   Operation = "serviceAccounts.read"
	OperationServiceAccountsManage Operation = "serviceAccounts.manage"
	OperationAPIKeysRead           Operation = "apiKeys.read"
	OperationAPIKeysCreate         Operation = "apiKeys.create"
	OperationAPIKeysRevoke         Operation = "apiKeys.revoke"
	OperationRequestsRead          Operation = "requests.read"
	OperationAuditRead             Operation = "audit.read"
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

type Grant struct {
	Preset     Preset      `json:"permission"`
	Version    int         `json:"customPermissionVersion,omitempty"`
	Operations []Operation `json:"customOperations,omitempty"`
}

type ValidationFailure struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (failure *ValidationFailure) Error() string { return failure.Message }

func (failure *ValidationFailure) Unwrap() error { return ErrInvalidArgument }
