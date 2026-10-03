import { describe, expect, it, vi } from 'vitest';
import { fetchOverview, parseOverviewSnapshot } from './client';

const validSnapshot = {
  data: {
    generatedAt: '2026-10-01T12:00:00Z',
    windowSeconds: 86400,
    collections: { count: 2, recordCount: 1214, withPendingChanges: 1, withFailedChanges: 0, recent: [] },
    requests: { windowSeconds: 86400, requestCount: 40, clientErrorCount: 2, serverErrorCount: 1, p95DurationMs: 34 },
    events: { enabledHooks: 1, enabledWebhooks: 1, enabledEventHooks: 0, enabledJobs: 1, runCount: 4, deliveryCount: 6, failedDeliveryCount: 1, pendingDeliveryCount: 0 },
    changes: { pendingCount: 1, needsReviewCount: 0, failedCount: 0 },
    drift: { state: 'drift', differenceCount: 1, checkedAt: '2026-10-01T11:00:00Z' },
  },
};

describe('overview client', () => {
  it('accepts a complete snapshot', () => {
    const snapshot = parseOverviewSnapshot(validSnapshot);
    expect(snapshot?.collections?.count).toBe(2);
    expect(snapshot?.requests?.p95DurationMs).toBe(34);
    expect(snapshot?.events?.deliveryCount).toBe(6);
    expect(snapshot?.changes?.pendingCount).toBe(1);
    expect(snapshot?.drift?.differenceCount).toBe(1);
  });

  it('keeps a missing section missing instead of inventing a zero', () => {
    const snapshot = parseOverviewSnapshot({
      data: { generatedAt: '2026-10-01T12:00:00Z', windowSeconds: 86400, collections: { count: 0, withPendingChanges: 0, withFailedChanges: 0 } },
    });
    expect(snapshot?.collections?.count).toBe(0);
    expect(snapshot?.requests).toBeUndefined();
    expect(snapshot?.events).toBeUndefined();
    expect(snapshot?.changes).toBeUndefined();
    expect(snapshot?.drift).toBeUndefined();
  });

  it('rejects payloads without the envelope', () => {
    expect(parseOverviewSnapshot({})).toBeNull();
    expect(parseOverviewSnapshot({ data: { windowSeconds: 86400 } })).toBeNull();
    expect(parseOverviewSnapshot(null)).toBeNull();
  });

  it('surfaces a transport error and an unreadable payload as errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'RUNTIME_NOT_READY', message: 'not ready', details: {}, requestId: 'req_1' } }, { status: 503 })));
    await expect(fetchOverview()).rejects.toMatchObject({ status: 503 });

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} }, { status: 200 })));
    await expect(fetchOverview()).rejects.toMatchObject({ apiError: { code: 'INVALID_OVERVIEW' } });
    vi.unstubAllGlobals();
  });
});
