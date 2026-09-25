package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// cliLargeObjectBytes 超过 manifest 的 64 MiB 上限，但仍在 128 MiB 的单对象上限内。
const cliLargeObjectBytes = 70 << 20

const cliObjectKey = "obj_44444444444444444444444444444444"

// cliProject 是一个已经停止、可以被 CLI 备份的项目根目录。
type cliProject struct {
	root    string
	managed string
	objects string
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
		Bundle      string `json:"bundle"`
		Digest      string `json:"digest"`
		Collections int64  `json:"collections"`
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