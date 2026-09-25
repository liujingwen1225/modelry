import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../collections/client';
import { LocaleProvider } from '../i18n/i18n';
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
const fileCollection: Collection = {
  ...collection,
  fields: [...collection.fields, { id: 'fld_attachment', name: 'attachment', type: 'file' }],
};
const filesCollection: Collection = {
  ...collection,
  fields: [...collection.fields, { id: 'fld_attachments', name: 'attachments', type: 'files' }],
};
const authCollection: Collection = {
  id: 'col_members', name: 'members', type: 'Auth', schemaVersion: 1,
  fields: [{ id: 'fld_email', name: 'email', type: 'text', required: true }],
};
const requestRecord = {
  requestId: 'req_12345678', time: '2026-09-24T10:00:00Z', collectionId: 'col_posts',
  endpoint: '/api/v1/posts/rec_abc', method: 'GET', status: 403, durationMs: 18,
  responseSizeBytes: 46,
  authenticationOutcome: 'anonymous', authorizationOutcome: 'denied', errorCode: 'FORBIDDEN',
};
const fileRequestRecord = {
  ...requestRecord,
  requestId: 'req_file_123456', endpoint: '/api/v1/posts/rec_abc/files/attachment', status: 200,
  authenticationOutcome: 'authenticated', authorizationOutcome: 'allowed', errorCode: undefined,
};

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

function renderCollectionAPI(type: 'Normal' | 'Auth' = 'Normal', collectionOverride?: Collection, initialSearch = '') {
  const value = collectionOverride ?? (type === 'Auth' ? authCollection : collection);
  return render(<LocaleProvider><MemoryRouter initialEntries={[`/collections/${value.id}/api${initialSearch}`]}><Routes>
    <Route element={<><CurrentLocation /><Outlet context={{ collection: value, pendingChange: null, refreshCollection: vi.fn(), refreshPendingChange: vi.fn() }} /></>} path="/collections/:collectionId">
      <Route element={<CollectionAPIPage />} path="api" />
    </Route>
  </Routes></MemoryRouter></LocaleProvider>);
}

