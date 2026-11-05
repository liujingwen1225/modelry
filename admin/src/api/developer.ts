import { api } from './client'

/**
 * 开发与连接（Issue #45）的真实后端契约封装。
 *
 * 端点路径与字段严格来自已核实的后端契约；不猜测额外端点、不注入示例数据。
 * 所有写操作走同源 Cookie，由 @/api/client 的 api 统一处理。
 */

/**
 * 当前后端 `GET /developer/contract` 的 endpoints 是形如 "GET /api/v1/notes" 的字符串数组
 * （见 internal/portability/transfer.go:BuildContract）。这里同时兼容未来的对象结构。
 */
export type ContractEndpoint = Record<string, unknown>
export type ContractEndpointValue = string | ContractEndpoint

export type ContractAccessRule = {
  operation: string
  mode: string
}

export type ContractCollection = {
  id: string
  name: string
  type: string
  schemaVersion: number
  fields: unknown
  endpoints: ContractEndpointValue[]
  accessRules: ContractAccessRule[]
}

export type DeveloperContract = {
  version: string
  contentHash: string
  apiBasePath: string
  collections: ContractCollection[]
}

export type RequestRecord = {
  requestId: string
  time: string
  collectionId: string
  endpoint: string
  method: string
  status: number
  durationMs: number
  responseSizeBytes: number
  authenticationOutcome: string
  authorizationOutcome: string
  errorCode?: string
}

/** 列表响应是扁平的 { data, nextCursor }，不是再包一层 data。 */
export type RequestPage = {
  data: RequestRecord[]
  nextCursor?: string
}

/** filter 语法：<field> <op> <JSON值>，例如 "status gte 400"。 */
export type RequestListParams = {
  limit?: number
  cursor?: string
  search?: string
  filter?: string
}

/** Secret 列表永不返回明文，只有元数据。 */
export type SecretMetadata = {
  id: string
  name: string
  configured: boolean
  createdAt: string
  updatedAt: string
}

export const developerApi = {
  contract: () =>
    api.get<{ data: DeveloperContract }>('/admin/api/v1/developer/contract').then((response) => response.data),

  requests: (params: RequestListParams) =>
    api.get<RequestPage>('/admin/api/v1/requests', {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        search: params.search,
        filter: params.filter,
      },
    }),

  /** 不存在的 requestId 返回 404，调用方应关闭重试并显示真实错误。 */
  request: (requestId: string) =>
    api
      .get<{ data: RequestRecord }>(`/admin/api/v1/requests/${encodeURIComponent(requestId)}`)
      .then((response) => response.data),
}

export const secretsApi = {
  list: () => api.get<{ data: SecretMetadata[] }>('/admin/api/v1/secrets').then((response) => response.data),

  create: (input: { name: string; value: string }) =>
    api.post<{ data: SecretMetadata }>('/admin/api/v1/secrets', input).then((response) => response.data),

  /** 只改名，明文从未离开服务端。 */
  rename: (id: string, name: string) =>
    api
      .patch<{ data: SecretMetadata }>(`/admin/api/v1/secrets/${encodeURIComponent(id)}`, { name })
      .then((response) => response.data),

  /** 更新版本；服务端不回显明文。 */
  setValue: (id: string, value: string) =>
    api
      .put<{ data: SecretMetadata }>(`/admin/api/v1/secrets/${encodeURIComponent(id)}/value`, { value })
      .then((response) => response.data),

  /** 204 无响应体；列表刷新交给调用方的 invalidateQueries。 */
  remove: (id: string) => api.delete<void>(`/admin/api/v1/secrets/${encodeURIComponent(id)}`),
}

export const developerKeys = {
  contract: ['developer-contract'] as const,
  requests: (params: RequestListParams) => ['developer-requests', params] as const,
  request: (requestId: string) => ['developer-request', requestId] as const,
  secrets: ['developer-secrets'] as const,
}
