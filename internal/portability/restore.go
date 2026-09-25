package portability

import (
	"archive/tar"
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/liujingwen1225/modelry/internal/filestore"
)

// restoreFault 是确定性的故障注入点，仅供测试使用；生产运行时始终为 nil。
// 它在每一个会改变项目或暂存状态的步骤之前被调用，因此测试可以证明任意中途失败
// 都会完整回滚，而不是留下半恢复的项目。step 的形态是 "<phase>:<destination>"。
var restoreFault func(step string) error

// restoreRollbackFault simulates process death after one destination has been
// rolled back. Production runs keep it nil; recovery tests replay the journal.
var restoreRollbackFault func(step string) error

const (
	restorePhaseCopy            = "copy"
	restorePhasePreserve        = "preserve"
	restorePhasePreserveSync    = "preserve-sync"
	restorePhaseActivate        = "activate"
	restorePhaseActivateSync    = "activate-sync"
	restorePhaseCommitWrite     = "commit-write"
	restorePhaseCommitFlush     = "commit-flush"
	restorePhaseCommitSync      = "commit-sync"
	restorePhaseCommitRename    = "commit-rename"
	restorePhaseCommitDirectory = "commit-directory-sync"
)

// ApplyOptions 控制一次 restore apply。
type ApplyOptions struct {
	// Force 允许覆盖一个已经包含项目的目录。
	Force bool
	// ObjectsDir 是目标本地对象目录。
	ObjectsDir string
	// DatabasePath 是目标数据库路径。
	DatabasePath string
}

// Apply 在 preflight 通过后原子地替换一个已停止项目的状态。
// 它先在一个 managed staging 目录里完成解压、摘要校验与数据库校验，然后才用一个
// 带 journal 的三阶段激活替换数据库与 object store：任何一步失败都会把原项目
// 完整回滚，包括字节级的原数据库与原 object store。
func (service *Service) Apply(ctx context.Context, archivePath string, options ApplyOptions) (Preflight, error) {
	if options.DatabasePath == "" || options.ObjectsDir == "" {
		return Preflight{}, fmt.Errorf("%w: database path and object directory are required", ErrInvalidArgument)
	}
	// 上一次崩溃可能留下一个未完成的激活；先把项目恢复原状，再判断它是否为空，
	// 否则一个残留的 journal 会让 --force 这道安全门被绕过。
	if err := rollbackInterruptedRestore(service.managed); err != nil {
		return Preflight{}, fmt.Errorf("%w: recover an interrupted restore: %v", ErrStorage, err)
	}
	removeStaleWorkspaces(service.managed)

	preflight, err := service.Preflight(ctx, archivePath)
	if err != nil {
		return Preflight{}, err
	}
	if !preflight.Compatible {
		return preflight, ErrIncompatibleBundle
	}
	if !options.Force {
		if _, err := os.Stat(options.DatabasePath); err == nil {
			return preflight, ErrProjectNotEmpty
		}
	}
	workDir, err := os.MkdirTemp(service.managed, restoreWorkPrefix)
	if err != nil {
		return preflight, fmt.Errorf("%w: prepare restore workspace: %v", ErrStorage, err)
	}
	defer os.RemoveAll(workDir)

	staged, err := stageBundle(ctx, archivePath, workDir)
	if err != nil {
		return preflight, err
	}
	if err := validateSnapshotDatabase(ctx, staged.databasePath, service.sqliteVersion()); err != nil {
		return preflight, fmt.Errorf("%w: %v", ErrIncompatibleBundle, err)
	}
	plan, err := buildActivationPlan(service.managed, options.DatabasePath, options.ObjectsDir, staged)
	if err != nil {
		return preflight, err
	}
	if err := plan.run(); err != nil {
		return preflight, err
	}
	return preflight, nil
}

// bundlePlan 是一个已按 manifest 严格校验过的归档预算。
// Preflight 与 Apply 共用它，因此两遍校验永远不会出现分歧。
type bundlePlan struct {
	manifest             Manifest
	expected             map[string]ObjectEntry
	declaredPayloadBytes int64
}

