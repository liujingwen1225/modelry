package portability

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
)

// newPortabilityRouter 组装真实的 Portability Module 与共享 API Router，
// 因此这里断言的是 Contract 上的状态码与错误码，而不是内部错误值。
func newPortabilityRouter(t *testing.T, fixture *portabilityFixture) http.Handler {
	t.Helper()
	module := NewModule(ModuleOptions{
		Service: fixture.service, Records: fixture.records, Resolver: fixture.models,
	})
	return httpapi.NewAPIRouter(module)
}

func postPortability(t *testing.T, router http.Handler, target, contentType string, payload []byte) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(string(payload)))
	request.Header.Set("Content-Type", contentType)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	var decoded map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("%s returned a non-JSON body (%d): %s", target, recorder.Code, recorder.Body.String())
	}
	return recorder.Code, decoded
}

func errorCode(body map[string]any) string {
	problem, _ := body["error"].(map[string]any)
	code, _ := problem["code"].(string)
	return code
}

// TestImportRouteSeparatesInvalidHeaderFromModelMismatch 锁定 Contract：
// 缺失或空的 appliedModelHash 是 INVALID_ARGUMENT，不一致是 MODEL_MISMATCH。
func TestImportRouteSeparatesInvalidHeaderFromModelMismatch(t *testing.T) {
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
	router := newPortabilityRouter(t, fixture)
	target := "/admin/api/v1/collections/" + collection.ID + "/import"
	record := `{"kind":"record","values":{"title":"imported"}}`

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

	t.Run("missing hash", func(t *testing.T) {
		status, body := postPortability(t, router, target, "application/x-ndjson", []byte(header("")+"\n"+record+"\n"))
		if status != http.StatusBadRequest || errorCode(body) != "INVALID_ARGUMENT" {
			t.Fatalf("status=%d code=%s, want 400 INVALID_ARGUMENT", status, errorCode(body))
		}
	})

	t.Run("empty hash", func(t *testing.T) {
		status, body := postPortability(t, router, target, "application/x-ndjson", []byte(header(" ")+"\n"+record+"\n"))
		if status != http.StatusBadRequest || errorCode(body) != "INVALID_ARGUMENT" {
			t.Fatalf("status=%d code=%s, want 400 INVALID_ARGUMENT", status, errorCode(body))
		}
	})

	t.Run("mismatched hash", func(t *testing.T) {
		status, body := postPortability(t, router, target, "application/x-ndjson", []byte(header(strings.Repeat("0", 64))+"\n"+record+"\n"))
		if status != http.StatusConflict || errorCode(body) != "MODEL_MISMATCH" {
			t.Fatalf("status=%d code=%s, want 409 MODEL_MISMATCH", status, errorCode(body))
		}
	})

	t.Run("matching hash", func(t *testing.T) {
		status, body := postPortability(t, router, target, "application/x-ndjson", []byte(header(applied)+"\n"+record+"\n"))
		if status != http.StatusOK {
			t.Fatalf("status=%d body=%v, want 200", status, body)
		}
		data, _ := body["data"].(map[string]any)
		if created, _ := data["created"].(float64); created != 1 {
			t.Fatalf("created=%v, want 1", data["created"])
		}
	})
}

