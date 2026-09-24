package records

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrFileStorageUnavailable = errors.New("local file storage unavailable")
	ErrFileNotFound           = errors.New("local file not found")
	objectKeyPattern          = regexp.MustCompile(`^obj_[0-9a-f]{32}$`)
	temporaryKeyPattern       = regexp.MustCompile(`^tmp_[0-9a-f]{32}$`)
)

const maximumUploadBytes = 128 << 20
const defaultUploadBytes = 10 << 20

type LocalFileStore struct {
	tempDir    string
	objectsDir string
	mu         sync.Mutex
	staged     map[string]stagedFile
}

type stagedFile struct {
	collectionID string
	fieldName    string
	contentType  string
	bytes        int64
	createdAt    time.Time
}

type FilePolicy struct {
	MaxBytes         int64
	AllowedMIMETypes []string
}

type UploadedFile struct {
	TemporaryID string `json:"temporaryId"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

type FileInfo struct {
	ContentType string
	Size        int64
}

// NewWithLocalFiles 创建带 Local Single-file Field 能力的 Records Service。
// Runtime 应传入解析后的 Project Root 下 `.modelry/files/tmp` 与 `objects` 路径。
func NewWithLocalFiles(store *storage.Store, models *backendmodel.Service, tempDir, objectsDir string, options ...Option) (*Service, error) {
	service, err := New(store, models, options...)
	if err != nil {
		return nil, err
	}
	files, err := NewLocalFileStore(tempDir, objectsDir)
	if err != nil {
		return nil, err
	}
	service.files = files
	return service, nil
}

// NewLocalFileStore 只使用 Runtime 预先创建的目录，不会根据客户端文件名拼接路径。
func NewLocalFileStore(tempDir, objectsDir string) (*LocalFileStore, error) {
	if tempDir == "" || objectsDir == "" {
		return nil, fmt.Errorf("%w: Runtime-managed temporary and object paths are required", ErrFileStorageUnavailable)
	}
	tempDir, err := filepath.Abs(filepath.Clean(tempDir))
	if err != nil {
		return nil, fmt.Errorf("resolve temporary file directory: %w", err)
	}
	objectsDir, err = filepath.Abs(filepath.Clean(objectsDir))
	if err != nil {
		return nil, fmt.Errorf("resolve object file directory: %w", err)
	}
	if tempDir == objectsDir {
		return nil, fmt.Errorf("%w: temporary and object directories must differ", ErrFileStorageUnavailable)
	}
	for _, directory := range []string{tempDir, objectsDir} {
		info, err := os.Lstat(directory)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("%w: Runtime-managed file directory is missing or unsafe", ErrFileStorageUnavailable)
		}
	}
	return &LocalFileStore{tempDir: tempDir, objectsDir: objectsDir, staged: make(map[string]stagedFile)}, nil
}

// UploadFile 为一个已应用的 File Field 暂存数据流。约束来自该字段；可选调用方策略只能进一步收紧约束。
// 此方法不接收原始文件名，也不会将其用作存储路径。
func (service *Service) UploadFile(ctx context.Context, collectionID, fieldName string, source io.Reader, policy FilePolicy) (UploadedFile, error) {
	if service.files == nil {
		return UploadedFile{}, ErrFileStorageUnavailable
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return UploadedFile{}, err
	}
	field, ok := model.byName[fieldName]
	if !ok || field.Type != backendmodel.FieldTypeFile {
		return UploadedFile{}, fmt.Errorf("%w: Applied Field %q is not a File Field", ErrInvalidArgument, fieldName)
	}
	configured, err := appliedFilePolicy(field.Validation)
	if err != nil {
		return UploadedFile{}, err
	}
	policy, err = restrictFilePolicy(configured, policy)
	if err != nil {
		return UploadedFile{}, err
	}
	if source == nil || policy.MaxBytes < 1 || policy.MaxBytes > maximumUploadBytes || len(policy.AllowedMIMETypes) == 0 {
		return UploadedFile{}, fmt.Errorf("%w: upload requires a positive size limit and at least one allowed MIME type", ErrInvalidArgument)
	}
	allowed, err := normalizeAllowedMIMEs(policy.AllowedMIMETypes)
	if err != nil {
		return UploadedFile{}, err
	}
	if err := ctx.Err(); err != nil {
		return UploadedFile{}, err
	}
	service.files.mu.Lock()
	defer service.files.mu.Unlock()
	temporaryID, err := newOpaqueKey("tmp_")
	if err != nil {
		return UploadedFile{}, err
	}
	path := filepath.Join(service.files.tempDir, temporaryID)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return UploadedFile{}, fmt.Errorf("create temporary upload: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(path)
		}
	}()
	reader := io.LimitReader(source, policy.MaxBytes+1)
	buffer := make([]byte, 512)
	count, readErr := io.ReadFull(reader, buffer)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("read temporary upload: %w", readErr)
	}
	contentType := http.DetectContentType(buffer[:count])
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("detect upload MIME type: %w", err)
	}
	if !mimeAllowed(mediaType, allowed) {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("%w: uploaded content type %q is not allowed", ErrInvalidArgument, mediaType)
	}
	written, err := file.Write(buffer[:count])
	if err != nil || written != count {
		_ = file.Close()
		if err == nil {
			err = io.ErrShortWrite
		}
		return UploadedFile{}, fmt.Errorf("write temporary upload: %w", err)
	}
	rest, err := io.Copy(file, reader)
	if err != nil {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("write temporary upload: %w", err)
	}
	size := int64(count) + rest
	if size > policy.MaxBytes {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("%w: upload exceeds the configured size limit", ErrInvalidArgument)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("flush temporary upload: %w", err)
	}
	if err := file.Close(); err != nil {
		return UploadedFile{}, fmt.Errorf("close temporary upload: %w", err)
	}
	service.files.staged[temporaryID] = stagedFile{collectionID: collectionID, fieldName: fieldName, contentType: mediaType, bytes: size, createdAt: time.Now().UTC()}
	cleanup = false
	return UploadedFile{TemporaryID: temporaryID, ContentType: mediaType, Size: size}, nil
}

func appliedFilePolicy(validation json.RawMessage) (FilePolicy, error) {
	policy := FilePolicy{MaxBytes: defaultUploadBytes, AllowedMIMETypes: []string{
		"application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp", "text/csv", "text/plain",
	}}
	if len(validation) == 0 {
		return policy, nil
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(validation, &values); err != nil {
		return FilePolicy{}, fmt.Errorf("%w: File Field constraints are invalid", ErrInvalidArgument)
	}
	if raw, exists := values["maxBytes"]; exists {
		if err := json.Unmarshal(raw, &policy.MaxBytes); err != nil || policy.MaxBytes < 1 || policy.MaxBytes > maximumUploadBytes {
			return FilePolicy{}, fmt.Errorf("%w: File Field maxBytes must be between 1 and %d", ErrInvalidArgument, maximumUploadBytes)
		}
	}
	if raw, exists := values["allowedMimeTypes"]; exists {
		if err := json.Unmarshal(raw, &policy.AllowedMIMETypes); err != nil || len(policy.AllowedMIMETypes) == 0 {
			return FilePolicy{}, fmt.Errorf("%w: File Field allowedMimeTypes must contain at least one MIME type", ErrInvalidArgument)
		}
	}
	allowed, err := normalizeAllowedMIMEs(policy.AllowedMIMETypes)
	if err != nil {
		return FilePolicy{}, err
	}
	policy.AllowedMIMETypes = allowed
	return policy, nil
}

func restrictFilePolicy(configured, requested FilePolicy) (FilePolicy, error) {
	if requested.MaxBytes < 0 || requested.MaxBytes > maximumUploadBytes {
		return FilePolicy{}, fmt.Errorf("%w: requested upload limit is invalid", ErrInvalidArgument)
	}
	result := configured
	if requested.MaxBytes > 0 && requested.MaxBytes < result.MaxBytes {
		result.MaxBytes = requested.MaxBytes
	}
	if len(requested.AllowedMIMETypes) != 0 {
		requestedMIMEs, err := normalizeAllowedMIMEs(requested.AllowedMIMETypes)
		if err != nil {
			return FilePolicy{}, err
		}
		intersection := make([]string, 0, len(requestedMIMEs))
		for _, requestedMIME := range requestedMIMEs {
			if mimePolicySubset(requestedMIME, configured.AllowedMIMETypes) {
				intersection = append(intersection, requestedMIME)
			}
		}
		if len(intersection) == 0 {
			return FilePolicy{}, fmt.Errorf("%w: upload MIME policy is not allowed by the Applied Field", ErrInvalidArgument)
		}
		result.AllowedMIMETypes = intersection
	}
	return result, nil
}

func mimePolicySubset(requested string, configured []string) bool {
	if strings.HasSuffix(requested, "/*") {
		for _, allowed := range configured {
			if requested == allowed {
				return true
			}
		}
		return false
	}
	return mimeAllowed(requested, configured)
}

func normalizeAllowedMIMEs(values []string) ([]string, error) {
	allowed := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(strings.ToLower(value))
		if strings.HasSuffix(value, "/*") {
			if strings.Count(value, "/") != 1 || len(value) < 3 {
				return nil, fmt.Errorf("%w: invalid MIME wildcard", ErrInvalidArgument)
			}
			allowed = append(allowed, value)
			continue
		}
		parsed, _, err := mime.ParseMediaType(value)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid allowed MIME type", ErrInvalidArgument)
		}
		allowed = append(allowed, strings.ToLower(parsed))
	}
	return allowed, nil
}

func mimeAllowed(value string, allowed []string) bool {
	for _, candidate := range allowed {
		if candidate == value || strings.HasSuffix(candidate, "/*") && strings.HasPrefix(value, strings.TrimSuffix(candidate, "*")) {
			return true
		}
	}
	return false
}

func newOpaqueKey(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate opaque file key: %w", err)
	}
	return prefix + hex.EncodeToString(value[:]), nil
}

func (service *Service) prepareFileValues(collection backendmodel.Collection, values map[string]any) (func(), error) {
	hasFile := false
	for _, field := range collection.Fields {
		if field.Type == backendmodel.FieldTypeFile && values[field.Name] != nil {
			hasFile = true
		}
	}
	if !hasFile {
		return func() {}, nil
	}
	if service.files == nil {
		return nil, ErrFileStorageUnavailable
	}
	service.files.mu.Lock()
	if err := service.prepareFileValuesLocked(collection, values); err != nil {
		service.files.mu.Unlock()
		return nil, err
	}
	return service.files.mu.Unlock, nil
}

// prepareFileValuesLocked 要求调用方持有 service.files.mu，直至 Record 事务提交。
func (service *Service) prepareFileValuesLocked(collection backendmodel.Collection, values map[string]any) error {
	if service.files == nil {
		for _, field := range collection.Fields {
			if field.Type == backendmodel.FieldTypeFile && values[field.Name] != nil {
				return ErrFileStorageUnavailable
			}
		}
		return nil
	}
	fields := make(map[string]backendmodel.Field, len(collection.Fields))
	for _, field := range collection.Fields {
		fields[field.Name] = field
	}
	for name, value := range values {
		field, isFile := fields[name]
		if !isFile || field.Type != backendmodel.FieldTypeFile || value == nil {
			continue
		}
		key, ok := value.(string)
		if !ok {
			return fmt.Errorf("%w: File Field %q must contain a Runtime storage key", ErrInvalidArgument, name)
		}
		if temporaryKeyPattern.MatchString(key) {
			staged, exists := service.files.staged[key]
			if !exists || staged.collectionID != collection.ID || staged.fieldName != name {
				return fmt.Errorf("%w: temporary upload is unavailable for this Field", ErrNotFound)
			}
			objectKey, err := service.files.bind(key)
			if err != nil {
				return err
			}
			values[name] = objectKey
			continue
		}
		if !objectKeyPattern.MatchString(key) {
			return fmt.Errorf("%w: File Field %q must reference an opaque Runtime object key", ErrInvalidArgument, name)
		}
		object, err := service.files.openObject(key)
		if err != nil {
			return fmt.Errorf("%w: File Field %q does not reference an available stored object", ErrInvalidArgument, name)
		}
		if err := object.Close(); err != nil {
			return fmt.Errorf("check stored File Field object: %w", err)
		}
	}
	return nil
}

func (files *LocalFileStore) bind(temporaryID string) (string, error) {
	if !temporaryKeyPattern.MatchString(temporaryID) {
		return "", fmt.Errorf("%w: temporary file key is invalid", ErrInvalidArgument)
	}
	if _, exists := files.staged[temporaryID]; !exists {
		return "", ErrNotFound
	}
	objectKey, err := newOpaqueKey("obj_")
	if err != nil {
		return "", err
	}
	tempPath := filepath.Join(files.tempDir, temporaryID)
	objectPath := filepath.Join(files.objectsDir, objectKey)
	info, err := os.Lstat(tempPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%w: temporary upload is no longer available", ErrFileNotFound)
	}
	// 同一文件系统内创建硬链接是原子操作；若不可变目标已存在，操作会失败。
	if err := os.Link(tempPath, objectPath); err != nil {
		return "", fmt.Errorf("bind temporary upload to immutable object: %w", err)
	}
	if err := os.Remove(tempPath); err != nil {
		_ = os.Remove(objectPath)
		return "", fmt.Errorf("remove bound temporary upload: %w", err)
	}
	delete(files.staged, temporaryID)
	return objectKey, nil
}

func (files *LocalFileStore) openObject(objectKey string) (*os.File, error) {
	if !objectKeyPattern.MatchString(objectKey) {
		return nil, ErrFileNotFound
	}
	path := filepath.Join(files.objectsDir, objectKey)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrFileNotFound
	}
	return os.Open(path)
}

func (service *Service) OpenFile(ctx context.Context, collectionID, recordID, fieldName string) (io.ReadCloser, FileInfo, error) {
	if service.files == nil {
		return nil, FileInfo{}, ErrFileStorageUnavailable
	}
	record, err := service.Get(ctx, collectionID, recordID)
	if err != nil {
		return nil, FileInfo{}, err
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return nil, FileInfo{}, err
	}
	field, ok := model.byName[fieldName]
	if !ok || field.Type != backendmodel.FieldTypeFile {
		return nil, FileInfo{}, fmt.Errorf("%w: Applied Field is not a File Field", ErrNotFound)
	}
	key, ok := record.Values[fieldName].(string)
	if !ok || !objectKeyPattern.MatchString(key) {
		return nil, FileInfo{}, ErrFileNotFound
	}
	file, err := service.files.openObject(key)
	if err != nil {
		return nil, FileInfo{}, fmt.Errorf("%w: stored object is missing or unavailable", ErrFileNotFound)
	}
	buffer := make([]byte, 512)
	n, readErr := file.Read(buffer)
	if readErr != nil && readErr != io.EOF {
		_ = file.Close()
		return nil, FileInfo{}, fmt.Errorf("read stored object metadata: %w", readErr)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, FileInfo{}, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, FileInfo{}, err
	}
	contentType, _, _ := mime.ParseMediaType(http.DetectContentType(buffer[:n]))
	return file, FileInfo{ContentType: contentType, Size: info.Size()}, nil
}

// ReconcileFiles 回收超过宽限期的临时文件和未被 Durable Record 引用的对象。
// Runtime 应在启动和后台有界周期调用；Record 写入与清理共享本地文件锁。
func (service *Service) ReconcileFiles(ctx context.Context, grace time.Duration) error {
	if service.files == nil {
		return ErrFileStorageUnavailable
	}
	if grace <= 0 {
		return fmt.Errorf("%w: file reconciliation grace period must be positive", ErrInvalidArgument)
	}
	service.files.mu.Lock()
	defer service.files.mu.Unlock()
	refs, err := service.fileReferences(ctx)
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-grace)
	if err := cleanOldFiles(service.files.tempDir, cutoff, nil, service.files.staged); err != nil {
		return err
	}
	if err := cleanOldFiles(service.files.objectsDir, cutoff, refs, nil); err != nil {
		return err
	}
	for key := range refs {
		object, err := service.files.openObject(key)
		if err != nil {
			return fmt.Errorf("%w: a referenced object is missing from Local Storage", ErrFileNotFound)
		}
		if err := object.Close(); err != nil {
			return fmt.Errorf("close Local Storage reference check: %w", err)
		}
	}
	return nil
}

func cleanOldFiles(directory string, cutoff time.Time, references map[string]struct{}, staged map[string]stagedFile) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("read Local Storage directory: %w", err)
	}
	var failures []error
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			continue
		}
		if references != nil {
			if _, referenced := references[name]; referenced {
				continue
			}
		}
		if staged != nil {
			if _, active := staged[name]; active {
				continue
			}
		}
		info, err := entry.Info()
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if info.ModTime().After(cutoff) || info.ModTime().Equal(cutoff) {
			continue
		}
		if references != nil && !objectKeyPattern.MatchString(name) || staged != nil && !temporaryKeyPattern.MatchString(name) {
			continue
		}
		if err := os.Remove(filepath.Join(directory, name)); err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("reconcile Local Storage: %w", errors.Join(failures...))
	}
	return nil
}

func (service *Service) fileReferences(ctx context.Context) (map[string]struct{}, error) {
	collections := make([]appliedModel, 0)
	var cursor string
	for {
		page, err := service.models.ListCollections(ctx, backendmodel.ListOptions{Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, collection := range page.Data {
			model, err := service.loadModel(ctx, collection.ID)
			if err != nil {
				return nil, err
			}
			collections = append(collections, model)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	refs := make(map[string]struct{})
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		for _, model := range collections {
			if err := verifyModel(ctx, snapshot, model); err != nil {
				return err
			}
			table, err := storage.QuoteSQLiteIdentifier(model.projection.TableName)
			if err != nil {
				return err
			}
			for _, field := range model.projection.Fields {
				if field.Type != backendmodel.FieldTypeFile || field.System {
					continue
				}
				column, err := storage.QuoteSQLiteIdentifier(field.ColumnName)
				if err != nil {
					return err
				}
				rows, err := snapshot.QueryContext(ctx, `SELECT `+column+` FROM `+table+` WHERE `+column+` IS NOT NULL`)
				if err != nil {
					return fmt.Errorf("read durable File Field references: %w", err)
				}
				for rows.Next() {
					var key string
					if err := rows.Scan(&key); err != nil {
						rows.Close()
						return err
					}
					if !objectKeyPattern.MatchString(key) {
						rows.Close()
						return fmt.Errorf("%w: durable File Field contains an invalid storage key", ErrFileNotFound)
					}
					refs[key] = struct{}{}
				}
				if err := rows.Err(); err != nil {
					rows.Close()
					return err
				}
				if err := rows.Close(); err != nil {
					return err
				}
			}
		}
		return nil
	})
	return refs, err
}

func validateFileValues(collection backendmodel.Collection, values map[string]any) error {
	for _, field := range collection.Fields {
		if field.Type != backendmodel.FieldTypeFile || values[field.Name] == nil {
			continue
		}
		key, ok := values[field.Name].(string)
		if !ok || !objectKeyPattern.MatchString(key) && !temporaryKeyPattern.MatchString(key) {
			return fmt.Errorf("%w: File Field %q must be an opaque Runtime file key", ErrInvalidArgument, field.Name)
		}
	}
	return nil
}

func fillOptionalValues(collection backendmodel.Collection, values map[string]any) {
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		if _, ok := values[field.Name]; !ok {
			values[field.Name] = nil
		}
	}
}
