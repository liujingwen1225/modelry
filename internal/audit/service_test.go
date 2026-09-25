package audit

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestAuditAppendIsDurableAppendOnlyAndCursorStable(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "project.sqlite")
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 9, 24, 3, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		input := AppendInput{
			ID: "aud_000000000000000" + string(rune('1'+i)), Time: base.Add(time.Duration(i) * time.Second),
			Actor: Actor{Kind: ActorOwner, ID: "own_test"}, Action: "serviceAccount.created",
			Resource: Resource{Kind: "serviceAccount", ID: "sa_test"}, Result: "success",
		}
		if err := service.Append(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	first, err := service.List(ctx, ListOptions{Limit: 2})
	if err != nil || len(first.Data) != 2 || first.NextCursor == "" {
		t.Fatalf("first Audit page = %+v, err = %v", first, err)
	}
	second, err := service.List(ctx, ListOptions{Limit: 2, Cursor: first.NextCursor})
	if err != nil || len(second.Data) != 1 || second.NextCursor != "" || second.Data[0].ID == first.Data[1].ID {
		t.Fatalf("second Audit page = %+v, err = %v", second, err)
	}
	read, err := service.Get(ctx, first.Data[0].ID)
	if err != nil || read.Actor.Kind != ActorOwner || read.Action != "serviceAccount.created" || read.Time.IsZero() {
		t.Fatalf("Audit read = %+v, err = %v", read, err)
	}
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "plaintext-key") {
		t.Fatalf("Audit page contains a secret: %s", encoded)
	}

	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := service.AppendInTransaction(ctx, tx, AppendInput{
			Actor: Actor{Kind: ActorOwner, ID: "own_test"}, Action: "serviceAccount.disabled",
			Resource: Resource{Kind: "serviceAccount", ID: "sa_test"}, Result: "success",
		}); err != nil {
			return err
		}
		return errors.New("roll back caller transaction")
	}); err == nil {
		t.Fatal("caller transaction failure should be returned")
	}
	count, err := service.List(ctx, ListOptions{Limit: 10})
	if err != nil || len(count.Data) != 3 {
		t.Fatalf("rolled back Audit append became durable: rows=%d err=%v", len(count.Data), err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_audit_records SET result = 'failure' WHERE id = ?`, first.Data[0].ID)
		return err
	}); err == nil {
		t.Fatal("Audit UPDATE should be blocked by the append-only trigger")
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM modelry_audit_records WHERE id = ?`, first.Data[0].ID)
		return err
	}); err == nil {
		t.Fatal("Audit DELETE should be blocked by the append-only trigger")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restarted, err := NewService(ctx, reopened)
	if err != nil {
		t.Fatal(err)
	}
	page, err := restarted.List(ctx, ListOptions{Limit: 10})
	if err != nil || len(page.Data) != 3 {
		t.Fatalf("Audit history did not survive SQLite reopen: rows=%d err=%v", len(page.Data), err)
	}
}

