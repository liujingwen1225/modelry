import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';

function json(data: unknown) {
  return Response.json(data, { headers: { 'Content-Type': 'application/json' } });
}

function setupOverview(collections: unknown[], failCollections = false) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/session')) return Promise.resolve(json({
      owner: { id: 'own_test', email: 'owner@example.test' },
      expiresAt: '2026-09-25T09:00:00Z',
      role: 'owner',
      permission: { preset: 'fullAccess' },
    }));
    if (path.endsWith('/runtime/status')) return Promise.resolve(json({
      state: 'ready', observedAt: '2026-09-24T09:00:00Z',
      database: { state: 'ready' }, localStorage: { state: 'ready' },
    }));
    if (path.endsWith('/storage/status')) return Promise.resolve(json({
      database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' },
    }));
    if (path.startsWith('/admin/api/v1/collections?')) return Promise.resolve(failCollections
      ? Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Collection list unavailable.' } }, { status: 500 })
      : json({ data: collections }));
    return Promise.resolve(json({ data: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  return fetchMock;
}

describe('Home workspace', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives an empty project one direct next step and keeps healthy status to a single row each', async () => {
    setupOverview([]);

    expect(await screen.findByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument();
    // 状态与下一步都来自真实运行时快照，先等到加载完成再断言。
    await screen.findByText('Up to date');
    const status = screen.getByRole('region', { name: 'Workspace status' });
    for (const label of ['Runtime', 'Database', 'File storage', 'Model']) {
      expect(status).toHaveTextContent(label);
    }

    const nextStep = screen.getByRole('region', { name: 'Next step' });
    expect(nextStep).toHaveTextContent('Create your first Collection');
    expect(within(nextStep).getByRole('link', { name: /Create Collection/ })).toHaveAttribute('href', '/collections/new');
    expect(document.querySelector('.diagnostics-grid')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('links failed schema recovery and recent Collections to their next action', async () => {
    setupOverview([
      { id: 'col_posts', name: 'posts', type: 'Normal', fields: [], recordCount: 4, updatedAt: '2026-09-22T00:00:00Z', pendingChangeStatus: 'failed' },
      { id: 'col_users', name: 'users', type: 'Auth', fields: [], recordCount: 2, updatedAt: '2026-09-23T00:00:00Z' },
    ]);

    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(attention).toHaveTextContent('A saved change in posts needs recovery.');
    expect(within(attention).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/collections/col_posts/model');

    const nextStep = screen.getByRole('region', { name: 'Next step' });
    expect(nextStep).toHaveTextContent('Recover the failed change');
    expect(within(nextStep).getByRole('link', { name: /Review changes/ })).toHaveAttribute('href', '/changes?view=pending');

    const recentWork = screen.getByRole('region', { name: 'Recent work' });
    expect(recentWork).toHaveTextContent('users');
    expect(within(recentWork).getAllByRole('link', { name: 'Open' })).toHaveLength(2);
  });

  it('suggests reviewing pending changes before anything else', async () => {
    setupOverview([{ id: 'col_posts', name: 'posts', type: 'Normal', fields: [], recordCount: 3, pendingChangeStatus: 'needsReview' }]);

    expect(await screen.findByText('1 change to review')).toBeInTheDocument();
    const nextStep = screen.getByRole('region', { name: 'Next step' });
    expect(nextStep).toHaveTextContent('Review pending changes');
    expect(within(nextStep).getByRole('link', { name: /Review changes/ })).toHaveAttribute('href', '/changes?view=pending');
  });

  it('points a healthy project with an empty Collection at its first record', async () => {
    setupOverview([{ id: 'col_posts', name: 'posts', type: 'Normal', fields: [], recordCount: 0 }]);

    expect(await screen.findByText('Create the first record in posts')).toBeInTheDocument();
    const nextStep = screen.getByRole('region', { name: 'Next step' });
    expect(within(nextStep).getByRole('link', { name: 'Open records' })).toHaveAttribute('href', '/collections/col_posts');
  });

  it('shows unavailable status instead of a healthy project when the Collection summary cannot load', async () => {
    setupOverview([], true);

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByText('Collection status is unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Collections' })).toHaveAttribute('href', '/collections');
    const status = screen.getByRole('region', { name: 'Workspace status' });
    expect(status).toHaveTextContent('Unavailable');
    expect(status).not.toHaveTextContent('Up to date');
  });
});
