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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	// ErrFileStorageUnavailable 表示当前 Storage Provider 不可用；调用方必须 fail closed。
	ErrFileStorageUnavailable = errors.New("file storage unavailable")
	// ErrFileNotFound 表示 Record 引用的对象在当前 Provider 中不存在。
	ErrFileNotFound     = errors.New("file not found")
	objectKeyPattern    = regexp.MustCompile(`^obj_[0-9a-f]{32}$`)
	temporaryKeyPattern = regexp.MustCompile(`^tmp_[0-9a-f]{32}$`)
	// migrationKeyPattern 标记 Provider migration 的本地暂存文件。
	migrationKeyPattern = regexp.MustCompile(`^mig_[0-9a-f]{32}$`)
)

const (
	maximumUploadBytes = backendmodel.MaximumFileBytes
	defaultUploadBytes = backendmodel.DefaultFileBytes
	// maximumStagedUploads 限制同一 Runtime 中未绑定暂存上传的数量。
	maximumStagedUploads = 64
)

// FileProviders 把 Record 中的对象引用解析为当前 Storage Provider。
// 它由 Runtime 注入；Records 不持有 Provider 配置，也不知道 Local 与 S3 的差别。
type FileProviders interface {
	ActiveProvider(ctx context.Context) (filestore.Provider, error)
}

type staticFileProviders struct{ provider filestore.Provider }

func (providers staticFileProviders) ActiveProvider(context.Context) (filestore.Provider, error) {
	if providers.provider == nil {
		return nil, ErrFileStorageUnavailable
	}
	return providers.provider, nil
}

type stagedUpload struct {
	collectionID string
	fieldName    string
	contentType  string
	bytes        int64
	createdAt    time.Time
}

// fileStaging 是 Provider 无关的本地暂存区：任何 Provider 的上传都先落到这里。
type fileStaging struct {
	mu      sync.Mutex
	tempDir string
	uploads map[string]stagedUpload
	// refCursor 让引用的存在性校验按有界游标轮转，避免一次扫描无界对象。
	refCursor int
}

// FilePolicy 是调用方可选的额外收紧；它永远不能放宽 Applied Field 约束。
type FilePolicy struct {
	MaxBytes         int64
	AllowedMIMETypes []string
	MaxFiles         int
}

