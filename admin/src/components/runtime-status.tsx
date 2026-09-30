import type { ReactNode } from 'react';
import { useDiagnostics } from './diagnostics-context';
import { Button } from './button';
import { CopyButton } from './copy-button';
import { JsonViewer } from './json-viewer';
import { ErrorState, StatusChip } from './states';
import { Surface } from './surface';
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
      <div className="flex flex-wrap items-baseline gap-[7px] text-[11px] text-ink-secondary">
        <code className="text-[10px] font-bold text-danger">{error.apiError.code}</code>
        <span>{errorMessage(error.apiError.code) ?? t('errors.requestFailed')}</span>
      </div>
      <p className="text-[10px] text-muted-foreground">{t('common.tryAgainWhenAvailable')}</p>
      <div className="flex items-center gap-[7px] text-[10px] text-muted-foreground">
        <span>{t('diagnostics.requestId')}</span>
        <code className="text-[10px] text-ink-secondary [overflow-wrap:anywhere]">{error.apiError.requestId}</code>
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

// RuntimeBadge 的每个分支都包在同一个 data-runtime-badge 容器里；
// 状态胶囊本身由共享 StatusChip 渲染（它自带 data-status-chip）。
export function RuntimeBadge() {
  const { runtime } = useDiagnostics();
  const { t } = useI18n();
  const badge = (chip: ReactNode) => <span className="inline-flex items-center" data-runtime-badge>{chip}</span>;

  if (runtime.state === 'loading' && !runtime.value) {
    return badge(<StatusChip state="loading"><span className="inline-block size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" /> {t('runtime.connecting')}</StatusChip>);
  }
  if (runtime.state === 'error') return badge(<StatusChip state="unavailable">{t('runtime.unavailable')}</StatusChip>);
  if (!runtime.value) return badge(<StatusChip state="unknown">{t('runtime.unknown')}</StatusChip>);

  const state = runtime.value.state;
  const label = state === 'ready' ? t('runtime.ready') : t('runtime.state', { state: stateLabel(state, t) });
  return badge(<StatusChip state={state}>{state === 'ready' && <span className="inline-block size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}{label}</StatusChip>);
}

export function DiagnosticsCards() {
  const { t } = useI18n();
  const { runtime, storage, refresh } = useDiagnostics();
  const runtimeError = runtime.state === 'error' && runtime.error instanceof Error ? runtime.error : null;
  const storageError = storage.state === 'error' && storage.error instanceof Error ? storage.error : null;

  return (
    <div className="grid gap-3.5 sm:grid-cols-2" aria-live="polite">
      <Surface className="min-h-[154px] p-4 md:min-h-[169px]" variant="raised">
        <div className="flex items-start justify-between gap-3.75">
          <div>
            <p className="eyebrow mb-[3px]">{t('diagnostics.runtime.eyebrow')}</p>
            <h3 className="text-[13px] font-semibold tracking-[-0.1px]">{t('diagnostics.runtime.title')}</h3>
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
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"><span>{t('diagnostics.database')}</span><HealthValue label={t('diagnostics.database')} resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.database } : runtime} /></div>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"><span>{t('diagnostics.localStorage')}</span><HealthValue label={t('diagnostics.localStorage')} resource={runtime.state === 'ready' ? { state: 'ready', value: runtime.value.localStorage } : runtime} /></div>
            {runtime.state === 'ready' && <p className="mt-px mb-0 text-[10px] text-subtle-foreground">{t('diagnostics.observed', { date: new Date(runtime.value.observedAt).toLocaleTimeString() })}</p>}
          </div>
        )}
      </Surface>

      <Surface className="min-h-[154px] p-4 md:min-h-[169px]" variant="raised">
        <div className="flex items-start justify-between gap-3.75">
          <div>
            <p className="eyebrow mb-[3px]">{t('diagnostics.storage.eyebrow')}</p>
            <h3 className="text-[13px] font-semibold tracking-[-0.1px]">{t('diagnostics.storage.title')}</h3>
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
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"><span>{t('diagnostics.provider')}</span><strong className="text-[11px] font-semibold text-ink-secondary">{storage.state === 'ready' ? storage.value.localStorage.provider : '—'}</strong></div>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"><span>{t('diagnostics.localStorage')}</span><HealthValue label={t('diagnostics.localStorage')} resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.localStorage } : storage} /></div>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"><span>{t('diagnostics.database')}</span><HealthValue label={t('diagnostics.database')} resource={storage.state === 'ready' ? { state: 'ready', value: storage.value.database } : storage} /></div>
            {storage.state === 'ready' && storage.value.localStorage.path && (
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-[11px] text-muted-foreground">
                <span>{t('diagnostics.localPath')}</span>
                <code className="text-right break-all text-ink-secondary">{storage.value.localStorage.path}</code>
                <CopyButton label={t('diagnostics.copyLocalPath')} value={storage.value.localStorage.path} />
              </div>
            )}
            {storage.state === 'ready' && storage.value.localStorage.message && <p className="mt-px mb-0 text-[10px] text-subtle-foreground">{t('diagnostics.resourceReady')}</p>}
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
      className="mt-2.75 grid gap-2.25"
      description={error instanceof Error && 'apiError' in error ? t('diagnostics.structuredDetails') : t('diagnostics.requestFailed')}
      title={t('diagnostics.statusRequestFailed')}
    >
      {error instanceof Error && 'apiError' in error && <ErrorDetails error={error as ApiClientError} />}
      <Button onClick={onRetry} size="small" variant="secondary">{t('diagnostics.retry')}</Button>
    </ErrorState>
  );
}
