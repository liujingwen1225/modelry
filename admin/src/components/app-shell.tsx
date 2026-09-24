import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
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
import { RuntimeBadge } from './runtime-status';
import { useTheme } from './theme-context';

const groups = [
  {
    label: null,
    items: [{ label: 'Overview', to: '/', icon: Home }],
  },
  {
    label: 'Build',
    items: [
      { label: 'Collections', to: '/collections', icon: FileStack },
      { label: 'API', to: '/api', icon: Network },
    ],
  },
  {
    label: 'Operate',
    items: [
      { label: 'Changes', to: '/changes', icon: GitBranch },
      { label: 'Access', to: '/access', icon: ShieldCheck },
    ],
  },
  {
    label: 'System',
    items: [{ label: 'Settings', to: '/settings', icon: Settings2 }],
  },
];

function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Project navigation">
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true"><Command size={17} strokeWidth={2.2} /></span>
        <span className="brand-word">modelry</span>
        <span className="brand-edition">LOCAL</span>
      </div>
      <nav aria-label="Project navigation" className="side-navigation">
        {groups.map((group, groupIndex) => (
          <div className="nav-group" key={group.label ?? 'overview'}>
            {group.label && <p className="nav-group__label">{group.label}</p>}
            {group.items.map(({ label, to, icon: Icon }) => (
              <NavLink
                className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
                end={to === '/'}
                key={to}
                to={to}
              >
                <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                <span>{label}</span>
              </NavLink>
            ))}
            {groupIndex < groups.length - 1 && <div className="nav-separator" />}
          </div>
        ))}
      </nav>
      <div className="sidebar__bottom">
        <div className="project-presence"><span className="project-presence__dot" />Local project</div>
      </div>
    </aside>
  );
}

function ThemeButton() {
  const { theme, toggleTheme } = useTheme();
  const nextLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button aria-label={nextLabel} className="theme-button" onClick={toggleTheme} title={nextLabel} type="button">
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
    </button>
  );
}

export type AppShellProps = {
	ownerEmail?: string;
	sessionExpiresAt?: string;
	onLogout?: () => Promise<void>;
};

function OwnerMenu({ ownerEmail, sessionExpiresAt, onLogout }: AppShellProps) {
	const [signOutState, setSignOutState] = useState<'idle' | 'loading' | 'error'>('idle');
	const [signOutMessage, setSignOutMessage] = useState('');

	async function signOut() {
		if (!onLogout || signOutState === 'loading') return;
		setSignOutState('loading');
		setSignOutMessage('');
		try {
			await onLogout();
		} catch (error) {
			setSignOutMessage(error instanceof Error ? error.message : 'Sign out could not be completed. Retry after checking the Runtime.');
			setSignOutState('error');
			return;
		}
		setSignOutState('idle');
	}

	return (
		<details className="owner-menu">
			<summary aria-label={`Owner menu${ownerEmail ? ` for ${ownerEmail}` : ''}`}>
				<span className="owner-menu__avatar" aria-hidden="true">{ownerEmail?.slice(0, 1).toUpperCase() ?? 'O'}</span>
				<span className="owner-menu__email">{ownerEmail ?? 'Owner'}</span>
				<ChevronDown aria-hidden="true" size={14} />
			</summary>
			<div className="owner-menu__popover">
				<div className="owner-menu__identity">
					<strong>{ownerEmail ?? 'Owner'}</strong>
					<span>Owner session active</span>
					{sessionExpiresAt && <span>Expires {new Date(sessionExpiresAt).toLocaleString()}</span>}
				</div>
				<div className="owner-menu__actions">
					<ThemeButton />
					<span>Theme</span>
					{onLogout && (
						<button aria-disabled={signOutState === 'loading'} className="owner-menu__logout" disabled={signOutState === 'loading'} onClick={() => void signOut()} type="button">
							<LogOut aria-hidden="true" size={15} />
							{signOutState === 'loading' ? 'Signing out…' : 'Sign out'}
						</button>
					)}
				</div>
				{signOutMessage && <p className="owner-menu__error" role="alert">{signOutMessage}</p>}
			</div>
		</details>
	);
}

export function AppShell({ ownerEmail, sessionExpiresAt, onLogout }: AppShellProps) {
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Sidebar />
      <div className="workspace">
        <header className="topbar">
          <div className="topbar__identity">
            <Command aria-hidden="true" className="mobile-brand-mark" size={18} />
            <span className="topbar__project">Project workspace</span>
            <span className="topbar__divider" aria-hidden="true">/</span>
            <span className="topbar__context">Local</span>
          </div>
          <div className="topbar__actions">
            <RuntimeBadge />
            <span aria-hidden="true" className="topbar__action-divider" />
            <OwnerMenu onLogout={onLogout} ownerEmail={ownerEmail} sessionExpiresAt={sessionExpiresAt} />
          </div>
        </header>
        <main className="page-area" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="workspace-footer">
          <span>Modelry Community</span>
          <span className="footer-dot" aria-hidden="true">·</span>
          <span>V0.1</span>
        </footer>
      </div>
    </div>
  );
}
