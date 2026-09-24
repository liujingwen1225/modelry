import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './app';

function diagnosticResponse(path: string): Response {
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

    const navigation = screen.getByRole('navigation', { name: 'Project navigation' });
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
    const darkThemeButton = screen.getByRole('button', { name: 'Switch to dark theme' });

    darkThemeButton.focus();
    await user.keyboard('{Enter}');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('modelry-admin-theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
