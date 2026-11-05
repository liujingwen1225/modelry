// Package aicollab 实现 Issue #48「AI 协作」的最小真实后端能力。
//
// 产品语义是「需求 → 理解 → 变更方案/差异/风险 → 审阅授权 → 应用 → 验证 → 公开分享」。
// 本包不调用任何 LLM / Agent SDK / 外部模型：「需求理解」只做对真实项目状态的
// 规则化结构化分析；所有「差异 / 风险 / 影响」都来自 Backend Model 既有的
// Pending Operation / Preview / Apply 变更生命周期，绝不凭空写库、绝不绕过生命周期。
package aicollab

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

// 提案状态机：draft → planned → applied → verified，任意一步失败进入 failed。
const (
	StatusDraft    = "draft"
	StatusPlanned  = "planned"
	StatusApplied  = "applied"
	StatusVerified = "verified"
	StatusFailed   = "failed"
)

const (
	// shareScope 固定为提案摘要，公开页永远只拿到这一范围内的投影。
	shareScope            = "proposal-summary"
	defaultFieldName      = "is_public"
	defaultExpiresInHours = 24
	minExpiresInHours     = 1
	maxExpiresInHours     = 168
	maxRequirementRunes   = 2000
	maxRequestBody        = 1 << 20
)

// 字段名规则是 Backend Model 字段名规则（^[A-Za-z][A-Za-z0-9_]{0,62}$）的
// 小写子集：必须以小写字母开头，后接小写字母 / 数字 / 下划线。这样既能满足
// 校验，又能保证 SaveOperation 里的 validateField 一定通过。
var fieldNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// Proposal 对应 modelry_ai_proposals 的一行。understandingJson 在 DB 中是 TEXT，
// 这里以 json.RawMessage 暴露为内嵌对象，便于前端直接读取真实事实。
type Proposal struct {
	ID                string          `json:"id"`
	Title             string          `json:"title"`
	Requirement       string          `json:"requirement"`
	CollectionID      string          `json:"collectionId"`
	UnderstandingJSON json.RawMessage `json:"understandingJson"`
	Status            string          `json:"status"`
	ChangeSetID       string          `json:"changeSetId"`
	FieldName         string          `json:"fieldName"`
	ErrorCode         string          `json:"errorCode"`
	ErrorMessage      string          `json:"errorMessage"`
	CreatedAt         string          `json:"createdAt"`
	UpdatedAt         string          `json:"updatedAt"`
}

// ProposalDetail 在 Proposal 全部字段之外，附带按当前真实状态计算的 plan 与 verification。
// changeSetId 为空或对应 Pending Change 已不存在时，plan 为 null。
type ProposalDetail struct {
	Proposal
	Plan         *Plan        `json:"plan"`
	Verification Verification `json:"verification"`
}

// Plan 来自真实 Pending Change（GetPendingChange / Preview）或已归档变更（GetChange）。
type Plan struct {
	ChangeSetID string                          `json:"changeSetId"`
	Version     int                             `json:"version"`
	Operations  []backendmodel.PendingOperation `json:"operations"`
	Preview     *PlanPreview                    `json:"preview"`
}

// PlanPreview 是 Backend Model SchemaPreview 的投影，字段均为真实评估值。
type PlanPreview struct {
	Risk          backendmodel.Risk           `json:"risk"`
	Diff          []backendmodel.DiffItem     `json:"diff"`
	Impact        backendmodel.Impact         `json:"impact"`
	Preconditions []backendmodel.Precondition `json:"preconditions"`
}

// Check 是一条真实验证结论，detail 只描述事实，不含凭据或内部路径。
type Check struct {
	Label  string `json:"label"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail"`
}

// Verification 汇总至少三类检查：目标字段是否已进入 Applied Model、
// 是否仍存在待应用变更、提案状态。
type Verification struct {
	Passed bool    `json:"passed"`
	Checks []Check `json:"checks"`
}

// Understanding 是「规则化理解」的结构化结果：全部字段来自真实项目状态。
type Understanding struct {
	Kind              string                  `json:"kind"`
	Note              string                  `json:"note"`
	Requirement       string                  `json:"requirement"`
	Collection        UnderstandingCollection `json:"collection"`
	Fields            []UnderstandingField    `json:"fields"`
	TargetFieldName   string                  `json:"targetFieldName"`
	TargetFieldExists bool                    `json:"targetFieldExists"`
}

// UnderstandingCollection 记录集合的真实身份与 schemaVersion。
type UnderstandingCollection struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	SchemaVersion int    `json:"schemaVersion"`
}

// UnderstandingField 记录当前 Applied Model 中每个字段的真实 (id/name/type/required)。
type UnderstandingField struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

// shareRecord 是 modelry_ai_share_links 的一行，含明文 token，仅内部使用。
type shareRecord struct {
	ID         string
	Token      string
	ProposalID string
	CreatedAt  string
	ExpiresAt  string
	RevokedAt  string
	Scope      string
}

// ShareCreated 是创建分享的响应，token 仅在创建时返回一次。
type ShareCreated struct {
	ID        string `json:"id"`
	Token     string `json:"token"`
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
	RevokedAt string `json:"revokedAt"`
}

// ShareLink 是分享列表项：刻意不含明文 token 与含 token 的 url，避免暴露敏感数据。
type ShareLink struct {
	ID         string `json:"id"`
	ProposalID string `json:"proposalId"`
	CreatedAt  string `json:"createdAt"`
	ExpiresAt  string `json:"expiresAt"`
	RevokedAt  string `json:"revokedAt"`
	Scope      string `json:"scope"`
}

// PublicSharePlan 是公开页看到的方案摘要，全部来自真实 DB 查询。
type PublicSharePlan struct {
	Risk          string `json:"risk"`
	ImpactSummary string `json:"impactSummary"`
	DiffCount     int    `json:"diffCount"`
}

// PublicShareView 是公开只读端点返回的裸对象（不带 {data:...} 包裹）。
// 它只包含提案摘要，绝不返回 Secret、凭据、会话、记录内容、内部表信息或绝对路径。
type PublicShareView struct {
	ProposalID     string          `json:"proposalId"`
	Title          string          `json:"title"`
	Requirement    string          `json:"requirement"`
	Status         string          `json:"status"`
	CollectionName string          `json:"collectionName"`
	FieldName      string          `json:"fieldName"`
	Plan           PublicSharePlan `json:"plan"`
	Verification   Verification    `json:"verification"`
	ExpiresAt      string          `json:"expiresAt"`
}

// nowUTC 统一使用 UTC RFC3339Nano 文本，避免不同格式导致的比较歧义。
func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// newID 生成带前缀的不透明 ID（crypto/rand，16 字节 hex）。
func newID(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(value[:]), nil
}

// newToken 生成 URL 安全的随机串（crypto/rand，32 字节 → 43 字符，≥32）。
func newToken() (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value[:]), nil
}

// validFieldName 判断是否为合法且能被 Backend Model 接受的字段名。
func validFieldName(name string) bool {
	return fieldNamePattern.MatchString(name)
}
