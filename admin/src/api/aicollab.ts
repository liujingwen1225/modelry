/**
 * AI 协作（Issue #48）真实 API 层。
 *
 * 端点全部来自已核实的后端契约，不猜测其它路径：
 *   管理面（Owner-only，统一 { data: ... }）：
 *     GET    /admin/api/v1/ai/proposals
 *     POST   /admin/api/v1/ai/proposals                     body { requirement, collectionId, fieldName? }
 *     GET    /admin/api/v1/ai/proposals/{id}
 *     POST   /admin/api/v1/ai/proposals/{id}/plan
 *     POST   /admin/api/v1/ai/proposals/{id}/apply           body { confirmRisk? }
 *     POST   /admin/api/v1/ai/proposals/{id}/verify
 *     POST   /admin/api/v1/ai/proposals/{id}/shares          body { expiresInHours? }
 *     GET    /admin/api/v1/ai/proposals/{id}/shares
 *     DELETE /admin/api/v1/ai/shares/{id}                    → 204
 *   公开只读（裸对象，不是 { data }，无需登录）：
 *     GET    /api/v1/public/ai/shares/{token}
 *
 * 产品边界：understandingJson 是后端「对真实项目状态的结构化理解」，
 * 规则化计算的结果，不是大模型生成的文字。页面必须据此标注，不得伪造成 AI 输出。
 */
import { api } from './client'

/* ── 类型：字段名与后端 JSON 契约一一对应 ─────────────────── */

export type ProposalStatus = 'draft' | 'planned' | 'applied' | 'verified' | 'failed'

/**
 * 后端在草稿阶段用空字符串表示 changeSetId / fieldName / errorCode / errorMessage 未设置，
 * 因此这些字段前端按「可空」容错处理，页面还要把空串当成「未设置」显示；不臆造缺省值。
 */
export type Proposal = {
  id: string
  title: string
  requirement: string
  collectionId: string
  /**
   * 规则化理解。书面契约是 JSON 字符串（需 JSON.parse）；真实后端用 json.RawMessage
   * 输出为内嵌 JSON 对象。两种形态页面都兼容，结构变化也自行容错。
   */
  understandingJson: unknown
  status: ProposalStatus
  changeSetId: string | null
  fieldName: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

/** preview.risk 是字符串枚举，不是对象。 */
export type AiRisk = 'safe' | 'review' | 'blocked'

export type PlanPreview = {
  risk: AiRisk
  /** 差异结构由后端决定，这里保留 unknown，页面按真实 JSON 渲染。 */
  diff: unknown
  impact: {
    affectedCollections: number
    affectedFields: number
    affectedIndexes: number
    affectedRecords: number
    summary: string
  }
  preconditions: Array<{ code: string; status: string; message: string }>
}

/** 变更已归档且没有持久评估时，后端 preview 为 null；页面必须容错。 */
export type ProposalPlan = {
  changeSetId: string
  version: number
  operations: unknown[]
  preview: PlanPreview | null
}

export type VerificationCheck = {
  label: string
  passed: boolean
  detail: string
}

export type Verification = {
  passed: boolean
  checks: VerificationCheck[]
}

/** 详情 = Proposal 全部字段 + 可能为 null 的 plan / verification。 */
export type ProposalDetail = Proposal & {
  plan: ProposalPlan | null
  verification: Verification | null
}

/**
 * 创建分享（201）返回 token + 相对 url（明文只此一次）；
 * 列表项刻意不含明文 token/url，只含元数据。因此 token/url 为可选，
 * 页面对「列表里没有明文链接」做真实反馈。
 */
export type ShareLink = {
  id: string
  token?: string
  /** 相对路径 /ai/share/{token}；完整 URL 由前端拼接 window.location.origin。 */
  url?: string
  proposalId?: string
  createdAt?: string
  expiresAt: string
  /** 未撤销时后端是空字符串 ""，已撤销才是非空时间。 */
  revokedAt: string | null
  scope?: string
}

/** 公开只读端点返回裸对象（不是 { data }）。status 用 string 容错未知枚举。 */
export type PublicShare = {
  proposalId: string
  title: string
  requirement: string
  status: string
  collectionName: string
  fieldName: string | null
  /** 真实后端总是返回对象；尚无方案时 risk 为空字符串。 */
  plan: {
    risk: string
    impactSummary: string
    diffCount: number
  } | null
  verification: Verification | null
  expiresAt: string
}

/* ── 展示文案：状态 / 风险的中文标记 ─────────────────────── */

export const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  planned: '已生成方案 · 待审阅',
  applied: '已应用',
  verified: '已验证',
  failed: '失败',
}

