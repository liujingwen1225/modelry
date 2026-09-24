import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './client';
import { fetchRuntimeStatus, fetchStorageStatus } from './status';

afterEach(() => vi.unstubAllGlobals());

describe('diagnostic API client', () => {
  it('reads the real runtime snapshot without sending an Owner session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      state: 'ready',
      observedAt: '2026-09-24T09:00:00Z',
      database: { state: 'ready' },
      localStorage: { state: 'ready' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await fetchRuntimeStatus();

    expect(status.state).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/runtime/status', expect.objectContaining({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }));
  });

  it('reads the storage provider and health through its canonical endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      database: { state: 'ready' },
      localStorage: { state: 'ready', provider: 'Local' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await fetchStorageStatus();

    expect(status.localStorage.provider).toBe('Local');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/storage/status', expect.any(Object));
  });

  it('preserves the structured error envelope and canonical response request id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'STORAGE_UNAVAILABLE',
        message: 'Local storage is unavailable.',
        details: { check: 'write-access' },
        hint: 'Check the project storage.',
        requestId: 'req_body_value_1234',
      },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_header_value_1234' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRuntimeStatus()).rejects.toMatchObject({
      status: 503,
      apiError: {
        code: 'STORAGE_UNAVAILABLE',
        message: 'Local storage is unavailable.',
        details: { check: 'write-access' },
        hint: 'Check the project storage.',
        requestId: 'req_header_value_1234',
      },
    } satisfies Partial<ApiClientError>);
  });

  it('returns a structured client error if a successful response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', {
      status: 200,
      headers: { 'X-Request-Id': 'req_invalid_body_1234' },
    })));

    await expect(fetchRuntimeStatus()).rejects.toMatchObject({
      status: 200,
      apiError: { code: 'INTERNAL_ERROR', requestId: 'req_invalid_body_1234' },
    });
  });
});
