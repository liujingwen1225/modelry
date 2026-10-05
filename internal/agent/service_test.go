package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestConfirmationDoesNotWriteBeforeApprovalOrRepeat(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	svc, err := NewService(context.Background(), store, nil, audits, func(ctx context.Context, a Actor) (context.Context, error) {
		return audit.WithActor(ctx, audit.Actor{Kind: audit.ActorOwner, ID: a.ID}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	svc.SetHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			calls.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"id":"col_test","name":"notes"}}`))
	}))
	actor := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	session, err := svc.CreateSession(context.Background(), actor, "测试")
	if err != nil {
		t.Fatal(err)
	}
	op, err := svc.Call(context.Background(), session.ID, actor, "collections_create", map[string]any{"body": map[string]any{"name": "notes", "type": "Normal"}})
	if err != nil {
		t.Fatal(err)
	}
	if op.State != "awaitingApproval" || calls.Load() != 0 {
		t.Fatal("未批准就发生写入", op.State, calls.Load())
	}
	op, err = svc.Approve(context.Background(), op.ID, actor)
	if err != nil {
		t.Fatal(err)
	}
	if op.State != "succeeded" || calls.Load() != 1 {
		t.Fatal("确认没有只执行一次", op.State, calls.Load())
	}
	_, err = svc.Approve(context.Background(), op.ID, actor)
	if err != nil || calls.Load() != 1 {
		t.Fatal("重复批准导致重放", err, calls.Load())
	}
	policy := Policy{Mode: "autoWrites", AllowedOperations: []string{"collections.create", "schema.apply"}, AutoOperations: []string{"collections.create", "schema.apply"}}
	if _, err = svc.SavePolicy(context.Background(), "builtin", policy, actor); err != nil {
		t.Fatal(err)
	}
	op, err = svc.Call(context.Background(), session.ID, actor, "schema_apply", map[string]any{"collectionId": "col_test", "body": map[string]any{"expectedVersion": json.Number("1")}})
	if err != nil || op.State != "awaitingApproval" {
		t.Fatal("高风险操作被自动执行", err, op.State)
	}
}

func TestTargetConflictPolicyRevocationAndDataGrant(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(context.Background(), store, nil, audits, func(ctx context.Context, a Actor) (context.Context, error) {
		return audit.WithActor(ctx, audit.Actor{Kind: audit.ActorOwner, ID: a.ID}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	var writes atomic.Int32
	version := 1
	svc.SetHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			writes.Add(1)
		}
		if r.URL.Path == "/admin/api/v1/collections/col_test/records" {
			if r.URL.Query().Get("limit") != "20" {
				t.Error("记录读取未限制为 20 条")
			}
			w.Write([]byte(`{"data":[{"id":"rec_test","values":{"title":"授权内容","private":"不能发送","password":"不能泄露"}}],"nextCursor":"cursor_test"}`))
			return
		}
		w.Write([]byte(`{"data":{"version":` + fmt.Sprint(version) + `}}`))
	}))
	actor := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	session, err := svc.CreateSession(context.Background(), actor, "测试")
	if err != nil {
		t.Fatal(err)
	}
	op, err := svc.Call(context.Background(), session.ID, actor, "collections_create", map[string]any{"body": map[string]any{"name": "notes"}})
	if err != nil {
		t.Fatal(err)
	}
	version++
	op, err = svc.Approve(context.Background(), op.ID, actor)
	if err != nil || op.State != "stale" || writes.Load() != 0 {
		t.Fatal("目标变化后仍执行", op.State, err)
	}
	op, err = svc.Call(context.Background(), session.ID, actor, "collections_create", map[string]any{"body": map[string]any{"name": "other"}})
	if err != nil {
		t.Fatal(err)
	}
	policy, _ := svc.Policy(context.Background(), "builtin")
	policy.Mode = "readOnly"
	if _, err = svc.SavePolicy(context.Background(), "builtin", policy, actor); err != nil {
		t.Fatal(err)
	}
	op, err = svc.Approve(context.Background(), op.ID, actor)
	if err != nil || op.State != "stale" || writes.Load() != 0 {
		t.Fatal("权限收紧后仍执行", op.State, err)
	}
	args := map[string]any{"collectionId": "col_test", "limit": json.Number("100")}
	if _, err = svc.Call(context.Background(), session.ID, actor, "records_list", args); err == nil {
		t.Fatal("无会话授权就读取业务数据")
	}
	if err = svc.Grant(context.Background(), session.ID, DataGrant{CollectionID: "col_test", Fields: []string{"title"}}, actor); err != nil {
		t.Fatal(err)
	}
	op, err = svc.Call(context.Background(), session.ID, actor, "records_list", args)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(op.Result)
	if strings.Contains(string(b), "不能发送") || strings.Contains(string(b), "不能泄露") || !strings.Contains(string(b), "授权内容") {
		t.Fatal("字段授权无效", string(b))
	}
	persisted, err := svc.GetOperation(context.Background(), op.ID, actor)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(persisted)
	if strings.Contains(string(b), "授权内容") {
		t.Fatal("原始查询结果进入了耐久会话")
	}
	if _, err = svc.Approve(context.Background(), op.ID, Actor{Identity: "sa_test", Kind: "serviceAccount", ID: "sa_test"}); err == nil {
		t.Fatal("智能体可以自行批准")
	}
}

func TestBatchConfirmsFixedOrdinaryOperationsAndRestartDoesNotReplay(t *testing.T) {
	root := t.TempDir()
	store, err := storage.Open(filepath.Join(root, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	var writes atomic.Int32
	resolver := func(ctx context.Context, a Actor) (context.Context, error) {
		return audit.WithActor(ctx, audit.Actor{Kind: audit.ActorOwner, ID: a.ID}), nil
	}
	svc, err := NewService(context.Background(), store, nil, audits, resolver)
	if err != nil {
		t.Fatal(err)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/admin/api/v1/extensions" || r.URL.Path == "/admin/api/v1/event-hooks" {
			w.Write([]byte(`{"data":[]}`))
			return
		}
		if r.Method == http.MethodPost {
			writes.Add(1)
		}
		w.Write([]byte(`{"data":{"id":"col_test","fields":[]}}`))
	})
	svc.SetHandler(handler)
	actor := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	v, err := svc.CreateSession(context.Background(), actor, "批次")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, name := range []string{"one", "two"} {
		op, err := svc.Call(context.Background(), v.ID, actor, "records_create", map[string]any{"collectionId": "col_test", "body": map[string]any{"values": map[string]any{"title": name}}})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, op.ID)
	}
	result, err := svc.ApproveBatch(context.Background(), ids, actor)
	if err != nil || len(result) != 2 || writes.Load() != 2 {
		t.Fatal("批次未完整执行", err, result, writes.Load())
	}
	if _, err = svc.ApproveBatch(context.Background(), ids, actor); err != nil || writes.Load() != 2 {
		t.Fatal("重复批准批次造成重放", err, writes.Load())
	}
	svc.Close()
	restarted, err := NewService(context.Background(), store, nil, audits, resolver)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	restarted.SetHandler(handler)
	for _, id := range ids {
		op, err := restarted.Approve(context.Background(), id, actor)
		if err != nil || op.State != "succeeded" {
			t.Fatal("重启后状态丢失", op, err)
		}
	}
	if writes.Load() != 2 {
		t.Fatal("重启后自动重放")
	}
}

func TestExecutionModesConcurrentApprovalAndCancellation(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(context.Background(), store, nil, audits, func(ctx context.Context, a Actor) (context.Context, error) { return ctx, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	var writes atomic.Int32
	svc.SetHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			writes.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"id":"col_test"}}`))
	}))
	a := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	session, err := svc.CreateSession(context.Background(), a, "策略测试")
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"body": map[string]any{"name": "notes", "type": "Normal"}}
	policy := Policy{Mode: "readOnly", AllowedOperations: []string{"collections.read", "collections.create"}}
	if _, err = svc.SavePolicy(context.Background(), "builtin", policy, a); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Call(context.Background(), session.ID, a, "collections_create", args); err == nil || writes.Load() != 0 {
		t.Fatal("只读策略允许写入")
	}
	policy.Mode = "autoWrites"
	policy.Revision = 1
	policy.AutoOperations = []string{"collections.create"}
	if _, err = svc.SavePolicy(context.Background(), "builtin", policy, a); err != nil {
		t.Fatal(err)
	}
	op, err := svc.Call(context.Background(), session.ID, a, "collections_create", args)
	if err != nil || op.State != "succeeded" || writes.Load() != 1 {
		t.Fatal("普通自动写入没有执行", op.State, err)
	}
	policy.Mode = "confirmWrites"
	policy.Revision = 2
	if _, err = svc.SavePolicy(context.Background(), "builtin", policy, a); err != nil {
		t.Fatal(err)
	}
	op, err = svc.Call(context.Background(), session.ID, a, "collections_create", args)
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	group.Add(8)
	for i := 0; i < 8; i++ {
		go func() {
			defer group.Done()
			_, e := svc.Approve(context.Background(), op.ID, a)
			if e != nil {
				t.Errorf("并发批准失败 %v", e)
			}
		}()
	}
	group.Wait()
	if writes.Load() != 2 {
		t.Fatal("并发确认造成重复执行", writes.Load())
	}
	op, err = svc.Call(context.Background(), session.ID, a, "collections_create", args)
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.Cancel(context.Background(), session.ID, a); err != nil {
		t.Fatal(err)
	}
	op, err = svc.Approve(context.Background(), op.ID, a)
	if err != nil || op.State != "cancelled" || writes.Load() != 2 {
		t.Fatal("取消后仍执行待确认写入", op.State, err)
	}
	if hasSensitive(map[string]any{"emailPasswordEnabled": true}) || !hasSensitive(map[string]any{"password": "不能进入模型"}) {
		t.Fatal("认证配置与密码未正确区分")
	}
}

