package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

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