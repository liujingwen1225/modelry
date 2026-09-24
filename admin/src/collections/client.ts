import { ApiClientError, type ApiError } from '../api/client';

export type CollectionType = 'Normal' | 'Auth';
export type FieldType = 'text' | 'number' | 'boolean' | 'dateTime' | 'json' | 'relation' | 'file';

export type RelationDefinition = { targetCollectionId: string; cardinality: string };

export type FieldDefinition = {
  id?: string;
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  description?: string;
  validation?: Record<string, unknown>;
  default?: unknown;
  relation?: RelationDefinition;
  system?: boolean;
};

export type Collection = {
  id: string;
  name: string;
  type: CollectionType;
  description?: string;
  fields: FieldDefinition[];
  indexes?: IndexDefinition[];
  schemaVersion?: number;
  createdAt?: string;
  updatedAt?: string;
};
export type CollectionSummary = Collection & {
  recordCount?: number;
  pendingChangeStatus?: 'ready' | 'needsReview' | 'failed';
};

export type IndexDefinition = { id?: string; name: string; fields: string[]; unique?: boolean };
export type CollectionCreateRequest = {
  name: string;
  type: CollectionType;
  description?: string;
  fields: FieldDefinition[];
  authentication?: AuthenticationConfiguration;
  accessRules?: Array<Record<string, unknown>>;
};
export type AuthenticationConfiguration = {
  emailPasswordEnabled: boolean;
  selfRegistration: boolean;
  sessionDurationDays: number;
};
export type Page<T> = { data: T[]; nextCursor?: string };
export type OperationKind = 'field' | 'relation' | 'index';
export type OperationAction = 'add' | 'update' | 'remove';
export type PendingOperationRequest = {
  kind: OperationKind;
  action: OperationAction;
  targetId?: string;
  definition: Record<string, unknown>;
};
export type PendingOperation = PendingOperationRequest & { id: string };
export type RecoveryState = { state: string; summary?: string; actions?: string[] };
export type PendingChange = {
  changeSetId: string;
  collectionId: string;
  version: number;
  status: 'ready' | 'needsReview' | 'failed';
  operations: PendingOperation[];
  recoveryState?: RecoveryState;
};
export type SchemaPreview = {
  risk: 'safe' | 'review' | 'blocked';
  diff: Array<Record<string, unknown>>;
  preconditions: Array<Record<string, unknown>>;
  impact: Record<string, unknown>;
  version?: number;
};
export type ApplyResult = {
  state: 'applied' | 'recoveryRequired';
  appliedMigrationId?: string;
  applyAttemptId?: string;
  recovery?: RecoveryState;
};
export type AppliedMigration = {
  id: string;
  changeSetId: string;
  collectionId?: string;
  applyAttemptId: string;
  appliedAt: string;
  diff?: Array<Record<string, unknown>>;
};
export type ChangeDetail = {
  changeSetId: string;
  collectionId: string;
  status: 'ready' | 'needsReview' | 'failed' | 'applied' | 'discarded';
  version: number;
  operations?: PendingOperation[];
  applyAttempts: Array<Record<string, unknown>>;
  appliedMigration?: AppliedMigration;
  recoveryState?: RecoveryState;
};
export type ChangeListItem = PendingChange | AppliedMigration;

export type CollectionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  [fieldName: string]: unknown;
};
export type RecordListOptions = {
  limit?: number;
  cursor?: string;
  search?: string;
  filter?: string;
  sort?: string;
};
export type AccessRuleMode = 'noAccess' | 'anyone' | 'signedInUsers' | 'recordOwner' | 'custom';
export type AccessOperation = 'list' | 'view' | 'create' | 'update' | 'delete';
export type AccessPredicate = { fieldId: string; operator: 'eq' | 'neq' | 'in'; value: unknown };
export type AccessExpression = { version: 1; all: AccessPredicate[] };
export type AccessRule = {
  operation: AccessOperation;
  mode: AccessRuleMode;
  ownerFieldId?: string;
  expression?: AccessExpression;
};
export type AccessRulesState = { applied: AccessRule[]; pending: AccessRule[]; version: number };
export type AccessRuleApplyResult = AccessRulesState & { state?: 'applied' | 'recoveryRequired' };
export type UploadedCollectionFile = { temporaryId: string; contentType: string; size: number };
export type AuthenticationConfigurationState = { applied: AuthenticationConfiguration; pending: AuthenticationConfiguration; version: number };
export type ApplicationUser = { recordId: string; email: string };
export type ApplicationSession = { id: string; createdAt: string; expiresAt: string; status: 'active' | 'revoked' | 'expired'; lastUsedAt?: string };

