import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { allApplicationEndpoints } from './api/endpoints';
import { App } from './app';
import { en } from './i18n/locales/en';
import { zhCN } from './i18n/locales/zh-CN';

type Resource = { [key: string]: string | Resource };

// flatten 收集所有叶子键，用于比较两种语言的键集合。
function flatten(resource: Resource, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix === '' ? key : prefix + '.' + key;
    if (typeof value === 'string') keys.push(path);
    else keys.push(...flatten(value, path));
  }
  return keys.sort();
}

function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
}

function setupFetch(role: 'owner' | 'administrator' = 'owner') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/session')) {
      return response({
        owner: { id: 'own_test', email: 'owner@example.test' },
        expiresAt: '2030-01-01T00:00:00Z',
        role,
        permission: role === 'owner' ? { preset: 'fullAccess' } : { preset: 'readOnly' },
      });
    }
    if (path.endsWith('/runtime/status')) return response({ state: 'ready', observedAt: '2026-09-25T09:00:00Z', database: { state: 'ready' }, localStorage: { state: 'ready', message: 'ok' } });
    if (path.endsWith('/storage/status')) return response({ database: { state: 'ready' }, localStorage: { state: 'ready', provider: 'Local' } });
    if (path.startsWith('/admin/api/v1/collections?')) return response({ data: [] });
    return response({ data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Community V0.1.x closure', () => {
  it('keeps English and Simplified Chinese key sets identical', () => {
    const english = flatten(en as unknown as Resource);
    const chinese = flatten(zhCN as unknown as Resource);
    const missingInChinese = english.filter((key) => !chinese.includes(key));
    const missingInEnglish = chinese.filter((key) => !english.includes(key));
    expect(missingInChinese).toEqual([]);
    expect(missingInEnglish).toEqual([]);
  });

  it('covers every accepted V0.1.x surface in both languages', () => {
    const surfaces = [
      'navigation.activity', 'navigation.drift', 'navigation.runtimeSettings', 'navigation.portability',
      'navigation.administrators', 'navigation.mail', 'navigation.automations', 'navigation.extensions',
      'navigation.secrets', 'navigation.collections', 'navigation.changes', 'navigation.access',
      'activity.title', 'drift.title', 'runtimeSettings.title', 'portability.title',
      'mail.title', 'storage.title', 'administrators.title', 'automation.title', 'extensions.title',
      // V0.1 时代的四个产品面已经迁移到同一套 i18n，必须与 V0.1.x 面共享同一份词条。
      'collections.title', 'records.title', 'changes.title',
      'schema.title', 'schema.views.history', 'schema.previewReviewTitle',
      'security.title', 'security.tabs.rules', 'security.simulationTitle',
      'access.title', 'access.auditTitle', 'access.revealTitle',
      'api.workspaceTitle', 'api.requestDetailTitle', 'api.endpointTitles.listApplicationRecords',
    ];
    const english = flatten(en as unknown as Resource);
    const chinese = flatten(zhCN as unknown as Resource);
    for (const key of surfaces) {
      expect(english, 'missing English key ' + key).toContain(key);
      expect(chinese, 'missing Chinese key ' + key).toContain(key);
    }
  });

  it('gives every Application endpoint a localized label and keeps the compact access-mode vocabulary shared', () => {
    const english = flatten(en as unknown as Resource);
    const chinese = flatten(zhCN as unknown as Resource);
    const endpoints = allApplicationEndpoints([{
      id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 1,
      fields: [{ id: 'fld_attachment', name: 'attachment', type: 'file' }],
    }, {
      id: 'col_members', name: 'members', type: 'Auth', schemaVersion: 1,
      fields: [{ id: 'fld_email', name: 'email', type: 'text' }],
    }]);
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(english, 'missing English endpoint title for ' + endpoint.operationId).toContain(endpoint.titleKey);
      expect(chinese, 'missing Chinese endpoint title for ' + endpoint.operationId).toContain(endpoint.titleKey);
    }
    // 同一套访问模式词汇同时服务 Application API 与 Collection Security。
    for (const mode of ['noAccess', 'anyone', 'signedInUsers', 'recordOwner', 'custom']) {
      expect(english).toContain('accessModes.' + mode + '.label');
      expect(chinese).toContain('accessModes.' + mode + '.label');
      expect(english).toContain('accessModes.' + mode + '.description');
      expect(chinese).toContain('accessModes.' + mode + '.description');
    }
  });

  it('keeps the global top bar order and the theme control outside the user menu', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/');
    setupFetch();
    render(<App />);

    const topbar = await screen.findByRole('banner').catch(() => null) ?? document.querySelector('.topbar');
    expect(topbar).not.toBeNull();
    const actions = (topbar as HTMLElement).querySelector('.topbar__actions') as HTMLElement;
    expect(actions).not.toBeNull();
    const order = Array.from(actions.children)
      .filter((child) => !child.classList.contains('topbar__action-divider'))
      .map((child) => {
        if (child.classList.contains('command-palette-trigger')) return 'palette';
        if (child.classList.contains('locale-switcher')) return 'language';
        if (child.classList.contains('theme-button')) return 'theme';
        if (child.classList.contains('owner-menu')) return 'user';
        return 'runtime';
      });
    expect(order[0]).toBe('palette');
    expect(order[order.length - 1]).toBe('user');
    expect(order).toContain('language');
    expect(order).toContain('theme');
    expect(order.indexOf('palette')).toBeLessThan(order.indexOf('runtime'));
    expect(order.indexOf('runtime')).toBeLessThan(order.indexOf('language'));
    expect(order.indexOf('language')).toBeLessThan(order.indexOf('theme'));
    expect(order.indexOf('theme')).toBeLessThan(order.indexOf('user'));

    const themeButton = (topbar as HTMLElement).querySelector('.theme-button');
    expect(themeButton).not.toBeNull();
    expect(themeButton?.closest('.owner-menu')).toBeNull();
  });

  it('persists the theme choice outside the user menu', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.localStorage.removeItem('modelry-admin-theme');
    window.history.pushState({}, '', '/');
    setupFetch();
    render(<App />);

    const themeButton = await waitFor(() => {
      const button = document.querySelector('.theme-button');
      expect(button).not.toBeNull();
      return button as HTMLElement;
    });
    const before = document.documentElement.dataset.theme;
    await userEvent.click(themeButton);
    const after = document.documentElement.dataset.theme;
    expect(after).not.toBe(before);
    expect(window.localStorage.getItem('modelry-admin-theme')).toBe(after);
  });

  it('exposes accepted surfaces through the command palette and gates Owner-only entries', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    window.history.pushState({}, '', '/');
    setupFetch('owner');
    const { unmount } = render(<App />);

    await waitFor(() => expect(document.querySelector('.command-palette-trigger')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('a.nav-link[href="/activity"]')).not.toBeNull());
    // Command Registry 通过 effect 提交 revision；等一个宏任务再打开面板，避免读到上一版命令。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog');
    const labels = within(palette).getAllByRole('option').map((option) => option.textContent ?? '');
    for (const expected of ['Open Activity', 'Open Drift', 'Open Runtime settings', 'Open Developer and portability', 'Open Mail settings', 'Open Administrators']) {
      expect(labels.join('|')).toContain(expected);
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    unmount();

    setupFetch('administrator');
    render(<App />);
    await waitFor(() => expect(document.querySelector('.command-palette-trigger')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await userEvent.keyboard('{Control>}k{/Control}');
    const restricted = await screen.findByRole('dialog');
    const restrictedLabels = within(restricted).getAllByRole('option').map((option) => option.textContent ?? '').join('|');
    expect(restrictedLabels).toContain('Open Activity');
    expect(restrictedLabels).not.toContain('Open Mail settings');
    expect(restrictedLabels).not.toContain('Open Administrators');
    expect(restrictedLabels).not.toContain('Open Developer and portability');
  });
});