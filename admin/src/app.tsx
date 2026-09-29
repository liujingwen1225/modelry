import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { DiagnosticsProvider } from './components/diagnostics-context';
import { ThemeProvider } from './components/theme-context';
import { LocaleProvider, useI18n } from './i18n/i18n';
import { OwnerSessionProvider, useOwnerSession } from './auth/owner-session';
import { BootstrapPage, LoginPage, fetchBootstrapStatus, resolveOwnerReturnTo } from './auth';
import type { BootstrapStatus } from './auth/client';
import { Button, ErrorState, LoadingState, Surface } from './components/ui';
import { ChangesPage as GlobalChangesPage, CollectionRecordsPage, CollectionSchemaPage, CollectionSecurityPage, CollectionWorkspacePage, CollectionsPage, CreateCollectionPage } from './collections';
import { AccessPage, AuditPage } from './access';
import { CollectionAPIPage, GlobalAPIPage, RequestDetailPage } from './api';
import { OverviewPage, SettingsPage } from './pages/pages';
import { ExtensionsPage, SecretsPage } from './extensions/pages';
import { AutomationPage } from './automation/pages';
import { FileStoragePage } from './storage/pages';
import { AdministratorsPage } from './administrators/pages';
import { MailPage } from './mail/pages';
import { ActivityPage } from './activity/pages';
import { DriftPage } from './drift/pages';
import { RuntimeSettingsPage } from './settings/pages';
import { APIContractPage, BackupRestorePage, DataTransferPage } from './portability/pages';
import { MCPGuidePage } from './developer/pages';
import { mapLegacyPath } from './route-map';

function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="not-found" role="status">
      <p className="eyebrow">{t('notFound.eyebrow')}</p>
      <h1>{t('notFound.title')}</h1>
      <a className="text-link" href="/">{t('notFound.back')}</a>
    </div>
  );
}

// Spec 0001 §15：旧稳定深链接经纯函数 route-map 映射到新导航，
// 保留 query/hash 上下文；未命中映射的路径进入 404。
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
    <main className="auth-screen">
      <Surface className="session-recovery" variant="raised">
        <p className="eyebrow">{t('recovery.eyebrow')}</p>
        <h1>{t('recovery.title')}</h1>
        <ErrorState description={message} title={t('recovery.errorTitle')} />
        <p>{t('recovery.description')}</p>
        <Button onClick={onRetry} type="button" variant="primary">{t('recovery.retry')}</Button>
      </Surface>
    </main>
  );
}

function AuthLoading({ label }: { label: string }) {
  return (
    <main className="auth-screen">
      <div className="auth-layout">
        <a className="auth-brand" href="/">
          <span aria-hidden="true" className="auth-brand__mark">m</span>
          <span className="auth-brand__word">modelry</span>
        </a>
        <Surface className="auth-card session-recovery" variant="raised">
          <LoadingState label={label} />
        </Surface>
      </div>
    </main>
  );
}

function AuthenticatedWorkspace() {
  const { state, logout } = useOwnerSession();
  if (state.status !== 'authenticated') return null;

  const session = state.session;
  return (
    <Routes>
      <Route element={<AppShell onLogout={logout} ownerEmail={session.owner.email} permission={session.permission} role={session.role} sessionExpiresAt={session.expiresAt} />}>
        <Route element={<OverviewPage />} path="/" />
        {/* BUILD — Collections（Collection 工作区：Records | Model | Access | API，spec §3.1） */}
        <Route element={<CollectionsPage />} path="/collections" />
        <Route element={<CreateCollectionPage />} path="/collections/new" />
        <Route element={<CollectionWorkspacePage />} path="/collections/:collectionId">
          <Route element={<CollectionRecordsPage />} index />
          <Route element={<CollectionSchemaPage />} path="model" />
          <Route element={<CollectionSecurityPage />} path="access" />
          <Route element={<CollectionAPIPage />} path="api" />
        </Route>
        {/* CONNECT — API & SDK（子导航：API | SDK & Contract | MCP） */}
        <Route element={<Navigate replace to="/connect/api" />} path="/connect" />
        <Route element={<GlobalAPIPage />} path="/connect/api" />
        <Route element={<APIContractPage />} path="/connect/sdk" />
        <Route element={<MCPGuidePage />} path="/connect/mcp" />
        {/* AUTOMATE — Automations（子导航：Hooks | Webhooks | Triggers | Schedules | Delivery history）。
            裸 /automations 与 /automations?tab=* 都交给 catch-all LegacyRedirect / route-map 处理，
            避免 /automations 的显式 redirect 抢先吞掉 ?tab= 变体。 */}
        <Route element={<ExtensionsPage />} path="/automations/hooks" />
        <Route element={<ExtensionsPage />} path="/automations/hooks/:extensionId" />
        <Route element={<AutomationPage />} path="/automations/webhooks" />
        <Route element={<AutomationPage />} path="/automations/triggers" />
        <Route element={<AutomationPage />} path="/automations/schedules" />
        <Route element={<AutomationPage />} path="/automations/deliveries" />
        {/* OBSERVE */}
        <Route element={<RequestDetailPage />} path="/requests/:requestId" />
        <Route element={<ActivityPage />} path="/activity" />
        <Route element={<AuditPage />} path="/activity/audit" />
        <Route element={<AuditPage />} path="/activity/audit/:auditRecordId" />
        {/* EVOLVE */}
        <Route element={<GlobalChangesPage />} path="/changes" />
        <Route element={<DriftPage />} path="/health" />
        {/* PROJECT */}
        <Route element={<AccessPage />} path="/access" />
        <Route element={<AdministratorsPage />} path="/access/administrators" />
        <Route element={<SettingsPage />} path="/settings" />
        <Route element={<RuntimeSettingsPage />} path="/settings/runtime" />
        <Route element={<FileStoragePage />} path="/settings/storage" />
        <Route element={<MailPage />} path="/settings/mail" />
        <Route element={<SecretsPage />} path="/settings/secrets" />
        <Route element={<DataTransferPage />} path="/settings/data" />
        <Route element={<BackupRestorePage />} path="/settings/backups" />
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
