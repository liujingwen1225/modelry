import { Link } from 'react-router-dom';
import { useDiagnostics } from './diagnostics-context';
import { Button } from './button';
import { CopyButton } from './copy-button';
import { JsonViewer } from './json-viewer';
import { ErrorState, StatusChip } from './states';
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
  const { t, errorMessage } = useI18n();
  return (
    <div className="grid gap-2.25">
      <div className="flex flex-wrap items-baseline gap-[7px] text-sm text-ink-secondary">
        <code className="text-xs font-bold text-danger">{error.apiError.code}</code>
        <span>{errorMessage(error.apiError.code) ?? t('errors.requestFailed')}</span>
      </div>
      <p className="text-xs text-muted-foreground">{t('common.tryAgainWhenAvailable')}</p>
      <div className="flex items-center gap-[7px] text-xs text-muted-foreground">
        <span>{t('diagnostics.requestId')}</span>
        <code className="text-xs text-ink-secondary [overflow-wrap:anywhere]">{error.apiError.requestId}</code>
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
  if (resource.state === 'loading') return <span aria-label={t('diagnostics.loading', { label })} className="inline-block h-[23px] w-[65px] animate-pulse rounded-full bg-muted" />;
  if (resource.state !== 'ready' || !('value' in resource)) return <StatusChip state="unknown">{t('diagnostics.unknown')}</StatusChip>;
  return <StatusChip state={resource.value.state}>{stateLabel(resource.value.state, t)}</StatusChip>;
}

// 顶栏用安静的状态点与文字显示事实；只有具备设置读取权限时才提供诊断入口。
export function RuntimeBadge({ canOpenSettings = true }: { canOpenSettings?: boolean }) {
  const { runtime } = useDiagnostics();
  const { t } = useI18n();
  const state = runtime.state === 'error' ? 'unavailable' : runtime.value?.state ?? (runtime.state === 'loading' ? 'loading' : 'unknown');
  const text = state === 'ready' ? t('runtime.ready') : state === 'loading' ? t('runtime.connecting') : state === 'unavailable' ? t('runtime.unavailable') : state === 'unknown' ? t('runtime.unknown') : t('runtime.state', { state: stateLabel(state, t) });
  const content = <span className={`inline-flex items-center gap-2 ${state === 'ready' ? 'text-muted-foreground' : state === 'loading' || state === 'unknown' ? 'text-info' : state === 'degraded' ? 'text-warning' : 'text-danger'}`}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      <span className="max-[1023px]:sr-only">{text}</span>
    </span>;
  const className = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-xs";
  return canOpenSettings
    ? <Link to="/settings/runtime" className={className + " hover:bg-accent focus-visible:bg-accent"} data-runtime-badge aria-label={text} title={text}>{content}</Link>
    : <span className={className} data-runtime-badge aria-label={text} title={text}>{content}</span>;
}

export function DiagnosticsCards() {
  const { t } = useI18n();
  const { runtime, storage, refresh } = useDiagnostics();
  const runtimeError = runtime.state === 'error' && runtime.error instanceof Error ? runtime.error : null;
  const storageError = storage.state === 'error' && storage.error instanceof Error ? storage.error : null;

  return (
    <div className="grid gap-6 sm:grid-cols-2 sm:gap-0 sm:[&>section+section]:border-l sm:[&>section+section]:pl-6 sm:[&>section:first-child]:pr-6" aria-live="polite">
      <section className="min-w-0 border-t pt-4">
        <div className="flex items-start justify-between gap-3.75">
          <div>
            <p className="eyebrow mb-[3px]">{t('diagnostics.runtime.eyebrow')}</p>
            <h3 className="text-base font-semibold">{t('diagnostics.runtime.title')}</h3>
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
          <div className="mt-4.25 grid gap-2.25">
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{t('diagnostics.database')}</span><HealthValue label={t('diagnostics.database')} resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.database } : runtime} /></div>
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{t('diagnostics.localStorage')}</span><HealthValue label={t('diagnostics.localStorage')} resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.localStorage } : runtime} /></div>
            {runtime.state === 'ready' && <p className="mt-px mb-0 text-xs text-subtle-foreground">{t('diagnostics.observed', { date: new Date(runtime.value.observedAt).toLocaleTimeString() })}</p>}
          </div>
        )}
      </section>

      <section className="min-w-0 border-t pt-4">
        <div className="flex items-start justify-between gap-3.75">
          <div>
            <p className="eyebrow mb-[3px]">{t('diagnostics.storage.eyebrow')}</p>
            <h3 className="text-base font-semibold">{t('diagnostics.storage.title')}</h3>
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
          <div className="mt-4.25 grid gap-2.25">
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{t('diagnostics.provider')}</span><strong className="text-sm font-semibold text-ink-secondary">{storage.state === 'ready' ? storage.value.localStorage.provider : '—'}</strong></div>
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{t('diagnostics.localStorage')}</span><HealthValue label={t('diagnostics.localStorage')} resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.localStorage } : storage} /></div>
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{t('diagnostics.database')}</span><HealthValue label={t('diagnostics.database')} resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.database } : storage} /></div>
            {storage.state === 'ready' && storage.value.localStorage.path && (
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-sm text-muted-foreground">
                <span>{t('diagnostics.localPath')}</span>
                <code className="text-right break-all text-ink-secondary">{storage.value.localStorage.path}</code>
                <CopyButton label={t('diagnostics.copyLocalPath')} value={storage.value.localStorage.path} />
              </div>
            )}
            {storage.state === 'ready' && storage.value.localStorage.message && <p className="mt-px mb-0 text-xs text-subtle-foreground">{t('diagnostics.resourceReady')}</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function ErrorDetailsPanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <ErrorState
      className="mt-2.75 grid gap-2.25"
      description={error instanceof Error && 'apiError' in error ? t('diagnostics.structuredDetails') : t('diagnostics.requestFailed')}
      title={t('diagnostics.statusRequestFailed')}
    >
      {error instanceof Error && 'apiError' in error && <ErrorDetails error={error as ApiClientError} />}
      <Button onClick={onRetry} size="small" variant="secondary">{t('diagnostics.retry')}</Button>
    </ErrorState>
  );
}
