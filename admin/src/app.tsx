import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { DiagnosticsProvider } from './components/diagnostics-context';
import { ThemeProvider } from './components/theme-context';
import { FoundationScopePage, OverviewPage, SettingsPage } from './pages/pages';

function NotFoundPage() {
  return (
    <div className="not-found" role="status">
      <p className="eyebrow">PAGE NOT FOUND</p>
      <h1>This route is not part of the workspace.</h1>
      <a className="text-link" href="/">Return to Overview</a>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <DiagnosticsProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route element={<OverviewPage />} path="/" />
              <Route element={<FoundationScopePage title="Collections" />} path="/collections" />
              <Route element={<FoundationScopePage title="API" />} path="/api" />
              <Route element={<FoundationScopePage title="Changes" />} path="/changes" />
              <Route element={<FoundationScopePage title="Access" />} path="/access" />
              <Route element={<SettingsPage />} path="/settings" />
              <Route element={<NotFoundPage />} path="*" />
            </Route>
          </Routes>
        </BrowserRouter>
      </DiagnosticsProvider>
    </ThemeProvider>
  );
}
