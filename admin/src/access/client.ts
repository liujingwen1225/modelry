import { ApiClientError, type ApiError, getJson } from '../api/client';

export type PermissionPreset = 'fullAccess' | 'readOnly' | 'custom';
export type ServiceAccountStatus = 'active' | 'disabled';
export type APIKeyStatus = 'active' | 'revoked';
export type CustomPermissionOperation =
  | 'runtime.read' | 'storage.read'
  | 'collections.read' | 'collections.create'
  | 'records.read' | 'records.create' | 'records.update' | 'records.delete'
  | 'files.read' | 'files.write'
  | 'schema.read' | 'schema.write' | 'schema.apply'
  | 'accessRules.read' | 'accessRules.write' | 'accessRules.apply'
  | 'authentication.read' | 'authentication.write' | 'authentication.apply'
  | 'users.read' | 'users.create' | 'users.managePassword'
  | 'sessions.read' | 'sessions.revoke'
  | 'serviceAccounts.read' | 'serviceAccounts.manage'
  | 'apiKeys.read' | 'apiKeys.create' | 'apiKeys.revoke'
  | 'requests.read' | 'audit.read';

export type ServiceAccount = {
  id: string;
  name: string;
  description?: string;
  permission: PermissionPreset;
  status: ServiceAccountStatus;
  createdAt?: string;
  lastUsedAt?: string;
  customPermissionVersion?: 1;
  customOperations?: CustomPermissionOperation[];
};
export type APIKey = { id: string; name: string; status: APIKeyStatus; createdAt: string; expiresAt?: string; lastUsedAt?: string };
export type APIKeyReveal = { apiKey: APIKey; secret: string; revealedOnce: true };
export type ServiceAccountPage = { data: ServiceAccount[]; nextCursor?: string };
export type APIKeyPage = { data: APIKey[] };
export type AuditRecord = {
  id: string;
  requestId?: string;
  time: string;
  actor: { kind: 'owner' | 'serviceAccount'; id: string };
  action: string;
  resource: Record<string, unknown>;
  result: string;
};
export type AuditPage = { data: AuditRecord[]; nextCursor?: string };
export type ServiceAccountDraft = {
  name: string;
  description?: string;
  permission: PermissionPreset;
  createAPIKey?: boolean;
  customPermissionVersion?: 1;
  customOperations?: CustomPermissionOperation[];
};
export type ServiceAccountCreateResult = { serviceAccount: ServiceAccount; apiKeyReveal?: APIKeyReveal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /password|token|secret|credential|api.?key|authorization|cookie/i.test(key) ? '[redacted]' : redact(child)]));
}

function query(limit: number, cursor?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return `?${params.toString()}`;
}

function requestError(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const details = isRecord(envelope.details) ? redact(envelope.details) as Record<string, unknown> : {};
  const error: ApiError = {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: typeof envelope.message === 'string' ? envelope.message : `The request failed with status ${response.status}.`,
    details,
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId: response.headers.get('X-Request-Id') ?? (typeof envelope.requestId === 'string' ? envelope.requestId : 'unavailable'),
  };
  return new ApiClientError(response.status, error);
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
  });
  if (response.status === 204) {
    if (!response.ok) throw requestError(undefined, response);
    return undefined;
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { value = undefined; }
  if (!response.ok) throw requestError(value, response);
  if (value === undefined) throw new ApiClientError(response.status, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable response.', details: {}, requestId: response.headers.get('X-Request-Id') ?? 'unavailable' });
  return value;
}

function unwrapData<T>(value: unknown, description: string): T {
  if (!isRecord(value) || !('data' in value)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: `The Runtime returned an invalid ${description} response.`, details: {}, requestId: 'unavailable' });
  return value.data as T;
}

export async function listServiceAccounts(options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<ServiceAccountPage> {
  const value = await getJson<unknown>(`/admin/api/v1/service-accounts${query(options.limit ?? 50, options.cursor)}`, signal);
  if (!isRecord(value) || !Array.isArray(value.data)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid Service Account list response.', details: {}, requestId: 'unavailable' });
  return { data: value.data as ServiceAccount[], ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) };
}

export async function getServiceAccount(id: string, signal?: AbortSignal): Promise<ServiceAccount> {
  return unwrapData<ServiceAccount>(await getJson<unknown>(`/admin/api/v1/service-accounts/${encodeURIComponent(id)}`, signal), 'Service Account');
}

export async function createServiceAccount(draft: ServiceAccountDraft, signal?: AbortSignal): Promise<ServiceAccountCreateResult> {
  return unwrapData<ServiceAccountCreateResult>(await request('/admin/api/v1/service-accounts', { method: 'POST', body: JSON.stringify(draft), signal }), 'Service Account creation');
}

export async function updateServiceAccount(id: string, draft: Partial<ServiceAccountDraft>, signal?: AbortSignal): Promise<ServiceAccount> {
  return unwrapData<ServiceAccount>(await request(`/admin/api/v1/service-accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(draft), signal }), 'Service Account');
}

export async function setServiceAccountEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const action = enabled ? 'enable' : 'disable';
  await request(`/admin/api/v1/service-accounts/${encodeURIComponent(id)}/${action}`, { method: 'POST', signal });
}

export async function listAPIKeys(serviceAccountId: string, signal?: AbortSignal): Promise<APIKeyPage> {
  const value = await getJson<unknown>(`/admin/api/v1/service-accounts/${encodeURIComponent(serviceAccountId)}/api-keys`, signal);
  const data = unwrapData<APIKey[]>(value, 'API Key list');
  if (!Array.isArray(data)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid API Key list response.', details: {}, requestId: 'unavailable' });
  return { data };
}

export async function createAPIKey(serviceAccountId: string, name?: string, signal?: AbortSignal): Promise<APIKeyReveal> {
  const value = await request(`/admin/api/v1/service-accounts/${encodeURIComponent(serviceAccountId)}/api-keys`, { method: 'POST', body: JSON.stringify(name ? { name } : {}), signal });
  return unwrapData<APIKeyReveal>(value, 'API Key creation');
}

export async function revokeAPIKey(apiKeyId: string, signal?: AbortSignal): Promise<void> {
  await request(`/admin/api/v1/api-keys/${encodeURIComponent(apiKeyId)}/revoke`, { method: 'POST', signal });
}

export type AuditQuery = { limit?: number; cursor?: string; search?: string; actorKind?: string; actorId?: string; action?: string; resourceKind?: string; resourceId?: string; from?: string; to?: string };

function auditQuery(options: AuditQuery) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  for (const key of ['cursor', 'search', 'actorKind', 'actorId', 'action', 'resourceKind', 'resourceId', 'from', 'to'] as const) {
    const value = options[key];
    if (value) params.set(key, value);
  }
  return `?${params.toString()}`;
}

export async function listAuditRecords(options: AuditQuery = {}, signal?: AbortSignal): Promise<AuditPage> {
  const value = await getJson<unknown>(`/admin/api/v1/audit${auditQuery(options)}`, signal);
  if (!isRecord(value) || !Array.isArray(value.data)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid Audit list response.', details: {}, requestId: 'unavailable' });
  return { data: value.data as AuditRecord[], ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) };
}

export async function getAuditRecord(id: string, signal?: AbortSignal): Promise<AuditRecord> {
  return unwrapData<AuditRecord>(await getJson<unknown>(`/admin/api/v1/audit/${encodeURIComponent(id)}`, signal), 'Audit detail');
}
