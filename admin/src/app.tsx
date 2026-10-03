import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { DiagnosticsProvider } from './components/diagnostics-context';
import { ThemeProvider } from './components/theme-context';
import { LocaleProvider, useI18n } from './i18n/i18n';
import { OwnerSessionProvider, useOwnerSession } from './auth/owner-session';
import { BootstrapPage, LoginPage, fetchBootstrapStatus, resolveOwnerReturnTo } from './auth';
import type { BootstrapStatus } from './auth/client';
import { Button } from './components/button';
import { Surface } from './components/surface';
import { ErrorState, LoadingState } from './components/states';
import { CollectionRecordsPage, CollectionSchemaPage, CollectionSecurityPage, CollectionWorkspacePage, CollectionsPage, CreateCollectionPage } from './collections';
import { CollectionAPIPage } from './api';
import { ApiWorkspacePage } from './api/pages';
import { RequestDetailPage } from './api/requests';
import { EventsPage, HookDetailPage } from './events/pages';
import { SchedulesPage } from './schedules/pages';
import { ChangesWorkspacePage } from './changes/pages';
import { AccessWorkspacePage, AuditPage } from './access/pages';
import { ActivityWorkspacePage } from './activity/pages';
import { OverviewPage } from './overview/pages';
import { SettingsLayout } from './settings/layout';
import { RuntimeSettingsPage, SettingsGeneralPage } from './settings/pages';
import { FileStoragePage } from './storage/pages';
import { MailPage } from './mail/pages';
import { HookCreatePage, SecretsPage } from './extensions/pages';
import { DataTransferPage, BackupRestorePage } from './portability/pages';
import { MCPGuidePage } from './developer/pages';
import { mapLegacyPath } from './route-map';

function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto mt-[9vh] flex max-w-[620px] flex-col gap-2" role="status">
      <p className="eyebrow">{t('notFound.eyebrow')}</p>
      <h1>{t('notFound.title')}</h1>
      <a className="inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-primary hover:underline" href="/">{t('notFound.back')}</a>
    </div>
  );
}

// Spec 0001 §15：旧稳定深链接经纯函数 route-map 映射到新导航，
// 保留 query/hash 上下文；未命中映射的路径进入 404。
// 路径已是 canonical、只有 query 采用历史写法的情况（例如 `/changes?view=pending`）
// 由 AppShellLayout 内的 `NormalizedOutlet` 归一。
function LegacyRedirect() {
  const location = useLocation();
  const mapped = mapLegacyPath(location.pathname, location.search);
  if (mapped === null) return <NotFoundPage />;
  return <Navigate replace to={{ pathname: mapped.pathname, search: mapped.search, hash: location.hash }} />;
}

function SessionRecovery({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  const message = error instanceof Error ? error.message : t('recovery.unknownError');
  return (
    <main className="grid min-h-screen place-items-center bg-background px-[18px] py-[clamp(24px,6vh,56px)]">
      <Surface className="mx-auto flex w-full max-w-[460px] flex-col gap-3 p-6 shadow-soft" variant="raised">
        <p className="eyebrow">{t('recovery.eyebrow')}</p>
        <h1>{t('recovery.title')}</h1>
        <ErrorState description={message} title={t('recovery.errorTitle')} />
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('recovery.description')}</p>
        <div><Button onClick={onRetry} type="button" variant="primary">{t('recovery.retry')}</Button></div>
      </Surface>
    </main>
  );
}

function AuthLoading({ label }: { label: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-[18px] py-[clamp(24px,6vh,56px)]">
      <div className="mx-auto flex w-full max-w-[420px] flex-col items-center gap-5">
        <a className="inline-flex items-center gap-2 text-foreground" href="/">
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted font-mono text-sm font-bold text-ink-secondary">m</span>
          <span className="text-xl font-bold tracking-[-1.1px]">modelry</span>
        </a>
        <Surface className="w-full p-6 shadow-soft" variant="raised">
          <LoadingState label={label} />
        </Surface>
      </div>
    </main>
  );
}