// planBundle 校验 manifest 自身并建立条目预算。
// 返回的 findings 是软性不兼容；返回的 error 是结构性非法或超出边界。
func planBundle(manifest Manifest) (bundlePlan, []Finding, error) {
	// 先按数量拒绝，再为条目分配任何内存：一个 64 MiB 的 manifest 可以列出上百万条
	// 极小的对象项，预分配必须发生在数量校验之后。
	if len(manifest.Objects) > maximumBundleObjects {
		return bundlePlan{}, nil, fmt.Errorf("%w: the manifest lists %d file objects; a bundle is limited to %d", ErrPayloadTooLarge, len(manifest.Objects), maximumBundleObjects)
	}
	plan := bundlePlan{
		manifest: manifest,
		expected: make(map[string]ObjectEntry, len(manifest.Objects)+1),
	}
	findings := make([]Finding, 0, 4)
	invalid := func(code, message string) {
		findings = append(findings, Finding{Code: code, Severity: "error", Message: message})
	}
	if manifest.Format != FormatName {
		invalid("format.unsupported", "This archive is not a Modelry Community backup bundle.")
	}
	if manifest.FormatVersion != FormatVersion {
		invalid("format.versionUnsupported", databaseCompatibilityMsg)
	}
	database := manifest.Database
	if database.Path != DatabaseArchivePath || database.SHA256 == "" || database.Bytes <= 0 {
		invalid("database.missing", "The manifest does not describe a database payload.")
	} else if !validDigest(database.SHA256) {
		invalid("database.invalidDigest", "The manifest describes a database payload with an invalid digest.")
	}
	if database.Bytes > maximumDatabasePayloadBytes {
		return bundlePlan{}, nil, fmt.Errorf("%w: the database payload is larger than this Runtime accepts", ErrPayloadTooLarge)
	}
	plan.declaredPayloadBytes = database.Bytes
	plan.expected[DatabaseArchivePath] = ObjectEntry{Key: DatabaseArchivePath, Bytes: database.Bytes, SHA256: database.SHA256}
	for _, entry := range manifest.Objects {
		switch {
		case !filestore.ValidObjectKey(entry.Key):
			invalid("object.invalidKey", "The manifest lists an invalid object key.")
			continue
		case !validDigest(entry.SHA256):
			invalid("object.invalidDigest", "The manifest lists an invalid object digest.")
			continue
		// 零字节 File object 是合法的（产品允许空文件），因此这里只拒绝负长度。
		case entry.Bytes < 0 || entry.Bytes > maximumObjectPayloadBytes:
			invalid("object.invalidSize", "The manifest lists a file object size this Runtime does not accept.")
			continue
		}
		name := ObjectsArchivePrefix + entry.Key
		if _, duplicate := plan.expected[name]; duplicate {
			return bundlePlan{}, nil, fmt.Errorf("%w: the manifest lists file object %q more than once", ErrInvalidBundle, entry.Key)
		}
		plan.expected[name] = entry
		plan.declaredPayloadBytes += entry.Bytes
	}
	if plan.declaredPayloadBytes > maximumRestoreBytes {
		return bundlePlan{}, nil, fmt.Errorf("%w: the bundle declares more payload than this Runtime accepts", ErrPayloadTooLarge)
	}
	return plan, findings, nil
}

// stagedBundle 是一次 restore 在 managed staging 目录里准备好的新项目状态。
type stagedBundle struct {
	databasePath  string
	objectsDir    string
	databaseEntry ObjectEntry
	objectKeys    []string
	objectEntries []ObjectEntry
}

// stageBundle 解压一个 Backup Bundle 到 staging 目录，并对每个载荷重新校验
// manifest 声明的字节长度与摘要。它绝不触碰目标项目。
func stageBundle(ctx context.Context, archivePath, workDir string) (stagedBundle, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return stagedBundle{}, fmt.Errorf("%w: open bundle: %v", ErrInvalidBundle, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return stagedBundle{}, fmt.Errorf("%w: read bundle: %v", ErrInvalidBundle, err)
	}
	if info.Size() > archiveEnvelope(maximumRestoreBytes) {
		return stagedBundle{}, fmt.Errorf("%w: the bundle is larger than this Runtime accepts", ErrPayloadTooLarge)
	}
	bounded := &boundedReader{reader: file, limit: archiveEnvelope(maximumRestoreBytes)}
	reader := tar.NewReader(bounded)

	header, err := reader.Next()
	if err != nil || path.Clean(header.Name) != ManifestPath {
		return stagedBundle{}, fmt.Errorf("%w: the bundle must start with %s", ErrInvalidBundle, ManifestPath)
	}
	if !regularArchiveEntry(header) || header.Size > maximumManifestBytes {
		return stagedBundle{}, fmt.Errorf("%w: %s must be a regular file of at most %d bytes", ErrInvalidBundle, ManifestPath, int64(maximumManifestBytes))
	}
	manifestBytes, err := io.ReadAll(io.LimitReader(reader, maximumManifestBytes+1))
	if err != nil || int64(len(manifestBytes)) > maximumManifestBytes {
		return stagedBundle{}, fmt.Errorf("%w: manifest is not readable", ErrInvalidBundle)
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return stagedBundle{}, fmt.Errorf("%w: manifest is not readable", ErrInvalidBundle)
	}
	plan, findings, err := planBundle(manifest)
	if err != nil {
		return stagedBundle{}, err
	}
	for _, finding := range findings {
		if finding.Severity == "error" {
			// Apply 只在 preflight 已经通过后运行；这里再次失败说明归档在两次读取之间
			// 被替换了，因此必须拒绝而不是继续。
			return stagedBundle{}, fmt.Errorf("%w: the bundle changed between preflight and apply", ErrIncompatibleBundle)
		}
	}
	bounded.tighten(archiveEnvelope(plan.declaredPayloadBytes))

	staged := stagedBundle{
		databasePath:  filepath.Join(workDir, "project.sqlite"),
		objectsDir:    filepath.Join(workDir, "objects"),
		databaseEntry: ObjectEntry{Key: DatabaseArchivePath, Bytes: plan.manifest.Database.Bytes, SHA256: plan.manifest.Database.SHA256},
	}
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
				return stagedBundle{}, fmt.Errorf("%w: the bundle is larger than its manifest declares", ErrPayloadTooLarge)
			}
			return stagedBundle{}, fmt.Errorf("%w: read bundle: %v", ErrInvalidBundle, err)
		}
		entries++
		if entries > maximumArchiveEntries {
			return stagedBundle{}, fmt.Errorf("%w: the archive contains more entries than this Runtime accepts", ErrPayloadTooLarge)
		}
		name := path.Clean(header.Name)
		declared, found := plan.expected[name]
		if !found {
			return stagedBundle{}, fmt.Errorf("%w: the archive contains an entry the manifest does not list", ErrInvalidBundle)
		}
		if _, duplicate := seen[name]; duplicate {
			return stagedBundle{}, fmt.Errorf("%w: the archive contains %q more than once", ErrInvalidBundle, name)
		}
		seen[name] = struct{}{}
		if !regularArchiveEntry(header) || header.Size != declared.Bytes {
			return stagedBundle{}, fmt.Errorf("%w: a bundle payload does not match the byte length recorded in the manifest", ErrIncompatibleBundle)
		}
		destination := staged.databasePath
		if name != DatabaseArchivePath {
			key := strings.TrimPrefix(name, ObjectsArchivePrefix)
			staged.objectKeys = append(staged.objectKeys, key)
			staged.objectEntries = append(staged.objectEntries, declared)
			destination = filepath.Join(staged.objectsDir, key)
			if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
				return stagedBundle{}, fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
			}
		}
		if err := writeVerifiedPayload(reader, destination, declared); err != nil {
			return stagedBundle{}, err
		}
	}
	for name := range plan.expected {
		if _, found := seen[name]; found {
			continue
		}
		return stagedBundle{}, fmt.Errorf("%w: the manifest lists a payload that the archive does not contain", ErrInvalidBundle)
	}
	if err := ctx.Err(); err != nil {
		return stagedBundle{}, err
	}
	return staged, nil
}

