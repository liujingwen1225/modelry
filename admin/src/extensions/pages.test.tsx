import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';

const extension = {
  id: 'ext_demo', name: 'Normalize Profile', language: 'typescript', activeRevision: 2, enabled: false,
  bindingCount: 1, secretBindingCount: 1, originGrantCount: 1, updatedAt: '2026-09-25T09:00:00Z', createdAt: '2026-09-24T09:00:00Z',
  source: 'export function beforeCreate(context) { return { action: "allow", values: context.values }; }',
  bindings: [{ collectionId: 'col_profile', operation: 'create', phase: 'before' }],
  secretBindings: [{ alias: 'MAIL_KEY', secretId: 'sec_mail', secretName: 'Mail provider', configured: true }],
  allowedOrigins: ['https://api.example.test'],
};

const safeRun = {
  runId: 'run_demo', extensionId: 'ext_demo', revision: 2, collectionId: 'col_profile', recordId: 'rec_demo', eventId: 'evt_demo',
  operation: 'create', phase: 'afterCommit', status: 'failed', startedAt: '2026-09-25T09:10:00Z', completedAt: '2026-09-25T09:10:01Z',
  durationMs: 1000, errorCode: 'externalRequestFailed', correlationId: 'req_safe',
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(extensionError?: { status: number; error: unknown }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return response({ owner: { id: 'own_test', email: 'owner@example.test' }, expiresAt: '2026-09-25T12:00:00Z', role: 'owner', permission: { preset: 'fullAccess' } });
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [{ id: 'col_profile', name: 'Profiles', type: 'Normal' }] });
    if (path === '/admin/api/v1/extensions' && method === 'GET') return response({ data: [extension] });
    if (path === '/admin/api/v1/extensions' && method === 'POST') return response({ data: extension }, 201);
    if (path === '/admin/api/v1/extensions/ext_demo' && method === 'GET') return response({ data: extension });
    if (path === '/admin/api/v1/extensions/ext_demo' && method === 'PUT') return extensionError
      ? response({ error: extensionError.error }, extensionError.status)
      : response({ data: extension });
    if (path.startsWith('/admin/api/v1/extensions/ext_demo/runs?')) return response({ data: [safeRun] });
    if (path === '/admin/api/v1/extensions/ext_demo/runs/run_demo') return response({ data: { ...safeRun, source: 'must-not-display', input: 'must-not-display', httpBody: 'must-not-display', secret: 'must-not-display' } });
    if (path === '/admin/api/v1/secrets' && method === 'GET') return response({ data: [{ id: 'sec_mail', name: 'Mail provider', configured: true, createdAt: '2026-09-24T09:00:00Z', updatedAt: '2026-09-24T09:00:00Z' }] });
    if (path === '/admin/api/v1/secrets' && method === 'POST') return response({ data: { id: 'sec_new', name: 'New provider', configured: true, createdAt: '2026-09-25T09:00:00Z', updatedAt: '2026-09-25T09:00:00Z' } }, 201);
    return response({ error: { code: 'NOT_FOUND', message: 'Not found', details: {}, requestId: 'req_test' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Extension and write-only Secret Admin surfaces', () => {
  it('opens the Extensions surface from the shared command palette', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    setupFetch();
    render(<App />);
    await screen.findByRole('navigation', { name: 'Project navigation' });
    await userEvent.click(screen.getByRole('button', { name: /Search commands/ }));
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox', { name: 'Search commands' });
    await userEvent.type(input, 'Extensions');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Extensions' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Normalize Profile/ })).toBeInTheDocument();
  });

  it('loads, edits, and saves the complete Extension configuration', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const fetchMock = setupFetch();
    window.history.replaceState({}, '', '/extensions/ext_demo?tab=settings&keep=deep-link');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Normalize Profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Allowed HTTPS origins')).toHaveValue('https://api.example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) =>
      path === '/admin/api/v1/extensions/ext_demo' && init?.method === 'PUT'
      && init.body === JSON.stringify({
        name: 'Normalize Profile', language: 'typescript', source: extension.source,
        bindings: [{ collectionId: 'col_profile', operation: 'create', phase: 'before' }],
        secretBindings: [{ alias: 'MAIL_KEY', secretId: 'sec_mail' }], allowedOrigins: ['https://api.example.test'],
      }),
    )).toBe(true));
    expect(window.location.search).toContain('keep=deep-link');
  });

  it('shows localized Extension field paths and binding conflict context safely', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    setupFetch({ status: 422, error: {
      code: 'VALIDATION_FAILED', message: 'ignored', requestId: 'req_validate',
      details: { violations: [{ path: '/source', code: 'invalidSource', message: 'secret source text' }] },
    } });
    window.history.replaceState({}, '', '/extensions/ext_demo?tab=settings&keep=route');
    render(<App />);

    expect(await screen.findByLabelText('允许的 HTTPS 来源')).toHaveAttribute('placeholder', 'https://api.example.com');
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText(/\/source: 请检查扩展源代码语法及支持的 API。/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret source text');
    expect(window.location.search).toContain('keep=route');
  });

  it('clears a Secret value after success and never renders its cleartext again', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const fetchMock = setupFetch();
    window.history.replaceState({}, '', '/secrets?q=provider#saved');
    render(<App />);
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Secret value');
    const cleartext = 'sensitive-provider-value';
    await user.type(screen.getByLabelText('Name'), 'New provider');
    await user.type(input, cleartext);
    await user.click(screen.getByRole('button', { name: 'Create Secret' }));

    await waitFor(() => expect(screen.getByLabelText('Secret value')).toHaveValue(''));
    expect(await screen.findByText('Secret saved. Its value has been cleared from the form.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(cleartext);
    const createCall = fetchMock.mock.calls.find(([path, init]) => path === '/admin/api/v1/secrets' && init?.method === 'POST');
    expect(createCall?.[1]?.body).toBe(JSON.stringify({ name: 'New provider', value: cleartext }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/secrets?q=provider#saved');
  });

  it('shows only allowlisted Hook Run metadata and keeps the cursor in the deep link', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const fetchMock = setupFetch();
    window.history.replaceState({}, '', '/extensions/ext_demo?tab=runs&cursor=cursor_a&back=cursor_before');
    render(<App />);

    expect(await screen.findByText('External request failed')).toBeInTheDocument();
    expect(screen.getByText('Record rec_demo')).toHaveAttribute('href', '/collections/col_profile?record=rec_demo');
    await userEvent.click(screen.getByRole('button', { name: 'Safe details' }));
    expect(await screen.findByRole('heading', { name: 'Hook Run details' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('must-not-display');
    expect(fetchMock.mock.calls.some(([path]) => path === '/admin/api/v1/extensions/ext_demo/runs?limit=100&cursor=cursor_a')).toBe(true);
    expect(window.location.search).toContain('tab=runs');
    expect(window.location.search).toContain('cursor=cursor_a');
  });

  it('translates Secret controls to Simplified Chinese without losing route context', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    setupFetch();
    window.history.replaceState({}, '', '/secrets?q=mail#selected');
    render(<App />);
    await screen.findByRole('heading', { name: 'Secrets' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'zh-CN');
    expect(await screen.findByRole('heading', { name: '密钥' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建密钥' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/secrets?q=mail#selected');
  });
});
