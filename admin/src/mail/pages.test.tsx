import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';

const provider = {
  enabled: false,
  host: '',
  port: 587,
  security: 'startTLS',
  fromAddress: '',
  fromName: '',
  username: null,
  password: null,
  revision: 1,
  updatedAt: '2026-09-25T09:00:00Z',
};

const delivery = {
  id: 'dly_1',
  kind: 'passwordReset',
  recipient: 'member@example.test',
  status: 'failed',
  attempts: 3,
  nextAttemptAt: null,
  errorCode: 'MAIL_UNAVAILABLE',
  createdAt: '2026-09-25T09:00:00Z',
  completedAt: null,
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(options: { saveError?: { status: number; code: string } } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return response({ owner: { id: 'own_test', email: 'owner@example.test' }, expiresAt: '2026-09-25T12:00:00Z', role: 'owner', permission: { preset: 'fullAccess' } });
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [] });
    if (path === '/admin/api/v1/mail' && method === 'GET') return response({ data: provider });
    if (path === '/admin/api/v1/mail' && method === 'PUT') {
      if (options.saveError) return response({ error: { code: options.saveError.code, message: 'no', details: {}, requestId: 'req_test' } }, options.saveError.status);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return response({ data: { ...provider, enabled: Boolean(body.enabled), host: String(body.host), fromAddress: String(body.fromAddress), revision: 2 } });
    }
    if (path === '/admin/api/v1/mail/deliveries' && method === 'GET') return response({ data: [delivery] });
    if (path === '/admin/api/v1/mail/deliveries/dly_1/retry' && method === 'POST') return response({ data: { ...delivery, status: 'pending', attempts: 3 } });
    if (path === '/admin/api/v1/secrets' && method === 'GET') return response({ data: [{ id: 'sec_smtp', name: 'SMTP password', configured: true }] });
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Mail settings Admin surface', () => {
  it('shows the durable delivery history with its last error code', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/mail');
    setupFetch();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Mail', level: 1 })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /Recent Mail deliveries/ });
    expect(within(table).getByText('member@example.test')).toBeInTheDocument();
    expect(within(table).getByText('MAIL_UNAVAILABLE')).toBeInTheDocument();
  });

  it('saves the SMTP provider with the expected configuration revision', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/mail');
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Mail', level: 1 });

    await userEvent.selectOptions(screen.getByLabelText('Enabled'), 'enabled');
    await userEvent.type(screen.getByLabelText('Host'), 'smtp.example.test');
    await userEvent.type(screen.getByLabelText('From address'), 'noreply@example.test');
    await userEvent.selectOptions(screen.getByLabelText('Password Secret'), 'sec_smtp');
    await userEvent.click(screen.getByRole('button', { name: 'Save Mail provider' }));

    await waitFor(() => expect(screen.getByText('Mail provider saved.')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([input, init]) => String(input) === '/admin/api/v1/mail' && (init as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as { expectedRevision: number; passwordSecretId: string };
    expect(body.expectedRevision).toBe(1);
    expect(body.passwordSecretId).toBe('sec_smtp');
  });

  it('explains the fail closed Mail configuration requirement instead of faking success', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/mail');
    setupFetch({ saveError: { status: 409, code: 'MAIL_NOT_CONFIGURED' } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Mail', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Save Mail provider' }));
    expect(await screen.findByText(/Enable the Mail provider with host, port, sender address, and credential Secrets first./)).toBeInTheDocument();
  });

  it('queues another delivery attempt from the delivery history', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/settings/mail');
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByRole('heading', { name: 'Mail', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Retry member@example.test' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/admin/api/v1/mail/deliveries/dly_1/retry' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    expect(await screen.findByText('Delivery queued for another attempt.')).toBeInTheDocument();
  });
});