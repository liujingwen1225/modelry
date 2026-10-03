import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './app';

// Spec 0001 §3.1：一级导航按 WORKSPACE / BUILD / OPERATE / SYSTEM 四组九项组织；
// 旧的 Automations / Connect / Observe / Evolve / Project 分组不再存在。

const overviewSnapshot = {
  generatedAt: '2026-10-01T12:00:00Z',
  windowSeconds: 86400,
  collections: { count: 2, recordCount: 1214, withPendingChanges: 0, withFailedChanges: 0, recent: [] },
  requests: { windowSeconds: 86400, requestCount: 40, clientErrorCount: 0, serverErrorCount: 0, p95DurationMs: 12 },
  events: { enabledHooks: 1, enabledWebhooks: 1, enabledEventHooks: 1, enabledJobs: 2, runCount: 4, deliveryCount: 6, failedDeliveryCount: 0, pendingDeliveryCount: 0 },
  changes: { pendingCount: 0, needsReviewCount: 0, failedCount: 0 },
  drift: { state: 'healthy', differenceCount: 0, checkedAt: '2026-10-01T11:00:00Z' },
};

function diagnosticResponse(path: string): Response {
  if (path.endsWith('/auth/session')) {
    return Response.json({
      owner: { id: 'own_test', email: 'owner@example.com' },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      role: 'owner',
      permission: { preset: 'fullAccess' },
    });
  }

  if (path.endsWith('/runtime/status')) {
    return Response.json({
      state: 'ready',
      observedAt: '2026-09-24T09:00:00Z',
      database: { state: 'ready' },
      localStorage: { state: 'ready' },
    });
  }

  if (path.startsWith('/admin/api/v1/overview')) {
    return Response.json({ data: overviewSnapshot });
  }

  if (path.startsWith('/admin/api/v1/changes?')) {
    return Response.json({ data: [] });
  }

  if (path.startsWith('/admin/api/v1/activity')) {
    return Response.json({ data: [] });
  }

  return Response.json({
    database: { state: 'ready' },
    localStorage: { state: 'ready', provider: 'Local' },
    databaseSizeBytes: 40108032,
  });
}

const primaryNavigationLabels = [
  'Overview',
  'Collections',
  'API workspace',
  'Hooks & Events',
  'Scheduled jobs',
  'Changes',
  'Access & auth',
  'Activity',
  'System settings',
];