func writeVerifiedPayload(source io.Reader, destination string, declared ObjectEntry) error {
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, err)
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), source)
	if syncErr := file.Sync(); copyErr == nil {
		copyErr = syncErr
	}
	if closeErr := file.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		if errors.Is(copyErr, errBundleTooLarge) {
			return fmt.Errorf("%w: the bundle is larger than its manifest declares", ErrPayloadTooLarge)
		}
		if truncatedBundle(copyErr) {
			// 归档提前结束：bundle 本身不可读，而不是 Runtime 故障。
			return fmt.Errorf("%w: the archive ended before a payload was complete", ErrInvalidBundle)
		}
		return fmt.Errorf("%w: stage bundle payload: %v", ErrStorage, copyErr)
	}
	if written != declared.Bytes || hex.EncodeToString(hasher.Sum(nil)) != declared.SHA256 {
		return fmt.Errorf("%w: a bundle payload does not match the manifest", ErrIncompatibleBundle)
	}
	return nil
}

// activationKind 区分「替换一个文件」与「移除一个文件（例如旧数据库的 WAL 边车）」。
type activationKind string

const (
	activationReplace activationKind = "replace"
	activationRemove  activationKind = "remove"
)

// activationEntry 描述一个目标路径的新内容与它的原内容备份位置。
type activationEntry struct {
	kind        activationKind
	staged      string
	destination string
	backup      string
	tmp         string
	expected    ObjectEntry
}

// activationPlan 是一次 restore 的三阶段激活计划。
type activationPlan struct {
	journalPath string
	commitPath  string
	transaction string
	journal     *os.File
	entries     []activationEntry
}

func buildActivationPlan(managedDir, databasePath, objectsDir string, staged stagedBundle) (*activationPlan, error) {
	nonce, err := restoreNonce()
	if err != nil {
		return nil, fmt.Errorf("%w: prepare restore activation: %v", ErrStorage, err)
	}
	entries := make([]activationEntry, 0, len(staged.objectKeys)+3)
	entries = append(entries, activationEntry{
		kind: activationReplace, staged: staged.databasePath, destination: databasePath,
		backup: databasePath + "." + nonce + ".old", tmp: databasePath + "." + nonce + ".new", expected: staged.databaseEntry,
	})
	// 旧数据库的 WAL 边车必须随主文件一起消失：把新数据库留在旧 WAL 旁边会让下一次
	// 启动把它当作本库的日志回放，从而得到新旧混合的数据。
	for _, sidecar := range []string{databasePath + "-wal", databasePath + "-shm"} {
		entries = append(entries, activationEntry{
			kind: activationRemove, destination: sidecar, backup: sidecar + "." + nonce + ".old",
		})
	}
	for index, key := range staged.objectKeys {
		destination := filepath.Join(objectsDir, key)
		entries = append(entries, activationEntry{
			kind: activationReplace, staged: filepath.Join(staged.objectsDir, key), destination: destination,
			backup: destination + "." + nonce + ".old", tmp: destination + "." + nonce + ".new", expected: staged.objectEntries[index],
		})
	}
	return &activationPlan{
		journalPath: filepath.Join(managedDir, RestoreJournalName),
		commitPath:  filepath.Join(managedDir, RestoreCommitName),
		transaction: nonce,
		entries:     entries,
	}, nil
}

func restoreNonce() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return "restore-" + hex.EncodeToString(value[:]), nil
}

