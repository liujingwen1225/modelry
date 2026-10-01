import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';

// Spec 0001 §5：总览只显示真实运行事实；section 缺失时显示 Unavailable，
// 空项目时给出第一步，并且主操作随真实状态切换。

const session = {
  owner: { id: 'own_test', email: 'owner@example.test' },
  expiresAt: '2026-10-25T12:00:00Z',
  role: 'owner',
  permission: { preset: 'fullAccess' },
};

const activityFact = {
  id: 'af_change_pending_chg_1',
  kind: 'change.pending',
  status: 'pending',
  occurredAt: '2026-10-01T11:28:00Z',
  resourceKind: 'changeSet',
  resourceId: 'chg_1',
  collectionId: 'col_users',
  title: 'users',
  deepLink: '/collections/col_users/schema',
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

const fullSnapshot = {
  generatedAt: '2026-10-01T12:00:00Z',
  windowSeconds: 86400,
  collections: {
    count: 2,
    recordCount: 1214,
    withPendingChanges: 1,
    withFailedChanges: 0,
    recent: [
      { id: 'col_users', name: 'users', type: 'Auth', recordCount: 1204, fieldCount: 9, relationCount: 2, indexCount: 3, pendingChangeStatus: 'ready', updatedAt: '2026-10-01T11:00:00Z' },
      { id: 'col_posts', name: 'posts', type: 'Normal', recordCount: 10, fieldCount: 12, relationCount: 1, indexCount: 3, updatedAt: '2026-10-01T10:00:00Z' },
    ],
  },
  requests: { windowSeconds: 86400, requestCount: 18400, clientErrorCount: 42, serverErrorCount: 3, p95DurationMs: 34 },
  events: { enabledHooks: 4, enabledWebhooks: 2, enabledEventHooks: 1, enabledJobs: 2, runCount: 284, deliveryCount: 12, failedDeliveryCount: 2, pendingDeliveryCount: 1 },
  changes: { pendingCount: 3, needsReviewCount: 1, failedCount: 0 },
  drift: { state: 'drift', differenceCount: 1, checkedAt: '2026-10-01T11:18:00Z' },
};

function setupFetch(overview: unknown, options: { overviewStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/session')) return response(session);
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-10-01T12:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' }, databaseSizeBytes: 40108032 });
    if (path.startsWith('/admin/api/v1/overview')) {
      if (options.overviewStatus && options.overviewStatus !== 200) {
        return response({ error: { code: 'RUNTIME_NOT_READY', message: 'Overview facts are not available yet.', details: {}, requestId: 'req_ov' } }, options.overviewStatus);
      }
      return response({ data: overview });
    }
    if (path.startsWith('/admin/api/v1/activity')) return response({ data: [activityFact] });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [] });
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function card(id: string): HTMLElement {
  const element = document.querySelector(`[data-overview-card="${id}"]`);
  if (!element) throw new Error(`overview card ${id} was not rendered`);
  return element as HTMLElement;
}

describe('Overview', () => {
  it('renders every summary from real facts and links to its owning page', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/');
    setupFetch(fullSnapshot);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();

    await waitFor(() => expect(within(card('collections')).getByText('2')).toBeInTheDocument());
    expect(within(card('collections')).getByText('1,214')).toBeInTheDocument();
    expect(within(card('collections')).getByText('Pending')).toBeInTheDocument();
    expect(within(card('api')).getByText('18,400')).toBeInTheDocument();
    expect(within(card('api')).getByText('42 / 3')).toBeInTheDocument();
    expect(within(card('api')).getByText('34 ms')).toBeInTheDocument();
    expect(within(card('events')).getByText('7')).toBeInTheDocument();
    expect(within(card('events')).getByText('296')).toBeInTheDocument();
    // 变更卡：待应用 3，需审查 1，结构漂移 1。
    expect(within(card('changes')).getByText('3')).toBeInTheDocument();
    expect(within(card('changes')).getAllByText('1')).toHaveLength(2);

    // 主操作跟随真实的待应用变更数量，而不是固定文案。
    expect(screen.getByRole('link', { name: 'Review 3 changes' })).toHaveAttribute('href', '/changes?tab=pending');

    // 继续工作恢复最近集合，并提供打开入口。
    const continueCard = document.querySelector('[data-overview-continue]') as HTMLElement;
    expect(within(continueCard).getByText('users')).toBeInTheDocument();
    expect(within(continueCard).getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href', '/collections/col_users');

    // 快捷开始只提供真实动作。
    const quickCard = document.querySelector('[data-overview-quick-start]') as HTMLElement;
    expect(within(quickCard).getByRole('link', { name: /Create Webhook/ })).toHaveAttribute('href', '/events?tab=webhooks&create=1');
    expect(within(quickCard).getByRole('link', { name: /Create a scheduled job/ })).toHaveAttribute('href', '/schedules?tab=jobs&create=1');

    // 最近活动来自 Activity facts，并把 deep link 归一化到新导航。
    const recent = document.querySelector('[data-overview-recent-activity]') as HTMLElement;
    expect(within(recent).getByText('users')).toBeInTheDocument();

    // 运行状态显示真实数据库大小与漂移数量，备份没有持久化事实时显示 Unavailable。
    const runtime = document.querySelector('[data-overview-runtime]') as HTMLElement;
    expect(within(runtime).getByText(/SQLite/)).toBeInTheDocument();
    expect(within(runtime).getByText(/39,168 KB/)).toBeInTheDocument();
    expect(within(runtime).getByText('Unavailable')).toBeInTheDocument();
  });

  it('keeps readable sections when another section cannot be read', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/');
    const partial = { ...fullSnapshot, requests: undefined };
    setupFetch(partial);
    render(<App />);

    await waitFor(() => expect(within(card('collections')).getByText('2')).toBeInTheDocument());
    // API 摘要缺失时必须显示 Unavailable，而不是 0 次请求。
    expect(within(card('api')).getByText('Unavailable')).toBeInTheDocument();
    expect(within(card('api')).queryByText('0')).toBeNull();
    expect(within(card('changes')).getByText('3')).toBeInTheDocument();
  });

  it('guides an empty project instead of showing zero-value tiles', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/');
    setupFetch({
      generatedAt: '2026-10-01T12:00:00Z',
      windowSeconds: 86400,
      collections: { count: 0, recordCount: 0, withPendingChanges: 0, withFailedChanges: 0, recent: [] },
      requests: { windowSeconds: 86400, requestCount: 0, clientErrorCount: 0, serverErrorCount: 0 },
      events: { enabledHooks: 0, enabledWebhooks: 0, enabledEventHooks: 0, enabledJobs: 0, runCount: 0, deliveryCount: 0, failedDeliveryCount: 0, pendingDeliveryCount: 0 },
      changes: { pendingCount: 0, needsReviewCount: 0, failedCount: 0 },
    });
    render(<App />);

    expect(await screen.findByRole('link', { name: 'Create Collection' })).toHaveAttribute('href', '/collections/new');
    const continueCard = document.querySelector('[data-overview-continue]') as HTMLElement;
    expect(within(continueCard).getByText(/No Collection yet/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Review 0 changes/ })).toBeNull();
  });

  it('shows a recoverable error when the aggregate itself is unavailable', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/');
    setupFetch(fullSnapshot, { overviewStatus: 503 });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(within(card('collections')).getByText('Unavailable')).toBeInTheDocument());
    // 侧栏计数在没有快照时不渲染任何数字（不把失败显示成 0）。
    expect(document.querySelector('[data-nav-count="collections"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Retry/i }).length).toBeGreaterThan(0);
  });
});
