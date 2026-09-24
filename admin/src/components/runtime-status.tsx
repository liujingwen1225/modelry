import { useDiagnostics } from './diagnostics-context';
import { Button, CopyButton, ErrorState, JsonViewer, StatusChip, Surface } from './ui';
import type { HealthSnapshot } from '../api/status';
import type { ApiClientError } from '../api/client';

function titleCase(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function ErrorDetails({ error }: { error: ApiClientError }) {
  return (
    <div className="error-details">
      <div className="error-details__title">
        <code>{error.apiError.code}</code>
        <span>{error.apiError.message}</span>
      </div>
      {error.apiError.hint && <p className="error-hint">{error.apiError.hint}</p>}
      <div className="request-id-line">
        <span>Request ID</span>
        <code>{error.apiError.requestId}</code>
        <CopyButton label="Copy request ID" value={error.apiError.requestId} />
      </div>
      <JsonViewer label="Error details" value={error.apiError.details} />
    </div>
  );
}

function HealthValue({
  resource,
  label,
}: {
  resource: { state: 'ready'; value: HealthSnapshot } | { state: string };
  label: string;
}) {
  if (resource.state === 'loading') return <span className="skeleton skeleton--inline" aria-label={`Loading ${label} status`} />;
  if (resource.state !== 'ready' || !('value' in resource)) return <StatusChip state="unknown">Unknown</StatusChip>;
  return <StatusChip state={resource.value.state}>{titleCase(resource.value.state)}</StatusChip>;
}

export function RuntimeBadge() {
  const { runtime } = useDiagnostics();

  if (runtime.state === 'loading' && !runtime.value) {
    return <StatusChip state="loading"><span className="pulse-dot" aria-hidden="true" /> Connecting</StatusChip>;
  }
  if (runtime.state === 'error') return <StatusChip state="unavailable">Runtime unavailable</StatusChip>;
  if (!runtime.value) return <StatusChip state="unknown">Runtime unknown</StatusChip>;

  const state = runtime.value.state;
  const label = state === 'ready' ? 'Runtime ready' : `Runtime ${titleCase(state)}`;
  return <StatusChip state={state}>{state === 'ready' && <span className="pulse-dot" aria-hidden="true" />}{label}</StatusChip>;
}

export function DiagnosticsCards() {
  const { runtime, storage, refresh } = useDiagnostics();
  const runtimeError = runtime.state === 'error' && runtime.error instanceof Error ? runtime.error : null;
  const storageError = storage.state === 'error' && storage.error instanceof Error ? storage.error : null;

  return (
    <div className="diagnostics-grid" aria-live="polite">
      <Surface className="diagnostic-card" variant="raised">
        <div className="diagnostic-card__top">
          <div>
            <p className="eyebrow">Runtime</p>
            <h3>Application process</h3>
          </div>
          {runtime.state === 'ready'
            ? <StatusChip state={runtime.value.state}>{titleCase(runtime.value.state)}</StatusChip>
            : runtime.state === 'loading'
              ? <StatusChip state="loading">Checking</StatusChip>
              : <StatusChip state="unavailable">Unavailable</StatusChip>}
        </div>
        {runtimeError instanceof Error ? (
          <ErrorDetailsPanel error={runtimeError} onRetry={refresh} />
        ) : (
          <div className="diagnostic-rows">
            <div><span>Database</span><HealthValue label="database" resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.database } : runtime} /></div>
            <div><span>Local storage</span><HealthValue label="local storage" resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.localStorage } : runtime} /></div>
            {runtime.state === 'ready' && <p className="diagnostic-note">Observed {new Date(runtime.value.observedAt).toLocaleTimeString()}</p>}
          </div>
        )}
      </Surface>

      <Surface className="diagnostic-card" variant="raised">
        <div className="diagnostic-card__top">
          <div>
            <p className="eyebrow">Storage</p>
            <h3>Local project data</h3>
          </div>
          {storage.state === 'ready'
            ? <StatusChip state={storage.value.localStorage.state}>{titleCase(storage.value.localStorage.state)}</StatusChip>
            : storage.state === 'loading'
              ? <StatusChip state="loading">Checking</StatusChip>
              : <StatusChip state="unavailable">Unavailable</StatusChip>}
        </div>
        {storageError ? (
          <ErrorDetailsPanel error={storageError} onRetry={refresh} />
        ) : (
          <div className="diagnostic-rows">
            <div><span>Provider</span><strong>{storage.state === 'ready' ? storage.value.localStorage.provider : '—'}</strong></div>
            <div><span>Local storage</span><HealthValue label="local storage" resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.localStorage } : storage} /></div>
            <div><span>Database</span><HealthValue label="database" resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.database } : storage} /></div>
            {storage.state === 'ready' && storage.value.localStorage.message && <p className="diagnostic-note">{storage.value.localStorage.message}</p>}
          </div>
        )}
      </Surface>
    </div>
  );
}

function ErrorDetailsPanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <ErrorState
      className="resource-error"
      description={error instanceof Error && 'apiError' in error ? 'Review the structured response details.' : error.message || 'The status request failed.'}
      title="Status request failed"
    >
      {error instanceof Error && 'apiError' in error && <ErrorDetails error={error as ApiClientError} />}
      <Button onClick={onRetry} size="small" variant="secondary">Retry</Button>
    </ErrorState>
  );
}