// journalRecord 是 restore journal 的一行。它采用 write-ahead 顺序：先记录意图，
// 再执行动作，因此回滚可以精确区分「已经动过」与「还没动过」。
type journalRecord struct {
	Op     string `json:"op"`
	ID     string `json:"id,omitempty"`
	Dest   string `json:"dest,omitempty"`
	Path   string `json:"path,omitempty"`
	Exists bool   `json:"exists,omitempty"`
	Bytes  int64  `json:"bytes,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

const (
	journalStage    = "stage"
	journalMkdir    = "mkdir"
	journalBackup   = "backup"
	journalAbsent   = "absent"
	journalActivate = "activate"
	journalBegin    = "begin"
	journalTarget   = "target"
	journalDone     = "done"
)

var errLegacyCommitAmbiguous = errors.New("legacy restore journal has no durable commit marker")

// LegacyRestoreResolution is an explicit operator choice for a pre-marker restore journal
// whose visible journalDone line cannot prove whether the old file Sync succeeded.
type LegacyRestoreResolution string

const (
	LegacyRestoreAcceptCurrent LegacyRestoreResolution = "accept-current"
)

type commitDestination struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	Bytes  int64  `json:"bytes,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

type durableCommitMarker struct {
	Version       int                 `json:"version"`
	Transaction   string              `json:"transaction"`
	JournalSHA256 string              `json:"journalSha256"`
	Destinations  []commitDestination `json:"destinations"`
}

// run 执行三阶段激活：先准备全部新内容，再统一把原内容移开，最后统一激活。
// 三个阶段严格分开，因此「原内容被移开」的窗口只包含 rename，不包含任何大块复制。
func (plan *activationPlan) run() error {
	journal, err := os.OpenFile(plan.journalPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("%w: create the restore journal: %v", ErrStorage, err)
	}
	plan.journal = journal
	writer := bufio.NewWriter(journal)
	if err := plan.record(writer, journalRecord{Op: journalBegin, ID: plan.transaction}); err != nil {
		return plan.fail(err)
	}
	if err := syncDirectory(filepath.Dir(plan.journalPath)); err != nil {
		return plan.fail(fmt.Errorf("%w: persist the restore journal entry: %v", ErrStorage, err))
	}
	for index := range plan.entries {
		entry := &plan.entries[index]
		expected := entry.kind == activationReplace
		record := journalRecord{Op: journalTarget, ID: plan.transaction, Dest: entry.destination, Exists: expected}
		if expected {
			record.Bytes, record.SHA256 = entry.expected.Bytes, entry.expected.SHA256
		}
		if err := plan.record(writer, record); err != nil {
			return plan.fail(err)
		}
	}

	// 阶段一：把新内容准备到目标目录旁边。此时原项目完全没有被触碰。
	for index := range plan.entries {
		entry := &plan.entries[index]
		if entry.kind != activationReplace {
			continue
		}
		if err := plan.fault(restorePhaseCopy, entry); err != nil {
			return plan.fail(err)
		}
		if err := plan.record(writer, journalRecord{Op: journalStage, Dest: entry.destination, Path: entry.tmp}); err != nil {
			return plan.fail(err)
		}
		if err := plan.prepareDirectory(writer, filepath.Dir(entry.destination)); err != nil {
			return plan.fail(err)
		}
		if err := copyFile(entry.staged, entry.tmp); err != nil {
			return plan.fail(err)
		}
	}
	// 阶段二：把原内容移到同目录的备份位置。窗口只包含 rename。
	for index := range plan.entries {
		entry := &plan.entries[index]
		existed, err := pathExists(entry.destination)
		if err != nil {
			return plan.fail(fmt.Errorf("%w: inspect the restore destination: %v", ErrStorage, err))
		}
		if !existed {
			if err := plan.record(writer, journalRecord{Op: journalAbsent, Dest: entry.destination}); err != nil {
				return plan.fail(err)
			}
			continue
		}
		if err := plan.fault(restorePhasePreserve, entry); err != nil {
			return plan.fail(err)
		}
		if err := plan.record(writer, journalRecord{Op: journalBackup, Dest: entry.destination, Path: entry.backup}); err != nil {
			return plan.fail(err)
		}
		if err := os.Rename(entry.destination, entry.backup); err != nil {
			return plan.fail(fmt.Errorf("%w: preserve the existing project state: %v", ErrStorage, err))
		}
		if err := plan.fault(restorePhasePreserveSync, entry); err != nil {
			return plan.fail(err)
		}
		if err := syncDirectory(filepath.Dir(entry.destination)); err != nil {
			return plan.fail(fmt.Errorf("%w: persist preserved project state: %v", ErrStorage, err))
		}
	}

	// 阶段三：激活。每一步都有 write-ahead 记录，因此中途失败可以精确回滚。
	for index := range plan.entries {
		entry := &plan.entries[index]
		if entry.kind != activationReplace {
			continue
		}
		if err := plan.fault(restorePhaseActivate, entry); err != nil {
			return plan.fail(err)
		}
		if err := plan.record(writer, journalRecord{Op: journalActivate, Dest: entry.destination, Path: entry.tmp}); err != nil {
			return plan.fail(err)
		}
		if err := os.Rename(entry.tmp, entry.destination); err != nil {
			return plan.fail(fmt.Errorf("%w: activate the restored payload: %v", ErrStorage, err))
		}
		if err := plan.fault(restorePhaseActivateSync, entry); err != nil {
			return plan.fail(err)
		}
		if err := syncDirectory(filepath.Dir(entry.destination)); err != nil {
			return plan.fail(fmt.Errorf("%w: persist activated project state: %v", ErrStorage, err))
		}
	}

	// 阶段四：关闭并再次同步完整 journal，再原子安装独立 commit marker。
	// marker 的 rename + managed directory fsync 是唯一 commit point。
	if err := writer.Flush(); err != nil {
		return plan.fail(fmt.Errorf("%w: flush the restore journal before commit: %v", ErrStorage, err))
	}
	if err := journal.Sync(); err != nil {
		return plan.fail(fmt.Errorf("%w: sync the restore journal before commit: %v", ErrStorage, err))
	}
	if err := journal.Close(); err != nil {
		plan.journal = nil
		return plan.fail(fmt.Errorf("%w: close the restore journal before commit: %v", ErrStorage, err))
	}
	plan.journal = nil
	if err := plan.installCommitMarker(); err != nil {
		return plan.fail(err)
	}
	// Durable commit point 已经越过。清理失败不改变成功结果；journal 和 marker 会留给
	// 下次启动只做 cleanup，绝不会回滚已提交的新项目。
	_ = cleanupCommittedRestore(plan.journalPath, plan.commitPath)
	return nil
}

func (plan *activationPlan) fault(phase string, entry *activationEntry) error {
	return injectRestoreFault(phase + ":" + entry.destination)
}

func injectRestoreFault(step string) error {
	if restoreFault == nil {
		return nil
	}
	return restoreFault(step)
}

func (plan *activationPlan) installCommitMarker() error {
	journalBytes, err := os.ReadFile(plan.journalPath)
	if err != nil {
		return fmt.Errorf("%w: read the complete restore journal before commit: %v", ErrStorage, err)
	}
	marker := durableCommitMarker{
		Version: 1, Transaction: plan.transaction,
		JournalSHA256: digestBytes(journalBytes),
		Destinations:  make([]commitDestination, 0, len(plan.entries)),
	}
	for _, entry := range plan.entries {
		state := commitDestination{Path: entry.destination, Exists: entry.kind == activationReplace}
		if state.Exists {
			state.Bytes, state.SHA256 = entry.expected.Bytes, entry.expected.SHA256
		}
		marker.Destinations = append(marker.Destinations, state)
	}
	encoded, err := json.Marshal(marker)
	if err != nil {
		return fmt.Errorf("%w: encode the restore commit marker: %v", ErrStorage, err)
	}
	temporary := plan.commitPath + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("%w: create the restore commit marker: %v", ErrStorage, err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()
	writer := bufio.NewWriter(file)
	if err := injectRestoreFault(restorePhaseCommitWrite + ":" + plan.commitPath); err != nil {
		return err
	}
	if n, err := writer.Write(encoded); err != nil || n != len(encoded) {
		if err == nil {
			err = io.ErrShortWrite
		}
		return fmt.Errorf("%w: write the restore commit marker: %v", ErrStorage, err)
	}
	if err := injectRestoreFault(restorePhaseCommitFlush + ":" + plan.commitPath); err != nil {
		return err
	}
	if err := writer.Flush(); err != nil {
		return fmt.Errorf("%w: flush the restore commit marker: %v", ErrStorage, err)
	}
	if err := injectRestoreFault(restorePhaseCommitSync + ":" + plan.commitPath); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("%w: sync the restore commit marker: %v", ErrStorage, err)
	}
	if err := file.Close(); err != nil {
		closed = true
		return fmt.Errorf("%w: close the restore commit marker: %v", ErrStorage, err)
	}
	closed = true
	if err := injectRestoreFault(restorePhaseCommitRename + ":" + plan.commitPath); err != nil {
		return err
	}
	if err := os.Rename(temporary, plan.commitPath); err != nil {
		return fmt.Errorf("%w: install the restore commit marker: %v", ErrStorage, err)
	}
	if err := injectRestoreFault(restorePhaseCommitDirectory + ":" + plan.commitPath); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(plan.commitPath)); err != nil {
		return fmt.Errorf("%w: persist the restore commit marker: %v", ErrStorage, err)
	}
	return nil
}

