import { ApiClientError, getJson, type ApiError } from '../api/client';

export type ApplicationAPIField = {
  id: string; name: string; type: string; required: boolean; unique: boolean;
  relationTargetCollectionId?: string; relationCardinality?: string;
};
export type ApplicationAPICollection = {
  id: string; name: string; type: 'Normal' | 'Auth'; schemaVersion: number;
  fields: ApplicationAPIField[]; endpoints: string[]; accessRules: Array<{ operation: string; mode: string }>;
};
export type ApplicationAPIContract = {
  version: string; contentHash: string; apiBasePath: string; collections: ApplicationAPICollection[];
};
export type DriftSeverity = 'info' | 'warning' | 'error';
export type BackupFinding = { code: string; severity: DriftSeverity; message: string };
export type BackupPreflight = {
  compatible: boolean; projectId?: string; runtimeVersion?: string; formatVersion?: number;
  createdAt?: string; appliedModelHash?: string;
  counts: { collections: number; records: number; objects: number };
  findings: BackupFinding[];
};
export type ImportResult = { index: number; status: 'created' | 'failed'; recordId?: string; code?: string };
export type ImportSummary = { created: number; failed: number; results: ImportResult[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Portability request could not be completed.',
    details: isRecord(envelope.details) ? (envelope.details as Record<string, unknown>) : {},
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  };
  return new ApiClientError(response.status, apiError);
}

async function readJSON(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

export async function fetchApplicationAPIContract(signal?: AbortSignal): Promise<ApplicationAPIContract> {
  const value = await getJson('/admin/api/v1/developer/contract', signal);
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable contract.', details: {}, requestId: 'unavailable' });
  }
  return value.data as ApplicationAPIContract;
}

// createBackup 返回 bundle 的 Blob 与建议文件名；Backup 由 Runtime 产生，不是文件复制。
export async function createBackup(): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch('/admin/api/v1/backup', { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw errorFrom(await readJSON(response), response);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), fileName: match?.[1] ?? 'modelry-backup.tar' };
}

export async function preflightRestoreBundle(file: File): Promise<BackupPreflight> {
  const response = await fetch('/admin/api/v1/restore/preflight', {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/x-tar' }, body: file,
  });
  const payload = await readJSON(response);
  if (!response.ok) throw errorFrom(payload, response);
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable preflight result.', details: {}, requestId: 'unavailable' });
  }
  return payload.data as BackupPreflight;
}

export async function exportCollection(collectionId: string): Promise<{ text: string; fileName: string }> {
  const response = await fetch('/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/export', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', headers: { Accept: 'application/x-ndjson' },
  });
  if (!response.ok) throw errorFrom(await readJSON(response), response);
  return { text: await response.text(), fileName: collectionId + '.ndjson' };
}

export async function importCollection(collectionId: string, ndjson: string): Promise<ImportSummary> {
  const response = await fetch('/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/import', {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/x-ndjson' }, body: ndjson,
  });
  const payload = await readJSON(response);
  if (!response.ok) throw errorFrom(payload, response);
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable import summary.', details: {}, requestId: 'unavailable' });
  }
  return payload.data as ImportSummary;
}