package backendmodel

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestCollectionsAreDurableAndProjectionIdentifiersAreGenerated(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "project.sqlite")
	store := openTestStore(t, databasePath)
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}

	users, err := service.CreateCollection(ctx, CreateCollectionInput{Name: "Users", Type: CollectionTypeAuth})
	if err != nil {
		t.Fatal(err)
	}
	email, found := fieldByName(users.Fields, "email")
	if !found || email.Type != FieldTypeText || !email.Required || !email.Unique {
		t.Fatalf("Auth Collection email identifier is not enforced: %+v", email)
	}
	if _, found := fieldByName(users.Fields, "password"); found {
		t.Fatal("password was persisted as a profile Field")
	}

	posts, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Blog Posts", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "title", Type: FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetRecordProjection(ctx, posts.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(projection.TableName, "Blog") || strings.Contains(projection.TableName, "Posts") {
		t.Fatalf("physical table name contains a user-supplied Collection name: %q", projection.TableName)
	}
	title, found := projectedFieldByName(projection.Fields, "title")
	if !found || !strings.HasPrefix(title.ColumnName, "mry_field_") {
		t.Fatalf("Field is not mapped to a generated physical column: %+v", title)
	}
	if _, err := QuoteSQLiteIdentifier(`title"; DROP TABLE modelry_backend_collections;--`); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unsafe identifier was accepted: %v", err)
	}
	if _, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Unsafe Fields", Type: CollectionTypeNormal,
		Fields: []Field{{Name: `title"; DROP TABLE x;--`, Type: FieldTypeText}},
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unsafe Field name was accepted: %v", err)
	}

	got, err := service.GetCollection(ctx, posts.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != posts.ID || got.SchemaVersion != 1 || len(got.Fields) != 4 {
		t.Fatalf("unexpected initial Applied Model: %+v", got)
	}
	page, err := service.ListCollections(ctx, ListOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.NextCursor == "" {
		t.Fatalf("expected the first page and a continuation cursor, got %+v", page)
	}
	secondPage, err := service.ListCollections(ctx, ListOptions{Limit: 1, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage.Data) != 1 || secondPage.Data[0].ID == page.Data[0].ID {
		t.Fatalf("Collection pagination did not continue after the cursor: first=%+v second=%+v", page, secondPage)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restartedStore := openTestStore(t, databasePath)
	restarted, err := NewService(ctx, restartedStore)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := restarted.GetCollection(ctx, posts.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ID != posts.ID || reloaded.Fields[3].ID != posts.Fields[3].ID {
		t.Fatalf("Collection identity or Field identity changed after reopening SQLite: %+v", reloaded)
	}
}

func TestInitialRelationTargetsAnotherAppliedCollection(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	target, err := service.CreateCollection(ctx, CreateCollectionInput{Name: "Authors", Type: CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	source, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Posts", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "author", Type: FieldTypeRelation, Relation: &Relation{TargetCollectionID: target.ID, Cardinality: "many-to-one"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	field, found := fieldByName(source.Fields, "author")
	if !found || field.Relation == nil || field.Relation.TargetCollectionID != target.ID {
		t.Fatalf("initial Relation was not applied to the source model: %+v", source)
	}
}

func TestCollectionInitializerSharesCreateTransaction(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `CREATE TABLE initializer_probe (collection_id TEXT PRIMARY KEY)`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollectionWithInitializer(ctx, CreateCollectionInput{Name: "Atomic", Type: CollectionTypeNormal}, func(ctx context.Context, tx storage.Executor, collection Collection) error {
		var persistedID string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM modelry_backend_collections WHERE id = ?`, collection.ID).Scan(&persistedID); err != nil {
			return err
		}
		if persistedID != collection.ID {
			return errors.New("initializer did not observe the persisted Collection")
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO initializer_probe (collection_id) VALUES (?)`, collection.ID)
		return err
	})
	if err != nil {
		t.Fatalf("create with successful initializer: %v", err)
	}
	var initializedID string
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT collection_id FROM initializer_probe WHERE collection_id = ?`, collection.ID).Scan(&initializedID)
	}); err != nil || initializedID != collection.ID {
		t.Fatalf("initializer write did not commit with the Collection: id=%q err=%v", initializedID, err)
	}

	var failedCollectionID, failedProjectionTable string
	failedCollection, err := service.CreateCollectionWithInitializer(ctx, CreateCollectionInput{Name: "Rolled Back", Type: CollectionTypeNormal}, func(ctx context.Context, tx storage.Executor, collection Collection) error {
		failedCollectionID = collection.ID
		failedProjectionTable = recordsTableName(collection.ID)
		if _, err := tx.ExecContext(ctx, `INSERT INTO initializer_probe (collection_id) VALUES (?)`, collection.ID); err != nil {
			return err
		}
		return errors.New("reject atomic initialization")
	})
	if err == nil || failedCollection.ID != "" {
		t.Fatalf("failing initializer should fail Collection creation: collection=%+v err=%v", failedCollection, err)
	}
	if _, err := service.GetCollection(ctx, failedCollectionID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed initialization left a readable Collection: %v", err)
	}
	var collectionCount, probeCount, projectionCount int
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_backend_collections WHERE name = ?`, "Rolled Back").Scan(&collectionCount); err != nil {
			return err
		}
		if err := snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM initializer_probe p LEFT JOIN modelry_backend_collections c ON c.id = p.collection_id WHERE c.id IS NULL`).Scan(&probeCount); err != nil {
			return err
		}
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, failedProjectionTable).Scan(&projectionCount)
	}); err != nil {
		t.Fatal(err)
	}
	if collectionCount != 0 || probeCount != 0 || projectionCount != 0 {
		t.Fatalf("failed initializer left partial state: collectionCount=%d orphanProbeCount=%d projectionCount=%d", collectionCount, probeCount, projectionCount)
	}
}

func TestPendingApplyAndHistorySurviveRestart(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "project.sqlite")
	store := openTestStore(t, databasePath)
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Posts", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "title", Type: FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	title, _ := projectedFieldByName(projection.Fields, "title")
	insertRecord(t, ctx, store, projection.TableName, title.ColumnName, "rec_test_1", "A durable title")

	pending, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationAdd,
		Definition: json.RawMessage(`{"name":"rating","type":"number","required":true,"default":5}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if pending.Version != 1 || pending.Status != ChangeReady || len(pending.Operations) != 1 {
		t.Fatalf("unexpected durable Pending Change: %+v", pending)
	}
	preview, err := service.Preview(ctx, collection.ID, pending.Version)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Risk != RiskSafe || preview.Version != pending.Version || preview.Impact.AffectedRecords != 1 {
		t.Fatalf("safe additive change was not correctly evaluated: %+v", preview)
	}
	unapplied, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := fieldByName(unapplied.Fields, "rating"); found {
		t.Fatal("pending schema changed the Applied Model before Apply")
	}

	result, err := service.Apply(ctx, collection.ID, pending.Version, false)
	if err != nil {
		t.Fatalf("Apply failed: %v", err)
	}
	if result.State != "applied" || result.ApplyAttemptID == "" || result.AppliedMigrationID == "" {
		t.Fatalf("unexpected Apply result: %+v", result)
	}
	applied, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := fieldByName(applied.Fields, "rating"); !found || applied.SchemaVersion != 2 {
		t.Fatalf("Applied Model did not advance with the physical projection: %+v", applied)
	}
	projection, err = service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	rating, found := projectedFieldByName(projection.Fields, "rating")
	if !found {
		t.Fatal("Applied Field is absent from the Records projection")
	}
	assertProjectedValue(t, ctx, store, projection.TableName, rating.ColumnName, "rec_test_1", int64(5))
	if _, found, err := service.GetPendingChange(ctx, collection.ID); err != nil || found {
		t.Fatalf("successful Apply did not clear the active Pending Change: found=%v err=%v", found, err)
	}
	change, err := service.GetChange(ctx, pending.ChangeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if change.Status != ChangeApplied || len(change.ApplyAttempts) != 1 || change.AppliedMigration == nil {
		t.Fatalf("Change detail is missing durable result facts: %+v", change)
	}
	history, err := service.History(ctx, collection.ID, ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Data) != 1 || history.Data[0].ID != result.AppliedMigrationID {
		t.Fatalf("Applied History is not independently readable: %+v", history)
	}
	pendingAfterApply, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationAdd,
		Definition: json.RawMessage(`{"name":"excerpt","type":"text"}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	page, err := service.ListChanges(ctx, ListOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.NextCursor == "" || page.Data[0].PendingChange == nil || page.Data[0].PendingChange.ChangeSetID != pendingAfterApply.ChangeSetID {
		t.Fatalf("Changes pagination should start with the newer Pending Change: %+v", page)
	}
	secondPage, err := service.ListChanges(ctx, ListOptions{Limit: 1, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage.Data) != 1 || secondPage.Data[0].AppliedMigration == nil {
		t.Fatalf("Changes cursor did not continue into immutable Applied History: %+v", secondPage)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restartedStore := openTestStore(t, databasePath)
	restarted, err := NewService(ctx, restartedStore)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := restarted.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.SchemaVersion != 2 {
		t.Fatalf("Applied Model version changed after restart: %+v", reloaded)
	}
	reloadedPending, found, err := restarted.GetPendingChange(ctx, collection.ID)
	if err != nil || !found || reloadedPending.ChangeSetID != pendingAfterApply.ChangeSetID {
		t.Fatalf("Pending Change did not survive restart: pending=%+v found=%v err=%v", reloadedPending, found, err)
	}
	reloadedHistory, err := restarted.History(ctx, collection.ID, ListOptions{})
	if err != nil || len(reloadedHistory.Data) != 1 || reloadedHistory.Data[0].ID != result.AppliedMigrationID {
		t.Fatalf("Applied History did not survive restart: page=%+v err=%v", reloadedHistory, err)
	}
}

func TestBlockedPreviewAndApplyKeepAppliedModelUnchanged(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Items", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "name", Type: FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	insertRecord(t, ctx, store, projection.TableName, "", "rec_test_1", "Item one")
	pending, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationAdd,
		Definition: json.RawMessage(`{"name":"quantity","type":"number","required":true}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := service.Preview(ctx, collection.ID, pending.Version)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Risk != RiskBlocked || !hasPrecondition(preview, "REQUIRED_FIELD_NEEDS_DEFAULT", "failed") {
		t.Fatalf("a required new Field without a default was not blocked: %+v", preview)
	}
	if _, err := service.Apply(ctx, collection.ID, pending.Version, false); !errors.Is(err, ErrChangeBlocked) {
		t.Fatalf("blocked Apply should return an actionable precondition error, got %v", err)
	}
	blockedChange, err := service.GetChange(ctx, pending.ChangeSetID)
	if err != nil || blockedChange.Status != ChangeReady || len(blockedChange.ApplyAttempts) != 0 {
		t.Fatalf("a non-Unique blocked precondition should remain a quick non-attempt rejection: change=%+v err=%v", blockedChange, err)
	}
	current, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := fieldByName(current.Fields, "quantity"); found || current.SchemaVersion != 1 {
		t.Fatalf("blocked change altered the Applied Model: %+v", current)
	}
	retained, found, err := service.GetPendingChange(ctx, collection.ID)
	if err != nil || !found || retained.ChangeSetID != pending.ChangeSetID {
		t.Fatalf("blocked change should remain durable: found=%v pending=%+v err=%v", found, retained, err)
	}
}

func TestFlow009BlockedUniqueApplyIsDurableAndCanBeRetried(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "flow-009.sqlite")
	store := openTestStore(t, databasePath)
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "posts", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "category", Type: FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	category, found := projectedFieldByName(projection.Fields, "category")
	if !found {
		t.Fatal("category Field is missing from the Record projection")
	}
	insertRecord(t, ctx, store, projection.TableName, category.ColumnName, "rec_flow_1", "same")
	insertRecord(t, ctx, store, projection.TableName, category.ColumnName, "rec_flow_2", "same")
	pending, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationUpdate, TargetID: category.ID,
		Definition: json.RawMessage(`{"name":"category","type":"text","unique":true}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := service.Preview(ctx, collection.ID, pending.Version)
	if err != nil || preview.Risk != RiskBlocked || !hasPrecondition(preview, "UNIQUE_VALUES_CONFLICT", "failed") {
		t.Fatalf("duplicate categories were not identified before Apply: preview=%+v err=%v", preview, err)
	}

	failed, err := service.Apply(ctx, collection.ID, pending.Version, false)
	var applyFailure *ApplyFailure
	if !errors.As(err, &applyFailure) || applyFailure.Code != "VALIDATION_FAILED" || !errors.Is(err, ErrChangeBlocked) || failed.State != "recoveryRequired" || failed.ApplyAttemptID == "" || failed.Recovery == nil {
		t.Fatalf("blocked Review & Apply did not return a recoverable failed attempt: result=%+v err=%v", failed, err)
	}
	change, err := service.GetChange(ctx, pending.ChangeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if change.Status != ChangeFailed || len(change.ApplyAttempts) != 1 || change.ApplyAttempts[0].ID != failed.ApplyAttemptID || change.ApplyAttempts[0].Status != AttemptFailed {
		t.Fatalf("blocked Apply facts were not recorded: %+v", change)
	}
	attempt := change.ApplyAttempts[0]
	if attempt.ErrorCode != "VALIDATION_FAILED" || attempt.Recovery == nil || change.RecoveryState == nil || attempt.Evaluation.Risk != RiskBlocked || !hasPrecondition(attempt.Evaluation, "UNIQUE_VALUES_CONFLICT", "failed") {
		t.Fatalf("failed Apply is missing its evaluation or recovery details: %+v", attempt)
	}
	if change.AppliedMigration != nil {
		t.Fatalf("blocked Apply created an Applied Migration: %+v", change.AppliedMigration)
	}
	current, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.SchemaVersion != 1 || current.Fields[3].Unique {
		t.Fatalf("blocked Apply changed the Applied Model: %+v", current)
	}
	assertProjectedValue(t, ctx, store, projection.TableName, category.ColumnName, "rec_flow_1", "same")
	assertProjectedValue(t, ctx, store, projection.TableName, category.ColumnName, "rec_flow_2", "same")

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopenedStore := openTestStore(t, databasePath)
	restarted, err := NewService(ctx, reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	change, err = restarted.GetChange(ctx, pending.ChangeSetID)
	if err != nil || change.Status != ChangeFailed || len(change.ApplyAttempts) != 1 || change.ApplyAttempts[0].ID != failed.ApplyAttemptID || change.ApplyAttempts[0].Recovery == nil {
		t.Fatalf("failed Apply and recovery did not survive restart: change=%+v err=%v", change, err)
	}

	quotedTable, err := QuoteSQLiteIdentifier(projection.TableName)
	if err != nil {
		t.Fatal(err)
	}
	quotedCategory, err := QuoteSQLiteIdentifier(category.ColumnName)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopenedStore.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, "UPDATE "+quotedTable+" SET "+quotedCategory+" = ? WHERE id = ?", "other", "rec_flow_2")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	result, err := restarted.Apply(ctx, collection.ID, pending.Version, true)
	if err != nil || result.State != "applied" || result.ApplyAttemptID == "" || result.ApplyAttemptID == failed.ApplyAttemptID {
		t.Fatalf("corrected data did not succeed under a new ApplyAttempt: result=%+v err=%v", result, err)
	}
	change, err = restarted.GetChange(ctx, pending.ChangeSetID)
	if err != nil || len(change.ApplyAttempts) != 2 || change.Status != ChangeApplied || change.AppliedMigration == nil || change.AppliedMigration.ApplyAttemptID != result.ApplyAttemptID {
		t.Fatalf("success did not retain both independent attempts and immutable history: change=%+v err=%v", change, err)
	}
	statuses := map[AttemptStatus]bool{}
	ids := map[string]bool{}
	for _, item := range change.ApplyAttempts {
		statuses[item.Status] = true
		ids[item.ID] = true
	}
	if len(ids) != 2 || !statuses[AttemptFailed] || !statuses[AttemptSucceeded] {
		t.Fatalf("retry overwrote the failed attempt: %+v", change.ApplyAttempts)
	}
	current, err = restarted.GetCollection(ctx, collection.ID)
	if err != nil || current.SchemaVersion != 2 || !current.Fields[3].Unique {
		t.Fatalf("successful retry did not apply Unique to the model: collection=%+v err=%v", current, err)
	}
}

func TestFailedApplyCanBeEditedAndRetriedWithANewAttempt(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	hooked := &transactionHookStore{Store: store}
	service, err := NewService(ctx, hooked)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Labels", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "name", Type: FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	nameField, _ := projectedFieldByName(projection.Fields, "name")
	insertRecord(t, ctx, store, projection.TableName, nameField.ColumnName, "rec_test_1", "one")
	pending, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationAdd,
		Definition: json.RawMessage(`{"name":"code","type":"text","unique":true,"default":"same"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	projectionTable := projection.TableName
	hooked.setAfterNextCommit(func() error {
		return store.WithTransaction(ctx, func(tx storage.Executor) error {
			_, err := tx.ExecContext(ctx, `INSERT INTO `+mustQuote(t, projectionTable)+` (id, createdAt, updatedAt, `+mustQuote(t, nameField.ColumnName)+`) VALUES (?, ?, ?, ?)`, "rec_test_2", time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano), "two")
			return err
		})
	})
	failed, err := service.Apply(ctx, collection.ID, pending.Version, false)
	if err == nil || failed.State != "recoveryRequired" || failed.ApplyAttemptID == "" {
		t.Fatalf("late uniqueness conflict should leave a failed durable attempt: result=%+v err=%v", failed, err)
	}
	var applyFailure *ApplyFailure
	if !errors.As(err, &applyFailure) || applyFailure.Code != "VALIDATION_FAILED" || !errors.Is(err, ErrChangeBlocked) {
		t.Fatalf("Apply failure should keep a stable public error code and domain cause: %T %v", err, err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "sqlite") || strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
		t.Fatalf("Apply failure leaked a database cause: %v", err)
	}
	current, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := fieldByName(current.Fields, "code"); found || current.SchemaVersion != 1 {
		t.Fatalf("failed Apply changed the Applied Model: %+v", current)
	}
	failedChange, err := service.GetChange(ctx, pending.ChangeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if failedChange.Status != ChangeFailed || len(failedChange.ApplyAttempts) != 1 || failedChange.ApplyAttempts[0].Status != AttemptFailed {
		t.Fatalf("failed Apply facts were not durable: %+v", failedChange)
	}

	operation := pending.Operations[0]
	updated, err := service.UpdateOperation(ctx, collection.ID, operation.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationAdd,
		Definition: json.RawMessage(`{"name":"code","type":"text","default":"same"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Operations[0].TargetID != operation.TargetID {
		t.Fatal("editing an added Field changed its stable pending Field ID")
	}
	retried, err := service.Apply(ctx, collection.ID, updated.Version, false)
	if err != nil {
		t.Fatalf("retry did not succeed: %v", err)
	}
	retriedChange, err := service.GetChange(ctx, pending.ChangeSetID)
	if err != nil {
		t.Fatal(err)
	}
	if len(retriedChange.ApplyAttempts) != 2 || retriedChange.ApplyAttempts[0].ID == retriedChange.ApplyAttempts[1].ID {
		t.Fatalf("retry must retain the failed attempt and create a new attempt: %+v", retriedChange.ApplyAttempts)
	}
	if retriedChange.ApplyAttempts[0].Status != AttemptSucceeded || retriedChange.ApplyAttempts[1].Status != AttemptFailed {
		t.Fatalf("retry attempt outcomes are not independently retained: %+v", retriedChange.ApplyAttempts)
	}
	if retriedChange.AppliedMigration == nil || retriedChange.AppliedMigration.ID != retried.AppliedMigrationID {
		t.Fatalf("successful retry did not create immutable history: %+v", retriedChange)
	}
}

func TestDiscardAndDefaultValidationUseAppliedModelOnly(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, CreateCollectionInput{
		Name: "Notes", Type: CollectionTypeNormal,
		Fields: []Field{{Name: "title", Type: FieldTypeText, Required: true, Default: json.RawMessage(`"Untitled"`), Validation: json.RawMessage(`{"minLength":3}`)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	values, err := ValidateRecordValues(collection, map[string]any{})
	if err != nil || values["title"] != "Untitled" {
		t.Fatalf("Applied default was not returned: values=%v err=%v", values, err)
	}
	if _, err := ValidateRecordValues(collection, map[string]any{"title": "x"}); err == nil {
		t.Fatal("Applied Field validation was not enforced")
	}
	if _, err := ValidateRecordValues(collection, map[string]any{"id": "rec_user_input"}); err == nil {
		t.Fatal("system Field values must be rejected on record writes")
	}
	pending, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{
		Kind: OperationField, Action: OperationAdd,
		Definition: json.RawMessage(`{"name":"temporary","type":"text"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	discarded, err := service.Discard(ctx, collection.ID, pending.Version)
	if err != nil {
		t.Fatal(err)
	}
	if discarded.Status != ChangeDiscarded {
		t.Fatalf("Discard did not persist terminal state: %+v", discarded)
	}
	current, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := fieldByName(current.Fields, "temporary"); found {
		t.Fatal("discarded Field entered the Applied Model")
	}
}

func openTestStore(t *testing.T, databasePath string) *storage.Store {
	t.Helper()
	store, err := storage.Open(databasePath)
	if err != nil {
		t.Fatalf("open real SQLite test database: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	return store
}

func insertRecord(t *testing.T, ctx context.Context, store *storage.Store, tableName, fieldColumn, recordID, textValue string) {
	t.Helper()
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		t.Fatal(err)
	}
	columns := "id, createdAt, updatedAt"
	placeholders := "?, ?, ?"
	args := []any{recordID, time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)}
	if fieldColumn != "" {
		quotedColumn, err := QuoteSQLiteIdentifier(fieldColumn)
		if err != nil {
			t.Fatal(err)
		}
		columns += ", " + quotedColumn
		placeholders += ", ?"
		args = append(args, textValue)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO "+quotedTable+" ("+columns+") VALUES ("+placeholders+")", args...)
		return err
	}); err != nil {
		t.Fatalf("insert real test Record: %v", err)
	}
}

func assertProjectedValue(t *testing.T, ctx context.Context, store *storage.Store, tableName, fieldColumn, recordID string, expected any) {
	t.Helper()
	quotedTable, err := QuoteSQLiteIdentifier(tableName)
	if err != nil {
		t.Fatal(err)
	}
	quotedColumn, err := QuoteSQLiteIdentifier(fieldColumn)
	if err != nil {
		t.Fatal(err)
	}
	var actual any
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, "SELECT "+quotedColumn+" FROM "+quotedTable+" WHERE id = ?", recordID).Scan(&actual)
	}); err != nil {
		t.Fatal(err)
	}
	if actual != expected {
		t.Fatalf("projected default got %T(%v), want %T(%v)", actual, actual, expected, expected)
	}
}

func projectedFieldByName(fields []ProjectedField, name string) (ProjectedField, bool) {
	for _, field := range fields {
		if field.Name == name {
			return field, true
		}
	}
	return ProjectedField{}, false
}

func hasPrecondition(preview SchemaPreview, code, status string) bool {
	for _, item := range preview.Preconditions {
		if item.Code == code && item.Status == status {
			return true
		}
	}
	return false
}

func mustQuote(t *testing.T, name string) string {
	t.Helper()
	quoted, err := QuoteSQLiteIdentifier(name)
	if err != nil {
		t.Fatal(err)
	}
	return quoted
}

type transactionHookStore struct {
	*storage.Store
	mu              sync.Mutex
	afterNextCommit func() error
}

func (store *transactionHookStore) WithTransaction(ctx context.Context, work func(storage.Executor) error) error {
	if err := store.Store.WithTransaction(ctx, work); err != nil {
		return err
	}
	store.mu.Lock()
	hook := store.afterNextCommit
	store.afterNextCommit = nil
	store.mu.Unlock()
	if hook != nil {
		return hook()
	}
	return nil
}

func (store *transactionHookStore) setAfterNextCommit(hook func() error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.afterNextCommit = hook
}

func (store *transactionHookStore) WithReadSnapshot(ctx context.Context, work func(storage.Executor) error) error {
	return store.Store.WithReadSnapshot(ctx, work)
}

var _ TransactionalStore = (*transactionHookStore)(nil)
