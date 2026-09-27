import { useDiagnostics } from './diagnostics-context';
import { Button, CopyButton, ErrorState, JsonViewer, StatusChip, Surface } from './ui';
import type { HealthSnapshot } from '../api/status';
import type { ApiClientError } from '../api/client';
import { useI18n, type TranslationKey, type TranslationValues } from '../i18n/i18n';

function titleCase(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

// stateLabel 优先使用共享 i18n；未知状态回退到人类可读的英文形态，避免丢失诊断信息。
function stateLabel(value: string, translate: (key: TranslationKey, values?: TranslationValues) => string): string {
  const key = ('diagnostics.states.' + value) as TranslationKey;
  const translated = translate(key);
  return translated === key ? titleCase(value) : translated;
}

function ErrorDetails({ error }: { error: ApiClientError }) {
  const { t } = useI18n();
  return (
    <div className="error-details">
      <div className="error-details__title">
        <code>{error.apiError.code}</code>
        <span>{error.apiError.message}</span>
      </div>
      {error.apiError.hint && <p className="error-hint">{error.apiError.hint}</p>}
      <div className="request-id-line">
        <span>{t('diagnostics.requestId')}</span>
        <code>{error.apiError.requestId}</code>
        <CopyButton label={t('diagnostics.copyRequestId')} value={error.apiError.requestId} />
      </div>
      <JsonViewer label={t('diagnostics.errorDetails')} value={error.apiError.details} />
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
  const { t } = useI18n();
  if (resource.state === 'loading') return <span className="skeleton skeleton--inline" aria-label={t('diagnostics.loading', { label })} />;
  if (resource.state !== 'ready' || !('value' in resource)) return <StatusChip state="unknown">{t('diagnostics.unknown')}</StatusChip>;
  return <StatusChip state={resource.value.state}>{stateLabel(resource.value.state, t)}</StatusChip>;
}

export function RuntimeBadge() {
  const { runtime } = useDiagnostics();
  const { t } = useI18n();

  if (runtime.state === 'loading' && !runtime.value) {
    return <StatusChip state="loading"><span className="pulse-dot" aria-hidden="true" /> {t('runtime.connecting')}</StatusChip>;
  }
  if (runtime.state === 'error') return <StatusChip state="unavailable">{t('runtime.unavailable')}</StatusChip>;
  if (!runtime.value) return <StatusChip state="unknown">{t('runtime.unknown')}</StatusChip>;

  const state = runtime.value.state;
  const label = state === 'ready' ? t('runtime.ready') : t('runtime.state', { state: stateLabel(state, t) });
  return <StatusChip state={state}>{state === 'ready' && <span className="pulse-dot" aria-hidden="true" />}{label}</StatusChip>;
}

export function DiagnosticsCards() {
  const { t } = useI18n();
  const { runtime, storage, refresh } = useDiagnostics();
  const runtimeError = runtime.state === 'error' && runtime.error instanceof Error ? runtime.error : null;
  const storageError = storage.state === 'error' && storage.error instanceof Error ? storage.error : null;

  return (
    <div className="diagnostics-grid" aria-live="polite">
      <Surface className="diagnostic-card" variant="raised">
        <div className="diagnostic-card__top">
          <div>
            <p className="eyebrow">{t('diagnostics.runtime.eyebrow')}</p>
            <h3>{t('diagnostics.runtime.title')}</h3>
          </div>
          {runtime.state === 'ready'
            ? <StatusChip state={runtime.value.state}>{stateLabel(runtime.value.state, t)}</StatusChip>
            : runtime.state === 'loading'
              ? <StatusChip state="loading">{t('diagnostics.checking')}</StatusChip>
              : <StatusChip state="unavailable">{t('diagnostics.unavailable')}</StatusChip>}
        </div>
        {runtimeError instanceof Error ? (
          <ErrorDetailsPanel error={runtimeError} onRetry={refresh} />
        ) : (
          <div className="diagnostic-rows">
            <div><span>{t('diagnostics.database')}</span><HealthValue label={t('diagnostics.database')} resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.database } : runtime} /></div>
            <div><span>{t('diagnostics.localStorage')}</span><HealthValue label={t('diagnostics.localStorage')} resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.localStorage } : runtime} /></div>
            {runtime.state === 'ready' && <p className="diagnostic-note">{t('diagnostics.observed', { date: new Date(runtime.value.observedAt).toLocaleTimeString() })}</p>}
          </div>
        )}
      </Surface>

      <Surface className="diagnostic-card" variant="raised">
        <div className="diagnostic-card__top">
          <div>
            <p className="eyebrow">{t('diagnostics.storage.eyebrow')}</p>
            <h3>{t('diagnostics.storage.title')}</h3>
          </div>
          {storage.state === 'ready'
            ? <StatusChip state={storage.value.localStorage.state}>{stateLabel(storage.value.localStorage.state, t)}</StatusChip>
            : storage.state === 'loading'
              ? <StatusChip state="loading">{t('diagnostics.checking')}</StatusChip>
              : <StatusChip state="unavailable">{t('diagnostics.unavailable')}</StatusChip>}
        </div>
        {storageError ? (
          <ErrorDetailsPanel error={storageError} onRetry={refresh} />
        ) : (
          <div className="diagnostic-rows">
            <div><span>{t('diagnostics.provider')}</span><strong>{storage.state === 'ready' ? storage.value.localStorage.provider : '—'}</strong></div>
            <div><span>{t('diagnostics.localStorage')}</span><HealthValue label={t('diagnostics.localStorage')} resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.localStorage } : storage} /></div>
            <div><span>{t('diagnostics.database')}</span><HealthValue label={t('diagnostics.database')} resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.database } : storage} /></div>
            {storage.state === 'ready' && storage.value.localStorage.path && (
              <div className="diagnostic-path">
                <span>{t('diagnostics.localPath')}</span>
                <code className="diagnostic-path__value">{storage.value.localStorage.path}</code>
                <CopyButton label={t('diagnostics.copyLocalPath')} value={storage.value.localStorage.path} />
              </div>
            )}
            {storage.state === 'ready' && storage.value.localStorage.message && <p className="diagnostic-note">{storage.value.localStorage.message}</p>}
          </div>
        )}
      </Surface>
    </div>
  );
}

function ErrorDetailsPanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <ErrorState
      className="resource-error"
      description={error instanceof Error && 'apiError' in error ? t('diagnostics.structuredDetails') : error.message || t('diagnostics.requestFailed')}
      title={t('diagnostics.statusRequestFailed')}
    >
      {error instanceof Error && 'apiError' in error && <ErrorDetails error={error as ApiClientError} />}
      <Button onClick={onRetry} size="small" variant="secondary">{t('diagnostics.retry')}</Button>
    </ErrorState>
  );
}