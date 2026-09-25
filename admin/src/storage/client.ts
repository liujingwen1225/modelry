import { ApiClientError, getJson, type ApiError } from '../api/client';

export type ProviderKind = 'local' | 's3';
export type StorageHealthState = 'ready' | 'degraded' | 'unavailable' | 'unknown';
export type MigrationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type SecretReference = { secretId: string; name: string; configured: boolean };
export type LocalConfiguration = { path: string };
export type S3Configuration = {
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  pathStyle: boolean;
  configured: boolean;
  accessKey?: SecretReference;
  secretKey?: SecretReference;
  sessionToken?: SecretReference;
};
export type FileStorageConfiguration = { provider: ProviderKind; local: LocalConfiguration; s3?: S3Configuration | null };
export type FileStorageHealth = { state: StorageHealthState; message?: string; hint?: string; observedAt: string; referencedObjects: number };
export type FileMigration = {
  id: string;
  sourceProvider: ProviderKind;
  targetProvider: ProviderKind;
  status: MigrationStatus;
  totalObjects: number;
  copiedObjects: number;
  startedAt: string;
  finishedAt?: string | null;
  errorCode?: string;
  message?: string;
  targetEndpointHost?: string;
  targetBucket?: string;
  targetKeyPrefix?: string;
};
export type FileStorageStatus = {
  activeProvider: ProviderKind;
  provider: string;
  revision: number;
  providerState: StorageHealthState;
  providerMessage?: string;
  providerHint?: string;
  configuration: FileStorageConfiguration;
  health: FileStorageHealth;
  migration: { active: boolean; latest?: FileMigration | null };
};
export type S3Input = {
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix?: string;
  pathStyle?: boolean;
  accessKeySecretId: string;
  secretKeySecretId: string;
  sessionTokenSecretId?: string;
};
export type ProviderInput = { expectedRevision: number; provider: ProviderKind; s3?: S3Input };
export type ProviderTestResult = { state: 'ready' | 'unavailable'; message: string; hint?: string; endpointHost?: string; bucket?: string };
export type MigrationInput = { targetProvider: ProviderKind; s3?: S3Input };
export type SecretOption = { id: string; name: string; configured: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(envelope.code) ? envelope.code : 'INTERNAL_ERROR',
    message: 'The File Storage request could not be completed.',
    details: {},
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

function unwrap<T>(value: unknown): T {
  if (isRecord(value) && 'data' in value) return value.data as T;
  throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable response.', details: {}, requestId: 'unavailable' });
}

export async function fetchFileStorage(signal?: AbortSignal): Promise<FileStorageStatus> {
  return unwrap<FileStorageStatus>(await getJson('/admin/api/v1/storage/files', signal));
}

export async function saveFileStorageProvider(input: ProviderInput, signal?: AbortSignal): Promise<FileStorageStatus> {
  return unwrap<FileStorageStatus>(await request('/admin/api/v1/storage/files/provider', { method: 'PUT', body: JSON.stringify(input), signal }));
}

export async function testFileStorageProvider(input: S3Input, signal?: AbortSignal): Promise<ProviderTestResult> {
  return unwrap<ProviderTestResult>(await request('/admin/api/v1/storage/files/provider/test', { method: 'POST', body: JSON.stringify({ s3: input }), signal }));
}

export async function startFileMigration(input: MigrationInput, signal?: AbortSignal): Promise<FileMigration> {
  return unwrap<FileMigration>(await request('/admin/api/v1/storage/files/migrations', { method: 'POST', body: JSON.stringify(input), signal }));
}

export async function cancelFileMigration(migrationId: string, signal?: AbortSignal): Promise<FileMigration> {
  const path = '/admin/api/v1/storage/files/migrations/' + encodeURIComponent(migrationId) + '/cancel';
  return unwrap<FileMigration>(await request(path, { method: 'POST', signal }));
}

export async function listFileMigrations(signal?: AbortSignal): Promise<FileMigration[]> {
  const value = await request('/admin/api/v1/storage/files/migrations', { signal });
  return isRecord(value) && Array.isArray(value.data) ? (value.data as FileMigration[]) : [];
}

export async function listStorageSecretOptions(signal?: AbortSignal): Promise<SecretOption[]> {
  const value = await request('/admin/api/v1/secrets', { signal });
  const items = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  return items.filter(isRecord).flatMap((item) =>
    typeof item.id === 'string' && typeof item.name === 'string'
      ? [{ id: item.id, name: item.name, configured: item.configured === true }]
      : [],
  );
}
