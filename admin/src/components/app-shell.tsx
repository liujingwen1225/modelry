import { useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
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
  Settings2,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import type { TranslationKey } from '../i18n/i18n';
import { useI18n } from '../i18n/i18n';
import { RuntimeBadge } from './runtime-status';
import { useDiagnostics } from './diagnostics-context';
import { CommandPaletteControl } from './command-palette';
import { CommandRegistryProvider, useCommandRegistry, useRegisterCommands, type AdminCommand, type CommandContext } from './command-registry';
import { collectionIdFromPathname } from './route-context';
import { useTheme } from './theme-context';

const groups: Array<{
  label: TranslationKey | null;
  items: Array<{ label: TranslationKey; to: string; icon: LucideIcon }>;
}> = [
  { label: null, items: [{ label: 'navigation.overview', to: '/', icon: Home }] },
  {
    label: 'navigation.build',
    items: [
      { label: 'navigation.collections', to: '/collections', icon: FileStack },
      { label: 'navigation.api', to: '/api', icon: Network },
    ],
  },
  {
    label: 'navigation.operate',
    items: [
      { label: 'navigation.changes', to: '/changes', icon: GitBranch },
      { label: 'navigation.access', to: '/access', icon: ShieldCheck },
    ],
  },
  { label: 'navigation.system', items: [{ label: 'navigation.settings', to: '/settings', icon: Settings2 }] },
];

function Sidebar() {
  const { t } = useI18n();
  return (
    <aside className="sidebar" aria-label={t('navigation.projectNavigation')}>
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true"><Command size={17} strokeWidth={2.2} /></span>
        <span className="brand-word">modelry</span>
        <span className="brand-edition">{t('shell.localEdition')}</span>
      </div>
      <nav aria-label={t('navigation.projectNavigation')} className="side-navigation">
        {groups.map((group, groupIndex) => (
          <div className="nav-group" key={group.label ?? 'overview'}>
            {group.label && <p className="nav-group__label">{t(group.label)}</p>}
            {group.items.map(({ label, to, icon: Icon }) => (
              <NavLink
                className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
                end={to === '/'}
                key={to}
                to={to}
              >
                <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                <span>{t(label)}</span>
              </NavLink>
            ))}
            {groupIndex < groups.length - 1 && <div className="nav-separator" />}
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
  onLogout?: () => Promise<void>;
};

function OwnerMenu({ ownerEmail, sessionExpiresAt, onLogout }: AppShellProps) {
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

function ShellCommands() {
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
      go('navigate.settings', 'commands.settings', '/settings'),
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
      ] as const).map(({ key, path }): AdminCommand => ({
        id: `collection.current.${key}`,
        category: 'commands.categories.collection',
        label: () => t(`commands.${key}`),
        keywords: () => ['records', 'schema', 'security', 'api'],
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

    return result;
  }, [currentId, locale, recentCollections, runtime, setLocale, storage, t, theme, toggleTheme]);

  useRegisterCommands(commands);
  return null;
}

function AppShellLayout({ ownerEmail, sessionExpiresAt, onLogout }: AppShellProps) {
  const { t } = useI18n();
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">{t('shell.skipToMainContent')}</a>
      <Sidebar />
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
            <OwnerMenu onLogout={onLogout} ownerEmail={ownerEmail} sessionExpiresAt={sessionExpiresAt} />
          </div>
        </header>
        <main className="page-area" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="workspace-footer">
          <span>{t('shell.community')}</span>
          <span className="footer-dot" aria-hidden="true">·</span>
          <span>{t('shell.version')}</span>
        </footer>
      </div>
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <CommandRegistryProvider>
      <ShellCommands />
      <AppShellLayout {...props} />
    </CommandRegistryProvider>
  );
}
