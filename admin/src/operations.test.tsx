import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './app';

const session = {
  owner: { id: 'own_test', email: 'owner@example.test' },
  expiresAt: '2026-10-25T12:00:00Z',
  role: 'owner',
  permission: { preset: 'fullAccess' },
};

const activityFact = {
  id: 'af_change_applied_mig_1',
  kind: 'change.applied',
  status: 'applied',
  occurredAt: '2026-09-25T09:00:00Z',
  resourceKind: 'changeSet',
  resourceId: 'chg_1',
  collectionId: 'col_posts',
  title: 'posts',
  deepLink: '/changes?changeSet=chg_1',
};

const driftFinding = {
  id: 'df_table_missing_col_posts',
  class: 'physicalProjection',
  severity: 'error',
  code: 'physicalProjection.tableMissing',
  collectionId: 'col_posts',
  collectionName: 'posts',
  expected: 'record projection table for the applied model',
  actual: 'no record table exists',
  expectedPendingChange: false,
  remedy: 'reconcile',
  deepLink: '/collections/col_posts/schema',
  detectedAt: '2026-09-25T09:00:00Z',
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(options: { drift?: unknown; settingsAfterSave?: unknown } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return response(session);
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [] });
    if (path.startsWith('/admin/api/v1/activity')) return response({ data: [activityFact] });
    if (path === '/admin/api/v1/drift' && method === 'GET') {
      return response({ data: options.drift ?? { state: 'healthy', findings: [], detectedAt: '2026-09-25T09:00:00Z' } });
    }
    if (path === '/admin/api/v1/drift/reconcile' && method === 'POST') {
      return response({ data: { state: 'healthy', findings: [], detectedAt: '2026-09-25T09:00:00Z' } });
    }
    if (path === '/admin/api/v1/settings' && method === 'GET') {
      return response({ data: { listenAddress: { value: '127.0.0.1:8080', source: 'default', restartRequired: false, bounds: 'host:port' }, requestRetentionDays: { value: '30', source: 'default', restartRequired: false, bounds: '1..3650 days' }, revision: 1, updatedAt: '2026-09-25T09:00:00Z' } });
    }
    if (path === '/admin/api/v1/settings' && method === 'PUT') {
      return response({ data: options.settingsAfterSave ?? { listenAddress: { value: '127.0.0.1:9090', source: 'project', restartRequired: true, bounds: 'host:port' }, requestRetentionDays: { value: '14', source: 'project', restartRequired: false, bounds: '1..3650 days' }, revision: 2, updatedAt: '2026-09-25T09:05:00Z' } });
    }
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Operations surfaces', () => {
  it('renders the Activity timeline with its deep link and kind filter', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/activity');
    setupFetch();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Activity', level: 1 })).toBeInTheDocument();
    const list = await screen.findByRole('list');
    expect(within(list).getByText('Model change applied')).toBeInTheDocument();
    expect(within(list).getByText('posts')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/changes?changeSet=chg_1');
  });

  it('reports a healthy Drift state and repairs an actionable difference', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/drift');
    const fetchMock = setupFetch({ drift: { state: 'degraded', findings: [driftFinding], detectedAt: '2026-09-25T09:00:00Z' } });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Drift', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Record table is missing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open corrective surface' })).toHaveAttribute('href', '/collections/col_posts/schema');
    await userEvent.click(screen.getByRole('button', { name: /Reconcile projection/ }));
    await waitFor(() => expect(screen.getByText('Projection reconciled with the applied model.')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/admin/api/v1/drift/reconcile' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
  });

  it('shows where a Runtime setting comes from and reports the restart requirement', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/runtime');
    const fetchMock = setupFetch();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Runtime settings', level: 1 })).toBeInTheDocument();
    expect(await screen.findAllByText('built-in default')).toHaveLength(2);
    await userEvent.type(screen.getByLabelText('Listen address'), '127.0.0.1:9090');
    await userEvent.clear(screen.getByLabelText('Request retention (days)'));
    await userEvent.type(screen.getByLabelText('Request retention (days)'), '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(screen.getByText(/The new listen address applies after a restart/)).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([input, init]) => String(input) === '/admin/api/v1/settings' && (init as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as { expectedRevision: number; listenAddress: string; requestRetentionDays: number };
    expect(body).toEqual({ expectedRevision: 1, listenAddress: '127.0.0.1:9090', requestRetentionDays: 14 });
  });
});