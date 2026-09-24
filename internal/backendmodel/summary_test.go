package backendmodel_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestCollectionSummaryCountsRecordsAndOnlyReportsActiveSchemaChanges(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name:   "Posts",
		Type:   backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	recordService, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "First post"}); err != nil {
		t.Fatal(err)
	}

	listOptions := backendmodel.ListOptions{Limit: 10}
	page, err := models.ListCollectionSummaries(ctx, listOptions, backendmodel.CollectionSummaryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].RecordCount != 0 {
		t.Fatalf("unrequested Record count = %+v, want omitted count", page.Data)
	}
	if page.Data[0].PendingChangeStatus != "" {
		t.Fatalf("unrequested Change status = %q, want omitted status", page.Data[0].PendingChangeStatus)
	}

	summaryOptions := backendmodel.CollectionSummaryOptions{IncludeRecordCount: true, IncludePendingChangeStatus: true}
	page, err = models.ListCollectionSummaries(ctx, listOptions, summaryOptions)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].RecordCount != 1 {
		t.Fatalf("Collection summary = %+v, want one Record", page.Data)
	}
	if page.Data[0].PendingChangeStatus != "" {
		t.Fatalf("Collection without an active change exposed status %q", page.Data[0].PendingChangeStatus)
	}

	if _, err := models.SaveOperation(ctx, collection.ID, backendmodel.PendingOperationInput{
		Kind: backendmodel.OperationField, Action: backendmodel.OperationAdd,
		Definition: json.RawMessage(`{"name":"summary","type":"text"}`),
	}); err != nil {
		t.Fatal(err)
	}
	page, err = models.ListCollectionSummaries(ctx, listOptions, summaryOptions)
	if err != nil {
		t.Fatal(err)
	}
	if got := page.Data[0].PendingChangeStatus; got != backendmodel.ChangeReady {
		t.Fatalf("active Change status = %q, want %q", got, backendmodel.ChangeReady)
	}

	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_backend_changes SET status = ? WHERE collection_id = ?`, backendmodel.ChangeFailed, collection.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	page, err = models.ListCollectionSummaries(ctx, listOptions, summaryOptions)
	if err != nil {
		t.Fatal(err)
	}
	if got := page.Data[0].PendingChangeStatus; got != backendmodel.ChangeFailed {
		t.Fatalf("failed Change status = %q, want %q", got, backendmodel.ChangeFailed)
	}
}
