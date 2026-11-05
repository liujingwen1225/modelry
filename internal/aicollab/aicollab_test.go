package aicollab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const testRequirement = "让文章可对外公开（机密需求文本-ZH-48）"

// testEnv 使用真实 SQLite（t.TempDir 文件）+ 真实 backendmodel.Service。
type testEnv struct {
	ctx        context.Context
	store      *storage.Store
	models     *backendmodel.Service
	module     *Module
	collection backendmodel.Collection
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatalf("打开真实 SQLite 测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatalf("初始化真实 Backend Model 失败: %v", err)
	}
	module, err := NewModule(store, models)
	if err != nil {
		t.Fatalf("初始化 aicollab 模块失败: %v", err)
	}
	// 单测里替换 Owner 守卫以构造「已认证」上下文（生产仍走 adminauth.OwnerFromContext）。
	module.checkOwner = func(context.Context) bool { return true }

	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name:   "Articles",
		Type:   backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatalf("创建真实集合失败: %v", err)
	}
	return &testEnv{ctx: ctx, store: store, models: models, module: module, collection: collection}
}

func (env *testEnv) createProposal(t *testing.T, fieldName string) Proposal {
	t.Helper()
	p, err := env.module.service.createProposal(env.ctx, createProposalInput{
		Requirement: testRequirement, CollectionID: env.collection.ID, FieldName: fieldName,
	})
	if err != nil {
		t.Fatalf("创建提案失败: %v", err)
	}
	return p
}

