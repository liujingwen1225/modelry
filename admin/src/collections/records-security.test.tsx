import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessRule, AccessRulesState, ApplicationSession, AuthenticationConfiguration, AuthenticationConfigurationState, Collection } from './client';
import { CollectionRecordsPage } from './records';
import { CollectionSecurityPage } from './security';
import { CollectionWorkspacePage } from './pages';
import { CommandRegistryProvider } from '../components/command-registry';
import { LocaleProvider } from '../i18n/i18n';

const collection: Collection = {
  id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 1,
  fields: [
    { id: 'fld_id', name: 'id', type: 'text', required: true, system: true },
    { id: 'fld_created', name: 'createdAt', type: 'dateTime', required: true, system: true },
    { id: 'fld_updated', name: 'updatedAt', type: 'dateTime', required: true, system: true },
    { id: 'fld_title', name: 'title', type: 'text', required: true },
  ],
};
const authCollection: Collection = {
  id: 'col_members', name: 'members', type: 'Auth', schemaVersion: 1,
  fields: [
    { id: 'fld_id', name: 'id', type: 'text', system: true },
    { id: 'fld_created', name: 'createdAt', type: 'dateTime', system: true },
    { id: 'fld_updated', name: 'updatedAt', type: 'dateTime', system: true },
    { id: 'fld_email', name: 'email', type: 'text', required: true },
    { id: 'fld_name', name: 'name', type: 'text' },
  ],
};
const savedRecord = { id: 'rec_posts_1', createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z', title: 'First post' };

function response(data: unknown, status = 200) { return Response.json({ data }, { status }); }

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

function renderCollection(path: string) {
  return render(<LocaleProvider><CommandRegistryProvider><MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route element={<><CurrentLocation /><CollectionWorkspacePage /></>} path="/collections/:collectionId">
        <Route element={<CollectionRecordsPage />} index />
        <Route element={<CollectionSecurityPage />} path="security" />
      </Route>
    </Routes>
  </MemoryRouter></CommandRegistryProvider></LocaleProvider>);
}

function workspaceResponse(path: string) {
  if (path.endsWith('/schema/pending-change')) return response(null);
  if (path === '/admin/api/v1/collections/col_posts') return response(collection);
  if (path === '/admin/api/v1/collections/col_members') return response(authCollection);
  return undefined;
}

describe('Collection Records and Security pages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a durable Record in the same sheet and shows the returned identity', async () => {
    const user = userEvent.setup();
    let created = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const workspace = workspaceResponse(path);
      if (workspace) return Promise.resolve(workspace);
      if (path.includes('/records?')) return Promise.resolve(response(created ? [savedRecord] : []));
      if (path.endsWith('/records') && init?.method === 'POST') { created = true; return Promise.resolve(response(savedRecord, 201)); }
      if (path.endsWith(`/records/${savedRecord.id}`)) return Promise.resolve(response(savedRecord));
      return Promise.resolve(response([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_posts?new=1');

    await user.type(await screen.findByRole('textbox', { name: /title/i }), 'First post');
    await user.click(screen.getAllByRole('button', { name: 'Create record' }).at(-1)!);

    expect(await within(await screen.findByRole('dialog')).findByText(savedRecord.id)).toBeInTheDocument();
    expect(screen.getByText('Record saved. The durable result is shown here.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Record' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('First post')).toBeInTheDocument();
    expect(fetchMock.mock.calls.find(([path, init]) => String(path).endsWith('/records') && init?.method === 'POST')?.[1]).toEqual(expect.objectContaining({
      credentials: 'include', mode: 'same-origin', body: JSON.stringify({ values: { title: 'First post' } }),
    }));
  });

  it('keeps record search, filter, sort, columns, and cursor context when opening a deep-linked record', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const workspace = workspaceResponse(path);
      if (workspace) return Promise.resolve(workspace);
      if (path.includes('/records?')) return Promise.resolve(response([savedRecord]));
      if (path.endsWith(`/records/${savedRecord.id}`)) return Promise.resolve(response(savedRecord));
      return Promise.resolve(response([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_posts?search=first&filter=title+eq+%22first%22&sort=title+asc&columns=id%2Ctitle&cursor=cursor_2&cursorStack=%5B%22%22%5D');

    await user.click(await screen.findByRole('button', { name: 'First post' }));
    expect(await within(await screen.findByRole('dialog')).findByText(savedRecord.id)).toBeInTheDocument();
    const location = screen.getByTestId('current-location').textContent ?? '';
    expect(location).toContain('search=first');
    expect(location).toContain('filter=title');
    expect(location).toContain('sort=title');
    expect(location).toContain('columns=id');
    expect(location).toContain('cursor=cursor_2');
    expect(location).toContain(`record=${savedRecord.id}`);
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('search=first') && String(path).includes('filter=title+eq'))).toBe(true);
  });

  it('saves Access Rules as a durable pending state, then applies them', async () => {
    const user = userEvent.setup();
    const initialRules: AccessRule[] = ['list', 'view', 'create', 'update', 'delete'].map((operation) => ({ operation, mode: 'noAccess' })) as AccessRule[];
    let state: AccessRulesState = { applied: initialRules, pending: initialRules, version: 1 };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const workspace = workspaceResponse(path);
      if (workspace) return Promise.resolve(workspace);
      if (path === '/admin/api/v1/collections?limit=100') return Promise.resolve(response([collection, { id: 'col_users', name: 'users', type: 'Auth', fields: [] }]));
      if (path.endsWith('/access-rules') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { rules: AccessRule[] };
        state = { ...state, pending: body.rules, version: state.version + 1 };
        return Promise.resolve(response(state));
      }
      if (path.endsWith('/access-rules/apply')) {
        state = { applied: state.pending, pending: state.pending, version: state.version + 1 };
        return Promise.resolve(response(state));
      }
      if (path.endsWith('/access-rules')) return Promise.resolve(response(state));
      return Promise.resolve(response([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_posts/security');

    await user.click(await screen.findByRole('button', { name: 'Edit List access' }));
    await user.click(screen.getByRole('radio', { name: /Signed-in users/ }));
    await user.click(screen.getByRole('button', { name: 'Save pending rule' }));
    expect(await screen.findByRole('region', { name: 'Pending access changes' })).toHaveTextContent('1 pending access rule change');
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }));

    expect(await screen.findByText('Access rules applied. The Runtime confirmed the durable state.')).toBeInTheDocument();
    expect(state.applied[0]?.mode).toBe('signedInUsers');
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/access-rules') && init?.method === 'PUT')).toBe(true);
  });

  it('keeps Authentication configuration changes separate and applies the confirmed version', async () => {
    const user = userEvent.setup();
    const initial: AuthenticationConfiguration = { emailPasswordEnabled: true, selfRegistration: false, sessionDurationDays: 7 };
    let state: AuthenticationConfigurationState = { applied: initial, pending: initial, version: 1 };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const workspace = path === '/admin/api/v1/collections/col_members' ? response(authCollection) : path.endsWith('/schema/pending-change') ? response(null) : undefined;
      if (workspace) return Promise.resolve(workspace);
      if (path.endsWith('/authentication') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { configuration: AuthenticationConfiguration };
        state = { ...state, pending: body.configuration, version: state.version + 1 };
        return Promise.resolve(response(state));
      }
      if (path.endsWith('/authentication/apply')) {
        state = { applied: state.pending, pending: state.pending, version: state.version + 1 };
        return Promise.resolve(response(state));
      }
      if (path.endsWith('/authentication')) return Promise.resolve(response(state));
      if (path === '/admin/api/v1/collections?limit=100') return Promise.resolve(response([authCollection]));
      if (path.endsWith('/access-rules')) return Promise.resolve(response({ applied: [], pending: [], version: 1 }));
      return Promise.resolve(response([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_members/security?panel=authentication');

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.selectOptions(screen.getByLabelText('Self registration'), 'enabled');
    await user.click(screen.getByRole('button', { name: 'Save pending settings' }));
    expect(await screen.findByRole('region', { name: 'Pending authentication settings' })).toHaveTextContent('Pending authentication settings');
    expect(state.applied.selfRegistration).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Apply settings' }));
    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }));

    expect(await screen.findByText('Authentication settings applied. The Runtime confirmed the durable state.')).toBeInTheDocument();
    expect(state.applied.selfRegistration).toBe(true);
    const saveCall = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith('/authentication') && init?.method === 'PUT');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({ expectedVersion: 1, configuration: { ...initial, selfRegistration: true } });
  });

  it('shows user sessions and requires explicit confirmation before revoking one', async () => {
    const user = userEvent.setup();
    let sessions: ApplicationSession[] = [{ id: 'ses_1', createdAt: '2026-09-24T09:00:00Z', expiresAt: '2026-10-01T09:00:00Z', status: 'active' }];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const workspace = path === '/admin/api/v1/collections/col_members' ? response(authCollection) : path.endsWith('/schema/pending-change') ? response(null) : undefined;
      if (workspace) return Promise.resolve(workspace);
      if (path === '/admin/api/v1/collections?limit=100') return Promise.resolve(response([authCollection]));
      if (path.endsWith('/users?limit=50')) return Promise.resolve(response([{ recordId: 'rec_user_1', email: 'alice@example.test' }]));
      if (path.endsWith('/users/rec_user_1/sessions')) return Promise.resolve(response(sessions));
      if (path.endsWith('/records/rec_user_1')) return Promise.resolve(response({ id: 'rec_user_1', email: 'alice@example.test', name: 'Alice' }));
      if (path.endsWith('/sessions/ses_1/revoke') && init?.method === 'POST') {
        sessions = sessions.map((session) => ({ ...session, status: 'revoked' }));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(response({ applied: [], pending: [], version: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_members/security?panel=sessions');

    await user.click(await screen.findByRole('button', { name: 'View sessions' }));
    expect(await screen.findByText('alice@example.test')).toBeInTheDocument();
    expect(await screen.findByText('active')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Revoke this session?');
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    expect(await screen.findByText('Session revoked.')).toBeInTheDocument();
    expect(await screen.findByText('revoked')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections/col_members/sessions/ses_1/revoke', expect.objectContaining({ method: 'POST', credentials: 'include', mode: 'same-origin' })));
  });

  it('keeps Sessions available when the profile lookup is unavailable', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const workspace = path === '/admin/api/v1/collections/col_members' ? response(authCollection) : path.endsWith('/schema/pending-change') ? response(null) : undefined;
      if (workspace) return Promise.resolve(workspace);
      if (path === '/admin/api/v1/collections?limit=100') return Promise.resolve(response([authCollection]));
      if (path.endsWith('/users?limit=50')) return Promise.resolve(Response.json({ data: [{ recordId: 'rec_user_1', email: 'alice@example.test' }] }));
      if (path.endsWith('/users/rec_user_1/sessions')) return Promise.resolve(response([{ id: 'ses_1', createdAt: '2026-09-24T09:00:00Z', expiresAt: '2026-10-01T09:00:00Z', status: 'active' }]));
      if (path.endsWith('/records/rec_user_1')) return Promise.resolve(Response.json({ error: { code: 'NOT_FOUND', message: 'Profile is unavailable.' } }, { status: 404 }));
      return Promise.resolve(response({ applied: [], pending: [], version: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_members/security?panel=sessions&user=rec_user_1');

    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(await screen.findByText('alice@example.test')).toBeInTheDocument();
    expect(screen.queryByText('Sessions could not be loaded.')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections/col_members/records/rec_user_1', expect.objectContaining({ credentials: 'include', mode: 'same-origin' }));
  });

  it('paginates the Sessions user picker while keeping search and cursor in the URL', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const workspace = path === '/admin/api/v1/collections/col_members' ? response(authCollection) : path.endsWith('/schema/pending-change') ? response(null) : undefined;
      if (workspace) return Promise.resolve(workspace);
      if (path === '/admin/api/v1/collections?limit=100') return Promise.resolve(response([authCollection]));
      if (path.endsWith('/users?limit=50&cursor=users_page_2')) return Promise.resolve(Response.json({ data: [{ recordId: 'rec_user_2', email: 'alice+second@example.test' }] }));
      if (path.endsWith('/users?limit=50')) return Promise.resolve(Response.json({ data: [{ recordId: 'rec_user_1', email: 'bob@example.test' }], nextCursor: 'users_page_2' }));
      return Promise.resolve(response({ applied: [], pending: [], version: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollection('/collections/col_members/security?panel=sessions&userSearch=alice');

    expect(await screen.findByRole('heading', { name: 'No users match this search' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('alice+second@example.test')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search user' })).toHaveValue('alice');
    expect(screen.getByTestId('current-location').textContent).toContain('userSearch=alice');
    expect(screen.getByTestId('current-location').textContent).toContain('usersCursor=users_page_2');
    expect(screen.getByTestId('current-location').textContent).toContain('usersCursorStack=%5B%22%22%5D');

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('heading', { name: 'No users match this search' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search user' })).toHaveValue('alice');
    expect(screen.getByTestId('current-location').textContent).toContain('userSearch=alice');
    expect(screen.getByTestId('current-location').textContent).not.toContain('usersCursor=users_page_2');
    expect(screen.getByTestId('current-location').textContent).not.toContain('usersCursorStack=');
  });
});
