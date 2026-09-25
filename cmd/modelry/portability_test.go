package main

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
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/portability"
	modelryproject "github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/records"
	modelryruntime "github.com/liujingwen1225/modelry/internal/runtime"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// cliLargeObjectBytes 超过 manifest 的 64 MiB 上限，但仍在 128 MiB 的单对象上限内。
const cliLargeObjectBytes = 70 << 20

const cliObjectKey = "obj_44444444444444444444444444444444"

// cliProject 是一个已经停止、可以被 CLI 备份的项目根目录。
type cliProject struct {
	root         string
	managed      string
	objects      string
	collectionID string
}

// newCLIProject 建立一个带 file Field 的真实项目，并写入一个真实的 File object。
func newCLIProject(t *testing.T, objectBytes []byte) cliProject {
	t.Helper()
	ctx := context.Background()
	project := cliProject{root: t.TempDir()}
	project.managed = filepath.Join(project.root, ".modelry")
	project.objects = filepath.Join(project.managed, "files", "objects")
	tempDir := filepath.Join(project.managed, "files", "tmp")
	for _, directory := range []string{project.managed, project.objects, tempDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	store, err := storage.Open(filepath.Join(project.managed, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	recordService, err := records.NewWithLocalFiles(store, models, tempDir, project.objects)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "title", Type: backendmodel.FieldTypeText, Required: true},
			{Name: "attachment", Type: backendmodel.FieldTypeFile},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project.objects, cliObjectKey), objectBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "ported", "attachment": cliObjectKey}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	project.collectionID = collection.ID
	return project
}

func (project cliProject) database() string {
	return filepath.Join(project.managed, "project.sqlite")
}

func sha256Of(t *testing.T, path string) string {
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

// readCLIManifest 从 CLI 写出的 bundle 里读出 manifest。
func readCLIManifest(t *testing.T, bundlePath string) map[string]any {
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
			t.Fatal(err)
		}
		if header.Name != "manifest.json" {
			continue
		}
		var manifest map[string]any
		if err := json.NewDecoder(reader).Decode(&manifest); err != nil {
			t.Fatal(err)
		}
		return manifest
	}
	t.Fatal("the bundle has no manifest")
	return nil
}

// TestPortabilityCLIRoundTripsALargeFileObject 证明一个 >64 MiB 的 File object
// 可以经由真实 CLI 完成 Backup -> Preflight -> Restore。
func TestPortabilityCLIRoundTripsALargeFileObject(t *testing.T) {
	source := newCLIProject(t, cliPattern(cliLargeObjectBytes))
	sourceDigest := sha256Of(t, filepath.Join(source.objects, cliObjectKey))

	bundlePath := filepath.Join(source.root, "bundle.tar")
	var backupOut, backupErr bytes.Buffer
	if code := run([]string{"backup", "--project-root", source.root, "--out", bundlePath}, &backupOut, &backupErr); code != 0 {
		t.Fatalf("backup exited %d: %s", code, backupErr.String())
	}
	manifest := readCLIManifest(t, bundlePath)
	objects, _ := manifest["objects"].([]any)
	if len(objects) != 1 {
		t.Fatalf("manifest objects = %v", manifest["objects"])
	}
	entry, _ := objects[0].(map[string]any)
	if bytes, _ := entry["bytes"].(float64); int64(bytes) != int64(cliLargeObjectBytes) {
		t.Fatalf("manifest object bytes = %v, want %d", entry["bytes"], int64(cliLargeObjectBytes))
	}

	var preflightOut, preflightErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", source.root, "--from", bundlePath, "--preflight"}, &preflightOut, &preflightErr); code != 0 {
		t.Fatalf("preflight exited %d: %s", code, preflightErr.String())
	}
	if !strings.Contains(preflightOut.String(), `"compatible":true`) {
		t.Fatalf("preflight output = %s", preflightOut.String())
	}

	targetRoot := t.TempDir()
	var restoreOut, restoreErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", targetRoot, "--from", bundlePath}, &restoreOut, &restoreErr); code != 0 {
		t.Fatalf("restore exited %d: %s", code, restoreErr.String())
	}
	restored := filepath.Join(targetRoot, ".modelry", "files", "objects", cliObjectKey)
	if digest := sha256Of(t, restored); digest != sourceDigest {
		t.Fatalf("restored large object sha256 = %s, want %s", digest, sourceDigest)
	}
	restoredStore, err := storage.Open(filepath.Join(targetRoot, ".modelry", "project.sqlite"))
	if err != nil {
		t.Fatalf("open the restored project: %v", err)
	}
	defer restoredStore.Close()
	if count, err := restoredStore.ProjectedRecordCount(context.Background()); err != nil || count != 1 {
		t.Fatalf("restored Record count = %d (%v), want 1", count, err)
	}
}

