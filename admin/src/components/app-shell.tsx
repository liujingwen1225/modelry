import {
  useMemo, useState } from 'react';
import {
  Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ChevronDown,
  Command,
  FileStack,
  GitBranch,
  HeartPulse,
  Home,
  LogOut,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sun,
  Webhook,
} from 'lucide-react';
import type { TranslationKey } from '../i18n/i18n';
import type { ControlPlanePermission } from '../auth/client';
import {
  useI18n } from '../i18n/i18n';
import {
  RuntimeBadge } from './runtime-status';
import {
  useDiagnostics } from './diagnostics-context';
import {
  CommandPaletteControl } from './command-palette';
import {
  CommandRegistryProvider, useCommandRegistry, useRegisterCommands, type AdminCommand, type CommandContext } from './command-registry';
import {
  PendingChangesProvider, usePendingChanges } from './pending-changes-context';
import {
  collectionIdFromPathname } from './route-context';
import {
  useTheme } from './theme-context';

// 新版信息架构（spec 0001 §3.1）：按开发者完成后的工作顺序排列——
// Home；BUILD/Collections；CONNECT/API & SDK；AUTOMATE/Automations；
// OBSERVE/Requests + Activity & Audit；EVOLVE/Changes + Model health；
// PROJECT/Access & keys + Settings。Requests 导航项随 M4 Requests 页交付。
const groups: Array<{
  label: TranslationKey | null;
  items: Array<{ label: TranslationKey; to: string; icon: LucideIcon; operation?: string }>;
}> = [
  { label: null, items: [{ label: 'navigation.home', to: '/', icon: Home, operation: 'runtime.read' }] },
  {
    label: 'navigation.build',
    items: [{ label: 'navigation.collections', to: '/collections', icon: FileStack, operation: 'collections.read' }],
  },
  {
    label: 'navigation.connect',
    items: [{ label: 'navigation.apiSdk', to: '/connect', icon: Network, operation: 'collections.read' }],
  },
  {
    label: 'navigation.automate',
    items: [{ label: 'navigation.automations', to: '/automations', icon: Webhook }],
  },
  {
    label: 'navigation.observe',
    items: [
      { label: 'navigation.requests', to: '/requests', icon: Activity, operation: 'requests.read' },
      { label: 'navigation.activityAudit', to: '/activity', icon: ScrollText, operation: 'activity.read' },
    ],
  },
  {
    label: 'navigation.evolve',
    items: [
      { label: 'navigation.changes', to: '/changes', icon: GitBranch, operation: 'schema.read' },
      { label: 'navigation.modelHealth', to: '/health', icon: HeartPulse, operation: 'drift.read' },
    ],
  },
  {
    label: 'navigation.project',
    items: [
      { label: 'navigation.accessKeys', to: '/access', icon: ShieldCheck, operation: 'serviceAccounts.read' },
      { label: 'navigation.settings', to: '/settings', icon: Settings2, operation: 'runtime.read' },
    ],
  },
];

type AreaLink = { label: TranslationKey; to: string; operation?: string };
type AreaSection = { label?: TranslationKey | null; links: AreaLink[] };
type ProductAreaNavigation = {
  id: 'automation' | 'connect' | 'access' | 'settings';
  label: TranslationKey;
  sections: AreaSection[];
};

