// Package portability 实现 Backup Bundle、Restore preflight/apply、Collection Export/Import
// 与 Typed Application API Contract。它是投影与搬运层，绝不绕过 Runtime 语义。
package portability

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	// ErrInvalidArgument 表示输入不合法。
	ErrInvalidArgument = errors.New("invalid portability argument")
	// ErrInvalidBundle 表示 Backup Bundle 结构不正确。
	ErrInvalidBundle = errors.New("invalid backup bundle")
	// ErrIncompatibleBundle 表示 preflight 发现 bundle 与本 Runtime 不兼容。
	ErrIncompatibleBundle = errors.New("incompatible backup bundle")
	// ErrProjectInUse 表示项目正被其它进程使用。
	ErrProjectInUse = errors.New("project is in use")
	// ErrProjectNotEmpty 表示目标项目已存在内容且未显式覆盖。
	ErrProjectNotEmpty = errors.New("project already contains a project")
	// ErrModelMismatch 表示导入 header 与 Applied Model 不一致。
	ErrModelMismatch = errors.New("imported model does not match the applied model")
	// ErrStorage 表示快照、归档或数据库读取失败。
	ErrStorage = errors.New("portability storage unavailable")
)

// 归档与 manifest 的固定标识。
const (
	FormatName             = "modelry.community.backup"
	FormatVersion          = 1
	ManifestPath           = "manifest.json"
	DatabaseArchivePath    = "database/project.sqlite"
	ObjectsArchivePrefix   = "objects/"
	maximumBundleObjects   = 100000
	maximumPreflightBytes  = 64 << 20
	maximumArchiveEntries  = 100000
	maximumImportRecords   = 1000
	maximumExportRecords   = 100000
	archiveStreamBuffer    = 32 << 10
	databaseCompatibilityMsg = "The backup was produced by a newer Modelry project format than this Runtime supports."
)

// DatabaseEntry 描述 bundle 中的数据库载荷。
type DatabaseEntry struct {
	Path          string `json:"path"`
	Bytes         int64  `json:"bytes"`
	SHA256        string `json:"sha256"`
	SQLiteVersion string `json:"sqliteVersion"`
}

