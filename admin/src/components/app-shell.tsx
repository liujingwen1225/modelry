import {
  useMemo, useState } from 'react';
import {
  Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronDown,
  Command,
  FileStack,
  GitBranch,
  Home,
  LogOut,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
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
  collectionIdFromPathname } from './route-context';
import {
  useTheme } from './theme-context';

const groups: Array<{
  label: TranslationKey | null;
  items: Array<{ label: TranslationKey; to: string; icon: LucideIcon; operation?: string }>;
}> = [
  { label: null, items: [{ label: 'navigation.overview', to: '/', icon: Home, operation: 'runtime.read' }] },
  {
    label: 'navigation.build',
    items: [
      { label: 'navigation.collections', to: '/collections', icon: FileStack, operation: 'collections.read' },
      { label: 'navigation.api', to: '/api', icon: Network, operation: 'collections.read' },
      { label: 'navigation.hooks', to: '/extensions', icon: Puzzle },
      { label: 'navigation.automation', to: '/automations', icon: Webhook },
    ],
  },
  {
    label: 'navigation.manage',
    items: [
      { label: 'navigation.changes', to: '/changes', icon: GitBranch, operation: 'schema.read' },
      { label: 'navigation.access', to: '/access', icon: ShieldCheck, operation: 'accessRules.read' },
    ],
  },
  { label: 'navigation.system', items: [{ label: 'navigation.settings', to: '/settings', icon: Settings2, operation: 'runtime.read' }] },
];

type AreaLink = { label: TranslationKey; to: string; operation?: string };
type AreaSection = { label?: TranslationKey; links: AreaLink[] };
type ProductAreaNavigation = {
  id: 'automation' | 'access' | 'settings';
  label: TranslationKey;
  sections: AreaSection[];
};

function productAreaNavigation(pathname: string): ProductAreaNavigation | null {
  if (pathname === '/automations') {
    return {
      id: 'automation',
      label: 'navigation.automation',
      sections: [{ links: [
        { label: 'automation.tabs.webhooks', to: '/automations?tab=webhooks' },
        { label: 'automation.tabs.eventHooks', to: '/automations?tab=eventHooks' },
        { label: 'automation.tabs.jobs', to: '/automations?tab=jobs' },
        { label: 'automation.tabs.deliveries', to: '/automations?tab=deliveries' },
      ] }],
    };
  }
  if (pathname.startsWith('/access') || pathname === '/administrators') {
    return {
      id: 'access',
      label: 'navigation.access',
      sections: [{ links: [
        { label: 'access.tabs.serviceAccounts', to: '/access', operation: 'serviceAccounts.read' },
        { label: 'navigation.administrators', to: '/administrators', operation: 'administrators.read' },
        { label: 'access.tabs.audit', to: '/access/audit', operation: 'audit.read' },
      ] }],
    };
  }
  if (pathname.startsWith('/settings') || pathname === '/activity') {
    return {
      id: 'settings',
      label: 'navigation.settings',
      sections: [
        { links: [
          { label: 'settings.navigation.general', to: '/settings', operation: 'runtime.read' },
          { label: 'settings.navigation.runtime', to: '/settings/runtime', operation: 'settings.read' },
          { label: 'settings.navigation.filesStorage', to: '/settings/storage', operation: 'storage.read' },
          { label: 'settings.navigation.mail', to: '/settings/mail', operation: 'mail.read' },
          { label: 'settings.navigation.backupRestore', to: '/settings/portability' },
        ] },
        { label: 'settings.navigation.diagnostics', links: [
          { label: 'navigation.activity', to: '/activity', operation: 'activity.read' },
          { label: 'navigation.drift', to: '/settings/drift', operation: 'drift.read' },
        ] },
      ],
    };
  }
  return null;
}

function isAreaLinkActive(link: AreaLink, pathname: string, search: string): boolean {
  const [targetPath, targetSearch = ''] = link.to.split('?');
  if (pathname !== targetPath) return false;
  const current = new URLSearchParams(search);
  const target = new URLSearchParams(targetSearch);
  for (const [key, value] of target) {
    if (current.get(key) !== value) return false;
  }
  if (targetPath === '/automations' && !target.has('tab')) {
    return !current.has('tab') || current.get('tab') === 'webhooks';
  }
  return true;
}

function isPrimaryLinkActive(pathname: string, to: string): boolean {
  if (to === '/automations') return pathname === '/automations';
  if (to === '/access') return pathname.startsWith('/access') || pathname === '/administrators';
  if (to === '/settings') return pathname.startsWith('/settings') || pathname === '/activity';
  return pathname === to || pathname.startsWith(`${to}/`);
}