function productAreaNavigation(pathname: string): ProductAreaNavigation | null {
  if (pathname.startsWith('/automations')) {
    return {
      id: 'automation',
      label: 'navigation.automations',
      sections: [
        { label: 'automation.navigation.triggers', links: [
          { label: 'automation.subnav.hooks', to: '/automations/hooks' },
          { label: 'automation.subnav.webhooks', to: '/automations/webhooks' },
          { label: 'automation.subnav.triggers', to: '/automations/triggers' },
          { label: 'automation.subnav.schedules', to: '/automations/schedules' },
        ] },
        { label: 'automation.navigation.runHistory', links: [
          { label: 'automation.subnav.deliveries', to: '/automations/deliveries' },
        ] },
      ],
    };
  }
  if (pathname.startsWith('/connect')) {
    return {
      id: 'connect',
      label: 'navigation.apiSdk',
      sections: [
        { label: null, links: [
          { label: 'navigation.connectApi', to: '/connect/api', operation: 'collections.read' },
          { label: 'navigation.connectSdk', to: '/connect/sdk' },
          { label: 'navigation.connectMcp', to: '/connect/mcp' },
        ] },
      ],
    };
  }
  if (pathname.startsWith('/access')) {
    return {
      id: 'access',
      label: 'navigation.accessKeys',
      sections: [
        { label: 'access.navigation.identity', links: [
          { label: 'access.tabs.serviceAccounts', to: '/access', operation: 'serviceAccounts.read' },
          { label: 'navigation.administrators', to: '/access/administrators', operation: 'administrators.read' },
        ] },
        { label: 'access.navigation.security', links: [
          { label: 'access.tabs.audit', to: '/activity/audit', operation: 'audit.read' },
        ] },
      ],
    };
  }
  if (pathname.startsWith('/settings')) {
    return {
      id: 'settings',
      label: 'navigation.settings',
      sections: [
        { label: 'settings.navigation.project', links: [
          { label: 'settings.navigation.status', to: '/settings', operation: 'runtime.read' },
          { label: 'settings.navigation.runtime', to: '/settings/runtime', operation: 'settings.read' },
        ] },
        { label: 'settings.navigation.service', links: [
          { label: 'settings.navigation.filesStorage', to: '/settings/storage', operation: 'storage.read' },
          { label: 'settings.navigation.mail', to: '/settings/mail', operation: 'mail.read' },
          { label: 'settings.navigation.secrets', to: '/settings/secrets' },
        ] },
        { label: 'settings.navigation.maintenance', links: [
          { label: 'settings.navigation.backupRestore', to: '/settings/backups' },
          { label: 'settings.navigation.dataTransfer', to: '/settings/data' },
        ] },
      ],
    };
  }
  return null;
}

// 子导航为纯路径形态（query 参数仅保留在页面内部状态）。
// 命中多个前缀时只高亮最具体的那个（如 /access 与 /access/administrators）。
function isAreaLinkMatch(link: AreaLink, pathname: string): boolean {
  return pathname === link.to || pathname.startsWith(`${link.to}/`);
}

function isPrimaryLinkActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

function areaLinkTarget(link: AreaLink): string {
  return link.to;
}

const readOnlyControlPlaneOperations = new Set([
  'runtime.read', 'storage.read', 'collections.read', 'records.read', 'files.read', 'schema.read',
  'accessRules.read', 'authentication.read', 'users.read', 'sessions.read', 'serviceAccounts.read',
  'apiKeys.read', 'requests.read', 'audit.read', 'administrators.read', 'mail.read',
  // #27/#28 新增的只读操作必须与后端 readOnly preset 保持一致。
  'activity.read', 'drift.read', 'policy.simulate', 'settings.read', 'records.export',
]);

// allowsOperation 在 Admin Shell 中复现 Control Plane 的 fail closed 语义。
// 没有显式 operation 的导航项只对 Owner 可见。
function allowsOperation(role: AppShellProps['role'], permission: ControlPlanePermission | undefined, operation: string): boolean {
  if (role === undefined || role === 'owner') return true;
  if (!permission) return false;
  switch (permission.preset) {
    case 'fullAccess': return true;
    case 'readOnly': return readOnlyControlPlaneOperations.has(operation);
    case 'custom': return (permission.customOperations ?? []).includes(operation);
    default: return false;
  }
}

