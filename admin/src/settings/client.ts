import { ApiClientError, getJson, type ApiError } from '../api/client';

export type RuntimeSettingSource = 'flag' | 'project' | 'default';

export type RuntimeSetting = {
  value: string;
  source: RuntimeSettingSource;
  restartRequired: boolean;
  bounds: string;
};

export type RuntimeSettings = {
  listenAddress: RuntimeSetting;
  requestRetentionDays: RuntimeSetting;
  revision: number;
  updatedAt: string;
};

export type RuntimeSettingsInput = {
  expectedRevision: number;
  listenAddress: string;
  requestRetentionDays: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Runtime Settings request could not be completed.',
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

function unwrap(value: unknown): RuntimeSettings {
  if (isRecord(value) && isRecord(value.data)) return value.data as RuntimeSettings;
  throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned unreadable Runtime Settings.', details: {}, requestId: 'unavailable' });
}

export async function fetchRuntimeSettings(signal?: AbortSignal): Promise<RuntimeSettings> {
  return unwrap(await getJson('/admin/api/v1/settings', signal));
}

export async function saveRuntimeSettings(input: RuntimeSettingsInput): Promise<RuntimeSettings> {
  return unwrap(await request('/admin/api/v1/settings', { method: 'PUT', body: JSON.stringify(input) }));
}