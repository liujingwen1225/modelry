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
	"github.com/liujingwen1225/modelry/internal/filestore"
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
	// ErrPayloadTooLarge 表示 bundle 声明的载荷超过了本 Runtime 接受的边界。
	ErrPayloadTooLarge = errors.New("backup bundle payload exceeds the accepted bound")
)

// 归档与 manifest 的固定标识。
const (
	FormatName               = "modelry.community.backup"
	FormatVersion            = 1
	ManifestPath             = "manifest.json"
	DatabaseArchivePath      = "database/project.sqlite"
	ObjectsArchivePrefix     = "objects/"
	databaseCompatibilityMsg = "The backup was produced by a newer Modelry project format than this Runtime supports."
)

// Bounds 与 Spec 0010 §5 一一对应。这些上限只约束它们各自描述的对象：
// maximumManifestBytes 绝不约束数据库或 object 载荷，因此一个合法的
// >64 MiB 且 <=128 MiB 的 File object 仍然可以 Backup -> Preflight -> Restore。
const (
	// maximumBundleObjects 是一个 bundle 能携带的 File object 数量。
	maximumBundleObjects = 100000
	// maximumArchiveEntries 是一个归档能包含的条目数量。它必须容纳 manifest、数据库载荷
	// 以及上限数量的 File object，否则 Backup 能写出一个自己拒绝读取的 bundle。
	maximumArchiveEntries = maximumBundleObjects + 2
	// maximumManifestBytes 只约束 manifest.json 自身。
	maximumManifestBytes = 64 << 20
	// maximumObjectPayloadBytes 约束单个 File object 载荷。它与产品的单对象硬上限
	// 一致：Provider 永远不会存下更大的对象，因此这不会拒绝任何合法备份。
	maximumObjectPayloadBytes = filestore.MaxObjectBytes
	// maximumDatabasePayloadBytes 约束数据库载荷。
	maximumDatabasePayloadBytes = 4 << 30
	// maximumRestoreBytes 约束一个 bundle 声明的载荷总量：它同时约束 HTTP 读入量、
	// preflight 的 staging 峰值与 Apply 期间单份 staging 的大小。Apply 还会把每个载荷
	// 在目标目录旁再复制一份，因此 restore 的峰值磁盘约为声明量的两倍。
	maximumRestoreBytes = 4 << 30
	// archiveOverheadAllowance 为 manifest 与全部归档条目的 tar 头/padding 预留余量。
	// 它按条目上限推导，因此调整 maximumArchiveEntries 或对象键长度不会让合法 bundle 被误判。
	archiveOverheadAllowance = maximumManifestBytes + maximumArchiveEntries*1024 + (1 << 20)
	// maximumContractCollections 是 Contract 生成与 Applied Model 读取的 Collection 上限。
	// 超过它时 Runtime 明确失败，绝不静默丢弃一部分 Collection——否则 appliedModelHash
	// 会描述一个不完整的模型，import 的 model gate 就会失效。
	maximumContractCollections = 512

	maximumImportRecords = 1000
	maximumExportRecords = 100000
	archiveStreamBuffer  = 32 << 10
)

// RestoreJournalName 是 restore 原子激活日志的文件名，位于 managed directory。
const RestoreJournalName = "restore-journal.jsonl"

// archiveEnvelope 返回一个 bundle 允许占用的最大字节数。
// 它由 manifest 声明的载荷总量推导，因此合法的大对象不会被整体上限误伤，
// 而声明越大、Runtime 允许读入的字节也越大——并且始终有绝对上限。
func archiveEnvelope(declaredPayloadBytes int64) int64 {
	if declaredPayloadBytes < 0 {
		declaredPayloadBytes = 0
	}
	if declaredPayloadBytes > maximumRestoreBytes {
		declaredPayloadBytes = maximumRestoreBytes
	}
	return declaredPayloadBytes + archiveOverheadAllowance
}

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