// UploadedFile 是暂存成功的上传，只能绑定到它所属的 Collection 与 Field。
type UploadedFile struct {
	TemporaryID string `json:"temporaryId"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

// FileInfo 是读取路径返回的安全元数据。
type FileInfo struct {
	ContentType string
	Size        int64
}

// SetFileProviders 在 Runtime 启动阶段注入 Provider 解析器。
// 它必须在开始服务请求之前调用，之后不再改变。
func (service *Service) SetFileProviders(providers FileProviders) {
	if service == nil {
		return
	}
	service.fileProviders = providers
}

// ReconcileStaging 只回收超过宽限期的暂存上传，不触碰已绑定对象。
func (service *Service) ReconcileStaging(_ context.Context, grace time.Duration) error {
	if grace <= 0 {
		return fmt.Errorf("%w: staging grace period must be positive", ErrInvalidArgument)
	}
	staging, err := service.fileStagingOrError()
	if err != nil {
		return err
	}
	return cleanStagedUploads(staging, time.Now().Add(-grace))
}

// NewWithFileProviders 创建带 Runtime 注入 Provider 的 Records Service。
func NewWithFileProviders(store *storage.Store, models *backendmodel.Service, tempDir string, providers FileProviders, options ...Option) (*Service, error) {
	service, err := New(store, models, options...)
	if err != nil {
		return nil, err
	}
	staging, err := newFileStaging(tempDir)
	if err != nil {
		return nil, err
	}
	service.staging = staging
	service.fileProviders = providers
	return service, nil
}

// NewWithLocalFiles 创建使用 Local Storage Provider 的 Records Service。
// Runtime 应传入解析后的 Project Root 下 `.modelry/files/tmp` 与 `.modelry/files/objects` 路径。
func NewWithLocalFiles(store *storage.Store, models *backendmodel.Service, tempDir, objectsDir string, options ...Option) (*Service, error) {
	provider, err := filestore.NewLocal(objectsDir)
	if err != nil {
		return nil, err
	}
	return NewWithFileProviders(store, models, tempDir, staticFileProviders{provider: provider}, options...)
}

func newFileStaging(tempDir string) (*fileStaging, error) {
	if tempDir == "" {
		return nil, fmt.Errorf("%w: Runtime-managed staging directory is required", ErrFileStorageUnavailable)
	}
	absolute, err := filepath.Abs(filepath.Clean(tempDir))
	if err != nil {
		return nil, fmt.Errorf("resolve staging directory: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: Runtime-managed staging directory is missing or unsafe", ErrFileStorageUnavailable)
	}
	return &fileStaging{tempDir: absolute, uploads: make(map[string]stagedUpload)}, nil
}

func (service *Service) fileStagingOrError() (*fileStaging, error) {
	if service == nil || service.staging == nil {
		return nil, ErrFileStorageUnavailable
	}
	return service.staging, nil
}

func (service *Service) activeProvider(ctx context.Context) (filestore.Provider, error) {
	if service == nil || service.fileProviders == nil {
		return nil, ErrFileStorageUnavailable
	}
	provider, err := service.fileProviders.ActiveProvider(ctx)
	if err != nil {
		return nil, mapProviderError(err)
	}
	if provider == nil {
		return nil, ErrFileStorageUnavailable
	}
	return provider, nil
}

// mapProviderError 把 Provider 错误折叠为 Records 的安全错误类别，不泄漏 Provider 细节。
func mapProviderError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, filestore.ErrNotFound):
		return fmt.Errorf("%w: stored object is missing or unavailable", ErrFileNotFound)
	case errors.Is(err, filestore.ErrInvalidArgument):
		return fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	case errors.Is(err, filestore.ErrNotConfigured), errors.Is(err, filestore.ErrCredentialUnavailable), errors.Is(err, filestore.ErrUnavailable):
		return fmt.Errorf("%w: the active Storage Provider is unavailable: %v", ErrFileStorageUnavailable, err)
	default:
		return fmt.Errorf("%w: %v", ErrFileStorageUnavailable, err)
	}
}

// UploadFile 为一个已应用的 file/files Field 暂存数据流。
// 约束来自该 Field；可选调用方策略只能进一步收紧。原始文件名既不接收也不使用。
func (service *Service) UploadFile(ctx context.Context, collectionID, fieldName string, source io.Reader, policy FilePolicy) (UploadedFile, error) {
	staging, err := service.fileStagingOrError()
	if err != nil {
		return UploadedFile{}, err
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return UploadedFile{}, err
	}
	field, ok := appliedFileField(model.collection, fieldName)
	if !ok {
		return UploadedFile{}, fmt.Errorf("%w: Applied Field %q is not a File Field", ErrInvalidArgument, fieldName)
	}
	configured, err := backendmodel.AppliedFileConstraints(field)
	if err != nil {
		return UploadedFile{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	constraints, err := restrictFilePolicy(configured, policy)
	if err != nil {
		return UploadedFile{}, err
	}
	if source == nil || constraints.MaxBytes < 1 || constraints.MaxBytes > maximumUploadBytes || len(constraints.AllowedMIMETypes) == 0 {
		return UploadedFile{}, fmt.Errorf("%w: upload requires a positive size limit and at least one allowed MIME type", ErrInvalidArgument)
	}
	if err := ctx.Err(); err != nil {
		return UploadedFile{}, err
	}
	staging.mu.Lock()
	defer staging.mu.Unlock()
	if len(staging.uploads) >= maximumStagedUploads {
		return UploadedFile{}, fmt.Errorf("%w: too many staged uploads are waiting to be bound; bind or discard them first", ErrConflict)
	}
	temporaryID, err := newOpaqueKey("tmp_")
	if err != nil {
		return UploadedFile{}, err
	}
	path := filepath.Join(staging.tempDir, temporaryID)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return UploadedFile{}, fmt.Errorf("create staged upload: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(path)
		}
	}()
	reader := io.LimitReader(source, constraints.MaxBytes+1)
	buffer := make([]byte, 512)
	count, readErr := io.ReadFull(reader, buffer)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("read staged upload: %w", readErr)
	}
	contentType := http.DetectContentType(buffer[:count])
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("detect upload MIME type: %w", err)
	}
	if !backendmodel.MIMEAllowed(mediaType, constraints.AllowedMIMETypes) {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("%w: uploaded content type %q is not allowed", ErrInvalidArgument, mediaType)
	}
	written, err := file.Write(buffer[:count])
	if err != nil || written != count {
		_ = file.Close()
		if err == nil {
			err = io.ErrShortWrite
		}
		return UploadedFile{}, fmt.Errorf("write staged upload: %w", err)
	}
	rest, err := io.Copy(file, reader)
	if err != nil {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("write staged upload: %w", err)
	}
	size := int64(count) + rest
	if size > constraints.MaxBytes {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("%w: upload exceeds the configured size limit of %d bytes", ErrInvalidArgument, constraints.MaxBytes)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return UploadedFile{}, fmt.Errorf("flush staged upload: %w", err)
	}
	if err := file.Close(); err != nil {
		return UploadedFile{}, fmt.Errorf("close staged upload: %w", err)
	}
	staging.uploads[temporaryID] = stagedUpload{collectionID: collectionID, fieldName: fieldName, contentType: mediaType, bytes: size, createdAt: time.Now().UTC()}
	cleanup = false
	return UploadedFile{TemporaryID: temporaryID, ContentType: mediaType, Size: size}, nil
}

func appliedFileField(collection backendmodel.Collection, name string) (backendmodel.Field, bool) {
	for _, field := range collection.Fields {
		if field.Name == name {
			return field, field.Type == backendmodel.FieldTypeFile || field.Type == backendmodel.FieldTypeFiles
		}
	}
	return backendmodel.Field{}, false
}

func restrictFilePolicy(configured backendmodel.FileFieldConstraints, requested FilePolicy) (backendmodel.FileFieldConstraints, error) {
	if requested.MaxBytes < 0 || requested.MaxBytes > maximumUploadBytes {
		return backendmodel.FileFieldConstraints{}, fmt.Errorf("%w: requested upload limit is invalid", ErrInvalidArgument)
	}
	if requested.MaxFiles < 0 || requested.MaxFiles > backendmodel.MaximumFileCount {
		return backendmodel.FileFieldConstraints{}, fmt.Errorf("%w: requested file count limit is invalid", ErrInvalidArgument)
	}
	result := configured
	if requested.MaxBytes > 0 && requested.MaxBytes < result.MaxBytes {
		result.MaxBytes = requested.MaxBytes
	}
	if requested.MaxFiles > 0 && requested.MaxFiles < result.MaxFiles {
		result.MaxFiles = requested.MaxFiles
	}
	if len(requested.AllowedMIMETypes) != 0 {
		requestedMIMEs, err := backendmodel.NormalizeMIMETypes(requested.AllowedMIMETypes)
		if err != nil {
			return backendmodel.FileFieldConstraints{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
		}
		intersection := make([]string, 0, len(requestedMIMEs))
		for _, requestedMIME := range requestedMIMEs {
			if backendmodel.MIMESubset(requestedMIME, configured.AllowedMIMETypes) {
				intersection = append(intersection, requestedMIME)
			}
		}
		if len(intersection) == 0 {
			return backendmodel.FileFieldConstraints{}, fmt.Errorf("%w: upload MIME policy is not allowed by the Applied Field", ErrInvalidArgument)
		}
		result.AllowedMIMETypes = intersection
	}
	return result, nil
}

func newOpaqueKey(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate opaque file key: %w", err)
	}
	return prefix + hex.EncodeToString(value[:]), nil
}

// prepareFileValues 在 SQLite 事务之外把暂存上传提升为不可变对象。
// 事务失败时新对象只会变成待回收孤儿，绝不会让 Record 引用不存在的字节。
func (service *Service) prepareFileValues(ctx context.Context, collection backendmodel.Collection, values map[string]any) (func(), error) {
	release := func() {}
	if !hasFileFieldValue(collection, values) {
		return release, nil
	}
	provider, err := service.activeProvider(ctx)
	if err != nil {
		return nil, err
	}
	staging, err := service.fileStagingOrError()
	if err != nil {
		return nil, err
	}
	for _, field := range collection.Fields {
		if field.Type != backendmodel.FieldTypeFile && field.Type != backendmodel.FieldTypeFiles {
			continue
		}
		value, present := values[field.Name]
		if !present || value == nil {
			continue
		}
		keys, err := fileValueKeys(field, value)
		if err != nil {
			return nil, err
		}
		if field.Type == backendmodel.FieldTypeFiles {
			constraints, err := backendmodel.AppliedFileConstraints(field)
			if err != nil {
				return nil, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
			}
			if len(keys) > constraints.MaxFiles {
				return nil, fmt.Errorf("%w: Field %q accepts at most %d files", ErrInvalidArgument, field.Name, constraints.MaxFiles)
			}
		}
		bound := make([]any, 0, len(keys))
		for _, key := range keys {
			switch {
			case temporaryKeyPattern.MatchString(key):
				staged, path, err := service.consumeStagedUpload(staging, key, collection.ID, field.Name)
				if err != nil {
					return nil, err
				}
				objectKey, err := promoteStagedUpload(ctx, provider, staged, path)
				if err != nil {
					return nil, mapProviderError(err)
				}
				removeStagedFile(path)
				bound = append(bound, objectKey)
			case objectKeyPattern.MatchString(key):
				if _, err := provider.Stat(ctx, key); err != nil {
					return nil, mapProviderError(err)
				}
				bound = append(bound, key)
			default:
				return nil, fmt.Errorf("%w: File Field %q must reference an opaque Runtime object key", ErrInvalidArgument, field.Name)
			}
		}
		if field.Type == backendmodel.FieldTypeFile {
			values[field.Name] = bound[0]
			continue
		}
		values[field.Name] = bound
	}
	return release, nil
}

// consumeStagedUpload 校验并认领一个暂存上传；失败时保留它以便调用方重试或回收。
func (service *Service) consumeStagedUpload(staging *fileStaging, temporaryID, collectionID, fieldName string) (stagedUpload, string, error) {
	staging.mu.Lock()
	defer staging.mu.Unlock()
	staged, exists := staging.uploads[temporaryID]
	if !exists || staged.collectionID != collectionID || staged.fieldName != fieldName {
		return stagedUpload{}, "", fmt.Errorf("%w: temporary upload is unavailable for this Field", ErrNotFound)
	}
	path := filepath.Join(staging.tempDir, temporaryID)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		delete(staging.uploads, temporaryID)
		return stagedUpload{}, "", fmt.Errorf("%w: temporary upload is no longer available", ErrFileNotFound)
	}
	delete(staging.uploads, temporaryID)
	return staged, path, nil
}

func promoteStagedUpload(ctx context.Context, provider filestore.Provider, staged stagedUpload, path string) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		objectKey, err := newOpaqueKey("obj_")
		if err != nil {
			return "", err
		}
		err = provider.Promote(ctx, objectKey, filestore.Staged{Path: path, Size: staged.bytes, ContentType: staged.contentType})
		if errors.Is(err, filestore.ErrObjectExists) {
			continue
		}
		if err != nil {
			return "", err
		}
		return objectKey, nil
	}
	return "", fmt.Errorf("%w: cannot allocate an unused immutable object reference", ErrConflict)
}

// removeStagedFile 清理已经成功绑定（或已由 Local Provider 搬走）的暂存文件。
func removeStagedFile(path string) {
	if path == "" {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		// 暂存清理是尽力而为：reconcile 会再次回收。
		_ = err
	}
}

func fileValueKeys(field backendmodel.Field, value any) ([]string, error) {
	switch field.Type {
	case backendmodel.FieldTypeFile:
		key, ok := value.(string)
		if !ok || key == "" {
			return nil, fmt.Errorf("%w: File Field %q must contain a Runtime storage key", ErrInvalidArgument, field.Name)
		}
		return []string{key}, nil
	case backendmodel.FieldTypeFiles:
		switch typed := value.(type) {
		case []any:
			keys := make([]string, 0, len(typed))
			for _, item := range typed {
				key, ok := item.(string)
				if !ok || key == "" {
					return nil, fmt.Errorf("%w: files Field %q must contain only file references", ErrInvalidArgument, field.Name)
				}
				keys = append(keys, key)
			}
			return keys, nil
		case []string:
			return append([]string(nil), typed...), nil
		default:
			return nil, fmt.Errorf("%w: files Field %q must be an ordered list of file references", ErrInvalidArgument, field.Name)
		}
	default:
		return nil, fmt.Errorf("%w: Field %q is not a File Field", ErrInvalidArgument, field.Name)
	}
}

// OpenFile 读取单个 file Field 的对象内容。
func (service *Service) OpenFile(ctx context.Context, collectionID, recordID, fieldName string) (io.ReadCloser, FileInfo, error) {
	return service.openFile(ctx, collectionID, recordID, fieldName, nil, nil)
}

// OpenFileAt 读取 files Field 中第 index 个（0-based）对象内容。
func (service *Service) OpenFileAt(ctx context.Context, collectionID, recordID, fieldName string, index int) (io.ReadCloser, FileInfo, error) {
	return service.openFile(ctx, collectionID, recordID, fieldName, &index, nil)
}

func (service *Service) openFile(ctx context.Context, collectionID, recordID, fieldName string, index *int, principal *authorization.Principal) (io.ReadCloser, FileInfo, error) {
	record, err := service.getForFileRead(ctx, collectionID, recordID, principal)
	if err != nil {
		return nil, FileInfo{}, err
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return nil, FileInfo{}, err
	}
	field, ok := appliedFileField(model.collection, fieldName)
	if !ok {
		return nil, FileInfo{}, ErrNotFound
	}
	key, err := fileFieldKey(field, record.Values[fieldName], index)
	if err != nil {
		return nil, FileInfo{}, err
	}
	provider, err := service.activeProvider(ctx)
	if err != nil {
		return nil, FileInfo{}, err
	}
	file, info, err := provider.Open(ctx, key)
	if err != nil {
		return nil, FileInfo{}, mapProviderError(err)
	}
	contentType := info.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return file, FileInfo{ContentType: contentType, Size: info.Size}, nil
}

// getForFileRead 在 Application 读取时执行 Collection view Access Rule，Admin 读取直接读 Durable Record。
func (service *Service) getForFileRead(ctx context.Context, collectionID, recordID string, principal *authorization.Principal) (Record, error) {
	if principal == nil {
		return service.Get(ctx, collectionID, recordID)
	}
	return service.GetApplication(ctx, collectionID, recordID, *principal)
}

func fileFieldKey(field backendmodel.Field, value any, index *int) (string, error) {
	if field.Type == backendmodel.FieldTypeFile {
		if index != nil {
			return "", fmt.Errorf("%w: Field %q holds a single file; use the non-indexed read route", ErrInvalidArgument, field.Name)
		}
		key, ok := value.(string)
		if !ok || !objectKeyPattern.MatchString(key) {
			return "", ErrFileNotFound
		}
		return key, nil
	}
	if index == nil {
		return "", fmt.Errorf("%w: Field %q holds multiple files; select one by index", ErrInvalidArgument, field.Name)
	}
	keys, err := fileValueKeys(field, value)
	if err != nil {
		return "", ErrFileNotFound
	}
	if *index < 0 || *index >= len(keys) {
		return "", ErrFileNotFound
	}
	key := keys[*index]
	if !objectKeyPattern.MatchString(key) {
		return "", ErrFileNotFound
	}
	return key, nil
}

// ReconcileFiles 回收过期暂存文件与未被 Durable Record 引用的对象，并校验引用的存在性。
// 它是有界的：单次扫描最多处理 filestore.MaxListPage 个对象与同样数量的引用校验。
func (service *Service) ReconcileFiles(ctx context.Context, grace time.Duration) error {
	if grace <= 0 {
		return fmt.Errorf("%w: file reconciliation grace period must be positive", ErrInvalidArgument)
	}
	if _, err := service.fileStagingOrError(); err != nil {
		return err
	}
	provider, err := service.activeProvider(ctx)
	if err != nil {
		return err
	}
	references, err := service.ReferencedFileKeys(ctx)
	if err != nil {
		return err
	}
	referenced := make(map[string]struct{}, len(references))
	for _, key := range references {
		referenced[key] = struct{}{}
	}
	cutoff := time.Now().Add(-grace)
	if err := service.ReconcileStaging(ctx, grace); err != nil {
		return err
	}
	page, err := provider.List(ctx, "", filestore.MaxListPage)
	if err != nil {
		return mapProviderError(err)
	}
	for _, object := range page.Objects {
		if _, keep := referenced[object.Key]; keep {
			continue
		}
		if !object.ModifiedAt.Before(cutoff) {
			continue
		}
		if err := provider.Delete(ctx, object.Key); err != nil {
			return mapProviderError(err)
		}
	}
	return service.verifyReferencedObjects(ctx, provider, references)
}

// verifyReferencedObjects 按有界游标轮转校验引用，避免一次请求执行无界 HEAD/Stat。
func (service *Service) verifyReferencedObjects(ctx context.Context, provider filestore.Provider, references []string) error {
	if len(references) == 0 {
		service.staging.mu.Lock()
		service.staging.refCursor = 0
		service.staging.mu.Unlock()
		return nil
	}
	sorted := append([]string(nil), references...)
	sort.Strings(sorted)
	service.staging.mu.Lock()
	start := service.staging.refCursor
	if start >= len(sorted) {
		start = 0
	}
	service.staging.mu.Unlock()
	limit := min(len(sorted), filestore.MaxListPage)
	for offset := 0; offset < limit; offset++ {
		index := (start + offset) % len(sorted)
		if _, err := provider.Stat(ctx, sorted[index]); err != nil {
			service.staging.mu.Lock()
			service.staging.refCursor = (index + 1) % len(sorted)
			service.staging.mu.Unlock()
			if errors.Is(err, filestore.ErrNotFound) {
				return fmt.Errorf("%w: a referenced object is missing from the active Storage Provider", ErrFileNotFound)
			}
			return mapProviderError(err)
		}
	}
	service.staging.mu.Lock()
	service.staging.refCursor = (start + limit) % len(sorted)
	service.staging.mu.Unlock()
	return nil
}

func cleanStagedUploads(staging *fileStaging, cutoff time.Time) error {
	entries, err := os.ReadDir(staging.tempDir)
	if err != nil {
		return fmt.Errorf("read staging directory: %w", err)
	}
	staging.mu.Lock()
	active := make(map[string]struct{}, len(staging.uploads))
	for name := range staging.uploads {
		active[name] = struct{}{}
	}
	staging.mu.Unlock()
	var failures []error
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			continue
		}
		if !temporaryKeyPattern.MatchString(name) && !migrationKeyPattern.MatchString(name) {
			continue
		}
		if _, keep := active[name]; keep {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(staging.tempDir, name)); err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("reconcile staged uploads: %w", errors.Join(failures...))
	}
	return nil
}

// ReferencedFileKeys 返回所有 Durable Record 引用的对象引用（去重并排序）。
// Provider migration 与 reconcile 都只使用这个持久事实，不信任内存状态。
func (service *Service) ReferencedFileKeys(ctx context.Context) ([]string, error) {
	collections := make([]appliedModel, 0)
	var cursor string
	for {
		page, err := service.models.ListCollections(ctx, backendmodel.ListOptions{Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, mapModelError(err)
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
				if field.System || (field.Type != backendmodel.FieldTypeFile && field.Type != backendmodel.FieldTypeFiles) {
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
					var stored string
					if err := rows.Scan(&stored); err != nil {
						rows.Close()
						return err
					}
					for _, key := range storedFileKeys(field.Type, stored) {
						refs[key] = struct{}{}
					}
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
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(refs))
	for key := range refs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}

// storedFileKeys 解析一个耐久 File Field 值；非法引用会让 reconcile 明确失败而不是静默丢数据。
func storedFileKeys(fieldType backendmodel.FieldType, stored string) []string {
	if fieldType == backendmodel.FieldTypeFile {
		if !objectKeyPattern.MatchString(stored) {
			return nil
		}
		return []string{stored}
	}
	var values []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(stored)), &values); err != nil {
		return nil
	}
	keys := make([]string, 0, len(values))
	for _, value := range values {
		if objectKeyPattern.MatchString(value) {
			keys = append(keys, value)
		}
	}
	return keys
}

// validateFileValues 在写入前确认 File Field 只包含 Runtime 生成的引用。
func validateFileValues(collection backendmodel.Collection, values map[string]any) error {
	for _, field := range collection.Fields {
		if field.Type != backendmodel.FieldTypeFile && field.Type != backendmodel.FieldTypeFiles {
			continue
		}
		value := values[field.Name]
		if value == nil {
			continue
		}
		keys, err := fileValueKeys(field, value)
		if err != nil {
			return err
		}
		for _, key := range keys {
			if !objectKeyPattern.MatchString(key) && !temporaryKeyPattern.MatchString(key) {
				return fmt.Errorf("%w: File Field %q must be an opaque Runtime file key", ErrInvalidArgument, field.Name)
			}
		}
	}
	return nil
}

// hasFileFieldValue 判断一次写入是否包含任何 File value。
func hasFileFieldValue(collection backendmodel.Collection, values map[string]any) bool {
	for _, field := range collection.Fields {
		if field.Type != backendmodel.FieldTypeFile && field.Type != backendmodel.FieldTypeFiles {
			continue
		}
		if values[field.Name] != nil {
			return true
		}
	}
	return false
}

// NewMigrationStagingFile 创建一个 Runtime 管理的迁移暂存文件。
// 迁移只把远端字节落到这里，再交给目标 Provider 的 Promote。
func (service *Service) NewMigrationStagingFile() (*os.File, string, error) {
	staging, err := service.fileStagingOrError()
	if err != nil {
		return nil, "", err
	}
	name, err := newOpaqueKey("mig_")
	if err != nil {
		return nil, "", err
	}
	path := filepath.Join(staging.tempDir, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, "", fmt.Errorf("create migration staging file: %w", err)
	}
	return file, path, nil
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
