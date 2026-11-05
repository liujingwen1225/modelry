// Package visualrules 提供 Issue #46「可视化业务逻辑」的最小闭环：
// 编辑保存可视化规则、dry-run 测试、真实执行写入一条 Record、持久化执行记录并支持重试。
// 本包刻意不复用 automation 的代码型 Hook，也不提供 JS 编辑器，只处理
// 「触发事件 → 创建一条记录的字段模板」这一种可视化规则。
package visualrules

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// 表名与列名全部以常量书写，SQL 中绝不拼接任何用户输入。
const (
	tableRules = "modelry_visual_rules"
	tableRuns  = "modelry_visual_rule_runs"

	kindTest = "test"
	kindLive = "live"

	statusSucceeded = "succeeded"
	statusFailed    = "failed"

	ruleIDPrefix = "vlr_"
	runIDPrefix  = "vrr_"

	defaultTimeoutMs = 3000
	maxTimeoutMs     = 60000
	maxNameRunes     = 128
)

// triggerEvent 仅允许记录生命周期的三种事件。
var allowedTriggerEvents = map[string]bool{
	"record.created": true,
	"record.updated": true,
	"record.deleted": true,
}

// 占位符语法为 {{path}}。目前载荷只携带 user 身份，因此仅解析这三个路径；
// 其它任何占位符都会被判定为「无法解析」，并给出真实原因。
var placeholderPattern = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

var placeholderResolvers = map[string]func(testUser) string{
	"user.id":          func(u testUser) string { return u.ID },
	"user.email":       func(u testUser) string { return u.Email },
	"user.displayName": func(u testUser) string { return u.DisplayName },
}

// rule 是一条可视化规则，同时也是 API 的 data 响应体。
type rule struct {
	ID                  string            `json:"id"`
	Name                string            `json:"name"`
	TriggerCollectionID string            `json:"triggerCollectionId"`
	TriggerEvent        string            `json:"triggerEvent"`
	TargetCollectionID  string            `json:"targetCollectionId"`
	Values              map[string]string `json:"values"`
	Enabled             bool              `json:"enabled"`
	RetryEnabled        bool              `json:"retryEnabled"`
	TimeoutMs           int               `json:"timeoutMs"`
	Revision            int               `json:"revision"`
	CreatedAt           string            `json:"createdAt"`
	UpdatedAt           string            `json:"updatedAt"`
}

// run 是一次 test 或 live 执行的持久化记录，同时也是 API 的 data 响应体。
type run struct {
	ID           string            `json:"id"`
	RuleID       string            `json:"ruleId"`
	Kind         string            `json:"kind"`
	Status       string            `json:"status"`
	Payload      userPayload       `json:"payload"`
	Values       map[string]string `json:"values"`
	RecordID     string            `json:"recordId"`
	ErrorCode    string            `json:"errorCode"`
	ErrorMessage string            `json:"errorMessage"`
	AttemptOf    string            `json:"attemptOf"`
	CreatedAt    string            `json:"createdAt"`
	FinishedAt   string            `json:"finishedAt"`
}

// check 是 dry-run 中的一条检查结论，detail 给出真实原因。
type check struct {
	Label  string `json:"label"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail"`
}

// testResult 是 dry-run 的响应体；它只描述渲染结果，绝不写入任何 Record 或用户。
type testResult struct {
	Passed bool              `json:"passed"`
	Checks []check           `json:"checks"`
	Values map[string]string `json:"values"`
	RunID  string            `json:"runId"`
}

// ruleInput 是 POST/PUT 的请求体；可选字段用指针区分「未提供」与「显式 false」。
type ruleInput struct {
	Name                string            `json:"name"`
	TriggerCollectionID string            `json:"triggerCollectionId"`
	TriggerEvent        string            `json:"triggerEvent"`
	TargetCollectionID  string            `json:"targetCollectionId"`
	Values              map[string]string `json:"values"`
	Enabled             *bool             `json:"enabled"`
	RetryEnabled        *bool             `json:"retryEnabled"`
	TimeoutMs           *int              `json:"timeoutMs"`
}

// userPayload 是 test/run 的载荷，也是 run.payload 持久化的形状，允许整体缺省。
type userPayload struct {
	User testUser `json:"user"`
}

type testUser struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
}

// dataEnvelope 统一 { "data": ... } 成功响应包装。
type dataEnvelope[T any] struct {
	Data T `json:"data"`
}

// newOpaqueID 生成仓库风格的不透明 ID：前缀 + 16 字节随机数的 hex。
func newOpaqueID(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("生成 %s 标识失败: %w", prefix, err)
	}
	return prefix + hex.EncodeToString(value[:]), nil
}

func nowText() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func intToBool(value int) bool {
	return value != 0
}

func validTriggerEvent(event string) bool {
	return allowedTriggerEvents[event]
}

// inputSettings 解析可选字段的缺省值。
func inputSettings(input ruleInput) (enabled, retryEnabled bool, timeoutMs int) {
	enabled, retryEnabled, timeoutMs = true, false, defaultTimeoutMs
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	if input.RetryEnabled != nil {
		retryEnabled = *input.RetryEnabled
	}
	if input.TimeoutMs != nil {
		timeoutMs = *input.TimeoutMs
	}
	return enabled, retryEnabled, timeoutMs
}

func encodeStringMap(values map[string]string) (string, error) {
	if values == nil {
		values = map[string]string{}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", fmt.Errorf("编码字段模板: %w", err)
	}
	return string(encoded), nil
}

func decodeStringMap(raw string) (map[string]string, error) {
	values := map[string]string{}
	if strings.TrimSpace(raw) == "" || strings.TrimSpace(raw) == "null" {
		return values, nil
	}
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, fmt.Errorf("解码字段模板: %w", err)
	}
	if values == nil {
		values = map[string]string{}
	}
	return values, nil
}

func encodePayload(payload userPayload) (string, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("编码执行载荷: %w", err)
	}
	return string(encoded), nil
}

func decodePayload(raw string) (userPayload, error) {
	var payload userPayload
	if strings.TrimSpace(raw) == "" {
		return payload, nil
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return payload, fmt.Errorf("解码执行载荷: %w", err)
	}
	return payload, nil
}

func toStringAnyMap(values map[string]string) map[string]any {
	result := make(map[string]any, len(values))
	for name, value := range values {
		result[name] = value
	}
	return result
}

func allChecksPassed(checks []check) bool {
	for _, item := range checks {
		if !item.Passed {
			return false
		}
	}
	return true
}

// renderTemplates 把字段模板中的 {{path}} 用载荷替换。
// 未知占位符或未提供的值都保留原文并记入 problems，作为 test 的真实失败原因。
func renderTemplates(templates map[string]string, payload userPayload) (map[string]string, []string) {
	values := make(map[string]string, len(templates))
	problems := make([]string, 0)
	seen := map[string]bool{}
	addProblem := func(text string) {
		if !seen[text] {
			seen[text] = true
			problems = append(problems, text)
		}
	}
	for field, template := range templates {
		rendered := placeholderPattern.ReplaceAllStringFunc(template, func(match string) string {
			key := strings.TrimSpace(match[2 : len(match)-2])
			resolve, known := placeholderResolvers[key]
			if !known {
				addProblem(fmt.Sprintf("字段 %q 使用了不支持的占位符 %s", field, match))
				return match
			}
			value := resolve(payload.User)
			if value == "" {
				addProblem(fmt.Sprintf("字段 %q 的占位符 %s 在载荷中未提供", field, match))
				return match
			}
			return value
		})
		values[field] = rendered
	}
	return values, problems
}