describe('API Workspace', () => {
  beforeEach(() => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
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
    expect(screen.queryByRole('button', { name: /Read a file attachment/ })).not.toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('v3 · 2 fields')).toBeInTheDocument();
    await userEvent.click(screen.getByText('View OpenAPI'));
    expect(screen.getAllByText(/listApplicationRecords/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"title"/).length).toBeGreaterThan(0);
    expect(screen.getByText(/X-Request-Record-Persisted/)).toBeInTheDocument();
  });

  it('discovers the Realtime stream with the applied List rule and a resumable JavaScript example', async () => {
    mocks.getAccessRules.mockResolvedValueOnce({ applied: [{ operation: 'list', mode: 'anyone' }], pending: [], version: 1 });
    renderCollectionAPI('Normal', undefined, '?tab=realtime');

    expect(await screen.findByRole('heading', { name: 'Committed Record Events' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Collection API sections' })).toBeInTheDocument();
    expect(await screen.findByText('Anyone')).toBeInTheDocument();
    const sample = document.querySelector('.api-realtime__example pre code')?.textContent ?? '';
    expect(sample).toContain('/api/v1/posts/events');
    expect(sample).toContain("headers['Last-Event-ID']");
    expect(sample).toContain('AbortController');
    expect(sample).toContain("credentials: 'omit'");
    expect(screen.getByRole('button', { name: 'Copy JavaScript example' })).toBeInTheDocument();
  });

  it('preserves Collection API context when switching Realtime tabs', async () => {
    mocks.getAccessRules.mockResolvedValue({ applied: [{ operation: 'list', mode: 'anyone' }], pending: [], version: 1 });
    renderCollectionAPI('Normal', undefined, '?q=body&runSort=title&filter=status%20eq%20403');

    await userEvent.click(await screen.findByRole('button', { name: 'Realtime' }));
    expect(screen.getByTestId('current-location').textContent).toContain('q=body');
    expect(screen.getByTestId('current-location').textContent).toContain('runSort=title');
    expect(screen.getByTestId('current-location').textContent).toContain('filter=status');
    expect(screen.getByTestId('current-location').textContent).toContain('tab=realtime');

    await userEvent.click(screen.getByRole('button', { name: 'Endpoints' }));
    expect(screen.getByTestId('current-location').textContent).not.toContain('tab=realtime');
    expect(screen.getByTestId('current-location').textContent).toContain('q=body');
    expect(screen.getByTestId('current-location').textContent).toContain('runSort=title');
  });

  it('localizes the Realtime workspace and copied example in Simplified Chinese', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    renderCollectionAPI('Normal', undefined, '?tab=realtime');

    expect(await screen.findByRole('heading', { name: '已提交的记录事件' })).toBeInTheDocument();
    expect(screen.getByText('服务器发送事件流')).toBeInTheDocument();
    expect(document.querySelector('.api-realtime__example pre code')?.textContent).toContain('设置应用会话 token');
    expect(screen.getByRole('button', { name: '复制 JavaScript 示例' })).toBeInTheDocument();
  });

  it('does not expose generic Auth Collection writes and discovers canonical Auth routes', async () => {
    renderCollectionAPI('Auth');

    expect(await screen.findByRole('heading', { name: 'members API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /List records/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create a record/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update a record/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Register an App User/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Log in an App User/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Read a file attachment/ })).not.toBeInTheDocument();
  });

  it('discovers file reads only for Applied File Fields and uses the view Access Rule in OpenAPI and Runner', async () => {
    const user = userEvent.setup();
    mocks.getAccessRules.mockResolvedValueOnce({ applied: [{ operation: 'view', mode: 'signedInUsers' }], pending: [], version: 2 });
    mocks.runApplicationRequest.mockResolvedValueOnce({ status: 200, durationMs: 8, requestId: 'req_file_123456', requestRecordPersisted: true, textResponseHidden: true });
    renderCollectionAPI('Normal', fileCollection);

    await user.click(await screen.findByRole('button', { name: /Read a file attachment/ }));
    expect(await screen.findByText('Signed-in users')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Record ID'), 'rec_123');
    await user.selectOptions(screen.getByLabelText('File field'), 'attachment');
    await user.click(screen.getByText('View OpenAPI'));
    expect(screen.getAllByText(/readApplicationRecordFile/).length).toBeGreaterThan(0);
    expect(screen.getByText(/"\*\/\*"/)).toBeInTheDocument();
    expect(screen.getByText(/X-Request-Record-Persisted/)).toBeInTheDocument();
    expect(screen.getByText(/"x-modelry-access-rule"/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('App Session token (optional)'), 'session-example');
    await user.click(screen.getByRole('button', { name: 'Send GET request' }));
    await waitFor(() => expect(mocks.runApplicationRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: '/api/v1/posts/rec_123/files/attachment', accept: '*/*', applicationSession: 'session-example',
    })));
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
    expect(screen.getByText('46 bytes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to request context' })).toHaveAttribute('href', '/api?tab=requests');
    expect(screen.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', '/collections/col_posts/api?endpoint=getApplicationRecord');
  });

  it('resolves Request Detail links when durable telemetry stores a route template', async () => {
    mocks.getRequestRecord.mockResolvedValue({ ...fileRequestRecord, endpoint: '/api/v1/{collectionName}/{recordId}/files/{fieldName}' });
    mocks.listAllCollections.mockResolvedValue([fileCollection]);
    render(<MemoryRouter initialEntries={['/requests/req_file_123456']}><Routes>
      <Route element={<RequestDetailPage />} path="/requests/:requestId" />
    </Routes></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=col_posts&endpoint=readApplicationRecordFile');
  });

  it('resolves ordered file read templates to the indexed endpoint', async () => {
    mocks.getRequestRecord.mockResolvedValue({ ...fileRequestRecord, endpoint: '/api/v1/{collectionName}/{recordId}/files/{fieldName}/{fileIndex}' });
    mocks.listAllCollections.mockResolvedValue([filesCollection]);
    render(<MemoryRouter initialEntries={['/requests/req_file_ordered']}><Routes>
      <Route element={<RequestDetailPage />} path="/requests/:requestId" />
    </Routes></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=col_posts&endpoint=readApplicationRecordFileByIndex');
  });
  it('preserves file endpoint context in Request Detail links', async () => {
    mocks.getRequestRecord.mockResolvedValue(fileRequestRecord);
    mocks.listAllCollections.mockResolvedValue([fileCollection]);
    render(<MemoryRouter initialEntries={['/requests/req_file_123456']}><Routes>
      <Route element={<RequestDetailPage />} path="/requests/:requestId" />
    </Routes></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=col_posts&endpoint=readApplicationRecordFile');
    expect(screen.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', '/collections/col_posts/api?endpoint=readApplicationRecordFile');
  });
});
