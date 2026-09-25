import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';

const administrator = {
  id: 'adm_1',
  email: 'colleague@example.test',
  status: 'active',
  permission: { preset: 'readOnly' },
  createdAt: '2026-09-25T09:00:00Z',
  updatedAt: '2026-09-25T09:00:00Z',
  lastLoginAt: null,
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(options: { administrators?: unknown[]; createError?: { status: number; code: string } } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return response({ owner: { id: 'own_test', email: 'owner@example.test' }, expiresAt: '2026-09-25T12:00:00Z', role: 'owner', permission: { preset: 'fullAccess' } });
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [] });
    if (path === '/admin/api/v1/administrators' && method === 'GET') return response({ data: options.administrators ?? [administrator] });
    if (path === '/admin/api/v1/administrators' && method === 'POST') {
      if (options.createError) return response({ error: { code: options.createError.code, message: 'no', details: {}, requestId: 'req_test' } }, options.createError.status);
      const body = JSON.parse(String(init?.body ?? '{}')) as { email: string; permission: { preset: string } };
      return response({ data: { ...administrator, id: 'adm_2', email: body.email, permission: body.permission } }, 201);
    }
    if (path === '/admin/api/v1/administrators/adm_1/disable' && method === 'POST') return response({ data: { ...administrator, status: 'disabled' } });
    if (path === '/admin/api/v1/administrators/adm_1/sessions' && method === 'GET') return response({ data: [{ id: 'ses_1', createdAt: '2026-09-25T09:00:00Z', expiresAt: '2026-10-02T09:00:00Z', lastUsedAt: null, revokedAt: null, status: 'active', current: false }] });
    if (path === '/admin/api/v1/administrators/adm_1' && method === 'DELETE') return new Response(null, { status: 204 });
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Administrators Admin surface', () => {
  it('lists Administrators with their Permission and fail closed Owner-only actions', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/administrators');
    setupFetch();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Administrators' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /Administrator accounts/ });
    expect(within(table).getByText('colleague@example.test')).toBeInTheDocument();
    expect(within(table).getByText('Read only')).toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();
  });

  it('creates an Administrator with a normalised Custom Permission', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/administrators');
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Administrators' });

    await userEvent.click(screen.getByRole('button', { name: 'Create Administrator' }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('Email'), 'second@example.test');
    await userEvent.type(dialog.getByLabelText('Initial password'), 'administrator-password');
    await userEvent.selectOptions(dialog.getByLabelText('Permission preset'), 'custom');
    await userEvent.click(dialog.getByLabelText('audit.read'));
    await userEvent.click(dialog.getByRole('button', { name: 'Create Administrator' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/admin/api/v1/administrators' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([input, init]) => String(input) === '/admin/api/v1/administrators' && (init as RequestInit | undefined)?.method === 'POST');
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as { permission: { preset: string; customPermissionVersion: number; customOperations: string[] } };
    expect(body.permission).toEqual({ preset: 'custom', customPermissionVersion: 1, customOperations: ['audit.read'] });
  });

  it('disables, lists sessions, and deletes an Administrator', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/administrators');
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Administrators' });

    await userEvent.click(screen.getByRole('button', { name: 'Disable colleague@example.test' }));
    await waitFor(() => expect(screen.getByText('Administrator disabled and all sessions revoked.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Sessions colleague@example.test' }));
    const sessionsDialog = within(await screen.findByRole('dialog', { name: 'Administrator sessions' }));
    expect(await sessionsDialog.findByText(/Expires/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Delete colleague@example.test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Administrator' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/admin/api/v1/administrators/adm_1' && (init as RequestInit | undefined)?.method === 'DELETE')).toBe(true));
  });

  it('maps an Owner-only rejection to a clear recovery message', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/administrators');
    setupFetch({ createError: { status: 403, code: 'FORBIDDEN' } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Administrators' });

    await userEvent.click(screen.getByRole('button', { name: 'Create Administrator' }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('Email'), 'second@example.test');
    await userEvent.type(dialog.getByLabelText('Initial password'), 'administrator-password');
    await userEvent.click(dialog.getByRole('button', { name: 'Create Administrator' }));

    expect(await screen.findByText('Only the Owner can manage Administrators.')).toBeInTheDocument();
  });
});