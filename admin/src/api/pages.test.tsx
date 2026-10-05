import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../collections/client';
import { LocaleProvider } from '../i18n/i18n';
import { CommandRegistryProvider } from '../components/command-registry';
import { ApiWorkspacePage } from './pages';

// Spec 0001 §3 / §7.1 / §9.1：API 工作区只有一个一级页面，三个 Tab 存在 URL 的 ?tab= 里，
// 端点 / OpenAPI / 请求日志都要能在刷新与分享后回到同一个工作面。
const mocks = vi.hoisted(() => ({
  getRequestRecord: vi.fn(),
  listRequestRecords: vi.fn(),
  runApplicationRequest: vi.fn(),
  listAllCollections: vi.fn(),
  getAccessRules: vi.fn(),
  fetchApplicationAPIContract: vi.fn(),
}));

vi.mock('./workspace-client', () => ({
  getRequestRecord: mocks.getRequestRecord,
  listRequestRecords: mocks.listRequestRecords,
  runApplicationRequest: mocks.runApplicationRequest,
}));
vi.mock('../collections/client', () => ({ listAllCollections: mocks.listAllCollections, getAccessRules: mocks.getAccessRules }));
vi.mock('../portability/client', () => ({ fetchApplicationAPIContract: mocks.fetchApplicationAPIContract }));

const collection: Collection = {
  id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 3,
  fields: [{ id: 'fld_title', name: 'title', type: 'text', required: true }],
};
const contract = {
  version: 'test',
  contentHash: 'a'.repeat(64),
  apiBasePath: '/api/v1',
  collections: [{ id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 3, fields: [], endpoints: ['GET /api/v1/posts'], accessRules: [] }],
};

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

function renderWorkspace(initialEntry = '/api') {
  return render(<LocaleProvider><CommandRegistryProvider><MemoryRouter initialEntries={[initialEntry]}><CurrentLocation /><Routes>
    <Route element={<ApiWorkspacePage />} path="/api" />
  </Routes></MemoryRouter></CommandRegistryProvider></LocaleProvider>);
}

describe('API workspace tabs', () => {
  beforeEach(() => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    mocks.listAllCollections.mockReset();
    mocks.listAllCollections.mockResolvedValue([collection]);
    mocks.getAccessRules.mockReset();
    mocks.getAccessRules.mockResolvedValue({ applied: [{ operation: 'list', mode: 'anyone' }], pending: [], version: 1 });
    mocks.listRequestRecords.mockReset();
    mocks.listRequestRecords.mockResolvedValue({ data: [], nextCursor: undefined });
    mocks.fetchApplicationAPIContract.mockReset();
    mocks.fetchApplicationAPIContract.mockResolvedValue(contract);
  });

  it('opens the endpoint browser by default and marks the tab as current', async () => {
    renderWorkspace();

    expect(await screen.findByRole('heading', { level: 1, name: 'API workspace' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'API workspace sections' })).toBeInTheDocument();
    // Tab 是 URL 状态，因此必须是真实链接（可分享、可新开标签页）。
    expect(screen.getByRole('link', { name: 'Endpoints' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Request workspace' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /List records/ })).toBeInTheDocument();
  });

  it('treats an unknown tab as the endpoint tab', async () => {
    renderWorkspace('/api?tab=realtime&collection=col_posts');

    expect(await screen.findByRole('heading', { level: 1, name: 'API workspace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Endpoints' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('button', { name: /List records/ })).toBeInTheDocument();
  });

  it('opens legacy playground links in endpoints and preserves request context', async () => {
    renderWorkspace('/api?tab=playground&collection=col_posts&endpoint=createApplicationRecord&runSort=title');

    expect(await screen.findByRole('button', { name: 'Send POST request' })).toBeInTheDocument();
    const entry = screen.getByTestId('current-location').textContent ?? '';
    expect(entry).toContain('tab=endpoints');
    expect(entry).toContain('collection=col_posts');
    expect(entry).toContain('endpoint=createApplicationRecord');
    expect(entry).toContain('runSort=title');
    expect(screen.getByRole('link', { name: 'Endpoints' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Request workspace' })).not.toBeInTheDocument();
  });

  it('preserves request context when switching between OpenAPI and endpoints', async () => {
    const user = userEvent.setup();
    renderWorkspace('/api?tab=endpoints&collection=col_posts&endpoint=createApplicationRecord&runSort=title');
    await user.click(await screen.findByRole('link', { name: 'OpenAPI' }));
    await screen.findByRole('heading', { name: 'OpenAPI contract' });
    await user.click(screen.getByRole('link', { name: 'Endpoints' }));
    expect(await screen.findByRole('button', { name: 'Send POST request' })).toBeInTheDocument();
    expect(screen.getByTestId('current-location').textContent).toContain('runSort=title');
  });

  it('shows the real contract and only real integration actions in the OpenAPI tab', async () => {
    renderWorkspace('/api?tab=openapi');

    expect(await screen.findByRole('heading', { level: 2, name: 'OpenAPI contract' })).toBeInTheDocument();
    expect(mocks.fetchApplicationAPIContract).toHaveBeenCalled();
    expect(await screen.findByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download openapi.json' })).toBeInTheDocument();
    // 示例命令来自契约里真实存在的第一个 Collection；没有 Collection 时不渲染这个动作。
    expect(await screen.findByRole('button', { name: 'Copy cURL example' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect a coding agent through MCP/ })).toHaveAttribute('href', '/agent?tab=mcp');
  });

  it('keeps the OpenAPI tab recoverable when the contract cannot be loaded', async () => {
    mocks.fetchApplicationAPIContract.mockRejectedValueOnce(new Error('runtime unavailable'));
    renderWorkspace('/api?tab=openapi');

    expect(await screen.findByText('This page could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download openapi.json' })).not.toBeInTheDocument();
  });

  it('mounts the request log inside the workspace without a second level-1 heading', async () => {
    renderWorkspace('/api?tab=logs');

    expect(await screen.findByRole('heading', { level: 2, name: 'Request log' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Requests' })).not.toBeInTheDocument();
    expect(mocks.listRequestRecords).toHaveBeenCalled();
  });
});