// prepareDirectory 先把要创建的目录写进 journal，再真正创建它们。
func (plan *activationPlan) prepareDirectory(writer *bufio.Writer, directory string) error {
	missing, err := missingDirectories(directory)
	if err != nil {
		return fmt.Errorf("%w: inspect the restore destination: %v", ErrStorage, err)
	}
	for _, path := range missing {
		if err := plan.record(writer, journalRecord{Op: journalMkdir, Path: path}); err != nil {
			return err
		}
		if err := os.Mkdir(path, 0o700); err != nil {
			return fmt.Errorf("%w: prepare the restore destination: %v", ErrStorage, err)
		}
		if err := syncDirectory(filepath.Dir(path)); err != nil {
			return fmt.Errorf("%w: persist the restore destination directory: %v", ErrStorage, err)
		}
	}
	return nil
}

func (plan *activationPlan) record(writer *bufio.Writer, record journalRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("%w: encode the restore journal: %v", ErrStorage, err)
	}
	if _, err := writer.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("%w: write the restore journal: %v", ErrStorage, err)
	}
	if err := writer.Flush(); err != nil {
		return fmt.Errorf("%w: flush the restore journal: %v", ErrStorage, err)
	}
	// 每条意图必须在自己描述的动作之前耐久落盘，崩溃恢复才可能精确。
	if plan.journal != nil {
		if err := plan.journal.Sync(); err != nil {
			return fmt.Errorf("%w: sync the restore journal: %v", ErrStorage, err)
		}
	}
	return nil
}