func TestUncertainWriteCannotAutomaticallyRetry(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(context.Background(), store, nil, audits, func(ctx context.Context, a Actor) (context.Context, error) { return ctx, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	var attempts atomic.Int32
	svc.SetHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" && attempts.Add(1) == 1 {
			w.WriteHeader(500)
			w.Write([]byte(`{"error":{"code":"UNKNOWN_RESULT"}}`))
			return
		}
		w.Write([]byte(`{"data":{"id":"col_test"}}`))
	}))
	actor := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	session, err := svc.CreateSession(context.Background(), actor, "恢复测试")
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.SavePolicy(context.Background(), "builtin", Policy{Mode: "autoWrites", AllowedOperations: []string{"collections.create"}, AutoOperations: []string{"collections.create"}}, actor)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"body": map[string]any{"name": "notes", "type": "Normal"}}
	failed, err := svc.Call(context.Background(), session.ID, actor, "collections_create", args)
	if err != nil || failed.State != "failed" {
		t.Fatal("没有保存失败事实", err, failed.State)
	}
	retry, err := svc.Call(context.Background(), session.ID, actor, "collections_create", args)
	if err != nil || retry.State != "awaitingApproval" || !retry.Risk || attempts.Load() != 1 {
		t.Fatal("结果不确定的写入被自动重放", retry.State, err, attempts.Load())
	}
}

