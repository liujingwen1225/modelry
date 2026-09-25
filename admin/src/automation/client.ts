import { ApiClientError, type ErrorDetails } from '../api/client';

export type WebhookSummary = {
  id: string;
  name: string;
  targetUrl: string;
  signingSecretId: string;
  signingSecretName: string;
  signingConfigured: boolean;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type WebhookInput = Pick<WebhookSummary, 'name' | 'targetUrl' | 'signingSecretId'>;
export type EventType = 'record.created' | 'record.updated' | 'record.deleted';
export type EventHookInput = { name: string; collectionId: string; eventType: EventType; webhookId: string };
export type EventHookSummary = EventHookInput & {
  id: string; collectionName: string; webhookName: string; enabled: boolean; createdAt: string; updatedAt: string;
};
export type JobInput = { name: string; webhookId: string; cron: string };
export type JobSummary = JobInput & {
  id: string; webhookName: string; enabled: boolean; nextRunAt: string; lastRunAt?: string;
  lastStatus?: DeliveryStatus; lastErrorCode?: DeliveryErrorCode; createdAt: string; updatedAt: string;
};
export type SecretOption = { id: string; name: string; configured: boolean };
export type CollectionOption = { id: string; name: string };
export type DeliverySourceType = 'eventHook' | 'job' | 'test';
export type DeliveryStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type DeliveryErrorCode = 'none' | 'capacityExceeded' | 'secretNotAvailable' | 'secretKeyUnavailable' | 'secretRevoked' | 'webhookDisabled' | 'originNotAllowed' | 'externalRequestFailed' | 'deliveryRejected' | 'attemptInterrupted' | 'hookFailed';
export type DeliverySummary = {
  id: string;
  sourceType: DeliverySourceType;
  sourceId: string;
  webhookId: string;
  webhookName: string;
  webhookRevision: number;
  eventId?: string;
  eventType: string;
  status: DeliveryStatus;
  createdAt: string;
  nextAttemptAt?: string;
  completedAt?: string;
  attemptCount: number;
  manualRedriveCount: number;
  lastHttpStatus?: number;
  errorCode: DeliveryErrorCode;
};
export type DeliveryAttempt = {
  round: number; attempt: number; webhookRevision: number;
  status: 'running' | 'succeeded' | 'retryScheduled' | 'rejected' | 'failed' | 'interrupted' | 'cancelled';
  startedAt: string; completedAt?: string; durationMs: number; httpStatus?: number; errorCode: DeliveryErrorCode;
};
export type DeliveryDetail = DeliverySummary & { attempts: DeliveryAttempt[] };
export type DeliveryPage = { data: DeliverySummary[]; nextCursor?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeRequestError(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const code = typeof envelope.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(envelope.code)
    ? envelope.code : 'INTERNAL_ERROR';
  const requestId = response.headers.get('X-Request-Id')
    ?? (typeof envelope.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.requestId) ? envelope.requestId : 'unavailable');
  const paths = new Set(['/name', '/targetUrl', '/signingSecretId', '/collectionId', '/eventType', '/webhookId', '/cron']);
  const codes = new Set(['required', 'invalidName', 'invalidWebhookUrl', 'invalidSecretReference', 'invalidCollection', 'invalidEventType', 'duplicateEventHook', 'invalidCron', 'tooManyWebhooks', 'tooManyEventHooks', 'tooManyJobs']);
  const violations = code === 'VALIDATION_FAILED' && isRecord(envelope.details) && Array.isArray(envelope.details.violations)
    ? envelope.details.violations.filter(isRecord).flatMap((item) =>
      typeof item.path === 'string' && paths.has(item.path) && typeof item.code === 'string' && codes.has(item.code)
        ? [{ path: item.path, code: item.code, message: 'Review this field.' }]
        : [],
    )
    : [];
  return new ApiClientError(response.status, {
    code,
    message: 'The Automation request could not be completed.',
    details: violations.length ? { violations } satisfies ErrorDetails : {} satisfies ErrorDetails,
    requestId,
  });
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiClientError(0, { code: 'RUNTIME_UNAVAILABLE', message: 'The Automation request could not be completed.', details: {}, requestId: 'unavailable' });
  }
  if (response.status === 204) {
    if (!response.ok) throw safeRequestError(undefined, response);
    return undefined;
  }
  let value: unknown;
  try { value = await response.json(); } catch { value = undefined; }
  if (!response.ok) throw safeRequestError(value, response);
  if (value === undefined) throw new ApiClientError(response.status, {
    code: 'INTERNAL_ERROR', message: 'The Automation response could not be read.', details: {},
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  });
  return value;
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value) || !('data' in value)) throw new ApiClientError(200, {
    code: 'INTERNAL_ERROR', message: 'The Automation response was invalid.', details: {}, requestId: 'unavailable',
  });
  return value.data;
}