func perform(mux *http.ServeMux, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

type errorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// TestCreateProposalDoesNotWriteBusinessData 验证创建提案只写 aicollab 自己的表：
// understanding_json 是真实项目事实的规则化理解，不创建 Pending Change、不写任何业务数据。
func TestCreateProposalDoesNotWriteBusinessData(t *testing.T) {
	env := newTestEnv(t)
	p := env.createProposal(t, "is_public")

	if p.Status != StatusDraft || p.ChangeSetID != "" || p.FieldName != "is_public" {
		t.Fatalf("提案初始状态不正确: %+v", p)
	}
	if !strings.Contains(p.Title, "规则化提案") {
		t.Fatalf("标题未明确标注为规则化（非大模型生成）: %q", p.Title)
	}

	var understanding Understanding
	if err := json.Unmarshal(p.UnderstandingJSON, &understanding); err != nil {
		t.Fatalf("understanding_json 不是合法结构化事实: %v", err)
	}
	if !strings.Contains(understanding.Note, "规则化理解，非大模型生成") {
		t.Fatalf("缺少「规则化理解，非大模型生成」说明: %q", understanding.Note)
	}
	if understanding.Collection.Name != "Articles" || understanding.Collection.Type != string(backendmodel.CollectionTypeNormal) || understanding.Collection.SchemaVersion != 1 {
		t.Fatalf("集合事实不真实: %+v", understanding.Collection)
	}
	if understanding.TargetFieldName != "is_public" || understanding.TargetFieldExists {
		t.Fatalf("目标字段事实不真实: %+v", understanding)
	}
	if !containsFieldName(understanding.Fields, "title") {
		t.Fatalf("当前字段列表未反映真实 Applied Model: %+v", understanding.Fields)
	}

	// 没有写业务数据：Applied Model 未变、没有 Pending Change。
	collection, err := env.models.GetCollection(env.ctx, env.collection.ID)
	if err != nil {
		t.Fatalf("读取真实 Applied Model 失败: %v", err)
	}
	if _, exists := findField(collection.Fields, "is_public"); exists {
		t.Fatal("创建提案竟然把字段写进了 Applied Model")
	}
	if collection.SchemaVersion != 1 {
		t.Fatalf("创建提案改变了 schemaVersion: %d", collection.SchemaVersion)
	}
	if _, exists, err := env.models.GetPendingChange(env.ctx, env.collection.ID); err != nil || exists {
		t.Fatalf("创建提案竟然创建了 Pending Change: exists=%v err=%v", exists, err)
	}

	// 提案本身确实落库。
	if _, found, err := env.module.service.getProposal(env.ctx, p.ID); err != nil || !found {
		t.Fatalf("提案未持久化: found=%v err=%v", found, err)
	}
}

func containsFieldName(fields []UnderstandingField, name string) bool {
	for _, field := range fields {
		if field.Name == name {
			return true
		}
	}
	return false
}

// TestPlanGeneratesRealPendingChange 验证 plan 通过 SaveOperation 生成真实 pending 变更，
// 并验证「目标字段已存在」返回 409 FIELD_ALREADY_EXISTS、重复 plan 被拒绝。
func TestPlanGeneratesRealPendingChange(t *testing.T) {
	env := newTestEnv(t)
	p := env.createProposal(t, "is_public")

	planned, err := env.module.service.plan(env.ctx, p.ID)
	if err != nil {
		t.Fatalf("生成方案失败: %v", err)
	}
	if planned.Status != StatusPlanned || planned.ChangeSetID == "" {
		t.Fatalf("方案状态/ChangeSetID 不正确: %+v", planned)
	}

	pending, exists, err := env.models.GetPendingChange(env.ctx, env.collection.ID)
	if err != nil || !exists {
		t.Fatalf("未生成真实 Pending Change: exists=%v err=%v", exists, err)
	}
	if pending.ChangeSetID != planned.ChangeSetID {
		t.Fatalf("ChangeSetID 不一致: pending=%s proposal=%s", pending.ChangeSetID, planned.ChangeSetID)
	}
	if len(pending.Operations) != 1 {
		t.Fatalf("真实 Pending Operation 数量不对: %d", len(pending.Operations))
	}
	op := pending.Operations[0]
	if op.Kind != backendmodel.OperationField || op.Action != backendmodel.OperationAdd {
		t.Fatalf("Operation 不是 field/add: %+v", op)
	}
	var definition struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Required bool   `json:"required"`
	}
	if err := json.Unmarshal(op.Definition, &definition); err != nil {
		t.Fatalf("Operation definition 非法: %v", err)
	}
	if definition.Name != "is_public" || definition.Type != "boolean" || definition.Required {
		t.Fatalf("Operation definition 不是目标布尔字段: %+v", definition)
	}

	// 不得直接改 SQLite 表结构：Applied Model 仍没有该字段、schemaVersion 未变。
	collection, err := env.models.GetCollection(env.ctx, env.collection.ID)
	if err != nil {
		t.Fatalf("读取 Applied Model 失败: %v", err)
	}
	if _, exists := findField(collection.Fields, "is_public"); exists {
		t.Fatal("plan 竟然直接改了物理表结构 / Applied Model")
	}
	if collection.SchemaVersion != 1 {
		t.Fatalf("plan 改变了 schemaVersion: %d", collection.SchemaVersion)
	}

	// 目标字段已存在 → 409 FIELD_ALREADY_EXISTS。
	existing := env.createProposal(t, "title")
	_, err = env.module.service.plan(env.ctx, existing.ID)
	assertProblem(t, err, http.StatusConflict, "FIELD_ALREADY_EXISTS")

	// 重复 plan → 409 PROPOSAL_STATE。
	_, err = env.module.service.plan(env.ctx, planned.ID)
	assertProblem(t, err, http.StatusConflict, "PROPOSAL_STATE")
}

func assertProblem(t *testing.T, err error, status int, code string) {
	t.Helper()
	var p *problem
	if !errors.As(err, &p) {
		t.Fatalf("期望领域错误 %s，实际: %v", code, err)
	}
	if p.status != status || p.code != code {
		t.Fatalf("期望 %d/%s，实际 %d/%s", status, code, p.status, p.code)
	}
}

