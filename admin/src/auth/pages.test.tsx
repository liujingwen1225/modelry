import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BootstrapPage, LoginPage, resolveOwnerReturnTo } from './pages';

describe('Owner bootstrap page', () => {
  it('shows loading before exposing the setup form for a required project', async () => {
    let resolveStatus: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveStatus = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    render(<BootstrapPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Checking project setup');
    resolveStatus?.(Response.json({ state: 'required' }));

    expect(await screen.findByRole('heading', { name: 'Create your Modelry owner' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('button', { name: 'Complete setup' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/bootstrap/status', expect.objectContaining({
      credentials: 'omit',
      mode: 'same-origin',
    }));
  });

  it('creates the Owner and keeps the returned identity and active session visible', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/bootstrap/status')) return Promise.resolve(Response.json({ state: 'required' }));
      return Promise.resolve(Response.json({
        owner: { id: 'owner_42', email: 'dev@example.com' },
        session: { expiresAt: '2026-09-25T10:00:00Z' },
      }, { status: 201 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    render(<BootstrapPage onAuthenticated={onAuthenticated} />);

    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'dev@example.com');
    await user.type(screen.getByLabelText('Password'), 'long-secret-value');
    await user.click(screen.getByRole('button', { name: 'Complete setup' }));

    expect(await screen.findByRole('heading', { name: 'Owner account ready' })).toBeInTheDocument();
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
    expect(screen.getByText('2026-09-25T10:00:00Z')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('owner_42');
    expect(onAuthenticated).toHaveBeenCalledWith({
      owner: { id: 'owner_42', email: 'dev@example.com' },
      session: { expiresAt: '2026-09-25T10:00:00Z' },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/admin/api/v1/bootstrap/owner');
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'dev@example.com', password: 'long-secret-value' }),
      credentials: 'include',
      mode: 'same-origin',
    }));
    expect(document.body).not.toHaveTextContent('long-secret-value');
  });

  it('shows field-level structured errors and rechecks bootstrap state for recovery', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/bootstrap/status')) {
        return Promise.resolve(Response.json({ state: fetchMock.mock.calls.length > 2 ? 'closed' : 'required' }));
      }
      return Promise.resolve(Response.json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The Owner could not be created.',
          details: { violations: [{ path: '/email', code: 'INVALID', message: 'Enter a valid email address.' }] },
          hint: 'Correct the email and retry.',
          requestId: 'req_bootstrap_validation',
        },
      }, { status: 422, headers: { 'X-Request-Id': 'req_bootstrap_validation' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BootstrapPage />);

    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'dev@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret-value');
    await user.click(screen.getByRole('button', { name: 'Complete setup' }));

    expect(await screen.findByRole('alert', { name: 'Owner setup could not be completed' })).toHaveTextContent('VALIDATION_FAILED');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter a valid email address.');
    expect(screen.getByText('req_bootstrap_validation')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Check setup status' }));
    expect(await screen.findByRole('heading', { name: 'Setup is already complete' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(document.body).not.toHaveTextContent('secret-value');
  });

  it('disables repeated submission while the real bootstrap request is pending', async () => {
    const user = userEvent.setup();
    let resolveCreate: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/bootstrap/status')) return Promise.resolve(Response.json({ state: 'required' }));
      return new Promise<Response>((resolve) => { resolveCreate = resolve; });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BootstrapPage />);

    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'dev@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret-value');
    const submit = screen.getByRole('button', { name: 'Complete setup' });
    await user.dblClick(submit);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating owner…' })).toBeDisabled());
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/bootstrap/owner'))).toHaveLength(1);
    resolveCreate?.(Response.json({
      owner: { id: 'owner_42', email: 'dev@example.com' },
      session: { expiresAt: '2026-09-25T10:00:00Z' },
    }, { status: 201 }));
    expect(await screen.findByRole('heading', { name: 'Owner account ready' })).toBeInTheDocument();
  });
});

describe('Owner sign-in page', () => {
  it('explains expired sessions on the sign-in surface', () => {
    render(<LoginPage sessionExpired />);

    expect(screen.getByRole('status')).toHaveTextContent('Your session expired. Sign in to continue.');
  });

  it('accepts only same-origin paths as a post-login destination', () => {
    expect(resolveOwnerReturnTo('/collections/c_42?tab=records#row-7', 'https://modelry.test'))
      .toBe('/collections/c_42?tab=records#row-7');
    expect(resolveOwnerReturnTo('//outside.test/path', 'https://modelry.test')).toBeUndefined();
    expect(resolveOwnerReturnTo('https://outside.test/path', 'https://modelry.test')).toBeUndefined();
  });

  it('establishes the Owner identity and preserves a same-origin deep link', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      owner: { id: 'owner_42', email: 'dev@example.com' },
      session: { expiresAt: '2026-09-25T10:00:00Z' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    render(<LoginPage onAuthenticated={onAuthenticated} returnTo="/collections/c_42?tab=records#row-7" />);

    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'dev@example.com');
    await user.type(screen.getByLabelText('Password'), 'owner-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith({
      owner: { id: 'owner_42', email: 'dev@example.com' },
      session: { expiresAt: '2026-09-25T10:00:00Z' },
    }, '/collections/c_42?tab=records#row-7'));
    expect(screen.getByRole('heading', { name: 'Owner session active' })).toBeInTheDocument();
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
    expect(screen.getByText('2026-09-25T10:00:00Z')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('owner_42');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'dev@example.com', password: 'owner-password' }),
      credentials: 'include',
      mode: 'same-origin',
    }));
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('owner-password');
  });

  it('keeps structured authentication failures actionable without invoking the success callback', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      error: {
        code: 'AUTHENTICATION_FAILED',
        message: 'The email or password is incorrect.',
        details: {},
        hint: 'Check your credentials and try again.',
        requestId: 'req_sign_in_failed',
      },
    }, { status: 401, headers: { 'X-Request-Id': 'req_sign_in_failed' } }))));
    const onAuthenticated = vi.fn();
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'dev@example.com');
    await user.type(screen.getByLabelText('Password'), 'incorrect-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert', { name: 'Could not sign in' });
    expect(alert).toHaveTextContent('The email or password is incorrect.');
    expect(alert).toHaveTextContent('AUTHENTICATION_FAILED');
    expect(alert).toHaveTextContent('Check your credentials and try again.');
    expect(alert).toHaveTextContent('req_sign_in_failed');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(document.body).not.toHaveTextContent('incorrect-password');
  });
});