function webhook(value: unknown): WebhookSummary {
  const item = isRecord(value) ? value : {};
  return {
    id: text(item.id), name: text(item.name), targetUrl: text(item.targetUrl),
    signingSecretId: text(item.signingSecretId), signingSecretName: text(item.signingSecretName),
    signingConfigured: item.signingConfigured === true, enabled: item.enabled === true,
    revision: typeof item.revision === 'number' ? item.revision : 0,
    createdAt: text(item.createdAt), updatedAt: text(item.updatedAt),
  };
}

function delivery(value: unknown): DeliverySummary {
  const item = isRecord(value) ? value : {};
  const sourceType = item.sourceType === 'eventHook' || item.sourceType === 'job' ? item.sourceType : 'test';
  const status = item.status === 'running' || item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled' ? item.status : 'pending';
  const errorCodes: DeliveryErrorCode[] = ['none', 'capacityExceeded', 'secretNotAvailable', 'secretKeyUnavailable', 'secretRevoked', 'webhookDisabled', 'originNotAllowed', 'externalRequestFailed', 'deliveryRejected', 'attemptInterrupted', 'hookFailed'];
  const errorCode = typeof item.errorCode === 'string' && errorCodes.includes(item.errorCode as DeliveryErrorCode) ? item.errorCode as DeliveryErrorCode : 'none';
  return {
    id: text(item.id), sourceType, sourceId: text(item.sourceId), webhookId: text(item.webhookId),
    webhookName: text(item.webhookName), webhookRevision: typeof item.webhookRevision === 'number' ? item.webhookRevision : 0,
    ...(typeof item.eventId === 'string' ? { eventId: item.eventId } : {}), eventType: text(item.eventType), status,
    createdAt: text(item.createdAt), ...(typeof item.nextAttemptAt === 'string' ? { nextAttemptAt: item.nextAttemptAt } : {}),
    ...(typeof item.completedAt === 'string' ? { completedAt: item.completedAt } : {}),
    attemptCount: typeof item.attemptCount === 'number' ? item.attemptCount : 0,
    manualRedriveCount: typeof item.manualRedriveCount === 'number' ? item.manualRedriveCount : 0,
    ...(typeof item.lastHttpStatus === 'number' ? { lastHttpStatus: item.lastHttpStatus } : {}), errorCode,
  };
}

function deliveryAttempt(value: unknown): DeliveryAttempt {
  const item = isRecord(value) ? value : {};
  const statuses: DeliveryAttempt['status'][] = ['running', 'succeeded', 'retryScheduled', 'rejected', 'failed', 'interrupted', 'cancelled'];
  const errors: DeliveryErrorCode[] = ['none', 'capacityExceeded', 'secretNotAvailable', 'secretKeyUnavailable', 'secretRevoked', 'webhookDisabled', 'originNotAllowed', 'externalRequestFailed', 'deliveryRejected', 'attemptInterrupted', 'hookFailed'];
  return {
    round: typeof item.round === 'number' ? item.round : 0,
    attempt: typeof item.attempt === 'number' ? item.attempt : 0,
    webhookRevision: typeof item.webhookRevision === 'number' ? item.webhookRevision : 0,
    status: typeof item.status === 'string' && statuses.includes(item.status as DeliveryAttempt['status']) ? item.status as DeliveryAttempt['status'] : 'failed',
    startedAt: text(item.startedAt), ...(typeof item.completedAt === 'string' ? { completedAt: item.completedAt } : {}),
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : 0,
    ...(typeof item.httpStatus === 'number' ? { httpStatus: item.httpStatus } : {}),
    errorCode: typeof item.errorCode === 'string' && errors.includes(item.errorCode as DeliveryErrorCode) ? item.errorCode as DeliveryErrorCode : 'none',
  };
}

