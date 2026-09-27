import { render, screen } from '@testing-library/react';
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

describe('Overview action center', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives an empty project one direct action and keeps healthy status quiet', async () => {
    setupOverview([]);

    expect(await screen.findByRole('heading', { name: 'Your backend is ready' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Up to date' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create Collection' })).toHaveAttribute('href', '/collections/new');
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Continue recent work' })).not.toBeInTheDocument();
  });

  it('links failed schema recovery and the most recent Collections to their next action', async () => {
    setupOverview([
      { id: 'col_posts', name: 'posts', type: 'Normal', fields: [], updatedAt: '2026-09-22T00:00:00Z', pendingChangeStatus: 'failed' },
      { id: 'col_users', name: 'users', type: 'Auth', fields: [], updatedAt: '2026-09-23T00:00:00Z' },
    ]);

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByText('A schema change needs recovery in posts.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recovery needed' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/collections/col_posts/schema');
    expect(screen.getByRole('heading', { name: 'Continue recent work' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Edit security/ })).toHaveAttribute('href', '/collections/col_users/security');
    expect(screen.getByRole('link', { name: /Open records/ })).toHaveAttribute('href', '/collections/col_posts');
  });

  it('shows pending changes and their review path', async () => {
    setupOverview([{ id: 'col_posts', name: 'posts', type: 'Normal', fields: [], pendingChangeStatus: 'needsReview' }]);

    expect(await screen.findByRole('heading', { name: 'Pending changes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review changes/ })).toHaveAttribute('href', '/changes?view=pending');
  });

  it('shows unavailable schema health when the Collection summary cannot load', async () => {
    setupOverview([], true);

    expect(await screen.findByRole('heading', { name: 'Unavailable' })).toBeInTheDocument();
    expect(screen.getByText('Collection status is unavailable.')).toBeInTheDocument();
  });
});
