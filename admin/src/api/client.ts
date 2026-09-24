export type ErrorDetails = Record<string, unknown> & {
  violations?: Array<{ path: string; code: string; message: string }>;
};

export type ApiError = {
  code: string;
  message: string;
  details: ErrorDetails;
  hint?: string;
  requestId: string;
};

export class ApiClientError extends Error {
  readonly name = 'ApiClientError';

  constructor(
    readonly status: number,
    readonly apiError: ApiError,
  ) {
    super(apiError.message);
  }
}

type ErrorEnvelope = { error?: Partial<ApiError> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asErrorDetails(value: unknown): ErrorDetails {
  return isRecord(value) ? value : {};
}

async function readError(response: Response): Promise<ApiClientError> {
  let body: ErrorEnvelope = {};

  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed) && isRecord(parsed.error)) body = parsed as ErrorEnvelope;
  } catch {
    body = {};
  }

  const candidate = body.error ?? {};
  const headerRequestId = response.headers.get('X-Request-Id') ?? undefined;
  const apiError: ApiError = {
    code: typeof candidate.code === 'string' ? candidate.code : 'INTERNAL_ERROR',
    message:
      typeof candidate.message === 'string'
        ? candidate.message
        : `The request failed with status ${response.status}.`,
    details: asErrorDetails(candidate.details),
    ...(typeof candidate.hint === 'string' ? { hint: candidate.hint } : {}),
    requestId:
      headerRequestId ??
      (typeof candidate.requestId === 'string' ? candidate.requestId : 'unavailable'),
  };

  return new ApiClientError(response.status, apiError);
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });

  if (!response.ok) throw await readError(response);

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiClientError(response.status, {
      code: 'INTERNAL_ERROR',
      message: 'The Runtime returned an unreadable response.',
      details: {},
      requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
    });
  }
}
