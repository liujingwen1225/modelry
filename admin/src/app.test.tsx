import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './app';

function diagnosticResponse(path: string): Response {
  if (path.endsWith('/auth/session')) {
    return new Response(JSON.stringify({
      owner: { id: 'own_test', email: 'owner@example.com' },
      expiresAt: '2026-09-25T09:00:00Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (path.endsWith('/runtime/status')) {
    return new Response(JSON.stringify({
      state: 'ready',
      observedAt: '2026-09-24T09:00:00Z',
      database: { state: 'ready' },
      localStorage: { state: 'ready' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    database: { state: 'ready' },
    localStorage: { state: 'ready', provider: 'Local' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Modelry Admin shell', () => {
  it('renders the exact V0.1 sidebar and reads runtime health through the diagnostics client', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input))));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    await waitFor(() => expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page'));
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Overview', 'Collections', 'API', 'Changes', 'Access', 'Settings',
    ]);
    expect(navigation).not.toHaveTextContent(/Hooks|Activity|Secrets/);
    expect(await screen.findByText('Runtime ready')).toBeInTheDocument();
    const storageCard = screen.getByRole('heading', { name: 'Local project data' }).closest('.diagnostic-card');
    expect(storageCard).not.toBeNull();
    expect(await within(storageCard as HTMLElement).findByText('Local', { exact: true })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/runtime/status', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/storage/status', expect.any(Object));
  });

  it('persists a keyboard reachable light and dark theme toggle', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);
    const darkThemeButton = await screen.findByRole('button', { name: 'Switch to dark theme' });

    darkThemeButton.focus();
    await user.keyboard('{Enter}');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('modelry-admin-theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('keeps the workspace private and starts first-run setup when no Owner session exists', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/session')) {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 'UNAUTHENTICATED', message: 'An Owner session is required.', details: {}, requestId: 'req_test' },
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path.endsWith('/bootstrap/status')) {
        return Promise.resolve(new Response(JSON.stringify({ state: 'required' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(diagnosticResponse(path));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Create your Modelry owner' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Project navigation' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/auth/session', expect.objectContaining({ credentials: 'include' }));
  });

  it('returns an expired Owner to sign-in with the attempted deep link preserved', async () => {
    window.sessionStorage.setItem('modelry-owner-session-active', 'true');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/session')) {
        return Promise.resolve(Response.json({
          error: { code: 'UNAUTHENTICATED', message: 'The supplied credentials could not be validated.', details: {}, requestId: 'req_expired' },
        }, { status: 401 }));
      }
      if (path.endsWith('/bootstrap/status')) return Promise.resolve(Response.json({ state: 'closed' }));
      return Promise.resolve(diagnosticResponse(path));
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/collections?search=draft#schema');
    render(<App />);

    expect(await screen.findByText('Your session expired. Sign in to continue.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(new URLSearchParams(window.location.search).get('returnTo')).toBe('/collections?search=draft#schema');
  });
});
