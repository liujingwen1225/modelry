package filestore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const maximumFileStorageRequestBytes = 64 << 10

// Module 暴露 Owner-only 的 File Storage Control Plane。
type Module struct {
	service *Service
}

// NewModule 创建 File Storage Admin API 模块。
func NewModule(service *Service) *Module { return &Module{service: service} }

// RegisterRoutes 注册 File Storage Provider 与 migration 路由。
func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	register := func(pattern string, handler http.HandlerFunc) {
		mux.HandleFunc(pattern, module.protect(handler))
	}
	register("GET /admin/api/v1/storage/files", module.getStatus)
	register("PUT /admin/api/v1/storage/files/provider", module.configureProvider)
	register("POST /admin/api/v1/storage/files/provider/test", module.testProvider)
	register("GET /admin/api/v1/storage/files/migrations", module.listMigrations)
	register("POST /admin/api/v1/storage/files/migrations", module.startMigration)
	register("GET /admin/api/v1/storage/files/migrations/{migrationId}", module.getMigration)
	register("POST /admin/api/v1/storage/files/migrations/{migrationId}/cancel", module.cancelMigration)
}

func (module *Module) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if _, ok := adminauth.OwnerFromContext(request.Context()); !ok {
			writeFileStorageError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "An active Owner session is required.", nil)
			return
		}
		if module == nil || module.service == nil {
			writeFileStorageError(w, request, http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "File Storage is not ready yet. Retry after the Runtime is ready.", nil)
			return
		}
		next(w, request)
	}
}

type fileStorageData[T any] struct {
	Data T `json:"data"`
}

type secretReferenceDTO struct {
	SecretID   string `json:"secretId"`
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
}

type localConfigurationDTO struct {
	Path string `json:"path"`
}

type s3ConfigurationDTO struct {
	Endpoint     string              `json:"endpoint"`
	Region       string              `json:"region"`
	Bucket       string              `json:"bucket"`
	KeyPrefix    string              `json:"keyPrefix"`
	PathStyle    bool                `json:"pathStyle"`
	Configured   bool                `json:"configured"`
	AccessKey    *secretReferenceDTO `json:"accessKey,omitempty"`
	SecretKey    *secretReferenceDTO `json:"secretKey,omitempty"`
	SessionToken *secretReferenceDTO `json:"sessionToken,omitempty"`
}

type configurationDTO struct {
	Provider string                `json:"provider"`
	Local    localConfigurationDTO `json:"local"`
	S3       *s3ConfigurationDTO   `json:"s3"`
}

type storageHealthDTO struct {
	State             string `json:"state"`
	Message           string `json:"message,omitempty"`
	Hint              string `json:"hint,omitempty"`
	ObservedAt        string `json:"observedAt"`
	ReferencedObjects int    `json:"referencedObjects"`
}

type migrationDTO struct {
	ID                 string  `json:"id"`
	SourceProvider     string  `json:"sourceProvider"`
	TargetProvider     string  `json:"targetProvider"`
	Status             string  `json:"status"`
	TotalObjects       int64   `json:"totalObjects"`
	CopiedObjects      int64   `json:"copiedObjects"`
	StartedAt          string  `json:"startedAt"`
	FinishedAt         *string `json:"finishedAt"`
	ErrorCode          string  `json:"errorCode,omitempty"`
	Message            string  `json:"message,omitempty"`
	TargetEndpointHost string  `json:"targetEndpointHost,omitempty"`
	TargetBucket       string  `json:"targetBucket,omitempty"`
	TargetKeyPrefix    string  `json:"targetKeyPrefix,omitempty"`
}

type migrationStateDTO struct {
	Active bool          `json:"active"`
	Latest *migrationDTO `json:"latest"`
}

type statusDTO struct {
	ActiveProvider  string            `json:"activeProvider"`
	Provider        string            `json:"provider"`
	Revision        int               `json:"revision"`
	ProviderState   string            `json:"providerState"`
	ProviderMessage string            `json:"providerMessage,omitempty"`
	ProviderHint    string            `json:"providerHint,omitempty"`
	Configuration   configurationDTO  `json:"configuration"`
	Health          storageHealthDTO  `json:"health"`
	Migration       migrationStateDTO `json:"migration"`
}

type s3Input struct {
	Endpoint             string `json:"endpoint"`
	Region               string `json:"region"`
	Bucket               string `json:"bucket"`
	KeyPrefix            string `json:"keyPrefix"`
	PathStyle            *bool  `json:"pathStyle"`
	AccessKeySecretID    string `json:"accessKeySecretId"`
	SecretKeySecretID    string `json:"secretKeySecretId"`
	SessionTokenSecretID string `json:"sessionTokenSecretId"`
}