// Spec 0001 §3.1：一级入口按业务对象组织——总览；集合 / API 工作区 / Hooks & Events /
// 定时任务；变更 / 访问与认证 / 活动记录；系统设置。二级工作面由各页面自己的 Tab 承担。
function AuthenticatedWorkspace() {
  const { state, logout } = useOwnerSession();
  if (state.status !== 'authenticated') return null;

  const session = state.session;
  return (
    <Routes>
      <Route element={<AppShell onLogout={logout} ownerEmail={session.owner.email} permission={session.permission} role={session.role} sessionExpiresAt={session.expiresAt} />}>
        <Route element={<OverviewPage />} path="/" />
        {/* BUILD — Collections（Collection 工作区：记录 | Model | 访问规则 | API） */}
        <Route element={<CollectionsPage />} path="/collections" />
        <Route element={<CreateCollectionPage />} path="/collections/new" />
        <Route element={<CollectionWorkspacePage />} path="/collections/:collectionId">
          <Route element={<CollectionRecordsPage />} index />
          <Route element={<CollectionSchemaPage />} path="model" />
          <Route element={<CollectionSecurityPage />} path="access" />
          <Route element={<CollectionAPIPage />} path="api" />
        </Route>
        {/* BUILD — API 工作区（端点 | OpenAPI | 请求日志） */}
        <Route element={<ApiWorkspacePage />} path="/api" />
        <Route element={<RequestDetailPage />} path="/api/requests/:requestId" />
        {/* BUILD — Hooks & Events（Hooks | Webhooks | 事件触发 | 投递历史） */}
        <Route element={<EventsPage />} path="/events" />
        <Route element={<HookCreatePage />} path="/events/hooks/new" />
        <Route element={<HookDetailPage />} path="/events/hooks/:extensionId" />
        {/* BUILD — 定时任务（任务 | 执行历史） */}
        <Route element={<SchedulesPage />} path="/schedules" />
        {/* OPERATE — 变更（待应用 | 已应用历史 | 结构漂移） */}
        <Route element={<ChangesWorkspacePage />} path="/changes" />
        {/* OPERATE — 访问与认证（管理员 | 应用认证 | API Tokens） */}
        <Route element={<AccessWorkspacePage />} path="/access" />
        {/* OPERATE — 活动记录（单一时间线，source 为筛选器） */}
        <Route element={<ActivityWorkspacePage />} path="/activity" />
        <Route element={<AuditPage />} path="/activity/audit/:auditRecordId" />
        {/* MCP 不占一级菜单，但从总览与 API 工作区可达 */}
        <Route element={<MCPGuidePage />} path="/mcp" />
        {/* SYSTEM — 系统设置（本地设置导航，分节用路径表达） */}
        <Route element={<SettingsLayout />} path="/settings">
          <Route element={<SettingsGeneralPage />} index />
          <Route element={<RuntimeSettingsPage />} path="runtime" />
          <Route element={<FileStoragePage />} path="storage" />
          <Route element={<MailPage />} path="mail" />
          <Route element={<SecretsPage />} path="secrets" />
          <Route element={<DataTransferPage />} path="data" />
          <Route element={<BackupRestorePage />} path="backups" />
        </Route>
        <Route element={<AuthenticatedRedirect />} path="/login" />
        <Route element={<LegacyRedirect />} path="*" />
      </Route>
    </Routes>
  );
}

function AuthenticatedRedirect() {
  const location = useLocation();
  const returnTo = resolveOwnerReturnTo(new URLSearchParams(location.search).get('returnTo') ?? undefined);
  return <Navigate replace to={returnTo ?? '/'} />;
}

function AnonymousWorkspace() {
  const { t } = useI18n();
  const { refresh, state } = useOwnerSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<{ status: 'loading' } | { status: 'ready'; value: BootstrapStatus } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBootstrap({ status: 'loading' });
    void fetchBootstrapStatus(controller.signal).then(
      (value) => setBootstrap({ status: 'ready', value }),
      (error: unknown) => {
        if (!controller.signal.aborted) setBootstrap({ status: 'error', error });
      },
    );
    return () => controller.abort();
  }, [generation]);

  async function enterWorkspace(defaultPath: string, returnTo?: string) {
    const session = await refresh();
    if (session) navigate(returnTo ?? defaultPath, { replace: true });
  }

  if (bootstrap.status === 'loading') return <AuthLoading label={t('recovery.checkingSetup')} />;
  if (bootstrap.status === 'error') {
    return <SessionRecovery error={bootstrap.error} onRetry={() => setGeneration((value) => value + 1)} />;
  }

  if (bootstrap.value.state === 'required') {
    return <BootstrapPage onAuthenticated={() => { void enterWorkspace('/collections/new'); }} />;
  }

  if (location.pathname !== '/login') {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate replace to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }

  return (
    <LoginPage
      onAuthenticated={(_result, returnTo) => { void enterWorkspace('/collections/new', returnTo); }}
      sessionExpired={state.status === 'anonymous' && state.sessionExpired}
    />
  );
}

function OwnerGate() {
  const { t } = useI18n();
  const { state, refresh } = useOwnerSession();
  if (state.status === 'loading') return <AuthLoading label={t('recovery.checkingSession')} />;
  if (state.status === 'error') return <SessionRecovery error={state.error} onRetry={() => { void refresh().catch(() => undefined); }} />;
  if (state.status === 'authenticated') return <AuthenticatedWorkspace />;
  return <AnonymousWorkspace />;
}

export function App() {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <OwnerSessionProvider>
          <DiagnosticsProvider>
            <BrowserRouter>
              <OwnerGate />
            </BrowserRouter>
          </DiagnosticsProvider>
        </OwnerSessionProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
