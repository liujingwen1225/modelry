package portability

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/liujingwen1225/modelry/internal/appauth"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// 测试用的稳定对象引用。File Field 只接受 Runtime 生成的 opaque key。
const (
	firstObjectKey  = "obj_11111111111111111111111111111111"
	secondObjectKey = "obj_22222222222222222222222222222222"
)

// portabilityFixture 是真实 SQLite + 真实 Backend Model + 真实 Records Service
// + 真实本地对象目录的组合。onOpen 让测试在 Backup 开始读取对象字节的那一刻
// 确定性地注入一次 mutation。
type portabilityFixture struct {
	store      *storage.Store
	models     *backendmodel.Service
	records    *records.Service
	service    *Service
	managed    string
	objectsDir string
	onOpen     func()
}

func newPortabilityFixtureWithFiles(t *testing.T) *portabilityFixture {
	t.Helper()
	ctx := context.Background()
	managed := filepath.Join(t.TempDir(), ".modelry")
	objectsDir := filepath.Join(managed, "files", "objects")
	tempDir := filepath.Join(managed, "files", "tmp")
	for _, directory := range []string{managed, objectsDir, tempDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	store, err := storage.Open(filepath.Join(managed, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	recordService, err := records.NewWithLocalFiles(store, models, tempDir, objectsDir)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &portabilityFixture{store: store, models: models, records: recordService, managed: managed, objectsDir: objectsDir}
	service, err := NewService(Options{Store: store, Objects: &hookedObjects{fixture: fixture}, Models: models, ManagedDir: managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	fixture.service = service
	return fixture
}

func (fixture *portabilityFixture) putObject(t *testing.T, key string, payload []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(fixture.objectsDir, key), payload, 0o600); err != nil {
		t.Fatal(err)
	}
}

// hookedObjects 从真实本地对象目录按 key 读取字节，并在第一次读取时触发 hook。
type hookedObjects struct {
	fixture *portabilityFixture
	once    sync.Once
}

func (source *hookedObjects) OpenObject(_ context.Context, key string) (io.ReadCloser, error) {
	if hook := source.fixture.onOpen; hook != nil {
		source.once.Do(hook)
	}
	return os.Open(filepath.Join(source.fixture.objectsDir, key))
}

func createFileCollection(t *testing.T, models *backendmodel.Service, name string) backendmodel.Collection {
	t.Helper()
	collection, err := models.CreateCollection(context.Background(), backendmodel.CreateCollectionInput{
		Name: name, Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "title", Type: backendmodel.FieldTypeText},
			{Name: "attachment", Type: backendmodel.FieldTypeFile},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return collection
}

// factsFromDatabase 从一个已经落盘的 SQLite 文件读取 Backup 需要的那组事实。
func factsFromDatabase(t *testing.T, databasePath string) snapshotFacts {
	t.Helper()
	ctx := context.Background()
	reader, err := liveSnapshotSource{}.OpenSnapshot(ctx, databasePath)
	if err != nil {
		t.Fatalf("open snapshot %q: %v", databasePath, err)
	}
	defer reader.Close()
	collections, err := reader.AppliedCollections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	modelHash, err := hashCollections(collections)
	if err != nil {
		t.Fatal(err)
	}
	counts, err := reader.Counts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := reader.ReferencedFileKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return snapshotFacts{
		projectID: reader.ProjectID(), collections: counts.Collections,
		records: counts.Records, modelHash: modelHash, fileKeys: keys,
	}
}

func readBundleManifest(t *testing.T, bundlePath string) Manifest {
	t.Helper()
	var manifest Manifest
	if err := json.Unmarshal(readBundleEntry(t, bundlePath, ManifestPath), &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	return manifest
}

func readBundleEntry(t *testing.T, bundlePath, name string) []byte {
	t.Helper()
	file, err := os.Open(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader := tar.NewReader(file)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("read bundle: %v", err)
		}
		if header.Name != name {
			continue
		}
		payload, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read bundle entry %q: %v", name, err)
		}
		return payload
	}
	t.Fatalf("bundle %q has no entry %q", bundlePath, name)
	return nil
}

func extractDatabaseToFile(t *testing.T, bundlePath string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "archived.sqlite")
	if err := os.WriteFile(path, readBundleEntry(t, bundlePath, DatabaseArchivePath), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func hashFile(t *testing.T, path string) string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func listDirectory(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

// ---------------------------------------------------------------- P1: Backup 一致性

// TestBackupFactsComeFromOneLogicalSnapshot 证明 bundle 的数据库载荷、引用对象集合、
// counts 与 Applied Model hash 来自同一个逻辑快照。
//
// 确定性来自 ObjectSource：它在 Backup 开始读取对象字节的那一刻执行一次 mutation。
// 旧实现会在快照之后回到 live Runtime 读取 counts 与 Applied Model，因此记录的是
// mutation 之后的事实；新实现全部从快照读取，因此记录 mutation 之前的事实。
func TestBackupFactsComeFromOneLogicalSnapshot(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	fixture.putObject(t, firstObjectKey, bytes.Repeat([]byte("a"), 4096))
	fixture.putObject(t, secondObjectKey, bytes.Repeat([]byte("b"), 2048))
	collection := createFileCollection(t, fixture.models, "posts")
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "before", "attachment": firstObjectKey}); err != nil {
		t.Fatal(err)
	}
	before := factsFromDatabase(t, filepath.Join(fixture.managed, "project.sqlite"))
	if before.collections != 1 || before.records != 1 || len(before.fileKeys) != 1 {
		t.Fatalf("unexpected pre-mutation facts: %+v", before)
	}

	// 快照产生之后，Runtime 继续写入：新 Collection、新 Record 和新 File object。
	fixture.onOpen = func() {
		if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "after", "attachment": secondObjectKey}); err != nil {
			t.Errorf("post-snapshot Record mutation failed: %v", err)
		}
		if _, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
			Name: "later", Type: backendmodel.CollectionTypeNormal,
			Fields: []backendmodel.Field{{Name: "note", Type: backendmodel.FieldTypeText}},
		}); err != nil {
			t.Errorf("post-snapshot schema mutation failed: %v", err)
		}
	}

	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	result, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath})
	if err != nil {
		t.Fatalf("create backup: %v", err)
	}
	if result.Counts.Collections != before.collections || result.Counts.Records != before.records || result.Counts.Objects != 1 {
		t.Fatalf("backup counts = %+v, want collections=%d records=%d objects=1", result.Counts, before.collections, before.records)
	}

	// mutation 必须真的发生过，否则这个测试什么也没有证明。
	liveCollections, err := fixture.store.CollectionCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	liveRecords, err := fixture.store.ProjectedRecordCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if liveCollections != 2 || liveRecords != 2 {
		t.Fatalf("the fixture did not mutate the live project: collections=%d records=%d", liveCollections, liveRecords)
	}

	manifest := readBundleManifest(t, bundlePath)
	if manifest.AppliedModelHash != before.modelHash {
		t.Fatalf("manifest appliedModelHash = %s, want the snapshot hash %s", manifest.AppliedModelHash, before.modelHash)
	}
	if manifest.ProjectID != before.projectID {
		t.Fatalf("manifest projectId = %s, want the snapshot project id %s", manifest.ProjectID, before.projectID)
	}
	if len(manifest.Objects) != 1 || manifest.Objects[0].Key != firstObjectKey {
		t.Fatalf("manifest objects = %+v, want exactly the snapshot's referenced object", manifest.Objects)
	}

	// 最直接的一致性证明：归档里的数据库载荷必须与 manifest 描述完全一致。
	archived := factsFromDatabase(t, extractDatabaseToFile(t, bundlePath))
	if archived.collections != manifest.Counts.Collections || archived.records != manifest.Counts.Records {
		t.Fatalf("archive database holds collections=%d records=%d but the manifest says %+v", archived.collections, archived.records, manifest.Counts)
	}
	if archived.modelHash != manifest.AppliedModelHash {
		t.Fatalf("archive database model hash = %s but the manifest says %s", archived.modelHash, manifest.AppliedModelHash)
	}
	if len(archived.fileKeys) != 1 || archived.fileKeys[0] != manifest.Objects[0].Key {
		t.Fatalf("archive database references %v but the manifest lists %+v", archived.fileKeys, manifest.Objects)
	}

	preflight, err := fixture.service.Preflight(ctx, bundlePath)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if !preflight.Compatible {
		t.Fatalf("a bundle built from one snapshot is not compatible: %+v", preflight.Findings)
	}
}

// TestBackupStaysSelfConsistentUnderConcurrentMutation 用真实并发写入反复证明
// 同一个不变量：manifest 描述的事实必须与归档里的数据库载荷一致。
func TestBackupStaysSelfConsistentUnderConcurrentMutation(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	fixture.putObject(t, firstObjectKey, []byte("attachment"))
	fixture.putObject(t, secondObjectKey, []byte("second-attachment"))
	collection := createFileCollection(t, fixture.models, "posts")
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "seed", "attachment": firstObjectKey}); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var writers sync.WaitGroup
	writers.Add(2)
	go func() {
		defer writers.Done()
		for index := 0; ; index++ {
			select {
			case <-stop:
				return
			default:
			}
			_, _ = fixture.records.Create(ctx, collection.ID, map[string]any{"title": fmt.Sprintf("concurrent-%d", index), "attachment": secondObjectKey})
		}
	}()
	go func() {
		defer writers.Done()
		for index := 0; ; index++ {
			select {
			case <-stop:
				return
			default:
			}
			_, _ = fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
				Name: fmt.Sprintf("concurrent-%d", index), Type: backendmodel.CollectionTypeNormal,
			})
		}
	}()

	for round := 0; round < 4; round++ {
		bundlePath := filepath.Join(fixture.managed, fmt.Sprintf("bundle-%d.tar", round))
		result, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath})
		if err != nil {
			close(stop)
			writers.Wait()
			t.Fatalf("round %d: create backup: %v", round, err)
		}
		manifest := readBundleManifest(t, bundlePath)
		archived := factsFromDatabase(t, extractDatabaseToFile(t, bundlePath))
		if archived.collections != manifest.Counts.Collections || archived.records != manifest.Counts.Records ||
			archived.modelHash != manifest.AppliedModelHash || result.Counts.Records != manifest.Counts.Records {
			close(stop)
			writers.Wait()
			t.Fatalf("round %d: manifest %+v does not describe the archived database (collections=%d records=%d)",
				round, manifest.Counts, archived.collections, archived.records)
		}
		if len(manifest.Objects) != len(archived.fileKeys) {
			close(stop)
			writers.Wait()
			t.Fatalf("round %d: manifest lists %d objects but the archived database references %d", round, len(manifest.Objects), len(archived.fileKeys))
		}
	}
	close(stop)
	writers.Wait()
}

// ---------------------------------------------------------------- P1: Restore 原子性

