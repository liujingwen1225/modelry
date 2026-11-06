import { api } from './client'

/** Collection / Schema 的 Admin API 类型。字段名与后端 JSON 契约一一对应。 */
export type FieldType = 'text' | 'number' | 'boolean' | 'dateTime' | 'json' | 'relation' | 'file' | 'files'

export type ChangeStatus = 'ready' | 'needsReview' | 'failed' | 'applied' | 'discarded'

/** 与 backendmodel.Relation 的真实 JSON 契约一致：targetCollectionId + cardinality。 */
export type RelationCardinality = 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many'

export type Relation = {
  targetCollectionId: string
  cardinality: RelationCardinality
}

/** 多选关联在界面上映射成 many-to-many，单选映射成 many-to-one。 */
export function isMultipleRelation(relation?: Relation): boolean {
  return relation?.cardinality === 'many-to-many' || relation?.cardinality === 'one-to-many'
}

export type Field = {
  id: string
  name: string
  type: FieldType
  required?: boolean
  unique?: boolean
  description?: string
  validation?: unknown
  default?: unknown
  relation?: Relation
  system?: boolean
}

export type Index = {
  id: string
  name: string
  fields?: string[]
  unique?: boolean
}

export type Collection = {
  id: string
  name: string
  description?: string
  type: 'Normal' | 'Auth'
  fields: Field[]
  indexes?: Index[]
  schemaVersion: number
  createdAt: string
  updatedAt: string
}

export type CollectionSummary = Collection & {
  recordCount: number
  pendingChangeStatus?: ChangeStatus
}

export type PendingOperation = {
  id: string
  kind: 'field' | 'relation' | 'index'
  action: 'add' | 'update' | 'remove'
  targetId?: string
  definition: unknown
  createdAt: string
  updatedAt: string
}

export type PendingChange = {
  changeSetId: string
  collectionId: string
  version: number
  status: ChangeStatus
  operations: PendingOperation[]
  recoveryState?: { state: string; summary?: string; actions?: string[] }
  createdAt: string
  updatedAt: string
}

export type DiffItem = {
  kind: string
  action: string
  targetId: string
  name?: string
  before?: unknown
  after?: unknown
}

export type SchemaPreview = {
  /** 后端 Risk 是字符串枚举，不是对象。 */
  risk: 'safe' | 'review' | 'blocked'
  diff: DiffItem[]
  preconditions: Array<{ code: string; status: string; message: string }>
  impact: {
    affectedCollections: number
    affectedFields: number
    affectedIndexes: number
    affectedRecords: number
    summary: string
  }
  version: number
}

export type AppliedMigration = {
  id: string
  changeSetId: string
  collectionId: string
  applyAttemptId: string
  appliedAt: string
  schemaVersion: number
  diff: DiffItem[]
}

export type CollectionDeletionResult = {
  collectionId: string
  name: string
  deletedRecords: number
  discardedChanges: number
  revokedSessions: number
  deletedFileObjects: number
  pendingFileObjects?: number
  irreversible: boolean
}

export type ApplyResult = {
  state: string
  appliedMigrationId?: string
  applyAttemptId?: string
  recovery?: { state: string; summary?: string; actions?: string[] }
}

export type FieldInput = {
  name: string
  type: FieldType
  required?: boolean
  unique?: boolean
  description?: string
  relation?: Relation
  /** 文件字段约束：maxBytes / maxFiles / allowedMimeTypes，由后端 AppliedFileConstraints 校验。 */
  validation?: unknown
}

export const collectionsApi = {
  list: () =>
    api.get<{ data: CollectionSummary[]; nextCursor?: string }>('/admin/api/v1/collections').then((page) => page.data),
  get: (collectionId: string) =>
    api.get<{ data: Collection }>(`/admin/api/v1/collections/${collectionId}`).then((response) => response.data),
  create: (input: { name: string; description?: string; type?: 'Normal' | 'Auth'; fields: FieldInput[] }) =>
    api.post<{ data: Collection }>('/admin/api/v1/collections', { type: 'Normal', ...input }).then((response) => response.data),

  /** 不可逆删除：后端要求 Owner，并在提供 confirmName 时二次校验集合名称。 */
  remove: (collectionId: string, confirmName: string) =>
    api
      .delete<{ data: CollectionDeletionResult }>(`/admin/api/v1/collections/${collectionId}`, { confirmName })
      .then((response) => response.data),

  pendingChange: (collectionId: string) =>
    api
      .get<{ data: PendingChange | null }>(`/admin/api/v1/collections/${collectionId}/schema/pending-change`)
      .then((response) => response.data),

  addOperation: (
    collectionId: string,
    operation: { kind: 'field' | 'relation' | 'index'; action: 'add' | 'update' | 'remove'; targetId?: string; definition: unknown },
  ) =>
    api
      .post<{ data: PendingChange }>(`/admin/api/v1/collections/${collectionId}/schema/pending-operations`, operation)
      .then((response) => response.data),

  removeOperation: (collectionId: string, operationId: string) =>
    api
      .delete<{ data: PendingChange }>(`/admin/api/v1/collections/${collectionId}/schema/pending-operations/${operationId}`)
      .then((response) => response.data),

  preview: (collectionId: string, expectedVersion: number) =>
    api
      .post<{ data: SchemaPreview }>(`/admin/api/v1/collections/${collectionId}/schema/preview`, { expectedVersion })
      .then((response) => response.data),

  apply: (collectionId: string, expectedVersion: number, confirmRisk = false) =>
    api
      .post<{ data: ApplyResult }>(`/admin/api/v1/collections/${collectionId}/schema/apply`, { expectedVersion, confirmRisk })
      .then((response) => response.data),

  discard: (collectionId: string, expectedVersion: number) =>
    api.post<{ data: PendingChange }>(`/admin/api/v1/collections/${collectionId}/schema/discard`, { expectedVersion }),

  history: (collectionId: string) =>
    api
      .get<{ data: AppliedMigration[]; nextCursor?: string }>(`/admin/api/v1/collections/${collectionId}/schema/history`)
      .then((page) => page.data),
}

export const collectionKeys = {
  list: ['collections'] as const,
  detail: (collectionId: string) => ['collection', collectionId] as const,
  pending: (collectionId: string) => ['collection', collectionId, 'pending'] as const,
  history: (collectionId: string) => ['collection', collectionId, 'history'] as const,
}
