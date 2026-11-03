import { api } from './client'

/** 概览聚合：只包含计数、状态与最近集合摘要，不返回记录内容或凭据。 */
export type ChangeStatus = 'ready' | 'needsReview' | 'failed' | 'applied' | 'discarded'

export type RecentCollection = {
  id: string
  name: string
  type: 'Normal' | 'Auth'
  recordCount?: number
  fieldCount: number
  relationCount: number
  indexCount: number
  pendingChangeStatus?: ChangeStatus
  updatedAt: string
}

export type OverviewSnapshot = {
  generatedAt: string
  windowSeconds: number
  collections?: {
    count: number
    recordCount?: number
    withPendingChanges: number
    withFailedChanges: number
    recent?: RecentCollection[]
  }
  requests?: {
    windowSeconds: number
    requestCount: number
    clientErrorCount: number
    serverErrorCount: number
    p95DurationMs?: number
  }
  events?: {
    enabledHooks: number
    enabledWebhooks: number
    enabledEventHooks: number
    enabledJobs: number
    runCount: number
    deliveryCount: number
    failedDeliveryCount: number
    pendingDeliveryCount: number
  }
  changes?: {
    pendingCount: number
    needsReviewCount: number
    failedCount: number
  }
  drift?: {
    state: string
    differenceCount: number
    checkedAt: string
  }
}

export const overviewApi = {
  read: () => api.get<{ data: OverviewSnapshot }>('/admin/api/v1/overview').then((response) => response.data),
}

export const overviewKeys = {
  snapshot: ['overview-snapshot'] as const,
}
