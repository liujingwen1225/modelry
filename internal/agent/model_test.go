package agent

import (
	"context"
	"encoding/json"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// 使用真实 HTTP 兼容协议验证工具回合、批次确认和运行中模型配置固定。
func TestModelLoopBatchConfirmationAndFrozenConfiguration(t *testing.T) {
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
	var writes, requests atomic.Int32
	svc.SetHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			writes.Add(1)
		}
		w.Write([]byte(`{"data":{"id":"col_test","name":"notes"}}`))
	}))
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("错误协议路径 %s", r.URL.Path)
		}
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		if payload["model"] != "frozen-model" {
			t.Errorf("运行中切换模型 %v", payload["model"])
		}
		w.Header().Set("Content-Type", "application/json")
		if requests.Add(1) == 1 {
			w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":"已列出两个待确认操作","tool_calls":[{"id":"call_1","type":"function","function":{"name":"collections_create","arguments":"{\"body\":{\"name\":\"notes_one\",\"type\":\"Normal\"}}"}},{"id":"call_2","type":"function","function":{"name":"collections_create","arguments":"{\"body\":{\"name\":\"notes_two\",\"type\":\"Normal\"}}"}}]}}]}`))
		} else {
			w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"两个操作均已完成"}}]}`))
		}
	}))
	defer provider.Close()
	actor := Actor{Identity: "builtin", Kind: "owner", ID: "owner_test"}
	if _, err = svc.SaveConfig(context.Background(), ConfigInput{BaseURL: provider.URL, Model: "frozen-model"}, actor); err != nil {
		t.Fatal(err)
	}
	session, err := svc.CreateSession(context.Background(), actor, "Agent")
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.Start(context.Background(), session.ID, "创建两个集合", "/collections", actor); err != nil {
		t.Fatal(err)
	}
	wait := func(check func(Session) bool) Session {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			v, e := svc.GetSession(context.Background(), session.ID, actor)
			if e != nil {
				t.Fatal(e)
			}
			if check(v) {
				return v
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("模型回合未完成")
		return Session{}
	}
	pending := wait(func(v Session) bool { return len(v.Operations) == 2 })
	if writes.Load() != 0 {
		t.Fatal("未确认发生写入")
	}
	if _, err = svc.SaveConfig(context.Background(), ConfigInput{BaseURL: provider.URL, Model: "next-model", Revision: 1}, actor); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ApproveBatch(context.Background(), []string{pending.Operations[0].ID, pending.Operations[1].ID}, actor); err != nil {
		t.Fatal(err)
	}
	wait(func(v Session) bool { return v.State == "completed" })
	if writes.Load() != 2 || requests.Load() != 2 {
		t.Fatal("执行次数异常", writes.Load(), requests.Load())
	}
}
