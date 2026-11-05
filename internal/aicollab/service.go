package aicollab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

// backendModelAPI 是 aicollab 对 Backend Model 变更生命周期的依赖。
// *backendmodel.Service 已导出这些方法且签名完全一致；定义为接口后，
// 单元测试可注入 fake 而不必依赖真实服务的复杂状态。
type backendModelAPI interface {
	GetCollection(context.Context, string) (backendmodel.Collection, error)
	GetPendingChange(context.Context, string) (backendmodel.PendingChange, bool, error)
	SaveOperation(context.Context, string, backendmodel.PendingOperationInput) (backendmodel.PendingChange, error)
	Preview(context.Context, string, int) (backendmodel.SchemaPreview, error)
	Apply(context.Context, string, int, bool) (backendmodel.ApplyResult, error)
	GetChange(context.Context, string) (backendmodel.ChangeDetail, error)
}

var _ backendModelAPI = (*backendmodel.Service)(nil)

// problem 是 aicollab 的领域错误，携带对外安全的 HTTP 状态与错误码。
// message 恒为预先写好的安全文本，绝不拼接底层 SQLite 错误。
type problem struct {
	status  int
	code    string
	message string
}

func (p *problem) Error() string { return p.message }

func newProblem(status int, code, message string) error {
	return &problem{status: status, code: code, message: message}
}

// createProposalInput 是创建提案的请求体（字段名与 HTTP 契约一致）。
type createProposalInput struct {
	Requirement  string `json:"requirement"`
	CollectionID string `json:"collectionId"`
	FieldName    string `json:"fieldName,omitempty"`
}

// Service 实现 AI 协作的全部业务逻辑；所有事实均来自真实项目状态。
type Service struct {
	repo   *repository
	models backendModelAPI
}

func (s *Service) listProposals(ctx context.Context) ([]Proposal, error) {
	return s.repo.listProposals(ctx)
}

func (s *Service) getProposal(ctx context.Context, id string) (Proposal, bool, error) {
	return s.repo.getProposal(ctx, id)
}

// createProposal 只写 aicollab 自己的提案表：对真实集合做结构化「规则化理解」，
// 状态 draft，不写任何业务数据、不创建 Pending Change、不改物理表结构。
func (s *Service) createProposal(ctx context.Context, input createProposalInput) (Proposal, error) {
	if strings.TrimSpace(input.Requirement) == "" || len([]rune(input.Requirement)) > maxRequirementRunes {
		return Proposal{}, newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "requirement 必须非空且不超过 2000 个字符。")
	}
	fieldName := input.FieldName
	if fieldName == "" {
		fieldName = defaultFieldName
	}
	if !validFieldName(fieldName) {
		return Proposal{}, newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "fieldName 必须是小写字母开头、仅含小写字母/数字/下划线的合法字段名。")
	}

	// collectionId 必须真实存在：直接读取 Applied Model，任何不存在/非法都视为参数错误。
	collection, err := s.models.GetCollection(ctx, input.CollectionID)
	if err != nil {
		if errors.Is(err, backendmodel.ErrNotFound) || errors.Is(err, backendmodel.ErrInvalidArgument) {
			return Proposal{}, newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "collectionId 指向的集合不存在或无效。")
		}
		return Proposal{}, err
	}

	understanding := buildUnderstanding(collection, input.Requirement, fieldName)
	encodedUnderstanding, err := json.Marshal(understanding)
	if err != nil {
		return Proposal{}, err
	}
	id, err := newID("aip_")
	if err != nil {
		return Proposal{}, err
	}
	now := nowUTC()
	p := Proposal{
		ID:                id,
		Title:             proposalTitle(collection.Name, fieldName),
		Requirement:       input.Requirement,
		CollectionID:      input.CollectionID,
		UnderstandingJSON: encodedUnderstanding,
		Status:            StatusDraft,
		ChangeSetID:       "",
		FieldName:         fieldName,
		ErrorCode:         "",
		ErrorMessage:      "",
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := s.repo.insertProposal(ctx, p); err != nil {
		return Proposal{}, err
	}
	return p, nil
}

