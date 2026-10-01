import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistryProvider } from '../components/command-registry';
import { LocaleProvider } from '../i18n/i18n';
import { EventsPage, HookDetailPage } from '../events/pages';
import { SchedulesPage } from '../schedules/pages';

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="Current URL">{location.pathname}{location.search}</output>;
}

// 新版信息架构（spec 0001 §3）：Hooks & Events 与定时任务是两个一级入口，
// 各自用 `?tab=` 表达工作面；这里按真实路由挂载页面组件。
function renderSurface(path: string) {
  return render(<LocaleProvider><CommandRegistryProvider><MemoryRouter initialEntries={[path]}>
    <CurrentLocation />
    <Routes>
      <Route element={<EventsPage />} path="/events" />
      <Route element={<HookDetailPage />} path="/events/hooks/:extensionId" />
      <Route element={<SchedulesPage />} path="/schedules" />
    </Routes>
  </MemoryRouter></CommandRegistryProvider></LocaleProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Hooks & Events and Scheduled jobs Admin surfaces', () => {
  it('shows safe Webhook summaries without rendering its destination or Secret value', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{
        id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/secret-path',
        signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true,
        enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
        secretValue: 'never-render-this-secret',
      }] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [{
        id: 'sec_mail', name: 'Mail signing', configured: true, createdAt: 'now', updatedAt: 'now', value: 'never-render-this-secret',
      }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSurface('/events?tab=webhooks&q=mail');

    expect(await screen.findByRole('heading', { name: 'Hooks & Events' })).toBeInTheDocument();
    expect(await screen.findByText('Mail receiver')).toBeInTheDocument();
    expect(screen.queryByText('https://private.example.test/secret-path')).not.toBeInTheDocument();
    expect(screen.queryByText('never-render-this-secret')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/events?tab=webhooks&q=mail');
  });

  it('keeps tabs as shareable links that preserve the rest of the query', async () => {
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));
    const user = userEvent.setup();

    renderSurface('/events?tab=deliveries&status=failed');
    expect(await screen.findByRole('link', { name: 'Delivery history' })).toHaveAttribute('aria-current', 'page');
    const webhooks = screen.getByRole('link', { name: 'Webhooks' });
    expect(webhooks).toHaveAttribute('href', '/events?tab=webhooks&status=failed');
    await user.click(webhooks);

    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/events?tab=webhooks&status=failed');
    expect(screen.getByRole('link', { name: 'Webhooks' })).toHaveAttribute('aria-current', 'page');
  });

  it('creates a Webhook with a write-only Secret selector and keeps the search context', async () => {
    const created = {
      id: 'whk_new', name: 'Billing receiver', targetUrl: 'https://billing.example.test/hooks',
      signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true,
      enabled: false, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
      secretValue: 'never-render-this-secret',
    };
    let createdOnce = false;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/webhooks' && init?.method === 'POST') {
        createdOnce = true;
        return Promise.resolve(Response.json({ data: created }, { status: 201 }));
      }
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: createdOnce ? [created] : [] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [{ id: 'sec_mail', name: 'Mail signing', configured: true, value: 'never-render-this-secret' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/events?tab=webhooks&q=mail');
    await user.click(await screen.findByRole('button', { name: 'Create Webhook' }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/events?tab=webhooks&q=mail&create=1');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Billing receiver');
    await user.type(screen.getByLabelText('HTTPS destination'), 'https://billing.example.test/hooks');
    await user.selectOptions(screen.getByLabelText('Signing Secret'), 'sec_mail');
    expect(screen.getByRole('link', { name: 'Manage Secrets' })).toHaveAttribute('href', '/settings/secrets');
    expect(screen.queryByText('never-render-this-secret')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Webhook' }));

    expect(await screen.findByText('Created successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/webhooks', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Billing receiver', targetUrl: 'https://billing.example.test/hooks', signingSecretId: 'sec_mail' }),
    }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/events?tab=webhooks&q=mail');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Billing receiver')).toBeInTheDocument();
    expect(screen.queryByText('never-render-this-secret')).not.toBeInTheDocument();
  });

  it('shows field-level validation without displaying a raw URL or server message', async () => {
    const privateValue = 'https://private.example.test/path?secret=never-show-this';
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/webhooks' && init?.method === 'POST') return Promise.resolve(Response.json({ error: {
        code: 'VALIDATION_FAILED', message: `Rejected ${privateValue}`,
        details: { violations: [{ path: '/targetUrl', code: 'invalidWebhookUrl', message: privateValue }], targetUrl: privateValue },
      } }, { status: 422 }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [{ id: 'sec_mail', name: 'Mail signing', configured: true }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/events?tab=webhooks');
    await user.click(await screen.findByRole('button', { name: 'Create Webhook' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Receiver');
    await user.type(screen.getByRole('textbox', { name: /HTTPS destination/ }), privateValue);
    await user.selectOptions(screen.getByLabelText('Signing Secret'), 'sec_mail');
    await user.click(screen.getByRole('button', { name: 'Save Webhook' }));

    expect(await screen.findByText('Enter an allowed HTTPS URL.')).toBeInTheDocument();
    expect(screen.queryByText(privateValue)).not.toBeInTheDocument();
    expect(screen.queryByText(`Rejected ${privateValue}`)).not.toBeInTheDocument();
  });

  it('opens a Webhook editor from its row and preserves the search in the deep link', async () => {
    const target = 'https://private.example.test/events';
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{
        id: 'whk_mail', name: 'Mail receiver', targetUrl: target, signingSecretId: 'sec_mail', signingSecretName: 'Mail signing',
        signingConfigured: true, enabled: false, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
      }] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [{ id: 'sec_mail', name: 'Mail signing', configured: true }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/events?tab=webhooks&q=mail');
    await user.click(await screen.findByRole('button', { name: 'Edit Mail receiver' }));

    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/events?tab=webhooks&q=mail&edit=whk_mail');
    expect(screen.getByLabelText('HTTPS destination')).toHaveValue(target);
    expect(screen.queryByText(target)).not.toBeInTheDocument();
  });

  it('confirms Webhook disable and explains cancellation before applying it', async () => {
    let enabled = true;
    const webhook = () => ({ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/events', signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, enabled, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' });
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/webhooks/whk_mail/disable') { enabled = false; return Promise.resolve(Response.json({ data: { id: 'whk_mail', enabled: false } })); }
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [webhook()] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [{ id: 'sec_mail', name: 'Mail signing', configured: true }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/events?tab=webhooks');
    await user.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable Webhook?' });
    expect(dialog).toHaveTextContent('Disabling a Webhook cancels pending event trigger and scheduled trigger deliveries.');
    await user.click(screen.getByRole('button', { name: 'Disable Webhook' }));

    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/webhooks/whk_mail/disable', expect.objectContaining({ method: 'POST' }));
  });

  it('creates an Event Hook with explicit value sharing consent and keeps tab context', async () => {
    const hook = { id: 'ehk_order', name: 'Order created', collectionId: 'col_orders', collectionName: 'Orders', eventType: 'record.created', webhookId: 'whk_mail', webhookName: 'Mail receiver', enabled: false, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
    let saved: typeof hook | undefined;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/event-hooks' && init?.method === 'POST') { saved = hook; return Promise.resolve(Response.json({ data: hook }, { status: 201 })); }
      if (path === '/admin/api/v1/event-hooks') return Promise.resolve(Response.json({ data: saved ? [saved] : [] }));
      if (path.startsWith('/admin/api/v1/collections?')) return Promise.resolve(Response.json({ data: [{ id: 'col_orders', name: 'Orders' }] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: '', signingConfigured: false, enabled: false, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/events?tab=triggers&q=order');
    await user.click(await screen.findByRole('button', { name: 'Create event trigger' }));
    expect(screen.getByText(/including applicable before and after field values/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Order created');
    await user.selectOptions(screen.getByLabelText('Collection'), 'col_orders');
    await user.selectOptions(screen.getByLabelText('Record Event'), 'record.created');
    await user.selectOptions(screen.getByLabelText('Webhook'), 'whk_mail');
    await user.click(screen.getByRole('button', { name: 'Save event trigger' }));

    expect(await screen.findByText('Created successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/event-hooks', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Order created', collectionId: 'col_orders', eventType: 'record.created', webhookId: 'whk_mail' }) }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/events?tab=triggers&q=order');
    expect(screen.queryByText('https://private.example.test/path')).not.toBeInTheDocument();
  });

  it('links an empty Event trigger form to the Webhooks surface for its missing prerequisite', async () => {
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/event-hooks') return Promise.resolve(Response.json({ data: [] }));
      if (path.startsWith('/admin/api/v1/collections?')) return Promise.resolve(Response.json({ data: [{ id: 'col_orders', name: 'Orders' }] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));
    const user = userEvent.setup();

    renderSurface('/events?tab=triggers');
    await user.click(await screen.findByRole('button', { name: 'Create event trigger' }));

    expect(screen.getByRole('link', { name: 'Create Webhook' })).toHaveAttribute('href', '/events?tab=webhooks&create=1');
  });

  it('previews a valid UTC Job schedule and rejects unsupported Cron before saving', async () => {
    const job = { id: 'job_daily', name: 'Daily report', webhookId: 'whk_mail', webhookName: 'Mail receiver', cron: '0 9 * * *', enabled: false, nextRunAt: '2026-09-26T09:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
    let saved: typeof job | undefined;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/jobs' && init?.method === 'POST') { saved = job; return Promise.resolve(Response.json({ data: job }, { status: 201 })); }
      if (path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: saved ? [saved] : [] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: '', signingConfigured: false, enabled: false, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/schedules?tab=jobs');
    await user.click(await screen.findByRole('button', { name: 'Create scheduled trigger' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Daily report');
    await user.selectOptions(screen.getByLabelText('Webhook'), 'whk_mail');
    const cron = screen.getByRole('textbox', { name: /Cron schedule/ });
    await user.type(cron, '0 9 * * *');
    expect(screen.getByText(/Next run preview \(UTC\)/)).toBeInTheDocument();
    expect(screen.getByText(/Next run preview \(UTC\)/).closest('p')).toHaveTextContent(/\bUTC\b/);
    await user.clear(cron);
    await user.type(cron, '@daily');
    expect(screen.getByText(/Enter a valid five-field Cron expression\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save scheduled trigger' })).toBeDisabled();
    await user.clear(cron);
    await user.type(cron, '0 9 * * *');
    await user.click(screen.getByRole('button', { name: 'Save scheduled trigger' }));

    expect(await screen.findByText('Created successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/jobs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Daily report', webhookId: 'whk_mail', cron: '0 9 * * *' }) }));
    expect(screen.queryByText('https://private.example.test/path')).not.toBeInTheDocument();
  });

  it('requests one manual Job run and keeps the durable server result in the panel', async () => {
    const job = { id: 'job_daily', name: 'Daily report', webhookId: 'whk_mail', webhookName: 'Mail receiver', cron: '0 9 * * *', enabled: true, nextRunAt: '2026-09-26T09:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
    const delivery = { id: 'dlv_manual_run', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'job.manual', status: 'pending', createdAt: '2026-09-25T09:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'none' };
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/jobs/job_daily/run' && init?.method === 'POST') return Promise.resolve(Response.json({ data: { ...delivery, payload: 'must-not-be-shown', targetUrl: 'https://private.example.test/path' } }, { status: 202 }));
      if (path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: [job] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/schedules?tab=jobs');
    await user.click(await screen.findByRole('button', { name: 'Run now' }));

    expect(await screen.findByText(/Manual run requested\. Execution dlv_manual_run is recorded in the history\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open execution history' })).toHaveAttribute('href', '/schedules?tab=history&deliveryId=dlv_manual_run');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/jobs/job_daily/run', expect.objectContaining({ method: 'POST' }));
    // 服务器响应是唯一事实来源：任务列表被重新加载，且响应中的敏感内容不进入页面。
    expect(fetchMock.mock.calls.filter(([path]) => path === '/admin/api/v1/jobs').length).toBeGreaterThan(1);
    expect(document.body.textContent).not.toContain('https://private.example.test/path');
    expect(document.body.textContent).not.toContain('must-not-be-shown');
  });

  it('explains a manual Job run rejected by the Webhook contract instead of showing success', async () => {
    const job = { id: 'job_daily', name: 'Daily report', webhookId: 'whk_mail', webhookName: 'Mail receiver', cron: '0 9 * * *', enabled: true, nextRunAt: '2026-09-26T09:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/jobs/job_daily/run' && init?.method === 'POST') return Promise.resolve(Response.json({ error: {
        code: 'VALIDATION_FAILED', message: 'ignored', requestId: 'req_run',
        details: { violations: [{ path: '/webhookId', code: 'invalidWebhook', message: 'ignored' }] },
      } }, { status: 422 }));
      if (path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: [job] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: '', signingConfigured: false, enabled: false, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/schedules?tab=jobs');
    await user.click(await screen.findByRole('button', { name: 'Run now' }));

    expect(await screen.findByText('Enable the linked Webhook and configure its signing Secret before running this Job manually.')).toBeInTheDocument();
    expect(screen.queryByText(/Manual run requested/)).not.toBeInTheDocument();
  });

  it('surfaces a terminal capacity-exceeded manual run without claiming it was dispatched', async () => {
    const job = { id: 'job_daily', name: 'Daily report', webhookId: 'whk_mail', webhookName: 'Mail receiver', cron: '0 9 * * *', enabled: true, nextRunAt: '2026-09-26T09:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
    const delivery = { id: 'dlv_full', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'job.manual', status: 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'capacityExceeded' };
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/jobs/job_daily/run' && init?.method === 'POST') return Promise.resolve(Response.json({ data: delivery }, { status: 202 }));
      if (path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: [job] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));
    const user = userEvent.setup();

    renderSurface('/schedules?tab=jobs');
    await user.click(await screen.findByRole('button', { name: 'Run now' }));

    expect(await screen.findByText('The run could not be dispatched because delivery capacity is full. Reduce the backlog and try again.')).toBeInTheDocument();
    expect(screen.queryByText(/Manual run requested/)).not.toBeInTheDocument();
  });

  it('shows Job execution history with a fixed job source and the trigger column', async () => {
    const scheduled = { id: 'dlv_scheduled', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'job.scheduled', status: 'succeeded', createdAt: '2026-09-25T09:00:00Z', attemptCount: 1, manualRedriveCount: 0, errorCode: 'none' };
    const manual = { id: 'dlv_manual', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'job.manual', status: 'pending', createdAt: '2026-09-25T10:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'none' };
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50&sourceType=job') return Promise.resolve(Response.json({ data: [manual, scheduled] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSurface('/schedules?tab=history');

    expect(await screen.findByRole('heading', { name: 'Execution history' })).toBeInTheDocument();
    // 等投递列表真正加载完成再断言触发方式列，避免在 loading 状态读取 DOM。
    // 两条投递使用同一个 Webhook，因此名称会匹配到两个卡片。
    expect(await screen.findAllByText('Mail receiver')).toHaveLength(2);
    expect(screen.getAllByText('Trigger')).toHaveLength(2);
    expect(screen.getByText('Manual run')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    // 来源已固定为 job：不提供来源筛选，查询始终带上 sourceType=job。
    expect(screen.queryByLabelText('Source')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/deliveries?limit=50&sourceType=job', expect.objectContaining({ method: 'GET' }));
  });

  it('loads bounded Delivery history and shows safe attempt metadata without response or target contents', async () => {
    const sensitive = 'https://private.example.test/path response-body-is-private delivery-payload-is-private';
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50&sourceType=job&status=failed') return Promise.resolve(Response.json({ data: [{ id: 'dly_1', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 2, eventType: 'job.scheduled', status: 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 1, manualRedriveCount: 0, lastHttpStatus: 500, errorCode: 'externalRequestFailed', payload: sensitive, responseBody: sensitive, targetUrl: sensitive }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSurface('/events?tab=deliveries&source=job&status=failed');

    expect(await screen.findByText('Mail receiver')).toBeInTheDocument();
    expect(await screen.findByText('The remote request failed. Check the receiver and try again.')).toBeInTheDocument();
    expect(screen.queryByText(sensitive)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/deliveries?limit=50&sourceType=job&status=failed', expect.objectContaining({ method: 'GET' }));
  });

  it('shows safe attempt history and retries an eligible failed Delivery', async () => {
    const sensitive = 'https://private.example.test/path response-body-is-private delivery-payload-is-private secret-is-private';
    let retried = false;
    const summary = { id: 'dly_1', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'job.scheduled', status: retried ? 'pending' : 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 1, manualRedriveCount: retried ? 1 : 0, lastHttpStatus: 500, errorCode: retried ? 'none' : 'externalRequestFailed' };
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50') return Promise.resolve(Response.json({ data: [summary] }));
      if (path === '/admin/api/v1/deliveries/dly_1') return Promise.resolve(Response.json({ data: { ...summary, payload: sensitive, responseBody: sensitive, targetUrl: sensitive, secretValue: sensitive, attempts: [{ round: 1, attempt: 1, webhookRevision: 1, status: 'failed', startedAt: '2026-09-25T09:00:00Z', durationMs: 85, httpStatus: 500, errorCode: 'externalRequestFailed', responseBody: sensitive }] } }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: sensitive, signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, secretValue: sensitive, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      if (path === '/admin/api/v1/deliveries/dly_1/retry') { retried = true; return Promise.resolve(Response.json({ data: { ...summary, status: 'pending', manualRedriveCount: 1, errorCode: 'none' } }, { status: 202 })); }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSurface('/events?tab=deliveries&deliveryId=dly_1');

    expect((await screen.findAllByRole('heading', { name: 'Mail receiver' })).length).toBe(2);
    expect(screen.getByText('Delivery ID')).toBeInTheDocument();
    expect(screen.getByText('dly_1', { exact: true })).toBeInTheDocument();
    expect((await screen.findAllByText('The remote request failed. Check the receiver and try again.')).length).toBeGreaterThan(0);
    expect(screen.getByText('85 ms')).toBeInTheDocument();
    expect(screen.queryByText(sensitive)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry Delivery' }));

    expect(await screen.findByText('A new bounded attempt round was queued for this Delivery.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/deliveries/dly_1/retry', expect.objectContaining({ method: 'POST' }));
    expect(screen.queryByText(sensitive)).not.toBeInTheDocument();
  });

  it('keeps a Hook detail under the Events route with its own editor context', async () => {
    const extension = {
      id: 'ext_demo', name: 'Normalize Profile', language: 'typescript', activeRevision: 2, enabled: false,
      bindingCount: 0, secretBindingCount: 0, originGrantCount: 0, updatedAt: '2026-09-25T09:00:00Z', createdAt: '2026-09-24T09:00:00Z',
      source: 'export function beforeCreate(context) { return { action: "allow" }; }',
      bindings: [], secretBindings: [], allowedOrigins: [],
    };
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/extensions/ext_demo') return Promise.resolve(Response.json({ data: extension }));
      if (path.startsWith('/admin/api/v1/collections?')) return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderSurface('/events/hooks/ext_demo');

    expect(await screen.findByRole('heading', { name: 'Normalize Profile' })).toBeInTheDocument();
    // Hook 列表的 canonical 路径是 `/events?tab=hooks`（裸 `/events/hooks` 会经 route-map 归一）。
    expect(screen.getByRole('link', { name: 'All Hooks' })).toHaveAttribute('href', '/events?tab=hooks');
  });

  it('uses the shared Simplified Chinese locale for the Scheduled jobs surface', async () => {
    const job = { id: 'job_daily', name: '每日报表', webhookId: 'whk_mail', webhookName: 'Mail receiver', cron: '0 9 * * *', enabled: true, nextRunAt: '2026-09-26T09:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: [job] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderSurface('/schedules?tab=jobs');

    expect(await screen.findByRole('heading', { name: '定时任务' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '创建定时触发' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即运行' })).toBeInTheDocument();
    expect(screen.getByText('按五字段 UTC Cron 计划发送 Webhook。定时触发不会执行代码。')).toBeInTheDocument();
  });

  it('does not offer retry for a capacity-exceeded Delivery without a retained payload', async () => {
    const delivery = { id: 'dly_full', sourceType: 'test', sourceId: 'whk_mail', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'webhook.test', status: 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'capacityExceeded' };
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50') return Promise.resolve(Response.json({ data: [delivery] }));
      if (path === '/admin/api/v1/deliveries/dly_full') return Promise.resolve(Response.json({ data: { ...delivery, attempts: [] } }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderSurface('/events?tab=deliveries&deliveryId=dly_full');

    expect(await screen.findByText('The Delivery queue is full. Reduce pending work, then retry; this Delivery and its retry allowance are unchanged.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Delivery' })).not.toBeInTheDocument();
  });

  it('shows the complete Delivery ID with the Simplified Chinese label', async () => {
    const delivery = { id: 'dly_zh_1234', sourceType: 'eventHook', sourceId: 'ehk_orders', webhookId: 'whk_mail', webhookName: '收件 Webhook', webhookRevision: 1, eventType: 'record.created', status: 'succeeded', createdAt: '2026-09-25T09:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'none' };
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50') return Promise.resolve(Response.json({ data: [delivery] }));
      if (path === '/admin/api/v1/deliveries/dly_zh_1234') return Promise.resolve(Response.json({ data: { ...delivery, attempts: [] } }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderSurface('/events?tab=deliveries&deliveryId=dly_zh_1234');

    expect(await screen.findByText('投递 ID')).toBeInTheDocument();
    expect(screen.getByText('dly_zh_1234', { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).toContain('记录已创建');
  });
});
