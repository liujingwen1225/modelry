import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';

const localStatus = {
  activeProvider: 'local',
  provider: 'Local',
  revision: 1,
  providerState: 'ready',
  providerMessage: 'Local Storage is responding.',
  configuration: { provider: 'local', local: { path: '/tmp/project/.modelry/files/objects' }, s3: null },
  health: { state: 'ready', observedAt: '2026-09-25T09:00:00Z', referencedObjects: 2 },
  migration: { active: false, latest: null },
};

const s3Status = {
  ...localStatus,
  activeProvider: 's3',
  provider: 'S3-compatible',
  revision: 2,
  configuration: {
    provider: 's3',
    local: { path: '/tmp/project/.modelry/files/objects' },
    s3: {
      endpoint: 'https://s3.example.test', region: 'us-east-1', bucket: 'modelry', keyPrefix: 'modelry/', pathStyle: true, configured: true,
      accessKey: { secretId: 'sec_access', name: 'Storage access key', configured: true },
      secretKey: { secretId: 'sec_secret', name: 'Storage secret key', configured: true },
    },
  },
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(options: { savedStatus?: unknown; saveError?: { status: number; code: string } } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return response({ owner: { id: 'own_test', email: 'owner@example.test' }, expiresAt: '2026-09-25T12:00:00Z', role: 'owner', permission: { preset: 'fullAccess' } });
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [] });
    if (path === '/admin/api/v1/storage/files' && method === 'GET') return response({ data: options.savedStatus ?? localStatus });
    if (path === '/admin/api/v1/storage/files/migrations' && method === 'GET') return response({ data: [] });
    if (path === '/admin/api/v1/secrets' && method === 'GET') return response({ data: [{ id: 'sec_access', name: 'Storage access key', configured: true }, { id: 'sec_secret', name: 'Storage secret key', configured: true }] });
    if (path === '/admin/api/v1/storage/files/provider' && method === 'PUT') {
      if (options.saveError) return response({ error: { code: options.saveError.code, message: 'no', details: {}, requestId: 'req_test' } }, options.saveError.status);
      return response({ data: s3Status });
    }
    if (path === '/admin/api/v1/storage/files/provider/test' && method === 'POST') return response({ data: { state: 'ready', message: 'S3-compatible Storage is responding.' } });
    if (path === '/admin/api/v1/storage/files/migrations' && method === 'POST') return response({ data: { id: 'fmig_' + 'a'.repeat(32), sourceProvider: 'local', targetProvider: 's3', status: 'running', totalObjects: 1, copiedObjects: 0, startedAt: '2026-09-25T09:00:00Z' } }, 202);
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('File Storage Admin surface', () => {
  it('shows the active Provider, referenced objects, and the Owner-only local path', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/storage');
    setupFetch();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Files & storage' })).toBeInTheDocument();
    expect(await screen.findByText('Referenced files')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project/.modelry/files/objects')).toBeInTheDocument();
  });

  it('saves the S3-compatible Provider configuration', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/storage');
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Files & storage' });
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 's3');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'https://s3.example.test');
    await userEvent.type(screen.getByLabelText('Region'), 'us-east-1');
    await userEvent.type(screen.getByLabelText('Bucket'), 'modelry');
    await userEvent.selectOptions(screen.getByLabelText('Access key Secret'), 'sec_access');
    await userEvent.selectOptions(screen.getByLabelText('Secret key Secret'), 'sec_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/S3-compatible Storage is responding/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(screen.getByText('Provider configuration saved.')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/storage/files/provider') && (init as RequestInit | undefined)?.method === 'PUT');
    expect(call).toBeDefined();
  });

  it('explains that referenced files require a migration before switching Provider', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/storage');
    setupFetch({ saveError: { status: 409, code: 'MIGRATION_REQUIRED' } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Files & storage' });
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 's3');
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    expect(await screen.findByText(/Start a migration before changing the Provider/)).toBeInTheDocument();
  });

  it('starts a migration and reports progress', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/storage');
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Files & storage' });
    await userEvent.click(screen.getByRole('button', { name: /Start migration/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/storage/files/migrations') && (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
  });
});