// plan 走真实变更生命周期：通过 SaveOperation 保存一条 pending schema 变更，
// 把返回的 ChangeSetID 记入提案，状态 planned。绝不直接改 SQLite 表结构。
func (s *Service) plan(ctx context.Context, id string) (Proposal, error) {
	p, found, err := s.repo.getProposal(ctx, id)
	if err != nil {
		return Proposal{}, err
	}
	if !found {
		return Proposal{}, newProblem(http.StatusNotFound, "PROPOSAL_NOT_FOUND", "提案不存在。")
	}
	if p.Status != StatusDraft {
		return Proposal{}, newProblem(http.StatusConflict, "PROPOSAL_STATE", "只有 draft 状态的提案才能生成变更方案。")
	}

	// 真实检查：目标字段是否已存在于 Applied Model。存在则不再添加并返回 409。
	collection, err := s.models.GetCollection(ctx, p.CollectionID)
	if err != nil {
		return Proposal{}, err
	}
	if _, exists := findField(collection.Fields, p.FieldName); exists {
		return Proposal{}, newProblem(http.StatusConflict, "FIELD_ALREADY_EXISTS", "目标字段已存在于 Applied Model，无需再生成变更。")
	}

	definition := json.RawMessage(fmt.Sprintf(`{"name":%q,"type":"boolean","required":false}`, p.FieldName))
	change, err := s.models.SaveOperation(ctx, p.CollectionID, backendmodel.PendingOperationInput{
		Kind:       backendmodel.OperationField,
		Action:     backendmodel.OperationAdd,
		Definition: definition,
	})
	if err != nil {
		return Proposal{}, err
	}

	p.ChangeSetID = change.ChangeSetID
	p.Status = StatusPlanned
	p.ErrorCode = ""
	p.ErrorMessage = ""
	p.UpdatedAt = nowUTC()
	if err := s.repo.updateProposal(ctx, p); err != nil {
		return Proposal{}, err
	}
	return p, nil
}

// apply 走真实 models.Apply：expectedVersion 取自当前真实 Pending Change 的 version，
// confirmRisk 原样透传。成功后状态 applied；任何失败都把真实 errorCode/errorMessage
// 与状态 failed 落库，并返回结构化错误，绝不伪造成功。
func (s *Service) apply(ctx context.Context, id string, confirmRisk bool) (Proposal, error) {
	p, found, err := s.repo.getProposal(ctx, id)
	if err != nil {
		return Proposal{}, err
	}
	if !found {
		return Proposal{}, newProblem(http.StatusNotFound, "PROPOSAL_NOT_FOUND", "提案不存在。")
	}
	if p.ChangeSetID == "" {
		return Proposal{}, newProblem(http.StatusConflict, "PROPOSAL_STATE", "提案尚未生成变更方案，无法应用。")
	}
	if p.Status == StatusApplied || p.Status == StatusVerified {
		return Proposal{}, newProblem(http.StatusConflict, "PROPOSAL_STATE", "变更已应用，无需重复应用。")
	}

	pending, exists, err := s.models.GetPendingChange(ctx, p.CollectionID)
	if err != nil {
		return Proposal{}, err
	}
	if !exists {
		return Proposal{}, newProblem(http.StatusConflict, "PROPOSAL_STATE", "当前没有待应用的 Pending Change，无法应用。")
	}

	_, err = s.models.Apply(ctx, p.CollectionID, pending.Version, confirmRisk)
	if err != nil {
		code, message, status := classifyApplyError(err)
		p.Status = StatusFailed
		p.ErrorCode = code
		p.ErrorMessage = message
		p.UpdatedAt = nowUTC()
		if updateErr := s.repo.updateProposal(ctx, p); updateErr != nil {
			return Proposal{}, updateErr
		}
		return p, newProblem(status, code, message)
	}

	p.Status = StatusApplied
	p.ErrorCode = ""
	p.ErrorMessage = ""
	p.UpdatedAt = nowUTC()
	if err := s.repo.updateProposal(ctx, p); err != nil {
		return Proposal{}, err
	}
	return p, nil
}