function eventHook(value: unknown): EventHookSummary {
  const item = isRecord(value) ? value : {};
  const eventType = item.eventType === 'record.updated' || item.eventType === 'record.deleted' ? item.eventType : 'record.created';
  return {
    id: text(item.id), name: text(item.name), collectionId: text(item.collectionId), collectionName: text(item.collectionName),
    eventType, webhookId: text(item.webhookId), webhookName: text(item.webhookName), enabled: item.enabled === true,
    createdAt: text(item.createdAt), updatedAt: text(item.updatedAt),
  };
}

function job(value: unknown): JobSummary {
  const item = isRecord(value) ? value : {};
  const statuses: DeliveryStatus[] = ['pending', 'running', 'succeeded', 'failed', 'cancelled'];
  const errorCodes: DeliveryErrorCode[] = ['none', 'capacityExceeded', 'secretNotAvailable', 'secretKeyUnavailable', 'secretRevoked', 'webhookDisabled', 'originNotAllowed', 'externalRequestFailed', 'deliveryRejected', 'attemptInterrupted', 'hookFailed'];
  return {
    id: text(item.id), name: text(item.name), webhookId: text(item.webhookId), webhookName: text(item.webhookName),
    cron: text(item.cron), enabled: item.enabled === true, nextRunAt: text(item.nextRunAt),
    ...(typeof item.lastRunAt === 'string' ? { lastRunAt: item.lastRunAt } : {}),
    ...(typeof item.lastStatus === 'string' && statuses.includes(item.lastStatus as DeliveryStatus) ? { lastStatus: item.lastStatus as DeliveryStatus } : {}),
    ...(typeof item.lastErrorCode === 'string' && errorCodes.includes(item.lastErrorCode as DeliveryErrorCode) ? { lastErrorCode: item.lastErrorCode as DeliveryErrorCode } : {}),
    createdAt: text(item.createdAt), updatedAt: text(item.updatedAt),
  };
}

async function list(path: string, project: (value: unknown) => unknown, signal?: AbortSignal): Promise<unknown[]> {
  const data = unwrap(await request(path, { method: 'GET', signal }));
  if (!Array.isArray(data)) throw new ApiClientError(200, {
    code: 'INTERNAL_ERROR', message: 'The Automation list was invalid.', details: {}, requestId: 'unavailable',
  });
  return data.map(project);
}

export async function listWebhooks(signal?: AbortSignal): Promise<WebhookSummary[]> {
  const value = await request('/admin/api/v1/webhooks', { method: 'GET', signal });
  const data = unwrap(value);
  if (!Array.isArray(data)) throw new ApiClientError(200, {
    code: 'INTERNAL_ERROR', message: 'The Webhook list was invalid.', details: {}, requestId: 'unavailable',
  });
  return data.map(webhook);
}

export async function createWebhook(input: WebhookInput): Promise<WebhookSummary> {
  return webhook(unwrap(await request('/admin/api/v1/webhooks', { method: 'POST', body: JSON.stringify(input) })));
}

export async function updateWebhook(id: string, input: WebhookInput): Promise<WebhookSummary> {
  return webhook(unwrap(await request(`/admin/api/v1/webhooks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })));
}

export async function setWebhookEnabled(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  const result = unwrap(await request(`/admin/api/v1/webhooks/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }));
  const item = isRecord(result) ? result : {};
  return { id: text(item.id), enabled: item.enabled === true };
}

