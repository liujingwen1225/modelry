import { api } from './client'

/** 审计记录：谁在什么时候对哪个资源做了什么，结果是什么。 */
export type AuditActor = {
  kind: string
  id: string
  displayName?: string
}

export type AuditResource = {
  kind: string
  id: string
  displayName?: string
}

export type AuditRecord = {
  id: string
  requestId?: string
  time: string
  actor: AuditActor
  action: string
  resource: AuditResource
  result: string
}

export type AuditPage = {
  data: AuditRecord[]
  nextCursor?: string
}

export const auditApi = {
  list: (options: { limit?: number; cursor?: string } = {}) =>
    api.get<AuditPage>('/admin/api/v1/audit', { query: { limit: options.limit, cursor: options.cursor } }),
}

export const auditKeys = {
  list: (limit: number) => ['audit', limit] as const,
}