// verify 读取真实 Applied Model 验证目标字段，并据此把状态写回 verified 或保持 applied。
func (s *Service) verify(ctx context.Context, id string) (ProposalDetail, error) {
	p, found, err := s.repo.getProposal(ctx, id)
	if err != nil {
		return ProposalDetail{}, err
	}
	if !found {
		return ProposalDetail{}, newProblem(http.StatusNotFound, "PROPOSAL_NOT_FOUND", "提案不存在。")
	}
	if p.Status != StatusApplied && p.Status != StatusVerified {
		return ProposalDetail{}, newProblem(http.StatusConflict, "PROPOSAL_STATE", "只有已应用（applied/verified）的提案才能验证。")
	}

	verification, err := s.computeVerification(ctx, p)
	if err != nil {
		return ProposalDetail{}, err
	}
	if verification.Passed && p.Status != StatusVerified {
		p.Status = StatusVerified
		p.UpdatedAt = nowUTC()
		if err := s.repo.updateProposal(ctx, p); err != nil {
			return ProposalDetail{}, err
		}
	} else if !verification.Passed && p.Status == StatusVerified {
		// 真实回退：再次验证不通过时退回 applied，并在 checks 里给出真实失败原因。
		p.Status = StatusApplied
		p.UpdatedAt = nowUTC()
		if err := s.repo.updateProposal(ctx, p); err != nil {
			return ProposalDetail{}, err
		}
	}

	plan, err := s.buildPlan(ctx, p)
	if err != nil {
		return ProposalDetail{}, err
	}
	return ProposalDetail{Proposal: p, Plan: plan, Verification: verification}, nil
}

// detail 按当前真实状态聚合 Proposal + plan + verification，不修改状态。
func (s *Service) detail(ctx context.Context, id string) (ProposalDetail, error) {
	p, found, err := s.repo.getProposal(ctx, id)
	if err != nil {
		return ProposalDetail{}, err
	}
	if !found {
		return ProposalDetail{}, newProblem(http.StatusNotFound, "PROPOSAL_NOT_FOUND", "提案不存在。")
	}
	plan, err := s.buildPlan(ctx, p)
	if err != nil {
		return ProposalDetail{}, err
	}
	verification, err := s.computeVerification(ctx, p)
	if err != nil {
		return ProposalDetail{}, err
	}
	return ProposalDetail{Proposal: p, Plan: plan, Verification: verification}, nil
}

// createShare 生成不透明 token 的分享链接；expiresInHours 为空时默认 24，范围 1..168。
func (s *Service) createShare(ctx context.Context, proposalID string, expiresInHours *int) (ShareCreated, error) {
	if _, found, err := s.repo.getProposal(ctx, proposalID); err != nil {
		return ShareCreated{}, err
	} else if !found {
		return ShareCreated{}, newProblem(http.StatusNotFound, "PROPOSAL_NOT_FOUND", "提案不存在。")
	}
	hours := defaultExpiresInHours
	if expiresInHours != nil {
		hours = *expiresInHours
	}
	if hours < minExpiresInHours || hours > maxExpiresInHours {
		return ShareCreated{}, newProblem(http.StatusBadRequest, "INVALID_ARGUMENT", "expiresInHours 必须在 1 到 168 之间。")
	}
	id, err := newID("ais_")
	if err != nil {
		return ShareCreated{}, err
	}
	token, err := newToken()
	if err != nil {
		return ShareCreated{}, err
	}
	now := time.Now().UTC()
	item := shareRecord{
		ID:         id,
		Token:      token,
		ProposalID: proposalID,
		CreatedAt:  now.Format(time.RFC3339Nano),
		ExpiresAt:  now.Add(time.Duration(hours) * time.Hour).Format(time.RFC3339Nano),
		RevokedAt:  "",
		Scope:      shareScope,
	}
	if err := s.repo.insertShare(ctx, item); err != nil {
		return ShareCreated{}, err
	}
	return ShareCreated{
		ID:        item.ID,
		Token:     item.Token,
		URL:       "/ai/share/" + item.Token,
		ExpiresAt: item.ExpiresAt,
		RevokedAt: item.RevokedAt,
	}, nil
}

