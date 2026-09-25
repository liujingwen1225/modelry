import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OwnerSessionProvider, useOwnerSession } from './owner-session';

function SessionProbe() {
  const { state, refresh, logout } = useOwnerSession();
  return (
    <section>
      <output aria-label="Session state">{state.status}</output>
      {state.status === 'anonymous' && <output aria-label="Session expired">{String(state.sessionExpired)}</output>}
      {state.status === 'authenticated' && <p>{state.session.owner.email}</p>}
      {state.status === 'error' && <p>{String(state.error)}</p>}
      <button onClick={() => void refresh()} type="button">Refresh</button>
      <button onClick={() => void logout()} type="button">Sign out</button>
    </section>
  );
}

describe('Owner session provider', () => {
  it('loads the durable Owner identity and revokes the session on sign out', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        owner: { id: 'owner_42', email: 'dev@example.com' },
        expiresAt: '2030-01-01T00:00:00Z',
        role: 'owner',
        permission: { preset: 'fullAccess' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<OwnerSessionProvider><SessionProbe /></OwnerSessionProvider>);

    expect(await screen.findByLabelText('Session state')).toHaveTextContent('authenticated');
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByLabelText('Session state')).toHaveTextContent('anonymous'));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/api/v1/auth/session',
      '/admin/api/v1/auth/logout',
    ]);
    expect(window.sessionStorage.getItem('modelry-owner-session-active')).toBeNull();
    for (const [, init] of fetchMock.mock.calls) expect(init).toEqual(expect.objectContaining({ credentials: 'include' }));
  });

  it('treats an unauthorized session as anonymous and does not expose a stale Owner', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      error: { code: 'UNAUTHORIZED', message: 'Sign in required.', details: {}, requestId: 'req_unauthenticated' },
    }, { status: 401 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<OwnerSessionProvider><SessionProbe /></OwnerSessionProvider>);

    expect(await screen.findByLabelText('Session state')).toHaveTextContent('anonymous');
    expect(screen.getByLabelText('Session expired')).toHaveTextContent('false');
    expect(screen.queryByText('dev@example.com')).not.toBeInTheDocument();
  });

  it('shows an expiry hint only when a previously active session is rejected', async () => {
    window.sessionStorage.setItem('modelry-owner-session-active', 'true');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required.', details: {}, requestId: 'req_expired' },
    }, { status: 401 }))));
    render(<OwnerSessionProvider><SessionProbe /></OwnerSessionProvider>);

    expect(await screen.findByLabelText('Session expired')).toHaveTextContent('true');
    });

  it('waits out a long-lived session instead of refreshing it in a loop', async () => {
    vi.useFakeTimers();
    try {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const fetchMock = vi.fn(() => Promise.resolve(Response.json({
        owner: { id: 'adm_1', email: 'colleague@example.test' },
        expiresAt,
        role: 'administrator',
        permission: { preset: 'readOnly' },
      })));
      vi.stubGlobal('fetch', fetchMock);
      render(<OwnerSessionProvider><SessionProbe /></OwnerSessionProvider>);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