function areaLinkTarget(link: AreaLink, search: string, hash: string): string {
  const [targetPath, targetSearch = ''] = link.to.split('?');
  if (targetPath !== '/automations') return link.to;
  const query = new URLSearchParams(search);
  const target = new URLSearchParams(targetSearch);
  for (const [key, item] of target) query.set(key, item);
  const serialized = query.toString();
  return `${targetPath}${serialized ? `?${serialized}` : ''}${hash}`;
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
  const { t } = useI18n();
  const { pathname } = useLocation();
  const visibleGroups = useMemo(
    () => groups
      .map((group) => ({ ...group, items: group.items.filter((item) => canSeeNavigationItem(role, permission, item)) }))
      .filter((group) => group.items.length > 0),
    [role, permission],
  );
  return (
    <aside className="sidebar" aria-label={t('navigation.projectNavigation')}>
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true"><Command size={17} strokeWidth={2.2} /></span>
        <span className="brand-word">modelry</span>
        <button
          aria-label={t(collapsed ? 'shell.expandProjectNavigation' : 'shell.collapseProjectNavigation')}
          className="sidebar__toggle"
          onClick={onToggleCollapsed}
          title={t(collapsed ? 'shell.expandProjectNavigation' : 'shell.collapseProjectNavigation')}
          type="button"
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" size={17} /> : <PanelLeftClose aria-hidden="true" size={17} />}
        </button>
      </div>
      <nav aria-label={t('navigation.projectNavigation')} className="side-navigation">
        {visibleGroups.map((group, groupIndex) => (
          <div className="nav-group" key={group.label ?? 'overview'}>
            {group.label && <p className="nav-group__label">{t(group.label)}</p>}
            {group.items.map(({ label, to, icon: Icon }) => (
              <NavLink
                aria-label={t(label)}
                aria-current={isPrimaryLinkActive(pathname, to) ? 'page' : undefined}
                className={() => `nav-link${isPrimaryLinkActive(pathname, to) ? ' nav-link--active' : ''}`}
                end={to === '/'}
                key={to}
                title={t(label)}
                to={to}
              >
                <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                <span>{t(label)}</span>
              </NavLink>
            ))}
            {groupIndex < visibleGroups.length - 1 && <div className="nav-separator" />}
          </div>
        ))}
      </nav>
      <div className="sidebar__bottom">
        <div className="project-presence"><span className="project-presence__dot" />{t('navigation.localProject')}</div>
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
    <button aria-label={nextLabel} className="theme-button" onClick={toggleTheme} title={nextLabel} type="button">
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
    </button>
  );
}