// canSeeNavigationItem 让没有显式 operation 的导航项只对 Owner 可见。
function canSeeNavigationItem(role: AppShellProps['role'], permission: ControlPlanePermission | undefined, item: { operation?: string }): boolean {
  if (item.operation === undefined) return role === undefined || role === 'owner';
  return allowsOperation(role, permission, item.operation);
}
function Sidebar({ role, permission, collapsed, onToggleCollapsed }: {
  role?: AppShellProps['role'];
  permission?: ControlPlanePermission;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t, formatPlural } = useI18n();
  const { pathname } = useLocation();
  const { pendingOperations } = usePendingChanges();
  const pendingLabel = formatPlural(pendingOperations, {
    one: t('shell.pendingChangeOne'),
    other: t('shell.pendingChangeMany'),
  });
  const visibleGroups = useMemo(
    () => groups
      .map((group) => ({ ...group, items: group.items.filter((item) => canSeeNavigationItem(role, permission, item)) }))
      .filter((group) => group.items.length > 0),
    [role, permission],
  );
  // 侧栏布局：≤680px 是横向顶栏；681–1023px 展开为 210px 栏、≥1024px 展开为 248px 栏；
  // 折叠后统一收成 72px 图标轨道。状态仍由上层 sidebarCollapsed 驱动，宽度只用响应式变体表达。
  const collapsedBlock = collapsed ? 'hidden' : 'hidden min-[681px]:block';
  const navLinkClassName = (isActive: boolean) => [
    'flex min-h-[35px] shrink-0 items-center gap-1.5 rounded-[7px] border border-transparent px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    collapsed
      ? 'min-[681px]:min-h-[39px] min-[681px]:justify-center min-[681px]:gap-0 min-[681px]:rounded-[5px] min-[681px]:px-0 min-[681px]:text-[13px]'
      : 'min-[681px]:min-h-[39px] min-[681px]:gap-[11px] min-[681px]:rounded-[5px] min-[681px]:px-2.5 min-[681px]:text-[13px]',
    isActive ? 'border-sidebar-accent bg-sidebar-accent font-semibold text-sidebar-accent-foreground' : '',
  ].filter(Boolean).join(' ');
  return (
    <aside
      aria-label={t('navigation.projectNavigation')}
      className={[
        'sticky top-0 z-[5] flex w-full flex-col border-b border-sidebar-border bg-sidebar px-2.5 pt-2 pb-2.5 text-sidebar-foreground',
        'min-[681px]:fixed min-[681px]:inset-y-0 min-[681px]:left-0 min-[681px]:h-dvh min-[681px]:border-r min-[681px]:border-b-0 min-[681px]:pt-[27px] min-[681px]:pb-[15px]',
        collapsed
          ? 'min-[681px]:w-[72px] min-[681px]:px-2.5'
          : 'min-[681px]:w-[210px] min-[681px]:px-[15px] lg:w-[248px]',
      ].filter(Boolean).join(' ')}
      data-shell-sidebar
    >
      <div
        className={[
          'flex items-center gap-[9px] px-[7px] pt-px pb-2.25',
          collapsed
            ? 'min-[681px]:flex-col min-[681px]:gap-[9px] min-[681px]:px-0 min-[681px]:pb-5'
            : 'min-[681px]:px-2.5 min-[681px]:pt-0 min-[681px]:pb-[29px]',
        ].filter(Boolean).join(' ')}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground min-[681px]:size-[27px]" aria-hidden="true"><Command size={17} strokeWidth={2.2} /></span>
        <span className={['text-[17px] font-extrabold tracking-[-0.8px] min-[681px]:text-[19px]', collapsed ? 'min-[681px]:hidden' : ''].filter(Boolean).join(' ')}>modelry</span>
        <button
          aria-label={t(collapsed ? 'shell.expandProjectNavigation' : 'shell.collapseProjectNavigation')}
          className="hidden size-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-input bg-card text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring min-[681px]:grid"
          onClick={onToggleCollapsed}
          title={t(collapsed ? 'shell.expandProjectNavigation' : 'shell.collapseProjectNavigation')}
          type="button"
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" size={17} /> : <PanelLeftClose aria-hidden="true" size={17} />}
        </button>
      </div>
      <nav
        aria-label={t('navigation.projectNavigation')}
        className="flex min-h-0 flex-1 flex-row gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin] min-[681px]:flex-col min-[681px]:gap-2 min-[681px]:overflow-x-hidden min-[681px]:overflow-y-auto"
      >
        {visibleGroups.map((group, groupIndex) => (
          <div className="contents min-[681px]:grid min-[681px]:gap-[3px]" key={group.label ?? 'overview'}>
            {group.label && <p className={['mx-2.5 mt-2.25 mb-1 text-[10px] font-bold uppercase tracking-[1.2px] text-subtle-foreground', collapsedBlock].join(' ')} data-nav-group-label>{t(group.label)}</p>}
            {group.items.map(({ label, to, icon: Icon }) => {
              const showsPendingCount = to === '/changes' && pendingOperations > 0;
              return (
                <NavLink
                  aria-label={showsPendingCount ? `${t(label)} · ${pendingLabel}` : t(label)}
                  aria-current={isPrimaryLinkActive(pathname, to) ? 'page' : undefined}
                  className={() => navLinkClassName(isPrimaryLinkActive(pathname, to))}
                  end={to === '/'}
                  key={to}
                  title={t(label)}
                  to={to}
                >
                  <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                  <span className={collapsed ? 'hidden min-[391px]:inline min-[681px]:hidden' : 'hidden min-[391px]:inline'}>{t(label)}</span>
                  {showsPendingCount && (
                    <span
                      aria-hidden="true"
                      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold tabular-nums text-primary-foreground"
                    >{pendingOperations}</span>
                  )}
                </NavLink>
              );
            })}
            {groupIndex < visibleGroups.length - 1 && <div className={['mx-2.25 mt-3 mb-1.25 h-px bg-border', collapsedBlock].join(' ')} />}
          </div>
        ))}
      </nav>
      <div className={['gap-2.25 border-t border-sidebar-border px-2 pt-3.5 pb-0.5', collapsed ? 'hidden' : 'hidden min-[681px]:grid'].join(' ')}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_var(--accent-cta-soft)]" />{t('navigation.localProject')}</div>
      </div>
    </aside>
  );
}

