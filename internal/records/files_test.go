package records

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

var anonymousPrincipal = authorization.Principal{Type: authorization.PrincipalAnonymous}

func TestLocalFileUploadBindReplaceAndOrphanReconciliation(t *testing.T) {
	ctx := context.Background()
	store, models, _ := newTestServices(t)
	root := t.TempDir()
	tempDir := filepath.Join(root, "tmp")
	objectsDir := filepath.Join(root, "objects")
	if err := os.Mkdir(tempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(objectsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	records, err := NewWithLocalFiles(store, models, tempDir, objectsDir)
	if err != nil {
		t.Fatalf("initialize Local File Records Service: %v", err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "assets", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true, Unique: true}, {Name: "attachment", Type: backendmodel.FieldTypeFile}},
	})
	if err != nil {
		t.Fatalf("create file Collection: %v", err)
	}
	policy := FilePolicy{MaxBytes: 64, AllowedMIMETypes: []string{"text/plain"}}
	firstUpload, err := records.UploadFile(ctx, collection.ID, "attachment", bytes.NewBufferString("original bytes"), policy)
	if err != nil {
		t.Fatalf("stage first upload: %v", err)
	}
	first, err := records.Create(ctx, collection.ID, map[string]any{"title": "asset", "attachment": firstUpload.TemporaryID})
	if err != nil {
		t.Fatalf("bind first upload to Record: %v", err)
	}
	firstKey := first.Values["attachment"].(string)
	if !objectKeyPattern.MatchString(firstKey) {
		t.Fatalf("bound File value is not an opaque object key: %q", firstKey)
	}
	if _, err := os.Stat(filepath.Join(tempDir, firstUpload.TemporaryID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary upload remained after binding, stat error = %v", err)
	}
	file, info, err := records.OpenFile(ctx, collection.ID, first.ID, "attachment")
	if err != nil {
		t.Fatalf("open authorized Record file: %v", err)
	}
	body, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil || string(body) != "original bytes" || info.Size != int64(len(body)) || info.ContentType != "text/plain" {
		t.Fatalf("opened file body=%q info=%+v err=%v", body, info, err)
	}
	if _, _, err := records.OpenFileApplication(ctx, collection.ID, first.ID, "attachment", anonymousPrincipal); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Application file read without Access Rule evaluator error = %v", err)
	}

	secondUpload, err := records.UploadFile(ctx, collection.ID, "attachment", bytes.NewBufferString("replacement bytes"), policy)
	if err != nil {
		t.Fatalf("stage replacement: %v", err)
	}
	updated, err := records.Update(ctx, collection.ID, first.ID, map[string]any{"attachment": secondUpload.TemporaryID})
	if err != nil {
		t.Fatalf("replace File Field: %v", err)
	}
	secondKey := updated.Values["attachment"].(string)
	if secondKey == firstKey {
		t.Fatalf("replacement reused immutable object key %q", secondKey)
	}
	if _, err := os.Stat(filepath.Join(objectsDir, firstKey)); err != nil {
		t.Fatalf("old object should remain until reconciliation: %v", err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(objectsDir, firstKey), old, old); err != nil {
		t.Fatal(err)
	}
	if err := records.ReconcileFiles(ctx, time.Minute); err != nil {
		t.Fatalf("reconcile replaced object: %v", err)
	}
	if _, err := os.Stat(filepath.Join(objectsDir, firstKey)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unreferenced replaced object not collected: %v", err)
	}
	if _, err := os.Stat(filepath.Join(objectsDir, secondKey)); err != nil {
		t.Fatalf("current referenced object was removed: %v", err)
	}

	orphanUpload, err := records.UploadFile(ctx, collection.ID, "attachment", bytes.NewBufferString("failed transaction"), policy)
	if err != nil {
		t.Fatalf("stage upload for failing DB operation: %v", err)
	}
	if _, err := records.Create(ctx, collection.ID, map[string]any{"title": "asset", "attachment": orphanUpload.TemporaryID}); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate unique value error = %v", err)
	}
	objects, err := os.ReadDir(objectsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(objects) != 2 {
		t.Fatalf("expected current object plus recoverable orphan, got %d objects", len(objects))
	}
	for _, object := range objects {
		old := time.Now().Add(-time.Hour)
		if err := os.Chtimes(filepath.Join(objectsDir, object.Name()), old, old); err != nil {
			t.Fatal(err)
		}
	}
	if err := records.ReconcileFiles(ctx, time.Minute); err != nil {
		t.Fatalf("reconcile unreferenced upload orphan: %v", err)
	}
	objects, err = os.ReadDir(objectsDir)
	if err != nil || len(objects) != 1 || objects[0].Name() != secondKey {
		t.Fatalf("reconciled objects=%v err=%v", objects, err)
	}
}

func TestRenameToUnusedObjectPreservesExistingImmutableObject(t *testing.T) {
	root := t.TempDir()
	objectsDir := filepath.Join(root, "objects")
	if err := os.Mkdir(objectsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tempPath := filepath.Join(root, "upload")
	if err := os.WriteFile(tempPath, []byte("new upload"), 0o600); err != nil {
		t.Fatal(err)
	}
	collisionPath := filepath.Join(objectsDir, "obj_collision")
	if err := os.WriteFile(collisionPath, []byte("durable object"), 0o600); err != nil {
		t.Fatal(err)
	}
	keys := []string{"obj_collision", "obj_unused"}
	keyIndex := 0
	key, err := renameToUnusedObject(tempPath, objectsDir, func() (string, error) {
		result := keys[keyIndex]
		keyIndex++
		return result, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if key != "obj_unused" {
		t.Fatalf("selected object key=%q", key)
	}
	oldContents, err := os.ReadFile(collisionPath)
	if err != nil || string(oldContents) != "durable object" {
		t.Fatalf("existing immutable object changed: %q err=%v", oldContents, err)
	}
	newContents, err := os.ReadFile(filepath.Join(objectsDir, key))
	if err != nil || string(newContents) != "new upload" {
		t.Fatalf("renamed upload=%q err=%v", newContents, err)
	}
	if _, err := os.Stat(tempPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful atomic rename retained source: %v", err)
	}
}

func TestActiveUploadSurvivesReconciliationAndMissingReferencedObjectIsActionable(t *testing.T) {
	ctx := context.Background()
	store, models, _ := newTestServices(t)
	root := t.TempDir()
	tempDir := filepath.Join(root, "tmp")
	objectsDir := filepath.Join(root, "objects")
	if err := os.Mkdir(tempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(objectsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	fileRecords, err := NewWithLocalFiles(store, models, tempDir, objectsDir)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "assets", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}, {Name: "attachment", Type: backendmodel.FieldTypeFile}},
	})
	if err != nil {
		t.Fatal(err)
	}
	policy := FilePolicy{MaxBytes: 64, AllowedMIMETypes: []string{"text/plain"}}
	upload, err := fileRecords.UploadFile(ctx, collection.ID, "attachment", bytes.NewBufferString("durable attachment"), policy)
	if err != nil {
		t.Fatal(err)
	}
	tempPath := filepath.Join(tempDir, upload.TemporaryID)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(tempPath, old, old); err != nil {
		t.Fatal(err)
	}
	if err := fileRecords.ReconcileFiles(ctx, time.Minute); err != nil {
		t.Fatalf("reconcile active upload: %v", err)
	}
	if _, err := os.Stat(tempPath); err != nil {
		t.Fatalf("active staged upload was removed: %v", err)
	}
	record, err := fileRecords.Create(ctx, collection.ID, map[string]any{"title": "report", "attachment": upload.TemporaryID})
	if err != nil {
		t.Fatalf("bind upload after reconciliation: %v", err)
	}
	objectKey := record.Values["attachment"].(string)
	if err := os.Remove(filepath.Join(objectsDir, objectKey)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fileRecords.OpenFile(ctx, collection.ID, record.ID, "attachment"); !errors.Is(err, ErrFileNotFound) {
		t.Fatalf("missing object read error = %v", err)
	}
	if err := fileRecords.ReconcileFiles(ctx, time.Minute); !errors.Is(err, ErrFileNotFound) || !strings.Contains(err.Error(), "referenced object is missing") {
		t.Fatalf("missing durable object did not produce an actionable reconciliation error: %v", err)
	}
}

func TestLocalFileUploadEnforcesSizeAndDetectedMIME(t *testing.T) {
	ctx := context.Background()
	store, models, _ := newTestServices(t)
	root := t.TempDir()
	tempDir := filepath.Join(root, "tmp")
	objectsDir := filepath.Join(root, "objects")
	if err := os.Mkdir(tempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(objectsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	records, err := NewWithLocalFiles(store, models, tempDir, objectsDir)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "documents", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "file", Type: backendmodel.FieldTypeFile}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := records.UploadFile(ctx, collection.ID, "file", bytes.NewBufferString("actual text"), FilePolicy{MaxBytes: 4, AllowedMIMETypes: []string{"text/plain"}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("oversize upload error = %v", err)
	}
	if _, err := records.UploadFile(ctx, collection.ID, "file", bytes.NewBufferString("actual text"), FilePolicy{MaxBytes: 64, AllowedMIMETypes: []string{"image/png"}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("MIME mismatch error = %v", err)
	}
	entries, err := os.ReadDir(tempDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed uploads left temporary files: entries=%v err=%v", entries, err)
	}
}

func TestAdminFileHTTPUploadBindAndDownload(t *testing.T) {
	ctx := context.Background()
	store, models, _ := newTestServices(t)
	root := t.TempDir()
	tempDir := filepath.Join(root, "tmp")
	objectsDir := filepath.Join(root, "objects")
	if err := os.Mkdir(tempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(objectsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	records, err := NewWithLocalFiles(store, models, tempDir, objectsDir)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "documents", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}, {
			Name: "file", Type: backendmodel.FieldTypeFile,
			Validation: json.RawMessage(`{"maxBytes":64,"allowedMimeTypes":["text/plain"]}`),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	records.RegisterRoutes(mux)
	path := "/admin/api/v1/collections/" + collection.ID

	expandListResponse := httptest.NewRecorder()
	mux.ServeHTTP(expandListResponse, httptest.NewRequest(http.MethodGet, path+"/records?expand=author", nil))
	if expandListResponse.Code != http.StatusBadRequest || !strings.Contains(expandListResponse.Body.String(), `"code":"INVALID_ARGUMENT"`) {
		t.Fatalf("Admin List must reject expand: status=%d body=%s", expandListResponse.Code, expandListResponse.Body.String())
	}

	uploadRequest := httptest.NewRequest(http.MethodPost, path+"/files?fieldName=file", bytes.NewBufferString("route upload"))
	uploadResponse := httptest.NewRecorder()
	mux.ServeHTTP(uploadResponse, uploadRequest)
	if uploadResponse.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", uploadResponse.Code, uploadResponse.Body.String())
	}
	var upload struct {
		Data UploadedFile `json:"data"`
	}
	if err := json.Unmarshal(uploadResponse.Body.Bytes(), &upload); err != nil {
		t.Fatalf("decode upload DTO: %v", err)
	}
	if !temporaryKeyPattern.MatchString(upload.Data.TemporaryID) || upload.Data.ContentType != "text/plain" || upload.Data.Size != int64(len("route upload")) {
		t.Fatalf("unexpected upload response: %+v", upload.Data)
	}

	writeBody, _ := json.Marshal(map[string]any{"values": map[string]any{"title": "HTTP file", "file": upload.Data.TemporaryID}})
	createRequest := httptest.NewRequest(http.MethodPost, path+"/records", bytes.NewReader(writeBody))
	createResponse := httptest.NewRecorder()
	mux.ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	var created struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode Record DTO: %v", err)
	}
	recordID, _ := created.Data["id"].(string)
	objectKey, _ := created.Data["file"].(string)
	if recordID == "" || !objectKeyPattern.MatchString(objectKey) {
		t.Fatalf("HTTP Record response did not include durable identity and object reference: %#v", created.Data)
	}

	downloadRequest := httptest.NewRequest(http.MethodGet, path+"/records/"+recordID+"/files/file", nil)
	downloadResponse := httptest.NewRecorder()
	mux.ServeHTTP(downloadResponse, downloadRequest)
	if downloadResponse.Code != http.StatusOK || downloadResponse.Body.String() != "route upload" {
		t.Fatalf("download status=%d body=%q", downloadResponse.Code, downloadResponse.Body.String())
	}
	if downloadResponse.Header().Get("Content-Type") != "text/plain" || downloadResponse.Header().Get("Content-Disposition") != "attachment" || downloadResponse.Header().Get("X-Content-Type-Options") != "nosniff" || downloadResponse.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("unsafe or incomplete file response headers: %#v", downloadResponse.Header())
	}

	badUpload := httptest.NewRecorder()
	mux.ServeHTTP(badUpload, httptest.NewRequest(http.MethodPost, path+"/files", bytes.NewBufferString("missing field")))
	if badUpload.Code != http.StatusBadRequest {
		t.Fatalf("upload missing field status=%d body=%s", badUpload.Code, badUpload.Body.String())
	}
	var errorEnvelope map[string]map[string]any
	if err := json.Unmarshal(badUpload.Body.Bytes(), &errorEnvelope); err != nil || errorEnvelope["error"]["code"] != "INVALID_ARGUMENT" {
		t.Fatalf("missing canonical upload error envelope: body=%s err=%v", badUpload.Body.String(), err)
	}
}
