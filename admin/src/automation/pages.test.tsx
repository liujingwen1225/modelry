import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistryProvider } from '../components/command-registry';
import { LocaleProvider } from '../i18n/i18n';
import { AutomationPage } from './pages';

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="Current URL">{location.pathname}{location.search}</output>;
}

function renderAutomation(path = '/automations') {
  return render(<LocaleProvider><CommandRegistryProvider><MemoryRouter initialEntries={[path]}>
    <CurrentLocation />
    <Routes><Route element={<AutomationPage />} path="/automations" /></Routes>
  </MemoryRouter></CommandRegistryProvider></LocaleProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Automation Admin surface', () => {
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

    renderAutomation('/automations?tab=webhooks&q=mail');

    expect(await screen.findByRole('heading', { name: 'Automations' })).toBeInTheDocument();
    expect(await screen.findByText('Mail receiver')).toBeInTheDocument();
    expect(screen.queryByText('https://private.example.test/secret-path')).not.toBeInTheDocument();
    expect(screen.queryByText('never-render-this-secret')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/automations?tab=webhooks&q=mail');
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

    renderAutomation('/automations?tab=webhooks&q=mail');
    await user.click(await screen.findByRole('button', { name: 'Create Webhook' }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/automations?tab=webhooks&q=mail&create=1');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Billing receiver');
    await user.type(screen.getByLabelText('HTTPS destination'), 'https://billing.example.test/hooks');
    await user.selectOptions(screen.getByLabelText('Signing Secret'), 'sec_mail');
    expect(screen.queryByText('never-render-this-secret')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Webhook' }));

    expect(await screen.findByText('Created successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/webhooks', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Billing receiver', targetUrl: 'https://billing.example.test/hooks', signingSecretId: 'sec_mail' }),
    }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/automations?tab=webhooks&q=mail');
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

    renderAutomation('/automations?tab=webhooks');
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

    renderAutomation('/automations?tab=webhooks&q=mail');
    await user.click(await screen.findByRole('button', { name: 'Edit Mail receiver' }));

    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/automations?tab=webhooks&q=mail&edit=whk_mail');
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

    renderAutomation('/automations?tab=webhooks');
    await user.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable Webhook?' });
    expect(dialog).toHaveTextContent('Disabling a Webhook cancels pending Event Hook and Job deliveries.');
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

    renderAutomation('/automations?tab=eventHooks&q=order');
    await user.click(await screen.findByRole('button', { name: 'Create Event Hook' }));
    expect(screen.getByText(/including applicable before and after field values/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Order created');
    await user.selectOptions(screen.getByLabelText('Collection'), 'col_orders');
    await user.selectOptions(screen.getByLabelText('Record Event'), 'record.created');
    await user.selectOptions(screen.getByLabelText('Webhook'), 'whk_mail');
    await user.click(screen.getByRole('button', { name: 'Save Event Hook' }));

    expect(await screen.findByText('Created successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/event-hooks', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Order created', collectionId: 'col_orders', eventType: 'record.created', webhookId: 'whk_mail' }) }));
    expect(screen.getByLabelText('Current URL')).toHaveTextContent('/automations?tab=eventHooks&q=order');
    expect(screen.queryByText('https://private.example.test/path')).not.toBeInTheDocument();
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

    renderAutomation('/automations?tab=jobs');
    await user.click(await screen.findByRole('button', { name: 'Create Job' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Daily report');
    await user.selectOptions(screen.getByLabelText('Webhook'), 'whk_mail');
    const cron = screen.getByRole('textbox', { name: /Cron schedule/ });
    await user.type(cron, '0 9 * * *');
    expect(screen.getByText(/Next run preview \(UTC\)/)).toBeInTheDocument();
    expect(screen.getByText(/Next run preview \(UTC\)/).closest('p')).toHaveTextContent(/\bUTC\b/);
    await user.clear(cron);
    await user.type(cron, '@daily');
    expect(screen.getByText(/Enter a valid five-field Cron expression\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Job' })).toBeDisabled();
    await user.clear(cron);
    await user.type(cron, '0 9 * * *');
    await user.click(screen.getByRole('button', { name: 'Save Job' }));

    expect(await screen.findByText('Created successfully.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/jobs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Daily report', webhookId: 'whk_mail', cron: '0 9 * * *' }) }));
    expect(screen.queryByText('https://private.example.test/path')).not.toBeInTheDocument();
  });

  it('loads bounded Delivery history and shows safe attempt metadata without response or target contents', async () => {
    const sensitive = 'https://private.example.test/path response-body-is-private delivery-payload-is-private';
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50&sourceType=job&status=failed') return Promise.resolve(Response.json({ data: [{ id: 'dly_1', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 2, eventType: 'scheduled', status: 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 1, manualRedriveCount: 0, lastHttpStatus: 500, errorCode: 'externalRequestFailed', payload: sensitive, responseBody: sensitive, targetUrl: sensitive }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAutomation('/automations?tab=deliveries&source=job&status=failed');

    expect(await screen.findByText('Mail receiver')).toBeInTheDocument();
    expect(await screen.findByText('The remote request failed. Check the receiver and try again.')).toBeInTheDocument();
    expect(screen.queryByText(sensitive)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/deliveries?limit=50&sourceType=job&status=failed', expect.objectContaining({ method: 'GET' }));
  });

  it('shows safe attempt history and retries an eligible failed Delivery', async () => {
    const sensitive = 'https://private.example.test/path response-body-is-private delivery-payload-is-private secret-is-private';
    let retried = false;
    const summary = { id: 'dly_1', sourceType: 'job', sourceId: 'job_daily', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'scheduled', status: retried ? 'pending' : 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 1, manualRedriveCount: retried ? 1 : 0, lastHttpStatus: 500, errorCode: retried ? 'none' : 'externalRequestFailed' };
    const fetchMock = vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50') return Promise.resolve(Response.json({ data: [summary] }));
      if (path === '/admin/api/v1/deliveries/dly_1') return Promise.resolve(Response.json({ data: { ...summary, payload: sensitive, responseBody: sensitive, targetUrl: sensitive, secretValue: sensitive, attempts: [{ round: 1, attempt: 1, webhookRevision: 1, status: 'failed', startedAt: '2026-09-25T09:00:00Z', durationMs: 85, httpStatus: 500, errorCode: 'externalRequestFailed', responseBody: sensitive }] } }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: sensitive, signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, secretValue: sensitive, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      if (path === '/admin/api/v1/deliveries/dly_1/retry') { retried = true; return Promise.resolve(Response.json({ data: { ...summary, status: 'pending', manualRedriveCount: 1, errorCode: 'none' } }, { status: 202 })); }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderAutomation('/automations?tab=deliveries&deliveryId=dly_1');

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

  it('uses the shared Simplified Chinese locale for the Job Admin surface', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderAutomation('/automations?tab=jobs');

    expect(await screen.findByRole('heading', { name: '自动化' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '创建任务' })).toBeInTheDocument();
    expect(screen.getByText('使用五字段 UTC Cron 表达式定时发送信号。任务不会执行代码。')).toBeInTheDocument();
  });

  it('does not offer retry for a capacity-exceeded Delivery without a retained payload', async () => {
    const delivery = { id: 'dly_full', sourceType: 'test', sourceId: 'whk_mail', webhookId: 'whk_mail', webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'webhook.test', status: 'failed', createdAt: '2026-09-25T09:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'capacityExceeded' };
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50') return Promise.resolve(Response.json({ data: [delivery] }));
      if (path === '/admin/api/v1/deliveries/dly_full') return Promise.resolve(Response.json({ data: { ...delivery, attempts: [] } }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [{ id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://private.example.test/path', signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true, enabled: true, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderAutomation('/automations?tab=deliveries&deliveryId=dly_full');

    expect(await screen.findByText('The Delivery queue is full. Reduce pending work, then retry; this Delivery and its retry allowance are unchanged.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Delivery' })).not.toBeInTheDocument();
  });

  it('shows the complete Delivery ID with the Simplified Chinese label', async () => {
    const delivery = { id: 'dly_zh_1234', sourceType: 'test', sourceId: 'whk_mail', webhookId: 'whk_mail', webhookName: '收件 Webhook', webhookRevision: 1, eventType: 'webhook.test', status: 'succeeded', createdAt: '2026-09-25T09:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'none' };
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (path === '/admin/api/v1/deliveries?limit=50') return Promise.resolve(Response.json({ data: [delivery] }));
      if (path === '/admin/api/v1/deliveries/dly_zh_1234') return Promise.resolve(Response.json({ data: { ...delivery, attempts: [] } }));
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    }));

    renderAutomation('/automations?tab=deliveries&deliveryId=dly_zh_1234');

    expect(await screen.findByText('投递 ID')).toBeInTheDocument();
    expect(screen.getByText('dly_zh_1234', { exact: true })).toBeInTheDocument();
  });
});