// ObjectSource 按 key 提供 bundle 需要的文件对象字节；Runtime 用当前 Provider 实现它。
// 它故意不提供「列出被引用 key」的能力：那必须来自 SQLite 快照，而不是 live Runtime。
// File object 是不可变的（Provider 拒绝覆盖已存在的 key），因此快照之后按快照给出的
// key 读取字节仍然属于同一个逻辑快照。
type ObjectSource interface {
	OpenObject(ctx context.Context, key string) (io.ReadCloser, error)
}

// ModelSource 提供 Applied Model 摘要与哈希。
type ModelSource interface {
	ListCollections(ctx context.Context, options backendmodel.ListOptions) (backendmodel.Page[backendmodel.Collection], error)
}

// Service 提供 backup、restore 与导入导出所需的编排能力。
type Service struct {
	store     *storage.Store
	objects   ObjectSource
	models    ModelSource
	snapshots SnapshotSource
	managed   string
	version   string
	now       func() time.Time
}

// Options 构造 Portability Service。
type Options struct {
	Store     *storage.Store
	Objects   ObjectSource
	Models    ModelSource
	// Snapshots 为一个已落盘的 SQLite 快照打开只读读取器。省略时使用内建实现。
	Snapshots  SnapshotSource
	ManagedDir string
	Version    string
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
	snapshots := options.Snapshots
	if snapshots == nil {
		snapshots = liveSnapshotSource{}
	}
	return &Service{store: options.Store, objects: options.Objects, models: options.Models, snapshots: snapshots, managed: options.ManagedDir, version: version, now: func() time.Time { return time.Now().UTC() }}, nil
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
	return hashCollections(collections)
}

// hashCollections 计算一组 Applied Collections 的稳定哈希。
// live Runtime 与 SQLite 快照共用它，因此 manifest 里的 hash 与 Export/Import
// 使用的 hash 永远是同一个函数的结果。
func hashCollections(collections []backendmodel.Collection) (string, error) {
	encoded, err := canonicalJSON(contractCollections(collections))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func (service *Service) appliedCollections(ctx context.Context) ([]backendmodel.Collection, error) {
	collections, err := collectCollections(ctx, service.models)
	if err != nil {
		// %w 让调用方仍能识别具体原因，而不是把所有失败折叠成「Runtime 未就绪」。
		return nil, fmt.Errorf("%w: read Applied Model: %w", ErrStorage, err)
	}
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

	// 第一步：产生一个一致的 SQLite 快照。此后引用对象集合、counts 与 Applied Model
	// hash 全部从这个快照读取——绝不回到仍在变化的 live Runtime。这样即使 Runtime
	// 在快照之后继续写入 Record、File 或 Schema，bundle 依然自洽。
	snapshotPath := filepath.Join(workDir, "project.sqlite")
	if err := service.store.SnapshotTo(ctx, snapshotPath); err != nil {
		return BackupResult{}, fmt.Errorf("%w: %v", ErrStorage, err)
	}

	facts, err := service.readSnapshotFacts(ctx, snapshotPath)
	if err != nil {
		return BackupResult{}, err
	}
	keys := facts.fileKeys
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
		// 对象是不可变的引用：Provider 永不覆盖已存在的 key，因此快照之后读取字节
		// 仍然属于同一个逻辑快照。
		written, digest, err := service.stageObject(ctx, key, stagedPath)
		if err != nil {
			return BackupResult{}, err
		}
		entries = append(entries, ObjectEntry{Key: key, Bytes: written, SHA256: digest})
	}

	databaseBytes, databaseDigest, err := fileDigest(snapshotPath)
	if err != nil {
		return BackupResult{}, err
	}
	// Backup 必须遵守与 Preflight 完全相同的边界，否则它会产出一份连自己都无法恢复的
	// bundle：错误暴露点从备份当天推迟到 restore 当天，那时已经不可补救。
	if err := checkPayloadBounds(databaseBytes, entries); err != nil {
		return BackupResult{}, err
	}
	manifest := Manifest{
		Format: FormatName, FormatVersion: FormatVersion, ProjectID: facts.projectID,
		RuntimeVersion: service.version, CreatedAt: service.now().UTC(), AppliedModelHash: facts.modelHash,
		Database: DatabaseEntry{Path: DatabaseArchivePath, Bytes: databaseBytes, SHA256: databaseDigest, SQLiteVersion: service.sqliteVersion()},
		Objects:  entries,
		Counts:   Counts{Collections: facts.collections, Records: facts.records, Objects: int64(len(entries))},
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

// stageObject 把一个对象字节流写进 staging。
// 它把读取量限制在单对象上限 + 1 字节，因此 staging 的磁盘占用与耗时由边界决定，
// 而不是由 Provider 里实际存了多大的对象决定。
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
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), io.LimitReader(reader, maximumObjectPayloadBytes+1))
	if closeErr := file.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return 0, "", fmt.Errorf("%w: stage file object: %v", ErrStorage, copyErr)
	}
	if written > maximumObjectPayloadBytes {
		return 0, "", fmt.Errorf("%w: file object %q exceeds the %d byte object limit", ErrInvalidArgument, key, int64(maximumObjectPayloadBytes))
	}
	return written, hex.EncodeToString(hasher.Sum(nil)), nil
}

