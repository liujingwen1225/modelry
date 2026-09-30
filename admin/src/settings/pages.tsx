import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { fetchRuntimeSettings, saveRuntimeSettings, type RuntimeSetting, type RuntimeSettings } from './client';

type LoadState = 'loading' | 'error' | 'ready';

function sourceKey(source: RuntimeSetting['source']): TranslationKey {
  return ('runtimeSettings.sources.' + source) as TranslationKey;
}

export function RuntimeSettingsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [listenAddress, setListenAddress] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string | null>(null);

  function apply(value: RuntimeSettings) {
    setSettings(value);
    setListenAddress(value.listenAddress.source === 'project' ? value.listenAddress.value : '');
    setRetentionDays(value.requestRetentionDays.value);
  }

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetchRuntimeSettings(controller.signal).then(
      (value) => { if (controller.signal.aborted) return; apply(value); setState('ready'); },
      (reason: unknown) => { if (controller.signal.aborted) return; setError(reason); setState('error'); },
    );
    return () => controller.abort();
  }, []);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    setNotice(null);
    try {
      const saved = await saveRuntimeSettings({
        expectedRevision: settings.revision,
        listenAddress,
        requestRetentionDays: Number(retentionDays),
      });
      apply(saved);
      setNotice(saved.listenAddress.restartRequired ? t('runtimeSettings.notices.savedRestartRequired') : t('runtimeSettings.notices.saved'));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'surface.runtimeSettings',
      category: 'commands.categories.system',
      label: () => t('commands.runtimeSettings'),
      keywords: () => [t('runtimeSettings.searchKeywords')],
      execute: () => navigate('/settings/runtime'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  const invalid = retentionDays.trim() === '' || Number(retentionDays) < 1 || Number(retentionDays) > 3650;

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('runtimeSettings.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('runtimeSettings.loadFailedDescription')} title={t('runtimeSettings.loadFailed')}>
          <Button onClick={() => window.location.reload()} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('runtimeSettings.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  if (!settings) return null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">{t('runtimeSettings.eyebrow')}</p>
        <h1>{t('runtimeSettings.title')}</h1>
        <p className="mt-2.5 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('runtimeSettings.description')}</p>
      </header>

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted text-ink-secondary"><Settings2 size={17} /></span>
          <div className="min-w-0">
            <p className="eyebrow">{t('runtimeSettings.current.eyebrow')}</p>
            <h2>{t('runtimeSettings.current.title')}</h2>
          </div>
        </div>
        <dl className="m-0 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('runtimeSettings.listenAddress.label')}</dt>
            <dd className="m-0 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
              <code className="break-words font-mono">{settings.listenAddress.value}</code>
              <StatusChip state="info">{t(sourceKey(settings.listenAddress.source))}</StatusChip>
              {settings.listenAddress.restartRequired && <StatusChip state="degraded">{t('runtimeSettings.restartRequired')}</StatusChip>}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('runtimeSettings.requestRetention.label')}</dt>
            <dd className="m-0 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
              <code className="break-words font-mono">{settings.requestRetentionDays.value}</code>
              <StatusChip state="info">{t(sourceKey(settings.requestRetentionDays.source))}</StatusChip>
              {settings.requestRetentionDays.restartRequired && <StatusChip state="degraded">{t('runtimeSettings.restartRequired')}</StatusChip>}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('runtimeSettings.current.revision')}</dt>
            <dd className="m-0 break-words text-xs text-ink-secondary">{settings.revision}</dd>
          </div>
        </dl>
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">{t('runtimeSettings.current.flagHint')}</p>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="min-w-0">
          <h2>{t('runtimeSettings.edit.title')}</h2>
          <p className="mt-1.5 max-w-[720px] text-[13px] leading-relaxed text-muted-foreground">{t('runtimeSettings.edit.description')}</p>
        </div>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FormField hint={t('runtimeSettings.listenAddress.hint')} htmlFor="runtime-listen-address" label={t('runtimeSettings.listenAddress.label')}>
            <input id="runtime-listen-address" onChange={(event) => setListenAddress(event.target.value)} placeholder={settings.listenAddress.value} value={listenAddress} />
          </FormField>
          <FormField hint={t('runtimeSettings.requestRetention.hint')} htmlFor="runtime-request-retention" label={t('runtimeSettings.requestRetention.label')}>
            <input id="runtime-request-retention" max="3650" min="1" onChange={(event) => setRetentionDays(event.target.value)} type="number" value={retentionDays} />
          </FormField>
          <div className="flex justify-end">
            <Button disabled={busy || invalid} type="submit" variant="primary">{busy ? t('runtimeSettings.saving') : t('runtimeSettings.save')}</Button>
          </div>
        </form>
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">{t('runtimeSettings.edit.restartHint')}</p>
      </Surface>

      {error !== undefined && (
        <ErrorState
          description={error instanceof ApiClientError && error.apiError.code === 'CONFLICT' ? t('runtimeSettings.errors.conflict') : t('runtimeSettings.errors.invalid')}
          title={t('runtimeSettings.saveFailed')}
        />
      )}
      {notice !== null && <p className="m-0 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-xs text-success" role="status">{notice}</p>}
    </div>
  );
}