import { ApiClientError, getJson } from '../api/client';

// Spec 0001 §5.2 / core-http-contract §5：总览只使用真实运行事实。
// 每个 section 都是可选的：字段缺失表示"当前读不到"（界面显示 Unavailable / Unknown），
// 字段存在且为 0 才是真实零。任何缺失都不得被渲染成 0。

export type OverviewRecentCollection = {
  id: string;
  name: string;
  type: 'Normal' | 'Auth';
  recordCount?: number;
  fieldCount: number;
  relationCount: number;
  indexCount: number;
  pendingChangeStatus?: 'ready' | 'needsReview' | 'failed';
  updatedAt: string;
};

export type OverviewCollections = {
  count: number;
  recordCount?: number;
  withPendingChanges: number;
  withFailedChanges: number;
  recent?: OverviewRecentCollection[];
};

export type OverviewRequests = {
  windowSeconds: number;
  windowCoveredFrom?: string;
  requestCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  p95DurationMs?: number;
};

export type OverviewEvents = {
  enabledHooks: number;
  enabledWebhooks: number;
  enabledEventHooks: number;
  enabledJobs: number;
  runCount: number;
  deliveryCount: number;
  failedDeliveryCount: number;
  pendingDeliveryCount: number;
};

export type OverviewChanges = {
  pendingCount: number;
  needsReviewCount: number;
  failedCount: number;
};

export type OverviewDrift = {
  state: string;
  differenceCount: number;
  checkedAt: string;
};

export type OverviewSnapshot = {
  generatedAt: string;
  windowSeconds: number;
  collections?: OverviewCollections;
  requests?: OverviewRequests;
  events?: OverviewEvents;
  changes?: OverviewChanges;
  drift?: OverviewDrift;
};

type Envelope = { data?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 未知字段一律忽略；section 只有在形状正确时才被采纳，避免把半个响应当成事实。
export function parseOverviewSnapshot(value: unknown): OverviewSnapshot | null {
  const envelope = isRecord(value) ? (value as Envelope) : undefined;
  const data = envelope && isRecord(envelope.data) ? envelope.data : undefined;
  if (!data || typeof data.generatedAt !== 'string' || typeof data.windowSeconds !== 'number') return null;
  const snapshot: OverviewSnapshot = { generatedAt: data.generatedAt, windowSeconds: data.windowSeconds };
  if (isRecord(data.collections) && typeof data.collections.count === 'number') {
    snapshot.collections = data.collections as unknown as OverviewCollections;
  }
  if (isRecord(data.requests) && typeof data.requests.requestCount === 'number') {
    snapshot.requests = data.requests as unknown as OverviewRequests;
  }
  if (isRecord(data.events) && typeof data.events.deliveryCount === 'number') {
    snapshot.events = data.events as unknown as OverviewEvents;
  }
  if (isRecord(data.changes) && typeof data.changes.pendingCount === 'number') {
    snapshot.changes = data.changes as unknown as OverviewChanges;
  }
  if (isRecord(data.drift) && typeof data.drift.differenceCount === 'number') {
    snapshot.drift = data.drift as unknown as OverviewDrift;
  }
  return snapshot;
}

export async function fetchOverview(signal?: AbortSignal): Promise<OverviewSnapshot> {
  const value = await getJson<unknown>('/admin/api/v1/overview', signal);
  const snapshot = parseOverviewSnapshot(value);
  if (!snapshot) {
    throw new ApiClientError(502, {
      code: 'INVALID_OVERVIEW',
      message: 'The Runtime returned an Overview payload that could not be read.',
      details: {},
      requestId: 'unavailable',
    });
  }
  return snapshot;
}
