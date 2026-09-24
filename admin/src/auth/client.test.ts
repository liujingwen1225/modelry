import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOwner,
  fetchBootstrapStatus,
  fetchOwnerSession,
  loginOwner,
  logoutOwner,
} from './client';
import { ApiClientError } from '../api/client';

afterEach(() => vi.unstubAllGlobals());

describe('Admin authentication API client', () => {
  it('uses the canonical Control Plane paths and same-origin Owner cookies', async () => {
    const responses = [
      { state: 'required' },
      { owner: { id: 'owner_1', email: 'owner@example.com' }, session: { expiresAt: '2026-09-25T10:00:00Z' } },
      { owner: { id: 'owner_1', email: 'owner@example.com' }, session: { expiresAt: '2026-09-25T10:00:00Z' } },
      { owner: { id: 'owner_1', email: 'owner@example.com' }, expiresAt: '2026-09-25T10:00:00Z' },
    ];
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(Response.json(responses[0])))
      .mockImplementationOnce(() => Promise.resolve(Response.json(responses[1], { status: 201 })))
      .mockImplementationOnce(() => Promise.resolve(Response.json(responses[2])))
      .mockImplementationOnce(() => Promise.resolve(Response.json(responses[3])))
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBootstrapStatus();
    await createOwner({ email: 'owner@example.com', password: 'first-secret' });
    await loginOwner({ email: 'owner@example.com', password: 'login-secret' });
    await fetchOwnerSession();
    await logoutOwner();

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/api/v1/bootstrap/status',
      '/admin/api/v1/bootstrap/owner',
      '/admin/api/v1/auth/login',
      '/admin/api/v1/auth/session',
      '/admin/api/v1/auth/logout',
    ]);
    for (const [index, [, init]] of fetchMock.mock.calls.entries()) {
      expect(init).toEqual(expect.objectContaining({
        credentials: index === 0 ? 'omit' : 'include',
        mode: 'same-origin',
        cache: 'no-store',
      }));
    }
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'first-secret' }),
    }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'login-secret' }),
    }));
    expect(fetchMock.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
  });

  it('preserves structured bootstrap errors and rejects malformed successful responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        error: {
          code: 'BOOTSTRAP_UNAVAILABLE',
          message: 'Owner setup is temporarily unavailable.',
          details: { violations: [{ path: '/email', code: 'INVALID', message: 'Enter a valid email.' }] },
          hint: 'Check the Runtime and try again.',
          requestId: 'req_body',
        },
      }, { status: 503, headers: { 'X-Request-Id': 'req_header' } }))
      .mockResolvedValueOnce(Response.json({ state: 'unknown' }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBootstrapStatus()).rejects.toMatchObject({
      status: 503,
      apiError: {
        code: 'BOOTSTRAP_UNAVAILABLE',
        message: 'Owner setup is temporarily unavailable.',
        details: { violations: [{ path: '/email', code: 'INVALID', message: 'Enter a valid email.' }] },
        hint: 'Check the Runtime and try again.',
        requestId: 'req_header',
      },
    } satisfies Partial<ApiClientError>);
    await expect(fetchBootstrapStatus()).rejects.toMatchObject({
      status: 200,
      apiError: { code: 'INTERNAL_ERROR', message: 'The Runtime returned an invalid authentication response.', details: { expected: 'state: required | closed' }, requestId: 'unavailable' },
    } satisfies Partial<ApiClientError>);
  });
});