// listShares 返回不含明文 token / url 的分享元数据。
func (s *Service) listShares(ctx context.Context, proposalID string) ([]ShareLink, error) {
	if _, found, err := s.repo.getProposal(ctx, proposalID); err != nil {
		return nil, err
	} else if !found {
		return nil, newProblem(http.StatusNotFound, "PROPOSAL_NOT_FOUND", "提案不存在。")
	}
	records, err := s.repo.listShares(ctx, proposalID)
	if err != nil {
		return nil, err
	}
	items := make([]ShareLink, 0, len(records))
	for _, record := range records {
		items = append(items, ShareLink{
			ID:         record.ID,
			ProposalID: record.ProposalID,
			CreatedAt:  record.CreatedAt,
			ExpiresAt:  record.ExpiresAt,
			RevokedAt:  record.RevokedAt,
			Scope:      record.Scope,
		})
	}
	return items, nil
}

// revokeShare 写入 revoked_at，已撤销或重复调用均返回成功（幂等）。
func (s *Service) revokeShare(ctx context.Context, id string) error {
	_, found, err := s.repo.getShareByID(ctx, id)
	if err != nil {
		return err
	}
	if !found {
		return newProblem(http.StatusNotFound, "SHARE_NOT_FOUND", "分享链接不存在。")
	}
	return s.repo.revokeShare(ctx, id, nowUTC())
}

// publicShare 校验 token 存在、未 revoke、未过期；任一不满足都返回完全相同的
// 404 SHARE_NOT_FOUND，不泄漏原因差异。只返回提案摘要，plan/verification 均来自真实 DB。
func (s *Service) publicShare(ctx context.Context, token string) (PublicShareView, error) {
	notFound := func() (PublicShareView, error) {
		return PublicShareView{}, newProblem(http.StatusNotFound, "SHARE_NOT_FOUND", "分享链接不存在或不可用。")
	}
	share, found, err := s.repo.getShareByToken(ctx, token)
	if err != nil {
		return PublicShareView{}, err
	}
	if !found || share.RevokedAt != "" {
		return notFound()
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, share.ExpiresAt)
	if err != nil || !time.Now().UTC().Before(expiresAt) {
		return notFound()
	}
	p, found, err := s.repo.getProposal(ctx, share.ProposalID)
	if err != nil {
		return PublicShareView{}, err
	}
	if !found {
		return notFound()
	}

	// collectionName 来自真实 Applied Model 查询；读不到时留空，不编造。
	collectionName := ""
	if collection, err := s.models.GetCollection(ctx, p.CollectionID); err == nil {
		collectionName = collection.Name
	}
	plan, err := s.buildPublicPlan(ctx, p)
	if err != nil {
		plan = PublicSharePlan{}
	}
	verification, err := s.computeVerification(ctx, p)
	if err != nil {
		verification = Verification{Checks: []Check{}}
	}
	return PublicShareView{
		ProposalID:     p.ID,
		Title:          p.Title,
		Requirement:    p.Requirement,
		Status:         p.Status,
		CollectionName: collectionName,
		FieldName:      p.FieldName,
		Plan:           plan,
		Verification:   verification,
		ExpiresAt:      share.ExpiresAt,
	}, nil
}