function ThemeButton() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const nextLabel = theme === 'dark' ? t('shell.themeSwitchToLight') : t('shell.themeSwitchToDark');
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button
      aria-label={nextLabel}
      className="grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-lg border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring min-[681px]:size-[34px]"
      data-theme-button
      onClick={toggleTheme}
      title={nextLabel}
      type="button"
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
    </button>
  );
}

function ProductAreaNavigation({ area, role, permission, pathname }: {
  area: ProductAreaNavigation;
  role?: AppShellProps['role'];
  permission?: ControlPlanePermission;
  pathname: string;
}) {
  const { t } = useI18n();
  const sections = area.sections
    .map((section) => ({ ...section, links: section.links.filter((link) => canSeeNavigationItem(role, permission, link)) }))
    .filter((section) => section.links.length > 0);

  if (!sections.length) return null;
  const activeLinks = sections.flatMap((section) => section.links).filter((link) => isAreaLinkMatch(link, pathname));
  const activeLink = activeLinks.sort((a, b) => b.to.length - a.to.length)[0];
  return (
    <nav
      aria-label={t(area.label)}
      className="flex min-h-[43px] items-center gap-2.25 overflow-x-auto border-b bg-card px-2.5 py-1.25 [scrollbar-width:thin] min-[681px]:min-h-12 min-[681px]:gap-3.75 min-[681px]:px-[clamp(25px,4.2vw,64px)] min-[681px]:py-1.5"
    >
      {sections.map((section, index) => <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2 first:border-l-0 first:pl-0 min-[681px]:pl-[13px]" key={section.label ?? `section-${index}`}>
        {section.label && <span className="mx-1.5 ml-0.5 text-[9px] font-bold uppercase tracking-[0.8px] text-subtle-foreground">{t(section.label)}</span>}
        {section.links.map((link) => {
          const active = link === activeLink;
          return <Link
            aria-current={active ? 'page' : undefined}
            className={[
              'inline-flex min-h-[30px] shrink-0 items-center rounded-[7px] border border-transparent px-[7px] text-[10px] font-medium whitespace-nowrap text-muted-foreground no-underline hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              'min-[681px]:min-h-[31px] min-[681px]:px-2.25 min-[681px]:text-[11px]',
              active ? 'border-accent-cta-soft bg-accent-cta-soft font-bold text-accent-cta-ink' : '',
            ].filter(Boolean).join(' ')}
            key={link.to}
            to={areaLinkTarget(link)}
          >{t(link.label)}</Link>;
        })}
      </div>)}
    </nav>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="flex items-center" data-locale-switcher>
      <span className="sr-only">{t('shell.language')}</span>
      <select
        aria-label={t('shell.language')}
        className="min-h-[30px] max-w-[88px] cursor-pointer rounded-lg border border-input bg-card px-1 text-[10px] text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring min-[681px]:min-h-8 min-[681px]:max-w-[116px] min-[681px]:px-2 min-[681px]:text-[11px] max-[390px]:max-w-[74px]"
        onChange={(event) => setLocale(event.target.value as 'en' | 'zh-CN')}
        value={locale}
      >
        <option value="en">{t('shell.english')}</option>
        <option value="zh-CN">{t('shell.simplifiedChinese')}</option>
      </select>
    </label>
  );
}

