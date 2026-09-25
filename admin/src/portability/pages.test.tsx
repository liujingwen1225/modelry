import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';

const contract = {
  version: 'test',
  contentHash: 'a'.repeat(64),
  apiBasePath: '/api/v1',
  collections: [{
    id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 1,
    fields: [{ id: 'fld_1', name: 'title', type: 'text', required: false, unique: false }],
    endpoints: ['GET /api/v1/posts', 'POST /api/v1/posts'],
    accessRules: [{ operation: 'list', mode: 'anyone' }],
  }],
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(options: { preflight?: unknown } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return response({ owner: { id: 'own_test', email: 'owner@example.test' }, expiresAt: '2030-01-01T00:00:00Z', role: 'owner', permission: { preset: 'fullAccess' } });
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [{ id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 1, fields: [], indexCount: 0 }] });
    if (path === '/admin/api/v1/developer/contract') return response({ data: contract });
    if (path === '/admin/api/v1/backup' && method === 'POST') {
      return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200, headers: { 'Content-Type': 'application/x-tar', 'Content-Disposition': 'attachment; filename="modelry-backup-abc.tar"' } });
    }
    if (path === '/admin/api/v1/restore/preflight' && method === 'POST') {
      return response({ data: options.preflight ?? { compatible: true, projectId: 'prj_test', runtimeVersion: 'test', formatVersion: 1, counts: { collections: 1, records: 2, objects: 0 }, findings: [] } });
    }
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Developer and portability surface', () => {
  it('shows the contract hash and validates a bundle without writing anything', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/portability');
    const fetchMock = setupFetch();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Developer and portability', level: 1 })).toBeInTheDocument();
    expect((await screen.findAllByText('posts')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('contract-hash')).toHaveTextContent('a'.repeat(64));
    expect(screen.getByText('2 endpoints')).toBeInTheDocument();

    const file = new File([new Uint8Array([1, 2, 3])], 'bundle.tar', { type: 'application/x-tar' });
    await userEvent.upload(screen.getByLabelText('Validate a backup bundle'), file);
    await waitFor(() => expect(screen.getByText('Compatible')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([input]) => String(input) === '/admin/api/v1/restore/preflight');
    expect(call).toBeDefined();
    expect(screen.getByText(/stays a CLI operation/)).toBeInTheDocument();
  });

  it('reports an incompatible bundle instead of pretending it can restore', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/portability');
    setupFetch({
      preflight: {
        compatible: false, formatVersion: 2,
        counts: { collections: 0, records: 0, objects: 0 },
        findings: [{ code: 'format.versionUnsupported', severity: 'error', message: 'This bundle was produced by a newer Modelry project format.' }],
      },
    });
    render(<App />);

    await screen.findByRole('heading', { name: 'Developer and portability', level: 1 });
    const file = new File([new Uint8Array([9])], 'bundle.tar', { type: 'application/x-tar' });
    await userEvent.upload(screen.getByLabelText('Validate a backup bundle'), file);
    await waitFor(() => expect(screen.getByText('Not compatible')).toBeInTheDocument());
    expect(screen.getByText('This bundle was produced by a newer Modelry project format.')).toBeInTheDocument();
  });
});