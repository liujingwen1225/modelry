import { TabContent } from './tab-content';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetCloseButton } from '@/components/ui/sheet';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button as ControlButton } from '@/components/ui/button';
import { LanguageSwitcher } from './language-switcher';
import {
  useEffect, useMemo, useState } from 'react';
import {
  Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronDown,
  Clock3,
  Command,
  FileStack,
  GitBranch,
  Home,
  LogOut,
  Moon,
  Menu,
  Network,
  ChevronLeft,
  ChevronRight,
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
  useOverview, OverviewProvider } from './overview-context';
import {
  CommandPaletteControl } from './command-palette';
import {
  CommandRegistryProvider, useCommandRegistry, useRegisterCommands, type AdminCommand, type CommandContext } from './command-registry';
import { allowsOperation, canSeeNavigationItem } from './permissions';
import { mapLegacyPath } from '../route-map';
import {
  PendingChangesProvider, usePendingChanges } from './pending-changes-context';
import {
  collectionIdFromPathname } from './route-context';
import {
  useTheme } from './theme-context';

// Spec 0001 §3.1 一级导航：按开发者实际管理的业务对象组织，只用视觉分组，
// 不形成额外页面层级。二级工作面由各页面自己的 Tab / 本地导航承担。
const groups: Array<{
  label: TranslationKey | null;
  items: Array<{ label: TranslationKey; to: string; icon: LucideIcon; operation?: string; count?: 'collections' | 'events' | 'schedules' }>;
}> = [
  {
    label: 'navigation.workspace',
    items: [{ label: 'navigation.overview', to: '/', icon: Home, operation: 'runtime.read' }],
  },
  {
    label: 'navigation.build',
    items: [
      { label: 'navigation.collections', to: '/collections', icon: FileStack, operation: 'collections.read', count: 'collections' },
      { label: 'navigation.apiWorkspace', to: '/api', icon: Network, operation: 'collections.read' },
      { label: 'navigation.hooksEvents', to: '/events', icon: Webhook, count: 'events' },
      { label: 'navigation.scheduledJobs', to: '/schedules', icon: Clock3, count: 'schedules' },
    ],
  },
  {
    label: 'navigation.operate',
    items: [
      { label: 'navigation.changes', to: '/changes', icon: GitBranch, operation: 'schema.read' },
      { label: 'navigation.accessAuth', to: '/access', icon: ShieldCheck, operation: 'serviceAccounts.read' },
      { label: 'navigation.activity', to: '/activity', icon: ScrollText, operation: 'activity.read' },
    ],
  },
  {
    label: 'navigation.system',
    items: [{ label: 'navigation.settings', to: '/settings', icon: Settings2, operation: 'runtime.read' }],
  },
];

// 顶栏面包屑：显示当前目的地名称（spec 0001 §3.4）。
function destinationKey(pathname: string): TranslationKey {
  if (pathname === '/') return 'navigation.overview';
  if (pathname.startsWith('/collections')) return 'navigation.collections';
  if (pathname.startsWith('/api')) return 'navigation.apiWorkspace';
  if (pathname.startsWith('/events')) return 'navigation.hooksEvents';
  if (pathname.startsWith('/schedules')) return 'navigation.scheduledJobs';
  if (pathname.startsWith('/changes')) return 'navigation.changes';
  if (pathname.startsWith('/access')) return 'navigation.accessAuth';
  if (pathname.startsWith('/activity')) return 'navigation.activity';
  if (pathname.startsWith('/settings')) return 'navigation.settings';
  if (pathname.startsWith('/mcp')) return 'mcp.title';
  return 'navigation.overview';
}

function isPrimaryLinkActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

// Spec 0001 §15：路径已经是 canonical、但 query 仍是历史写法时（例如 `/changes?view=pending`），
// 真实路由会直接命中而绕过 `*` 兜底，因此这里在 Shell 内再归一一次：
// 命中 route-map 就 replace 到 canonical URL（归一后返回 null，不会循环），否则原样渲染。
export function NormalizedOutlet() {
  const location = useLocation();
  const mapped = mapLegacyPath(location.pathname, location.search);
  if (mapped === null) return <Outlet />;
  return <Navigate replace to={{ pathname: mapped.pathname, search: mapped.search, hash: location.hash }} />;
}