func TestAuditListServerFiltersAreInclusiveAndCursorBound(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "audit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	from := time.Date(2026, 9, 24, 3, 0, 0, 0, time.UTC)
	to := from.Add(2 * time.Second)
	entries := []AppendInput{
		{ID: "aud_0000000000000001", Time: from, Actor: Actor{Kind: ActorOwner, ID: "own_filter"}, Action: "serviceAccount.created", Resource: Resource{Kind: "serviceAccount", ID: "sa_filter"}, Result: "success"},
		{ID: "aud_0000000000000002", Time: from.Add(time.Second), Actor: Actor{Kind: ActorServiceAccount, ID: "sa_actor"}, Action: "apiKey.created", Resource: Resource{Kind: "apiKey", ID: "key_filter"}, Result: "success"},
		{ID: "aud_0000000000000003", Time: to, Actor: Actor{Kind: ActorOwner, ID: "own_filter"}, Action: "serviceAccount.disabled", Resource: Resource{Kind: "serviceAccount", ID: "sa_filter"}, Result: "success"},
	}
	for _, input := range entries {
		if err := service.Append(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	page, err := service.List(ctx, ListOptions{
		Limit: 1, Search: "SERVICEACCOUNT", ActorKind: ActorOwner, ActorID: "own_filter",
		ResourceKind: "serviceAccount", ResourceID: "sa_filter", From: &from, To: &to,
	})
	if err != nil || len(page.Data) != 1 || page.Data[0].ID != entries[2].ID || page.NextCursor == "" {
		t.Fatalf("filtered first page = %+v, err = %v", page, err)
	}
	options := ListOptions{
		Limit: 1, Cursor: page.NextCursor, Search: "SERVICEACCOUNT", ActorKind: ActorOwner, ActorID: "own_filter",
		ResourceKind: "serviceAccount", ResourceID: "sa_filter", From: &from, To: &to,
	}
	second, err := service.List(ctx, options)
	if err != nil || len(second.Data) != 1 || second.Data[0].ID != entries[0].ID || second.NextCursor != "" {
		t.Fatalf("filtered second page = %+v, err = %v", second, err)
	}
	actionPage, err := service.List(ctx, ListOptions{Action: "apiKey.created"})
	if err != nil || len(actionPage.Data) != 1 || actionPage.Data[0].ID != entries[1].ID {
		t.Fatalf("exact action filter = %+v, err = %v", actionPage, err)
	}
	options.Cursor = page.NextCursor
	options.Action = "apiKey.created"
	if _, err := service.List(ctx, options); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("cursor accepted with different filters: %v", err)
	}
	options = ListOptions{Search: "%"}
	literal, err := service.List(ctx, options)
	if err != nil || len(literal.Data) != 0 {
		t.Fatalf("literal wildcard search matched records: %+v, err = %v", literal, err)
	}
	options = ListOptions{From: &to, To: &from}
	if _, err := service.List(ctx, options); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("reversed time range was accepted: %v", err)
	}
}

// TestAuditSchemaMigratesLegacyActorKindConstraint 证明旧项目的 AuditRecord 表会在启动时就地迁移，
// 允许 Administrator 与 App User 审计事实，同时保留历史记录与 append-only 触发器。
func TestAuditSchemaMigratesLegacyActorKindConstraint(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "project.sqlite")
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	legacy := `CREATE TABLE modelry_audit_records (
		id TEXT PRIMARY KEY NOT NULL,
		request_id TEXT NOT NULL,
		occurred_at TEXT NOT NULL,
		occurred_unix_nano INTEGER NOT NULL,
		actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'serviceAccount')),
		actor_id TEXT NOT NULL,
		action TEXT NOT NULL,
		resource_json TEXT NOT NULL,
		result TEXT NOT NULL
	)`
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, legacy); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_audit_records (id, request_id, occurred_at, occurred_unix_nano, actor_kind, actor_id, action, resource_json, result) VALUES ('aud_legacy00000000001', 'req_legacy0001', '2026-09-25T09:00:00Z', 1, 'owner', 'own_legacy', 'collections.created', '{"kind":"collection","id":"col_legacy"}', 'success')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatalf("migrating a legacy AuditRecord table: %v", err)
	}
	if err := service.Append(ctx, AppendInput{
		Actor: Actor{Kind: ActorAppUser, ID: "rec_app_user"}, Action: "auth.emailVerificationConfirmed",
		Resource: Resource{Kind: "authCollection", ID: "col_members"}, Result: "success",
	}); err != nil {
		t.Fatalf("append App User audit fact after migration: %v", err)
	}
	listed, err := service.List(ctx, ListOptions{Limit: 10, ActorKind: ActorAppUser})
	if err != nil || len(listed.Data) != 1 {
		t.Fatalf("filter App User audit facts = %+v, err = %v", listed, err)
	}
	legacyRecord, err := service.Get(ctx, "aud_legacy00000000001")
	if err != nil || legacyRecord.Actor.ID != "own_legacy" {
		t.Fatalf("legacy AuditRecord was not preserved: %+v, %v", legacyRecord, err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_audit_records SET result = 'denied' WHERE id = 'aud_legacy00000000001'`)
		return err
	}); err == nil {
		t.Fatal("append-only update protection was lost during the migration")
	}
}