type JsonResponse = { data: unknown; response: Response };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const details = isRecord(envelope.details) ? envelope.details : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: typeof envelope.message === 'string' ? envelope.message : `The request failed with status ${response.status}.`,
    details,
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId: response.headers.get('X-Request-Id') ?? (typeof envelope.requestId === 'string' ? envelope.requestId : 'unavailable'),
  };
  return new ApiClientError(response.status, apiError);
}

async function readResponse(response: Response): Promise<JsonResponse> {
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    throw errorFrom(body, response);
  }
  if (response.status === 204) return { data: undefined, response };
  try {
    return { data: await response.json(), response };
  } catch {
    throw new ApiClientError(response.status, {
      code: 'INTERNAL_ERROR',
      message: 'The Runtime returned an unreadable Collections response.',
      details: {},
      requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
    });
  }
}

async function request(path: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    credentials: 'include',
    mode: 'same-origin',
    cache: 'no-store',
  });
  return readResponse(response);
}

function unwrap<T>(response: JsonResponse): T {
  if (!isRecord(response.data) || !('data' in response.data)) {
    throw new ApiClientError(response.response.status, {
      code: 'INTERNAL_ERROR',
      message: 'The Runtime returned an invalid Collections response.',
      details: { expected: 'data envelope' },
      requestId: response.response.headers.get('X-Request-Id') ?? 'unavailable',
    });
  }
  return response.data.data as T;
}

function query(options: { limit?: number; cursor?: string } = {}) {
  const search = new URLSearchParams();
  if (options.limit) search.set('limit', String(options.limit));
  if (options.cursor) search.set('cursor', options.cursor);
  return search.size ? `?${search.toString()}` : '';
}

function recordQuery(options: RecordListOptions) {
  const search = new URLSearchParams();
  if (options.limit) search.set('limit', String(options.limit));
  if (options.cursor) search.set('cursor', options.cursor);
  if (options.search?.trim()) search.set('search', options.search.trim());
  if (options.filter?.trim()) search.set('filter', options.filter.trim());
  if (options.sort?.trim()) search.set('sort', options.sort.trim());
  return search.size ? `?${search.toString()}` : '';
}

export async function listRecords(collectionId: string, options: RecordListOptions = {}, signal?: AbortSignal): Promise<Page<CollectionRecord>> {
  const { data, response } = await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records${recordQuery({ limit: 50, ...options })}`, { method: 'GET', signal });
  if (!isRecord(data) || !Array.isArray(data.data)) {
    throw errorFrom({ error: { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid Record list.' } }, response);
  }
  return { data: data.data as CollectionRecord[], ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}) };
}

export async function getRecord(collectionId: string, recordId: string, signal?: AbortSignal): Promise<CollectionRecord> {
  return unwrap<CollectionRecord>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records/${encodeURIComponent(recordId)}`, { method: 'GET', signal }));
}

export async function createRecord(collectionId: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<CollectionRecord> {
  return unwrap<CollectionRecord>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, { method: 'POST', body: JSON.stringify({ values }), signal }));
}

export async function createApplicationUser(collectionId: string, profile: Record<string, unknown>, password: string, signal?: AbortSignal): Promise<CollectionRecord> {
  return unwrap<CollectionRecord>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/users`, { method: 'POST', body: JSON.stringify({ profile, password }), signal }));
}

export async function updateRecord(collectionId: string, recordId: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<CollectionRecord> {
  return unwrap<CollectionRecord>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify({ values }), signal }));
}

export async function deleteRecord(collectionId: string, recordId: string, signal?: AbortSignal): Promise<void> {
  await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records/${encodeURIComponent(recordId)}`, { method: 'DELETE', signal });
}

