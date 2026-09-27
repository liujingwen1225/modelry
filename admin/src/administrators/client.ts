import { ApiClientError, getJson, type ApiError } from '../api/client';

export type PermissionPreset = 'fullAccess' | 'readOnly' | 'custom';
export type AdministratorPermission = {
  preset: PermissionPreset;
  customPermissionVersion?: number;
  customOperations?: string[];
};
export type AdministratorStatus = 'active' | 'disabled';
export type Administrator = {
  id: string;
  email: string;
  status: AdministratorStatus;
  permission: AdministratorPermission;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string | null;
};
export type AdministratorSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  status: 'active' | 'revoked' | 'expired';
  current: boolean;
};
export type AdministratorCreateInput = { email: string; password: string; permission: AdministratorPermission };
export type AdministratorUpdateInput = { email?: string; permission?: AdministratorPermission };

export const administratorOperations = [
  'runtime.read', 'storage.read', 'collections.read', 'collections.create',
  'records.read', 'records.create', 'records.update', 'records.delete',
  'files.read', 'files.write', 'schema.read', 'schema.write', 'schema.apply',
  'accessRules.read', 'accessRules.write', 'accessRules.apply',
  'authentication.read', 'authentication.write', 'authentication.apply',
  'users.read', 'users.create', 'users.managePassword', 'sessions.read', 'sessions.revoke',
  'serviceAccounts.read', 'serviceAccounts.manage', 'apiKeys.read', 'apiKeys.create', 'apiKeys.revoke',
  'requests.read', 'audit.read', 'administrators.read', 'mail.read',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(envelope.code) ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Administrators request could not be completed.',
    details: isRecord(envelope.details) ? (envelope.details as Record<string, unknown>) : {},
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
  if (response.status === 204) return undefined;
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) throw errorFrom(payload, response);
  return payload;
}

function unwrap<T>(value: unknown): T {
  if (isRecord(value) && 'data' in value) return value.data as T;
  throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable response.', details: {}, requestId: 'unavailable' });
}

export async function listAdministrators(signal?: AbortSignal): Promise<Administrator[]> {
  const value = await getJson('/admin/api/v1/administrators', signal);
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data as Administrator[];
}

export async function createAdministrator(input: AdministratorCreateInput): Promise<Administrator> {
  return unwrap<Administrator>(await request('/admin/api/v1/administrators', { method: 'POST', body: JSON.stringify(input) }));
}

export async function updateAdministrator(administratorId: string, input: AdministratorUpdateInput): Promise<Administrator> {
  const path = '/admin/api/v1/administrators/' + encodeURIComponent(administratorId);
  return unwrap<Administrator>(await request(path, { method: 'PATCH', body: JSON.stringify(input) }));
}

export async function deleteAdministrator(administratorId: string): Promise<void> {
  const path = '/admin/api/v1/administrators/' + encodeURIComponent(administratorId);
  await request(path, { method: 'DELETE' });
}

export async function setAdministratorEnabled(administratorId: string, enabled: boolean): Promise<Administrator> {
  const suffix = enabled ? '/enable' : '/disable';
  const path = '/admin/api/v1/administrators/' + encodeURIComponent(administratorId) + suffix;
  return unwrap<Administrator>(await request(path, { method: 'POST' }));
}

export async function setAdministratorPassword(administratorId: string, password: string): Promise<void> {
  const path = '/admin/api/v1/administrators/' + encodeURIComponent(administratorId) + '/password';
  await request(path, { method: 'POST', body: JSON.stringify({ password }) });
}

export async function listAdministratorSessions(administratorId: string, signal?: AbortSignal): Promise<AdministratorSession[]> {
  const path = '/admin/api/v1/administrators/' + encodeURIComponent(administratorId) + '/sessions';
  const value = await request(path, { signal });
  return isRecord(value) && Array.isArray(value.data) ? (value.data as AdministratorSession[]) : [];
}

export async function revokeAdministratorSessions(administratorId: string): Promise<void> {
  const path = '/admin/api/v1/administrators/' + encodeURIComponent(administratorId) + '/sessions/revoke-all';
  await request(path, { method: 'POST' });
}
