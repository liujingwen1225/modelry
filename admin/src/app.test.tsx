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
  it('renders the shared sidebar and reads runtime health through the diagnostics client', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input))));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    await waitFor(() => expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page'));
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Overview', 'Collections', 'API', 'Changes', 'Access', 'Extensions', 'Secrets', 'Settings',
    ]);
    expect(navigation).not.toHaveTextContent(/Activity/);
    expect(await screen.findByText('Runtime ready')).toBeInTheDocument();
    const storageCard = screen.getByRole('heading', { name: 'Local project data' }).closest('.diagnostic-card');
    expect(storageCard).not.toBeNull();
    expect(await within(storageCard as HTMLElement).findByText('Local', { exact: true })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/runtime/status', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/storage/status', expect.any(Object));
  });

  it('persists a keyboard reachable light and dark theme toggle', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('modelry-admin-locale', 'en');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    const mounted = render(<App />);
    const darkThemeButton = await screen.findByRole('button', { name: 'Switch to dark theme' });
    const ownerMenu = document.querySelector('.owner-menu');
    expect(ownerMenu?.querySelector('.theme-button')).toBeNull();

    darkThemeButton.focus();
    await user.keyboard('{Enter}');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('modelry-admin-theme')).toBe('dark');

    mounted.unmount();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('switches shell locale without changing the current deep link or translating project data', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/?filter=keep#selected');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    const mounted = render(<App />);

    const language = await screen.findByRole('combobox', { name: 'Language' });
    const navigation = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(within(navigation).getByRole('link', { name: 'Collections' })).toBeInTheDocument();
    await user.selectOptions(language, 'zh-CN');

    expect(await screen.findByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '集合' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?filter=keep#selected');
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
    expect(window.localStorage.getItem('modelry-admin-locale')).toBe('zh-CN');

    mounted.unmount();
    render(<App />);
    expect(await screen.findByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?filter=keep#selected');
  });

  it('opens the shared command palette from the keyboard and executes real navigation', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Project navigation' });
    const trigger = screen.getByRole('button', { name: /Search commands/ });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox', { name: 'Search commands' });
    await user.type(input, 'Settings');
    expect(within(dialog).getByRole('option', { name: 'Settings' })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('traps palette focus, closes with Escape, restores focus, and hides out-of-context commands', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Project navigation' });
    const trigger = screen.getByRole('button', { name: /Search commands/ });

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox', { name: 'Search commands' });
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Close command palette' })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const reopened = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(reopened).getByRole('combobox', { name: 'Search commands' }), 'Create record');
    expect(within(reopened).queryByRole('option')).not.toBeInTheDocument();
    expect(within(reopened).getByRole('status')).toHaveTextContent('No commands match');
  });

  it('does not offer collection detail commands on the Create Collection route', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Project navigation' });

    await user.click(screen.getByRole('button', { name: /Search commands/ }));
    let palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox', { name: 'Search commands' }), 'Create Collection');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Create Collection' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Search commands/ }));
    palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox', { name: 'Search commands' }), 'Create record');
    expect(within(palette).queryByRole('option')).not.toBeInTheDocument();
    expect(within(palette).getByRole('status')).toHaveTextContent('No commands match');
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
