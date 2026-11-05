/**
 * 变更中心（Issue #47）真实 API 层。
 *
 * 端点全部来自已核实的后端契约，不猜测其它路径：
 *   GET  /admin/api/v1/changes?cursor&limit          混合变更流
 *   GET  /admin/api/v1/changes/{changeSetId}         变更详情
 *   GET  /admin/api/v1/collections                   集合列表（名称映射，复用 collectionsApi.list）
 *   GET  /admin/api/v1/collections/{id}/schema/pending-change
 *   POST /admin/api/v1/collections/{id}/schema/preview
 *   POST /admin/api/v1/collections/{id}/schema/apply
 *   POST /admin/api/v1/collections/{id}/schema/discard
 *   GET  /admin/api/v1/collections/{id}/schema/history?cursor&limit
 *
 * 关键点：GET /changes 返回的是 PendingChange 与 AppliedMigration 的混合数组，
 * 后端没有给类型判别字段，所以前端必须按字段判别（operations / appliedAt）。
 */
import { api } from './client'
import type {
  AppliedMigration,
  ApplyResult,
  ChangeStatus,
  DiffItem,
  PendingChange,
  PendingOperation,
  SchemaPreview,
} from './collections'

export type {
  AppliedMigration,
  ApplyResult,
  ChangeStatus,
  DiffItem,
  PendingChange,
  PendingOperation,
  SchemaPreview,
}

/** 应用失败后的恢复信息；actions 是后端建议的下一步。 */
export type RecoveryState = {
  state: string
  summary?: string
  actions?: string[]
}

/**
 * 应用尝试记录。契约只声明存在 applyAttempts 数组，没有固定元素结构，
 * 因此保留索引签名，页面直接渲染真实 JSON，不臆造字段。
 */
export type ApplyAttempt = {
  id?: string
  state?: string
  status?: string
  startedAt?: string
  finishedAt?: string
  appliedAt?: string
  error?: unknown
  recovery?: RecoveryState
  [key: string]: unknown
}

/** GET /changes/{changeSetId} 的 data。 */
export type ChangeDetail = {
  changeSetId: string
  collectionId: string
  status: ChangeStatus
  version: number
  operations: PendingOperation[]
  applyAttempts: ApplyAttempt[]
  appliedMigration: AppliedMigration | null
  recoveryState: RecoveryState | null
}

/** /changes 的混合数组元素。 */
export type ChangeFeedItem = PendingChange | AppliedMigration

export type ChangeFeedPage = {
  data: ChangeFeedItem[]
  nextCursor?: string | null
}

/** 有 operations 即待审阅变更（PendingChange）。 */
export function isPendingChange(item: ChangeFeedItem): item is PendingChange {
  return Array.isArray((item as PendingChange).operations)
}

/** 有 appliedAt 即已应用历史（AppliedMigration）。 */
export function isAppliedMigration(item: ChangeFeedItem): item is AppliedMigration {
  return typeof (item as AppliedMigration).appliedAt === 'string'
}

export type ChangeTab = 'pending' | 'history'
export type DetailView = 'diff' | 'risk' | 'attempts'

/** ChangeStatus 的中文文案，与 Figma「待审阅 / 已应用 / 失败」一致。 */
export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = {
  ready: '待应用',
  needsReview: '需要确认',
  failed: '失败',
  applied: '已应用',
  discarded: '已放弃',
}

export const CHANGE_STATUS_TONE: Record<ChangeStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  ready: 'warning',
  needsReview: 'warning',
  failed: 'danger',
  applied: 'success',
  discarded: 'neutral',
}

export const OPERATION_KIND_LABEL: Record<string, string> = {
  field: '字段',
  relation: '关联',
  index: '索引',
}

export const ACTION_LABEL: Record<string, string> = {
  add: '新增',
  update: '修改',
  remove: '删除',
}

/** Figma 差异列里使用的符号：＋ / ～ / －。 */
export const ACTION_MARK: Record<string, string> = {
  add: '＋',
  update: '～',
  remove: '－',
}

/** preview.risk 是字符串枚举，不是对象。 */
export const RISK_LABEL: Record<'safe' | 'review' | 'blocked', string> = {
  safe: '安全',
  review: '需要确认',
  blocked: '被阻塞',
}

export const RISK_TONE: Record<'safe' | 'review' | 'blocked', 'success' | 'warning' | 'danger'> = {
  safe: 'success',
  review: 'warning',
  blocked: 'danger',
}

export const changeKeys = {
  feed: ['changes', 'feed'] as const,
  detail: (changeSetId: string) => ['changes', 'detail', changeSetId] as const,
  preview: (collectionId: string, version: number) => ['changes', 'preview', collectionId, version] as const,
  collectionHistory: (collectionId: string) => ['changes', 'collection-history', collectionId] as const,
}

const BASE = '/admin/api/v1'

/** 集合维度的路径统一做一次转义，避免 id 里的特殊字符破坏 URL。 */
function collectionPath(collectionId: string, suffix: string): string {
  return `${BASE}/collections/${encodeURIComponent(collectionId)}/schema/${suffix}`
}

export const changesApi = {
  /** 混合变更流；保留 nextCursor 供 useInfiniteQuery 加载更多。 */
  list: (params: { cursor?: string; limit?: number; signal?: AbortSignal } = {}) =>
    api.get<ChangeFeedPage>(`${BASE}/changes`, {
      query: { cursor: params.cursor, limit: params.limit },
      signal: params.signal,
    }),

  detail: (changeSetId: string) =>
    api
      .get<{ data: ChangeDetail }>(`${BASE}/changes/${encodeURIComponent(changeSetId)}`)
      .then((response) => response.data),

  /** 单集合待应用变更，可用于确认某集合是否仍有 pending。 */
  pendingChange: (collectionId: string) =>
    api
      .get<{ data: PendingChange | null }>(collectionPath(collectionId, 'pending-change'))
      .then((response) => response.data),

  /** risk 为字符串枚举 'safe' | 'review' | 'blocked'。 */
  preview: (collectionId: string, expectedVersion: number) =>
    api
      .post<{ data: SchemaPreview }>(collectionPath(collectionId, 'preview'), { expectedVersion })
      .then((response) => response.data),

  /**
   * risk=review 时必须显式 confirmRisk，否则后端返回 409 CHANGE_CONFIRMATION_REQUIRED；
   * 被记录阻塞时返回 422 VALIDATION_FAILED。
   */
  apply: (collectionId: string, expectedVersion: number, confirmRisk: boolean) =>
    api
      .post<{ data: ApplyResult }>(collectionPath(collectionId, 'apply'), { expectedVersion, confirmRisk })
      .then((response) => response.data),

  /** 无 pending 时后端返回 404。 */
  discard: (collectionId: string, expectedVersion: number) =>
    api
      .post<{ data: PendingChange }>(collectionPath(collectionId, 'discard'), { expectedVersion })
      .then((response) => response.data),

  /** 单集合已应用历史，用于历史标签按集合补充完整列表。 */
  history: (collectionId: string, params: { cursor?: string; limit?: number } = {}) =>
    api
      .get<{ data: AppliedMigration[]; nextCursor?: string }>(collectionPath(collectionId, 'history'), {
        query: { cursor: params.cursor, limit: params.limit },
      })
      .then((response) => response.data),
}
