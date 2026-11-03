import { api } from './client'

/** Record 值以字段名为键扁平返回，另含 id / createdAt / updatedAt。 */
export type RecordValue = string | number | boolean | null | unknown[] | Record<string, unknown>

export type RecordItem = {
  id: string
  createdAt: string
  updatedAt: string
  [field: string]: RecordValue
}

export type RecordPage = {
  data: RecordItem[]
  nextCursor?: string
}

export type FileUpload = {
  /** Runtime 生成的存储引用；记录字段值必须先上传再写入这个 key。 */
  temporaryId: string
  contentType: string
  size: number
}

export const recordsApi = {
  list: (collectionId: string, options: { limit?: number; cursor?: string } = {}) =>
    api.get<RecordPage>(`/admin/api/v1/collections/${collectionId}/records`, {
      query: { limit: options.limit, cursor: options.cursor },
    }),

  get: (collectionId: string, recordId: string, expand: string[] = []) =>
    api
      .get<{ data: RecordItem }>(`/admin/api/v1/collections/${collectionId}/records/${recordId}`, {
        query: { expand: expand.length > 0 ? expand.join(',') : undefined },
      })
      .then((response) => response.data),

  create: (collectionId: string, values: Record<string, unknown>) =>
    api
      .post<{ data: RecordItem }>(`/admin/api/v1/collections/${collectionId}/records`, { values })
      .then((response) => response.data),

  update: (collectionId: string, recordId: string, values: Record<string, unknown>) =>
    api
      .patch<{ data: RecordItem }>(`/admin/api/v1/collections/${collectionId}/records/${recordId}`, { values })
      .then((response) => response.data),

  remove: (collectionId: string, recordId: string) =>
    api.delete<void>(`/admin/api/v1/collections/${collectionId}/records/${recordId}`),

  /** 文件字段上传：返回可写入 field 值对象的上传结果。 */
  uploadFile: (collectionId: string, fieldName: string, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return api.upload<{ data: FileUpload }>(
      `/admin/api/v1/collections/${collectionId}/files?fieldName=${encodeURIComponent(fieldName)}`,
      body,
    )
  },

  fileUrl: (collectionId: string, recordId: string, fieldName: string, index?: number) =>
    `/admin/api/v1/collections/${collectionId}/records/${recordId}/files/${encodeURIComponent(fieldName)}${
      index === undefined ? '' : `/${index}`
    }`,
}

export const recordKeys = {
  list: (collectionId: string) => ['records', collectionId] as const,
}