// TestPortabilityCLIRestoreIsAllOrNothing 证明真实 CLI 的 restore 在 object 阶段
// 失败时不会留下半恢复的项目。
func TestPortabilityCLIRestoreIsAllOrNothing(t *testing.T) {
	source := newCLIProject(t, []byte("source-attachment-bytes"))
	bundlePath := filepath.Join(source.root, "bundle.tar")
	var backupOut, backupErr bytes.Buffer
	if code := run([]string{"backup", "--project-root", source.root, "--out", bundlePath}, &backupOut, &backupErr); code != 0 {
		t.Fatalf("backup exited %d: %s", code, backupErr.String())
	}

	target := newCLIProject(t, []byte("target-attachment-bytes"))
	beforeDatabase := sha256Of(t, target.database())

	// object 目录的位置被一个普通文件占住：restore 的 object 阶段必然失败。
	if err := os.RemoveAll(target.objects); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target.objects, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	var restoreOut, restoreErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", target.root, "--from", bundlePath, "--force"}, &restoreOut, &restoreErr); code == 0 {
		t.Fatal("restore reported success although its object store is unusable")
	}
	if after := sha256Of(t, target.database()); after != beforeDatabase {
		t.Fatalf("a failed restore replaced the database anyway: %s -> %s", beforeDatabase, after)
	}
	contents, err := os.ReadFile(target.objects)
	if err != nil || string(contents) != "not a directory" {
		t.Fatalf("a failed restore changed the object store location: %q %v", contents, err)
	}
	if _, err := os.Stat(filepath.Join(target.managed, "restore-journal.jsonl")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the restore journal was not cleaned up: %v", err)
	}
	reopened, err := storage.Open(target.database())
	if err != nil {
		t.Fatalf("the untouched project is not usable: %v", err)
	}
	defer reopened.Close()
	if count, err := reopened.ProjectedRecordCount(context.Background()); err != nil || count != 1 {
		t.Fatalf("Records after a failed restore = %d (%v), want 1", count, err)
	}
}