export type AppShellProps = {
  ownerEmail?: string;
  sessionExpiresAt?: string;
  role?: 'owner' | 'administrator';
  permission?: ControlPlanePermission;
  onLogout?: () => Promise<void>;
};

function OwnerMenu({ ownerEmail, sessionExpiresAt, onLogout, role }: AppShellProps) {
  const [signOutState, setSignOutState] = useState<'idle' | 'loading' | 'error'>('idle');
  const { formatDate, t } = useI18n();
  const ownerLabel = ownerEmail ? t('shell.ownerMenuFor', { email: ownerEmail }) : t('shell.ownerMenu');

  async function signOut() {
    if (!onLogout || signOutState === 'loading') return;
    setSignOutState('loading');
    try {
      await onLogout();
    } catch {
      setSignOutState('error');
      return;
    }
    setSignOutState('idle');
  }

  return (
    <details className="relative flex items-center" data-owner-menu>
      <summary
        aria-label={ownerLabel}
        className="flex cursor-pointer list-none items-center gap-[7px] rounded-full border border-transparent py-1 pr-2 pl-1 text-[11px] font-semibold text-ink-secondary hover:border-border hover:bg-accent open:border-border open:bg-accent [&::-webkit-details-marker]:hidden"
      >
        <span className="grid size-[25px] shrink-0 place-items-center rounded-full bg-accent-cta-soft text-[10px] font-bold text-accent-cta-ink" aria-hidden="true">{ownerEmail?.slice(0, 1).toUpperCase() ?? 'O'}</span>
        <span className="max-w-[190px] overflow-hidden text-ellipsis whitespace-nowrap max-[680px]:max-w-[110px] max-[390px]:hidden">{ownerEmail ?? t('shell.owner')}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </summary>
      <div className="absolute top-[calc(100%+8px)] right-0 z-[8] w-[min(290px,calc(100vw-24px))] rounded-md border border-border bg-card p-3.25 shadow-floating">
        <div className="grid gap-[3px] border-b border-border px-[3px] pt-0.5 pb-2.75">
          <strong className="text-[11px] text-foreground [overflow-wrap:anywhere]">{ownerEmail ?? t('shell.owner')}</strong>
          <span className="text-[10px] text-muted-foreground">{t(role === 'administrator' ? 'shell.roleAdministrator' : 'shell.roleOwner')}</span>
          <span className="text-[10px] text-muted-foreground">{t('shell.ownerSessionActive')}</span>
          {sessionExpiresAt && <span className="text-[10px] text-muted-foreground">{t('shell.expires', { date: formatDate(sessionExpiresAt) })}</span>}
        </div>
        <div className="flex items-center gap-[7px] pt-2 text-[10px] text-muted-foreground">
          {onLogout && (
            <button
              aria-disabled={signOutState === 'loading'}
              className="ml-auto flex min-h-8 cursor-pointer items-center gap-[7px] rounded-[7px] border border-input bg-card px-2.25 text-[10px] text-ink-secondary enabled:hover:border-danger/40 enabled:hover:bg-danger-soft enabled:hover:text-danger disabled:cursor-wait disabled:opacity-65"
              disabled={signOutState === 'loading'}
              onClick={() => void signOut()}
              type="button"
            >
              <LogOut aria-hidden="true" size={15} />
              {signOutState === 'loading' ? t('shell.signingOut') : t('shell.signOut')}
            </button>
          )}
        </div>
        {signOutState === 'error' && <p className="mt-2.25 mb-0 text-[10px] text-danger" role="alert">{t('shell.signOutFailed')}</p>}
      </div>
    </details>
  );
}