export const PROPOSAL_STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  planned: 'warning',
  applied: 'success',
  verified: 'success',
  failed: 'danger',
}

export const AI_RISK_LABEL: Record<string, string> = {
  safe: '安全',
  review: '需要确认',
  blocked: '被阻塞',
}

export const AI_RISK_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  safe: 'success',
  review: 'warning',
  blocked: 'danger',
}

export const aiKeys = {
  proposals: ['ai', 'proposals'] as const,
  detail: (id: string) => ['ai', 'detail', id] as const,
  shares: (id: string) => ['ai', 'shares', id] as const,
  publicShare: (token: string) => ['ai', 'public-share', token] as const,
}

const ADMIN_BASE = '/admin/api/v1/ai'
const PUBLIC_BASE = '/api/v1/public/ai'

/** 路径里的 id / token 统一转义，避免特殊字符破坏 URL。 */
const proposalPath = (id: string, suffix = '') =>
  `${ADMIN_BASE}/proposals/${encodeURIComponent(id)}${suffix}`

export const aicollabApi = {
  list: () =>
    api.get<{ data: Proposal[] }>(`${ADMIN_BASE}/proposals`).then((response) => response.data),

  create: (input: { requirement: string; collectionId: string; fieldName?: string }) =>
    api.post<{ data: Proposal }>(`${ADMIN_BASE}/proposals`, input).then((response) => response.data),

  detail: (id: string) =>
    api.get<{ data: ProposalDetail }>(proposalPath(id)).then((response) => response.data),

  /** 真实创建一条待应用结构变更，不绕过变更生命周期。 */
  plan: (id: string) =>
    api.post<{ data: Proposal }>(proposalPath(id, '/plan')).then((response) => response.data),

  /** risk=review 由调用方传 confirmRisk=true；失败由后端落库真实 errorCode/errorMessage。 */
  apply: (id: string, confirmRisk: boolean) =>
    api
      .post<{ data: Proposal }>(proposalPath(id, '/apply'), { confirmRisk })
      .then((response) => response.data),

  /** 读取真实 Applied Model，核对目标字段是否已真实存在。 */
  verify: (id: string) =>
    api.post<{ data: ProposalDetail }>(proposalPath(id, '/verify')).then((response) => response.data),

  listShares: (id: string) =>
    api.get<{ data: ShareLink[] }>(proposalPath(id, '/shares')).then((response) => response.data),

  /** expiresInHours ∈ [1,168]，不传则后端默认 24。 */
  createShare: (id: string, expiresInHours?: number) =>
    api
      .post<{ data: ShareLink }>(proposalPath(id, '/shares'), expiresInHours ? { expiresInHours } : {})
      .then((response) => response.data),

  revokeShare: (shareId: string) =>
    api.delete<void>(`${ADMIN_BASE}/shares/${encodeURIComponent(shareId)}`),

  /** 公开只读：裸对象，token 无效 / 过期 / 已撤销一律 404 SHARE_NOT_FOUND。 */
  publicShare: (token: string) =>
    api.get<PublicShare>(`${PUBLIC_BASE}/shares/${encodeURIComponent(token)}`),
}