function Sidebar({ role, permission, collapsed, onToggleCollapsed, mobile = false, onNavigate }: {
  role?: AppShellProps['role'];
  permission?: ControlPlanePermission;
  collapsed: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
  onToggleCollapsed: () => void;
}) {
  const { t, formatNumber, formatPlural } = useI18n();
  const { pathname } = useLocation();
  const { pendingOperations } = usePendingChanges();
  const pendingLabel = formatPlural(pendingOperations, {
    one: t('shell.pendingChangeOne'),
    other: t('shell.pendingChangeMany'),
  });
  const { overview } = useOverview();
  const { runtime } = useDiagnostics();

  const visibleGroups = useMemo(
    () => groups
      .map((group) => ({ ...group, items: group.items.filter((item) => canSeeNavigationItem(role, permission, item)) }))
      .filter((group) => group.items.length > 0),
    [role, permission],
  );

  // 计数只来自真实快照；section 缺失时不显示 0，也不显示猜测值。
  const counts = useMemo(() => {
    const snapshot = overview.value;
    const events = snapshot?.events;
    return {
      collections: snapshot?.collections ? snapshot.collections.count : undefined,
      events: events ? events.enabledHooks + events.enabledWebhooks + events.enabledEventHooks : undefined,
      schedules: events ? events.enabledJobs : undefined,
    } as Record<string, number | undefined>;
  }, [overview.value]);

  const runtimeState = runtime.state === 'ready' ? runtime.value.state : runtime.state === 'error' ? 'unavailable' : 'loading';
  const collapsedBlock = collapsed ? 'hidden' : 'block';
  const navLinkClassName = (isActive: boolean) => [
    'flex min-h-11 shrink-0 items-center gap-3 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground',
    collapsed ? 'justify-center px-0' : '',
    isActive ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground' : '',
  ].filter(Boolean).join(' ');

  const runtimeContext = <>
          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${runtimeState === 'ready' ? 'bg-muted-foreground' : runtimeState === 'loading' ? 'bg-info' : runtimeState === 'degraded' ? 'bg-warning' : 'bg-danger'}`} />
          <span className="min-w-0">
            <span className="block font-medium text-foreground">{t('navigation.localProject')}</span>
            <span className="block truncate font-mono text-xs">{window.location.host} · {t(`diagnostics.states.${runtimeState}` as TranslationKey)}</span>
          </span>
  </>;

  return (
    <aside
      aria-label={t('navigation.projectNavigation')}
      className={[
        'flex flex-col bg-sidebar text-sidebar-foreground',
        mobile ? 'min-h-0 flex-1 px-4 pb-4' : 'fixed inset-y-0 left-0 z-[5] hidden h-dvh border-r border-sidebar-border px-4 py-6 min-[769px]:flex',
        mobile ? 'w-full' : collapsed ? 'w-[72px] px-2.5' : 'w-[224px] lg:w-[248px]',
      ].filter(Boolean).join(' ')}
      data-shell-sidebar
    >
      {!mobile && <div className={`flex items-center gap-2 pb-6 ${collapsed ? 'flex-col' : 'px-2.5'}`}>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true"><Command size={17} strokeWidth={2.2} /></span>
        {!collapsed && <span className="text-lg font-semibold tracking-tight">modelry</span>}
        <ControlButton variant="ghost" size="icon"
          aria-label={t(collapsed ? 'shell.expandProjectNavigation' : 'shell.collapseProjectNavigation')}
          className={collapsed ? '' : 'ml-auto'}
          onClick={onToggleCollapsed}
          title={t(collapsed ? 'shell.expandProjectNavigation' : 'shell.collapseProjectNavigation')}
          type="button"
        >
          {collapsed ? <ChevronRight aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={18} />}
        </ControlButton>
      </div>}
      <nav
        aria-label={t('navigation.projectNavigation')}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto [scrollbar-width:thin]"
      >
        {visibleGroups.map((group, groupIndex) => (
          <div className="grid gap-1" key={group.label ?? 'overview'}>
            {group.label && <p className={['mx-2.5 mt-2 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground', collapsedBlock].join(' ')} data-nav-group-label>{t(group.label)}</p>}
            {group.items.map(({ label, to, icon: Icon, count }) => {
              const showsPendingCount = to === '/changes' && pendingOperations > 0;
              const countValue = count ? counts[count] : undefined;
              return (
                <NavLink
                  aria-label={showsPendingCount ? `${t(label)} · ${pendingLabel}` : t(label)}
                  aria-current={isPrimaryLinkActive(pathname, to) ? 'page' : undefined}
                  className={() => navLinkClassName(isPrimaryLinkActive(pathname, to))}
                  onClick={onNavigate}
                  end={to === '/'}
                  key={to}
                  title={t(label)}
                  to={to}
                >
                  <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                  <span className={collapsed ? 'sr-only' : ''}>{t(label)}</span>
                  {showsPendingCount ? (
                    <span
                      aria-hidden="true"
                      className={`${collapsed ? 'hidden' : 'inline-flex'} ml-auto h-5 min-w-5 items-center justify-center rounded-full bg-warning-soft px-1.5 text-xs font-semibold tabular-nums text-warning`}
                      data-nav-count="changes"
                    >{pendingOperations}</span>
                  ) : countValue !== undefined ? (
                    <span
                      aria-hidden="true"
                      className={`${collapsed ? 'hidden' : 'inline-flex'} ml-auto h-5 min-w-5 items-center justify-center px-1.5 text-xs tabular-nums text-muted-foreground`}
                      data-nav-count={count}
                    >{formatNumber(countValue)}</span>
                  ) : null}
                </NavLink>
              );
            })}
            {groupIndex < visibleGroups.length - 1 && <div className={['mx-2.25 mt-3 mb-1.25 h-px bg-border', collapsedBlock].join(' ')} />}
          </div>
        ))}
      </nav>
      {!collapsed && <div className="border-t border-sidebar-border pt-4 text-xs text-muted-foreground">
        {allowsOperation(role, permission, 'settings.read')
          ? <Link className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 hover:bg-sidebar-accent focus-visible:bg-sidebar-accent" data-shell-runtime-context onClick={onNavigate} to="/settings/runtime">{runtimeContext}</Link>
          : <div className="flex min-h-11 min-w-0 items-center gap-2 px-2" data-shell-runtime-context>{runtimeContext}</div>}
      </div>}
    </aside>
  );
}

function ThemeButton() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const nextLabel = theme === 'dark' ? t('shell.themeSwitchToLight') : t('shell.themeSwitchToDark');
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <ControlButton variant="ghost" size="icon"
      aria-label={nextLabel}
      className="size-11 shrink-0"
      data-theme-button
      onClick={toggleTheme}
      title={nextLabel}
      type="button"
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
    </ControlButton>
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
    // 窄屏只保留头像：完整邮箱仍在 aria-label 与展开后的菜单里，
    // 但不再把顶栏撑出视口（spec 0001 §16.1 不允许横向溢出）。
    <div className="relative flex min-w-0 items-center" data-owner-menu><Popover>
      <PopoverTrigger
        aria-label={ownerLabel}
        className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-md px-2 text-xs font-medium text-foreground hover:bg-accent focus-visible:bg-accent"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-cta-soft text-xs font-bold text-accent-cta-ink" aria-hidden="true">{ownerEmail?.slice(0, 1).toUpperCase() ?? 'O'}</span>
        <span className="hidden min-w-0 max-w-[190px] overflow-hidden text-ellipsis whitespace-nowrap min-[1280px]:inline">{ownerEmail ?? t('shell.owner')}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </PopoverTrigger><PopoverContent>
      <div className="w-[min(290px,calc(100vw-24px))]">
        <div className="grid gap-[3px] border-b border-border px-[3px] pt-0.5 pb-2.75">
          <strong className="text-xs text-foreground [overflow-wrap:anywhere]">{ownerEmail ?? t('shell.owner')}</strong>
          <span className="text-xs text-muted-foreground">{t(role === 'administrator' ? 'shell.roleAdministrator' : 'shell.roleOwner')}</span>
          <span className="text-xs text-muted-foreground">{t('shell.ownerSessionActive')}</span>
          {sessionExpiresAt && <span className="text-xs text-muted-foreground">{t('shell.expires', { date: formatDate(sessionExpiresAt) })}</span>}
        </div>
        <div className="flex items-center gap-[7px] pt-2 text-xs text-muted-foreground">
          {onLogout && (
            <ControlButton variant="outline"
              aria-disabled={signOutState === 'loading'}
              className="ml-auto"
              disabled={signOutState === 'loading'}
              onClick={() => void signOut()}
              type="button"
            >
              <LogOut aria-hidden="true" size={15} />
              {signOutState === 'loading' ? t('shell.signingOut') : t('shell.signOut')}
            </ControlButton>
          )}
        </div>
        {signOutState === 'error' && <p className="mt-2.25 mb-0 text-xs text-danger" role="alert">{t('shell.signOutFailed')}</p>}
      </div>
    </PopoverContent></Popover></div>
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
      go('navigate.overview', 'navigation.overview', '/'),
      go('navigate.collections', 'navigation.collections', '/collections', ['build']),
      go('navigate.api', 'navigation.apiWorkspace', '/api?tab=endpoints', ['endpoint', 'runner', 'openapi']),
      go('navigate.events', 'navigation.hooksEvents', '/events?tab=hooks', ['webhook', 'event hook', 'delivery', 'hooks']),
      go('navigate.schedules', 'navigation.scheduledJobs', '/schedules?tab=jobs', ['cron', 'job', 'schedule']),
      go('navigate.changes', 'navigation.changes', '/changes?tab=pending'),
      go('navigate.access', 'navigation.accessAuth', '/access?tab=administrators'),
      go('navigate.secrets', 'commands.secrets', '/settings/secrets', ['write-only', 'secret']),
      go('navigate.settings', 'navigation.settings', '/settings'),
      ...(allowsOperation(role, permission, 'activity.read') ? [go('navigate.activity', 'commands.activity', '/activity', ['timeline', 'operations', 'audit'])] : []),
      ...(allowsOperation(role, permission, 'drift.read') ? [go('navigate.drift', 'commands.drift', '/changes?tab=drift', ['consistency', 'projection', 'reconcile'])] : []),
      ...(allowsOperation(role, permission, 'settings.read') ? [go('navigate.runtimeSettings', 'commands.runtimeSettings', '/settings/runtime', ['runtime', 'configuration', 'restart'])] : []),
      ...(role === undefined || role === 'owner' ? [
        go('navigate.backupRestore', 'commands.backupRestore', '/settings/backups', ['backup', 'restore']),
        go('navigate.dataTransfer', 'commands.dataTransfer', '/settings/data', ['import', 'export', 'ndjson']),
        // 契约与 MCP 不占一级菜单，但属于 Owner 的开发者接入入口（developer.read 不在 readOnly preset 中）。
        go('navigate.apiContract', 'commands.apiContract', '/api?tab=openapi', ['sdk', 'openapi', 'contract']),
        go('navigate.mcp', 'commands.mcp', '/mcp', ['agent', 'model context protocol']),
      ] : []),
      ...(role === undefined || role === 'owner' ? [
        {
          id: 'navigate.administrators',
          category: 'commands.categories.system' as const,
          label: () => t('commands.administrators'),
          keywords: () => [t('administrators.searchKeywords')],
          execute: (context: CommandContext) => context.navigate('/access?tab=administrators'),
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => { setNavigationOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(min-width: 769px)');
    const closeOnDesktop = () => { if (query.matches) setNavigationOpen(false); };
    query.addEventListener('change', closeOnDesktop);
    return () => query.removeEventListener('change', closeOnDesktop);
  }, []);
  return (
    <div className="app-frame min-h-screen">
      <a
        className="fixed top-2 left-2 z-20 -translate-y-[150%] rounded-md bg-card px-3 py-2.25 text-xs font-bold text-accent-cta-ink shadow-soft focus:translate-y-0"
        href="#main-content"
      >{t('shell.skipToMainContent')}</a>
      <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
        <SheetContent className="w-[min(320px,100vw)]" aria-label={t('navigation.projectNavigation')}>
          <SheetHeader>
            <SheetTitle>{t('navigation.projectNavigation')}</SheetTitle>
            <SheetCloseButton aria-label={t('shell.collapseProjectNavigation')} />
          </SheetHeader>
          <Sidebar mobile collapsed={false} onToggleCollapsed={() => undefined} onNavigate={() => setNavigationOpen(false)} permission={permission} role={role} />
        </SheetContent>
      </Sheet>
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} permission={permission} role={role} />
      <div
        className={[
          'flex min-w-0 flex-col',
          'min-[769px]:min-h-screen',
          sidebarCollapsed
            ? 'min-[769px]:ml-[72px]'
            : 'min-[769px]:ml-[224px] lg:ml-[248px]',
        ].filter(Boolean).join(' ')}
        data-shell-workspace
      >
        <header
          className="sticky top-0 z-[4] flex min-h-16 items-center justify-between gap-2 border-b bg-background px-3 py-2 min-[769px]:px-6 lg:px-8"
          data-shell-topbar
        >
          <div className="flex min-w-0 items-center gap-2 min-[769px]:gap-3.25">
            <ControlButton variant="ghost" size="icon" className="size-11 min-[769px]:hidden" aria-label={t('shell.expandProjectNavigation')} aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}>
              <Menu aria-hidden="true" size={18} />
            </ControlButton>
            <span className="hidden text-xs font-medium text-muted-foreground min-[769px]:inline" data-shell-destination>{t(destinationKey(location.pathname))}</span>
          </div>
          <div
            className="flex min-w-0 items-center gap-1 lg:gap-2"
            data-shell-topbar-actions
          >
            <CommandPaletteControl />

            <RuntimeBadge canOpenSettings={allowsOperation(role, permission, 'settings.read')} />
            <LanguageSwitcher />
            <ThemeButton />

            <OwnerMenu onLogout={onLogout} ownerEmail={ownerEmail} role={role} sessionExpiresAt={sessionExpiresAt} />
          </div>
        </header>
        <main
          className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 py-6 min-[769px]:px-6 min-[769px]:py-8 lg:px-8"
          id="main-content"
          tabIndex={-1}
        >
          <TabContent activeKey={location.pathname}><NormalizedOutlet /></TabContent>
        </main>
      </div>
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <PendingChangesProvider>
      <OverviewProvider>
        <CommandRegistryProvider>
          <ShellCommands permission={props.permission} role={props.role} />
          <AppShellLayout {...props} />
        </CommandRegistryProvider>
      </OverviewProvider>
    </PendingChangesProvider>
  );
}
