import { ApiClientError, type ErrorDetails } from '../api/client';

export type ExtensionLanguage = 'javascript' | 'typescript';
export type ExtensionOperation = 'create' | 'update' | 'delete';
export type ExtensionPhase = 'before' | 'afterCommit';
export type ExtensionRunStatus = 'pending' | 'running' | 'succeeded' | 'rejected' | 'failed' | 'interrupted' | 'cancelled';

export type ExtensionBinding = { collectionId: string; operation: ExtensionOperation; phase: ExtensionPhase };
export type ExtensionSecretBinding = { alias: string; secretId: string; secretName: string; configured: boolean };
export type ExtensionSummary = {
  id: string;
  name: string;
  language: ExtensionLanguage;
  activeRevision: number;
  enabled: boolean;
  bindingCount: number;
  secretBindingCount: number;
  originGrantCount: number;
  updatedAt: string;
};
export type ExtensionDetail = ExtensionSummary & {
  source: string;
  bindings: ExtensionBinding[];
  secretBindings: ExtensionSecretBinding[];
  allowedOrigins: string[];
  createdAt: string;
};
export type ExtensionDraft = {
  name: string;
  language: ExtensionLanguage;
  source: string;
  bindings: ExtensionBinding[];
  secretBindings: Array<{ alias: string; secretId: string }>;
  allowedOrigins: string[];
};
export type ExtensionRun = {
  runId: string;
  extensionId: string;
  revision: number;
  collectionId: string;
  recordId?: string;
  eventId?: string;
  operation: ExtensionOperation;
  phase: ExtensionPhase;
  status: ExtensionRunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  errorCode: string;
  correlationId?: string;
};
export type SecretMetadata = { id: string; name: string; configured: true; createdAt: string; updatedAt: string };
export type CollectionOption = { id: string; name: string; type?: string };
export type Page<T> = { data: T[]; nextCursor?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const validationCodes = new Set([
  'required', 'invalidName', 'unsupportedLanguage', 'invalidSource', 'invalidCollection',
  'invalidOperation', 'invalidPhase', 'duplicateBinding', 'invalidAlias', 'invalidSecretReference',
  'duplicateAlias', 'tooManyBindings', 'tooManyOrigins', 'invalidOrigin', 'duplicateOrigin', 'unsupportedOperation',
  'duplicateName', 'invalidSecretValue',
]);
const validationPath = /^\/(?:name|language|source|value|allowedOrigins(?:\/\d+)?|bindings(?:\/\d+(?:\/(?:collectionId|operation|phase))?)?|secretBindings\/\d+\/(?:alias|secretId))$/;

function safeErrorDetails(code: string, value: unknown): ErrorDetails {
  if (!record(value)) return {};
  if (code === 'BINDING_CONFLICT') {
    const collectionId = value.collectionId;
    const operation = value.operation;
    const phase = value.phase;
    if (typeof collectionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(collectionId) &&
      (operation === 'create' || operation === 'update' || operation === 'delete') &&
      (phase === 'before' || phase === 'afterCommit')) {
      return { collectionId, operation, phase };
    }
  }
  if (code === 'VALIDATION_FAILED' && Array.isArray(value.violations)) {
    const violations = value.violations.filter(record).flatMap((item) => {
      if (typeof item.path !== 'string' || !validationPath.test(item.path) ||
        typeof item.code !== 'string' || !validationCodes.has(item.code)) return [];
      return [{ path: item.path, code: item.code, message: 'Review this field.' }];
    });
    return violations.length ? { violations } : {};
  }
  return {};
}

function safeRequestError(value: unknown, response: Response): ApiClientError {
  const envelope = record(value) && record(value.error) ? value.error : {};
  return new ApiClientError(response.status, {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Extension request could not be completed.',
    details: safeErrorDetails(typeof envelope.code === 'string' ? envelope.code : '', envelope.details),
    requestId: response.headers.get('X-Request-Id') ?? (typeof envelope.requestId === 'string' ? envelope.requestId : 'unavailable'),
  });
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
    credentials: 'same-origin',
    mode: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 204) {
    if (!response.ok) throw safeRequestError(undefined, response);
    return undefined;
  }
  let value: unknown;
  try { value = await response.json(); } catch { value = undefined; }
  if (!response.ok) throw safeRequestError(value, response);
  if (value === undefined) throw new ApiClientError(response.status, {
    code: 'INTERNAL_ERROR', message: 'The Extension response could not be read.', details: {},
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  });
  return value;
}

