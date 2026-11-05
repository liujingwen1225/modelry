package visualrules

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
)

// Module 是可视化规则 Admin API 模块，由 Runtime 接线到共享路由器。
type Module struct {
	service *rulesService
}

// NewModule 在一个事务里建表并完成接线。
// models / records 允许为 nil；此时依赖它们的路径会返回明确的「服务未就绪」错误，
// 便于分阶段接线与独立单元测试。
func NewModule(store transactionalStore, models *backendmodel.Service, records *records.Service) (*Module, error) {
	service, err := newService(store)
	if err != nil {
		return nil, err
	}
	if models != nil {
		service.collections = models
	}
	if records != nil {
		service.creator = records
	}
	return &Module{service: service}, nil
}

func validationProblem(message string) error {
	return apiProblem{status: http.StatusUnprocessableEntity, code: "VALIDATION_FAILED", message: message}
}

func notFoundProblem(message string) error {
	return apiProblem{status: http.StatusNotFound, code: "NOT_FOUND", message: message}
}

func unavailableProblem(code, message string) error {
	return apiProblem{status: http.StatusServiceUnavailable, code: code, message: message}
}

func notRetryableProblem() error {
	return apiProblem{status: http.StatusConflict, code: "RUN_NOT_RETRYABLE", message: "只有失败的真实执行记录可以重试。"}
}

// mapStoreError 把存储哨兵错误翻译成对外的结构化错误；其余内部错误交由 HTTP 层
// 统一收敛为 INTERNAL_ERROR，绝不把 SQLite 细节返回给客户端。
func mapStoreError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, errRuleNotFound), errors.Is(err, errRunNotFound):
		return notFoundProblem("请求的可视化规则或执行记录不存在。")
	case errors.Is(err, errRuleNameConflict):
		return apiProblem{status: http.StatusConflict, code: "CONFLICT", message: "同名可视化规则已存在。"}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return unavailableProblem("SERVICE_UNAVAILABLE", "存储暂时不可用，请重试。")
	default:
		return err
	}
}

// validateRuleInput 执行 POST/PUT 的全部校验，包括集合真实存在与 values 键合法性。
func (service *rulesService) validateRuleInput(ctx context.Context, input ruleInput) error {
	if strings.TrimSpace(input.Name) == "" {
		return validationProblem("规则名称不能为空。")
	}
	if len([]rune(input.Name)) > maxNameRunes {
		return validationProblem(fmt.Sprintf("规则名称不能超过 %d 个字符。", maxNameRunes))
	}
	for _, character := range input.Name {
		if character < 0x20 || character == 0x7f {
			return validationProblem("规则名称不能包含控制字符。")
		}
	}
	if strings.TrimSpace(input.TriggerCollectionID) == "" || strings.TrimSpace(input.TargetCollectionID) == "" {
		return validationProblem("触发集合与目标集合都必须指定。")
	}
	if !validTriggerEvent(input.TriggerEvent) {
		return validationProblem("触发事件必须是 record.created、record.updated 或 record.deleted。")
	}
	if input.Values == nil {
		return validationProblem("values 必须是 JSON 对象。")
	}
	_, _, timeoutMs := inputSettings(input)
	if timeoutMs < 1 || timeoutMs > maxTimeoutMs {
		return validationProblem(fmt.Sprintf("timeoutMs 必须在 1 到 %d 之间。", maxTimeoutMs))
	}
	if service.collections == nil {
		return unavailableProblem("MODELS_UNAVAILABLE", "Backend Model 服务未就绪，无法校验集合。")
	}
	if _, err := service.collections.GetCollection(ctx, input.TriggerCollectionID); err != nil {
		return validationProblem("触发集合不存在或当前不可读。")
	}
	target, err := service.collections.GetCollection(ctx, input.TargetCollectionID)
	if err != nil {
		return validationProblem("目标集合不存在或当前不可读。")
	}
	writable := make(map[string]bool, len(target.Fields))
	for _, field := range target.Fields {
		writable[field.Name] = !field.System
	}
	for key := range input.Values {
		ok, exists := writable[key]
		if !exists {
			return validationProblem(fmt.Sprintf("values 中的字段 %q 不是目标集合里的字段。", key))
		}
		if !ok {
			return validationProblem(fmt.Sprintf("values 中的字段 %q 是系统字段，不能由可视化规则写入。", key))
		}
	}
	return nil
}

