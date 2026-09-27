import { ApiClientError, getJson, type ApiError } from '../api/client';

export type ActivityKind =
  | 'change.applied' | 'change.pending' | 'change.failed'
  | 'webhook.delivery' | 'job.run' | 'extension.run'
  | 'mail.delivery' | 'storage.migration' | 'auth.recovery';

export type ActivityFact = {
  id: string;
  kind: ActivityKind;
  status: string;
  occurredAt: string;
  resourceKind: string;
  resourceId: string;
  collectionId?: string;
  title?: string;
  deepLink: string;
};

export type ActivityPage = { data: ActivityFact[]; nextCursor?: string };

export type ActivityQuery = { limit?: number; cursor?: string; kinds?: string[]; collectionId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Activity request could not be completed.',
    details: isRecord(envelope.details) ? (envelope.details as Record<string, unknown>) : {},
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  };
  return new ApiClientError(response.status, apiError);
}

export async function listActivity(query: ActivityQuery = {}, signal?: AbortSignal): Promise<ActivityPage> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.cursor) search.set('cursor', query.cursor);
  if (query.collectionId) search.set('collectionId', query.collectionId);
  if (query.kinds && query.kinds.length > 0) search.set('kinds', query.kinds.join(','));
  const suffix = search.toString();
  const path = '/admin/api/v1/activity' + (suffix ? '?' + suffix : '');
  try {
    const value = await getJson<ActivityPage>(path, signal);
    if (!isRecord(value) || !Array.isArray(value.data)) {
      return { data: [] };
    }
    return value as ActivityPage;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw errorFrom(undefined, new Response(null, { status: 0 }));
  }
}