export async function uploadCollectionFile(collectionId: string, fieldName: string, file: Blob, signal?: AbortSignal): Promise<UploadedCollectionFile> {
  const path = `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/files?fieldName=${encodeURIComponent(fieldName)}`;
  const response = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
    body: file,
    credentials: 'include',
    mode: 'same-origin',
    cache: 'no-store',
    signal,
  });
  return unwrap<UploadedCollectionFile>(await readResponse(response));
}

export async function downloadRecordFile(collectionId: string, recordId: string, fieldName: string, signal?: AbortSignal): Promise<Blob> {
  const path = `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records/${encodeURIComponent(recordId)}/files/${encodeURIComponent(fieldName)}`;
  const response = await fetch(path, { method: 'GET', credentials: 'include', mode: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) await readResponse(response);
  return response.blob();
}

export async function getAccessRules(collectionId: string, signal?: AbortSignal): Promise<AccessRulesState> {
  return unwrap<AccessRulesState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/access-rules`, { method: 'GET', signal }));
}

export async function saveAccessRules(collectionId: string, expectedVersion: number, rules: AccessRule[], signal?: AbortSignal): Promise<AccessRulesState> {
  return unwrap<AccessRulesState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/access-rules`, { method: 'PUT', body: JSON.stringify({ expectedVersion, rules }), signal }));
}

export async function applyAccessRules(collectionId: string, expectedVersion: number, signal?: AbortSignal): Promise<AccessRuleApplyResult> {
  return unwrap<AccessRuleApplyResult>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/access-rules/apply`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }));
}

export async function discardAccessRules(collectionId: string, expectedVersion: number, signal?: AbortSignal): Promise<AccessRulesState> {
  return unwrap<AccessRulesState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/access-rules/discard`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }));
}

export async function getAuthenticationConfiguration(collectionId: string, signal?: AbortSignal): Promise<AuthenticationConfigurationState> {
  return unwrap<AuthenticationConfigurationState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/authentication`, { method: 'GET', signal }));
}

export async function saveAuthenticationConfiguration(collectionId: string, expectedVersion: number, configuration: AuthenticationConfiguration, signal?: AbortSignal): Promise<AuthenticationConfigurationState> {
  return unwrap<AuthenticationConfigurationState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/authentication`, { method: 'PUT', body: JSON.stringify({ expectedVersion, configuration }), signal }));
}

export async function applyAuthenticationConfiguration(collectionId: string, expectedVersion: number, signal?: AbortSignal): Promise<AuthenticationConfigurationState> {
  return unwrap<AuthenticationConfigurationState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/authentication/apply`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }));
}

export async function discardAuthenticationConfiguration(collectionId: string, expectedVersion: number, signal?: AbortSignal): Promise<AuthenticationConfigurationState> {
  return unwrap<AuthenticationConfigurationState>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/authentication/discard`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }));
}

export async function listApplicationUsers(collectionId: string, options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<ApplicationUser>> {
  const { data, response } = await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/users${query({ limit: options.limit ?? 50, cursor: options.cursor })}`, { method: 'GET', signal });
  if (!isRecord(data) || !Array.isArray(data.data)) throw errorFrom({ error: { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid App User list.' } }, response);
  return { data: data.data as ApplicationUser[], ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}) };
}

export async function getApplicationUserSessions(collectionId: string, recordId: string, signal?: AbortSignal): Promise<ApplicationSession[]> {
  return unwrap<ApplicationSession[]>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/users/${encodeURIComponent(recordId)}/sessions`, { method: 'GET', signal }));
}

export async function setApplicationUserPassword(collectionId: string, recordId: string, password: string, signal?: AbortSignal): Promise<void> {
  await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/users/${encodeURIComponent(recordId)}/password`, { method: 'PUT', body: JSON.stringify({ password }), signal });
}

export async function revokeApplicationUserSession(collectionId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST', signal });
}

export async function revokeAllApplicationUserSessions(collectionId: string, recordId: string, signal?: AbortSignal): Promise<void> {
  await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/users/${encodeURIComponent(recordId)}/sessions/revoke-all`, { method: 'POST', signal });
}