func TestPortabilityCLIAcceptsAmbiguousLegacyStateBeforeRetry(t *testing.T) {
	source := newCLIProject(t, []byte("bundle-file-bytes"))
	bundlePath := filepath.Join(source.root, "bundle.tar")
	var backupOut, backupErr bytes.Buffer
	if code := run([]string{"backup", "--project-root", source.root, "--out", bundlePath}, &backupOut, &backupErr); code != 0 {
		t.Fatalf("backup exited %d: %s", code, backupErr.String())
	}

	target := newCLIProject(t, []byte("previous-project-file"))
	originalDatabase, err := os.ReadFile(target.database())
	if err != nil {
		t.Fatal(err)
	}
	legacyBackup := target.database() + ".legacy.old"
	if err := os.Rename(target.database(), legacyBackup); err != nil {
		t.Fatal(err)
	}
	possiblyActivated := []byte("legacy activated database")
	if err := os.WriteFile(target.database(), possiblyActivated, 0o600); err != nil {
		t.Fatal(err)
	}
	legacyJournal := fmt.Sprintf(
		"{\"op\":\"stage\",\"dest\":%q,\"path\":%q}\n"+
			"{\"op\":\"backup\",\"dest\":%q,\"path\":%q}\n"+
			"{\"op\":\"activate\",\"dest\":%q,\"path\":%q}\n"+
			"{\"op\":\"done\"}\n",
		target.database(), target.database()+".legacy.new",
		target.database(), legacyBackup,
		target.database(), target.database()+".legacy.new",
	)
	if err := os.WriteFile(filepath.Join(target.managed, portability.RestoreJournalName), []byte(legacyJournal), 0o600); err != nil {
		t.Fatal(err)
	}

	var refusedOut, refusedErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", target.root, "--from", bundlePath, "--force"}, &refusedOut, &refusedErr); code == 0 {
		t.Fatal("restore guessed how to recover an ambiguous legacy journal")
	}
	if got, err := os.ReadFile(target.database()); err != nil || !bytes.Equal(got, possiblyActivated) {
		t.Fatalf("refused restore changed the active legacy database: %q (%v)", got, err)
	}
	if got, err := os.ReadFile(legacyBackup); err != nil || !bytes.Equal(got, originalDatabase) {
		t.Fatalf("refused restore changed the legacy backup: %q (%v)", got, err)
	}

	var restoreOut, restoreErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", target.root, "--from", bundlePath, "--force", "--resolve-legacy-restore=accept-current"}, &restoreOut, &restoreErr); code != 0 {
		t.Fatalf("explicit legacy-state acceptance and restore exited %d: %s", code, restoreErr.String())
	}
	if got, err := os.ReadFile(filepath.Join(target.objects, cliObjectKey)); err != nil || !bytes.Equal(got, []byte("bundle-file-bytes")) {
		t.Fatalf("restored File object = %q (%v)", got, err)
	}
	startStopCLIRuntime(t, target.root)
}