// fail 回滚已经发生的每一步，然后返回原始错误。
func (plan *activationPlan) fail(cause error) error {
	if plan.journal != nil {
		if err := plan.journal.Close(); err != nil {
			cause = errors.Join(cause, fmt.Errorf("close restore journal: %w", err))
		}
		plan.journal = nil
	}
	if err := rollbackJournal(plan.journalPath); err != nil {
		return errors.Join(cause, err)
	}
	if err := cleanupUncommittedRestore(plan.journalPath, plan.commitPath); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func cleanupUncommittedRestore(journalPath, commitPath string) error {
	if err := removePath(commitPath + ".tmp"); err != nil {
		return fmt.Errorf("%w: remove an incomplete commit marker: %v", ErrStorage, err)
	}
	if err := removePath(commitPath); err != nil {
		return fmt.Errorf("%w: remove an uncommitted marker: %v", ErrStorage, err)
	}
	if err := syncDirectory(filepath.Dir(journalPath)); err != nil {
		return fmt.Errorf("%w: persist removal of an uncommitted marker: %v", ErrStorage, err)
	}
	if err := removePath(journalPath); err != nil {
		return fmt.Errorf("%w: remove the rolled back restore journal: %v", ErrStorage, err)
	}
	if err := syncDirectory(filepath.Dir(journalPath)); err != nil {
		return fmt.Errorf("%w: persist removal of the restore journal: %v", ErrStorage, err)
	}
	return nil
}

// CheckInterruptedRestore 在项目被打开之前收敛一次未完成的 restore。
//
// Runtime 与 CLI 都调用它：一个半恢复的项目必须由 modelry restore 收敛，而不是被当成
// 空项目打开。一个已经提交、只是没来得及清理的 journal 会就地收敛，因此它不会让项目
// 无法启动。
func CheckInterruptedRestore(managedDir string) error {
	journalPath := filepath.Join(managedDir, RestoreJournalName)
	if _, err := os.Stat(journalPath); errors.Is(err, os.ErrNotExist) {
		return cleanupOrphanCommitMarker(filepath.Join(managedDir, RestoreCommitName))
	} else if err != nil {
		return err
	}
	committed, err := journalCommitted(journalPath)
	if err != nil {
		return err
	}
	if committed {
		return cleanupCommittedRestore(journalPath, filepath.Join(managedDir, RestoreCommitName))
	}
	return fmt.Errorf("project %q is in the middle of an interrupted restore; run modelry restore --from <bundle> again to finish or roll it back before starting the Runtime", managedDir)
}

// journalCommitted 报告 durable commit marker 是否对应一个完整 journal 和当前新状态。
func journalCommitted(journalPath string) (bool, error) {
	journalBytes, err := os.ReadFile(journalPath)
	if err != nil {
		return false, fmt.Errorf("%w: read the restore journal: %v", ErrStorage, err)
	}
	records, complete := parseCompleteJournal(journalBytes)
	if !complete {
		return false, nil
	}
	commitPath := filepath.Join(filepath.Dir(journalPath), RestoreCommitName)
	markerBytes, err := os.ReadFile(commitPath)
	if errors.Is(err, os.ErrNotExist) {
		if hasJournalDone(records) {
			return false, fmt.Errorf("%w: refusing to infer a commit from a readable legacy done record", errLegacyCommitAmbiguous)
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("%w: read the restore commit marker: %v", ErrStorage, err)
	}
	var marker durableCommitMarker
	if err := json.Unmarshal(markerBytes, &marker); err != nil || marker.Version != 1 || marker.Transaction == "" {
		if hasJournalDone(records) {
			return false, fmt.Errorf("%w: legacy done record is not backed by a valid commit marker", errLegacyCommitAmbiguous)
		}
		return false, nil
	}
	if marker.JournalSHA256 != digestBytes(journalBytes) {
		if hasJournalDone(records) {
			return false, fmt.Errorf("%w: legacy done record is not backed by a matching commit marker", errLegacyCommitAmbiguous)
		}
		return false, nil
	}
	targets := make(map[string]commitDestination)
	transaction := ""
	for _, record := range records {
		switch record.Op {
		case journalBegin:
			if transaction != "" || record.ID == "" {
				return false, nil
			}
			transaction = record.ID
		case journalTarget:
			if record.ID == "" || record.Dest == "" {
				return false, nil
			}
			if _, duplicate := targets[record.Dest]; duplicate {
				return false, nil
			}
			targets[record.Dest] = commitDestination{Path: record.Dest, Exists: record.Exists, Bytes: record.Bytes, SHA256: record.SHA256}
		}
	}
	if transaction == "" || transaction != marker.Transaction || len(targets) == 0 || len(targets) != len(marker.Destinations) {
		return false, nil
	}
	for _, destination := range marker.Destinations {
		target, found := targets[destination.Path]
		if !found || target != destination {
			return false, nil
		}
		if err := verifyCommitDestination(destination); err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, errCommitStateMismatch) {
				return false, nil
			}
			return false, fmt.Errorf("%w: verify the restore commit state: %v", ErrStorage, err)
		}
	}
	return true, nil
}

var errCommitStateMismatch = errors.New("restore destination differs from committed state")

func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func parseCompleteJournal(contents []byte) ([]journalRecord, bool) {
	if len(contents) == 0 || contents[len(contents)-1] != '\n' {
		return nil, false
	}
	lines := strings.Split(string(contents), "\n")
	records := make([]journalRecord, 0, len(lines)-1)
	for _, line := range lines[:len(lines)-1] {
		if strings.TrimSpace(line) == "" {
			return nil, false
		}
		var record journalRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil || record.Op == "" {
			return nil, false
		}
		records = append(records, record)
	}
	return records, true
}

func hasJournalDone(records []journalRecord) bool {
	for _, record := range records {
		if record.Op == journalDone {
			return true
		}
	}
	return false
}

// ResolveLegacyRestore recovers a journal written before durable commit markers existed.
// Those journals cannot be classified safely from their bytes alone, so callers must
// explicitly choose to accept the currently activated destinations.
func ResolveLegacyRestore(managedDir string, resolution LegacyRestoreResolution) error {
	if resolution != LegacyRestoreAcceptCurrent {
		return fmt.Errorf("%w: legacy restore resolution must be %q", ErrInvalidArgument, LegacyRestoreAcceptCurrent)
	}
	journalPath := filepath.Join(managedDir, RestoreJournalName)
	committed, err := journalCommitted(journalPath)
	if err == nil {
		if committed {
			return fmt.Errorf("%w: the restore journal already has a valid durable commit marker", ErrInvalidArgument)
		}
		return fmt.Errorf("%w: the restore journal is not an ambiguous legacy journal", ErrInvalidArgument)
	}
	if !errors.Is(err, errLegacyCommitAmbiguous) {
		return err
	}
	// The old format has no old-state hashes or durable commit marker. An explicit operator
	// choice can accept the currently active destinations; guessing rollback could produce a
	// hybrid state if the old cleanup already removed only some backups.
	return cleanupCommittedRestore(journalPath, filepath.Join(managedDir, RestoreCommitName))
}

