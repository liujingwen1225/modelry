package visualrules

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	testTriggerCollectionID = "col_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testTargetCollectionID  = "col_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testRecordID            = "rec_22222222222222222222222222222222"
)

// fakeCollections 提供真实形状的 Collection 模型，避免依赖整个 Runtime。
type fakeCollections struct {
	byID map[string]backendmodel.Collection
}

func (fake *fakeCollections) GetCollection(_ context.Context, id string) (backendmodel.Collection, error) {
	collection, found := fake.byID[id]
	if !found {
		return backendmodel.Collection{}, fmt.Errorf("%w: collection %q not found", backendmodel.ErrNotFound, id)
	}
	return collection, nil
}

// fakeCreator 记录「真实写入」的调用次数，用接口注入替代整个 Records 子系统。
type fakeCreator struct {
	calls          int
	nextID         string
	err            error
	lastCollection string
	lastValues     map[string]any
}

func (fake *fakeCreator) Create(_ context.Context, collectionID string, values map[string]any) (records.Record, error) {
	fake.calls++
	fake.lastCollection = collectionID
	fake.lastValues = values
	if fake.err != nil {
		return records.Record{}, fake.err
	}
	return records.Record{ID: fake.nextID, Values: values}, nil
}

func newTestService(t *testing.T) (*rulesService, *fakeCreator, *fakeCollections) {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.db"))
	if err != nil {
		t.Fatalf("打开真实 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := newService(store)
	if err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	collections := &fakeCollections{byID: map[string]backendmodel.Collection{
		testTriggerCollectionID: {
			ID: testTriggerCollectionID, Name: "Events", Type: backendmodel.CollectionTypeNormal,
			Fields: []backendmodel.Field{},
		},
		testTargetCollectionID: {
			ID: testTargetCollectionID, Name: "Orders", Type: backendmodel.CollectionTypeNormal,
			Fields: []backendmodel.Field{
				{ID: "fld_system_id", Name: "id", Type: backendmodel.FieldTypeText, Required: true, System: true},
				{ID: "fld_system_created_at", Name: "createdAt", Type: backendmodel.FieldTypeDateTime, Required: true, System: true},
				{ID: "fld_system_updated_at", Name: "updatedAt", Type: backendmodel.FieldTypeDateTime, Required: true, System: true},
				{ID: "fld_title", Name: "title", Type: backendmodel.FieldTypeText, Required: true},
			},
		},
	}}
	creator := &fakeCreator{nextID: "rec_11111111111111111111111111111111"}
	service.collections = collections
	service.creator = creator
	return service, creator, collections
}

func sampleInput() ruleInput {
	return ruleInput{
		Name:                "下单后创建记录",
		TriggerCollectionID: testTriggerCollectionID,
		TriggerEvent:        "record.created",
		TargetCollectionID:  testTargetCollectionID,
		Values:              map[string]string{"title": "{{user.email}} 下单"},
	}
}

func isProblemCode(err error, code string) bool {
	var problem apiProblem
	return errors.As(err, &problem) && problem.code == code
}

// 测试一：规则保存、读取、更新 revision、开关与校验。
func TestCreateGetAndReplaceRule(t *testing.T) {
	service, _, _ := newTestService(t)
	ctx := context.Background()

	created, err := service.createRule(ctx, sampleInput())
	if err != nil {
		t.Fatalf("保存规则失败: %v", err)
	}
	if !strings.HasPrefix(created.ID, ruleIDPrefix) {
		t.Fatalf("规则 ID 前缀应为 %q，得到 %q", ruleIDPrefix, created.ID)
	}
	if created.Revision != 1 || !created.Enabled || created.RetryEnabled || created.TimeoutMs != defaultTimeoutMs {
		t.Fatalf("默认值不正确: %+v", created)
	}
	if created.Values["title"] != "{{user.email}} 下单" {
		t.Fatalf("字段模板未保存: %+v", created.Values)
	}

	got, err := service.getRule(ctx, created.ID)
	if err != nil {
		t.Fatalf("读取规则失败: %v", err)
	}
	if got.Name != created.Name || got.TriggerEvent != created.TriggerEvent || got.TargetCollectionID != created.TargetCollectionID {
		t.Fatalf("读取结果与保存不一致: %+v", got)
	}
	if got.Values["title"] != created.Values["title"] {
		t.Fatalf("读取的字段模板不一致: %+v", got.Values)
	}

	list, err := service.listRules(ctx)
	if err != nil || len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("列表应只有一条规则: len=%d err=%v", len(list), err)
	}

	// 同名规则应冲突。
	if _, err := service.createRule(ctx, sampleInput()); !isProblemCode(err, "CONFLICT") {
		t.Fatalf("同名保存应返回 CONFLICT，得到 %v", err)
	}

	// PUT 全量替换并 revision+1。
	replacement := sampleInput()
	replacement.Name = "改名后的规则"
	updated, err := service.replaceRule(ctx, created.ID, replacement)
	if err != nil {
		t.Fatalf("替换规则失败: %v", err)
	}
	if updated.Revision != 2 || updated.Name != "改名后的规则" {
		t.Fatalf("替换结果不正确: %+v", updated)
	}
	if updated.CreatedAt != created.CreatedAt || updated.ID != created.ID {
		t.Fatalf("替换不应改变 ID 与创建时间: %+v", updated)
	}

	disabled, err := service.setEnabled(ctx, created.ID, false)
	if err != nil || disabled.Enabled {
		t.Fatalf("禁用失败: enabled=%v err=%v", disabled.Enabled, err)
	}
	enabled, err := service.setEnabled(ctx, created.ID, true)
	if err != nil || !enabled.Enabled {
		t.Fatalf("启用失败: enabled=%v err=%v", enabled.Enabled, err)
	}

	if _, err := service.getRule(ctx, "vlr_missing"); !isProblemCode(err, "NOT_FOUND") {
		t.Fatalf("不存在的规则应返回 NOT_FOUND，得到 %v", err)
	}

	// values 键必须是目标集合真实存在且非 system 的字段。
	invalid := sampleInput()
	invalid.Values = map[string]string{"id": "{{user.id}}"}
	if _, err := service.createRule(ctx, invalid); !isProblemCode(err, "VALIDATION_FAILED") {
		t.Fatalf("系统字段应被拒绝，得到 %v", err)
	}
	unknown := sampleInput()
	unknown.Values = map[string]string{"ghost": "x"}
	if _, err := service.createRule(ctx, unknown); !isProblemCode(err, "VALIDATION_FAILED") {
		t.Fatalf("未知字段应被拒绝，得到 %v", err)
	}
}

// 测试二：dry-run test 绝不写 Record / 绝不写用户，并持久化 test run。
func TestRuleTestIsDryRun(t *testing.T) {
	service, creator, _ := newTestService(t)
	ctx := context.Background()
	created, err := service.createRule(ctx, sampleInput())
	if err != nil {
		t.Fatalf("保存规则失败: %v", err)
	}

	result, err := service.testRule(ctx, created.ID, userPayload{User: testUser{
		ID: "u_1", Email: "a@example.com", DisplayName: "Alice",
	}})
	if err != nil {
		t.Fatalf("dry-run 失败: %v", err)
	}
	if !result.Passed {
		t.Fatalf("载荷完整时 test 应通过: %+v", result.Checks)
	}
	if len(result.Checks) != 5 {
		t.Fatalf("checks 应至少包含 5 项，得到 %d", len(result.Checks))
	}
	if result.Values["title"] != "a@example.com 下单" {
		t.Fatalf("渲染结果不正确: %+v", result.Values)
	}
	if !strings.HasPrefix(result.RunID, runIDPrefix) {
		t.Fatalf("runId 前缀不正确: %q", result.RunID)
	}
	if creator.calls != 0 {
		t.Fatalf("test 绝不写 Record，但 creator 被调用 %d 次", creator.calls)
	}

	runs, err := service.listRuns(ctx, created.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("应持久化一条 test run: len=%d err=%v", len(runs), err)
	}
	if runs[0].Kind != kindTest || runs[0].Status != statusSucceeded || runs[0].RecordID != "" {
		t.Fatalf("test run 内容不正确: %+v", runs[0])
	}
	if runs[0].Payload.User.Email != "a@example.com" {
		t.Fatalf("test run 载荷未持久化: %+v", runs[0].Payload)
	}

	// 载荷缺省：占位符未解析 -> 失败并给出真实原因，仍然绝不写 Record。
	failed, err := service.testRule(ctx, created.ID, userPayload{})
	if err != nil {
		t.Fatalf("缺载荷的 dry-run 不应报错: %v", err)
	}
	if failed.Passed {
		t.Fatal("占位符未解析时 test 应失败")
	}
	foundReason := false
	for _, item := range failed.Checks {
		if item.Label == "占位符解析" && !item.Passed && strings.Contains(item.Detail, "未提供") {
			foundReason = true
		}
	}
	if !foundReason {
		t.Fatalf("应给出占位符未提供的真实原因: %+v", failed.Checks)
	}
	if creator.calls != 0 {
		t.Fatalf("test 全程绝不写 Record，但 creator 被调用 %d 次", creator.calls)
	}

	runs, err = service.listRuns(ctx, created.ID)
	if err != nil || len(runs) != 2 {
		t.Fatalf("应持久化两条 test run: len=%d err=%v", len(runs), err)
	}
	hasFailed := false
	for _, item := range runs {
		if item.Kind == kindTest && item.Status == statusFailed && item.ErrorCode == "TEST_FAILED" && item.ErrorMessage != "" {
			hasFailed = true
		}
	}
	if !hasFailed {
		t.Fatalf("失败的 test run 应记录 errorCode/errorMessage: %+v", runs)
	}
}

// 测试三：真实执行失败后重试，关联原 run 并真实再执行一次。
func TestRetryAssociatesOriginalRun(t *testing.T) {
	service, creator, _ := newTestService(t)
	ctx := context.Background()
	created, err := service.createRule(ctx, sampleInput())
	if err != nil {
		t.Fatalf("保存规则失败: %v", err)
	}

	// 第一次 live 执行失败：错误被写入 run，但不吞掉。
	creator.err = errors.New("模拟目标集合模型不匹配")
	first, err := service.runRule(ctx, created.ID, userPayload{User: testUser{Email: "x@example.com"}})
	if err != nil {
		t.Fatalf("执行失败也应返回持久化的 Run: %v", err)
	}
	if first.Kind != kindLive || first.Status != statusFailed || first.RecordID != "" {
		t.Fatalf("失败的 live run 内容不正确: %+v", first)
	}
	if first.ErrorCode == "" || first.ErrorMessage == "" {
		t.Fatalf("失败原因不能吞掉: %+v", first)
	}
	if creator.calls != 1 {
		t.Fatalf("应真实执行一次，得到 %d 次", creator.calls)
	}

	// test run 不允许重试。
	testRun, err := service.testRule(ctx, created.ID, userPayload{User: testUser{Email: "y@example.com"}})
	if err != nil {
		t.Fatalf("dry-run 失败: %v", err)
	}
	if _, err := service.retryRun(ctx, testRun.RunID); !isProblemCode(err, "RUN_NOT_RETRYABLE") {
		t.Fatalf("test run 应返回 RUN_NOT_RETRYABLE，得到 %v", err)
	}

	// 重试：服务恢复后真实再执行一次，关联原 run 并带回真实 record id。
	creator.err = nil
	creator.nextID = testRecordID
	retried, err := service.retryRun(ctx, first.ID)
	if err != nil {
		t.Fatalf("重试失败: %v", err)
	}
	if retried.AttemptOf != first.ID {
		t.Fatalf("attemptOf 应指向原 run: %+v", retried)
	}
	if retried.ID == first.ID || retried.Kind != kindLive || retried.Status != statusSucceeded {
		t.Fatalf("重试应产生新的成功 live run: %+v", retried)
	}
	if retried.RecordID != testRecordID {
		t.Fatalf("重试成功应带真实 record id，得到 %q", retried.RecordID)
	}
	if retried.Payload.User.Email != "x@example.com" {
		t.Fatalf("重试应使用原 payload: %+v", retried.Payload)
	}
	if creator.calls != 2 {
		t.Fatalf("重试应真实再执行一次，共 2 次，得到 %d 次", creator.calls)
	}
	if creator.lastCollection != testTargetCollectionID {
		t.Fatalf("应写入目标集合，得到 %q", creator.lastCollection)
	}
	if creator.lastValues["title"] != "x@example.com 下单" {
		t.Fatalf("重试应重新渲染模板: %+v", creator.lastValues)
	}

	// 成功 run 与不存在的 run 的状态边界。
	if _, err := service.retryRun(ctx, retried.ID); !isProblemCode(err, "RUN_NOT_RETRYABLE") {
		t.Fatalf("成功 run 应返回 RUN_NOT_RETRYABLE，得到 %v", err)
	}
	if _, err := service.retryRun(ctx, "vrr_missing"); !isProblemCode(err, "NOT_FOUND") {
		t.Fatalf("不存在的 run 应返回 NOT_FOUND，得到 %v", err)
	}

	runs, err := service.listRuns(ctx, created.ID)
	if err != nil || len(runs) != 3 {
		t.Fatalf("应持久化三条 run（live/test/live）：len=%d err=%v", len(runs), err)
	}
	if runs[0].CreatedAt < runs[1].CreatedAt || runs[1].CreatedAt < runs[2].CreatedAt {
		t.Fatalf("runs 应按 created_at DESC 排序: %+v", runs)
	}
}