export async function listCollections(options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<CollectionSummary>> {
  const { data, response } = await request(`/admin/api/v1/collections${query({ limit: options.limit ?? 100, cursor: options.cursor })}`, { method: 'GET', signal });
  if (!isRecord(data) || !Array.isArray(data.data)) {
    throw errorFrom({ error: { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid Collection list.' } }, response);
  }
  return { data: data.data as CollectionSummary[], ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}) };
}

export async function listAllCollections(signal?: AbortSignal): Promise<CollectionSummary[]> {
  const items: CollectionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await listCollections({ limit: 100, cursor }, signal);
    items.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export async function createCollection(input: CollectionCreateRequest, signal?: AbortSignal): Promise<Collection> {
  return unwrap<Collection>(await request('/admin/api/v1/collections', { method: 'POST', body: JSON.stringify(input), signal }));
}

export async function getCollection(collectionId: string, signal?: AbortSignal): Promise<Collection> {
  return unwrap<Collection>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}`, { method: 'GET', signal }));
}

export async function getPendingChange(collectionId: string, signal?: AbortSignal): Promise<PendingChange | null> {
  return unwrap<PendingChange | null>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/pending-change`, { method: 'GET', signal }));
}

export async function savePendingOperation(collectionId: string, input: PendingOperationRequest, signal?: AbortSignal): Promise<PendingChange> {
  return unwrap<PendingChange>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/pending-operations`, { method: 'POST', body: JSON.stringify(input), signal }));
}

export async function updatePendingOperation(collectionId: string, operationId: string, input: PendingOperationRequest, signal?: AbortSignal): Promise<PendingChange> {
  return unwrap<PendingChange>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/pending-operations/${encodeURIComponent(operationId)}`, { method: 'PATCH', body: JSON.stringify(input), signal }));
}

export async function removePendingOperation(collectionId: string, operationId: string, signal?: AbortSignal): Promise<void> {
  await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/pending-operations/${encodeURIComponent(operationId)}`, { method: 'DELETE', signal });
}

export async function previewSchemaChange(collectionId: string, expectedVersion: number, signal?: AbortSignal): Promise<SchemaPreview> {
  return unwrap<SchemaPreview>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/preview`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }));
}

export async function applySchemaChange(collectionId: string, expectedVersion: number, confirmRisk: boolean, signal?: AbortSignal): Promise<ApplyResult> {
  return unwrap<ApplyResult>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/apply`, { method: 'POST', body: JSON.stringify({ expectedVersion, confirmRisk }), signal }));
}

export async function discardSchemaChange(collectionId: string, expectedVersion: number, signal?: AbortSignal): Promise<PendingChange> {
  return unwrap<PendingChange>(await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/discard`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }));
}

export async function listSchemaHistory(collectionId: string, options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<AppliedMigration>> {
  const { data, response } = await request(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/schema/history${query({ limit: options.limit ?? 100, cursor: options.cursor })}`, { method: 'GET', signal });
  if (!isRecord(data) || !Array.isArray(data.data)) throw errorFrom({ error: { code: 'INTERNAL_ERROR', message: 'The Runtime returned invalid applied history.' } }, response);
  return { data: data.data as AppliedMigration[], ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}) };
}

export async function listChanges(options: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Page<ChangeListItem>> {
  const { data, response } = await request(`/admin/api/v1/changes${query({ limit: options.limit ?? 100, cursor: options.cursor })}`, { method: 'GET', signal });
  if (!isRecord(data) || !Array.isArray(data.data)) throw errorFrom({ error: { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid Changes list.' } }, response);
  return { data: data.data as ChangeListItem[], ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}) };
}

export async function listAllChanges(signal?: AbortSignal): Promise<ChangeListItem[]> {
  const items: ChangeListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listChanges({ limit: 100, cursor }, signal);
    items.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export async function getChange(changeSetId: string, signal?: AbortSignal): Promise<ChangeDetail> {
  return unwrap<ChangeDetail>(await request(`/admin/api/v1/changes/${encodeURIComponent(changeSetId)}`, { method: 'GET', signal }));
}