// TestPublicShareNotFoundAfterRevokeOrExpiry 验证公开分享只暴露提案摘要，
// 且 revoke / 过期 / 未知 token 都返回完全相同的 404 SHARE_NOT_FOUND、不泄漏数据。
func TestPublicShareNotFoundAfterRevokeOrExpiry(t *testing.T) {
	env := newTestEnv(t)
	p := env.createProposal(t, "is_public")
	valid, err := env.module.service.createShare(env.ctx, p.ID, nil)
	if err != nil {
		t.Fatalf("创建分享失败: %v", err)
	}
	revoked, err := env.module.service.createShare(env.ctx, p.ID, nil)
	if err != nil {
		t.Fatalf("创建分享失败: %v", err)
	}
	expired, err := env.module.service.createShare(env.ctx, p.ID, nil)
	if err != nil {
		t.Fatalf("创建分享失败: %v", err)
	}
	if len(valid.Token) < 32 || !strings.HasPrefix(valid.URL, "/ai/share/") {
		t.Fatalf("token / url 不合规: token=%q url=%q", valid.Token, valid.URL)
	}

	mux := http.NewServeMux()
	env.module.RegisterRoutes(mux)

	// 有效分享：200，裸对象，字段来自真实 DB，不含内部信息。
	okResponse := perform(mux, http.MethodGet, "/api/v1/public/ai/shares/"+valid.Token, "")
	if okResponse.Code != http.StatusOK {
		t.Fatalf("有效分享应返回 200，实际 %d: %s", okResponse.Code, okResponse.Body.String())
	}
	var view PublicShareView
	if err := json.Unmarshal(okResponse.Body.Bytes(), &view); err != nil {
		t.Fatalf("公开响应不是预期裸对象: %v", err)
	}
	if view.ProposalID != p.ID || view.Status != StatusDraft || view.FieldName != "is_public" || view.CollectionName != "Articles" {
		t.Fatalf("公开摘要字段不真实: %+v", view)
	}
	// proposalId 是契约明确要求的公开字段（aip_ 前缀的不透明 ID），
	// 因此只断言 token、ais_ 分享 ID、内部表名、绝对路径等不应出现的内容。
	okBody := okResponse.Body.String()
	for _, secret := range []string{valid.Token, "modelry_", "modelry_ai", "ais_", "/Users/"} {
		if strings.Contains(okBody, secret) {
			t.Fatalf("公开响应泄漏了敏感/内部信息 %q: %s", secret, okBody)
		}
	}
	if !strings.Contains(okBody, testRequirement) {
		t.Fatalf("公开摘要应包含 requirement: %s", okBody)
	}

	// 通过 HTTP DELETE 撤销（含幂等第二次）。
	deleteAgain := perform(mux, http.MethodDelete, "/admin/api/v1/ai/shares/"+revoked.ID, "")
	if deleteAgain.Code != http.StatusNoContent {
		t.Fatalf("撤销应返回 204，实际 %d", deleteAgain.Code)
	}
	deleteTwice := perform(mux, http.MethodDelete, "/admin/api/v1/ai/shares/"+revoked.ID, "")
	if deleteTwice.Code != http.StatusNoContent {
		t.Fatalf("重复撤销应幂等返回 204，实际 %d", deleteTwice.Code)
	}

	// 过期：真实改 DB 的 expires_at 到过去。
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if err := env.store.WithTransaction(env.ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(env.ctx, `UPDATE modelry_ai_share_links SET expires_at = ? WHERE id = ?`, past, expired.ID)
		return err
	}); err != nil {
		t.Fatalf("构造过期分享失败: %v", err)
	}

	// 三种无效情形 + 未知 token 都必须是同一个 404，且不带任何提案数据。
	notFoundTargets := []string{
		"/api/v1/public/ai/shares/" + revoked.Token,
		"/api/v1/public/ai/shares/" + expired.Token,
		"/api/v1/public/ai/shares/unknown-token-value",
	}
	var referenceCode, referenceMessage string
	for index, target := range notFoundTargets {
		response := perform(mux, http.MethodGet, target, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("无效分享 %q 应返回 404，实际 %d: %s", target, response.Code, response.Body.String())
		}
		var envelope errorEnvelope
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("404 响应不是统一错误格式: %v", err)
		}
		if envelope.Error.Code != "SHARE_NOT_FOUND" {
			t.Fatalf("404 错误码应为 SHARE_NOT_FOUND，实际 %q", envelope.Error.Code)
		}
		if index == 0 {
			referenceCode, referenceMessage = envelope.Error.Code, envelope.Error.Message
		} else if envelope.Error.Code != referenceCode || envelope.Error.Message != referenceMessage {
			t.Fatalf("无效原因被区分泄漏: %q vs %q", envelope.Error.Message, referenceMessage)
		}
		body := response.Body.String()
		for _, secret := range []string{testRequirement, valid.Token, revoked.Token, expired.Token, p.ID, "Articles"} {
			if strings.Contains(body, secret) {
				t.Fatalf("404 响应泄漏了提案数据 %q: %s", secret, body)
			}
		}
	}
}