func (service *rulesService) createRule(ctx context.Context, input ruleInput) (rule, error) {
	if err := service.validateRuleInput(ctx, input); err != nil {
		return rule{}, err
	}
	id, err := newOpaqueID(ruleIDPrefix)
	if err != nil {
		return rule{}, err
	}
	enabled, retryEnabled, timeoutMs := inputSettings(input)
	now := nowText()
	item := rule{
		ID: id, Name: input.Name,
		TriggerCollectionID: input.TriggerCollectionID, TriggerEvent: input.TriggerEvent,
		TargetCollectionID: input.TargetCollectionID, Values: input.Values,
		Enabled: enabled, RetryEnabled: retryEnabled, TimeoutMs: timeoutMs,
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	if err := service.insertRule(ctx, item); err != nil {
		return rule{}, mapStoreError(err)
	}
	return item, nil
}

func (service *rulesService) getRule(ctx context.Context, id string) (rule, error) {
	item, err := service.loadRule(ctx, id)
	if err != nil {
		return rule{}, mapStoreError(err)
	}
	return item, nil
}

func (service *rulesService) listRules(ctx context.Context) ([]rule, error) {
	items, err := service.listRuleRows(ctx)
	if err != nil {
		return nil, mapStoreError(err)
	}
	return items, nil
}

func (service *rulesService) replaceRule(ctx context.Context, id string, input ruleInput) (rule, error) {
	existing, err := service.loadRule(ctx, id)
	if err != nil {
		return rule{}, mapStoreError(err)
	}
	if err := service.validateRuleInput(ctx, input); err != nil {
		return rule{}, err
	}
	enabled, retryEnabled, timeoutMs := inputSettings(input)
	item := rule{
		ID: existing.ID, Name: input.Name,
		TriggerCollectionID: input.TriggerCollectionID, TriggerEvent: input.TriggerEvent,
		TargetCollectionID: input.TargetCollectionID, Values: input.Values,
		Enabled: enabled, RetryEnabled: retryEnabled, TimeoutMs: timeoutMs,
		Revision:  existing.Revision + 1,
		CreatedAt: existing.CreatedAt, UpdatedAt: nowText(),
	}
	if err := service.updateRule(ctx, item); err != nil {
		return rule{}, mapStoreError(err)
	}
	return item, nil
}

func (service *rulesService) setEnabled(ctx context.Context, id string, enabled bool) (rule, error) {
	item, err := service.setRuleEnabled(ctx, id, enabled)
	if err != nil {
		return rule{}, mapStoreError(err)
	}
	return item, nil
}

func collectionCheckDetail(label string, err error) string {
	if err == nil {
		return label + "存在且可读。"
	}
	if errors.Is(err, backendmodel.ErrNotFound) {
		return label + "不存在。"
	}
	return label + "当前不可读。"
}

func testFailureSummary(checks []check) string {
	parts := make([]string, 0, len(checks))
	for _, item := range checks {
		if !item.Passed {
			parts = append(parts, item.Label+"："+item.Detail)
		}
	}
	return strings.Join(parts, "；")
}

// testRule 是 dry-run：只做检查与渲染，绝不写 Record、绝不写用户，但把 test run 持久化。
func (service *rulesService) testRule(ctx context.Context, id string, payload userPayload) (testResult, error) {
	item, err := service.getRule(ctx, id)
	if err != nil {
		return testResult{}, err
	}
	if service.collections == nil {
		return testResult{}, unavailableProblem("MODELS_UNAVAILABLE", "Backend Model 服务未就绪，无法执行 dry-run 检查。")
	}
	checks := make([]check, 0, 5)

	_, triggerErr := service.collections.GetCollection(ctx, item.TriggerCollectionID)
	checks = append(checks, check{Label: "触发集合存在", Passed: triggerErr == nil, Detail: collectionCheckDetail("触发集合", triggerErr)})

	eventOK := validTriggerEvent(item.TriggerEvent)
	eventDetail := "触发事件合法。"
	if !eventOK {
		eventDetail = "触发事件 " + item.TriggerEvent + " 不在允许范围内。"
	}
	checks = append(checks, check{Label: "触发事件合法", Passed: eventOK, Detail: eventDetail})

	target, targetErr := service.collections.GetCollection(ctx, item.TargetCollectionID)
	checks = append(checks, check{Label: "目标集合存在", Passed: targetErr == nil, Detail: collectionCheckDetail("目标集合", targetErr)})

	values, problems := renderTemplates(item.Values, payload)

	coverageOK := true
	coverageDetail := "渲染后的值已覆盖目标集合所有必填非系统字段。"
	if targetErr != nil {
		coverageOK = false
		coverageDetail = "目标集合不可读，无法判断必填字段覆盖。"
	} else {
		missing := make([]string, 0)
		for _, field := range target.Fields {
			if field.System || !field.Required {
				continue
			}
			if _, supplied := values[field.Name]; !supplied {
				missing = append(missing, field.Name)
			}
		}
		if len(missing) > 0 {
			coverageOK = false
			coverageDetail = "缺少必填字段的字段模板：" + strings.Join(missing, "、")
		}
	}
	checks = append(checks, check{Label: "必填字段覆盖", Passed: coverageOK, Detail: coverageDetail})

	placeholderOK := len(problems) == 0
	placeholderDetail := "全部占位符已解析。"
	if !placeholderOK {
		placeholderDetail = strings.Join(problems, "；")
	}
	checks = append(checks, check{Label: "占位符解析", Passed: placeholderOK, Detail: placeholderDetail})

	passed := allChecksPassed(checks)
	runID, err := newOpaqueID(runIDPrefix)
	if err != nil {
		return testResult{}, err
	}
	now := nowText()
	record := run{
		ID: runID, RuleID: item.ID, Kind: kindTest, Status: statusSucceeded,
		Payload: payload, Values: values, CreatedAt: now, FinishedAt: now,
	}
	if !passed {
		record.Status = statusFailed
		record.ErrorCode = "TEST_FAILED"
		record.ErrorMessage = testFailureSummary(checks)
	}
	if err := service.insertRun(ctx, record); err != nil {
		return testResult{}, mapStoreError(err)
	}
	return testResult{Passed: passed, Checks: checks, Values: values, RunID: runID}, nil
}

func leaksStorageDetail(message string) bool {
	lower := strings.ToLower(message)
	for _, token := range []string{"sqlite", "constraint", "no such", "unique", "busy", "locked", "syntax", "database", "sql"} {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}

func sanitizeErrorMessage(prefix string, err error) string {
	message := err.Error()
	if leaksStorageDetail(message) {
		return prefix + "，请检查目标集合模型与字段类型。"
	}
	if len(message) > 300 {
		message = message[:300]
	}
	return prefix + "：" + message
}

// classifyCreateError 把真实写入失败翻译成大写下划线错误码与安全的中文原因，
// 既不吞掉失败类别，也不泄漏 SQLite 细节。
func classifyCreateError(err error) (string, string) {
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "EXECUTION_TIMEOUT", "真实执行超过规则配置的超时时间。"
	case errors.Is(err, records.ErrNotFound), errors.Is(err, backendmodel.ErrNotFound):
		return "TARGET_COLLECTION_NOT_FOUND", "目标集合不存在或已被删除。"
	case errors.Is(err, records.ErrAuthCollectionWriteRequiresAuthAPI):
		return "AUTH_COLLECTION_WRITE_REJECTED", "Auth 集合不能通过可视化规则写入。"
	case errors.Is(err, records.ErrInvalidArgument), errors.Is(err, backendmodel.ErrInvalidArgument):
		return "RECORD_VALUES_INVALID", "渲染后的字段值不符合目标集合模型。"
	default:
		var valueError *backendmodel.RecordValueError
		if errors.As(err, &valueError) {
			return "RECORD_VALUES_INVALID", fmt.Sprintf("字段 %q 的渲染值不符合目标集合模型。", valueError.Field)
		}
		return "RECORD_CREATE_FAILED", sanitizeErrorMessage("创建真实记录失败", err)
	}
}

// executeLive 渲染模板并调用 Records 服务写入一条真实 Record，随后持久化执行记录。
// 执行失败也返回 202 对应的 failed Run（不吞错），只有服务未就绪才返回错误。
func (service *rulesService) executeLive(ctx context.Context, item rule, payload userPayload, attemptOf string) (run, error) {
	values, problems := renderTemplates(item.Values, payload)
	runID, err := newOpaqueID(runIDPrefix)
	if err != nil {
		return run{}, err
	}
	record := run{
		ID: runID, RuleID: item.ID, Kind: kindLive, Status: statusFailed,
		Payload: payload, Values: values, AttemptOf: attemptOf, CreatedAt: nowText(),
	}
	finish := func() (run, error) {
		record.FinishedAt = nowText()
		if err := service.insertRun(ctx, record); err != nil {
			return run{}, mapStoreError(err)
		}
		return record, nil
	}
	if len(problems) > 0 {
		record.ErrorCode = "TEMPLATE_RENDER_FAILED"
		record.ErrorMessage = strings.Join(problems, "；")
		return finish()
	}
	if service.creator == nil {
		return run{}, unavailableProblem("RECORDS_UNAVAILABLE", "Records 服务未就绪，无法执行真实写入。")
	}
	execCtx, cancel := context.WithTimeout(ctx, time.Duration(item.TimeoutMs)*time.Millisecond)
	defer cancel()
	created, createErr := service.creator.Create(execCtx, item.TargetCollectionID, toStringAnyMap(values))
	if createErr != nil {
		record.ErrorCode, record.ErrorMessage = classifyCreateError(createErr)
		return finish()
	}
	record.Status = statusSucceeded
	record.RecordID = created.ID
	return finish()
}

func (service *rulesService) runRule(ctx context.Context, id string, payload userPayload) (run, error) {
	item, err := service.getRule(ctx, id)
	if err != nil {
		return run{}, err
	}
	return service.executeLive(ctx, item, payload, "")
}

func (service *rulesService) listRuns(ctx context.Context, ruleID string) ([]run, error) {
	items, err := service.listRunRows(ctx, ruleID)
	if err != nil {
		return nil, mapStoreError(err)
	}
	return items, nil
}

// retryRun 只允许重试失败的 live run：用原 payload 重新真实执行一次，并关联原记录。
func (service *rulesService) retryRun(ctx context.Context, runID string) (run, error) {
	original, err := service.loadRun(ctx, runID)
	if err != nil {
		return run{}, mapStoreError(err)
	}
	if original.Kind != kindLive || original.Status != statusFailed {
		return run{}, notRetryableProblem()
	}
	item, err := service.getRule(ctx, original.RuleID)
	if err != nil {
		return run{}, err
	}
	return service.executeLive(ctx, item, original.Payload, original.ID)
}