// TestImportRouteReportsAnOversizedBodyAsPayloadTooLarge 锁定 Spec 0010 §6：
// 超过请求体上限的 import 返回 PAYLOAD_TOO_LARGE。
func TestImportRouteReportsAnOversizedBodyAsPayloadTooLarge(t *testing.T) {
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
	router := newPortabilityRouter(t, fixture)

	header, err := json.Marshal(map[string]any{
		"kind": "collection", "collectionId": collection.ID, "appliedModelHash": applied,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 前若干条 Record 完全合法并会被创建，随后请求体越界：整个请求仍然必须被
	// 报告为 PAYLOAD_TOO_LARGE，而不是一个看起来成功的部分摘要。
	padding := strings.Repeat("x", 900_000)
	var builder strings.Builder
	builder.Write(header)
	builder.WriteByte('\n')
	for index := 0; index < 12; index++ {
		builder.WriteString(`{"kind":"record","values":{"title":"`)
		builder.WriteString(padding)
		builder.WriteString(`"}}`)
		builder.WriteByte('\n')
	}
	status, body := postPortability(t, router, "/admin/api/v1/collections/"+collection.ID+"/import", "application/x-ndjson", []byte(builder.String()))
	if status != http.StatusRequestEntityTooLarge || errorCode(body) != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("status=%d code=%s, want 413 PAYLOAD_TOO_LARGE", status, errorCode(body))
	}
	// 前几条 Record 是耐久写入的，因此错误响应必须报告进度，否则调用方无法避免重复导入。
	problem, _ := body["error"].(map[string]any)
	details, _ := problem["details"].(map[string]any)
	if created, _ := details["created"].(float64); created < 1 {
		t.Fatalf("details = %v, want the number of already committed Records", details)
	}
}

// TestImportRouteReportsAnOverLimitRecordCountAsInvalidArgument 证明超过单次 Import 的
// Record 数量上限是一个稳定的请求级错误，而不是一个看起来成功的部分摘要。
func TestImportRouteReportsAnOverLimitRecordCountAsInvalidArgument(t *testing.T) {
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
		"kind": "collection", "collectionId": collection.ID, "appliedModelHash": applied,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 用一个只统计调用的 RecordSource：这里要证明的是 HTTP 契约，不是写入性能。
	module := NewModule(ModuleOptions{
		Service: fixture.service, Records: &countingRecords{}, Resolver: fixture.models,
	})
	router := httpapi.NewAPIRouter(module)

	var builder strings.Builder
	builder.Write(header)
	builder.WriteByte('\n')
	for index := 0; index < maximumImportRecords+1; index++ {
		builder.WriteString(`{"kind":"record","values":{"title":"imported"}}`)
		builder.WriteByte('\n')
	}
	status, body := postPortability(t, router, "/admin/api/v1/collections/"+collection.ID+"/import", "application/x-ndjson", []byte(builder.String()))
	if status != http.StatusBadRequest || errorCode(body) != "INVALID_ARGUMENT" {
		t.Fatalf("status=%d code=%s, want 400 INVALID_ARGUMENT", status, errorCode(body))
	}
	problem, _ := body["error"].(map[string]any)
	details, _ := problem["details"].(map[string]any)
	if created, _ := details["created"].(float64); created != float64(maximumImportRecords) {
		t.Fatalf("details = %v, want created=%d", details, maximumImportRecords)
	}
}

// TestPreflightRouteReportsBoundsAndCompatibility 锁定 restore preflight 的
// 状态码：超出边界的声明是 PAYLOAD_TOO_LARGE，不兼容的 bundle 是 VALIDATION_FAILED，
// 而合法的 bundle 是 200 且写入了 restore.preflight audit fact。
func TestPreflightRouteReportsBoundsAndCompatibility(t *testing.T) {
	ctx := context.Background()
	fixture := newPortabilityFixtureWithFiles(t)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.records.Create(ctx, collection.ID, map[string]any{"title": "preflight"}); err != nil {
		t.Fatal(err)
	}
	bundlePath := fixture.managed + "/bundle.tar"
	if _, err := fixture.service.CreateBackup(ctx, BackupOptions{Destination: bundlePath}); err != nil {
		t.Fatal(err)
	}
	bundle, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}

	target := "/admin/api/v1/restore/preflight"
	t.Run("a compatible bundle is accepted", func(t *testing.T) {
		status, body := postPortability(t, newPortabilityRouter(t, fixture), target, "application/x-tar", bundle)
		if status != http.StatusOK {
			t.Fatalf("status=%d body=%v, want 200", status, body)
		}
		data, _ := body["data"].(map[string]any)
		if compatible, _ := data["compatible"].(bool); !compatible {
			t.Fatalf("compatible=%v findings=%v", data["compatible"], data["findings"])
		}
	})

	t.Run("a bundle declaring too much payload is rejected by bounds", func(t *testing.T) {
		manifest := Manifest{
			Format: FormatName, FormatVersion: FormatVersion, ProjectID: "prj_test",
			RuntimeVersion: "test", AppliedModelHash: strings.Repeat("a", 64),
			Database: DatabaseEntry{
				Path: DatabaseArchivePath, Bytes: maximumDatabasePayloadBytes, SHA256: strings.Repeat("c", 64),
			},
			Objects: []ObjectEntry{{Key: firstObjectKey, Bytes: int64(maximumObjectPayloadBytes), SHA256: strings.Repeat("d", 64)}},
		}
		path := writeBundle(t, fixture.managed, "declared-too-large.tar", manifest, nil, nil)
		payload, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		status, body := postPortability(t, newPortabilityRouter(t, fixture), target, "application/x-tar", payload)
		if status != http.StatusRequestEntityTooLarge || errorCode(body) != "PAYLOAD_TOO_LARGE" {
			t.Fatalf("status=%d code=%s, want 413 PAYLOAD_TOO_LARGE", status, errorCode(body))
		}
	})

	t.Run("a tampered bundle is a validation failure", func(t *testing.T) {
		tampered := append([]byte(nil), bundle...)
		index := strings.Index(string(tampered), "preflight")
		if index < 0 {
			t.Fatal("the fixture Record was not found in the bundle")
		}
		tampered[index] = 'x'
		status, body := postPortability(t, newPortabilityRouter(t, fixture), target, "application/x-tar", tampered)
		if status != http.StatusOK {
			t.Fatalf("status=%d body=%v, want 200 with compatible=false", status, body)
		}
		data, _ := body["data"].(map[string]any)
		if compatible, _ := data["compatible"].(bool); compatible {
			t.Fatalf("a tampered bundle reported compatible: %v", data)
		}
	})

	t.Run("an unreadable archive is a validation failure", func(t *testing.T) {
		status, body := postPortability(t, newPortabilityRouter(t, fixture), target, "application/x-tar", []byte("not a tar archive"))
		if status != http.StatusUnprocessableEntity || errorCode(body) != "VALIDATION_FAILED" {
			t.Fatalf("status=%d code=%s, want 422 VALIDATION_FAILED", status, errorCode(body))
		}
	})
}
