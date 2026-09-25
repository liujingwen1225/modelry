package filestore

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type fakeSecrets struct{ values map[string]string }

func (secrets fakeSecrets) SecretMetadata(_ context.Context, secretID string) (string, bool, error) {
	value, exists := secrets.values[secretID]
	if !exists || value == "" {
		return "", false, ErrCredentialUnavailable
	}
	return secretID, true, nil
}

func (secrets fakeSecrets) WithSecretValue(_ context.Context, secretID string, use func([]byte) error) error {
	value, exists := secrets.values[secretID]
	if !exists || value == "" {
		return ErrCredentialUnavailable
	}
	return use([]byte(value))
}

type fakeReferences struct {
	mu   sync.Mutex
	keys []string
}

func (references *fakeReferences) ReferencedFileKeys(context.Context) ([]string, error) {
	references.mu.Lock()
	defer references.mu.Unlock()
	return append([]string(nil), references.keys...), nil
}

func (references *fakeReferences) set(keys ...string) {
	references.mu.Lock()
	defer references.mu.Unlock()
	references.keys = append([]string(nil), keys...)
}

type fakeStaging struct{ dir string }

func (staging fakeStaging) NewMigrationStagingFile() (*os.File, string, error) {
	file, err := os.CreateTemp(staging.dir, "mig_*")
	if err != nil {
		return nil, "", err
	}
	return file, file.Name(), nil
}

type storageFixture struct {
	service    *Service
	store      *storage.Store
	references *fakeReferences
	objectsDir string
	stagingDir string
}