func (input s3Input) settings() S3Settings {
	pathStyle := true
	if input.PathStyle != nil {
		pathStyle = *input.PathStyle
	}
	return S3Settings{
		Endpoint: input.Endpoint, Region: input.Region, Bucket: input.Bucket, KeyPrefix: input.KeyPrefix,
		PathStyle: pathStyle, AccessKeySecretID: input.AccessKeySecretID, SecretKeySecretID: input.SecretKeySecretID,
		SessionTokenSecretID: input.SessionTokenSecretID,
	}
}

type providerInput struct {
	ExpectedRevision int      `json:"expectedRevision"`
	Provider         string   `json:"provider"`
	S3               *s3Input `json:"s3"`
}

type providerTestInput struct {
	S3 *s3Input `json:"s3"`
}

type migrationInput struct {
	TargetProvider string   `json:"targetProvider"`
	S3             *s3Input `json:"s3"`
}

func (module *Module) getStatus(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	status, err := module.service.Status(request.Context())
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, fileStorageData[statusDTO]{Data: toStatusDTO(status)})
}

func (module *Module) configureProvider(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	var input providerInput
	if err := decodeFileStorageJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	var settings *S3Settings
	if input.S3 != nil {
		value := input.S3.settings()
		settings = &value
	}
	status, err := module.service.Configure(request.Context(), input.ExpectedRevision, ProviderKind(input.Provider), settings)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, fileStorageData[statusDTO]{Data: toStatusDTO(status)})
}

func (module *Module) testProvider(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	var input providerTestInput
	if err := decodeFileStorageJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	if input.S3 == nil {
		module.writeError(w, request, ErrInvalidArgument)
		return
	}
	settings := input.S3.settings()
	health, err := module.service.TestS3(request.Context(), settings)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	result := map[string]any{"state": health.State, "message": health.Message}
	if health.Hint != "" {
		result["hint"] = health.Hint
	}
	if host := settings.Host(); host != "" {
		result["endpointHost"] = host
	}
	if settings.Bucket != "" {
		result["bucket"] = settings.Bucket
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, fileStorageData[map[string]any]{Data: result})
}

func (module *Module) listMigrations(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	items, err := module.service.Migrations(request.Context(), 20)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	payload := make([]migrationDTO, 0, len(items))
	for _, item := range items {
		payload = append(payload, toMigrationDTO(item))
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, fileStorageData[[]migrationDTO]{Data: payload})
}

func (module *Module) startMigration(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	var input migrationInput
	if err := decodeFileStorageJSON(w, request, &input); err != nil {
		module.writeError(w, request, err)
		return
	}
	var settings *S3Settings
	if input.S3 != nil {
		value := input.S3.settings()
		settings = &value
	}
	migration, err := module.service.StartMigration(request.Context(), ProviderKind(input.TargetProvider), settings)
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusAccepted, fileStorageData[migrationDTO]{Data: toMigrationDTO(migration)})
}

