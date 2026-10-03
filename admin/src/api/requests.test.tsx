import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../collections/client';
import { LocaleProvider } from '../i18n/i18n';
import { CommandRegistryProvider } from '../components/command-registry';
import { RequestDetailPage, RequestsPage } from './requests';

// Spec 0001 §9.1：Requests 列表与详情只展示运行时确实记录的诊断事实，
// 并且详情字段来自显式 allowlist。
const mocks = vi.hoisted(() => ({
  getRequestRecord: vi.fn(),
  listRequestRecords: vi.fn(),
  listAllCollections: vi.fn(),
}));

vi.mock('./workspace-client', () => ({
  getRequestRecord: mocks.getRequestRecord,
  listRequestRecords: mocks.listRequestRecords,
}));
vi.mock('../collections/client', () => ({ listAllCollections: mocks.listAllCollections }));

const collection: Collection = {
  id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 3,
  fields: [{ id: 'fld_title', name: 'title', type: 'text', required: true }],
};
const fileCollection: Collection = {
  ...collection,
  fields: [...collection.fields, { id: 'fld_attachment', name: 'attachment', type: 'file' }],
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

function renderRequests(initialEntry: string, embedded = false) {
  return render(<LocaleProvider><CommandRegistryProvider><MemoryRouter initialEntries={[initialEntry]}><CurrentLocation /><Routes>
    <Route element={<RequestsPage embedded={embedded} />} path="/api" />
  </Routes></MemoryRouter></CommandRegistryProvider></LocaleProvider>);
}

function renderRequestDetail(initialEntry: string) {
  return render(<LocaleProvider><MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route element={<RequestDetailPage />} path="/api/requests/:requestId" />
  </Routes></MemoryRouter></LocaleProvider>);
}

describe('Requests surface', () => {
  beforeEach(() => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    mocks.getRequestRecord.mockReset();
    mocks.listRequestRecords.mockReset();
    mocks.listAllCollections.mockReset();
    mocks.listAllCollections.mockResolvedValue([collection]);
  });

  it('lists durable request facts and localizes the surface in Simplified Chinese', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    mocks.listRequestRecords.mockResolvedValue({ data: [requestRecord], nextCursor: 'cursor_2' });
    renderRequests('/api?tab=logs&search=req_12');

    expect(await screen.findByRole('heading', { name: '请求' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: '应用请求记录' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'req_12345678' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用筛选' })).toBeInTheDocument();
    expect(screen.queryByText('Apply filters')).not.toBeInTheDocument();
    // 端点路径、错误码等耐久遥测字段属于标识，必须保持原样。
    expect(screen.getByText('FORBIDDEN')).toBeInTheDocument();
    expect(mocks.listRequestRecords).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'req_12', filter: '', sort: 'time desc' }),
      expect.any(AbortSignal),
    );
  });

  it('keeps search, filter, sort and cursor pagination in the URL', async () => {
    const user = userEvent.setup();
    mocks.listRequestRecords.mockResolvedValue({ data: [requestRecord], nextCursor: 'cursor_2' });
    renderRequests('/api?tab=logs&search=req_12&filter=status+eq+403&sort=time+asc');

    expect(await screen.findByRole('link', { name: 'req_12345678' })).toBeInTheDocument();
    expect(mocks.listRequestRecords).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'req_12', filter: 'status eq 403', sort: 'time asc' }),
      expect.any(AbortSignal),
    );
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getByTestId('current-location').textContent).toContain('cursor=cursor_2'));
    expect(screen.getByTestId('current-location').textContent).toContain('search=req_12');
    expect(screen.getByTestId('current-location').textContent).toContain('filter=status');
    expect(screen.getByTestId('current-location').textContent).toContain('back=');
    // 请求日志是 API 工作区的一个 Tab：分页与筛选都不能丢掉 tab 上下文。
    expect(screen.getByTestId('current-location').textContent).toContain('tab=logs');
  });

  it('lets the API workspace own the page heading when embedded', async () => {
    mocks.listRequestRecords.mockResolvedValue({ data: [requestRecord], nextCursor: undefined });
    renderRequests('/api?tab=logs', true);

    expect(await screen.findByRole('heading', { level: 2, name: 'Request log' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Requests' })).not.toBeInTheDocument();
  });

  it('keeps search, filter, sort and cursor pagination in the URL when applying filters', async () => {
    const user = userEvent.setup();
    mocks.listRequestRecords.mockResolvedValue({ data: [requestRecord], nextCursor: undefined });
    renderRequests('/api?tab=logs&search=req_12');

    await screen.findByRole('link', { name: 'req_12345678' });
    await user.click(screen.getByRole('button', { name: /Apply filters/ }));
    await waitFor(() => expect(screen.getByTestId('current-location').textContent).toContain('search=req_12'));
    expect(screen.getByTestId('current-location').textContent).toContain('tab=logs');
  });

  it('maps a Collection deep link onto the same single filter condition', async () => {
    mocks.listRequestRecords.mockResolvedValue({ data: [requestRecord], nextCursor: undefined });
    renderRequests('/api?tab=logs&collection=col_posts');

    expect(await screen.findByRole('link', { name: 'req_12345678' })).toBeInTheDocument();
    expect(mocks.listRequestRecords).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'collectionId eq "col_posts"' }),
      expect.any(AbortSignal),
    );
  });

  it('shows only allowlisted durable fields on the detail surface', async () => {
    mocks.getRequestRecord.mockResolvedValue(requestRecord);
    renderRequestDetail('/api/requests/req_12345678?from=%2Fconnect%2Fapi%3Ftab%3Dendpoints');

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Request details' });
    for (const field of ['req_12345678', 'FORBIDDEN', 'Denied', 'Anonymous', 'posts']) {
      expect(region).toHaveTextContent(field);
    }
    // §9.1 allowlist 之外的字段（如响应体大小）不再展示。
    expect(region).not.toHaveTextContent('46 bytes');
    expect(region).toHaveTextContent('Not recorded');
    // 旧的 /connect/api 深链接经 route-map 收敛到 /api?tab=endpoints。
    expect(screen.getByRole('link', { name: 'Back to request context' })).toHaveAttribute('href', '/api?tab=endpoints');
    expect(screen.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', '/collections/col_posts/api?endpoint=getApplicationRecord');
  });

  it('offers a direct Collection Access Rules recovery route after authorization is denied', async () => {
    mocks.getRequestRecord.mockResolvedValue(requestRecord);
    renderRequestDetail('/api/requests/req_12345678');

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review access rules' })).toHaveAttribute('href', '/collections/col_posts/access');
    expect(screen.getByRole('link', { name: 'All requests' })).toHaveAttribute('href', '/api?tab=logs');
  });

  it('resolves route templates stored by durable telemetry back to their endpoint', async () => {
    mocks.getRequestRecord.mockResolvedValue({ ...fileRequestRecord, endpoint: '/api/v1/{collectionName}/{recordId}/files/{fieldName}' });
    mocks.listAllCollections.mockResolvedValue([fileCollection]);
    renderRequestDetail('/api/requests/req_file_123456');

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=col_posts&endpoint=readApplicationRecordFile');
  });

  it('resolves ordered file read templates to the indexed endpoint', async () => {
    mocks.getRequestRecord.mockResolvedValue({ ...fileRequestRecord, endpoint: '/api/v1/{collectionName}/{recordId}/files/{fieldName}/{fileIndex}' });
    mocks.listAllCollections.mockResolvedValue([fileCollection]);
    renderRequestDetail('/api/requests/req_file_ordered');

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=col_posts&endpoint=readApplicationRecordFileByIndex');
  });

  it('preserves file endpoint context in Request Detail links', async () => {
    mocks.getRequestRecord.mockResolvedValue(fileRequestRecord);
    mocks.listAllCollections.mockResolvedValue([fileCollection]);
    renderRequestDetail('/api/requests/req_file_123456');

    expect(await screen.findByRole('heading', { name: 'Request details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=col_posts&endpoint=readApplicationRecordFile');
    expect(screen.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', '/collections/col_posts/api?endpoint=readApplicationRecordFile');
  });
});