function recordsTarget(context: CommandContext): string {
  const collectionPath = `/collections/${encodeURIComponent(context.collectionId ?? '')}`;
  const searchParams = context.pathname === collectionPath ? new URLSearchParams(context.search) : new URLSearchParams();
  searchParams.delete('record');
  searchParams.delete('edit');
  searchParams.set('new', '1');
  const search = searchParams.toString();
  return `${collectionPath}${search ? `?${search}` : ''}`;
}

function ShellCommands({ role, permission }: { role?: AppShellProps['role']; permission?: ControlPlanePermission }) {
  const { t, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const { runtime, storage } = useDiagnostics();
  const { recentCollections } = useCommandRegistry();
  const { pathname } = useLocation();
  const currentId = collectionIdFromPathname(pathname);

  const commands = useMemo<AdminCommand[]>(() => {
    const go = (id: string, key: TranslationKey, to: string, keywords: string[] = []): AdminCommand => ({
      id,
      category: 'commands.categories.navigate',
      label: () => t(key),
      keywords: () => keywords,
      execute: (context) => context.navigate(to),
    });

    const result: AdminCommand[] = [
      go('navigate.overview', 'commands.overview', '/'),
      go('navigate.collections', 'commands.collections', '/collections', ['build']),
      go('navigate.api', 'commands.api', '/connect/api'),
      go('navigate.changes', 'commands.changes', '/changes'),
      go('navigate.access', 'commands.access', '/access'),
      go('navigate.automations', 'commands.automations', '/automations', ['webhook', 'event hook', 'cron', 'delivery']),
      go('navigate.extensions', 'commands.extensions', '/automations/hooks', ['hooks', 'lifecycle', 'runtime', 'extension', '扩展']),
      go('navigate.secrets', 'commands.secrets', '/settings/secrets', ['write-only', 'secret']),
      go('navigate.settings', 'commands.settings', '/settings'),
      ...(allowsOperation(role, permission, 'activity.read') ? [go('navigate.activity', 'commands.activity', '/activity', ['timeline', 'operations', 'audit'])] : []),
      ...(allowsOperation(role, permission, 'drift.read') ? [go('navigate.drift', 'commands.drift', '/health', ['consistency', 'projection', 'reconcile'])] : []),
      ...(allowsOperation(role, permission, 'settings.read') ? [go('navigate.runtimeSettings', 'commands.runtimeSettings', '/settings/runtime', ['runtime', 'configuration', 'restart'])] : []),
      ...(role === undefined || role === 'owner' ? [
        go('navigate.backupRestore', 'commands.backupRestore', '/settings/backups', ['backup', 'restore']),
        go('navigate.dataTransfer', 'commands.dataTransfer', '/settings/data', ['import', 'export', 'ndjson']),
        go('navigate.apiContract', 'commands.apiContract', '/connect/sdk', ['sdk', 'openapi', 'contract']),
        go('navigate.mcp', 'commands.mcp', '/connect/mcp', ['agent', 'model context protocol']),
      ] : []),
      ...(role === undefined || role === 'owner' ? [
        {
          id: 'navigate.administrators',
          category: 'commands.categories.system' as const,
          label: () => t('commands.administrators'),
          keywords: () => [t('administrators.searchKeywords')],
          execute: (context: CommandContext) => context.navigate('/access/administrators'),
        },
        {
          id: 'navigate.mail',
          category: 'commands.categories.system' as const,
          label: () => t('commands.mail'),
          keywords: () => [t('mail.searchKeywords')],
          execute: (context: CommandContext) => context.navigate('/settings/mail'),
        },
      ] : []),
      {
        id: 'create.collection',
        category: 'commands.categories.create',
        label: () => t('commands.createCollection'),
        keywords: () => ['collection', 'model'],
        execute: (context) => context.navigate('/collections/new'),
      },
      ...recentCollections.map((collection): AdminCommand => ({
        id: `collection.recent.${collection.id}`,
        category: 'commands.categories.collection',
        label: () => t('commands.openCollection', { name: collection.name }),
        keywords: () => [collection.name, collection.type],
        execute: (context) => context.navigate(`/collections/${encodeURIComponent(collection.id)}`),
      })),
      {
        id: 'collection.create-record',
        category: 'commands.categories.create',
        label: () => {
          const collection = recentCollections.find((item) => item.id === currentId);
          return collection ? t('commands.createRecordIn', { name: collection.name }) : t('commands.createRecord');
        },
        keywords: () => ['record', 'user'],
        isVisible: (context) => Boolean(context.collectionId),
        execute: (context) => context.navigate(recordsTarget(context)),
      },
      ...([
        { key: 'currentRecords', path: '' },
        { key: 'currentSchema', path: '/model' },
        { key: 'currentSecurity', path: '/access' },
        { key: 'currentAPI', path: '/api' },
        { key: 'currentRealtime', path: '/api?tab=realtime' },
      ] as const).map(({ key, path }): AdminCommand => ({
        id: `collection.current.${key}`,
        category: 'commands.categories.collection',
        label: () => t(`commands.${key}`),
        keywords: () => ['records', 'model', 'schema', 'access', 'security', 'api', 'realtime', 'events', 'stream'],
        isVisible: (context) => Boolean(context.collectionId),
        execute: (context) => context.navigate(`/collections/${encodeURIComponent(context.collectionId ?? '')}${path}`),
      })),
      {
        id: 'appearance.theme',
        category: 'commands.categories.appearance',
        label: () => t(theme === 'dark' ? 'commands.switchToLight' : 'commands.switchToDark'),
        keywords: () => ['theme', 'light', 'dark'],
        execute: () => toggleTheme(),
      },
      {
        id: 'appearance.locale.en',
        category: 'commands.categories.appearance',
        label: () => t('commands.switchToEnglish'),
        keywords: () => ['language', 'locale', 'english'],
        isVisible: () => locale !== 'en',
        execute: () => setLocale('en'),
      },
      {
        id: 'appearance.locale.zh-CN',
        category: 'commands.categories.appearance',
        label: () => t('commands.switchToChinese'),
        keywords: () => ['language', 'locale', 'Chinese', '中文'],
        isVisible: () => locale !== 'zh-CN',
        execute: () => setLocale('zh-CN'),
      },
    ];

    const runtimeUnavailable = runtime.state === 'error' || (runtime.state === 'ready' && runtime.value.state !== 'ready');
    if (runtimeUnavailable) {
      result.push({
        id: 'diagnostics.runtime',
        category: 'commands.categories.system',
        label: () => t('commands.runtimeProblem'),
        keywords: () => ['health', 'runtime'],
        execute: (context) => context.navigate('/settings'),
      });
    }
    const storageUnavailable = storage.state === 'error' || (storage.state === 'ready' && (storage.value.localStorage.state !== 'ready' || storage.value.database.state !== 'ready'));
    if (storageUnavailable) {
      result.push({
        id: 'diagnostics.storage',
        category: 'commands.categories.system',
        label: () => t('commands.storageProblem'),
        keywords: () => ['health', 'storage', 'database'],
        execute: (context) => context.navigate('/settings'),
      });
    }

    return result.map((command) => ({ ...command, requiresCapabilities: ['admin:owner-session'] }));
  }, [currentId, locale, permission, recentCollections, role, runtime, setLocale, storage, t, theme, toggleTheme]);

  useRegisterCommands(commands);
  return null;
}

function AppShellLayout({ ownerEmail, sessionExpiresAt, onLogout, role, permission }: AppShellProps) {
  const { t } = useI18n();
  const location = useLocation();
  const area = productAreaNavigation(location.pathname);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  return (
    <div className="app-frame min-h-screen" data-product-area={area?.id}>
      <a
        className="fixed top-2 left-2 z-20 -translate-y-[150%] rounded-md bg-card px-3 py-2.25 text-xs font-bold text-accent-cta-ink shadow-soft focus:translate-y-0"
        href="#main-content"
      >{t('shell.skipToMainContent')}</a>
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} permission={permission} role={role} />
      <div
        className={[
          'flex min-w-0 flex-col',
          'min-[681px]:min-h-screen',
          sidebarCollapsed
            ? 'min-[681px]:ml-[72px]'
            : 'min-[681px]:ml-[210px] lg:ml-[248px]',
        ].filter(Boolean).join(' ')}
        data-shell-workspace
      >
        <header
          className="flex min-h-[50px] items-center justify-between gap-3 border-b bg-card px-4 py-2 min-[681px]:sticky min-[681px]:top-0 min-[681px]:z-[4] min-[681px]:min-h-16 min-[681px]:gap-3.25 min-[681px]:px-[clamp(25px,4.2vw,64px)] max-[680px]:[&_[data-slot=badge]]:min-h-[23px] max-[680px]:[&_[data-slot=badge]]:px-[7px] max-[680px]:[&_[data-slot=badge]]:text-[9px]"
          data-shell-topbar
        >
          <div className="flex min-w-0 items-center gap-2 min-[681px]:gap-3.25">
            <Command aria-hidden="true" className="shrink-0 text-primary min-[681px]:hidden" size={18} />
            <span className="text-[10px] font-semibold text-ink-secondary min-[681px]:text-xs max-[390px]:hidden">{t('shell.projectWorkspace')}</span>
            <span className="text-[10px] text-subtle-foreground min-[681px]:text-xs max-[390px]:hidden" aria-hidden="true">/</span>
            <span className="truncate text-[10px] text-muted-foreground min-[681px]:text-xs max-[390px]:hidden">{t('shell.localContext')}</span>
          </div>
          <div
            className="flex min-w-0 items-center gap-1.5 min-[681px]:gap-1.25 lg:gap-3.25"
            data-shell-topbar-actions
          >
            <CommandPaletteControl />
            <span className="h-5.5 w-px shrink-0 bg-border" aria-hidden="true" />
            <RuntimeBadge />
            <LanguageSwitcher />
            <ThemeButton />
            <span className="h-5.5 w-px shrink-0 bg-border" aria-hidden="true" />
            <OwnerMenu onLogout={onLogout} ownerEmail={ownerEmail} role={role} sessionExpiresAt={sessionExpiresAt} />
          </div>
        </header>
        {area && <ProductAreaNavigation area={area} pathname={location.pathname} permission={permission} role={role} />}
        <main
          className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 pt-[27px] pb-[41px] min-[681px]:px-[clamp(25px,4.2vw,64px)] min-[681px]:pt-[43px] min-[681px]:pb-[62px]"
          id="main-content"
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <PendingChangesProvider>
      <CommandRegistryProvider>
        <ShellCommands permission={props.permission} role={props.role} />
        <AppShellLayout {...props} />
      </CommandRegistryProvider>
    </PendingChangesProvider>
  );
}
