import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';

// Spec 0001 §7.1：MCP 子页必须展示真实 CLI 命令、绑定账号的权限摘要，
// 以及来自现有 Activity 的最近操作——不引入新的后端接口。
function json(data: unknown) {
  return Response.json(data, { headers: { 'Content-Type': 'application/json' } });
}

function setupMCP({ accounts, activity }: { accounts: unknown[]; activity?: unknown[] }) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/session')) {
      return Promise.resolve(json({
        owner: { id: 'own_test', email: 'owner@example.test' },
        expiresAt: '2026-09-25T09:00:00Z',
        role: 'owner',
        permission: { preset: 'fullAccess' },
      }));
    }
    if (path.endsWith('/runtime/status')) {
      return Promise.resolve(json({
        state: 'ready', observedAt: '2026-09-24T09:00:00Z',
        database: { state: 'ready' }, localStorage: { state: 'ready' },
      }));
    }
    if (path.endsWith('/storage/status')) {
      return Promise.resolve(json({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } }));
    }
    if (path.startsWith('/admin/api/v1/service-accounts')) return Promise.resolve(json({ data: accounts }));
    if (path.startsWith('/admin/api/v1/activity')) return Promise.resolve(json({ data: activity ?? [] }));
    return Promise.resolve(json({ data: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.setItem('modelry-admin-locale', 'en');
  window.history.replaceState({}, '', '/connect/mcp');
  render(<App />);
  return fetchMock;
}

describe('MCP connection guide', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the real CLI command, the bound Service Account permission and recent agent operations', async () => {
    setupMCP({
      accounts: [
        { id: 'svc_agent', name: 'Deploy agent', description: 'Applies model changes', permission: 'readOnly', status: 'active', lastUsedAt: '2026-09-24T09:30:00Z' },
      ],
      activity: [
        { id: 'act_1', kind: 'change.applied', status: 'succeeded', occurredAt: '2026-09-24T09:30:00Z', resourceKind: 'changeSet', resourceId: 'chg_1', title: 'posts · Add publishedAt', deepLink: '/changes?changeSet=chg_1' },
      ],
    });

    expect(await screen.findByRole('heading', { name: 'MCP' })).toBeInTheDocument();
    // 命令必须与真实 CLI 一致，不使用虚构参数。
    expect(screen.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>')).toBeInTheDocument();

    const accountRow = await screen.findByText('Deploy agent');
    const row = accountRow.closest('li');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('Read only');
    expect(row).toHaveTextContent('Active');

    expect(await screen.findByText('posts · Add publishedAt')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/Never used/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/changes?changeSet=chg_1');
  });

  it('offers the smallest-permission next step when no Service Account exists yet', async () => {
    setupMCP({ accounts: [] });

    expect(await screen.findByText('No Service Account yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create Service Account' })).toHaveAttribute('href', '/access');
    expect(screen.getByText('No agent operations yet')).toBeInTheDocument();
  });
});
