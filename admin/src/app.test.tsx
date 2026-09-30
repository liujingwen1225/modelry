import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './app';

function diagnosticResponse(path: string): Response {
  if (path.endsWith('/auth/session')) {
    return new Response(JSON.stringify({
      owner: { id: 'own_test', email: 'owner@example.com' },
      expiresAt: '2026-09-25T09:00:00Z',
      role: 'owner',
      permission: { preset: 'fullAccess' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

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
  it('opens the Automations workspace from the shared Command Registry', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/extensions') return Promise.resolve(Response.json({ data: [] }));
      return Promise.resolve(diagnosticResponse(path));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    await user.click(screen.getByRole('button', { name: /Search commands/ }));
    const search = screen.getByRole('combobox', { name: 'Search commands' });
    await user.type(search, 'Automation');
    await user.click(await screen.findByRole('option', { name: 'Automation' }));

    // 新版信息架构：Automations 默认进入 Hooks 子页。
    expect(await screen.findByRole('heading', { name: 'Hooks' })).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Automations' })).toHaveAttribute('aria-current', 'page');
  });

  it('preserves the current Automation search context in a Command Palette create deep link', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/automations?tab=webhooks&q=mail');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/admin/api/v1/webhooks') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/secrets') return Promise.resolve(Response.json({ data: [] }));
      if (path === '/admin/api/v1/event-hooks') return Promise.resolve(Response.json({ data: [] }));
      if (path.startsWith('/admin/api/v1/collections?')) return Promise.resolve(Response.json({ data: [{ id: 'col_orders', name: 'Orders' }] }));
      return Promise.resolve(diagnosticResponse(path));
    }));
    render(<App />);

    await screen.findByRole('heading', { name: 'Automation' });
    await user.click(screen.getByRole('button', { name: /Search commands/ }));
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'Create event trigger');
    await user.click(await screen.findByRole('option', { name: 'Create event trigger' }));

    expect(await screen.findByRole('heading', { name: 'New event trigger' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/automations/triggers?q=mail&create=1');
  });

  it('renders the shared sidebar and reads runtime health through the diagnostics client', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith('/admin/api/v1/collections?')) return Promise.resolve(Response.json({ data: [] }));
      return Promise.resolve(diagnosticResponse(path));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    const navigation = await screen.findByRole('navigation', { name: 'Project navigation' });
    await waitFor(() => expect(within(navigation).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page'));
    const primaryNavigationLabels = ['Home', 'Collections', 'API & SDK', 'Automations', 'Activity & Audit', 'Changes', 'Model health', 'Access & keys', 'Settings'];
    const primaryNavigationLinks = within(navigation).getAllByRole('link');
    expect(primaryNavigationLinks.map((link) => link.textContent)).toEqual(primaryNavigationLabels);
    expect(primaryNavigationLinks.map((link) => link.getAttribute('aria-label'))).toEqual(primaryNavigationLabels);
    expect(primaryNavigationLinks.map((link) => link.getAttribute('title'))).toEqual(primaryNavigationLabels);
    expect(await screen.findByRole('heading', { name: 'Your backend is ready' })).toBeInTheDocument();
    const buildLinks = document.querySelector('.overview-build-links');
    expect(buildLinks).not.toBeNull();
    expect(within(buildLinks as HTMLElement).getByRole('link', { name: 'API' })).toHaveAttribute('href', '/connect/api');
    expect(within(buildLinks as HTMLElement).getByRole('link', { name: 'Hooks' })).toHaveAttribute('href', '/automations/hooks');
    expect(screen.getByRole('heading', { name: 'Connect a coding agent' })).toBeInTheDocument();
    const englishAgentGuidance = 'Model Context Protocol (MCP) lets your coding agent connect to Modelry through a Service Account API Key. The agent can perform only operations granted to that account. Start with Read only; if the task needs more, grant only its required custom operations. Application data remains governed by each Collection’s Access Rules. Model changes go through review and apply, and actions are audited.';
    const chineseAgentGuidance = '模型上下文协议（MCP）让编码智能体通过服务账号 API Key 连接 Modelry。智能体只能执行该账号获准的操作。建议从“只读”开始；若任务需要更多权限，只授予其必需的自定义操作。应用数据仍由各集合的访问规则管控。模型变更需要经过复核和应用，操作会写入审计记录。';
    expect(screen.getByText(englishAgentGuidance)).toBeInTheDocument();
    await user.selectOptions(document.querySelector('.locale-switcher select') as HTMLSelectElement, 'zh-CN');
    expect(await screen.findByText(chineseAgentGuidance)).toBeInTheDocument();
    await user.selectOptions(document.querySelector('.locale-switcher select') as HTMLSelectElement, 'en');
    expect(screen.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage Service Accounts' })).toHaveAttribute('href', '/access');
    expect(screen.getByRole('region', { name: 'Runtime & storage' })).toHaveTextContent('Runtime');
    expect(screen.queryByRole('heading', { name: 'Runtime & storage' })).not.toBeInTheDocument();
    expect(document.querySelector('.diagnostics-grid')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/runtime/status', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/storage/status', expect.any(Object));
  });

  it('aggregates Automation and Settings pages while preserving the active Automation search', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.replaceState({}, '', '/automations?tab=webhooks&q=mail');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/admin/api/v1/webhooks' || path === '/admin/api/v1/secrets' || path === '/admin/api/v1/event-hooks' || path === '/admin/api/v1/jobs') return Promise.resolve(Response.json({ data: [] }));
      return Promise.resolve(diagnosticResponse(path));
    }));
    render(<App />);

    const automationNavigation = await screen.findByRole('navigation', { name: 'Automations' });
    expect(within(automationNavigation).getByText('Triggers and delivery')).toBeInTheDocument();
    expect(within(automationNavigation).getByText('Run history')).toBeInTheDocument();
    // 新版子导航包含 Hooks；Hooks 由 Extensions 工作区承载。
    expect(within(automationNavigation).getByRole('link', { name: 'Hooks' })).toHaveAttribute('href', '/automations/hooks');
    expect(within(automationNavigation).getByRole('link', { name: 'Webhooks' })).toHaveAttribute('href', '/automations/webhooks');
    await user.click(within(automationNavigation).getByRole('link', { name: 'Triggers' }));
    expect(window.location.pathname + window.location.search).toBe('/automations/triggers');

    const primaryNavigation = screen.getByRole('navigation', { name: 'Project navigation' });
    await user.click(within(primaryNavigation).getByRole('link', { name: 'Settings' }));
    const settingsNavigation = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(settingsNavigation).getByRole('link', { name: 'Status' })).toHaveAttribute('href', '/settings');
    expect(within(settingsNavigation).getByRole('link', { name: 'Files & Storage' })).toHaveAttribute('href', '/settings/storage');
    expect(within(settingsNavigation).getByRole('link', { name: 'Secrets' })).toHaveAttribute('href', '/settings/secrets');
    expect(within(settingsNavigation).getByRole('link', { name: 'Backup and restore' })).toHaveAttribute('href', '/settings/backups');
    expect(within(settingsNavigation).getByRole('link', { name: 'Data import / export' })).toHaveAttribute('href', '/settings/data');
    // SDK & Contract 与 MCP 移入 Connect，不再作为 Settings 子页。
    expect(within(settingsNavigation).queryByRole('link', { name: 'API Contract / SDK' })).not.toBeInTheDocument();
    expect(within(settingsNavigation).queryByRole('link', { name: 'MCP' })).not.toBeInTheDocument();
    expect(within(settingsNavigation).getByText('Maintenance')).toBeInTheDocument();
    expect(within(settingsNavigation).queryByRole('link', { name: 'Activity' })).not.toBeInTheDocument();
    expect(within(settingsNavigation).queryByRole('link', { name: 'Storage consistency' })).not.toBeInTheDocument();
    await user.selectOptions(document.querySelector('.locale-switcher select') as HTMLSelectElement, 'zh-CN');
    expect(await screen.findByRole('heading', { name: '状态' })).toBeInTheDocument();
    expect(screen.getByText(/移动已有文件/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('迁移');
    await user.selectOptions(document.querySelector('.locale-switcher select') as HTMLSelectElement, 'en');

    await user.click(within(primaryNavigation).getByRole('link', { name: 'Access & keys' }));
    const accessNavigation = await screen.findByRole('navigation', { name: 'Access & keys' });
    expect(within(accessNavigation).getByText('Identity')).toBeInTheDocument();
    expect(within(accessNavigation).getByText('Security')).toBeInTheDocument();
    expect(within(accessNavigation).getByRole('link', { name: 'Service Accounts' })).toHaveAttribute('href', '/access');
    expect(within(accessNavigation).getByRole('link', { name: 'Administrators' })).toHaveAttribute('href', '/access/administrators');
    expect(within(accessNavigation).getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/activity/audit');
  });

  it('opens the MCP guide from Connect with the authorized connection path', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);

    const sidebar = await screen.findByRole('navigation', { name: 'Project navigation' });
    await user.click(within(sidebar).getByRole('link', { name: 'API & SDK' }));
    const connectNavigation = await screen.findByRole('navigation', { name: 'API & SDK' });
    await user.click(within(connectNavigation).getByRole('link', { name: 'MCP' }));

    expect(await screen.findByRole('heading', { name: 'MCP', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/only operations granted to that account/)).toBeInTheDocument();
    expect(screen.getByText(/Model changes go through review and apply, and actions are audited/)).toBeInTheDocument();
    expect(screen.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage Service Accounts' })).toHaveAttribute('href', '/access');
    expect(within(connectNavigation).getByRole('link', { name: 'MCP' })).toHaveAttribute('aria-current', 'page');
  });

  it('persists a keyboard reachable light and dark theme toggle', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('modelry-admin-locale', 'en');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    const mounted = render(<App />);
    const darkThemeButton = await screen.findByRole('button', { name: 'Switch to dark theme' });
    const ownerMenu = document.querySelector('.owner-menu');
    expect(ownerMenu?.querySelector('.theme-button')).toBeNull();
    await user.click(ownerMenu?.querySelector('summary') as HTMLElement);
    expect(within(ownerMenu as HTMLElement).getByText('Session active')).toBeInTheDocument();
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

    const language = await screen.findByRole('combobox', { name: 'Language' });
    const navigation = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(within(navigation).getByRole('link', { name: 'Collections' })).toBeInTheDocument();
    await user.selectOptions(language, 'zh-CN');

    const localizedNavigation = await screen.findByRole('navigation', { name: '项目导航' });
    expect(within(localizedNavigation).getByRole('link', { name: '集合' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?filter=keep#selected');
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
      expect(window.localStorage.getItem('modelry-admin-locale')).toBe('zh-CN');
    });
    await user.click(document.querySelector('.owner-menu summary') as HTMLElement);
    expect(document.querySelector('.owner-menu')).not.toHaveTextContent(/控制面|控制平面/);

    mounted.unmount();
    render(<App />);
    expect(await screen.findByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?filter=keep#selected');
  });

  it('opens the shared command palette from the keyboard and executes real navigation', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(diagnosticResponse(String(input)))));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Project navigation' });
    const trigger = screen.getByRole('button', { name: /Search commands/ });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox', { name: 'Search commands' });
    await user.type(input, 'Settings');
    expect(within(dialog).getByRole('option', { name: 'Settings' })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: 'Status' })).toBeInTheDocument();
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
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 'UNAUTHENTICATED', message: 'An Owner session is required.', details: {}, requestId: 'req_test' },
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path.endsWith('/bootstrap/status')) {
        return Promise.resolve(new Response(JSON.stringify({ state: 'required' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