// TestRestoreRollsBackWhenObjectActivationFails 是 Spec 0010 §3.2 的故障注入证明：
// 数据库已经激活完成之后，object 激活中途失败，原项目必须字节级保持不变。
func TestRestoreRollsBackWhenObjectActivationFails(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	fixture.putObject(t, firstObjectKey, bytes.Repeat([]byte("1"), 2048))
	fixture.putObject(t, secondObjectKey, bytes.Repeat([]byte("2"), 4096))
	collection := createFileCollection(t, fixture.models, "posts")
	for index, key := range []string{firstObjectKey, secondObjectKey} {
		if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": fmt.Sprintf("record-%d", index), "attachment": key}); err != nil {
			t.Fatal(err)
		}
	}
	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}

	// 目标项目：内容与 bundle 完全不同，restore 会覆盖它。
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, ".modelry", "project.sqlite")
	targetObjects := filepath.Join(targetRoot, ".modelry", "files", "objects")
	if err := os.MkdirAll(targetObjects, 0o700); err != nil {
		t.Fatal(err)
	}
	targetStore, targetModels, targetRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	targetCollection, err := targetModels.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "target", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "note", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := targetRecords.Create(ctx, targetCollection.ID, map[string]any{"note": "original"}); err != nil {
		t.Fatal(err)
	}
	// 目标对象与 bundle 的第一个对象使用同一个 key、不同的字节，因此这个条目走的是
	// 「原件被移开、回滚时放回去」这条分支，而不是「目标原本不存在」。
	if err := os.WriteFile(filepath.Join(targetObjects, firstObjectKey), []byte("the-original-object-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := targetStore.Close(); err != nil {
		t.Fatal(err)
	}

	beforeDatabase := hashFile(t, targetDatabase)
	beforeObjects := listDirectory(t, targetObjects)
	beforeObjectHashes := make(map[string]string, len(beforeObjects))
	for _, name := range beforeObjects {
		beforeObjectHashes[name] = hashFile(t, filepath.Join(targetObjects, name))
	}

	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: fixture.managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	// 故障注入必须落在阶段三：此时数据库已经激活完成、第二个 object 尚未激活。
	var observed []string
	restoreFault = func(step string) error {
		observed = append(observed, step)
		if step == restorePhaseActivate+":"+filepath.Join(targetObjects, secondObjectKey) {
			return errors.New("injected restore failure")
		}
		return nil
	}
	t.Cleanup(func() { restoreFault = nil })

	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err == nil {
		t.Fatal("restore reported success although object activation was injected to fail")
	}
	// 这个测试必须真的覆盖「数据库已经激活完成之后 object 激活失败」，而不是更早的
	// 准备阶段失败：因此数据库与第一个 object 的激活都必须已经发生过。
	for _, required := range []string{
		restorePhaseActivate + ":" + targetDatabase,
		restorePhaseActivate + ":" + filepath.Join(targetObjects, firstObjectKey),
	} {
		if !slices.Contains(observed, required) {
			t.Fatalf("the failure was injected before %q was activated; observed steps: %v", required, observed)
		}
	}

	// 故障确实发生在阶段三之后：目标数据库此刻曾经是 bundle 的内容。
	if after := hashFile(t, targetDatabase); after != beforeDatabase {
		t.Fatalf("restore left a half-replaced database: sha256 %s -> %s", beforeDatabase, after)
	}
	afterObjects := listDirectory(t, targetObjects)
	if strings.Join(afterObjects, ",") != strings.Join(beforeObjects, ",") {
		t.Fatalf("restore left a half-replaced object store: %v -> %v", beforeObjects, afterObjects)
	}
	for name, digest := range beforeObjectHashes {
		if after := hashFile(t, filepath.Join(targetObjects, name)); after != digest {
			t.Fatalf("restore changed object %q bytes", name)
		}
	}
	if _, err := os.Stat(filepath.Join(fixture.managed, RestoreJournalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the restore journal was not cleaned up: %v", err)
	}
	// 回滚后原项目必须仍然可用，并且保留它自己的 Record。
	reopened, reopenedModels, reopenedRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatalf("the rolled back project is not usable: %v", err)
	}
	defer reopened.Close()
	page, err := reopenedRecords.List(ctx, targetCollection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["note"] != "original" {
		t.Fatalf("rolled back Records = %+v", page.Data)
	}
	if _, err := reopenedModels.GetCollection(ctx, targetCollection.ID); err != nil {
		t.Fatal(err)
	}
}

// TestRestoreLeavesExistingProjectUntouchedWhenObjectStoreIsUnusable 用一个真实的
// 文件系统故障证明 all-or-nothing：object 目录不可用时 restore 必须在写入之前失败。
func TestRestoreLeavesExistingProjectUntouchedWhenObjectStoreIsUnusable(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	fixture.putObject(t, firstObjectKey, []byte("attachment-bytes"))
	collection := createFileCollection(t, fixture.models, "posts")
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "source", "attachment": firstObjectKey}); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}

	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, ".modelry", "project.sqlite")
	targetStore, targetModels, targetRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	targetCollection, err := targetModels.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "target", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "note", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := targetRecords.Create(ctx, targetCollection.ID, map[string]any{"note": "must survive"}); err != nil {
		t.Fatal(err)
	}
	if err := targetStore.Close(); err != nil {
		t.Fatal(err)
	}
	beforeDatabase := hashFile(t, targetDatabase)

	// object 目录的位置被一个普通文件占住：restore 无法在那里放置对象。
	unusableObjects := filepath.Join(targetRoot, "objects")
	if err := os.WriteFile(unusableObjects, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: fixture.managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: unusableObjects}); err == nil {
		t.Fatal("restore reported success although the object store is unusable")
	}
	if after := hashFile(t, targetDatabase); after != beforeDatabase {
		t.Fatalf("a failed restore replaced the database anyway: sha256 %s -> %s", beforeDatabase, after)
	}
	contents, err := os.ReadFile(unusableObjects)
	if err != nil || string(contents) != "not a directory" {
		t.Fatalf("a failed restore changed the object store location: %q %v", contents, err)
	}
	reopened, _, reopenedRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatalf("the untouched project is not usable: %v", err)
	}
	defer reopened.Close()
	page, err := reopenedRecords.List(ctx, targetCollection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["note"] != "must survive" {
		t.Fatalf("Records after a failed restore = %+v", page.Data)
	}
}