func (module *Module) getMigration(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	migration, err := module.service.Migration(request.Context(), request.PathValue("migrationId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, fileStorageData[migrationDTO]{Data: toMigrationDTO(migration)})
}

func (module *Module) cancelMigration(w http.ResponseWriter, request *http.Request) {
	if !noFileStorageQuery(w, request) {
		return
	}
	migration, err := module.service.CancelMigration(request.Context(), request.PathValue("migrationId"))
	if err != nil {
		module.writeError(w, request, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, fileStorageData[migrationDTO]{Data: toMigrationDTO(migration)})
}

func toStatusDTO(status Status) statusDTO {
	configuration := configurationDTO{Provider: string(status.Config.Provider), Local: localConfigurationDTO{Path: status.LocalPath}}
	if status.S3 != nil {
		settings := *status.S3
		s3 := &s3ConfigurationDTO{
			Endpoint: settings.Endpoint, Region: settings.Region, Bucket: settings.Bucket,
			KeyPrefix: settings.KeyPrefix, PathStyle: settings.PathStyle, Configured: settings.complete(),
		}
		s3.AccessKey = toSecretReferenceDTO(status.S3AccessKey)
		s3.SecretKey = toSecretReferenceDTO(status.S3SecretKey)
		s3.SessionToken = toSecretReferenceDTO(status.S3SessionKey)
		configuration.S3 = s3
	}
	migration := migrationStateDTO{Active: status.MigrationBusy}
	if status.Migration != nil {
		value := toMigrationDTO(*status.Migration)
		migration.Latest = &value
	}
	return statusDTO{
		ActiveProvider: string(status.Config.Provider), Provider: status.ProviderLabel, Revision: status.Config.Revision,
		ProviderState: status.ProviderState, ProviderMessage: status.Message, ProviderHint: status.Hint,
		Configuration: configuration,
		Health: storageHealthDTO{
			State: status.ProviderState, Message: status.Message, Hint: status.Hint,
			ObservedAt: status.ObservedAt.Format("2006-01-02T15:04:05.999999999Z07:00"), ReferencedObjects: status.Referenced,
		},
		Migration: migration,
	}
}

func toSecretReferenceDTO(reference *SecretReference) *secretReferenceDTO {
	if reference == nil {
		return nil
	}
	return &secretReferenceDTO{SecretID: reference.SecretID, Name: reference.Name, Configured: reference.Configured}
}

func toMigrationDTO(migration Migration) migrationDTO {
	payload := migrationDTO{
		ID: migration.ID, SourceProvider: string(migration.SourceProvider), TargetProvider: string(migration.TargetProvider),
		Status: migration.Status, TotalObjects: migration.TotalObjects, CopiedObjects: migration.CopiedObjects,
		StartedAt: migration.StartedAt.Format("2006-01-02T15:04:05.999999999Z07:00"),
		ErrorCode: migration.ErrorCode, Message: migration.Message,
		TargetEndpointHost: migration.TargetEndpointHost, TargetBucket: migration.TargetBucket, TargetKeyPrefix: migration.TargetKeyPrefix,
	}
	if migration.FinishedAt != nil {
		value := migration.FinishedAt.Format("2006-01-02T15:04:05.999999999Z07:00")
		payload.FinishedAt = &value
	}
	return payload
}

func (module *Module) writeError(w http.ResponseWriter, request *http.Request, err error) {
	var problem fileStorageRequestProblem
	if errors.As(err, &problem) {
		writeFileStorageError(w, request, problem.status, problem.code, problem.text, nil)
		return
	}
	switch {
	case errors.Is(err, ErrNotFound):
		writeFileStorageError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested File Storage resource was not found.", nil)
	case errors.Is(err, ErrMigrationRequired):
		writeFileStorageError(w, request, http.StatusConflict, "MIGRATION_REQUIRED", "Referenced File objects must be migrated before the Provider or its object location changes.", nil)
	case errors.Is(err, ErrMigrationActive):
		writeFileStorageError(w, request, http.StatusConflict, "MIGRATION_ACTIVE", "A File Storage migration is already running. Wait for it to finish or cancel it.", nil)
	case errors.Is(err, ErrMigrationNotActive):
		writeFileStorageError(w, request, http.StatusConflict, "MIGRATION_NOT_ACTIVE", "This migration already finished and cannot be cancelled.", nil)
	case errors.Is(err, ErrCredentialUnavailable):
		writeFileStorageError(w, request, http.StatusConflict, "STORAGE_CREDENTIAL_UNAVAILABLE", "A selected credential Secret is missing, revoked, or cannot be decrypted.", nil)
	case errors.Is(err, ErrNotConfigured):
		writeFileStorageError(w, request, http.StatusConflict, "STORAGE_PROVIDER_NOT_CONFIGURED", "The File Storage Provider configuration is incomplete.", nil)
	case errors.Is(err, ErrUnavailable):
		writeFileStorageError(w, request, http.StatusServiceUnavailable, "STORAGE_PROVIDER_UNAVAILABLE", "The File Storage Provider is not reachable. Check the Provider and retry.", nil)
	case errors.Is(err, ErrConflict):
		writeFileStorageError(w, request, http.StatusConflict, "CONFLICT", "The File Storage configuration changed. Reload and try again.", nil)
	case errors.Is(err, ErrInvalidArgument):
		writeFileStorageError(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "The File Storage request contains an invalid value.", nil)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeFileStorageError(w, request, http.StatusServiceUnavailable, "STORAGE_PROVIDER_UNAVAILABLE", "The File Storage Provider did not respond in time. Retry the request.", nil)
	default:
		writeFileStorageError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "The Runtime could not complete this File Storage request.", nil)
	}
}

func writeFileStorageError(w http.ResponseWriter, request *http.Request, status int, code, message string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	httpapi.WriteAPIError(w, request, status, httpapi.APIError{Code: code, Message: message, Details: details})
}

type fileStorageRequestProblem struct {
	status int
	code   string
	text   string
}

func (problem fileStorageRequestProblem) Error() string { return problem.code }

func decodeFileStorageJSON(w http.ResponseWriter, request *http.Request, destination any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return fileStorageRequestProblem{status: http.StatusUnsupportedMediaType, code: "UNSUPPORTED_MEDIA_TYPE", text: "Send this request as application/json."}
	}
	request.Body = http.MaxBytesReader(w, request.Body, maximumFileStorageRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return fileStorageRequestProblem{status: http.StatusRequestEntityTooLarge, code: "PAYLOAD_TOO_LARGE", text: "The request body exceeds the supported size."}
		}
		return fileStorageRequestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", text: "The request body must contain one valid JSON object with supported fields."}
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fileStorageRequestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", text: "The request body must contain exactly one JSON object."}
	}
	return nil
}

func noFileStorageQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery != "" {
		writeFileStorageError(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "This File Storage endpoint does not accept query parameters.", nil)
		return false
	}
	return true
}