function unwrap<T>(value: unknown): T {
  if (!record(value) || !('data' in value)) throw new ApiClientError(200, {
    code: 'INTERNAL_ERROR', message: 'The Extension response was invalid.', details: {}, requestId: 'unavailable',
  });
  return value.data as T;
}

function query(options: { cursor?: string; limit?: number } = {}) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor) params.set('cursor', options.cursor);
  return `?${params.toString()}`;
}

export async function listExtensions(signal?: AbortSignal): Promise<ExtensionSummary[]> {
  const value = await request('/admin/api/v1/extensions', { signal });
  if (!record(value) || !Array.isArray(value.data)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: 'The Extension list was invalid.', details: {}, requestId: 'unavailable' });
  return value.data as ExtensionSummary[];
}

export async function getExtension(id: string, signal?: AbortSignal): Promise<ExtensionDetail> {
  return unwrap<ExtensionDetail>(await request(`/admin/api/v1/extensions/${encodeURIComponent(id)}`, { signal }));
}

export async function createExtension(input: Pick<ExtensionDraft, 'name' | 'language' | 'source'>): Promise<ExtensionDetail> {
  return unwrap<ExtensionDetail>(await request('/admin/api/v1/extensions', { method: 'POST', body: JSON.stringify(input) }));
}

export async function replaceExtension(id: string, input: ExtensionDraft): Promise<ExtensionDetail> {
  return unwrap<ExtensionDetail>(await request(`/admin/api/v1/extensions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }));
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  const action = enabled ? 'enable' : 'disable';
  return unwrap<{ id: string; enabled: boolean }>(await request(`/admin/api/v1/extensions/${encodeURIComponent(id)}/${action}`, { method: 'POST' }));
}

export async function listExtensionRuns(id: string, options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<ExtensionRun>> {
  const value = await request(`/admin/api/v1/extensions/${encodeURIComponent(id)}/runs${query(options)}`, { signal });
  if (!record(value) || !Array.isArray(value.data)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: 'The Hook Run list was invalid.', details: {}, requestId: 'unavailable' });
  return { data: value.data as ExtensionRun[], ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) };
}

export async function getExtensionRun(extensionId: string, runId: string, signal?: AbortSignal): Promise<ExtensionRun> {
  return unwrap<ExtensionRun>(await request(`/admin/api/v1/extensions/${encodeURIComponent(extensionId)}/runs/${encodeURIComponent(runId)}`, { signal }));
}

export async function listSecrets(signal?: AbortSignal): Promise<SecretMetadata[]> {
  const value = await request('/admin/api/v1/secrets', { signal });
  if (!record(value) || !Array.isArray(value.data)) throw new ApiClientError(200, { code: 'INTERNAL_ERROR', message: 'The Secret list was invalid.', details: {}, requestId: 'unavailable' });
  return value.data as SecretMetadata[];
}

export async function createSecret(name: string, value: string): Promise<SecretMetadata> {
  return unwrap<SecretMetadata>(await request('/admin/api/v1/secrets', { method: 'POST', body: JSON.stringify({ name, value }) }));
}

export async function renameSecret(id: string, name: string): Promise<SecretMetadata> {
  return unwrap<SecretMetadata>(await request(`/admin/api/v1/secrets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
}

export async function replaceSecretValue(id: string, value: string): Promise<SecretMetadata> {
  return unwrap<SecretMetadata>(await request(`/admin/api/v1/secrets/${encodeURIComponent(id)}/value`, { method: 'PUT', body: JSON.stringify({ value }) }));
}

export async function deleteSecret(id: string): Promise<void> {
  await request(`/admin/api/v1/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