// checkPayloadBounds 执行与 planBundle 同源的载荷边界检查。
func checkPayloadBounds(databaseBytes int64, objects []ObjectEntry) error {
	if databaseBytes <= 0 {
		return fmt.Errorf("%w: the project database is empty", ErrStorage)
	}
	if databaseBytes > maximumDatabasePayloadBytes {
		return fmt.Errorf("%w: the project database is larger than this Runtime can restore", ErrPayloadTooLarge)
	}
	if int64(len(objects)) > maximumBundleObjects {
		return fmt.Errorf("%w: this project references %d file objects; a bundle is limited to %d", ErrPayloadTooLarge, len(objects), maximumBundleObjects)
	}
	total := databaseBytes
	for _, entry := range objects {
		// 零字节对象是合法的；负长度永远不合法。
		if entry.Bytes < 0 || entry.Bytes > maximumObjectPayloadBytes {
			return fmt.Errorf("%w: file object %q has a size this bundle cannot carry", ErrPayloadTooLarge, entry.Key)
		}
		total += entry.Bytes
	}
	if total > maximumRestoreBytes {
		return fmt.Errorf("%w: this project's database and file objects add up to more payload than this Runtime can restore", ErrPayloadTooLarge)
	}
	return nil
}

// snapshotFacts 是 Backup 必须从一个逻辑快照一次性取得的全部项目事实。
// 它们要么全部来自同一个快照，要么这次 backup 不成立。
type snapshotFacts struct {
	projectID   string
	collections int64
	records     int64
	modelHash   string
	fileKeys    []string
}

// readSnapshotFacts 从已经落盘的 SQLite 快照读取 Applied Model、计数与 File 引用。
// 它绝不读取 live Runtime，因此快照之后发生的 Record/File/Schema mutation 不会
// 污染 manifest 与 object set。
func (service *Service) readSnapshotFacts(ctx context.Context, snapshotPath string) (snapshotFacts, error) {
	reader, err := service.snapshots.OpenSnapshot(ctx, snapshotPath)
	if err != nil {
		return snapshotFacts{}, fmt.Errorf("%w: open the database snapshot: %v", ErrStorage, err)
	}
	defer func() { _ = reader.Close() }()

	collections, err := reader.AppliedCollections(ctx)
	if err != nil {
		return snapshotFacts{}, fmt.Errorf("%w: read the Applied Model from the database snapshot: %v", ErrStorage, err)
	}
	modelHash, err := hashCollections(collections)
	if err != nil {
		return snapshotFacts{}, err
	}
	counts, err := reader.Counts(ctx)
	if err != nil {
		return snapshotFacts{}, fmt.Errorf("%w: read counts from the database snapshot: %v", ErrStorage, err)
	}
	keys, err := reader.ReferencedFileKeys(ctx)
	if err != nil {
		return snapshotFacts{}, fmt.Errorf("%w: read referenced file objects from the database snapshot: %v", ErrStorage, err)
	}
	sort.Strings(keys)
	return snapshotFacts{
		projectID:   reader.ProjectID(),
		collections: counts.Collections,
		records:     counts.Records,
		modelHash:   modelHash,
		fileKeys:    keys,
	}, nil
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
	file, err := os.Open(archivePath)
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: open bundle: %v", ErrInvalidBundle, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: read bundle: %v", ErrInvalidBundle, err)
	}
	if info.Size() > archiveEnvelope(maximumRestoreBytes) {
		return Preflight{}, fmt.Errorf("%w: the bundle is larger than this Runtime accepts", ErrPayloadTooLarge)
	}
	workDir, err := os.MkdirTemp(service.managed, "preflight-")
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: prepare preflight workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)
	return preflightArchive(ctx, file, workDir, service.sqliteVersion())
}