export async function sendWebhookTest(id: string): Promise<DeliverySummary> {
  return delivery(unwrap(await request(`/admin/api/v1/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' })));
}

export async function listEventHooks(signal?: AbortSignal): Promise<EventHookSummary[]> {
  return await list('/admin/api/v1/event-hooks', eventHook, signal) as EventHookSummary[];
}

export async function createEventHook(input: EventHookInput): Promise<EventHookSummary> {
  return eventHook(unwrap(await request('/admin/api/v1/event-hooks', { method: 'POST', body: JSON.stringify(input) })));
}

export async function updateEventHook(id: string, input: EventHookInput): Promise<EventHookSummary> {
  return eventHook(unwrap(await request(`/admin/api/v1/event-hooks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })));
}

export async function setEventHookEnabled(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  const result = unwrap(await request(`/admin/api/v1/event-hooks/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }));
  const item = isRecord(result) ? result : {};
  return { id: text(item.id), enabled: item.enabled === true };
}

export async function listJobs(signal?: AbortSignal): Promise<JobSummary[]> {
  return await list('/admin/api/v1/jobs', job, signal) as JobSummary[];
}

export async function createJob(input: JobInput): Promise<JobSummary> {
  return job(unwrap(await request('/admin/api/v1/jobs', { method: 'POST', body: JSON.stringify(input) })));
}

export async function updateJob(id: string, input: JobInput): Promise<JobSummary> {
  return job(unwrap(await request(`/admin/api/v1/jobs/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })));
}

export async function setJobEnabled(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean; nextRunAt: string }> {
  const result = unwrap(await request(`/admin/api/v1/jobs/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }));
  const item = isRecord(result) ? result : {};
  return { id: text(item.id), enabled: item.enabled === true, nextRunAt: text(item.nextRunAt) };
}

export async function listDeliveries(options: {
  cursor?: string; limit?: number; sourceType?: DeliverySourceType; status?: DeliveryStatus;
} = {}, signal?: AbortSignal): Promise<DeliveryPage> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  params.set('limit', String(limit));
  if (options.sourceType) params.set('sourceType', options.sourceType);
  if (options.status) params.set('status', options.status);
  const value = await request(`/admin/api/v1/deliveries?${params.toString()}`, { method: 'GET', signal });
  if (!isRecord(value) || !Array.isArray(value.data)) throw new ApiClientError(200, {
    code: 'INTERNAL_ERROR', message: 'The Delivery list was invalid.', details: {}, requestId: 'unavailable',
  });
  return { data: value.data.map(delivery), ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) };
}

export async function getDelivery(id: string, signal?: AbortSignal): Promise<DeliveryDetail> {
  const item = unwrap(await request(`/admin/api/v1/deliveries/${encodeURIComponent(id)}`, { method: 'GET', signal }));
  const raw = isRecord(item) ? item : {};
  return { ...delivery(item), attempts: Array.isArray(raw.attempts) ? raw.attempts.map(deliveryAttempt) : [] };
}

export async function retryDelivery(id: string): Promise<DeliverySummary> {
  return delivery(unwrap(await request(`/admin/api/v1/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST' })));
}

export async function listAutomationSecrets(signal?: AbortSignal): Promise<SecretOption[]> {
  return await list('/admin/api/v1/secrets', (value) => {
    const item = isRecord(value) ? value : {};
    return { id: text(item.id), name: text(item.name), configured: item.configured === true } satisfies SecretOption;
  }, signal) as SecretOption[];
}

export async function listAutomationCollections(signal?: AbortSignal): Promise<CollectionOption[]> {
  const result: CollectionOption[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const response = await request(`/admin/api/v1/collections?${params.toString()}`, { method: 'GET', signal });
    if (!isRecord(response) || !Array.isArray(response.data)) throw new ApiClientError(200, {
      code: 'INTERNAL_ERROR', message: 'The Collection list was invalid.', details: {}, requestId: 'unavailable',
    });
    result.push(...response.data.map((value) => {
      const item = isRecord(value) ? value : {};
      return { id: text(item.id), name: text(item.name) };
    }));
    cursor = typeof response.nextCursor === 'string' && response.nextCursor.length > 0 ? response.nextCursor : undefined;
    pageCount += 1;
    if (cursor && seenCursors.has(cursor)) cursor = undefined;
    if (cursor) seenCursors.add(cursor);
  } while (cursor && pageCount < 100);
  return result;
}