describe('Modelry Admin shell', () => {
  it('renders the four navigation groups with their real destinations', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    await waitFor(() => expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page'));

    const links = within(navigation).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(primaryNavigationLabels);
    expect(links.map((link) => link.getAttribute('title'))).toEqual(primaryNavigationLabels);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/', '/collections', '/api', '/events', '/schedules', '/changes', '/access', '/activity', '/settings',
    ]);

    const groups = Array.from(navigation.querySelectorAll('[data-nav-group-label]')).map((label) => label.textContent);
    expect(groups).toEqual(['Workspace', 'Build', 'Operate', 'System']);

    // 顶栏显示当前目的地；侧栏底部显示真实 Runtime 上下文（状态来自诊断请求，需等待其解析）。
    expect(document.querySelector('[data-shell-destination]')).toHaveTextContent('Overview');
    const runtimeCard = document.querySelector('[data-shell-runtime-context]');
    expect(runtimeCard).not.toBeNull();
    expect(runtimeCard).toHaveAttribute('href', '/settings/runtime');
    await waitFor(() => expect(runtimeCard?.textContent).toContain('Ready'));
  });

  it('受限管理员的运行时事实不提供未授权的设置入口', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/collections');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      return Promise.resolve(path.endsWith('/auth/session') ? Response.json({
        owner: { id: 'adm_test', email: 'reader@example.test' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        role: 'administrator', permission: { preset: 'custom', customOperations: ['collections.read'] },
      }) : diagnosticResponse(path));
    }));
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    expect(within(navigation).queryByRole('link', { name: 'System settings' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-shell-runtime-context]')).not.toHaveAttribute('href');
    expect(document.querySelector('[data-runtime-badge]')).not.toHaveAttribute('href');
  });

  it('closes the navigation drawer with Escape and restores its trigger focus', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    const user = userEvent.setup();
    render(<App />);
    const trigger = await screen.findByRole('button', { name: 'Expand project navigation' });
    await user.click(trigger);
    const drawer = await screen.findByRole('dialog', { name: 'Project navigation' });
    expect(within(drawer).getByRole('link', { name: 'Collections' })).toHaveAttribute('href', '/collections');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Project navigation' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows real navigation counts from the shared overview snapshot', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    await waitFor(() => expect(document.querySelector('[data-nav-count="collections"]')).not.toBeNull());
    expect(document.querySelector('[data-nav-count="collections"]')).toHaveTextContent('2');
    // Hooks & Events 计数是启用的 Hook + Webhook + 事件触发数量之和。
    expect(document.querySelector('[data-nav-count="events"]')).toHaveTextContent('3');
    expect(document.querySelector('[data-nav-count="schedules"]')).toHaveTextContent('2');
    expect(within(navigation).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
  });

  it('normalises a legacy query form on a canonical path without a full reload', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    // 路径已是 canonical，只有 query 是历史写法：真实路由会命中，必须由 Shell 内的归一处理。
    window.history.replaceState({}, '', '/changes?view=pending&q=posts');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/changes?tab=pending&q=posts'));
    expect(await screen.findByRole('heading', { name: 'Changes', level: 1 })).toBeInTheDocument();
    const changesNavigation = screen.getByRole('navigation', { name: 'Change sections' });
    expect(within(changesNavigation).getByRole('link', { name: 'Pending' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens Hooks & Events from the shared Command Registry and keeps the legacy deep link working', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/automations?tab=webhooks&q=mail');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    // 旧 /automations?tab=webhooks 经 route-map 落到 Hooks & Events 的 Webhooks 工作面，并保留搜索上下文。
    const eventsNavigation = await screen.findByRole('navigation', { name: 'Hooks & Events sections' });
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/events?tab=webhooks&q=mail'));
    expect(within(eventsNavigation).getByRole('link', { name: 'Webhooks' })).toHaveAttribute('aria-current', 'page');

    const navigation = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(within(navigation).getByRole('link', { name: 'Hooks & Events' })).toHaveAttribute('aria-current', 'page');

    // 命令面板导航到定时任务（新的一级入口）。
    await user.click(screen.getByRole('button', { name: /Search commands/ }));
    const search = screen.getByRole('combobox', { name: 'Search commands' });
    await user.type(search, 'Scheduled jobs');
    await user.click(await screen.findByRole('option', { name: 'Scheduled jobs' }));
    expect(await screen.findByRole('heading', { name: 'Scheduled jobs', level: 1 })).toBeInTheDocument();
  });

  it('keeps the API workspace tabs in the URL', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/connect/sdk');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    // 旧 /connect/sdk 落到 API 工作区的 OpenAPI 工作面。
    const apiNavigation = await screen.findByRole('navigation', { name: 'API workspace sections' });
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/api?tab=openapi'));
    expect(within(apiNavigation).getByRole('link', { name: 'OpenAPI' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(apiNavigation).getByRole('link', { name: 'Request log' }));
    expect(window.location.pathname + window.location.search).toBe('/api?tab=logs');
    expect(await screen.findByRole('heading', { name: 'API workspace', level: 1 })).toBeInTheDocument();
  });

  it('opens the MCP guide and links back to the new destinations', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/mcp');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'MCP', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>')).toBeInTheDocument();
    // MCP 不占一级菜单，但接入入口必须可达（spec §3.3）。
    expect(document.querySelector('[data-shell-destination]')).toHaveTextContent('MCP');
  });

  it('persists a keyboard reachable light and dark theme toggle', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('modelry-admin-locale', 'en');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    const mounted = render(<App />);
    const darkThemeButton = await screen.findByRole('button', { name: 'Switch to dark theme' });
    const ownerMenu = document.querySelector('[data-owner-menu]');
    expect(ownerMenu?.querySelector('[data-theme-button]')).toBeNull();
    await user.click(ownerMenu?.querySelector('button') as HTMLElement);
    expect(screen.getByText('Session active')).toBeInTheDocument();
    expect(ownerMenu).not.toHaveTextContent('Control Plane');

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

    const language = await screen.findByRole('button', { name: 'Switch language to Simplified Chinese' });
    const navigation = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(within(navigation).getByRole('link', { name: 'Collections' })).toBeInTheDocument();
    await user.click(language);

    const localizedNavigation = await screen.findByRole('navigation', { name: '项目导航' });
    expect(within(localizedNavigation).getByRole('link', { name: '集合' })).toBeInTheDocument();
    expect(within(localizedNavigation).getByRole('link', { name: 'API 工作区' })).toBeInTheDocument();
    expect(within(localizedNavigation).getByRole('link', { name: '定时任务' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?filter=keep#selected');
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
      expect(window.localStorage.getItem('modelry-admin-locale')).toBe('zh-CN');
    });
    await user.click(document.querySelector('[data-owner-menu] > button') as HTMLElement);
    expect(document.querySelector('[data-owner-menu]')).not.toHaveTextContent(/控制面|控制平面/);

    mounted.unmount();
    render(<App />);
    expect(await screen.findByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '切换语言为 English' })).toHaveTextContent('EN');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?filter=keep#selected');
  });

  it('opens the shared command palette from the keyboard and executes real navigation', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Project navigation' });
    const trigger = screen.getByRole('button', { name: /Search commands/ });

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox', { name: 'Search commands' });
    await user.type(input, 'System settings');
    expect(within(dialog).getByRole('option', { name: 'System settings' })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: 'System settings' })).toBeInTheDocument();
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
        return Promise.resolve(Response.json({
          error: { code: 'UNAUTHENTICATED', message: 'An Owner session is required.', details: {}, requestId: 'req_test' },
        }, { status: 401 }));
      }
      if (path.endsWith('/bootstrap/status')) {
        return Promise.resolve(Response.json({ state: 'required' }));
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

  // Spec 0001 §6.5：保存后的 Pending Change 是 durable 的，Shell 的 Changes
  // 入口必须原地显示同一数量，而不是另一处“未保存”草稿。
  it('shows the durable Pending Change count on the Changes navigation entry', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/collections');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/changes?limit=100')) {
        return Promise.resolve(Response.json({ data: [
          {
            changeSetId: 'chg_posts', collectionId: 'col_posts', version: 2, status: 'ready',
            operations: [
              { id: 'op_1', kind: 'field', action: 'add', definition: { name: 'subtitle', type: 'text' } },
              { id: 'op_2', kind: 'index', action: 'add', definition: { name: 'idx_title', fields: ['title'] } },
            ],
          },
        ] }));
      }
      return Promise.resolve(diagnosticResponse(path));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    expect(await within(navigation).findByRole('link', { name: 'Changes · 2 pending changes' })).toBeInTheDocument();
  });
});