func newStorageFixture(t *testing.T, keys ...string) storageFixture {
	t.Helper()
	root := t.TempDir()
	objectsDir := filepath.Join(root, "objects")
	stagingDir := filepath.Join(root, "tmp")
	for _, directory := range []string{objectsDir, stagingDir} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	store, err := storage.Open(filepath.Join(root, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	references := &fakeReferences{}
	references.set(keys...)
	service, err := NewService(context.Background(), ServiceOptions{
		Store: store, Secrets: fakeSecrets{values: map[string]string{"sec_access": "ACCESSKEYEXAMPLE", "sec_secret": "secret-key-example"}},
		Audits: audits, References: references, Staging: fakeStaging{dir: stagingDir}, ObjectsDir: objectsDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	return storageFixture{service: service, store: store, references: references, objectsDir: objectsDir, stagingDir: stagingDir}
}

func (fixture storageFixture) writeObject(t *testing.T, key, contents string, age time.Duration) {
	t.Helper()
	path := filepath.Join(fixture.objectsDir, key)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if age > 0 {
		when := time.Now().Add(-age)
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
	}
}

func objectKey(seed byte) string { return "obj_" + strings.Repeat(string(rune(seed)), 32) }

func waitForMigration(t *testing.T, service *Service, id string) Migration {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		migration, err := service.Migration(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		switch migration.Status {
		case MigrationCompleted, MigrationFailed, MigrationCancelled, MigrationInterrupted:
			return migration
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("migration %s did not finish in time", id)
	return Migration{}
}

func TestNewServiceDefaultsToLocalProvider(t *testing.T) {
	key := objectKey('a')
	fixture := newStorageFixture(t, key)
	fixture.writeObject(t, key, "payload", 0)
	status, err := fixture.service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Config.Provider != ProviderLocal || status.Config.Revision != 1 || status.ProviderLabel != "Local" {
		t.Fatalf("default status = %+v", status)
	}
	if status.ProviderState != StateReady || status.Referenced != 1 || status.Migration != nil {
		t.Fatalf("default health = %+v", status)
	}
	provider, err := fixture.service.ActiveProvider(context.Background())
	if err != nil || provider.Name() != "local" {
		t.Fatalf("active provider = %v err=%v", provider, err)
	}
}

func TestConfigureRequiresMigrationForReferencedObjects(t *testing.T) {
	key := objectKey('b')
	fixture := newStorageFixture(t, key)
	fixture.writeObject(t, key, "payload", 0)
	settings := S3Settings{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "modelry", AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}
	if _, err := fixture.service.Configure(context.Background(), 1, ProviderS3, &settings); !errors.Is(err, ErrMigrationRequired) {
		t.Fatalf("configure with referenced objects error = %v, want ErrMigrationRequired", err)
	}
	config, err := fixture.service.currentConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Provider != ProviderLocal || config.Revision != 1 {
		t.Fatalf("rejected configuration changed the Project: %+v", config)
	}
}

func TestConfigureWithNoReferencedObjectsSwitchesProvider(t *testing.T) {
	fixture := newStorageFixture(t)
	settings := S3Settings{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "modelry", AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}
	status, err := fixture.service.Configure(context.Background(), 1, ProviderS3, &settings)
	if err == nil {
		t.Fatalf("unreachable Provider must not be accepted without a successful health probe")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("configure to unreachable provider error = %v", err)
	}
	status, err = fixture.service.Configure(context.Background(), 1, ProviderLocal, nil)
	if err != nil {
		t.Fatal(err)
	}
	if status.Config.Provider != ProviderLocal || status.Config.Revision != 2 {
		t.Fatalf("local reconfiguration = %+v", status)
	}
	if _, err := fixture.service.Configure(context.Background(), 999, ProviderLocal, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision error = %v, want ErrConflict", err)
	}
	if _, err := fixture.service.Configure(context.Background(), 3, ProviderKind("ftp"), nil); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unknown provider error = %v", err)
	}
}

func TestConfigureRejectsIncompleteS3Settings(t *testing.T) {
	fixture := newStorageFixture(t)
	settings := S3Settings{Endpoint: "http://example.com", Region: "us-east-1", Bucket: "modelry", AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}
	if _, err := fixture.service.TestS3(context.Background(), settings); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("public http endpoint error = %v", err)
	}
	settings.Endpoint = "https://s3.example.com"
	settings.AccessKeySecretID = "sec_missing"
	if _, err := fixture.service.TestS3(context.Background(), settings); !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatalf("missing credential error = %v", err)
	}
	settings.AccessKeySecretID = "sec_access"
	settings.Bucket = "Bad_Bucket"
	if _, err := fixture.service.TestS3(context.Background(), settings); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("invalid bucket error = %v", err)
	}
}

func TestMigrationCopiesReferencedObjectsAndSwitchesProvider(t *testing.T) {
	first := objectKey('c')
	second := objectKey('d')
	fixture := newStorageFixture(t, first, second)
	fixture.writeObject(t, first, "first payload", 0)
	fixture.writeObject(t, second, "second payload", 0)
	server, endpoint := newFakeS3(t, "modelry-migration")
	settings := S3Settings{Endpoint: endpoint.URL, Region: "us-east-1", Bucket: "modelry-migration", KeyPrefix: "modelry", PathStyle: true, AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}
	migration, err := fixture.service.StartMigration(context.Background(), ProviderS3, &settings)
	if err != nil {
		t.Fatal(err)
	}
	if migration.Status != MigrationPending && migration.Status != MigrationRunning {
		t.Fatalf("started migration status = %s", migration.Status)
	}
	finished := waitForMigration(t, fixture.service, migration.ID)
	if finished.Status != MigrationCompleted || finished.CopiedObjects != 2 || finished.TotalObjects != 2 {
		t.Fatalf("finished migration = %+v", finished)
	}
	config, err := fixture.service.currentConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Provider != ProviderS3 || config.Revision != 2 {
		t.Fatalf("provider after migration = %+v", config)
	}
	server.mu.Lock()
	stored := len(server.objects)
	server.mu.Unlock()
	if stored != 2 {
		t.Fatalf("fake S3 holds %d objects, want 2", stored)
	}
	// 迁移后读取路径不变：Provider 中立引用仍然直接可用。
	provider, err := fixture.service.ActiveProvider(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	file, info, err := provider.Open(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	buffer, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if string(buffer) != "first payload" || info.Size != int64(len("first payload")) {
		t.Fatalf("migrated object contents = %q size=%d", buffer, info.Size)
	}
	// 源对象不会被 migration 删除。
	if _, err := os.Stat(filepath.Join(fixture.objectsDir, first)); err != nil {
		t.Fatalf("migration deleted the source object: %v", err)
	}
}

func TestMigrationToLocalIsIdempotentForExistingObjects(t *testing.T) {
	first := objectKey('e')
	second := objectKey('f')
	fixture := newStorageFixture(t, first, second)
	server, endpoint := newFakeS3(t, "modelry-back")
	settings := S3Settings{Endpoint: endpoint.URL, Region: "us-east-1", Bucket: "modelry-back", PathStyle: true, AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}
	if _, err := fixture.service.TestS3(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	// 直接把配置切到 S3（无引用对象）并放入对象，再迁回 Local。
	fixture.references.set()
	if _, err := fixture.service.Configure(context.Background(), 1, ProviderS3, &settings); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	server.objects[first] = fakeObject{body: []byte("alpha"), contentType: "text/plain", modified: time.Now().UTC()}
	server.objects[second] = fakeObject{body: []byte("beta"), contentType: "text/plain", modified: time.Now().UTC()}
	server.mu.Unlock()
	fixture.references.set(first, second)
	// Local 目标已存在 first，migration 必须跳过它并且不覆盖。
	fixture.writeObject(t, first, "alpha", 0)
	migration, err := fixture.service.StartMigration(context.Background(), ProviderLocal, nil)
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForMigration(t, fixture.service, migration.ID)
	if finished.Status != MigrationCompleted || finished.CopiedObjects != 2 {
		t.Fatalf("finished migration = %+v", finished)
	}
	contents, err := os.ReadFile(filepath.Join(fixture.objectsDir, second))
	if err != nil || string(contents) != "beta" {
		t.Fatalf("copied local object = %q err=%v", contents, err)
	}
	config, err := fixture.service.currentConfig()
	if err != nil || config.Provider != ProviderLocal {
		t.Fatalf("provider after local migration = %+v err=%v", config, err)
	}
}

func TestStartMigrationRejectsSecondMigrationAndCancelLeavesProvider(t *testing.T) {
	first := objectKey('1')
	fixture := newStorageFixture(t, first)
	fixture.writeObject(t, first, "payload", 0)
	server := &fakeS3{bucket: "modelry-cancel", objects: make(map[string]fakeObject)}
	_ = server
	// 直接插入一条 running migration，模拟已有进行中的迁移。
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := fixture.store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		_, err := tx.ExecContext(context.Background(), `INSERT INTO modelry_file_migrations(id,source_provider,target_provider,status,total_objects,copied_objects,started_at,updated_at) VALUES(?,?,?,?,?,0,?,?)`,
			"fmig_"+strings.Repeat("9", 32), "local", "s3", MigrationRunning, 1, now, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	settings := S3Settings{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "modelry", AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}
	if _, err := fixture.service.StartMigration(context.Background(), ProviderS3, &settings); !errors.Is(err, ErrMigrationActive) {
		t.Fatalf("concurrent migration error = %v, want ErrMigrationActive", err)
	}
	cancelled, err := fixture.service.CancelMigration(context.Background(), "fmig_"+strings.Repeat("9", 32))
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != MigrationCancelled {
		t.Fatalf("cancelled migration = %+v", cancelled)
	}
	if _, err := fixture.service.CancelMigration(context.Background(), cancelled.ID); !errors.Is(err, ErrMigrationNotActive) {
		t.Fatalf("second cancel error = %v, want ErrMigrationNotActive", err)
	}
	config, err := fixture.service.currentConfig()
	if err != nil || config.Provider != ProviderLocal {
		t.Fatalf("cancelled migration changed the provider: %+v err=%v", config, err)
	}
}

func TestReconcileDeletesOnlyUnreferencedOldObjects(t *testing.T) {
	referenced := objectKey('2')
	orphan := objectKey('3')
	fresh := objectKey('4')
	fixture := newStorageFixture(t, referenced)
	fixture.writeObject(t, referenced, "keep", 2*time.Hour)
	fixture.writeObject(t, orphan, "collect", 2*time.Hour)
	fixture.writeObject(t, fresh, "young", 0)
	if err := fixture.service.Reconcile(context.Background(), time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(fixture.objectsDir, referenced)); err != nil {
		t.Fatalf("referenced object removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.objectsDir, orphan)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old orphan object not collected: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.objectsDir, fresh)); err != nil {
		t.Fatalf("young orphan object must survive the grace period: %v", err)
	}
}

func TestReconcileReportsMissingReferencedObject(t *testing.T) {
	missing := objectKey('5')
	fixture := newStorageFixture(t, missing)
	if err := fixture.service.Reconcile(context.Background(), time.Hour); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing referenced object error = %v, want ErrNotFound", err)
	}
	status, err := fixture.service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.ProviderState != StateDegraded {
		t.Fatalf("status after reconcile failure = %+v", status)
	}
}

func TestRestartMarksRunningMigrationInterrupted(t *testing.T) {
	fixture := newStorageFixture(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := fixture.store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		_, err := tx.ExecContext(context.Background(), `INSERT INTO modelry_file_migrations(id,source_provider,target_provider,status,total_objects,copied_objects,started_at,updated_at) VALUES(?,?,?,?,?,0,?,?)`,
			"fmig_"+strings.Repeat("8", 32), "local", "s3", MigrationRunning, 3, now, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	audits, err := audit.NewService(context.Background(), fixture.store)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(context.Background(), ServiceOptions{
		Store: fixture.store, Secrets: fakeSecrets{values: map[string]string{"sec_access": "a", "sec_secret": "b"}},
		Audits: audits, References: fixture.references, Staging: fakeStaging{dir: fixture.stagingDir}, ObjectsDir: fixture.objectsDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	migration, err := restarted.Migration(context.Background(), "fmig_"+strings.Repeat("8", 32))
	if err != nil {
		t.Fatal(err)
	}
	if migration.Status != MigrationInterrupted || migration.ErrorCode != ErrorInterrupted {
		t.Fatalf("restarted migration = %+v", migration)
	}
	if _, err := restarted.StartMigration(context.Background(), ProviderS3, &S3Settings{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "modelry", AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}); err == nil {
		t.Fatalf("migration to an unreachable provider must fail validation")
	}
}

func TestStatusDoesNotLeakCredentials(t *testing.T) {
	fixture := newStorageFixture(t)
	fixture.service.config = Config{Revision: 1, Provider: ProviderS3, S3: &S3Settings{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "modelry", PathStyle: true, AccessKeySecretID: "sec_access", SecretKeySecretID: "sec_secret"}}
	fixture.service.configLoaded = true
	status, err := fixture.service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded := status.S3AccessKey.Name + status.S3SecretKey.Name + status.Message + status.Hint
	if strings.Contains(encoded, "secret-key-example") || strings.Contains(encoded, "ACCESSKEYEXAMPLE") {
		t.Fatalf("status leaked credential material: %+v", status)
	}
}