// buildPlan 从真实状态计算方案：有活跃 Pending Change 时读 GetPendingChange + Preview，
// 变更已归档（applied/discarded）时读 GetChange 的真实归档事实，没有 changeSetId 则为 null。
func (s *Service) buildPlan(ctx context.Context, p Proposal) (*Plan, error) {
	if p.ChangeSetID == "" {
		return nil, nil
	}
	pending, exists, err := s.models.GetPendingChange(ctx, p.CollectionID)
	if err != nil {
		return nil, err
	}
	if exists && pending.ChangeSetID == p.ChangeSetID {
		preview, err := s.models.Preview(ctx, p.CollectionID, pending.Version)
		if err != nil {
			return nil, err
		}
		return &Plan{
			ChangeSetID: pending.ChangeSetID,
			Version:     pending.Version,
			Operations:  pending.Operations,
			Preview: &PlanPreview{
				Risk:          preview.Risk,
				Diff:          preview.Diff,
				Impact:        preview.Impact,
				Preconditions: preview.Preconditions,
			},
		}, nil
	}

	// 已不再活跃：从 GetChange 读取操作与版本，preview 取最近一次 Apply 的持久评估（真实）。
	detail, err := s.models.GetChange(ctx, p.ChangeSetID)
	if err != nil {
		return nil, err
	}
	plan := &Plan{
		ChangeSetID: detail.ChangeSetID,
		Version:     detail.Version,
		Operations:  detail.Operations,
	}
	for i := len(detail.ApplyAttempts) - 1; i >= 0; i-- {
		evaluation := detail.ApplyAttempts[i].Evaluation
		if evaluation.Risk != "" {
			plan.Preview = &PlanPreview{
				Risk:          evaluation.Risk,
				Diff:          evaluation.Diff,
				Impact:        evaluation.Impact,
				Preconditions: evaluation.Preconditions,
			}
			break
		}
	}
	return plan, nil
}

// buildPublicPlan 为公开摘要计算 risk / impactSummary / diffCount，全部来自真实 DB 查询。
func (s *Service) buildPublicPlan(ctx context.Context, p Proposal) (PublicSharePlan, error) {
	out := PublicSharePlan{}
	if p.ChangeSetID == "" {
		return out, nil // 真实事实：尚无变更方案
	}
	pending, exists, err := s.models.GetPendingChange(ctx, p.CollectionID)
	if err == nil && exists && pending.ChangeSetID == p.ChangeSetID {
		preview, previewErr := s.models.Preview(ctx, p.CollectionID, pending.Version)
		if previewErr == nil {
			out.Risk = string(preview.Risk)
			out.ImpactSummary = preview.Impact.Summary
			out.DiffCount = len(preview.Diff)
			return out, nil
		}
	}
	detail, err := s.models.GetChange(ctx, p.ChangeSetID)
	if err != nil {
		return out, nil // 不伪造：拿不到真实归档事实就返回零值摘要
	}
	out.DiffCount = len(detail.Operations)
	for i := len(detail.ApplyAttempts) - 1; i >= 0; i-- {
		evaluation := detail.ApplyAttempts[i].Evaluation
		if evaluation.Risk != "" {
			out.Risk = string(evaluation.Risk)
			out.ImpactSummary = evaluation.Impact.Summary
			if len(evaluation.Diff) > 0 {
				out.DiffCount = len(evaluation.Diff)
			}
			break
		}
	}
	return out, nil
}

// computeVerification 基于真实 Applied Model、真实 Pending Change 与提案状态计算验证结论。
// check detail 只描述事实，不含内部表信息或绝对路径。
func (s *Service) computeVerification(ctx context.Context, p Proposal) (Verification, error) {
	checks := make([]Check, 0, 3)

	fieldOK := false
	fieldDetail := ""
	collection, err := s.models.GetCollection(ctx, p.CollectionID)
	switch {
	case err != nil:
		fieldDetail = "无法读取 Applied Model，无法确认目标字段。"
	default:
		field, exists := findField(collection.Fields, p.FieldName)
		switch {
		case exists && field.Type == backendmodel.FieldTypeBoolean:
			fieldOK = true
			fieldDetail = fmt.Sprintf("字段 %q 已真实存在于 Applied Model，类型为 boolean。", p.FieldName)
		case exists:
			fieldDetail = fmt.Sprintf("字段 %q 已存在但类型为 %q，不是 boolean。", p.FieldName, field.Type)
		default:
			fieldDetail = fmt.Sprintf("字段 %q 尚未出现在 Applied Model，变更可能未应用。", p.FieldName)
		}
	}
	checks = append(checks, Check{Label: "目标字段是否已真实存在于 Applied Model", Passed: fieldOK, Detail: fieldDetail})

	_, pendingExists, pendingErr := s.models.GetPendingChange(ctx, p.CollectionID)
	noPending := pendingErr == nil && !pendingExists
	pendingDetail := ""
	switch {
	case pendingErr != nil:
		pendingDetail = "无法读取待应用变更状态。"
	case pendingExists:
		pendingDetail = "仍存在待应用变更，变更尚未应用。"
	default:
		pendingDetail = "当前集合没有待应用变更。"
	}
	checks = append(checks, Check{Label: "是否存在待应用变更", Passed: noPending, Detail: pendingDetail})

	statusOK := p.Status == StatusApplied || p.Status == StatusVerified
	checks = append(checks, Check{Label: "提案状态", Passed: statusOK, Detail: "当前提案状态为 " + p.Status + "。"})

	passed := true
	for _, check := range checks {
		if !check.Passed {
			passed = false
			break
		}
	}
	return Verification{Passed: passed, Checks: checks}, nil
}