// PreflightReader 校验一个来自 HTTP 请求体的 Backup Bundle。
// 它以流式方式解析归档：只有数据库载荷会落到 staging 目录，object 载荷只做摘要
// 校验，因此磁盘占用被 manifest 与数据库载荷的总量限制住。
func (service *Service) PreflightReader(ctx context.Context, source io.Reader) (Preflight, error) {
	workDir, err := os.MkdirTemp(service.managed, "preflight-")
	if err != nil {
		return Preflight{}, fmt.Errorf("%w: prepare preflight workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)
	return preflightArchive(ctx, source, workDir, service.sqliteVersion())
}

// errBundleTooLarge 由 boundedReader 在超出预算时返回。
var errBundleTooLarge = errors.New("backup bundle read past its allowed size")

// boundedReader 给一个字节流加上可动态收紧的预算。
// tar 顺序读取不需要 seek，因此 preflight 可以在读到 manifest 之后才收紧预算。
type boundedReader struct {
	reader io.Reader
	read   int64
	limit  int64
}

func (bounded *boundedReader) Read(buffer []byte) (int, error) {
	if bounded.read >= bounded.limit {
		return 0, errBundleTooLarge
	}
	if remaining := bounded.limit - bounded.read; int64(len(buffer)) > remaining {
		buffer = buffer[:remaining]
	}
	read, err := bounded.reader.Read(buffer)
	bounded.read += int64(read)
	return read, err
}

// tighten 只收紧预算，永不放宽。
func (bounded *boundedReader) tighten(limit int64) {
	if limit < bounded.limit {
		bounded.limit = limit
	}
}

func preflightArchive(ctx context.Context, source io.Reader, workDir, sqliteVersion string) (Preflight, error) {
	bounded := &boundedReader{reader: source, limit: archiveEnvelope(maximumRestoreBytes)}
	reader := tar.NewReader(bounded)
	findings := make([]Finding, 0, 8)
	preflight := Preflight{Compatible: false, Findings: findings}

	header, err := reader.Next()
	if err != nil || path.Clean(header.Name) != ManifestPath {
		return Preflight{}, fmt.Errorf("%w: the bundle must start with %s", ErrInvalidBundle, ManifestPath)
	}
	if !regularArchiveEntry(header) {
		return Preflight{}, fmt.Errorf("%w: %s must be a regular file", ErrInvalidBundle, ManifestPath)
	}
	if header.Size > maximumManifestBytes {
		return Preflight{}, fmt.Errorf("%w: the manifest is larger than the %d byte manifest limit", ErrPayloadTooLarge, int64(maximumManifestBytes))
	}
	manifestBytes, err := io.ReadAll(io.LimitReader(reader, maximumManifestBytes+1))
	if err != nil {
		if errors.Is(err, errBundleTooLarge) {
			return Preflight{}, fmt.Errorf("%w: the bundle ended before its manifest was complete", ErrPayloadTooLarge)
		}
		return Preflight{}, fmt.Errorf("%w: read manifest", ErrInvalidBundle)
	}
	if int64(len(manifestBytes)) > maximumManifestBytes {
		return Preflight{}, fmt.Errorf("%w: the manifest is larger than the %d byte manifest limit", ErrPayloadTooLarge, int64(maximumManifestBytes))
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

	plan, planFindings, err := planBundle(manifest)
	if err != nil {
		return Preflight{}, err
	}
	findings = append(findings, planFindings...)
	expected := plan.expected
	compatible := len(planFindings) == 0
	// 从这里开始，读取预算由 manifest 自己声明：合法的大对象不会被整体上限误伤，
	// 而一个撒谎的 manifest 也不能让 Runtime 读入超出声明的字节。
	bounded.tighten(archiveEnvelope(plan.declaredPayloadBytes))

	stagedDatabase := filepath.Join(workDir, "project.sqlite")
	seen := map[string]struct{}{}
	// manifest 自身也是一个归档条目，因此计数从 1 开始。
	entries := 1
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if errors.Is(err, errBundleTooLarge) {
				return Preflight{}, fmt.Errorf("%w: the bundle is larger than its manifest declares", ErrPayloadTooLarge)
			}
			compatible = false
			findings = append(findings, Finding{Code: "archive.unreadable", Severity: "error", Message: "The archive could not be read to the end."})
			break
		}
		entries++
		if entries > maximumArchiveEntries {
			return Preflight{}, fmt.Errorf("%w: the archive contains more entries than this Runtime accepts", ErrPayloadTooLarge)
		}
		name := path.Clean(header.Name)
		declared, found := expected[name]
		if !found {
			compatible = false
			findings = append(findings, Finding{Code: "archive.unexpectedEntry", Severity: "error", Message: "The archive contains an entry the manifest does not list."})
			continue
		}
		if _, duplicate := seen[name]; duplicate {
			return Preflight{}, fmt.Errorf("%w: the archive contains %q more than once", ErrInvalidBundle, name)
		}
		seen[name] = struct{}{}
		if !regularArchiveEntry(header) || header.Size != declared.Bytes {
			compatible = false
			findings = append(findings, Finding{Code: "payload.sizeMismatch", Severity: "error", Message: "A bundle payload size does not match the byte length recorded in the manifest."})
			continue
		}
		// 只有数据库载荷需要落到 staging；object 载荷只做摘要校验。
		hasher := sha256.New()
		var sink io.Writer = hasher
		var staged *os.File
		if name == DatabaseArchivePath {
			staged, err = os.OpenFile(stagedDatabase, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return Preflight{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
			}
			sink = io.MultiWriter(hasher, staged)
		}
		written, copyErr := io.Copy(sink, reader)
		if staged != nil {
			if closeErr := staged.Close(); copyErr == nil {
				copyErr = closeErr
			}
		}
		if copyErr != nil {
			if errors.Is(copyErr, errBundleTooLarge) {
				return Preflight{}, fmt.Errorf("%w: the bundle is larger than its manifest declares", ErrPayloadTooLarge)
			}
			if truncatedBundle(copyErr) {
				// 归档在载荷结束前就断了：这是一个不可读的 bundle，而不是 Runtime 故障，
				// 因此必须给出可恢复的错误而不是 RUNTIME_NOT_READY。
				compatible = false
				findings = append(findings, Finding{Code: "archive.unreadable", Severity: "error", Message: "The archive ended before a payload was complete."})
				break
			}
			return Preflight{}, fmt.Errorf("%w: read bundle payload: %v", ErrStorage, copyErr)
		}
		if written != declared.Bytes {
			compatible = false
			findings = append(findings, Finding{Code: "payload.sizeMismatch", Severity: "error", Message: "A bundle payload size does not match the byte length recorded in the manifest."})
			continue
		}
		if hex.EncodeToString(hasher.Sum(nil)) != declared.SHA256 {
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

// regularArchiveEntry 只接受普通文件；目录、符号链接与设备节点一律拒绝。
func regularArchiveEntry(header *tar.Header) bool {
	return header.Typeflag == tar.TypeReg || header.Typeflag == tar.TypeRegA
}

// truncatedBundle 判断一个读取错误是否表示归档提前结束，而不是底层设备故障。
func truncatedBundle(err error) bool {
	return errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF)
}

// validDigest 只接受 Modelry 书写 digest 的规范形式（小写十六进制），
// 因此校验与十六进制比较使用同一套规则，不会出现「校验通过但比较失败」的分歧。
func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
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

