import { api } from './client'

/**
 * Activity 事实：结构变更、执行、投递等领域事件。
 * 只用于「最近发生」这类时间线；记录内容与凭据不会出现在这里。
 */
export type ActivityKind =
  | 'change.applied'
  | 'change.pending'
  | 'change.failed'
  | 'webhook.delivery'
  | 'job.run'
  | 'extension.run'
  | 'mail.delivery'
  | 'storage.migration'
  | 'auth.recovery'

export type ActivityFact = {
  id: string
  kind: ActivityKind
  status: string
  occurredAt: string
  resourceKind: string
  resourceId: string
  collectionId?: string
  title?: string
  deepLink: string
}

export type ActivityPage = {
  data: ActivityFact[]
  nextCursor?: string
}

export const activityApi = {
  list: (options: { limit?: number; cursor?: string; collectionId?: string } = {}) =>
    api.get<ActivityPage>('/admin/api/v1/activity', {
      query: { limit: options.limit, cursor: options.cursor, collectionId: options.collectionId },
    }),
}

export const activityKeys = {
  list: (limit: number) => ['activity', limit] as const,
}
