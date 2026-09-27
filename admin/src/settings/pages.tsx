import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Settings2 } from 'lucide-react';
import { Button, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { fetchRuntimeSettings, saveRuntimeSettings, type RuntimeSetting, type RuntimeSettings } from './client';
import './settings.css';

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

  if (state === 'loading') return <div className="page-stack"><LoadingState label={t('runtimeSettings.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="page-stack">
        <ErrorState description={t('runtimeSettings.loadFailedDescription')} title={t('runtimeSettings.loadFailed')}>
          <Button onClick={() => window.location.reload()} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('runtimeSettings.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  if (!settings) return null;

  return (
    <div className="page-stack runtime-settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('runtimeSettings.eyebrow')}</p>
          <h1>{t('runtimeSettings.title')}</h1>
          <p className="page-description">{t('runtimeSettings.description')}</p>
        </div>
      </header>

      <Surface className="runtime-settings" variant="standard">
        <div className="runtime-settings__heading">
          <span className="scope-icon"><Settings2 aria-hidden="true" size={17} /></span>
          <div>
            <p className="eyebrow">{t('runtimeSettings.current.eyebrow')}</p>
            <h2>{t('runtimeSettings.current.title')}</h2>
          </div>
        </div>
        <dl className="runtime-settings__facts">
          <div>
            <dt>{t('runtimeSettings.listenAddress.label')}</dt>
            <dd>
              <code>{settings.listenAddress.value}</code>
              <StatusChip state="info">{t(sourceKey(settings.listenAddress.source))}</StatusChip>
              {settings.listenAddress.restartRequired && <StatusChip state="degraded">{t('runtimeSettings.restartRequired')}</StatusChip>}
            </dd>
          </div>
          <div>
            <dt>{t('runtimeSettings.requestRetention.label')}</dt>
            <dd>
              <code>{settings.requestRetentionDays.value}</code>
              <StatusChip state="info">{t(sourceKey(settings.requestRetentionDays.source))}</StatusChip>
              {settings.requestRetentionDays.restartRequired && <StatusChip state="degraded">{t('runtimeSettings.restartRequired')}</StatusChip>}
            </dd>
          </div>
          <div><dt>{t('runtimeSettings.current.revision')}</dt><dd>{settings.revision}</dd></div>
        </dl>
        <p className="runtime-settings__hint">{t('runtimeSettings.current.flagHint')}</p>
      </Surface>

      <Surface className="runtime-settings" variant="standard">
        <h2>{t('runtimeSettings.edit.title')}</h2>
        <p className="section-description">{t('runtimeSettings.edit.description')}</p>
        <form className="runtime-settings__form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FormField hint={t('runtimeSettings.listenAddress.hint')} htmlFor="runtime-listen-address" label={t('runtimeSettings.listenAddress.label')}>
            <input id="runtime-listen-address" onChange={(event) => setListenAddress(event.target.value)} placeholder={settings.listenAddress.value} value={listenAddress} />
          </FormField>
          <FormField hint={t('runtimeSettings.requestRetention.hint')} htmlFor="runtime-request-retention" label={t('runtimeSettings.requestRetention.label')}>
            <input id="runtime-request-retention" max="3650" min="1" onChange={(event) => setRetentionDays(event.target.value)} type="number" value={retentionDays} />
          </FormField>
          <div className="runtime-settings__actions">
            <Button disabled={busy || invalid} type="submit" variant="primary">{busy ? t('runtimeSettings.saving') : t('runtimeSettings.save')}</Button>
          </div>
        </form>
        <p className="runtime-settings__hint">{t('runtimeSettings.edit.restartHint')}</p>
      </Surface>

      {error !== undefined && (
        <ErrorState
          description={error instanceof ApiClientError && error.apiError.code === 'CONFLICT' ? t('runtimeSettings.errors.conflict') : t('runtimeSettings.errors.invalid')}
          title={t('runtimeSettings.saveFailed')}
        />
      )}
      {notice !== null && <p role="status">{notice}</p>}
    </div>
  );
}