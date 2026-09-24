import { ApiClientError, type ApiError, getJson } from './client';

export type RequestRecord = {
  requestId: string;
  time: string;
  collectionId?: string;
  endpoint: string;
  method: string;
  status: number;
  durationMs: number;
  authenticationOutcome?: string;
  authorizationOutcome?: string;
  errorCode?: string;
};

export type RequestRecordPage = { data: RequestRecord[]; nextCursor?: string };
export type RequestRecordQuery = { limit?: number; cursor?: string; search?: string; filter?: string; sort?: string };

export type ApplicationRunInput = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: string;
  applicationSession?: string;
  signal?: AbortSignal;
};

export type ApplicationRunResult = {
  status: number;
  durationMs: number;
  requestId?: string;
  requestRecordPersisted: boolean;
  body?: unknown;
  textResponseHidden?: boolean;
  structuredError?: Pick<ApiError, 'code' | 'message' | 'requestId' | 'hint' | 'details'>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryString(options: RequestRecordQuery): string {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.search) query.set('search', options.search);
  if (options.filter) query.set('filter', options.filter);
  if (options.sort) query.set('sort', options.sort);
  const value = query.toString();
  return value ? `?${value}` : '';
}

function invalidResponse(status: number, message: string, requestId = 'unavailable'): ApiClientError {
  return new ApiClientError(status, { code: 'INTERNAL_ERROR', message, details: {}, requestId });
}

export async function listRequestRecords(options: RequestRecordQuery = {}, signal?: AbortSignal): Promise<RequestRecordPage> {
  const result: unknown = await getJson<unknown>(`/admin/api/v1/requests${queryString(options)}`, signal);
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw invalidResponse(200, 'The Runtime returned an invalid Request list.');
  }
  return {
    data: result.data.filter(isRecord).map((item) => item as RequestRecord),
    ...(typeof result.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function getRequestRecord(requestId: string, signal?: AbortSignal): Promise<RequestRecord> {
  const result: unknown = await getJson<unknown>(`/admin/api/v1/requests/${encodeURIComponent(requestId)}`, signal);
  if (!isRecord(result) || !isRecord(result.data) || typeof result.data.requestId !== 'string') {
    throw invalidResponse(200, 'The Runtime returned an invalid Request detail.');
  }
  return result.data as RequestRecord;
}

function validateApplicationPath(path: string): string {
  if (!path.startsWith('/api/v1/') || path.startsWith('//') || path.includes('#')) {
    throw new Error('Application API paths must stay under /api/v1/.');
  }
  let parsed: URL;
  try {
    parsed = new URL(path, window.location.origin);
  } catch {
    throw new Error('Application API paths must stay under /api/v1/.');
  }
  if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/v1/')) {
    throw new Error('Application API paths must stay under /api/v1/.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/password|token|secret|credential|api.?key|authorization|cookie/i.test(key)) safe[key] = '[redacted]';
    else safe[key] = redact(child);
  }
  return safe;
}

function errorFromBody(value: unknown, requestId?: string): ApplicationRunResult['structuredError'] {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const error = value.error;
  return {
    code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: typeof error.message === 'string' ? error.message : 'The request failed.',
    requestId: requestId ?? (typeof error.requestId === 'string' ? error.requestId : 'unavailable'),
    details: isRecord(error.details) ? redact(error.details) as Record<string, unknown> : {},
    ...(typeof error.hint === 'string' ? { hint: error.hint } : {}),
  };
}

export async function runApplicationRequest(input: ApplicationRunInput): Promise<ApplicationRunResult> {
  const path = validateApplicationPath(input.path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.applicationSession) headers.Authorization = `Bearer ${input.applicationSession}`;
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';

  const startedAt = performance.now();
  const response = await fetch(path, {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
    credentials: 'omit',
    mode: 'same-origin',
    cache: 'no-store',
    signal: input.signal,
  });
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const requestId = response.headers.get('X-Request-Id') ?? undefined;
  const requestRecordPersisted = response.headers.get('X-Request-Record-Persisted') === 'true';
  const contentType = response.headers.get('Content-Type')?.toLocaleLowerCase() ?? '';
  let body: unknown;
  let textResponseHidden = false;

  if (response.status !== 204) {
    if (contentType.includes('json')) {
      try { body = redact(await response.json()); }
      catch { body = { message: 'The response could not be parsed as JSON.' }; }
    } else if (contentType.startsWith('text/')) {
      textResponseHidden = true;
    } else if (contentType) {
      textResponseHidden = true;
    }
  }

  const structuredError = errorFromBody(body, requestId);
  return {
    status: response.status,
    durationMs,
    ...(requestId ? { requestId } : {}),
    requestRecordPersisted,
    ...(body === undefined ? {} : { body }),
    ...(textResponseHidden ? { textResponseHidden: true } : {}),
    ...(structuredError ? { structuredError } : {}),
  };
}
