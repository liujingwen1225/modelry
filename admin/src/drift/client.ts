import { ApiClientError, getJson, type ApiError } from '../api/client';

export type DriftClass = 'appliedModel' | 'physicalProjection' | 'runtimeState';
export type DriftSeverity = 'info' | 'warning' | 'error';
export type DriftRemedy = 'none' | 'manual' | 'reconcile';

export type DriftFinding = {
  id: string;
  class: DriftClass;
  severity: DriftSeverity;
  code: string;
  collectionId?: string;
  collectionName?: string;
  expected: string;
  actual: string;
  expectedPendingChange: boolean;
  remedy: DriftRemedy;
  deepLink: string;
  detectedAt: string;
};

export type DriftReport = { state: 'healthy' | 'attention' | 'degraded'; findings: DriftFinding[]; detectedAt: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Drift request could not be completed.',
    details: isRecord(envelope.details) ? (envelope.details as Record<string, unknown>) : {},
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  };
  return new ApiClientError(response.status, apiError);
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiClientError(0, { code: 'NETWORK_ERROR', message: 'The Runtime could not be reached.', details: {}, requestId: 'unavailable' });
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) throw errorFrom(payload, response);
  return payload;
}

function unwrap(value: unknown): DriftReport {
  if (isRecord(value) && isRecord(value.data)) return value.data as DriftReport;
  throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable Drift report.', details: {}, requestId: 'unavailable' });
}

export async function fetchDriftReport(collectionId?: string, signal?: AbortSignal): Promise<DriftReport> {
  const path = '/admin/api/v1/drift' + (collectionId ? '?collectionId=' + encodeURIComponent(collectionId) : '');
  return unwrap(await getJson(path, signal));
}

export async function reconcileCollectionProjection(collectionId: string): Promise<DriftReport> {
  return unwrap(await request('/admin/api/v1/drift/reconcile', { method: 'POST', body: JSON.stringify({ collectionId }) }));
}