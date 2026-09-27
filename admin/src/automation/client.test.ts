import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { createEventHook, createJob, createWebhook, getDelivery, listAutomationCollections, listAutomationSecrets, listDeliveries, listWebhooks, retryDelivery, sendWebhookTest, setEventHookEnabled, setJobEnabled, setWebhookEnabled, updateEventHook, updateJob, updateWebhook } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Webhooks, Jobs, and Deliveries client', () => {
  it('returns only the Webhook contract fields and uses the same-origin Admin API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{
      id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://hooks.example.test/events',
      signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true,
      enabled: false, revision: 2, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
      secretValue: 'must-never-be-kept', payload: 'must-never-be-kept',
    }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWebhooks()).resolves.toEqual([{
      id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://hooks.example.test/events',
      signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true,
      enabled: false, revision: 2, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
    }]);
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/webhooks', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    }));
  });

  it('creates and replaces Webhook configuration and uses explicit state and test actions', async () => {
    const webhook = {
      id: 'whk_mail', name: 'Mail receiver', targetUrl: 'https://hooks.example.test/events',
      signingSecretId: 'sec_mail', signingSecretName: 'Mail signing', signingConfigured: true,
      enabled: false, revision: 1, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z',
    };
    const delivery = {
      id: `dlv_${'a'.repeat(36)}`, sourceType: 'test', sourceId: 'whk_mail', webhookId: 'whk_mail',
      webhookName: 'Mail receiver', webhookRevision: 1, eventType: 'webhook.test', status: 'pending',
      createdAt: '2026-09-25T00:00:00Z', attemptCount: 0, manualRedriveCount: 0, errorCode: 'none',
      payload: 'must-never-be-kept', responseBody: 'must-never-be-kept', targetUrl: 'https://private.example.test/path',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: webhook }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ data: { ...webhook, revision: 2 } }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'whk_mail', enabled: true } }))
      .mockResolvedValueOnce(Response.json({ data: delivery }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { name: 'Mail receiver', targetUrl: 'https://hooks.example.test/events', signingSecretId: 'sec_mail' };

    await createWebhook(input);
    await updateWebhook('whk/mail', input);
    await expect(setWebhookEnabled('whk_mail', true)).resolves.toEqual({ id: 'whk_mail', enabled: true });
    const tested = await sendWebhookTest('whk_mail');
    expect(JSON.stringify(tested)).not.toContain('must-never-be-kept');
    expect(JSON.stringify(tested)).not.toContain('private.example.test');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/admin/api/v1/webhooks', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/admin/api/v1/webhooks/whk%2Fmail', expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/admin/api/v1/webhooks/whk_mail/enable', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/admin/api/v1/webhooks/whk_mail/test', expect.objectContaining({ method: 'POST' }));
  });

  it('creates Event Hooks and UTC Jobs with explicit state actions and server next-run time', async () => {
    const eventHook = { id: 'ehk_posts', name: 'New posts', collectionId: 'col_posts', collectionName: 'Posts', eventType: 'record.created', webhookId: 'whk_mail', webhookName: 'Mail receiver', enabled: false, createdAt: 'now', updatedAt: 'now' };
    const job = { id: 'job_daily', name: 'Daily digest', webhookId: 'whk_mail', webhookName: 'Mail receiver', cron: '0 9 * * *', enabled: false, nextRunAt: '2026-09-26T09:00:00Z', createdAt: 'now', updatedAt: 'now', payload: 'must-never-be-kept' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: eventHook }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ data: eventHook }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'ehk_posts', enabled: true } }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'ehk_posts', enabled: false } }))
      .mockResolvedValueOnce(Response.json({ data: job }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ data: job }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'job_daily', enabled: true, nextRunAt: '2026-09-26T09:00:00Z' } }));
    vi.stubGlobal('fetch', fetchMock);

    const eventInput = { name: 'New posts', collectionId: 'col_posts', eventType: 'record.created' as const, webhookId: 'whk_mail' };
    const jobInput = { name: 'Daily digest', webhookId: 'whk_mail', cron: '0 9 * * *' };
    expect(await createEventHook(eventInput)).toMatchObject({ id: 'ehk_posts', eventType: 'record.created' });
    expect(await updateEventHook('ehk/posts', eventInput)).toMatchObject({ id: 'ehk_posts', collectionId: 'col_posts' });
    await expect(setEventHookEnabled('ehk_posts', true)).resolves.toEqual({ id: 'ehk_posts', enabled: true });
    await expect(setEventHookEnabled('ehk_posts', false)).resolves.toEqual({ id: 'ehk_posts', enabled: false });
    expect(await createJob(jobInput)).toMatchObject({ id: 'job_daily', nextRunAt: '2026-09-26T09:00:00Z' });
    expect(await updateJob('job/daily', jobInput)).toMatchObject({ id: 'job_daily', cron: '0 9 * * *' });
    await expect(setJobEnabled('job_daily', true)).resolves.toEqual({ id: 'job_daily', enabled: true, nextRunAt: '2026-09-26T09:00:00Z' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/admin/api/v1/event-hooks', expect.objectContaining({ method: 'POST', body: JSON.stringify(eventInput) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/admin/api/v1/event-hooks/ehk%2Fposts', expect.objectContaining({ method: 'PUT', body: JSON.stringify(eventInput) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/admin/api/v1/event-hooks/ehk_posts/enable', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/admin/api/v1/event-hooks/ehk_posts/disable', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/admin/api/v1/jobs', expect.objectContaining({ method: 'POST', body: JSON.stringify(jobInput) }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/admin/api/v1/jobs/job%2Fdaily', expect.objectContaining({ method: 'PUT', body: JSON.stringify(jobInput) }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/admin/api/v1/jobs/job_daily/enable', expect.objectContaining({ method: 'POST' }));
  });

  it('keeps Delivery pages and details bounded, filtered, and free of request or response content', async () => {
    const delivery = {
      id: `dlv_${'b'.repeat(36)}`, sourceType: 'eventHook', sourceId: 'ehk_posts', webhookId: 'whk_mail', webhookName: 'Mail receiver',
      webhookRevision: 3, eventId: 'evt_posts_00000000000000000001', eventType: 'record.created', status: 'failed',
      createdAt: '2026-09-25T00:00:00Z', attemptCount: 1, manualRedriveCount: 0, lastHttpStatus: 503, errorCode: 'externalRequestFailed',
      payload: 'private record content', responseBody: 'remote response content', targetUrl: 'https://private.example.test/path',
    };
    const attempt = { round: 1, attempt: 1, webhookRevision: 3, status: 'failed', startedAt: '2026-09-25T00:00:01Z', completedAt: '2026-09-25T00:00:02Z', durationMs: 1000, httpStatus: 503, errorCode: 'externalRequestFailed', responseBody: 'must-not-be-kept' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [delivery], nextCursor: 'opaque-next' }))
      .mockResolvedValueOnce(Response.json({ data: { ...delivery, attempts: [attempt] } }))
      .mockResolvedValueOnce(Response.json({ data: { ...delivery, status: 'pending', attemptCount: 2, manualRedriveCount: 1 } }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDeliveries({ cursor: 'opaque cursor', limit: 25, sourceType: 'eventHook', status: 'failed' })).resolves.toMatchObject({
      data: [{ id: delivery.id, status: 'failed', errorCode: 'externalRequestFailed' }], nextCursor: 'opaque-next',
    });
    const detail = await getDelivery(delivery.id);
    expect(detail.attempts).toEqual([{
      round: 1, attempt: 1, webhookRevision: 3, status: 'failed', startedAt: '2026-09-25T00:00:01Z',
      completedAt: '2026-09-25T00:00:02Z', durationMs: 1000, httpStatus: 503, errorCode: 'externalRequestFailed',
    }]);
    expect(JSON.stringify(detail)).not.toContain('private record content');
    expect(JSON.stringify(detail)).not.toContain('remote response content');
    expect(JSON.stringify(detail)).not.toContain('private.example.test');
    await expect(retryDelivery(delivery.id)).resolves.toMatchObject({ id: delivery.id, status: 'pending', manualRedriveCount: 1 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/admin/api/v1/deliveries?cursor=opaque+cursor&limit=25&sourceType=eventHook&status=failed', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/admin/api/v1/deliveries/${delivery.id}`, expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `/admin/api/v1/deliveries/${delivery.id}/retry`, expect.objectContaining({ method: 'POST' }));
  });

  it('keeps API validation useful without retaining raw messages or untrusted values', async () => {
    const privateValue = 'https://hooks.example.test/private?token=never-show-this';
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: {
      code: 'VALIDATION_FAILED', message: `Rejected ${privateValue}`,
      details: { violations: [
        { path: '/targetUrl', code: 'invalidWebhookUrl', message: privateValue },
        { path: '/targetUrl', code: 'untrusted', message: privateValue },
        { path: '/secret', code: 'invalidWebhookUrl', message: privateValue },
      ], targetUrl: privateValue },
    } }, { status: 422, headers: { 'X-Request-Id': 'req_safe123' } }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createWebhook({ name: 'Receiver', targetUrl: privateValue, signingSecretId: 'sec_mail' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ apiError: { code: 'VALIDATION_FAILED', requestId: 'req_safe123', details: {
      violations: [{ path: '/targetUrl', code: 'invalidWebhookUrl', message: 'Review this field.' }],
    } } });
    expect(JSON.stringify(error)).not.toContain(privateValue);
  });

  it('loads only Collection and write-only Secret choices needed by Automation forms', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'sec_mail', name: 'Mail signing', configured: true, value: 'never-render-this-secret' }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'col_posts', name: 'Posts', fields: [{ name: 'private-field' }] }], nextCursor: 'next' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'col_users', name: 'Users', records: [{ email: 'private@example.test' }] }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAutomationSecrets()).resolves.toEqual([{ id: 'sec_mail', name: 'Mail signing', configured: true }]);
    await expect(listAutomationCollections()).resolves.toEqual([{ id: 'col_posts', name: 'Posts' }, { id: 'col_users', name: 'Users' }]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/admin/api/v1/secrets', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/admin/api/v1/collections?limit=100', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/admin/api/v1/collections?limit=100&cursor=next', expect.objectContaining({ method: 'GET' }));
  });
});
