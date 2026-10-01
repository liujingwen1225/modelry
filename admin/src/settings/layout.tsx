import { useMemo } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useOwnerSession } from '../auth/owner-session';
import { canSeeNavigationItem } from '../components/permissions';
import { useI18n, type TranslationKey } from '../i18n/i18n';

// Spec 0001 §11.2 / §3.2：系统设置仍是一个一级页面，用本地设置导航把
// 常规 / 运行时 / 文件存储 / 邮件 / Secrets / 数据导入导出 / 备份与恢复 分开。
// 分节继续用路径表达，保证深链接、刷新与返回行为稳定；分节可见性沿用
// Control Plane 的 fail closed 语义（无 operation 的分节只对 Owner 可见）。

const sections: Array<{ to: string; label: TranslationKey; operation?: string }> = [
  { to: '/settings', label: 'settings.navigation.general', operation: 'runtime.read' },
  { to: '/settings/runtime', label: 'settings.navigation.runtime', operation: 'settings.read' },
  { to: '/settings/storage', label: 'settings.navigation.filesStorage', operation: 'storage.read' },
  { to: '/settings/mail', label: 'settings.navigation.mail', operation: 'mail.read' },
  { to: '/settings/secrets', label: 'settings.navigation.secrets' },
  { to: '/settings/data', label: 'settings.navigation.dataTransfer' },
  { to: '/settings/backups', label: 'settings.navigation.backupRestore' },
];

export function SettingsLayout() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { state } = useOwnerSession();
  const role = state.status === 'authenticated' ? state.session.role : undefined;
  const permission = state.status === 'authenticated' ? state.session.permission : undefined;

  const visibleSections = useMemo(
    () => sections.filter((section) => canSeeNavigationItem(role, permission, section)),
    [permission, role],
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="min-w-0">
        <p className="eyebrow">{t('settings.eyebrow')}</p>
        <h1>{t('settings.title')}</h1>
        <p className="mt-2 max-w-[700px] text-[13px] leading-relaxed text-muted-foreground">{t('settings.description')}</p>
      </header>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label={t('settings.navigationLabel')} className="flex min-w-0 flex-col gap-0.5 overflow-x-auto lg:overflow-visible" data-settings-navigation>
          {visibleSections.map((section) => (
            <NavLink
              aria-current={pathname === section.to ? 'page' : undefined}
              className={({ isActive }) => [
                'min-h-9 shrink-0 rounded-md px-2.5 py-2 text-xs font-medium no-underline transition-colors',
                isActive ? 'bg-accent-cta-soft font-semibold text-accent-cta-ink' : 'text-ink-secondary hover:bg-accent hover:text-foreground',
              ].join(' ')}
              end
              key={section.to}
              to={section.to}
            >
              {t(section.label)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
