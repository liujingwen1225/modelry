package portability

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type noObjects struct{}

func (noObjects) ReferencedFileKeys(context.Context) ([]string, error) { return nil, nil }
func (noObjects) OpenObject(context.Context, string) (io.ReadCloser, error) {
	return nil, os.ErrNotExist
}

func newPortabilityFixture(t *testing.T) (*storage.Store, *backendmodel.Service, *records.Service, *Service, string) {
	t.Helper()
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
	t.Cleanup(func() { _ = store.Close() })
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	recordService, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(Options{Store: store, Objects: noObjects{}, Models: models, ManagedDir: managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return store, models, recordService, service, managed
}

// TestBackupPreflightAndRestoreRoundTrip 证明 backup 是一致的产品快照、preflight 能发现篡改、
// 并且 restore 能把项目状态搬到另一个 root。
func TestBackupPreflightAndRestoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	store, models, recordService, service, managed := newPortabilityFixture(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "first"}); err != nil {
		t.Fatal(err)
	}
	if _, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "second"}); err != nil {
		t.Fatal(err)
	}

	bundlePath := filepath.Join(managed, "bundle.tar")
	result, err := service.CreateBackup(ctx, BackupOptions{Destination: bundlePath})
	if err != nil {
		t.Fatalf("create backup: %v", err)
	}
	if result.Counts.Collections != 1 || result.Counts.Records != 2 || result.Bytes == 0 || len(result.Digest) != 64 {
		t.Fatalf("backup result = %+v", result)
	}
	preflight, err := service.Preflight(ctx, bundlePath)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if !preflight.Compatible || preflight.ProjectID != store.ProjectID() || preflight.Counts.Records != 2 {
		t.Fatalf("preflight = %+v", preflight)
	}

	// 篡改任意载荷后 preflight 必须失败，并且不写任何东西。
	raw, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	index := bytes.Index(raw, []byte("first"))
	if index < 0 {
		t.Fatal("fixture record was not found in the bundle payload")
	}
	tampered := append([]byte(nil), raw...)
	tampered[index] = 'x'
	tamperedPath := filepath.Join(managed, "tampered.tar")
	if err := os.WriteFile(tamperedPath, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	bad, err := service.Preflight(ctx, tamperedPath)
	if err != nil {
		t.Fatalf("preflight tampered bundle: %v", err)
	}
	if bad.Compatible {
		t.Fatalf("tampered bundle reported compatible: %+v", bad)
	}
	found := false
	for _, finding := range bad.Findings {
		if finding.Severity == "error" {
			found = true
		}
	}
	if !found {
		t.Fatalf("tampered bundle had no error finding: %+v", bad.Findings)
	}

	// restore 到另一个 root：数据库被替换，Record 仍然存在。
	targetRoot := t.TempDir()
	targetDatabase := filepath.Join(targetRoot, "project.sqlite")
	targetObjects := filepath.Join(targetRoot, "objects")
	inspection, err := NewInspectionService(InspectionOptions{ManagedDir: managed, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err != nil {
		t.Fatalf("apply restore: %v", err)
	}
	restored, err := storage.Open(targetDatabase)
	if err != nil {
		t.Fatalf("open restored database: %v", err)
	}
	restoredModels, err := backendmodel.NewService(ctx, restored)
	if err != nil {
		t.Fatal(err)
	}
	restoredRecords, err := records.New(restored, restoredModels)
	if err != nil {
		t.Fatal(err)
	}
	page, err := restoredRecords.List(ctx, collection.ID, records.ListOptions{Limit: 10})
	if err != nil {
		t.Fatalf("list restored Records: %v", err)
	}
	if len(page.Data) != 2 {
		t.Fatalf("restored Records = %d, want 2", len(page.Data))
	}

	// Windows 上无法替换仍被打开的文件：这与「restore 只能在项目停止时执行」一致。
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}

	// 没有 --force 时不得覆盖已有项目。
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err == nil {
		t.Fatal("restore overwrote an existing project without force")
	}
	if _, err := inspection.Apply(ctx, bundlePath, ApplyOptions{Force: true, DatabasePath: targetDatabase, ObjectsDir: targetObjects}); err != nil {
		t.Fatalf("forced restore: %v", err)
	}
}

// TestExportImportPreservesSemanticsAndReportsFailures 证明导入复用 Record 创建路径：
// 合法 Record 被创建，非法 Record 被逐条报告而不是绕过校验。
func TestExportImportPreservesSemanticsAndReportsFailures(t *testing.T) {
	ctx := context.Background()
	_, models, recordService, service, managed := newPortabilityFixture(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "exported"}); err != nil {
		t.Fatal(err)
	}
	var stream bytes.Buffer
	if err := service.ExportStream(ctx, recordService, models, collection.ID, &stream); err != nil {
		t.Fatalf("export: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(stream.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"kind":"collection"`) || !strings.Contains(lines[1], "exported") {
		t.Fatalf("export stream = %s", stream.String())
	}

	summary, err := service.ImportStream(ctx, recordService, models, collection.ID, strings.NewReader(stream.String()))
	if err != nil {
		t.Fatalf("import exported stream: %v", err)
	}
	if summary.Created != 1 || summary.Failed != 0 {
		t.Fatalf("import summary = %+v", summary)
	}

	header := lines[0]
	invalid := header + "\n" + `{"kind":"record","values":{}}` + "\n" + `{"kind":"record","values":{"title":"valid"}}` + "\n"
	summary, err = service.ImportStream(ctx, recordService, models, collection.ID, strings.NewReader(invalid))
	if err != nil {
		t.Fatalf("import invalid stream: %v", err)
	}
	if summary.Created != 1 || summary.Failed != 1 || summary.Results[0].Status != "failed" || summary.Results[0].Code == "" {
		t.Fatalf("invalid import summary = %+v", summary)
	}

	mismatched := strings.Replace(header, `"appliedModelHash":"`, `"appliedModelHash":"0`, 1)
	if _, err := service.ImportStream(ctx, recordService, models, collection.ID, strings.NewReader(mismatched+"\n")); err == nil {
		t.Fatal("import accepted a mismatched applied model hash")
	}

	_ = managed
}

// TestGenerateArtifactsAreDeterministic 证明生成物可复现且版本可识别。
func TestGenerateArtifactsAreDeterministic(t *testing.T) {
	ctx := context.Background()
	_, models, _, service, _ := newPortabilityFixture(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}, {Name: "views", Type: backendmodel.FieldTypeNumber}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "authors", Type: backendmodel.CollectionTypeNormal}); err != nil {
		t.Fatal(err)
	}
	contract, err := service.BuildContract(ctx, nil)
	if err != nil {
		t.Fatalf("build contract: %v", err)
	}
	if contract.ContentHash == "" || len(contract.Collections) != 2 {
		t.Fatalf("contract = %+v", contract)
	}
	first, err := GenerateArtifacts(contract)
	if err != nil {
		t.Fatal(err)
	}
	second, err := GenerateArtifacts(contract)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.ContractJSON, second.ContractJSON) || !bytes.Equal(first.ClientTypeScript, second.ClientTypeScript) {
		t.Fatal("generated artifacts are not reproducible")
	}
	if !strings.Contains(string(first.ClientTypeScript), contract.ContentHash) || !strings.Contains(string(first.ClientTypeScript), "createModelryClient") {
		t.Fatalf("generated client = %s", first.ClientTypeScript)
	}
	if !strings.Contains(string(first.ContractJSON), collection.ID) {
		t.Fatal("generated contract does not describe the applied Collection")
	}
	var decoded map[string]any
	if err := json.Unmarshal(first.ContractJSON, &decoded); err != nil {
		t.Fatalf("generated contract is not valid JSON: %v", err)
	}
}