export type ApiErrorBody = {
  error?: {
    code?: string
    message?: string
    hint?: string
    requestId?: string
    details?: unknown
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly hint?: string
  readonly requestId?: string
  readonly details?: unknown

  constructor(status: number, body: ApiErrorBody | undefined, fallback: string) {
    const fault = body?.error
    super(fault?.message || fallback)
    this.name = 'ApiError'
    this.status = status
    this.code = fault?.code || 'INTERNAL_ERROR'
    this.hint = fault?.hint
    this.requestId = fault?.requestId
    this.details = fault?.details
  }
}

type QueryValue = string | number | boolean | undefined | null

export type RequestOptions = {
  body?: unknown
  query?: Record<string, QueryValue>
  signal?: AbortSignal
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined
  }
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path, window.location.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue
      }
      url.searchParams.set(key, String(value))
    }
  }
  return url.pathname + url.search
}

/**
 * 唯一的 HTTP 入口：Admin 会话走同源 Cookie，错误统一收敛成 ApiError。
 * 不缓存、不重试——重试策略由调用方（查询层）决定。
 */
export async function apiRequest<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  const response = await fetch(buildUrl(path, options.query), {
    method,
    credentials: 'same-origin',
    headers,
    body,
    signal: options.signal,
  })

  const payload = await readBody(response)
  if (!response.ok) {
    throw new ApiError(response.status, payload as ApiErrorBody, `请求失败（HTTP ${response.status}）`)
  }
  return payload as T
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'body'>) => apiRequest<T>('GET', path, options ?? {}),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'body'>) =>
    apiRequest<T>('POST', path, { ...options, body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, { body: body ?? {} }),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>('DELETE', path, body === undefined ? {} : { body }),
  /** 文件上传：由浏览器设置 multipart 边界，不能手写 Content-Type。 */
  upload: async <T>(path: string, body: FormData): Promise<T> => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', body, headers: { Accept: 'application/json' } })
    const payload = await readBody(response)
    if (!response.ok) {
      throw new ApiError(response.status, payload as ApiErrorBody, `上传失败（HTTP ${response.status}）`)
    }
    return payload as T
  },
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.hint ? `${error.message}（${error.hint}）` : error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return '发生未知错误'
}
