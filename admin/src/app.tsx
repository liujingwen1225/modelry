import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { DiagnosticsProvider } from './components/diagnostics-context';
import { ThemeProvider } from './components/theme-context';
import { LocaleProvider } from './i18n/i18n';
import { OwnerSessionProvider, useOwnerSession } from './auth/owner-session';
import { BootstrapPage, LoginPage, fetchBootstrapStatus, resolveOwnerReturnTo } from './auth';
import type { BootstrapStatus } from './auth/client';
import { Button, ErrorState, LoadingState, Surface } from './components/ui';
import { ChangesPage as GlobalChangesPage, CollectionRecordsPage, CollectionSchemaPage, CollectionSecurityPage, CollectionWorkspacePage, CollectionsPage, CreateCollectionPage } from './collections';
import { AccessPage, AuditPage } from './access';
import { CollectionAPIPage, GlobalAPIPage, RequestDetailPage } from './api';
import { OverviewPage, SettingsPage } from './pages/pages';

function NotFoundPage() {
  return (
    <div className="not-found" role="status">
      <p className="eyebrow">PAGE NOT FOUND</p>
      <h1>This route is not part of the workspace.</h1>
      <a className="text-link" href="/">Return to Overview</a>
    </div>
  );
}

function SessionRecovery({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : 'The Runtime could not verify the Owner session.';
  return (
    <main className="auth-screen">
      <Surface className="session-recovery" variant="raised">
        <p className="eyebrow">OWNER SESSION</p>
        <h1>Could not connect to this project</h1>
        <ErrorState description={message} title="Owner session could not be checked" />
        <p>Check that the Runtime is running, then retry. Your project data is unchanged.</p>
        <Button onClick={onRetry} type="button" variant="primary">Retry connection</Button>
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
      <Route element={<AppShell onLogout={logout} ownerEmail={session.owner.email} sessionExpiresAt={session.expiresAt} />}>
        <Route element={<OverviewPage />} path="/" />
        <Route element={<CollectionsPage />} path="/collections" />
        <Route element={<CreateCollectionPage />} path="/collections/new" />
        <Route element={<CollectionWorkspacePage />} path="/collections/:collectionId">
          <Route element={<CollectionRecordsPage />} index />
          <Route element={<CollectionSchemaPage />} path="schema" />
          <Route element={<CollectionSecurityPage />} path="security" />
          <Route element={<CollectionAPIPage />} path="api" />
        </Route>
        <Route element={<GlobalAPIPage />} path="/api" />
        <Route element={<RequestDetailPage />} path="/requests/:requestId" />
        <Route element={<GlobalChangesPage />} path="/changes" />
        <Route element={<AccessPage />} path="/access" />
        <Route element={<AuditPage />} path="/access/audit" />
        <Route element={<AuditPage />} path="/access/audit/:auditRecordId" />
        <Route element={<SettingsPage />} path="/settings" />
        <Route element={<AuthenticatedRedirect />} path="/login" />
        <Route element={<NotFoundPage />} path="*" />
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

  if (bootstrap.status === 'loading') return <AuthLoading label="Checking project setup" />;
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
  const { state, refresh } = useOwnerSession();
  if (state.status === 'loading') return <AuthLoading label="Checking Owner session" />;
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