function ProductAreaNavigation({ area, role, permission, pathname, search, hash }: {
  area: ProductAreaNavigation;
  role?: AppShellProps['role'];
  permission?: ControlPlanePermission;
  pathname: string;
  search: string;
  hash: string;
}) {
  const { t } = useI18n();
  const sections = area.sections
    .map((section) => ({ ...section, links: section.links.filter((link) => canSeeNavigationItem(role, permission, link)) }))
    .filter((section) => section.links.length > 0);

  if (!sections.length) return null;
  return (
    <nav aria-label={t(area.label)} className={`area-navigation area-navigation--${area.id}`}>
      {sections.map((section, index) => <div className="area-navigation__section" key={section.label ?? `section-${index}`}>
        {section.label && <span className="area-navigation__label">{t(section.label)}</span>}
        {section.links.map((link) => {
          const active = isAreaLinkActive(link, pathname, search);
          return <Link
            aria-current={active ? 'page' : undefined}
            className={`area-navigation__link${active ? ' area-navigation__link--active' : ''}`}
            key={link.to}
            to={areaLinkTarget(link, search, hash)}
          >{t(link.label)}</Link>;
        })}
      </div>)}
    </nav>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="locale-switcher">
      <span className="sr-only">{t('shell.language')}</span>
      <select aria-label={t('shell.language')} onChange={(event) => setLocale(event.target.value as 'en' | 'zh-CN')} value={locale}>
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
    <details className="owner-menu">
      <summary aria-label={ownerLabel}>
        <span className="owner-menu__avatar" aria-hidden="true">{ownerEmail?.slice(0, 1).toUpperCase() ?? 'O'}</span>
        <span className="owner-menu__email">{ownerEmail ?? t('shell.owner')}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </summary>
      <div className="owner-menu__popover">
        <div className="owner-menu__identity">
          <strong>{ownerEmail ?? t('shell.owner')}</strong>
          <span>{t(role === 'administrator' ? 'shell.roleAdministrator' : 'shell.roleOwner')}</span>
          <span>{t('shell.ownerSessionActive')}</span>
          {sessionExpiresAt && <span>{t('shell.expires', { date: formatDate(sessionExpiresAt) })}</span>}
        </div>
        <div className="owner-menu__actions">
          {onLogout && (
            <button aria-disabled={signOutState === 'loading'} className="owner-menu__logout" disabled={signOutState === 'loading'} onClick={() => void signOut()} type="button">
              <LogOut aria-hidden="true" size={15} />
              {signOutState === 'loading' ? t('shell.signingOut') : t('shell.signOut')}
            </button>
          )}
        </div>
        {signOutState === 'error' && <p className="owner-menu__error" role="alert">{t('shell.signOutFailed')}</p>}
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
      go('navigate.api', 'commands.api', '/api'),
      go('navigate.changes', 'commands.changes', '/changes'),
      go('navigate.access', 'commands.access', '/access'),
      go('navigate.automations', 'commands.automations', '/automations', ['webhook', 'event hook', 'cron', 'delivery']),
      go('navigate.extensions', 'commands.extensions', '/extensions', ['hooks', 'lifecycle', 'runtime', 'extension', '扩展']),
      go('navigate.secrets', 'commands.secrets', '/secrets', ['write-only', 'secret']),
      go('navigate.settings', 'commands.settings', '/settings'),
      ...(allowsOperation(role, permission, 'activity.read') ? [go('navigate.activity', 'commands.activity', '/activity', ['timeline', 'operations'])] : []),
      ...(allowsOperation(role, permission, 'drift.read') ? [go('navigate.drift', 'commands.drift', '/settings/drift', ['consistency', 'projection', 'reconcile'])] : []),
      ...(allowsOperation(role, permission, 'settings.read') ? [go('navigate.runtimeSettings', 'commands.runtimeSettings', '/settings/runtime', ['runtime', 'configuration', 'restart'])] : []),
      ...(role === undefined || role === 'owner' ? [go('navigate.portability', 'commands.portability', '/settings/portability', ['backup', 'restore', 'import', 'export', 'sdk'])] : []),
      ...(role === undefined || role === 'owner' ? [
        {
          id: 'navigate.administrators',
          category: 'commands.categories.system' as const,
          label: () => t('commands.administrators'),
          keywords: () => [t('administrators.searchKeywords')],
          execute: (context: CommandContext) => context.navigate('/administrators'),
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
        { key: 'currentSchema', path: '/schema' },
        { key: 'currentSecurity', path: '/security' },
        { key: 'currentAPI', path: '/api' },
        { key: 'currentRealtime', path: '/api?tab=realtime' },
      ] as const).map(({ key, path }): AdminCommand => ({
        id: `collection.current.${key}`,
        category: 'commands.categories.collection',
        label: () => t(`commands.${key}`),
        keywords: () => ['records', 'schema', 'security', 'api', 'realtime', 'events', 'stream'],
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
    <div className={`app-frame${sidebarCollapsed ? ' app-frame--sidebar-collapsed' : ''}`} data-product-area={area?.id}>
      <a className="skip-link" href="#main-content">{t('shell.skipToMainContent')}</a>
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} permission={permission} role={role} />
      <div className="workspace">
        <header className="topbar">
          <div className="topbar__identity">
            <Command aria-hidden="true" className="mobile-brand-mark" size={18} />
            <span className="topbar__project">{t('shell.projectWorkspace')}</span>
            <span className="topbar__divider" aria-hidden="true">/</span>
            <span className="topbar__context">{t('shell.localContext')}</span>
          </div>
          <div className="topbar__actions">
            <CommandPaletteControl />
            <span className="topbar__action-divider" aria-hidden="true" />
            <RuntimeBadge />
            <LanguageSwitcher />
            <ThemeButton />
            <span className="topbar__action-divider" aria-hidden="true" />
            <OwnerMenu onLogout={onLogout} ownerEmail={ownerEmail} role={role} sessionExpiresAt={sessionExpiresAt} />
          </div>
        </header>
        {area && <ProductAreaNavigation area={area} hash={location.hash} pathname={location.pathname} permission={permission} role={role} search={location.search} />}
        <main className="page-area" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <CommandRegistryProvider>
      <ShellCommands permission={props.permission} role={props.role} />
      <AppShellLayout {...props} />
    </CommandRegistryProvider>
  );
}