// ObjectEntry 描述 bundle 中的一个文件对象。
type ObjectEntry struct {
	Key    string `json:"key"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// Counts 是 bundle 的记录数量摘要。
type Counts struct {
	Collections int64 `json:"collections"`
	Records     int64 `json:"records"`
	Objects     int64 `json:"objects"`
}

// Manifest 是 bundle 的自描述元数据。
type Manifest struct {
	Format           string        `json:"format"`
	FormatVersion    int           `json:"formatVersion"`
	ProjectID        string        `json:"projectId"`
	RuntimeVersion   string        `json:"runtimeVersion"`
	CreatedAt        time.Time     `json:"createdAt"`
	AppliedModelHash string        `json:"appliedModelHash"`
	Database         DatabaseEntry `json:"database"`
	Objects          []ObjectEntry `json:"objects"`
	Counts           Counts        `json:"counts"`
}

// Finding 是一条 preflight 结论。
type Finding struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// Preflight 是 restore 之前的只读校验结论。
type Preflight struct {
	Compatible       bool      `json:"compatible"`
	ProjectID        string    `json:"projectId,omitempty"`
	RuntimeVersion   string    `json:"runtimeVersion,omitempty"`
	FormatVersion    int       `json:"formatVersion,omitempty"`
	CreatedAt        time.Time `json:"createdAt,omitempty"`
	AppliedModelHash string    `json:"appliedModelHash,omitempty"`
	Counts           Counts    `json:"counts"`
	Findings         []Finding `json:"findings"`
}

// ObjectSource 提供 bundle 需要的文件对象；Runtime 用当前 Provider 实现它。
type ObjectSource interface {
	ReferencedFileKeys(ctx context.Context) ([]string, error)
	OpenObject(ctx context.Context, key string) (io.ReadCloser, error)
}

// ModelSource 提供 Applied Model 摘要与哈希。
type ModelSource interface {
	ListCollections(ctx context.Context, options backendmodel.ListOptions) (backendmodel.Page[backendmodel.Collection], error)
}

// Service 提供 backup、restore 与导入导出所需的编排能力。
type Service struct {
	store    *storage.Store
	objects  ObjectSource
	models   ModelSource
	managed  string
	version  string
	now      func() time.Time
}

// Options 构造 Portability Service。
type Options struct {
	Store     *storage.Store
	Objects   ObjectSource
	Models    ModelSource
	ManagedDir string
	Version   string
}

// NewService 创建 Portability Service。
func NewService(options Options) (*Service, error) {
	if options.Store == nil || options.Objects == nil || options.Models == nil || options.ManagedDir == "" {
		return nil, fmt.Errorf("%w: store, object source, model source, and managed directory are required", ErrInvalidArgument)
	}
	version := options.Version
	if version == "" {
		version = "dev"
	}
	return &Service{store: options.Store, objects: options.Objects, models: options.Models, managed: options.ManagedDir, version: version, now: func() time.Time { return time.Now().UTC() }}, nil
}

// InspectionOptions 构造只做 preflight 与 contract 生成的轻量服务。
// 它不持有 Store 或 ObjectSource，因此可以在项目停止时、甚至在没有完整 Runtime 的情况下运行。
type InspectionOptions struct {
	ManagedDir string
	Models     ModelSource
	Version    string
}

// NewInspectionService 创建只读 Portability 服务。
func NewInspectionService(options InspectionOptions) (*Service, error) {
	if strings.TrimSpace(options.ManagedDir) == "" {
		return nil, fmt.Errorf("%w: managed directory is required", ErrInvalidArgument)
	}
	version := options.Version
	if version == "" {
		version = "dev"
	}
	return &Service{managed: options.ManagedDir, models: options.Models, version: version, now: func() time.Time { return time.Now().UTC() }}, nil
}
// sqliteVersion 在没有 Store 的只读场景下安全返回空值。
func (service *Service) sqliteVersion() string {
	if service == nil || service.store == nil {
		return ""
	}
	return service.store.SQLiteVersion()
}

// AppliedModelHash 计算 Applied Model 的稳定哈希。
func (service *Service) AppliedModelHash(ctx context.Context) (string, error) {
	collections, err := service.appliedCollections(ctx)
	if err != nil {
		return "", err
	}
	encoded, err := canonicalJSON(contractCollections(collections))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func (service *Service) appliedCollections(ctx context.Context) ([]backendmodel.Collection, error) {
	collections := make([]backendmodel.Collection, 0, 16)
	cursor := ""
	for len(collections) < 512 {
		page, err := service.models.ListCollections(ctx, backendmodel.ListOptions{Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, fmt.Errorf("%w: read Applied Model: %v", ErrStorage, err)
		}
		collections = append(collections, page.Data...)
		if page.NextCursor == "" || len(page.Data) == 0 {
			break
		}
		cursor = page.NextCursor
	}
	sort.SliceStable(collections, func(left, right int) bool { return collections[left].Name < collections[right].Name })
	return collections, nil
}

// canonicalCollection 是参与哈希与契约投影的稳定结构。
type canonicalCollection struct {
	ID      string                 `json:"id"`
	Name    string                 `json:"name"`
	Type    string                 `json:"type"`
	Version int                    `json:"schemaVersion"`
	Fields  []canonicalField       `json:"fields"`
	Indexes []canonicalIndex       `json:"indexes,omitempty"`
}

type canonicalField struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	Type                string          `json:"type"`
	Required            bool            `json:"required"`
	Unique              bool            `json:"unique"`
	RelationTarget      string          `json:"relationTargetCollectionId,omitempty"`
	RelationCardinality string          `json:"relationCardinality,omitempty"`
	Validation          json.RawMessage `json:"validation,omitempty"`
	Default             json.RawMessage `json:"default,omitempty"`
}

type canonicalIndex struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Fields []string `json:"fields"`
	Unique bool     `json:"unique"`
}

func contractCollections(collections []backendmodel.Collection) []canonicalCollection {
	result := make([]canonicalCollection, 0, len(collections))
	for _, collection := range collections {
		entry := canonicalCollection{
			ID: collection.ID, Name: collection.Name, Type: string(collection.Type),
			Version: collection.SchemaVersion,
		}
		fields := append([]backendmodel.Field(nil), collection.Fields...)
		sort.SliceStable(fields, func(left, right int) bool { return fields[left].Name < fields[right].Name })
		for _, field := range fields {
			if field.System {
				continue
			}
			projected := canonicalField{
				ID: field.ID, Name: field.Name, Type: string(field.Type),
				Required: field.Required, Unique: field.Unique,
				Validation: field.Validation, Default: field.Default,
			}
			if field.Relation != nil {
				projected.RelationTarget = field.Relation.TargetCollectionID
				projected.RelationCardinality = field.Relation.Cardinality
			}
			entry.Fields = append(entry.Fields, projected)
		}
		indexes := append([]backendmodel.Index(nil), collection.Indexes...)
		sort.SliceStable(indexes, func(left, right int) bool { return indexes[left].Name < indexes[right].Name })
		for _, index := range indexes {
			entry.Indexes = append(entry.Indexes, canonicalIndex{ID: index.ID, Name: index.Name, Fields: index.Fields, Unique: index.Unique})
		}
		result = append(result, entry)
	}
	return result
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("%w: canonical encoding failed", ErrStorage)
	}
	return encoded, nil
}

// BackupOptions 控制一次 backup。
type BackupOptions struct {
	// Destination 是 bundle 要写入的文件路径。
	Destination string
}

// BackupResult 是一次 backup 的结果。
type BackupResult struct {
	Path   string
	Bytes  int64
	Digest string
	Counts Counts
}

// CreateBackup 产生一个一致的 Backup Bundle 并写入 Destination。
func (service *Service) CreateBackup(ctx context.Context, options BackupOptions) (BackupResult, error) {
	if service == nil || service.store == nil {
		return BackupResult{}, fmt.Errorf("%w: portability service is not ready", ErrStorage)
	}
	if strings.TrimSpace(options.Destination) == "" {
		return BackupResult{}, fmt.Errorf("%w: backup destination is required", ErrInvalidArgument)
	}
	workDir, err := os.MkdirTemp(service.managed, "backup-work-")
	if err != nil {
		return BackupResult{}, fmt.Errorf("%w: prepare backup workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)

	snapshotPath := filepath.Join(workDir, "project.sqlite")
	if err := service.store.SnapshotTo(ctx, snapshotPath); err != nil {
		return BackupResult{}, fmt.Errorf("%w: %v", ErrStorage, err)
	}
	databaseBytes, databaseDigest, err := fileDigest(snapshotPath)
	if err != nil {
		return BackupResult{}, err
	}

	keys, err := service.objects.ReferencedFileKeys(ctx)
	if err != nil {
		return BackupResult{}, fmt.Errorf("%w: list referenced file objects: %v", ErrStorage, err)
	}
	sort.Strings(keys)
	if len(keys) > maximumBundleObjects {
		return BackupResult{}, fmt.Errorf("%w: this project references %d file objects; a bundle is limited to %d", ErrInvalidArgument, len(keys), maximumBundleObjects)
	}
	objectsDir := filepath.Join(workDir, "objects")
	if err := os.MkdirAll(objectsDir, 0o700); err != nil {
		return BackupResult{}, fmt.Errorf("%w: prepare object staging: %v", ErrStorage, err)
	}
	entries := make([]ObjectEntry, 0, len(keys))
	for _, key := range keys {
		stagedPath := filepath.Join(objectsDir, key)
		if err := os.MkdirAll(filepath.Dir(stagedPath), 0o700); err != nil {
			return BackupResult{}, fmt.Errorf("%w: prepare object staging: %v", ErrStorage, err)
		}
		written, digest, err := service.stageObject(ctx, key, stagedPath)
		if err != nil {
			return BackupResult{}, err
		}
		entries = append(entries, ObjectEntry{Key: key, Bytes: written, SHA256: digest})
	}

	collections, records, err := service.counts(ctx)
	if err != nil {
		return BackupResult{}, err
	}
	modelHash, err := service.AppliedModelHash(ctx)
	if err != nil {
		return BackupResult{}, err
	}
	manifest := Manifest{
		Format: FormatName, FormatVersion: FormatVersion, ProjectID: service.store.ProjectID(),
		RuntimeVersion: service.version, CreatedAt: service.now().UTC(), AppliedModelHash: modelHash,
		Database: DatabaseEntry{Path: DatabaseArchivePath, Bytes: databaseBytes, SHA256: databaseDigest, SQLiteVersion: service.sqliteVersion()},
		Objects:  entries,
		Counts:   Counts{Collections: collections, Records: records, Objects: int64(len(entries))},
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return BackupResult{}, fmt.Errorf("%w: encode manifest: %v", ErrStorage, err)
	}

	destinationFile, err := os.OpenFile(options.Destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return BackupResult{}, fmt.Errorf("%w: create backup bundle: %v", ErrStorage, err)
	}
	archiveDigest := sha256.New()
	writer := tar.NewWriter(io.MultiWriter(destinationFile, archiveDigest))
	writeErr := writeArchive(writer, manifestBytes, snapshotPath, objectsDir, entries)
	if writeErr == nil {
		writeErr = writer.Close()
	}
	if closeErr := destinationFile.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		_ = os.Remove(options.Destination)
		return BackupResult{}, fmt.Errorf("%w: write backup bundle: %v", ErrStorage, writeErr)
	}
	info, err := os.Stat(options.Destination)
	if err != nil {
		return BackupResult{}, fmt.Errorf("%w: read backup bundle: %v", ErrStorage, err)
	}
	return BackupResult{Path: options.Destination, Bytes: info.Size(), Digest: hex.EncodeToString(archiveDigest.Sum(nil)), Counts: manifest.Counts}, nil
}

func (service *Service) stageObject(ctx context.Context, key, destination string) (int64, string, error) {
	reader, err := service.objects.OpenObject(ctx, key)
	if err != nil {
		return 0, "", fmt.Errorf("%w: read referenced file object: %v", ErrStorage, err)
	}
	defer reader.Close()
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, "", fmt.Errorf("%w: stage file object: %v", ErrStorage, err)
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), reader)
	if closeErr := file.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return 0, "", fmt.Errorf("%w: stage file object: %v", ErrStorage, copyErr)
	}
	return written, hex.EncodeToString(hasher.Sum(nil)), nil
}

func (service *Service) counts(ctx context.Context) (int64, int64, error) {
	collections, err := service.store.CollectionCount(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("%w: %v", ErrStorage, err)
	}
	records, err := service.store.ProjectedRecordCount(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("%w: %v", ErrStorage, err)
	}
	return collections, records, nil
}

func fileDigest(path string) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", fmt.Errorf("%w: read snapshot: %v", ErrStorage, err)
	}
	defer file.Close()
	hasher := sha256.New()
	written, err := io.Copy(hasher, file)
	if err != nil {
		return 0, "", fmt.Errorf("%w: read snapshot: %v", ErrStorage, err)
	}
	return written, hex.EncodeToString(hasher.Sum(nil)), nil
}

func writeArchive(writer *tar.Writer, manifest []byte, snapshotPath, objectsDir string, entries []ObjectEntry) error {
	if err := writeTarEntry(writer, ManifestPath, manifest, time.Time{}); err != nil {
		return err
	}
	snapshotFile, err := os.Open(snapshotPath)
	if err != nil {
		return err
	}
	defer snapshotFile.Close()
	snapshotInfo, err := snapshotFile.Stat()
	if err != nil {
		return err
	}
	if err := writeTarStream(writer, DatabaseArchivePath, snapshotFile, snapshotInfo.Size()); err != nil {
		return err
	}
	for _, entry := range entries {
		file, err := os.Open(filepath.Join(objectsDir, entry.Key))
		if err != nil {
			return err
		}
		objectInfo, statErr := file.Stat()
		if statErr != nil {
			file.Close()
			return statErr
		}
		writeErr := writeTarStream(writer, ObjectsArchivePrefix+entry.Key, file, objectInfo.Size())
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func writeTarEntry(writer *tar.Writer, name string, payload []byte, modified time.Time) error {
	header := &tar.Header{Name: name, Mode: 0o600, Size: int64(len(payload)), ModTime: modified}
	if err := writer.WriteHeader(header); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}

func writeTarStream(writer *tar.Writer, name string, source io.Reader, size int64) error {
	header := &tar.Header{Name: name, Mode: 0o600, Size: size, Typeflag: tar.TypeReg, ModTime: time.Time{}}
	if err := writer.WriteHeader(header); err != nil {
		return err
	}
	if _, err := io.Copy(writer, source); err != nil {
		return err
	}
	return nil
}

// Preflight 校验一个 Backup Bundle，且不写入任何项目文件。
func (service *Service) Preflight(ctx context.Context, archivePath string) (Preflight, error) {
	workDir, err := os.MkdirTemp(service.managed, "preflight-")
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: prepare preflight workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)
	sqliteVersion := ""
	if service.store != nil {
		sqliteVersion = service.sqliteVersion()
	}
	return preflightArchive(ctx, archivePath, workDir, sqliteVersion)
}

// PreflightReader 校验一个来自 HTTP 请求体的 Backup Bundle。
func (service *Service) PreflightReader(ctx context.Context, source io.Reader) (Preflight, error) {
	workDir, err := os.MkdirTemp(service.managed, "preflight-")
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: prepare preflight workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)
	archivePath := filepath.Join(workDir, "bundle.tar")
	file, err := os.OpenFile(archivePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: stage uploaded bundle: %v", ErrStorage, err)
	}
	limited := io.LimitReader(source, maximumPreflightBytes+1)
	written, copyErr := io.Copy(file, limited)
	if closeErr := file.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return Preflight{}, fmt.Errorf("%w: stage uploaded bundle: %v", ErrStorage, copyErr)
	}
	if written > maximumPreflightBytes {
		return Preflight{}, fmt.Errorf("%w: the uploaded bundle exceeds the preflight limit", ErrInvalidArgument)
	}
	sqliteVersion := ""
	if service.store != nil {
		sqliteVersion = service.sqliteVersion()
	}
	return preflightArchive(ctx, archivePath, workDir, sqliteVersion)
}

func preflightArchive(ctx context.Context, archivePath, workDir, sqliteVersion string) (Preflight, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: open bundle: %v", ErrInvalidBundle, err)
	}
	defer file.Close()
	reader := tar.NewReader(file)
	findings := make([]Finding, 0, 8)
	preflight := Preflight{Compatible: false, Findings: findings}

	header, err := reader.Next()
	if err != nil || strings.TrimSpace(path.Clean(header.Name)) != ManifestPath {
		return Preflight{}, fmt.Errorf("%w: the bundle must start with %s", ErrInvalidBundle, ManifestPath)
	}
	manifestBytes, err := io.ReadAll(io.LimitReader(reader, maximumPreflightBytes))
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: read manifest", ErrInvalidBundle)
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return Preflight{}, fmt.Errorf("%w: manifest is not readable", ErrInvalidBundle)
	}
	preflight.ProjectID = manifest.ProjectID
	preflight.RuntimeVersion = manifest.RuntimeVersion
	preflight.FormatVersion = manifest.FormatVersion
	preflight.CreatedAt = manifest.CreatedAt
	preflight.AppliedModelHash = manifest.AppliedModelHash
	preflight.Counts = manifest.Counts

	compatible := true
	if manifest.Format != FormatName {
		compatible = false
		findings = append(findings, Finding{Code: "format.unsupported", Severity: "error", Message: "This archive is not a Modelry Community backup bundle."})
	}
	if manifest.FormatVersion != FormatVersion {
		compatible = false
		findings = append(findings, Finding{Code: "format.versionUnsupported", Severity: "error", Message: databaseCompatibilityMsg})
	}
	if manifest.Database.Path != DatabaseArchivePath || manifest.Database.SHA256 == "" {
		compatible = false
		findings = append(findings, Finding{Code: "database.missing", Severity: "error", Message: "The manifest does not describe a database payload."})
	}

	stagedDatabase := filepath.Join(workDir, "project.sqlite")
	expected := map[string]string{DatabaseArchivePath: manifest.Database.SHA256}
	for _, entry := range manifest.Objects {
		expected[ObjectsArchivePrefix+entry.Key] = entry.SHA256
	}
	seen := map[string]struct{}{}
	entries := 0
	objects := filepath.Join(workDir, "objects")
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			compatible = false
			findings = append(findings, Finding{Code: "archive.unreadable", Severity: "error", Message: "The archive could not be read to the end."})
			break
		}
		entries++
		if entries > maximumArchiveEntries {
			compatible = false
			findings = append(findings, Finding{Code: "archive.tooManyEntries", Severity: "error", Message: "The archive contains more entries than this Runtime accepts."})
			break
		}
		name := path.Clean(header.Name)
		digest, found := expected[name]
		if !found {
			compatible = false
			findings = append(findings, Finding{Code: "archive.unexpectedEntry", Severity: "error", Message: "The archive contains an entry the manifest does not list."})
			continue
		}
		seen[name] = struct{}{}
		destination := ""
		switch {
		case name == DatabaseArchivePath:
			destination = stagedDatabase
		case strings.HasPrefix(name, ObjectsArchivePrefix):
			key := strings.TrimPrefix(name, ObjectsArchivePrefix)
			if key == "" || strings.Contains(key, "..") {
				compatible = false
				findings = append(findings, Finding{Code: "object.invalidKey", Severity: "error", Message: "The archive contains an invalid object key."})
				continue
			}
			destination = filepath.Join(objects, key)
		}
		hasher := sha256.New()
		var sink io.Writer = hasher
		var staged *os.File
		if destination != "" {
			if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
				return Preflight{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
			}
			staged, err = os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return Preflight{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
			}
			sink = io.MultiWriter(hasher, staged)
		}
		_, copyErr := io.Copy(sink, io.LimitReader(reader, maximumPreflightBytes))
		if staged != nil {
			if closeErr := staged.Close(); copyErr == nil {
				copyErr = closeErr
			}
		}
		if copyErr != nil {
			return Preflight{}, fmt.Errorf("%w: read bundle payload: %v", ErrStorage, copyErr)
		}
		if hex.EncodeToString(hasher.Sum(nil)) != digest {
			compatible = false
			findings = append(findings, Finding{Code: "payload.digestMismatch", Severity: "error", Message: "A bundle payload does not match the digest recorded in the manifest."})
		}
	}
	for name := range expected {
		if _, found := seen[name]; found {
			continue
		}
		compatible = false
		findings = append(findings, Finding{Code: "payload.missing", Severity: "error", Message: "The manifest lists a payload that the archive does not contain."})
		break
	}

	if compatible {
		if err := validateSnapshotDatabase(ctx, stagedDatabase, sqliteVersion); err != nil {
			compatible = false
			findings = append(findings, Finding{Code: "database.incompatible", Severity: "error", Message: err.Error()})
		} else if len(manifest.Objects) > 0 {
			findings = append(findings, Finding{Code: "objects.localOnly", Severity: "warning", Message: "Restore writes the bundle's file objects into the local object directory. A project configured for S3-compatible storage must migrate objects after restore."})
		}
	}
	preflight.Compatible = compatible
	if findings == nil {
		findings = []Finding{}
	}
	preflight.Findings = findings
	return preflight, nil
}

func validateSnapshotDatabase(ctx context.Context, databasePath, sqliteVersion string) error {
	file, err := os.Stat(databasePath)
	if err != nil || file.Size() == 0 {
		return errors.New("The bundle database payload is missing or empty.")
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(databasePath)+"?mode=ro&_pragma=query_only(1)")
	if err != nil {
		return errors.New("The bundle database payload cannot be opened.")
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, "SELECT 1"); err != nil {
		return errors.New("The bundle database payload cannot be read.")
	}
	present, err := storage.HasInternalMigrationTable(ctx, database)
	if err != nil || !present {
		return errors.New("The bundle database payload is not a Modelry project database.")
	}
	version, err := storage.DatabaseFormatVersion(ctx, database)
	if err != nil {
		return errors.New("The bundle database format version cannot be read.")
	}
	if version > 1 {
		return errors.New(databaseCompatibilityMsg)
	}
	_ = sqliteVersion
	return nil
}

// ApplyOptions 控制一次 restore apply。
type ApplyOptions struct {
	// Force 允许覆盖一个已经包含项目的目录。
	Force bool
	// ObjectsDir 是目标本地对象目录。
	ObjectsDir string
	// DatabasePath 是目标数据库路径。
	DatabasePath string
}

// Apply 在 preflight 通过后替换一个已停止项目的状态。
func (service *Service) Apply(ctx context.Context, archivePath string, options ApplyOptions) (Preflight, error) {
	preflight, err := service.Preflight(ctx, archivePath)
	if err != nil {
		return Preflight{}, err
	}
	if !preflight.Compatible {
		return preflight, ErrIncompatibleBundle
	}
	if options.DatabasePath == "" || options.ObjectsDir == "" {
		return preflight, fmt.Errorf("%w: database path and object directory are required", ErrInvalidArgument)
	}
	if !options.Force {
		if _, err := os.Stat(options.DatabasePath); err == nil {
			return preflight, ErrProjectNotEmpty
		}
	}
	workDir, err := os.MkdirTemp(service.managed, "restore-")
	if err != nil {
		return preflight, fmt.Errorf("%w: prepare restore workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)
	staged, err := extractArchive(ctx, archivePath, workDir)
	if err != nil {
		return preflight, err
	}
	if err := validateSnapshotDatabase(ctx, staged.databasePath, service.sqliteVersion()); err != nil {
		return preflight, fmt.Errorf("%w: %v", ErrIncompatibleBundle, err)
	}
	if err := replacePath(staged.databasePath, options.DatabasePath); err != nil {
		return preflight, err
	}
	for _, key := range staged.objectKeys {
		source := filepath.Join(staged.objectsDir, key)
		destination := filepath.Join(options.ObjectsDir, key)
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return preflight, fmt.Errorf("%w: prepare object directory: %v", ErrStorage, err)
		}
		if err := replacePath(source, destination); err != nil {
			return preflight, err
		}
	}
	return preflight, nil
}

type stagedBundle struct {
	databasePath string
	objectsDir   string
	objectKeys   []string
}

func extractArchive(ctx context.Context, archivePath, workDir string) (stagedBundle, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return stagedBundle{}, fmt.Errorf("%w: open bundle: %v", ErrInvalidBundle, err)
	}
	defer file.Close()
	reader := tar.NewReader(file)
	staged := stagedBundle{databasePath: filepath.Join(workDir, "project.sqlite"), objectsDir: filepath.Join(workDir, "objects")}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return stagedBundle{}, fmt.Errorf("%w: read bundle: %v", ErrInvalidBundle, err)
		}
		name := path.Clean(header.Name)
		if name == ManifestPath {
			continue
		}
		destination := ""
		switch {
		case name == DatabaseArchivePath:
			destination = staged.databasePath
		case strings.HasPrefix(name, ObjectsArchivePrefix):
			key := strings.TrimPrefix(name, ObjectsArchivePrefix)
			if key == "" || strings.Contains(key, "..") {
				return stagedBundle{}, fmt.Errorf("%w: invalid object key", ErrInvalidBundle)
			}
			staged.objectKeys = append(staged.objectKeys, key)
			destination = filepath.Join(staged.objectsDir, key)
		default:
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return stagedBundle{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
		}
		out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return stagedBundle{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
		}
		_, copyErr := io.Copy(out, reader)
		if closeErr := out.Close(); copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return stagedBundle{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, copyErr)
		}
	}
	if err := ctx.Err(); err != nil {
		return stagedBundle{}, err
	}
	return staged, nil
}

func replacePath(source, destination string) error {
	temp := destination + ".restore-tmp"
	_ = os.Remove(temp)
	if err := os.Rename(source, temp); err != nil {
		return fmt.Errorf("%w: stage restored payload: %v", ErrStorage, err)
	}
	if err := os.Rename(temp, destination); err != nil {
		return fmt.Errorf("%w: activate restored payload: %v", ErrStorage, err)
	}
	return nil
}