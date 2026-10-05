package backendmodel

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// 审计失败必须回滚模型、投影和应用历史；恢复审计后可以重试。
func TestSchemaApplyAuditFailureRollsBackAndRetryWritesOneFact(t *testing.T) {
	ctx := audit.WithActor(context.Background(), audit.Actor{Kind: audit.ActorServiceAccount, ID: "sa_agent"})
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	audits, err := audit.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, audits)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, CreateCollectionInput{Name: "notes", Type: CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := service.SaveOperation(ctx, collection.ID, PendingOperationInput{Kind: OperationField, Action: OperationAdd, Definition: json.RawMessage(`{"name":"done","type":"boolean"}`)})
	if err != nil {
		t.Fatal(err)
	}
	err = store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `CREATE TRIGGER audit_unavailable BEFORE INSERT ON modelry_audit_records BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Apply(ctx, collection.ID, pending.Version, true); err == nil {
		t.Fatal("审计失败仍成功应用模型")
	}
	unchanged, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.SchemaVersion != 1 {
		t.Fatal("审计失败后模型未回滚")
	}
	if _, found := fieldByName(unchanged.Fields, "done"); found {
		t.Fatal("审计失败留下新增字段")
	}
	projection, err := service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := projectedFieldByName(projection.Fields, "done"); found {
		t.Fatal("审计失败留下字段投影")
	}
	history, err := service.History(ctx, collection.ID, ListOptions{})
	if err != nil || len(history.Data) != 0 {
		t.Fatalf("审计失败留下成功历史：%+v %v", history, err)
	}
	err = store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `DROP TRIGGER audit_unavailable`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Apply(ctx, collection.ID, pending.Version, true); err != nil {
		t.Fatal(err)
	}
	page, err := audits.List(ctx, audit.ListOptions{Action: "schema.apply"})
	if err != nil || len(page.Data) != 1 {
		t.Fatalf("重试未产生唯一成功审计：%+v %v", page, err)
	}
	if page.Data[0].Actor.ID != "sa_agent" || page.Data[0].Resource.ID != pending.ChangeSetID {
		t.Fatalf("成功审计关联错误：%+v", page.Data[0])
	}
	if _, err := service.Apply(ctx, collection.ID, pending.Version, true); err == nil {
		t.Fatal("已应用变更被再次应用")
	}
	page, err = audits.List(ctx, audit.ListOptions{Action: "schema.apply"})
	if err != nil || len(page.Data) != 1 {
		t.Fatal("失败的重复应用产生成功审计")
	}
}