func TestRecordReviewDoesNotPersistOrReturnRawOldValuesToModel(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(context.Background(), store, nil, audits, func(ctx context.Context, a Actor) (context.Context, error) { return ctx, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	svc.SetHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/rec_test") {
			w.Write([]byte(`{"data":{"id":"rec_test","values":{"title":"旧值不能落盘","private":"私密原始值"}}}`))
			return
		}
		w.Write([]byte(`{"data":[]}`))
	}))
	actor := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	session, err := svc.CreateSession(context.Background(), actor, "复核测试")
	if err != nil {
		t.Fatal(err)
	}
	op, err := svc.Call(context.Background(), session.ID, actor, "records_update", map[string]any{"collectionId": "col_test", "recordId": "rec_test", "body": map[string]any{"values": map[string]any{"title": "新值"}}})
	if err != nil {
		t.Fatal(err)
	}
	transient, _ := json.Marshal(op)
	if strings.Contains(string(transient), "旧值不能落盘") || strings.Contains(string(transient), "私密原始值") {
		t.Fatal("未授权的旧值进入模型工具结果")
	}
	if err = store.WithReadSnapshot(context.Background(), func(tx storage.Executor) error {
		var body string
		if err := tx.QueryRowContext(context.Background(), `SELECT body FROM modelry_agent_operations WHERE id=?`, op.ID).Scan(&body); err != nil {
			return err
		}
		if strings.Contains(body, "旧值不能落盘") || strings.Contains(body, "私密原始值") {
			t.Error("原始旧值进入耐久步骤")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ownerPreview, err := svc.GetOperation(context.Background(), op.ID, actor)
	if err != nil {
		t.Fatal(err)
	}
	preview, _ := json.Marshal(ownerPreview.Before)
	if !strings.Contains(string(preview), "旧值不能落盘") || strings.Contains(string(preview), "私密原始值") {
		t.Fatal("Owner 不能复核被修改字段，或暴露了其他字段", string(preview))
	}
}