// TestApplyAndVerifyRealLifecycle 走真实 Apply / 验证：字段确实进入 Applied Model，
// 状态变为 verified，且验证结论全部通过。
func TestApplyAndVerifyRealLifecycle(t *testing.T) {
	env := newTestEnv(t)
	p := env.createProposal(t, "is_public")
	planned, err := env.module.service.plan(env.ctx, p.ID)
	if err != nil {
		t.Fatalf("生成方案失败: %v", err)
	}
	applied, err := env.module.service.apply(env.ctx, planned.ID, false)
	if err != nil {
		t.Fatalf("真实 Apply 失败: %v", err)
	}
	if applied.Status != StatusApplied || applied.ErrorCode != "" {
		t.Fatalf("Apply 后状态不正确: %+v", applied)
	}

	collection, err := env.models.GetCollection(env.ctx, env.collection.ID)
	if err != nil {
		t.Fatalf("读取 Applied Model 失败: %v", err)
	}
	field, exists := findField(collection.Fields, "is_public")
	if !exists || field.Type != backendmodel.FieldTypeBoolean {
		t.Fatalf("目标字段未真实进入 Applied Model 或类型不对: %+v", field)
	}
	if _, exists, _ := env.models.GetPendingChange(env.ctx, env.collection.ID); exists {
		t.Fatal("应用后仍存在待应用变更")
	}

	detail, err := env.module.service.verify(env.ctx, applied.ID)
	if err != nil {
		t.Fatalf("验证失败: %v", err)
	}
	if detail.Status != StatusVerified || !detail.Verification.Passed {
		t.Fatalf("验证结论不正确: status=%s passed=%v checks=%+v", detail.Status, detail.Verification.Passed, detail.Verification.Checks)
	}
	if len(detail.Verification.Checks) < 3 {
		t.Fatalf("验证检查项不足: %+v", detail.Verification.Checks)
	}
}

// failingApplyModels 演示 models 可注入：仅覆写 Apply，其余方法委托真实 Service。
type failingApplyModels struct {
	backendModelAPI
	err error
}

func (f *failingApplyModels) Apply(_ context.Context, _ string, _ int, _ bool) (backendmodel.ApplyResult, error) {
	return backendmodel.ApplyResult{}, f.err
}

// TestApplyFailureRecordsRealError 用 fake 注入真实的 CHANGE_CONFIRMATION_REQUIRED 语义，
// 验证失败被真实记录（status failed + errorCode/errorMessage），且不伪造成功、不泄漏 SQLite 细节。
func TestApplyFailureRecordsRealError(t *testing.T) {
	env := newTestEnv(t)
	p := env.createProposal(t, "is_public")
	planned, err := env.module.service.plan(env.ctx, p.ID)
	if err != nil {
		t.Fatalf("生成方案失败: %v", err)
	}

	env.module.service.models = &failingApplyModels{
		backendModelAPI: env.models,
		err:             fmt.Errorf("%w: review the impact and confirm this schema change", backendmodel.ErrChangeConfirmationRequired),
	}
	_, err = env.module.service.apply(env.ctx, planned.ID, false)
	assertProblem(t, err, http.StatusConflict, "CHANGE_CONFIRMATION_REQUIRED")

	persisted, found, err := env.module.service.getProposal(env.ctx, planned.ID)
	if err != nil || !found {
		t.Fatalf("读取失败提案出错: found=%v err=%v", found, err)
	}
	if persisted.Status != StatusFailed || persisted.ErrorCode != "CHANGE_CONFIRMATION_REQUIRED" || persisted.ErrorMessage == "" {
		t.Fatalf("失败未被真实记录: %+v", persisted)
	}
	if strings.Contains(strings.ToLower(persisted.ErrorMessage), "sqlite") {
		t.Fatalf("errorMessage 泄漏了 SQLite 细节: %q", persisted.ErrorMessage)
	}

	// 不伪造成功：目标字段仍未进入 Applied Model。
	collection, err := env.models.GetCollection(env.ctx, env.collection.ID)
	if err != nil {
		t.Fatalf("读取 Applied Model 失败: %v", err)
	}
	if _, exists := findField(collection.Fields, "is_public"); exists {
		t.Fatal("Apply 失败却把字段写进了 Applied Model（伪造成功）")
	}
}