func verifyCommitDestination(destination commitDestination) error {
	info, err := os.Lstat(destination.Path)
	if !destination.Exists {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		return errCommitStateMismatch
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != destination.Bytes || !validDigest(destination.SHA256) {
		return errCommitStateMismatch
	}
	file, err := os.Open(destination.Path)
	if err != nil {
		return err
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(hasher, file)
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	if hex.EncodeToString(hasher.Sum(nil)) != destination.SHA256 {
		return errCommitStateMismatch
	}
	return nil
}

// rollbackInterruptedRestore 回滚上一次崩溃留下的激活。没有 journal 时它是空操作。
func rollbackInterruptedRestore(managedDir string) error {
	journalPath := filepath.Join(managedDir, RestoreJournalName)
	if _, err := os.Stat(journalPath); errors.Is(err, os.ErrNotExist) {
		return cleanupOrphanCommitMarker(filepath.Join(managedDir, RestoreCommitName))
	} else if err != nil {
		return err
	}
	commitPath := filepath.Join(managedDir, RestoreCommitName)
	committed, err := journalCommitted(journalPath)
	if err != nil {
		return err
	}
	if committed {
		return cleanupCommittedRestore(journalPath, commitPath)
	}
	if err := rollbackJournal(journalPath); err != nil {
		return err
	}
	return cleanupUncommittedRestore(journalPath, commitPath)
}

func cleanupOrphanCommitMarker(commitPath string) error {
	temporaryRemoved, err := removeIfExists(commitPath + ".tmp")
	if err != nil {
		return err
	}
	markerRemoved, err := removeIfExists(commitPath)
	if err != nil {
		return err
	}
	if !temporaryRemoved && !markerRemoved {
		return nil
	}
	return syncDirectory(filepath.Dir(commitPath))
}

func cleanupCommittedRestore(journalPath, commitPath string) error {
	contents, err := os.ReadFile(journalPath)
	if err != nil {
		return fmt.Errorf("%w: read committed restore journal: %v", ErrStorage, err)
	}
	records, complete := parseCompleteJournal(contents)
	if !complete {
		return fmt.Errorf("%w: committed restore journal is incomplete", ErrStorage)
	}
	backups := make([]string, 0, 8)
	staged := make([]string, 0, 8)
	for _, record := range records {
		switch record.Op {
		case journalBackup:
			backups = append(backups, record.Path)
		case journalStage:
			staged = append(staged, record.Path)
		}
	}
	for _, name := range append(backups, staged...) {
		removed, err := removeIfExists(name)
		if err != nil {
			return fmt.Errorf("%w: clean committed restore files: %v", ErrStorage, err)
		}
		if removed {
			if err := syncDirectory(filepath.Dir(name)); err != nil {
				return fmt.Errorf("%w: persist committed restore cleanup: %v", ErrStorage, err)
			}
		}
	}
	// 删除顺序确保 marker 仍在时 journal 要么仍在（可继续 cleanup），要么已 durable 删除。
	if removed, err := removeIfExists(journalPath); err != nil {
		return fmt.Errorf("%w: remove committed restore journal: %v", ErrStorage, err)
	} else if removed {
		if err := syncDirectory(filepath.Dir(journalPath)); err != nil {
			return fmt.Errorf("%w: persist committed journal removal: %v", ErrStorage, err)
		}
	}
	if err := cleanupOrphanCommitMarker(commitPath); err != nil {
		return fmt.Errorf("%w: remove committed restore marker: %v", ErrStorage, err)
	}
	return nil
}

// destinationState 是 journal 重放出的单个目标的状态。
type destinationState struct {
	backup    string
	hasBackup bool
	activated bool
	staged    string
}

// rollbackJournal 依据 journal 把每个目标恢复到激活之前的状态。
//
// 判定规则完全由 write-ahead 顺序决定，而不是由「记录过什么」猜测：
//   - 备份文件确实存在 → 原件已被移开，目标位置只可能是我们写的或不存在；
//     撤掉目标再把备份放回去。
//   - 备份文件不存在 → 移开这件事从未发生，目标位置仍然是原件，必须原样保留。
//   - 没有备份记录但记录过 activate → 原件本来就不存在，撤掉我们创建的内容即可。
func rollbackJournal(journalPath string) error {
	file, err := os.Open(journalPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("%w: read the restore journal: %v", ErrStorage, err)
	}
	defer file.Close()

	states := map[string]*destinationState{}
	order := make([]string, 0, 8)
	backups := make([]string, 0, 8)
	directories := make([]string, 0, 4)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record journalRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			// journal 只由本进程顺序追加，因此残缺的行只可能是最后一行（写入被中断）。
			// 那一行描述的动作用 write-ahead 语义保证还没有发生，忽略它即可——
			// 绝不能因为一行残缺而放弃整次回滚。
			break
		}
		switch record.Op {
		case journalStage:
			states[record.Dest] = &destinationState{staged: record.Path}
			order = append(order, record.Dest)
		case journalMkdir:
			directories = append(directories, record.Path)
		case journalBackup:
			if _, known := states[record.Dest]; !known {
				states[record.Dest] = &destinationState{}
				order = append(order, record.Dest)
			}
			states[record.Dest].backup, states[record.Dest].hasBackup = record.Path, true
			backups = append(backups, record.Path)
		case journalAbsent:
			if _, known := states[record.Dest]; !known {
				states[record.Dest] = &destinationState{}
				order = append(order, record.Dest)
			}
		case journalActivate:
			if state := states[record.Dest]; state != nil {
				state.activated = true
			}
		case journalBegin, journalTarget:
			// Transaction metadata does not change rollback state.
		}
	}
	// scanner.Err() 只可能来自超长行：同样当作 journal 在此处结束。
	var failures []error
	for _, destination := range order {
		state := states[destination]
		preserved, err := pathExists(state.backup)
		if state.hasBackup && err != nil {
			failures = append(failures, err)
		}
		switch {
		case state.hasBackup && preserved:
			// 原件确实被移开了；目标位置此刻只可能是我们的新内容或不存在。
			if removed, err := removeIfExists(destination); err != nil {
				failures = append(failures, err)
			} else if removed {
				if err := syncDirectory(filepath.Dir(destination)); err != nil {
					failures = append(failures, err)
				}
			}
			if err := os.Rename(state.backup, destination); err != nil {
				failures = append(failures, err)
			} else if err := syncDirectory(filepath.Dir(destination)); err != nil {
				failures = append(failures, err)
			}
		case state.hasBackup:
			// 备份文件不存在：要么「移开原件」从未发生（目标是原件），要么上一次回滚
			// 已经把原件放了回去（目标还是原件）。两种情况下目标都是原件，绝不能删除。
			// 这里也绝不报错：回滚必须幂等，否则一次只完成一半的回滚会让 journal 永远
			// 无法被消费，项目将再也无法启动，也无法再次 restore。
		case state.activated:
			// 目标原本不存在；撤掉我们创建的内容即可。
			if removed, err := removeIfExists(destination); err != nil {
				failures = append(failures, err)
			} else if removed {
				if err := syncDirectory(filepath.Dir(destination)); err != nil {
					failures = append(failures, err)
				}
			}
		}
		if state.staged != "" {
			if removed, err := removeIfExists(state.staged); err != nil {
				failures = append(failures, err)
			} else if removed {
				if err := syncDirectory(filepath.Dir(state.staged)); err != nil {
					failures = append(failures, err)
				}
			}
		}
		if restoreRollbackFault != nil {
			if err := restoreRollbackFault("rollback-after-target:" + destination); err != nil {
				return err
			}
		}
	}
	if len(failures) != 0 {
		return fmt.Errorf("%w: roll back the interrupted restore: %v", ErrStorage, errors.Join(failures...))
	}
	if err := removeEmptyDirectories(directories); err != nil {
		return fmt.Errorf("%w: remove restored directories during rollback: %v", ErrStorage, err)
	}
	return nil
}