// TestRestoreRecoversAnInterruptedActivation 证明崩溃留下的 journal 可以在下一次
// restore 之前被完整回滚。
func TestRestoreRecoversAnInterruptedActivation(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "alive"}); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}

	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	targetObjects := filepath.Join(targetRoot, "objects")
	if err := os.MkdirAll(targetObjects, 0o700); err != nil {
		t.Fatal(err)
	}
	// 原件内容与 bundle 完全不同，因此「还原了原件」与「换上了 bundle」可以区分。
	original := []byte("the-original-project-database-bytes")
	if err := os.WriteFile(targetDatabase, original, 0o600); err != nil {
		t.Fatal(err)
	}
	// 一份「数据库已经激活、但还没有提交」的 journal，模拟进程在此刻被杀死。
	writeJournal(t, fixture.managed,
		journalRecord{Op: journalStage, Dest: targetDatabase, Path: targetDatabase + ".interrupted.new"},
		journalRecord{Op: journalBackup, Dest: targetDatabase, Path: targetDatabase + ".interrupted.old"},
		journalRecord{Op: journalActivate, Dest: targetDatabase, Path: targetDatabase + ".interrupted.new"},
	)
	if err := os.Rename(targetDatabase, targetDatabase+".interrupted.old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetDatabase, []byte("half-activated"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := rollbackInterruptedRestore(fixture.managed); err != nil {
		t.Fatalf("roll back an interrupted activation: %v", err)
	}
	contents, err := os.ReadFile(targetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, original) {
		t.Fatalf("rollback restored %q, want the exact original %q", contents, original)
	}
	if _, err := os.Stat(targetDatabase + ".interrupted.old"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the interrupted backup file was not consumed: %v", err)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)

	// 回滚之后，同一次 restore 仍然可以被完整执行。
	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: fixture.managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err != nil {
		t.Fatalf("apply after rolling back the interrupted restore: %v", err)
	}
	restored := factsFromDatabase(t, targetDatabase)
	manifest := readBundleManifest(t, bundlePath)
	if restored.modelHash != manifest.AppliedModelHash || restored.records != manifest.Counts.Records {
		t.Fatalf("restored database = %+v, want the bundle's %+v", restored, manifest.Counts)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

// writeJournal 写出一份手工构造的 restore journal。
func writeJournal(t *testing.T, managedDir string, lines ...journalRecord) string {
	t.Helper()
	journal := filepath.Join(managedDir, RestoreJournalName)
	var body strings.Builder
	for _, record := range lines {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		body.Write(encoded)
		body.WriteByte('\n')
	}
	if err := os.WriteFile(journal, []byte(body.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return journal
}

// TestRestoreRollsBackAWriteAheadWindowWithoutTouchingTheOriginal 证明 write-ahead
// 窗口内的中断不会毁掉原件。
//
// journal 已经记录了「我要把原件移到备份」，但那次移动从未发生：目标位置此刻仍然
// 是原件。一个把「记录过 backup」当成「移动已发生」的回滚会删除原件，并且报告成功。
func TestRestoreRollsBackAWriteAheadWindowWithoutTouchingTheOriginal(t *testing.T) {
	fixture := newPortabilityFixtureWithFiles(t)
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	original := []byte("the-original-project-database")
	if err := os.WriteFile(targetDatabase, original, 0o600); err != nil {
		t.Fatal(err)
	}
	writeJournal(t, fixture.managed,
		journalRecord{Op: journalStage, Dest: targetDatabase, Path: targetDatabase + ".never.new"},
		journalRecord{Op: journalBackup, Dest: targetDatabase, Path: targetDatabase + ".never.old"},
	)

	if err := rollbackInterruptedRestore(fixture.managed); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	contents, err := os.ReadFile(targetDatabase)
	if err != nil {
		t.Fatalf("the original database disappeared during rollback: %v", err)
	}
	if !bytes.Equal(contents, original) {
		t.Fatalf("rollback changed the original database: %q", contents)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

// TestRestoreRollsBackAPreserveFailure 证明「移动原件失败」这条真实错误路径同样不会
// 毁掉原件：注入的失败点正好落在 write-ahead 记录与那次 rename 之间。
func TestRestoreRollsBackAPreserveFailure(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	fixture.putObject(t, firstObjectKey, []byte("source-attachment"))
	collection := createFileCollection(t, fixture.models, "posts")
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "source", "attachment": firstObjectKey}); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}

	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	targetObjects := filepath.Join(targetRoot, "objects")
	if err := os.MkdirAll(targetObjects, 0o700); err != nil {
		t.Fatal(err)
	}
	targetStore, targetModels, targetRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	targetCollection, err := targetModels.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "target", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "note", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := targetRecords.Create(ctx, targetCollection.ID, map[string]any{"note": "original"}); err != nil {
		t.Fatal(err)
	}
	if err := targetStore.Close(); err != nil {
		t.Fatal(err)
	}
	beforeDatabase := hashFile(t, targetDatabase)

	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: fixture.managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	restoreFault = func(step string) error {
		if step == restorePhasePreserve+":"+targetDatabase {
			return errors.New("injected failure before preserving the original")
		}
		return nil
	}
	t.Cleanup(func() { restoreFault = nil })

	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err == nil {
		t.Fatal("restore reported success although preserving the original was injected to fail")
	}
	if after := hashFile(t, targetDatabase); after != beforeDatabase {
		t.Fatalf("the original database was destroyed: sha256 %s -> %s", beforeDatabase, after)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
	reopened, _, reopenedRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatalf("the untouched project is not usable: %v", err)
	}
	defer reopened.Close()
	page, err := reopenedRecords.List(ctx, targetCollection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["note"] != "original" {
		t.Fatalf("Records after the failed restore = %+v", page.Data)
	}
}

// TestRestoreRollsBackDespiteATornJournalLine 证明一行被写入中断的 journal 不会
// 让回滚整体作废，也不会永久阻塞后续 restore。
func TestRestoreRollsBackDespiteATornJournalLine(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "alive"}); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}

	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	targetObjects := filepath.Join(targetRoot, "objects")
	if err := os.MkdirAll(targetObjects, 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte("the-original-project-database-bytes")
	if err := os.WriteFile(targetDatabase, original, 0o600); err != nil {
		t.Fatal(err)
	}
	journal := writeJournal(t, fixture.managed,
		journalRecord{Op: journalStage, Dest: targetDatabase, Path: targetDatabase + ".torn.new"},
		journalRecord{Op: journalBackup, Dest: targetDatabase, Path: targetDatabase + ".torn.old"},
	)
	if err := os.Rename(targetDatabase, targetDatabase+".torn.old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetDatabase, []byte("half-activated"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 追加一行写到一半的记录，模拟写入被中断。
	truncated, err := os.OpenFile(journal, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := truncated.WriteString(`{"op":"activate","dest":"` + targetDatabase); err != nil {
		t.Fatal(err)
	}
	if err := truncated.Close(); err != nil {
		t.Fatal(err)
	}

	if err := rollbackInterruptedRestore(fixture.managed); err != nil {
		t.Fatalf("a torn journal line aborted the rollback: %v", err)
	}
	contents, err := os.ReadFile(targetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, original) {
		t.Fatalf("rollback restored %q, want the exact original %q", contents, original)
	}
	// 回滚之后项目必须可以正常使用，而不是被残留 journal 永久阻塞。
	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: fixture.managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err != nil {
		t.Fatalf("apply after a torn journal: %v", err)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

// TestRestoreReplacesAndRollsBackTheDatabaseSidecars 证明替换数据库时旧的 WAL 边车
// 必须一起消失，而回滚必须把它们的字节原样放回去：把新数据库留在旧 WAL 旁边会让下一次
// 启动把旧日志回放到新数据库上，得到新旧混合的数据。
func TestRestoreReplacesAndRollsBackTheDatabaseSidecars(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "restored"}); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}

	// 目标项目带一个非空 WAL 边车，模拟上一次进程被非正常终止。
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	targetObjects := filepath.Join(targetRoot, "objects")
	if err := os.MkdirAll(targetObjects, 0o700); err != nil {
		t.Fatal(err)
	}
	targetStore, targetModels, targetRecords, err := openProject(targetDatabase)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := targetModels.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "target", Type: backendmodel.CollectionTypeNormal,
	}); err != nil {
		t.Fatal(err)
	}
	if err := targetStore.Close(); err != nil {
		t.Fatal(err)
	}
	oldWAL := []byte("stale-wal-frames-from-the-previous-database")
	oldSHM := []byte("stale-shm")
	for suffix, payload := range map[string][]byte{"-wal": oldWAL, "-shm": oldSHM} {
		if err := os.WriteFile(targetDatabase+suffix, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	beforeDatabase := hashFile(t, targetDatabase)

	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: fixture.managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}

	// 回滚路径：阶段二已经把数据库与 WAL 都移开、阶段三还没有激活任何东西时失败。
	// 旧数据库与旧 WAL/SHM 都必须字节还原。
	restoreFault = func(step string) error {
		if step != restorePhaseActivate+":"+targetDatabase {
			return nil
		}
		// 证明这边车真的已经被移开，否则后面的字节比对是空转。
		for _, suffix := range []string{"-wal", "-shm"} {
			if _, err := os.Stat(targetDatabase + suffix); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("the %s sidecar was still in place when activation started: %v", suffix, err)
			}
		}
		if _, err := os.Stat(targetDatabase); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("the database was still in place when activation started: %v", err)
		}
		return errors.New("injected failure before activating the restored database")
	}
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err == nil {
		restoreFault = nil
		t.Fatal("restore reported success although activation was injected to fail")
	}
	restoreFault = nil
	if after := hashFile(t, targetDatabase); after != beforeDatabase {
		t.Fatalf("the failed restore changed the database: %s -> %s", beforeDatabase, after)
	}
	for suffix, payload := range map[string][]byte{"-wal": oldWAL, "-shm": oldSHM} {
		contents, err := os.ReadFile(targetDatabase + suffix)
		if err != nil {
			t.Fatalf("the failed restore lost the %s sidecar: %v", suffix, err)
		}
		if !bytes.Equal(contents, payload) {
			t.Fatalf("the failed restore changed the %s sidecar: %q", suffix, contents)
		}
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
	_ = targetRecords

	// 成功路径：新的数据库旁边绝不能留下旧 WAL/SHM。
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err != nil {
		t.Fatalf("restore: %v", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(targetDatabase + suffix); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("a stale %s sidecar survived a successful restore: %v", suffix, err)
		}
	}
	restored := factsFromDatabase(t, targetDatabase)
	manifest := readBundleManifest(t, bundlePath)
	if restored.records != manifest.Counts.Records {
		t.Fatalf("restored database = %+v, want the bundle's %+v", restored, manifest.Counts)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

// TestRollbackIsIdempotent 证明回滚可以被重放：一次只完成一半的回滚之后，第二遍必须
// 成功收敛，而不是报错留下永远无法消费的 journal（那会让项目再也无法启动）。
func TestRollbackIsIdempotent(t *testing.T) {
	fixture := newPortabilityFixtureWithFiles(t)
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	original := []byte("the-original-project-database-bytes")
	if err := os.WriteFile(targetDatabase, original, 0o600); err != nil {
		t.Fatal(err)
	}
	journal := writeJournal(t, fixture.managed,
		journalRecord{Op: journalStage, Dest: targetDatabase, Path: targetDatabase + ".replay.new"},
		journalRecord{Op: journalBackup, Dest: targetDatabase, Path: targetDatabase + ".replay.old"},
		journalRecord{Op: journalActivate, Dest: targetDatabase, Path: targetDatabase + ".replay.new"},
	)
	if err := os.Rename(targetDatabase, targetDatabase+".replay.old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetDatabase, []byte("half-activated"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 第一遍回滚把原件放回去，然后模拟进程在删除 journal 之前被杀。
	if err := rollbackJournal(journal); err != nil {
		t.Fatalf("first rollback: %v", err)
	}
	contents, err := os.ReadFile(targetDatabase)
	if err != nil || !bytes.Equal(contents, original) {
		t.Fatalf("first rollback restored %q (%v), want %q", contents, err, original)
	}
	// 第二遍必须成功且幂等，而不是把已经回位的结果当成「原件丢失」。
	if err := rollbackInterruptedRestore(fixture.managed); err != nil {
		t.Fatalf("replaying the rollback must succeed, got %v", err)
	}
	contents, err = os.ReadFile(targetDatabase)
	if err != nil || !bytes.Equal(contents, original) {
		t.Fatalf("replayed rollback restored %q (%v), want %q", contents, err, original)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

// TestRollbackAfterCommitOnlyCleansBackups 证明一个已提交的 journal 只清理备份，
// 绝不回滚已经生效的新内容。
func TestRollbackAfterCommitOnlyCleansBackups(t *testing.T) {
	fixture := newPortabilityFixtureWithFiles(t)
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	committed := []byte("the-newly-restored-database")
	if err := os.WriteFile(targetDatabase, committed, 0o600); err != nil {
		t.Fatal(err)
	}
	backup := targetDatabase + ".committed.old"
	if err := os.WriteFile(backup, []byte("the-old-database"), 0o600); err != nil {
		t.Fatal(err)
	}
	transaction := "restore-test-committed"
	writeJournal(t, fixture.managed,
		journalRecord{Op: journalBegin, ID: transaction},
		journalRecord{Op: journalTarget, ID: transaction, Dest: targetDatabase, Exists: true, Bytes: int64(len(committed)), SHA256: digestBytes(committed)},
		journalRecord{Op: journalStage, Dest: targetDatabase, Path: targetDatabase + ".committed.new"},
		journalRecord{Op: journalBackup, Dest: targetDatabase, Path: backup},
		journalRecord{Op: journalActivate, Dest: targetDatabase, Path: targetDatabase + ".committed.new"},
	)
	plan := activationPlan{
		journalPath: filepath.Join(fixture.managed, RestoreJournalName),
		commitPath:  filepath.Join(fixture.managed, RestoreCommitName), transaction: transaction,
		entries: []activationEntry{{kind: activationReplace, destination: targetDatabase, expected: ObjectEntry{Bytes: int64(len(committed)), SHA256: digestBytes(committed)}}},
	}
	if err := plan.installCommitMarker(); err != nil {
		t.Fatalf("install durable commit marker: %v", err)
	}

	if err := rollbackInterruptedRestore(fixture.managed); err != nil {
		t.Fatalf("recovering a committed journal: %v", err)
	}
	contents, err := os.ReadFile(targetDatabase)
	if err != nil || !bytes.Equal(contents, committed) {
		t.Fatalf("a committed restore was rolled back: %q (%v)", contents, err)
	}
	if _, err := os.Stat(backup); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the committed journal left its backup behind: %v", err)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

func TestRestoreDurabilityAndCommitFailuresRestorePreviousBytes(t *testing.T) {
	ctx := context.Background()
	source := newPortabilityFixtureWithFiles(t)
	source.putObject(t, firstObjectKey, []byte("bundle-first-object"))
	source.putObject(t, secondObjectKey, []byte("bundle-new-object"))
	collection := createFileCollection(t, source.models, "posts")
	for index, key := range []string{firstObjectKey, secondObjectKey} {
		if _, err := source.records.Create(ctx, collection.ID, map[string]any{"title": fmt.Sprintf("source-%d", index), "attachment": key}); err != nil {
			t.Fatal(err)
		}
	}
	bundlePath := filepath.Join(source.managed, "durability-bundle.tar")
	if _, err := source.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}
	manifest := readBundleManifest(t, bundlePath)
	newDatabaseDigest := manifest.Database.SHA256
	newObjectDigest := manifest.Objects[0].SHA256
	collectionID := collection.ID
	tests := []struct {
		name                string
		phase               string
		checkFullyActivated bool
	}{
		{name: "preserve rename directory sync", phase: restorePhasePreserveSync},
		{name: "activation rename directory sync", phase: restorePhaseActivateSync},
		{name: "commit marker write", phase: restorePhaseCommitWrite, checkFullyActivated: true},
		{name: "commit marker flush", phase: restorePhaseCommitFlush, checkFullyActivated: true},
		{name: "commit marker sync", phase: restorePhaseCommitSync, checkFullyActivated: true},
		{name: "commit marker directory sync after full activation", phase: restorePhaseCommitDirectory, checkFullyActivated: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := newRestoreDurabilityTarget(t)
			destination := target.database
			if strings.HasPrefix(test.phase, "commit-") {
				destination = filepath.Join(target.managed, RestoreCommitName)
			}
			trigger := test.phase + ":" + destination
			observedFailure := false
			restoreFault = func(step string) error {
				if step != trigger {
					return nil
				}
				if test.checkFullyActivated {
					if got := hashFile(t, target.database); got != newDatabaseDigest {
						t.Errorf("commit failure occurred before full database activation: got %s, want %s", got, newDatabaseDigest)
					}
					if got := hashFile(t, filepath.Join(target.objects, firstObjectKey)); got != newObjectDigest {
						t.Errorf("commit failure occurred before full object activation: got %s, want %s", got, newObjectDigest)
					}
				}
				observedFailure = true
				return fmt.Errorf("injected %s failure", test.name)
			}
			inspection, err := NewInspectionService(InspectionOptions{ManagedDir: target.managed, Version: "test"})
			if err != nil {
				t.Fatal(err)
			}
			_, applyErr := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: target.database, ObjectsDir: target.objects})
			restoreFault = nil
			if applyErr == nil || !observedFailure {
				t.Fatalf("Apply error = %v, failure injected = %t", applyErr, observedFailure)
			}
			assertRestoreTargetUnchanged(t, target)
			// The error path has already rolled back. Replaying recovery must remain safe.
			if err := rollbackInterruptedRestore(target.managed); err != nil {
				t.Fatalf("replay recovery after failed Apply: %v", err)
			}
			assertRestoreTargetUnchanged(t, target)
			if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: target.database, ObjectsDir: target.objects}); err != nil {
				t.Fatalf("retry restore after rollback: %v", err)
			}
			assertRestoredDurabilityTarget(t, target, newDatabaseDigest, collectionID)
		})
	}
}

type restoreDurabilityTarget struct {
	root, managed, database, objects string
	databaseDigest                   string
	firstObject                      []byte
	wal, shm                         []byte
}

func newRestoreDurabilityTarget(t *testing.T) restoreDurabilityTarget {
	t.Helper()
	root := t.TempDir()
	managed := filepath.Join(root, ".modelry")
	database := filepath.Join(managed, "project.sqlite")
	objects := filepath.Join(managed, "files", "objects")
	temporary := filepath.Join(managed, "files", "tmp")
	for _, directory := range []string{objects, temporary} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	oldObject := []byte("the-original-referenced-object")
	if err := os.WriteFile(filepath.Join(objects, firstObjectKey), oldObject, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(database)
	if err != nil {
		t.Fatal(err)
	}
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	recordService, err := records.NewWithLocalFiles(store, models, temporary, objects)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	collection := createFileCollection(t, models, "original")
	if _, err := recordService.Create(context.Background(), collection.ID, map[string]any{"title": "old", "attachment": firstObjectKey}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	wal := []byte("previous-WAL-bytes")
	shm := []byte("previous-SHM-bytes")
	if err := os.WriteFile(database+"-wal", wal, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(database+"-shm", shm, 0o600); err != nil {
		t.Fatal(err)
	}
	return restoreDurabilityTarget{
		root: root, managed: managed, database: database, objects: objects,
		databaseDigest: hashFile(t, database), firstObject: oldObject, wal: wal, shm: shm,
	}
}

func assertRestoreTargetUnchanged(t *testing.T, target restoreDurabilityTarget) {
	t.Helper()
	if got := hashFile(t, target.database); got != target.databaseDigest {
		t.Fatalf("failed restore changed original database bytes: %s -> %s", target.databaseDigest, got)
	}
	if got, err := os.ReadFile(filepath.Join(target.objects, firstObjectKey)); err != nil || !bytes.Equal(got, target.firstObject) {
		t.Fatalf("failed restore changed the old referenced object: %q (%v)", got, err)
	}
	if _, err := os.Stat(filepath.Join(target.objects, secondObjectKey)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed restore left a newly introduced object: %v", err)
	}
	for suffix, expected := range map[string][]byte{"-wal": target.wal, "-shm": target.shm} {
		got, err := os.ReadFile(target.database + suffix)
		if err != nil || !bytes.Equal(got, expected) {
			t.Fatalf("failed restore changed original %s state: %q (%v)", suffix, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(target.managed, RestoreJournalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed Apply left a journal that did not converge: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target.managed, RestoreCommitName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed Apply left a commit marker: %v", err)
	}
}

func TestCommittedMarkerCrashOnlyCleansBackups(t *testing.T) {
	managed := t.TempDir()
	destination := filepath.Join(t.TempDir(), "project.sqlite")
	newBytes := []byte("newly committed project state")
	backup := destination + ".restore.old"
	if err := os.WriteFile(destination, newBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("previous project state"), 0o600); err != nil {
		t.Fatal(err)
	}
	transaction := "restore-test-committed"
	writeJournal(t, managed,
		journalRecord{Op: journalBegin, ID: transaction},
		journalRecord{Op: journalTarget, ID: transaction, Dest: destination, Exists: true, Bytes: int64(len(newBytes)), SHA256: digestBytes(newBytes)},
		journalRecord{Op: journalStage, Dest: destination, Path: destination + ".restore.new"},
		journalRecord{Op: journalBackup, Dest: destination, Path: backup},
		journalRecord{Op: journalActivate, Dest: destination, Path: destination + ".restore.new"},
	)
	plan := activationPlan{
		journalPath: filepath.Join(managed, RestoreJournalName),
		commitPath:  filepath.Join(managed, RestoreCommitName), transaction: transaction,
		entries: []activationEntry{{kind: activationReplace, destination: destination, expected: ObjectEntry{Bytes: int64(len(newBytes)), SHA256: digestBytes(newBytes)}}},
	}
	if err := plan.installCommitMarker(); err != nil {
		t.Fatalf("install durable commit marker: %v", err)
	}
	if err := CheckInterruptedRestore(managed); err != nil {
		t.Fatalf("recover committed restore cleanup: %v", err)
	}
	if got, err := os.ReadFile(destination); err != nil || !bytes.Equal(got, newBytes) {
		t.Fatalf("committed state was rolled back: %q (%v)", got, err)
	}
	if _, err := os.Stat(backup); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed backup remains after cleanup: %v", err)
	}
	if _, err := os.Stat(filepath.Join(managed, RestoreJournalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed journal remains after cleanup: %v", err)
	}
}

func TestLegacyDoneJournalWithoutDurableMarkerRequiresExplicitResolution(t *testing.T) {
	managed := t.TempDir()
	destination := filepath.Join(t.TempDir(), "project.sqlite")
	newBytes := []byte("possibly committed legacy state")
	oldBytes := []byte("legacy backup that must not be deleted")
	backup := destination + ".restore.old"
	if err := os.WriteFile(destination, newBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, oldBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	writeJournal(t, managed,
		journalRecord{Op: journalBegin, ID: "restore-legacy"},
		journalRecord{Op: journalStage, Dest: destination, Path: destination + ".restore.new"},
		journalRecord{Op: journalBackup, Dest: destination, Path: backup},
		journalRecord{Op: journalActivate, Dest: destination, Path: destination + ".restore.new"},
		journalRecord{Op: journalDone},
	)

	for attempt := 0; attempt < 2; attempt++ {
		if err := CheckInterruptedRestore(managed); !errors.Is(err, errLegacyCommitAmbiguous) {
			t.Fatalf("recovery attempt %d error = %v, want ambiguous legacy commit", attempt+1, err)
		}
		if got, err := os.ReadFile(destination); err != nil || !bytes.Equal(got, newBytes) {
			t.Fatalf("ambiguous legacy journal changed destination: %q (%v)", got, err)
		}
		if got, err := os.ReadFile(backup); err != nil || !bytes.Equal(got, oldBytes) {
			t.Fatalf("ambiguous legacy journal deleted or changed backup: %q (%v)", got, err)
		}
		if _, err := os.Stat(filepath.Join(managed, RestoreJournalName)); err != nil {
			t.Fatalf("ambiguous legacy journal was removed: %v", err)
		}
	}
	if err := ResolveLegacyRestore(managed, LegacyRestoreAcceptCurrent); err != nil {
		t.Fatalf("explicitly accept current legacy state: %v", err)
	}
	if got, err := os.ReadFile(destination); err != nil || !bytes.Equal(got, newBytes) {
		t.Fatalf("accept-current changed the active destination: %q (%v)", got, err)
	}
	if _, err := os.Stat(backup); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("accept-current left its backup: %v", err)
	}
	if _, err := os.Stat(filepath.Join(managed, RestoreJournalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("accept-current left its journal: %v", err)
	}
}

func TestRollbackCrashMidwayCanBeReplayed(t *testing.T) {
	managed := t.TempDir()
	root := t.TempDir()
	database := filepath.Join(root, "project.sqlite")
	object := filepath.Join(root, "objects", firstObjectKey)
	if err := os.MkdirAll(filepath.Dir(object), 0o700); err != nil {
		t.Fatal(err)
	}
	originalDatabase := []byte("previous database")
	originalObject := []byte("previous referenced object")
	if err := os.WriteFile(database, originalDatabase, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(object, originalObject, 0o600); err != nil {
		t.Fatal(err)
	}
	databaseBackup, objectBackup := database+".old", object+".old"
	databaseNew, objectNew := database+".new", object+".new"
	if err := os.Rename(database, databaseBackup); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(object, objectBackup); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(database, []byte("new database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(object, []byte("new object"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeJournal(t, managed,
		journalRecord{Op: journalBegin, ID: "restore-mid-rollback"},
		journalRecord{Op: journalStage, Dest: database, Path: databaseNew},
		journalRecord{Op: journalStage, Dest: object, Path: objectNew},
		journalRecord{Op: journalBackup, Dest: database, Path: databaseBackup},
		journalRecord{Op: journalBackup, Dest: object, Path: objectBackup},
		journalRecord{Op: journalActivate, Dest: database, Path: databaseNew},
		journalRecord{Op: journalActivate, Dest: object, Path: objectNew},
	)

	crashed := false
	restoreRollbackFault = func(step string) error {
		if strings.HasPrefix(step, "rollback-after-target:") && !crashed {
			crashed = true
			return errors.New("simulated process crash")
		}
		return nil
	}
	if err := rollbackJournal(filepath.Join(managed, RestoreJournalName)); err == nil || !crashed {
		restoreRollbackFault = nil
		t.Fatalf("first rollback = %v, simulated crash = %t", err, crashed)
	}
	restoreRollbackFault = nil
	if got, err := os.ReadFile(database); err != nil || !bytes.Equal(got, originalDatabase) {
		t.Fatalf("first rollback did not restore its completed database: %q (%v)", got, err)
	}
	if got, err := os.ReadFile(object); err != nil || bytes.Equal(got, originalObject) {
		t.Fatalf("simulated crash did not leave the second target pending: %q (%v)", got, err)
	}
	if err := rollbackInterruptedRestore(managed); err != nil {
		t.Fatalf("replay rollback after simulated crash: %v", err)
	}
	if got, err := os.ReadFile(database); err != nil || !bytes.Equal(got, originalDatabase) {
		t.Fatalf("replayed rollback changed the database: %q (%v)", got, err)
	}
	if got, err := os.ReadFile(object); err != nil || !bytes.Equal(got, originalObject) {
		t.Fatalf("replayed rollback changed the object: %q (%v)", got, err)
	}
	if _, err := os.Stat(filepath.Join(managed, RestoreJournalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replayed rollback left the journal: %v", err)
	}
}

// TestRollbackRemovesNewContentWhoseOriginalNeverExisted 覆盖 absent + activate 这条
// 重放分支：目标原本不存在，因此回滚必须撤掉我们创建的内容。
func TestRollbackRemovesNewContentWhoseOriginalNeverExisted(t *testing.T) {
	fixture := newPortabilityFixtureWithFiles(t)
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	writeJournal(t, fixture.managed,
		journalRecord{Op: journalStage, Dest: targetDatabase, Path: targetDatabase + ".absent.new"},
		journalRecord{Op: journalAbsent, Dest: targetDatabase},
		journalRecord{Op: journalActivate, Dest: targetDatabase, Path: targetDatabase + ".absent.new"},
	)
	if err := os.WriteFile(targetDatabase, []byte("our-activated-content"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := rollbackInterruptedRestore(fixture.managed); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if _, err := os.Stat(targetDatabase); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rollback left content whose original never existed: %v", err)
	}
	assertNoRestoreLeftovers(t, targetRoot, fixture.managed)
}

// TestStaleWorkspaceCleanupNeverRemovesTheJournal 证明暂存目录清理不会连 journal 一起删掉：
// journal 是项目处于中间态的唯一记录，丢了它 Runtime 就会在一个被移开数据库的项目上启动。
func TestStaleWorkspaceCleanupNeverRemovesTheJournal(t *testing.T) {
	fixture := newPortabilityFixtureWithFiles(t)
	journal := writeJournal(t, fixture.managed, journalRecord{Op: journalAbsent, Dest: "nowhere"})
	for _, name := range []string{"restore-work-stale", "preflight-stale", "backup-work-stale"} {
		if err := os.MkdirAll(filepath.Join(fixture.managed, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	removeStaleWorkspaces(fixture.managed)
	if _, err := os.Stat(journal); err != nil {
		t.Fatalf("the restore journal was removed by workspace cleanup: %v", err)
	}
	for _, name := range []string{"restore-work-stale", "preflight-stale", "backup-work-stale"} {
		if _, err := os.Stat(filepath.Join(fixture.managed, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("the stale workspace %q survived cleanup: %v", name, err)
		}
	}
}

// assertNoRestoreLeftovers 断言 restore 没有留下任何暂存、备份或 journal 痕迹。
func assertNoRestoreLeftovers(t *testing.T, targetRoot, managedDir string) {
	t.Helper()
	for _, directory := range []string{targetRoot, managedDir, filepath.Join(managedDir, "files", "objects")} {
		for _, name := range listDirectory(t, directory) {
			for _, marker := range []string{".new", ".old", ".tmp"} {
				if strings.HasSuffix(name, marker) {
					t.Fatalf("restore left %q in %q", name, directory)
				}
			}
			if strings.HasPrefix(name, restoreWorkPrefix) || strings.HasPrefix(name, "preflight-") || strings.HasPrefix(name, "backup-work-") {
				t.Fatalf("restore left the workspace %q in %q", name, directory)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(managedDir, RestoreJournalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the restore journal was left behind: %v", err)
	}
}

func openProject(databasePath string) (*storage.Store, *backendmodel.Service, *records.Service, error) {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		return nil, nil, nil, err
	}
	store, err := storage.Open(databasePath)
	if err != nil {
		return nil, nil, nil, err
	}
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		_ = store.Close()
		return nil, nil, nil, err
	}
	recordService, err := records.New(store, models)
	if err != nil {
		_ = store.Close()
		return nil, nil, nil, err
	}
	return store, models, recordService, nil
}

func assertRestoredDurabilityTarget(t *testing.T, target restoreDurabilityTarget, databaseDigest, collectionID string) {
	t.Helper()
	if got := hashFile(t, target.database); got != databaseDigest {
		t.Fatalf("successful retry database digest = %s, want %s", got, databaseDigest)
	}
	for key, expected := range map[string][]byte{
		firstObjectKey:  []byte("bundle-first-object"),
		secondObjectKey: []byte("bundle-new-object"),
	} {
		if got, err := os.ReadFile(filepath.Join(target.objects, key)); err != nil || !bytes.Equal(got, expected) {
			t.Fatalf("successful retry object %q = %q (%v)", key, got, err)
		}
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(target.database + suffix); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("successful retry left old database %s state: %v", suffix, err)
		}
	}
	store, _, restoredRecords, err := openProject(target.database)
	if err != nil {
		t.Fatalf("open database after successful retry: %v", err)
	}
	defer store.Close()
	page, err := restoredRecords.List(context.Background(), collectionID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatalf("read Records after successful retry: %v", err)
	}
	if len(page.Data) != 2 {
		t.Fatalf("Records after successful retry = %d, want 2", len(page.Data))
	}
	keys := map[string]bool{}
	for _, record := range page.Data {
		if key, ok := record.Values["attachment"].(string); ok {
			keys[key] = true
		}
	}
	if !keys[firstObjectKey] || !keys[secondObjectKey] {
		t.Fatalf("File references after successful retry = %#v", keys)
	}
}

// ---------------------------------------------------------------- P1: Restore bounds

const largeObjectBytes = 70 << 20 // >64 MiB 的 manifest 上限，<=128 MiB 的 object 上限

// TestFileObjectBoundsMatchTheProductLimits 锁定边界语义。
func TestFileObjectBoundsMatchTheProductLimits(t *testing.T) {
	// 单对象上限必须与产品自己的单文件硬上限一致，否则会拒绝 Provider 能存下的对象。
	if maximumObjectPayloadBytes != filestore.MaxObjectBytes {
		t.Fatalf("object payload bound = %d, want the product limit %d", int64(maximumObjectPayloadBytes), int64(filestore.MaxObjectBytes))
	}
	// 归档余量必须覆盖 manifest 与全部条目的 tar 头/padding，否则合法 bundle 会被读取预算误判。
	minimumOverhead := int64(maximumManifestBytes) + int64(maximumArchiveEntries)*1024
	if int64(archiveOverheadAllowance) < minimumOverhead {
		t.Fatalf("archive overhead allowance = %d, want at least %d", int64(archiveOverheadAllowance), minimumOverhead)
	}
}

// TestPreflightLocksTheObjectPayloadBoundary 锁定单对象边界：恰好 128 MiB 的声明必须被
// 接受，多一个字节必须被拒绝。
func TestPreflightLocksTheObjectPayloadBoundary(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	database := buildModelryDatabase(t)
	base := Manifest{
		Format: FormatName, FormatVersion: FormatVersion, ProjectID: "prj_test",
		RuntimeVersion: "test", AppliedModelHash: strings.Repeat("a", 64),
		Database: DatabaseEntry{Path: DatabaseArchivePath, Bytes: int64(len(database)), SHA256: digestOf(database), SQLiteVersion: "3.51.3"},
	}
	atBoundary := base
	atBoundary.Objects = []ObjectEntry{{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes), SHA256: strings.Repeat("b", 64)}}
	preflight, err := fixture.service.Preflight(ctx, writeBundle(t, fixture.managed, "at-boundary.tar", atBoundary, database, nil))
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if hasFinding(preflight, "object.invalidSize") {
		t.Fatalf("a %d byte object declaration was rejected: %+v", int64(maximumObjectPayloadBytes), preflight.Findings)
	}

	overBoundary := base
	overBoundary.Objects = []ObjectEntry{{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes) + 1, SHA256: strings.Repeat("b", 64)}}
	preflight, err = fixture.service.Preflight(ctx, writeBundle(t, fixture.managed, "over-boundary.tar", overBoundary, database, nil))
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if !hasFinding(preflight, "object.invalidSize") {
		t.Fatalf("a declaration above the object limit was accepted: %+v", preflight.Findings)
	}
}

// endlessReader 按需产生字节，让读取预算测试不必真的写满磁盘。
type endlessReader struct{ read int64 }

func (reader *endlessReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = 'z'
	}
	reader.read += int64(len(buffer))
	return len(buffer), nil
}

// TestPreflightStopsReadingWhenTheArchiveExceedsWhatTheManifestDeclares 证明读取预算
// 真的按 manifest 声明收紧：一个只声明了小载荷、归档里却还有远超声明数据的 bundle
// 必须被拒绝，而不是被无声读完。
func TestPreflightStopsReadingWhenTheArchiveExceedsWhatTheManifestDeclares(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	database := buildModelryDatabase(t)
	manifest := Manifest{
		Format: FormatName, FormatVersion: FormatVersion, ProjectID: "prj_test",
		RuntimeVersion: "test", AppliedModelHash: strings.Repeat("a", 64),
		Database: DatabaseEntry{Path: DatabaseArchivePath, Bytes: int64(len(database)), SHA256: digestOf(database), SQLiteVersion: "3.51.3"},
		Objects:  []ObjectEntry{{Key: firstObjectKey, Bytes: 4, SHA256: digestOf([]byte("tiny"))}},
	}
	path := filepath.Join(fixture.managed, "over-declared.tar")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		name    string
		payload []byte
	}{
		{ManifestPath, encoded},
		{DatabaseArchivePath, database},
		{ObjectsArchivePrefix + firstObjectKey, []byte("tiny")},
	} {
		if err := writer.WriteHeader(&tar.Header{Name: entry.name, Mode: 0o600, Size: int64(len(entry.payload)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(entry.payload); err != nil {
			t.Fatal(err)
		}
	}
	// 一个 manifest 没有列出的条目，其头部声明了超过归档余量的长度：tar 必须跳过它，
	// 于是读取会越过 manifest 声明的预算。
	oversized := int64(archiveOverheadAllowance) + (8 << 20)
	if err := writer.WriteHeader(&tar.Header{Name: ObjectsArchivePrefix + secondObjectKey, Mode: 0o600, Size: oversized, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	block := bytes.Repeat([]byte("z"), 1<<20)
	for written := int64(0); written < oversized; {
		chunk := block
		if remaining := oversized - written; remaining < int64(len(chunk)) {
			chunk = chunk[:remaining]
		}
		if _, err := writer.Write(chunk); err != nil {
			t.Fatal(err)
		}
		written += int64(len(chunk))
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	// 归档必须真的超出 manifest 声明的预算，否则这个测试什么也没有证明。
	declared := int64(len(database)) + 4
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() <= archiveEnvelope(declared) {
		t.Fatalf("the fixture archive is %d bytes, which does not exceed the %d byte budget", info.Size(), archiveEnvelope(declared))
	}
	if _, err := fixture.service.Preflight(ctx, path); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("preflight of an archive larger than its manifest declares error = %v, want ErrPayloadTooLarge", err)
	}
}

// TestBoundedReaderStopsAtItsBudget 直接锁定读取预算原语：它必须在恰好用满预算时停止。
func TestBoundedReaderStopsAtItsBudget(t *testing.T) {
	bounded := &boundedReader{reader: &endlessReader{}, limit: 1 << 20}
	if _, err := io.Copy(io.Discard, bounded); !errors.Is(err, errBundleTooLarge) {
		t.Fatalf("boundedReader error = %v, want errBundleTooLarge", err)
	}
	if bounded.read != 1<<20 {
		t.Fatalf("boundedReader read %d bytes, want exactly its limit", bounded.read)
	}
	bounded.tighten(1 << 30)
	if bounded.limit != 1<<20 {
		t.Fatalf("tighten widened the budget to %d", bounded.limit)
	}
	bounded.tighten(1 << 10)
	if bounded.limit != 1<<10 {
		t.Fatalf("tighten did not lower the budget: %d", bounded.limit)
	}
	if envelope := archiveEnvelope(0); envelope != int64(archiveOverheadAllowance) {
		t.Fatalf("envelope for an empty declaration = %d", envelope)
	}
	if envelope := archiveEnvelope(maximumRestoreBytes * 2); envelope != int64(maximumRestoreBytes)+int64(archiveOverheadAllowance) {
		t.Fatalf("envelope must clamp an oversized declaration, got %d", envelope)
	}
}

// TestCheckPayloadBoundsMatchesPreflight 证明 Backup 与 Preflight 使用同一套载荷边界，
// 因此 Backup 不可能产出一份自己无法恢复的 bundle。
func TestCheckPayloadBoundsMatchesPreflight(t *testing.T) {
	withinBounds := make([]ObjectEntry, 2)
	for index := range withinBounds {
		withinBounds[index] = ObjectEntry{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes)}
	}
	if err := checkPayloadBounds(1<<20, withinBounds); err != nil {
		t.Fatalf("a bundle inside the bounds was rejected: %v", err)
	}

	var tooMuch []ObjectEntry
	for total := int64(0); total <= int64(maximumRestoreBytes); total += int64(maximumObjectPayloadBytes) {
		tooMuch = append(tooMuch, ObjectEntry{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes)})
	}
	if err := checkPayloadBounds(1<<20, tooMuch); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("error = %v, want ErrPayloadTooLarge for %d objects of %d bytes", err, len(tooMuch), int64(maximumObjectPayloadBytes))
	}
	if err := checkPayloadBounds(int64(maximumDatabasePayloadBytes)+1, nil); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("error = %v, want ErrPayloadTooLarge for an oversized database payload", err)
	}
	if err := checkPayloadBounds(0, nil); err == nil {
		t.Fatal("an empty database payload was accepted")
	}
}

// TestBackupPreflightAndRestoreSupportLargeFileObjects 证明一个合法的 >64 MiB 且
// <=128 MiB 的 File object 可以完整地 Backup -> Preflight -> Restore。
func TestBackupPreflightAndRestoreSupportLargeFileObjects(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	largeObject := filepath.Join(t.TempDir(), "large-object.bin")
	if err := writePatternFile(t, largeObject, largeObjectBytes); err != nil {
		t.Fatal(err)
	}
	if err := copyPath(largeObject, filepath.Join(fixture.objectsDir, firstObjectKey)); err != nil {
		t.Fatal(err)
	}
	collection := createFileCollection(t, fixture.models, "posts")
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "large", "attachment": firstObjectKey}); err != nil {
		t.Fatal(err)
	}

	bundlePath := filepath.Join(fixture.managed, "bundle.tar")
	result, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath})
	if err != nil {
		t.Fatalf("create backup with a large file object: %v", err)
	}
	if result.Counts.Objects != 1 {
		t.Fatalf("backup counts = %+v", result.Counts)
	}
	manifest := readBundleManifest(t, bundlePath)
	if len(manifest.Objects) != 1 || manifest.Objects[0].Bytes != int64(largeObjectBytes) {
		t.Fatalf("manifest objects = %+v, want one %d byte object", manifest.Objects, int64(largeObjectBytes))
	}

	preflight, err := fixture.service.Preflight(ctx, bundlePath)
	if err != nil {
		t.Fatalf("preflight a bundle with a large file object: %v", err)
	}
	if !preflight.Compatible {
		t.Fatalf("a %d byte object must stay restorable: %+v", int64(largeObjectBytes), preflight.Findings)
	}
	// HTTP preflight 也必须接受它：manifest 的 64 MiB 上限不是整个 bundle 的上限。
	handle, err := os.Open(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	streamed, err := fixture.service.PreflightReader(ctx, handle)
	if err != nil {
		t.Fatalf("streamed preflight: %v", err)
	}
	if !streamed.Compatible {
		t.Fatalf("streamed preflight rejected a large file object: %+v", streamed.Findings)
	}

	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	targetObjects := filepath.Join(targetRoot, "objects")
	sourceDigest := hashFile(t, largeObject)
	if _, err := fixture.service.Apply(ctx, bundlePath, ApplyOptions{DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err != nil {
		t.Fatalf("restore a bundle with a large file object: %v", err)
	}
	restored := filepath.Join(targetObjects, firstObjectKey)
	if digest := hashFile(t, restored); digest != sourceDigest {
		t.Fatalf("restored large object sha256 = %s, want %s", digest, sourceDigest)
	}
	if digest := hashFile(t, restored); digest != manifest.Objects[0].SHA256 {
		t.Fatal("the restored large object does not match the manifest digest")
	}
}

// TestPreflightRejectsOverstatedAndTruncatedPayloads 证明 manifest 声明的字节长度
// 被严格校验：过短的归档、过大的声明与未列出的条目都必须被拒绝。
func TestPreflightRejectsOverstatedAndTruncatedPayloads(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	database := buildModelryDatabase(t)

	databaseEntry := DatabaseEntry{Path: DatabaseArchivePath, Bytes: int64(len(database)), SHA256: digestOf(database), SQLiteVersion: "3.51.3"}
	base := func() Manifest {
		return Manifest{
			Format: FormatName, FormatVersion: FormatVersion, ProjectID: "prj_test",
			RuntimeVersion: "test", AppliedModelHash: strings.Repeat("a", 64),
			Database: databaseEntry, Counts: Counts{},
		}
	}

	t.Run("object size lies about the payload length", func(t *testing.T) {
		manifest := base()
		manifest.Objects = []ObjectEntry{{Key: firstObjectKey, Bytes: 4096, SHA256: digestOf([]byte("short"))}}
		path := writeBundle(t, fixture.managed, "truncated.tar", manifest, database, map[string][]byte{firstObjectKey: []byte("short")})
		preflight, err := fixture.service.Preflight(ctx, path)
		if err != nil {
			t.Fatalf("preflight: %v", err)
		}
		if preflight.Compatible {
			t.Fatal("a payload shorter than its manifest declaration was accepted")
		}
		if !hasFinding(preflight, "payload.sizeMismatch") {
			t.Fatalf("findings = %+v, want payload.sizeMismatch", preflight.Findings)
		}
	})

	t.Run("object declaration exceeds the product object limit", func(t *testing.T) {
		manifest := base()
		manifest.Objects = []ObjectEntry{{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes) + 1, SHA256: strings.Repeat("b", 64)}}
		path := writeBundle(t, fixture.managed, "oversized-object.tar", manifest, database, nil)
		preflight, err := fixture.service.Preflight(ctx, path)
		if err != nil {
			t.Fatalf("preflight: %v", err)
		}
		if preflight.Compatible {
			t.Fatal("an object larger than the product limit was accepted")
		}
		if !hasFinding(preflight, "object.invalidSize") {
			t.Fatalf("findings = %+v, want object.invalidSize", preflight.Findings)
		}
	})

	t.Run("declared payload total exceeds the bundle bound", func(t *testing.T) {
		manifest := base()
		manifest.Database.Bytes = maximumDatabasePayloadBytes
		manifest.Database.SHA256 = strings.Repeat("c", 64)
		manifest.Objects = []ObjectEntry{{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes), SHA256: strings.Repeat("d", 64)}}
		path := writeBundle(t, fixture.managed, "too-large.tar", manifest, database, nil)
		if _, err := fixture.service.Preflight(ctx, path); !errors.Is(err, ErrPayloadTooLarge) {
			t.Fatalf("preflight error = %v, want ErrPayloadTooLarge", err)
		}
	})

	t.Run("object key is not a Runtime object reference", func(t *testing.T) {
		manifest := base()
		manifest.Objects = []ObjectEntry{{Key: "../../escape", Bytes: 4, SHA256: digestOf([]byte("evil"))}}
		path := writeBundle(t, fixture.managed, "traversal.tar", manifest, database, map[string][]byte{"../../escape": []byte("evil")})
		preflight, err := fixture.service.Preflight(ctx, path)
		if err != nil {
			t.Fatalf("preflight: %v", err)
		}
		if preflight.Compatible {
			t.Fatal("an object key that is not a Runtime object reference was accepted")
		}
		if !hasFinding(preflight, "object.invalidKey") && !hasFinding(preflight, "archive.unexpectedEntry") {
			t.Fatalf("findings = %+v, want an invalid object key finding", preflight.Findings)
		}
	})

	t.Run("manifest larger than the manifest limit", func(t *testing.T) {
		path := filepath.Join(fixture.managed, "huge-manifest.tar")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		writer := tar.NewWriter(file)
		payload := make([]byte, maximumManifestBytes+1024)
		if err := writer.WriteHeader(&tar.Header{Name: ManifestPath, Mode: 0o600, Size: int64(len(payload)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(payload); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.service.Preflight(ctx, path); !errors.Is(err, ErrPayloadTooLarge) {
			t.Fatalf("preflight error = %v, want ErrPayloadTooLarge", err)
		}
	})

	t.Run("archive ends inside a payload", func(t *testing.T) {
		payload := bytes.Repeat([]byte("p"), 64<<10)
		manifest := base()
		manifest.Objects = []ObjectEntry{{Key: firstObjectKey, Bytes: int64(len(payload)), SHA256: digestOf(payload)}}
		path := writeBundle(t, fixture.managed, "cut.tar", manifest, database, map[string][]byte{firstObjectKey: payload})
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		// 切掉尾部：归档在 object 载荷结束之前就断了。
		if err := os.Truncate(path, info.Size()-40<<10); err != nil {
			t.Fatal(err)
		}
		preflight, err := fixture.service.Preflight(ctx, path)
		if err != nil {
			t.Fatalf("preflight of a truncated archive must be a readable verdict, got error %v", err)
		}
		if preflight.Compatible {
			t.Fatal("an archive that ends inside a payload was accepted")
		}
		if !hasFinding(preflight, "archive.unreadable") {
			t.Fatalf("findings = %+v, want archive.unreadable", preflight.Findings)
		}
		// Apply 必须同样拒绝（preflight 不通过），并且不触碰目标。
		targetDatabase := filepath.Join(t.TempDir(), "project.sqlite")
		targetObjects := filepath.Join(t.TempDir(), "objects")
		if _, err := fixture.service.Apply(ctx, path, ApplyOptions{DatabasePath: targetDatabase, ObjectsDir: targetObjects}); !errors.Is(err, ErrIncompatibleBundle) {
			t.Fatalf("apply error = %v, want ErrIncompatibleBundle", err)
		}
		if _, err := os.Stat(targetDatabase); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("a rejected apply created a target database: %v", err)
		}
		if _, err := os.Stat(targetObjects); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("a rejected apply created an object store: %v", err)
		}
	})

	t.Run("unlisted archive entry", func(t *testing.T) {
		manifest := base()
		path := writeBundle(t, fixture.managed, "extra.tar", manifest, database, nil)
		extraPath := filepath.Join(fixture.managed, "extra-entry.tar")
		if err := appendArchiveEntry(path, extraPath, ObjectsArchivePrefix+secondObjectKey, []byte("unlisted")); err != nil {
			t.Fatal(err)
		}
		preflight, err := fixture.service.Preflight(ctx, extraPath)
		if err != nil {
			t.Fatalf("preflight: %v", err)
		}
		if preflight.Compatible {
			t.Fatal("an entry the manifest does not list was accepted")
		}
		if !hasFinding(preflight, "archive.unexpectedEntry") {
			t.Fatalf("findings = %+v, want archive.unexpectedEntry", preflight.Findings)
		}
	})
}

// ---------------------------------------------------------------- P1: Export 数据保持

// TestExportImportRoundTripKeepsSensitiveLookingFields 证明 Export 是无损的：
// 一个普通 Record 的合法字段不会因为名字像秘密而被丢弃。
func TestExportImportRoundTripKeepsSensitiveLookingFields(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "accounts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "token", Type: backendmodel.FieldTypeText},
			{Name: "secret", Type: backendmodel.FieldTypeText},
			{Name: "password_hash", Type: backendmodel.FieldTypeText},
			{Name: "api_key", Type: backendmodel.FieldTypeText},
			{Name: "client_secret", Type: backendmodel.FieldTypeText},
			{Name: "note", Type: backendmodel.FieldTypeText},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]any{
		"token": "token-value-must-survive", "secret": "secret-value-must-survive",
		"password_hash": "password-hash-must-survive", "api_key": "api-key-must-survive",
		"client_secret": "client-secret-must-survive", "note": "plain",
	}
	created, err := fixture.records.Create(ctx, collection.ID, wanted)
	if err != nil {
		t.Fatal(err)
	}

	var stream bytes.Buffer
	if err := fixture.service.ExportStream(ctx, fixture.records, fixture.models, collection.ID, &stream); err != nil {
		t.Fatalf("export: %v", err)
	}
	for name, value := range wanted {
		if !strings.Contains(stream.String(), value.(string)) {
			t.Fatalf("export dropped the value of field %q: %s", name, stream.String())
		}
	}

	// 真实往返：把导出的 NDJSON 原样导入回同一个 Applied Model，然后逐字段比对。
	summary, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(stream.String()))
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if summary.Created != 1 || summary.Failed != 0 || len(summary.Results) != 1 {
		t.Fatalf("import summary = %+v", summary)
	}
	importedID := summary.Results[0].RecordID
	if importedID == "" || importedID == created.ID {
		t.Fatalf("import did not create a new Record: %q (source %s)", importedID, created.ID)
	}
	page, err := fixture.records.List(ctx, collection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 2 {
		t.Fatalf("Records after the round trip = %d, want 2", len(page.Data))
	}
	for _, record := range page.Data {
		if record.ID != importedID {
			continue
		}
		for name, value := range wanted {
			if record.Values[name] != value {
				t.Fatalf("imported field %q = %v, want %v", name, record.Values[name], value)
			}
		}
		return
	}
	t.Fatalf("the imported Record %s was not found", importedID)
}

// TestExportNeverReachesPasswordCredentialsOrSessions 证明 Credential 与 Session
// 天然不进入 Record 导出：它们存放在独立的表里，用户的 Record 只有产品字段。
func TestExportNeverReachesPasswordCredentialsOrSessions(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	auth, err := appauth.NewService(ctx, fixture.store, fixture.models, fixture.records)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "members", Type: backendmodel.CollectionTypeAuth,
		Fields: []backendmodel.Field{{Name: "display", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	password := "correct-horse-battery-staple"
	if _, err := auth.CreateUser(ctx, collection.ID, map[string]any{"email": "member@example.com", "display": "Member"}, password); err != nil {
		t.Fatalf("create an app user: %v", err)
	}

	var stream bytes.Buffer
	if err := fixture.service.ExportStream(ctx, fixture.records, fixture.models, collection.ID, &stream); err != nil {
		t.Fatalf("export: %v", err)
	}
	exported := stream.String()
	if !strings.Contains(exported, "member@example.com") {
		t.Fatalf("the Auth profile Record was not exported: %s", exported)
	}
	for _, forbidden := range []string{password, "password_salt", "password_hash", "pbkdf2"} {
		if strings.Contains(exported, forbidden) {
			t.Fatalf("export leaked %q: %s", forbidden, exported)
		}
	}
	// 并且 Credential 确实存在，否则这个测试没有证明任何东西。
	var stored int
	if err := fixture.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_app_password_credentials`).Scan(&stored)
	}); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatalf("stored Password Credentials = %d, want 1", stored)
	}
}

// TestExportImportRoundTripPreservesEveryFieldType 用真实产品字段类型证明 Export -> Import
// 是无损的：值不仅被保留，而且序列化形态完全一致。
func TestExportImportRoundTripPreservesEveryFieldType(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	fixture.putObject(t, firstObjectKey, []byte("attachment-bytes"))
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "mixed", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "title", Type: backendmodel.FieldTypeText},
			{Name: "views", Type: backendmodel.FieldTypeNumber},
			{Name: "published", Type: backendmodel.FieldTypeBoolean},
			{Name: "published_at", Type: backendmodel.FieldTypeDateTime},
			{Name: "metadata", Type: backendmodel.FieldTypeJSON},
			{Name: "attachment", Type: backendmodel.FieldTypeFile},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	// metadata 里刻意放入超出 float64 精度的整数与高精度小数：它们必须逐字节往返。
	values := map[string]any{
		"title": "mixed", "views": 42.5, "published": true,
		"published_at": "2026-01-02T03:04:05Z",
		"metadata":     json.RawMessage(`{"big":9007199254740993,"precise":0.123456789012345678901234567890,"nested":{"list":[1,2,3]}}`),
		"attachment":   firstObjectKey,
	}
	created, err := fixture.records.Create(ctx, collection.ID, values)
	if err != nil {
		t.Fatal(err)
	}

	var stream bytes.Buffer
	if err := fixture.service.ExportStream(ctx, fixture.records, fixture.models, collection.ID, &stream); err != nil {
		t.Fatalf("export: %v", err)
	}
	if !strings.Contains(stream.String(), "9007199254740993") || !strings.Contains(stream.String(), "0.123456789012345678901234567890") {
		t.Fatalf("export changed a high-precision JSON value: %s", stream.String())
	}
	summary, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(stream.String()))
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if summary.Created != 1 || summary.Failed != 0 {
		t.Fatalf("import summary = %+v", summary)
	}

	page, err := fixture.records.List(ctx, collection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 2 {
		t.Fatalf("Records after the round trip = %d, want 2", len(page.Data))
	}
	var original, reimported records.Record
	for _, record := range page.Data {
		if record.ID == created.ID {
			original = record
		}
		if record.ID == summary.Results[0].RecordID {
			reimported = record
		}
	}
	if reimported.ID == "" {
		t.Fatalf("the imported Record %s was not found", summary.Results[0].RecordID)
	}
	before := canonicalRecordValues(t, original.Values)
	after := canonicalRecordValues(t, reimported.Values)
	if before != after {
		t.Fatalf("the round trip changed the Record:\n before %s\n after  %s", before, after)
	}
}

// canonicalRecordValues 把 Record 值编码成稳定的 JSON，用于逐字节比对。
func canonicalRecordValues(t *testing.T, values map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// countingRecords 是一个只统计调用的 RecordSource，用于测试 Import 的请求级边界，
// 而不必真的写入 1000 条 Record。
type countingRecords struct {
	created int
}

func (source *countingRecords) List(context.Context, string, records.ListOptions) (records.Page, error) {
	return records.Page{}, nil
}

func (source *countingRecords) Create(_ context.Context, _ string, values map[string]any) (records.Record, error) {
	source.created++
	return records.Record{ID: fmt.Sprintf("rec_%d", source.created), Values: values}, nil
}

// TestImportReportsRequestLevelLimitsInsteadOfPartialSuccess 证明超过单次 Import 上限是
// 请求级失败，而不是一个看起来成功的部分摘要：调用方必须能区分「全部导入」与「只导入了前 1000 条」。
func TestImportReportsRequestLevelLimitsInsteadOfPartialSuccess(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	applied, err := fixture.service.AppliedModelHash(ctx)
	if err != nil {
		t.Fatal(err)
	}
	header, err := json.Marshal(map[string]any{
		"kind": "collection", "collectionId": collection.ID, "name": collection.Name, "appliedModelHash": applied,
	})
	if err != nil {
		t.Fatal(err)
	}
	var body strings.Builder
	body.Write(header)
	body.WriteByte('\n')
	for index := 0; index < maximumImportRecords+1; index++ {
		body.WriteString(`{"kind":"record","values":{"title":"imported"}}`)
		body.WriteByte('\n')
	}

	source := &countingRecords{}
	summary, err := fixture.service.ImportStream(ctx, source, fixture.models, collection.ID, strings.NewReader(body.String()))
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("import error = %v, want ErrInvalidArgument", err)
	}
	// 前缀是耐久写入的，因此调用方必须能从摘要里看出来，而不是靠猜。
	if summary.Created != maximumImportRecords || source.created != maximumImportRecords {
		t.Fatalf("summary.Created = %d (created %d), want %d", summary.Created, source.created, maximumImportRecords)
	}
}

// TestImportRejectsLinesThatAreNotRecordLines 证明导入严格遵守 NDJSON 形状。
func TestImportRejectsLinesThatAreNotRecordLines(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	applied, err := fixture.service.AppliedModelHash(ctx)
	if err != nil {
		t.Fatal(err)
	}
	header, err := json.Marshal(map[string]any{
		"kind": "collection", "collectionId": collection.ID, "name": collection.Name, "appliedModelHash": applied,
	})
	if err != nil {
		t.Fatal(err)
	}
	stream := string(header) + "\n" +
		`{"values":{"title":"no-kind"}}` + "\n" +
		// 一行里粘了两个对象：第二个绝不能被静默丢弃。
		`{"kind":"record","values":{"title":"first"}}{"kind":"record","values":{"title":"second"}}` + "\n" +
		`{"kind":"record","values":{"title":"proper"}}` + "\n"
	summary, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(stream))
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if summary.Created != 1 || summary.Failed != 2 {
		t.Fatalf("import summary = %+v, want 1 created and 2 failed", summary)
	}
	for _, result := range summary.Results {
		if result.Status == "failed" && result.Code != "INVALID_ARGUMENT" {
			t.Fatalf("failed result = %+v, want INVALID_ARGUMENT", result)
		}
	}
	page, err := fixture.records.List(ctx, collection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["title"] != "proper" {
		t.Fatalf("imported Records = %+v, want only the well formed one", page.Data)
	}
}

// TestCollectCollectionsRefusesToTruncateTheAppliedModel 证明 Applied Model 读取在超过
// Contract 上限时明确失败，而不是静默丢弃一部分 Collection——静默截断会让 appliedModelHash
// 描述一个不完整的模型，从而让 import 的 model compatibility gate 失效。
type pagedCollections struct {
	total int
}

func (source pagedCollections) ListCollections(_ context.Context, options backendmodel.ListOptions) (backendmodel.Page[backendmodel.Collection], error) {
	start := 0
	if options.Cursor != "" {
		parsed, err := strconv.Atoi(options.Cursor)
		if err != nil {
			return backendmodel.Page[backendmodel.Collection]{}, err
		}
		start = parsed
	}
	page := backendmodel.Page[backendmodel.Collection]{Data: make([]backendmodel.Collection, 0, options.Limit)}
	for index := start; index < source.total && len(page.Data) < options.Limit; index++ {
		page.Data = append(page.Data, backendmodel.Collection{ID: fmt.Sprintf("col_%032d", index), Name: fmt.Sprintf("collection-%d", index)})
	}
	if start+len(page.Data) < source.total {
		page.NextCursor = strconv.Itoa(start + len(page.Data))
	}
	return page, nil
}

func TestCollectCollectionsRefusesToTruncateTheAppliedModel(t *testing.T) {
	ctx := context.Background()
	for _, total := range []int{maximumContractCollections, maximumContractCollections + 1, maximumContractCollections*3 + 7} {
		collected, err := collectCollections(ctx, pagedCollections{total: total})
		if err != nil {
			t.Fatalf("collecting %d collections: %v", total, err)
		}
		if len(collected) != total {
			t.Fatalf("collected %d collections, want all %d", len(collected), total)
		}
	}
	// 读取仍然有界：超过安全上界时明确失败，而不是继续读或静默截断。
	if _, err := collectCollections(ctx, pagedCollections{total: maximumAppliedCollections + 1}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("error = %v, want ErrInvalidArgument above the safety bound", err)
	}
}

// TestBuildContractRefusesMoreCollectionsThanItCanDescribe 证明 Contract 的 Collection
// 上限只约束 Contract，且它是明确失败而不是静默缺少一部分 Collection。
func TestBuildContractRefusesMoreCollectionsThanItCanDescribe(t *testing.T) {
	ctx := context.Background()
	service := &Service{models: pagedCollections{total: maximumContractCollections + 1}, version: "test"}
	if _, err := service.BuildContract(ctx, nil); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("error = %v, want ErrInvalidArgument", err)
	}
	service = &Service{models: pagedCollections{total: maximumContractCollections}, version: "test"}
	contract, err := service.BuildContract(ctx, nil)
	if err != nil {
		t.Fatalf("a project at the Collection limit was rejected: %v", err)
	}
	if len(contract.Collections) != maximumContractCollections {
		t.Fatalf("contract describes %d collections, want %d", len(contract.Collections), maximumContractCollections)
	}
}

// TestBackupAndPreflightAgreeOnZeroByteAndBoundaryObjects 证明 Backup 与 Preflight 对
// 边界大小的对象给出一致结论：零字节对象合法，恰好 128 MiB 合法，再多一字节非法。
func TestBackupAndPreflightAgreeOnZeroByteAndBoundaryObjects(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		bytes    int64
		rejected bool
	}{
		{name: "empty object", bytes: 0},
		{name: "one byte", bytes: 1},
		{name: "at the object limit", bytes: int64(maximumObjectPayloadBytes)},
		{name: "one byte over the object limit", bytes: int64(maximumObjectPayloadBytes) + 1, rejected: true},
		{name: "negative length", bytes: -1, rejected: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			objects := []ObjectEntry{{Key: firstObjectKey, Bytes: testCase.bytes, SHA256: strings.Repeat("b", 64)}}
			backupErr := checkPayloadBounds(1<<20, objects)
			manifest := Manifest{
				Format: FormatName, FormatVersion: FormatVersion, ProjectID: "prj_test",
				RuntimeVersion: "test", AppliedModelHash: strings.Repeat("a", 64),
				Database: DatabaseEntry{Path: DatabaseArchivePath, Bytes: 1 << 20, SHA256: strings.Repeat("c", 64)},
				Objects:  objects,
			}
			_, findings, planErr := planBundle(manifest)
			preflightRejects := planErr != nil
			for _, finding := range findings {
				if finding.Severity == "error" {
					preflightRejects = true
				}
			}
			if testCase.rejected {
				if backupErr == nil {
					t.Fatal("backup accepted an object size the bundle cannot carry")
				}
				if !preflightRejects {
					t.Fatal("preflight accepted an object size backup rejects")
				}
				return
			}
			if backupErr != nil {
				t.Fatalf("backup rejected a legal object size: %v", backupErr)
			}
			if preflightRejects {
				t.Fatalf("preflight rejected a legal object size: %v %+v", planErr, findings)
			}
		})
	}
}

// TestArchiveEntryBoundAccommodatesAFullBundle 证明归档条目上限容得下一个满载的 bundle：
// manifest + 数据库载荷 + 上限数量的 File object。
func TestArchiveEntryBoundAccommodatesAFullBundle(t *testing.T) {
	if int(maximumArchiveEntries) < maximumBundleObjects+2 {
		t.Fatalf("maximumArchiveEntries = %d cannot hold %d objects plus a manifest and a database payload", maximumArchiveEntries, maximumBundleObjects)
	}
	// 边界必须能被真正走到：恰好到达对象上限的 manifest 合法，再多一个不合法。
	// 两者结合才能保证「Backup 允许的满载 bundle 一定能通过 Preflight 的条目计数」。
	objects := make([]ObjectEntry, 0, maximumBundleObjects+1)
	for index := 0; index < maximumBundleObjects; index++ {
		objects = append(objects, ObjectEntry{Key: fmt.Sprintf("obj_%032x", index), Bytes: 1, SHA256: strings.Repeat("b", 64)})
	}
	base := Manifest{
		Format: FormatName, FormatVersion: FormatVersion, ProjectID: "prj_test",
		RuntimeVersion: "test", AppliedModelHash: strings.Repeat("a", 64),
		Database: DatabaseEntry{Path: DatabaseArchivePath, Bytes: 1 << 20, SHA256: strings.Repeat("c", 64)},
		Objects:  objects,
	}
	if _, findings, err := planBundle(base); err != nil {
		t.Fatalf("a manifest at the object limit was rejected: %v", err)
	} else {
		for _, finding := range findings {
			if finding.Code == "object.invalidSize" || finding.Code == "object.invalidKey" || finding.Code == "object.invalidDigest" {
				t.Fatalf("a manifest at the object limit produced %+v", finding)
			}
		}
	}
	overLimit := base
	overLimit.Objects = append(append([]ObjectEntry(nil), objects...), ObjectEntry{Key: fmt.Sprintf("obj_%032x", maximumBundleObjects), Bytes: 1, SHA256: strings.Repeat("b", 64)})
	if _, _, err := planBundle(overLimit); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("error = %v, want ErrPayloadTooLarge one object past the limit", err)
	}
}

// ---------------------------------------------------------------- P2: Import model hash gate

// TestImportRequiresAnAppliedModelHash 证明 model compatibility gate 不能被绕过。
func TestImportRequiresAnAppliedModelHash(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	applied, err := fixture.service.AppliedModelHash(ctx)
	if err != nil {
		t.Fatal(err)
	}

	header := func(hash string) string {
		line := map[string]any{"kind": "collection", "collectionId": collection.ID, "name": collection.Name, "type": "Normal"}
		if hash != "" {
			line["appliedModelHash"] = hash
		}
		encoded, err := json.Marshal(line)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	record := `{"kind":"record","values":{"title":"imported"}}`

	t.Run("missing hash is rejected as an invalid request", func(t *testing.T) {
		_, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(header("")+"\n"+record+"\n"))
		if !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("import error = %v, want ErrInvalidArgument", err)
		}
	})
	t.Run("empty hash is rejected as an invalid request", func(t *testing.T) {
		_, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(header("   ")+"\n"+record+"\n"))
		if !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("import error = %v, want ErrInvalidArgument", err)
		}
	})
	t.Run("a different hash is a model mismatch", func(t *testing.T) {
		_, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(header(strings.Repeat("0", 64))+"\n"+record+"\n"))
		if !errors.Is(err, ErrModelMismatch) {
			t.Fatalf("import error = %v, want ErrModelMismatch", err)
		}
	})
	t.Run("the applied hash imports", func(t *testing.T) {
		summary, err := fixture.service.ImportStream(ctx, fixture.records, fixture.models, collection.ID, strings.NewReader(header(applied)+"\n"+record+"\n"))
		if err != nil {
			t.Fatalf("import: %v", err)
		}
		if summary.Created != 1 || summary.Failed != 0 {
			t.Fatalf("import summary = %+v", summary)
		}
	})
}

// ---------------------------------------------------------------- 测试工具

// buildModelryDatabase 产生一个真实的、可被 preflight 接受的 Modelry 项目数据库。
func buildModelryDatabase(t *testing.T) []byte {
	t.Helper()
	databasePath := filepath.Join(t.TempDir(), "project.sqlite")
	store, _, _, err := openProject(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

// writeBundle 按 Spec 0010 的固定布局写出一个 bundle，用于精确构造边界场景。
func writeBundle(t *testing.T, directory, name string, manifest Manifest, database []byte, objects map[string][]byte) string {
	t.Helper()
	path := filepath.Join(directory, name)
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	writeEntry := func(entryName string, payload []byte) {
		if err := writer.WriteHeader(&tar.Header{Name: entryName, Mode: 0o600, Size: int64(len(payload)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(payload); err != nil {
			t.Fatal(err)
		}
	}
	writeEntry(ManifestPath, encoded)
	if database != nil {
		writeEntry(DatabaseArchivePath, database)
	}
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		writeEntry(ObjectsArchivePrefix+key, objects[key])
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// appendArchiveEntry 复制一个 bundle 并追加一个未列出的条目。
func appendArchiveEntry(sourcePath, destinationPath, name string, payload []byte) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.Create(destinationPath)
	if err != nil {
		return err
	}
	writer := tar.NewWriter(destination)
	reader := tar.NewReader(source)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			_ = destination.Close()
			return err
		}
		copied := &tar.Header{Name: header.Name, Mode: header.Mode, Size: header.Size, Typeflag: tar.TypeReg}
		if err := writer.WriteHeader(copied); err != nil {
			_ = destination.Close()
			return err
		}
		if _, err := io.Copy(writer, reader); err != nil {
			_ = destination.Close()
			return err
		}
	}
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(payload)), Typeflag: tar.TypeReg}); err != nil {
		_ = destination.Close()
		return err
	}
	if _, err := writer.Write(payload); err != nil {
		_ = destination.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		_ = destination.Close()
		return err
	}
	return destination.Close()
}

func digestOf(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func hasFinding(preflight Preflight, code string) bool {
	for _, finding := range preflight.Findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}

func writePatternFile(t *testing.T, path string, size int) error {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	block := make([]byte, 1<<20)
	for index := range block {
		block[index] = byte(index % 251)
	}
	written := 0
	for written < size {
		chunk := block
		if remaining := size - written; remaining < len(chunk) {
			chunk = chunk[:remaining]
		}
		if _, err := file.Write(chunk); err != nil {
			_ = file.Close()
			return err
		}
		written += len(chunk)
	}
	return file.Close()
}

func copyPath(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}
