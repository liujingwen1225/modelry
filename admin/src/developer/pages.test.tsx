import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';

// Spec 0001 §3.1/§7.1：MCP 子页必须展示真实 CLI 命令、绑定账号的权限摘要，
// 以及按该 Service Account 过滤的最近操作——全部复用既有只读接口。
function json(data: unknown) {
  return Response.json(data, { headers: { 'Content-Type': 'application/json' } });
}

function setupMCP({ accounts, audit }: { accounts: unknown[]; audit?: unknown[] }) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/session')) {
      return Promise.resolve(json({
        owner: { id: 'own_test', email: 'owner@example.test' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
    if (path.startsWith('/admin/api/v1/audit')) return Promise.resolve(json({ data: audit ?? [] }));
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

  it('shows the real CLI command, the bound Service Account permission and its audited operations', async () => {
    const fetchMock = setupMCP({
      accounts: [
        { id: 'svc_agent', name: 'Deploy agent', description: 'Applies model changes', permission: 'readOnly', status: 'active', lastUsedAt: '2026-09-24T09:30:00Z' },
      ],
      audit: [
        { id: 'aud_1', time: '2026-09-24T09:30:00Z', actor: { kind: 'serviceAccount', id: 'svc_agent' }, action: 'schema.apply', resource: { kind: 'changeSet', id: 'chg_1' }, result: 'succeeded' },
      ],
    });

    expect(await screen.findByRole('heading', { name: 'MCP' })).toBeInTheDocument();
    // 命令必须与真实 CLI 一致，不使用虚构参数。
    expect(screen.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>')).toBeInTheDocument();

    const accountRow = await screen.findByText('Deploy agent');
    const row = accountRow.closest('button');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('Read only');
    expect(row).toHaveTextContent('Active');
    expect(row).toHaveAttribute('aria-pressed', 'true');

    expect(await screen.findByText('schema.apply')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/activity/audit/aud_1');
    // 最近操作必须按绑定的 Service Account 过滤，而不是取全量记录。
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/admin/api/v1/audit?limit=8&actorKind=serviceAccount&actorId=svc_agent'))).toBe(true);
  });

  it('offers the smallest-permission next step when no Service Account exists yet', async () => {
    setupMCP({ accounts: [] });

    expect(await screen.findByText('No Service Account yet')).toBeInTheDocument();
    // 服务账号与 API Key 属于 Access & auth / API Tokens，深链接直接落到该 Tab。
    expect(screen.getByRole('link', { name: 'Create Service Account' })).toHaveAttribute('href', '/access?tab=tokens');
    expect(await screen.findByText('No agent operations yet')).toBeInTheDocument();
  });

  it('filters the operation list to the selected Service Account', async () => {
    const fetchMock = setupMCP({
      accounts: [
        { id: 'svc_first', name: 'First agent', permission: 'readOnly', status: 'active' },
        { id: 'svc_second', name: 'Second agent', permission: 'fullAccess', status: 'active' },
      ],
      audit: [],
    });

    const second = await screen.findByText('Second agent');
    const secondRow = second.closest('button');
    expect(secondRow).not.toBeNull();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(secondRow as HTMLElement);
    expect(secondRow).toHaveAttribute('aria-pressed', 'true');
    expect(within(secondRow as HTMLElement).getByText('Full access')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('actorId=svc_second'))).toBe(true);
  });
});