// removeEmptyDirectories 只删除 restore 自己创建、且回滚后仍然为空的目录。
func removeEmptyDirectories(directories []string) error {
	for index := len(directories) - 1; index >= 0; index-- {
		removed, err := removeIfExists(directories[index])
		if err != nil {
			return err
		}
		if removed {
			if err := syncDirectory(filepath.Dir(directories[index])); err != nil {
				return err
			}
		}
	}
	return nil
}

// restoreWorkPrefix 是 restore staging 目录的前缀。
// 它刻意不与 RestoreJournalName 共享前缀，否则清理暂存目录会连 journal 一起删掉。
const restoreWorkPrefix = "restore-work-"

// removeStaleWorkspaces 清理崩溃留下的暂存目录；它们可能包含整个项目的明文副本。
// 这些前缀刻意都不匹配 RestoreJournalName，否则清理会删掉项目中间态的唯一记录。
func removeStaleWorkspaces(managedDir string) {
	for _, pattern := range []string{restoreWorkPrefix + "*", "preflight-*", "backup-work-*"} {
		matches, err := filepath.Glob(filepath.Join(managedDir, pattern))
		if err != nil {
			return
		}
		for _, match := range matches {
			_ = os.RemoveAll(match)
		}
	}
}

// missingDirectories 返回把 directory 变成存在目录所需要创建的路径，从外到内。
func missingDirectories(directory string) ([]string, error) {
	if directory == "" || directory == "." {
		return nil, nil
	}
	missing := make([]string, 0, 4)
	for current := directory; ; current = filepath.Dir(current) {
		if _, err := os.Stat(current); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		missing = append(missing, current)
		if parent := filepath.Dir(current); parent == current {
			break
		}
	}
	created := make([]string, 0, len(missing))
	for index := len(missing) - 1; index >= 0; index-- {
		created = append(created, missing[index])
	}
	return created, nil
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("%w: read a staged payload: %v", ErrStorage, err)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("%w: prepare a restore destination: %v", ErrStorage, err)
	}
	_, copyErr := io.Copy(output, input)
	if syncErr := output.Sync(); copyErr == nil {
		copyErr = syncErr
	}
	if closeErr := output.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return fmt.Errorf("%w: stage a restore payload: %v", ErrStorage, copyErr)
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		return fmt.Errorf("%w: persist staged restore payload: %v", ErrStorage, err)
	}
	return nil
}

func pathExists(value string) (bool, error) {
	if value == "" {
		return false, nil
	}
	_, err := os.Stat(value)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func removePath(value string) error {
	_, err := removeIfExists(value)
	return err
}

func removeIfExists(value string) (bool, error) {
	if err := os.Remove(value); errors.Is(err, os.ErrNotExist) || os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		parent, parentErr := os.Stat(filepath.Dir(value))
		if os.IsNotExist(parentErr) || (parentErr == nil && !parent.IsDir()) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