// buildUnderstanding 把真实集合状态整理为「规则化理解，非大模型生成」的结构化事实。
func buildUnderstanding(collection backendmodel.Collection, requirement, fieldName string) Understanding {
	fields := make([]UnderstandingField, 0, len(collection.Fields))
	for _, field := range collection.Fields {
		fields = append(fields, UnderstandingField{
			ID: field.ID, Name: field.Name, Type: string(field.Type), Required: field.Required,
		})
	}
	_, targetExists := findField(collection.Fields, fieldName)
	return Understanding{
		Kind:        "rules-based",
		Note:        "规则化理解，非大模型生成：以下事实来自项目当前真实状态的结构化分析，未调用任何外部模型。",
		Requirement: requirement,
		Collection: UnderstandingCollection{
			ID: collection.ID, Name: collection.Name, Type: string(collection.Type), SchemaVersion: collection.SchemaVersion,
		},
		Fields:            fields,
		TargetFieldName:   fieldName,
		TargetFieldExists: targetExists,
	}
}

func proposalTitle(collectionName, fieldName string) string {
	return "规则化提案：为「" + collectionName + "」新增布尔字段「" + fieldName + "」"
}

func findField(fields []backendmodel.Field, name string) (backendmodel.Field, bool) {
	for _, field := range fields {
		if field.Name == name {
			return field, true
		}
	}
	return backendmodel.Field{}, false
}

// classifyApplyError 把 models.Apply 的真实错误映射到对外安全的错误码/消息，
// 不拼接底层 SQLite 错误文本，避免泄漏实现细节。
func classifyApplyError(err error) (code, message string, status int) {
	var failure *backendmodel.ApplyFailure
	if errors.As(err, &failure) {
		return normalizeApplyCode(failure.Code), failure.Message, statusForApplyCode(failure.Code)
	}
	switch {
	case errors.Is(err, backendmodel.ErrChangeConfirmationRequired):
		return "CHANGE_CONFIRMATION_REQUIRED", "审阅当前影响并确认 schema 变更后再应用。", http.StatusConflict
	case errors.Is(err, backendmodel.ErrChangeBlocked):
		return "VALIDATION_FAILED", "当前数据或 schema 前提不满足，变更被阻止。", http.StatusUnprocessableEntity
	case errors.Is(err, backendmodel.ErrConflict):
		return "CONFLICT", "Pending Change 已变化，请重新加载最新版本。", http.StatusConflict
	case errors.Is(err, backendmodel.ErrNotFound):
		return "NOT_FOUND", "未找到待应用的 Pending Change。", http.StatusNotFound
	case errors.Is(err, backendmodel.ErrInvalidArgument):
		return "INVALID_ARGUMENT", "应用参数无效。", http.StatusBadRequest
	default:
		return "INTERNAL_ERROR", "应用 schema 变更未完成，已回滚。", http.StatusInternalServerError
	}
}

func normalizeApplyCode(code string) string {
	if code == "" {
		return "INTERNAL_ERROR"
	}
	return code
}

func statusForApplyCode(code string) int {
	switch code {
	case "CHANGE_CONFIRMATION_REQUIRED", "CONFLICT":
		return http.StatusConflict
	case "VALIDATION_FAILED":
		return http.StatusUnprocessableEntity
	case "NOT_FOUND":
		return http.StatusNotFound
	case "INVALID_ARGUMENT":
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}
