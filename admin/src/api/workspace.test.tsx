import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../collections/client';
import { CollectionAPIPage, GlobalAPIPage, RequestDetailPage } from './workspace';

const mocks = vi.hoisted(() => ({
  getRequestRecord: vi.fn(),
  listRequestRecords: vi.fn(),
  runApplicationRequest: vi.fn(),
  listAllCollections: vi.fn(),
  getAccessRules: vi.fn(),
}));

vi.mock('./workspace-client', () => ({
  getRequestRecord: mocks.getRequestRecord,
  listRequestRecords: mocks.listRequestRecords,
  runApplicationRequest: mocks.runApplicationRequest,
}));
vi.mock('../collections/client', () => ({ listAllCollections: mocks.listAllCollections, getAccessRules: mocks.getAccessRules }));

const collection: Collection = {
  id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 3,
  fields: [
    { id: 'fld_title', name: 'title', type: 'text', required: true },
    { id: 'fld_body', name: 'body', type: 'text' },
  ],
};
const authCollection: Collection = {
  id: 'col_members', name: 'members', type: 'Auth', schemaVersion: 1,
  fields: [{ id: 'fld_email', name: 'email', type: 'text', required: true }],
};
const requestRecord = {
  requestId: 'req_12345678', time: '2026-09-24T10:00:00Z', collectionId: 'col_posts',
  endpoint: '/api/v1/posts/rec_abc', method: 'GET', status: 403, durationMs: 18,
  authenticationOutcome: 'anonymous', authorizationOutcome: 'denied', errorCode: 'FORBIDDEN',
};

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

function renderCollectionAPI(type: 'Normal' | 'Auth' = 'Normal') {
  const value = type === 'Auth' ? authCollection : collection;
  return render(<MemoryRouter initialEntries={[`/collections/${value.id}/api`]}><Routes>
    <Route element={<><CurrentLocation /><Outlet context={{ collection: value, pendingChange: null, refreshCollection: vi.fn(), refreshPendingChange: vi.fn() }} /></>} path="/collections/:collectionId">
      <Route element={<CollectionAPIPage />} path="api" />
    </Route>
  </Routes></MemoryRouter>);
}

describe('API Workspace', () => {
  beforeEach(() => {
    mocks.getRequestRecord.mockReset();
    mocks.listRequestRecords.mockReset();
    mocks.runApplicationRequest.mockReset();
    mocks.listAllCollections.mockReset();
    mocks.listAllCollections.mockResolvedValue([collection]);
    mocks.getAccessRules.mockReset();
    mocks.getAccessRules.mockResolvedValue({ applied: [{ operation: 'list', mode: 'noAccess' }], pending: [], version: 1 });
  });

  it('discovers Collection endpoints from applied Fields and shows canonical OpenAPI', async () => {
    renderCollectionAPI();

    expect(await screen.findByRole('heading', { name: 'posts API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /List records/ })).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('v3 · 2 fields')).toBeInTheDocument();
    await userEvent.click(screen.getByText('View OpenAPI'));
    expect(screen.getAllByText(/listApplicationRecords/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"title"/).length).toBeGreaterThan(0);
  });

  it('does not expose generic Auth Collection writes and discovers canonical Auth routes', async () => {
    renderCollectionAPI('Auth');

    expect(await screen.findByRole('heading', { name: 'members API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /List records/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create a record/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update a record/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Register an App User/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Log in an App User/ })).toBeInTheDocument();
  });

  it('sends a real Application request and only links to detail after durable persistence is confirmed', async () => {
    const user = userEvent.setup();
    mocks.runApplicationRequest.mockResolvedValueOnce({ status: 201, durationMs: 8, requestId: 'req_12345678', requestRecordPersisted: false, body: { data: { id: 'rec_1' } } })
      .mockResolvedValueOnce({ status: 201, durationMs: 11, requestId: 'req_12345678', requestRecordPersisted: true, body: { data: { id: 'rec_1' } } });
    renderCollectionAPI();

    await user.click(await screen.findByRole('button', { name: /Create a record/ }));
    await user.click(screen.getByRole('button', { name: 'Send POST request' }));
    expect(await screen.findByText(/durable Request Record was not confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View durable request details/ })).not.toBeInTheDocument();
    expect(mocks.runApplicationRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST', path: '/api/v1/posts', body: '{\n  "values": {}\n}' }));

    await user.click(screen.getByRole('button', { name: 'Send POST request' }));
    expect(await screen.findByRole('link', { name: /View durable request details/ })).toHaveAttribute('href', expect.stringContaining('/requests/req_12345678'));
  });

  it('uses applied Access Rules in the OpenAPI view and lets the Runner switch between anonymous and signed-in requests', async () => {
    const user = userEvent.setup();
    mocks.getAccessRules.mockResolvedValueOnce({ applied: [{ operation: 'list', mode: 'signedInUsers' }], pending: [], version: 2 });
    mocks.runApplicationRequest.mockResolvedValueOnce({ status: 200, durationMs: 6, requestId: 'req_signed_in', requestRecordPersisted: true, body: { data: [] } });
    renderCollectionAPI();

    await user.click(await screen.findByRole('button', { name: /List records/ }));
    expect(await screen.findByText('Signed-in users')).toBeInTheDocument();
    await user.click(screen.getByText('View OpenAPI'));
    expect(screen.getByText(/"ApplicationSession"/)).toBeInTheDocument();
    expect(screen.getByText(/"x-modelry-access-rule"/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('App Session token (optional)'), 'session-example');
    await user.click(screen.getByRole('button', { name: 'Send GET request' }));
    await waitFor(() => expect(mocks.runApplicationRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: expect.stringMatching(/^\/api\/v1\/posts\?/), applicationSession: 'session-example',
    })));
  });

  it('keeps Requests search, filter, sort and cursor pagination in the URL', async () => {
    const user = userEvent.setup();
    mocks.listRequestRecords.mockResolvedValue({ data: [requestRecord], nextCursor: 'cursor_2' });
    render(<MemoryRouter initialEntries={['/api?tab=requests&search=req_12&filter=status+eq+403&sort=time+desc']}><CurrentLocation /><GlobalAPIPage /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'req_12345678' })).toBeInTheDocument();
    expect(mocks.listRequestRecords).toHaveBeenCalledWith(expect.objectContaining({ search: 'req_12', filter: 'status eq 403', sort: 'time desc' }), expect.any(AbortSignal));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getByTestId('current-location').textContent).toContain('cursor=cursor_2'));
    expect(screen.getByTestId('current-location').textContent).toContain('search=req_12');
    expect(screen.getByTestId('current-location').textContent).toContain('filter=status');
    expect(screen.getByTestId('current-location').textContent).toContain('back=');
  });

  it('loads durable Request Detail directly and links back to its Collection endpoint context', async () => {
    mocks.getRequestRecord.mockResolvedValue(requestRecord);
    mocks.listAllCollections.mockResolvedValue([collection]);
    render(<MemoryRouter initialEntries={['/requests/req_12345678?from=%2Fapi%3Ftab%3Drequests']}><Routes>
      <Route element={<RequestDetailPage />} path="/requests/:requestId" />
    </Routes></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByText('FORBIDDEN')).toBeInTheDocument();
    expect(screen.getByText('denied')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to request context' })).toHaveAttribute('href', '/api?tab=requests');
    expect(screen.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', '/collections/col_posts/api?endpoint=getApplicationRecord');
  });
});