// TestPortabilityCLIRefusesToBackupOrGenerateDuringAnInterruptedRestore 证明一个半恢复
// 的项目不会被 CLI 当成空项目打开：那会创建一个全新的空项目，并产出一份看起来合法、
// 实际是空的备份。
func TestPortabilityCLIRefusesToBackupOrGenerateDuringAnInterruptedRestore(t *testing.T) {
	source := newCLIProject(t, []byte("attachment-bytes"))
	journal := filepath.Join(source.managed, portability.RestoreJournalName)
	if err := os.WriteFile(journal, []byte(`{"op":"absent","dest":"nowhere"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(source.root, "bundle.tar")

	var backupOut, backupErr bytes.Buffer
	if code := run([]string{"backup", "--project-root", source.root, "--out", bundlePath}, &backupOut, &backupErr); code == 0 {
		t.Fatal("backup succeeded during an interrupted restore")
	}
	if !strings.Contains(backupErr.String(), "interrupted restore") {
		t.Fatalf("backup error = %s", backupErr.String())
	}
	if _, err := os.Stat(bundlePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused backup still wrote a bundle: %v", err)
	}

	var generateOut, generateErr bytes.Buffer
	if code := run([]string{"generate", "--project-root", source.root, "--out", t.TempDir()}, &generateOut, &generateErr); code == 0 {
		t.Fatal("generate succeeded during an interrupted restore")
	}
	if !strings.Contains(generateErr.String(), "interrupted restore") {
		t.Fatalf("generate error = %s", generateErr.String())
	}

	// 收敛之后同一个项目必须恢复可用。
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if code := run([]string{"backup", "--project-root", source.root, "--out", bundlePath}, &backupOut, &backupErr); code != 0 {
		t.Fatalf("backup after the journal was cleared exited %d: %s", code, backupErr.String())
	}
	if _, err := os.Stat(bundlePath); err != nil {
		t.Fatalf("backup after the journal was cleared produced no bundle: %v", err)
	}
}

const (
	cliS3AccessKey = "modelry-backup-test-access-marker"
	cliS3SecretKey = "modelry-backup-test-secret-marker"
	cliS3Bucket    = "modelry-backup-test"
	cliS3Prefix    = "modelry"
)

type cliS3Fixture struct {
	server    *httptest.Server
	accessKey string
	mu        sync.Mutex
	objects   map[string][]byte
}

func newCLIS3Fixture(t *testing.T) *cliS3Fixture {
	t.Helper()
	fixture := &cliS3Fixture{accessKey: cliS3AccessKey, objects: make(map[string][]byte)}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := r.Header.Get("Authorization")
		if !strings.Contains(authorization, "Credential="+fixture.accessKey+"/") || !strings.Contains(authorization, "Signature=") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		bucketPath := "/" + cliS3Bucket
		if r.URL.Path == bucketPath && r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2" {
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`)
			return
		}
		if !strings.HasPrefix(r.URL.Path, bucketPath+"/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, bucketPath+"/")
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			payload, err := io.ReadAll(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fixture.objects[key] = payload
			w.WriteHeader(http.StatusOK)
		case http.MethodHead:
			payload, ok := fixture.objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
			w.Header().Set("Content-Type", "application/octet-stream")
		case http.MethodGet:
			payload, ok := fixture.objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(payload)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (fixture *cliS3Fixture) object(key string) ([]byte, bool) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	payload, ok := fixture.objects[key]
	return append([]byte(nil), payload...), ok
}

func prepareActiveS3CLIProject(t *testing.T, objectBytes []byte) (cliProject, *cliS3Fixture, string) {
	t.Helper()
	project := newCLIProject(t, objectBytes)
	fixture := newCLIS3Fixture(t)
	rootPath := project.root
	root, err := modelryproject.ResolveRoot(modelryproject.RootConfig{FlagPath: &rootPath, WorkingDir: project.root})
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(project.database())
	if err != nil {
		t.Fatal(err)
	}
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	secrets, err := extensions.NewService(context.Background(), store, models, extensions.ServiceOptions{ManagedDir: root.ManagedDir, ProjectID: store.ProjectID()})
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	accessSecret, err := secrets.CreateSecret(context.Background(), "S3 access key", cliS3AccessKey)
	if err != nil {
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatal(err)
	}
	secretSecret, err := secrets.CreateSecret(context.Background(), "S3 secret key", cliS3SecretKey)
	if err != nil {
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatal(err)
	}
	files, err := newCLIFileStorage(root, store, models, secrets)
	if err != nil {
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatal(err)
	}
	settings := filestore.S3Settings{
		Endpoint: fixture.server.URL, Region: "us-east-1", Bucket: cliS3Bucket,
		KeyPrefix: cliS3Prefix, PathStyle: true,
		AccessKeySecretID: accessSecret.ID, SecretKeySecretID: secretSecret.ID,
	}
	migration, err := files.StartMigration(context.Background(), filestore.ProviderS3, &settings)
	if err != nil {
		_ = files.Close(context.Background())
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatalf("start Local to S3 migration: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for migration.Status == filestore.MigrationPending || migration.Status == filestore.MigrationRunning {
		if time.Now().After(deadline) {
			_ = files.Close(context.Background())
			_ = secrets.Close(context.Background())
			_ = store.Close()
			t.Fatal("Local to S3 migration did not finish")
		}
		time.Sleep(10 * time.Millisecond)
		migration, err = files.Migration(context.Background(), migration.ID)
		if err != nil {
			_ = files.Close(context.Background())
			_ = secrets.Close(context.Background())
			_ = store.Close()
			t.Fatalf("read Local to S3 migration: %v", err)
		}
	}
	if migration.Status != filestore.MigrationCompleted {
		_ = files.Close(context.Background())
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatalf("Local to S3 migration status = %s (%s)", migration.Status, migration.Message)
	}
	provider, err := files.ActiveProvider(context.Background())
	if err != nil || provider.Name() != string(filestore.ProviderS3) {
		_ = files.Close(context.Background())
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatalf("active Provider = %v (%v), want S3", provider, err)
	}
	remote, ok := fixture.object(cliS3Prefix + "/" + cliObjectKey)
	if !ok || !bytes.Equal(remote, objectBytes) {
		_ = files.Close(context.Background())
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatalf("S3 migration stored %q (%t), want the referenced object bytes", remote, ok)
	}
	if err := os.Remove(filepath.Join(project.objects, cliObjectKey)); err != nil {
		_ = files.Close(context.Background())
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatalf("remove the Local copy after completed migration: %v", err)
	}
	if err := files.Close(context.Background()); err != nil {
		_ = secrets.Close(context.Background())
		_ = store.Close()
		t.Fatal(err)
	}
	if err := secrets.Close(context.Background()); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	return project, fixture, secretSecret.ID
}

func TestPortabilityCLIBackupReadsActiveS3AndRestoresTheFileObject(t *testing.T) {
	objectBytes := []byte("referenced object that exists only in S3")
	source, s3, _ := prepareActiveS3CLIProject(t, objectBytes)
	if _, err := os.Stat(filepath.Join(source.objects, cliObjectKey)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Local object copy still exists before backup: %v", err)
	}
	// Start and stop the real Runtime around the active S3 configuration before invoking CLI backup.
	startStopCLIRuntime(t, source.root)

	bundlePath := filepath.Join(source.root, "active-s3-backup.tar")
	var backupOut, backupErr bytes.Buffer
	if code := run([]string{"backup", "--project-root", source.root, "--out", bundlePath}, &backupOut, &backupErr); code != 0 {
		t.Fatalf("S3-backed CLI backup exited %d: %s", code, backupErr.String())
	}
	manifest := readCLIManifest(t, bundlePath)
	objects, ok := manifest["objects"].([]any)
	if !ok || len(objects) != 1 {
		t.Fatalf("S3 backup manifest objects = %v", manifest["objects"])
	}
	entry, _ := objects[0].(map[string]any)
	if entry["key"] != cliObjectKey || int64(entry["bytes"].(float64)) != int64(len(objectBytes)) {
		t.Fatalf("S3 backup manifest entry = %#v", entry)
	}
	objectPath := "objects/" + cliObjectKey
	archived, err := readCLIBundleEntry(t, bundlePath, objectPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(objectBytes)
	if !bytes.Equal(archived, objectBytes) || entry["sha256"] != hex.EncodeToString(digest[:]) {
		t.Fatalf("bundle S3 object bytes/digest do not match the active Provider object")
	}
	if got, ok := s3.object(cliS3Prefix + "/" + cliObjectKey); !ok || !bytes.Equal(got, objectBytes) {
		t.Fatal("the S3-compatible fixture no longer contains the source object")
	}

	targetRoot := t.TempDir()
	var preflightOut, preflightErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", targetRoot, "--from", bundlePath, "--preflight"}, &preflightOut, &preflightErr); code != 0 {
		t.Fatalf("S3 bundle preflight exited %d: %s", code, preflightErr.String())
	}
	if !strings.Contains(preflightOut.String(), `"compatible":true`) {
		t.Fatalf("S3 bundle preflight = %s", preflightOut.String())
	}
	var restoreOut, restoreErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", targetRoot, "--from", bundlePath}, &restoreOut, &restoreErr); code != 0 {
		t.Fatalf("S3 bundle restore exited %d: %s", code, restoreErr.String())
	}
	startStopCLIRuntime(t, targetRoot)

	store, err := storage.Open(filepath.Join(targetRoot, ".modelry", "project.sqlite"))
	if err != nil {
		t.Fatalf("open project after Runtime restart: %v", err)
	}
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	objectsDir := filepath.Join(targetRoot, ".modelry", "files", "objects")
	recordsService, err := records.NewWithLocalFiles(store, models, filepath.Join(targetRoot, ".modelry", "files", "tmp"), objectsDir)
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	page, err := recordsService.List(context.Background(), source.collectionID, records.ListOptions{Limit: 10})
	if err != nil {
		_ = store.Close()
		t.Fatalf("read restored Records after Runtime restart: %v", err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["attachment"] != cliObjectKey {
		_ = store.Close()
		t.Fatalf("restored File Record reference = %#v", page.Data)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restoredObject := filepath.Join(objectsDir, cliObjectKey)
	if got, err := os.ReadFile(restoredObject); err != nil || !bytes.Equal(got, objectBytes) {
		t.Fatalf("restored Local object = %q (%v), want the original S3 bytes", got, err)
	}
}

func TestPortabilityCLIBackupFailsClosedForMissingS3CredentialAndUnavailableS3(t *testing.T) {
	t.Run("missing credential does not fall back to Local", func(t *testing.T) {
		project, _, secretID := prepareActiveS3CLIProject(t, []byte("only-in-S3"))
		store, err := storage.Open(project.database())
		if err != nil {
			t.Fatal(err)
		}
		if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
			_, err := tx.ExecContext(context.Background(), `DELETE FROM modelry_secrets WHERE id=?`, secretID)
			return err
		}); err != nil {
			_ = store.Close()
			t.Fatal(err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
		decoy := []byte("incorrect Local fallback decoy")
		if err := os.WriteFile(filepath.Join(project.objects, cliObjectKey), decoy, 0o600); err != nil {
			t.Fatal(err)
		}
		bundlePath := filepath.Join(project.root, "missing-secret.tar")
		var stdout, stderr bytes.Buffer
		if code := run([]string{"backup", "--project-root", project.root, "--out", bundlePath}, &stdout, &stderr); code == 0 {
			t.Fatal("backup succeeded after its active S3 Secret was removed")
		}
		assertCLIBackupFailureIsRedacted(t, bundlePath, stdout.String(), stderr.String())
	})

	t.Run("unavailable S3 does not fall back to Local", func(t *testing.T) {
		project, fixture, _ := prepareActiveS3CLIProject(t, []byte("only-in-S3"))
		fixture.server.Close()
		decoy := []byte("incorrect Local fallback decoy")
		if err := os.WriteFile(filepath.Join(project.objects, cliObjectKey), decoy, 0o600); err != nil {
			t.Fatal(err)
		}
		bundlePath := filepath.Join(project.root, "unavailable-s3.tar")
		var stdout, stderr bytes.Buffer
		if code := run([]string{"backup", "--project-root", project.root, "--out", bundlePath}, &stdout, &stderr); code == 0 {
			t.Fatal("backup succeeded by using the Local decoy while active S3 was unavailable")
		}
		assertCLIBackupFailureIsRedacted(t, bundlePath, stdout.String(), stderr.String())
	})
}

func assertCLIBackupFailureIsRedacted(t *testing.T, bundlePath, stdout, stderr string) {
	t.Helper()
	if _, err := os.Stat(bundlePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed S3 backup left a bundle: %v", err)
	}
	combined := stdout + stderr
	for _, secret := range []string{cliS3AccessKey, cliS3SecretKey, "Authorization", "X-Amz-Signature", "X-Amz-Security-Token"} {
		if strings.Contains(combined, secret) {
			t.Fatalf("backup failure output leaked %q: %s", secret, combined)
		}
	}
}

func startStopCLIRuntime(t *testing.T, projectRoot string) {
	t.Helper()
	path := projectRoot
	instance, err := modelryruntime.New(modelryruntime.Options{
		ProjectRoot: modelryproject.RootConfig{FlagPath: &path, WorkingDir: projectRoot}, Version: "test",
	})
	if err != nil {
		t.Fatalf("start Runtime for %s: %v", projectRoot, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	ready := make(chan net.Addr, 1)
	go func() { done <- instance.Run(ctx, "127.0.0.1:0", func(address net.Addr) { ready <- address }) }()
	select {
	case <-ready:
	case err := <-done:
		cancel()
		t.Fatalf("Runtime exited before ready: %v", err)
	case <-time.After(10 * time.Second):
		cancel()
		_ = instance.Close()
		t.Fatal("Runtime did not become ready")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("stop Runtime for %s: %v", projectRoot, err)
		}
	case <-time.After(10 * time.Second):
		_ = instance.Close()
		t.Fatal("Runtime did not stop")
	}
}

func readCLIBundleEntry(t *testing.T, bundlePath, name string) ([]byte, error) {
	t.Helper()
	file, err := os.Open(bundlePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := tar.NewReader(file)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil, os.ErrNotExist
		}
		if err != nil {
			return nil, err
		}
		if header.Name == name {
			return io.ReadAll(reader)
		}
	}
}

func cliPattern(size int) []byte {
	payload := make([]byte, size)
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	return payload
}

// TestPortabilityCLIBackupPreflightGenerateAndRestore 覆盖 CLI 的 backup / restore --preflight /
// generate 与 restore apply 的真实文件系统行为。
func TestPortabilityCLIBackupPreflightGenerateAndRestore(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	managed := filepath.Join(root, ".modelry")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(filepath.Join(managed, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	bundlePath := filepath.Join(root, "bundle.tar")
	var backupOut, backupErr bytes.Buffer
	if code := run([]string{"backup", "--project-root", root, "--out", bundlePath}, &backupOut, &backupErr); code != 0 {
		t.Fatalf("backup exited %d: %s", code, backupErr.String())
	}
	if _, err := os.Stat(bundlePath); err != nil {
		t.Fatalf("backup bundle missing: %v", err)
	}
	var summary struct {
		Bundle         string `json:"bundle"`
		Digest         string `json:"digest"`
		Collections    int64  `json:"collections"`
		RuntimeVersion string `json:"runtimeVersion"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(backupOut.Bytes()), &summary); err != nil {
		t.Fatalf("backup summary = %s", backupOut.String())
	}
	if summary.Collections != 1 || len(summary.Digest) != 64 || summary.RuntimeVersion == "" {
		t.Fatalf("backup summary = %+v", summary)
	}

	var preflightOut, preflightErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", root, "--from", bundlePath, "--preflight"}, &preflightOut, &preflightErr); code != 0 {
		t.Fatalf("restore preflight exited %d: %s", code, preflightErr.String())
	}
	if !strings.Contains(preflightOut.String(), `"compatible":true`) {
		t.Fatalf("preflight output = %s", preflightOut.String())
	}

	// restore apply 到另一个 root 必须成功；缺少 --force 时不得覆盖已有项目。
	secondRoot := t.TempDir()
	var restoreOut, restoreErr bytes.Buffer
	if code := run([]string{"restore", "--project-root", secondRoot, "--from", bundlePath}, &restoreOut, &restoreErr); code != 0 {
		t.Fatalf("restore exited %d: %s", code, restoreErr.String())
	}
	restored, err := storage.Open(filepath.Join(secondRoot, ".modelry", "project.sqlite"))
	if err != nil {
		t.Fatalf("open restored project: %v", err)
	}
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}
	var forceErr bytes.Buffer
	var forceOut bytes.Buffer
	if code := run([]string{"restore", "--project-root", secondRoot, "--from", bundlePath}, &forceOut, &forceErr); code == 0 {
		t.Fatal("restore overwrote an existing project without --force")
	}
	if !strings.Contains(forceErr.String(), "--force") {
		t.Fatalf("restore refusal message = %s", forceErr.String())
	}
	if code := run([]string{"restore", "--project-root", secondRoot, "--from", bundlePath, "--force"}, &forceOut, &forceErr); code != 0 {
		t.Fatalf("forced restore exited %d: %s", code, forceErr.String())
	}

	// generate：产物可复现且带版本标识。
	firstOut := filepath.Join(t.TempDir(), "client-a")
	secondOut := filepath.Join(t.TempDir(), "client-b")
	for _, directory := range []string{firstOut, secondOut} {
		var generateOut, generateErr bytes.Buffer
		if code := run([]string{"generate", "--project-root", secondRoot, "--out", directory}, &generateOut, &generateErr); code != 0 {
			t.Fatalf("generate exited %d: %s", code, generateErr.String())
		}
		if !strings.Contains(generateOut.String(), "contentHash") {
			t.Fatalf("generate output = %s", generateOut.String())
		}
	}
	for _, name := range []string{"application-api.json", "modelry-client.ts"} {
		first, err := os.ReadFile(filepath.Join(firstOut, name))
		if err != nil {
			t.Fatal(err)
		}
		second, err := os.ReadFile(filepath.Join(secondOut, name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(first, second) {
			t.Fatalf("%s is not reproducible", name)
		}
		if name == "modelry-client.ts" && !strings.Contains(string(first), "createModelryClient") {
			t.Fatalf("generated client = %s", first)
		}
	}
}
