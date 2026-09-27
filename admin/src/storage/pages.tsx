import { useCallback, useEffect, useMemo, useState } from 'react';
import { HardDrive, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import {
  cancelFileMigration, fetchFileStorage, listFileMigrations, listStorageSecretOptions,
  saveFileStorageProvider, startFileMigration, testFileStorageProvider,
  type FileMigration, type FileStorageStatus, type ProviderKind, type S3Input, type SecretOption,
} from './client';
import './storage.css';

type LoadState = 'loading' | 'error' | 'ready';

function emptyS3Input(): S3Input {
  return { endpoint: '', region: '', bucket: '', keyPrefix: '', pathStyle: true, accessKeySecretId: '', secretKeySecretId: '', sessionTokenSecretId: '' };
}

function stateChipState(state: FileStorageStatus['providerState']): 'ready' | 'degraded' | 'unavailable' | 'unknown' {
  return state;
}

function providerStateKey(state: FileStorageStatus['providerState']): TranslationKey {
  switch (state) {
    case 'ready': return 'storage.states.ready';
    case 'degraded': return 'storage.states.degraded';
    case 'unavailable': return 'storage.states.unavailable';
    default: return 'storage.states.unknown';
  }
}

function actionMessage(error: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (!(error instanceof ApiClientError)) return t('storage.errors.unexpected');
  switch (error.apiError.code) {
    case 'MIGRATION_REQUIRED': return t('storage.errors.migrationRequired');
    case 'MIGRATION_ACTIVE': return t('storage.errors.migrationActive');
    case 'MIGRATION_NOT_ACTIVE': return t('storage.errors.migrationNotActive');
    case 'STORAGE_CREDENTIAL_UNAVAILABLE': return t('storage.errors.credentialUnavailable');
    case 'STORAGE_PROVIDER_NOT_CONFIGURED': return t('storage.errors.providerNotConfigured');
    case 'STORAGE_PROVIDER_UNAVAILABLE': return t('storage.errors.providerUnavailable');
    case 'CONFLICT': return t('storage.errors.conflict');
    case 'INVALID_ARGUMENT': return t('storage.errors.invalidArgument');
    case 'UNAUTHENTICATED': return t('storage.errors.unauthenticated');
    default: return t('storage.errors.unexpected');
  }
}

function migrationStateKey(status: FileMigration['status']): TranslationKey {
  switch (status) {
    case 'pending': return 'storage.migration.states.pending';
    case 'running': return 'storage.migration.states.running';
    case 'completed': return 'storage.migration.states.completed';
    case 'failed': return 'storage.migration.states.failed';
    case 'cancelled': return 'storage.migration.states.cancelled';
    default: return 'storage.migration.states.interrupted';
  }
}

export function FileStoragePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [status, setStatus] = useState<FileStorageStatus | null>(null);
  const [loadError, setLoadError] = useState<unknown>();
  const [secrets, setSecrets] = useState<SecretOption[]>([]);
  const [provider, setProvider] = useState<ProviderKind>('local');
  const [s3, setS3] = useState<S3Input>(emptyS3Input());
  const [testResult, setTestResult] = useState<{ state: 'ready' | 'unavailable'; message: string } | null>(null);
  const [migrations, setMigrations] = useState<FileMigration[]>([]);
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    Promise.all([fetchFileStorage(controller.signal), listStorageSecretOptions(controller.signal), listFileMigrations(controller.signal)]).then(
      ([value, secretOptions, history]) => {
        if (controller.signal.aborted) return;
        setStatus(value);
        setProvider(value.activeProvider);
        setS3({
          endpoint: value.configuration.s3?.endpoint ?? '',
          region: value.configuration.s3?.region ?? '',
          bucket: value.configuration.s3?.bucket ?? '',
          keyPrefix: value.configuration.s3?.keyPrefix ?? '',
          pathStyle: value.configuration.s3?.pathStyle ?? true,
          accessKeySecretId: value.configuration.s3?.accessKey?.secretId ?? '',
          secretKeySecretId: value.configuration.s3?.secretKey?.secretId ?? '',
          sessionTokenSecretId: value.configuration.s3?.sessionToken?.secretId ?? '',
        });
        setSecrets(secretOptions);
        setMigrations(history);
        setLoadError(undefined);
        setState('ready');
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(reason);
        setState('error');
      },
    );
    return () => controller.abort();
  }, [generation]);

  const refresh = useCallback(() => { setNotice(null); setActionError(undefined); setGeneration((value) => value + 1); }, []);

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'navigate.file-storage',
      category: 'commands.categories.system',
      label: () => t('commands.fileStorage'),
      keywords: () => [t('storage.searchKeywords')],
      execute: () => navigate('/settings/storage'),
    },
  ], [navigate, t]);

  useRegisterCommands(commands);
  async function testConnection() {
    setBusy('test');
    setActionError(undefined);
    setTestResult(null);
    try {
      const result = await testFileStorageProvider(s3);
      setTestResult({ state: result.state, message: result.message });
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function saveProvider() {
    if (!status) return;
    setBusy('save');
    setActionError(undefined);
    setNotice(null);
    try {
      const saved = await saveFileStorageProvider({
        expectedRevision: status.revision,
        provider,
        ...(provider === 's3' ? { s3 } : {}),
      });
      setStatus(saved);
      setNotice(t('storage.notices.saved'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function migrate() {
    if (!status) return;
    const target: ProviderKind = status.activeProvider === 'local' ? 's3' : 'local';
    setBusy('migrate');
    setActionError(undefined);
    setNotice(null);
    try {
      const migration = await startFileMigration({ targetProvider: target, ...(target === 's3' ? { s3 } : {}) });
      setMigrations((current) => [migration, ...current.filter((item) => item.id !== migration.id)]);
      setNotice(t('storage.notices.migrationStarted'));
      refresh();
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function cancelMigration(migrationId: string) {
    setBusy('cancel');
    setActionError(undefined);
    try {
      const cancelled = await cancelFileMigration(migrationId);
      setMigrations((current) => current.map((item) => (item.id === cancelled.id ? cancelled : item)));
      setNotice(t('storage.notices.migrationCancelled'));
      refresh();
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading') return <div className="page-stack"><LoadingState label={t('storage.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="page-stack">
        <ErrorState title={t('storage.loadFailed')} description={t('storage.loadFailedDescription')}>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('storage.retry')}</Button>
        </ErrorState>
        {loadError instanceof ApiClientError && loadError.apiError.code === 'UNAUTHENTICATED' && <p>{t('storage.errors.unauthenticated')}</p>}
      </div>
    );
  }
  if (!status) return null;

  const activeMigration = migrations.find((item) => item.status === 'running' || item.status === 'pending')
  const targetLabel = status.activeProvider === 'local' ? 'S3-compatible' : 'Local';
  return (
    <div className="page-stack storage-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('storage.eyebrow')}</p>
          <h1>{t('storage.title')}</h1>
          <p className="page-description">{t('storage.description')}</p>
        </div>
      </header>

      <Surface className="storage-status" variant="standard">
        <div className="storage-status__heading">
          <span className="scope-icon"><HardDrive aria-hidden="true" size={17} /></span>
          <div>
            <p className="eyebrow">{t('storage.status.eyebrow')}</p>
            <h2>{t('storage.status.title')}</h2>
          </div>
          <StatusChip state={stateChipState(status.providerState)}>{t(providerStateKey(status.providerState))}</StatusChip>
        </div>
        <dl className="storage-status__facts">
          <div><dt>{t('storage.status.provider')}</dt><dd>{status.provider}</dd></div>
          <div><dt>{t('storage.status.referencedObjects')}</dt><dd>{status.health.referencedObjects}</dd></div>
          <div><dt>{t('storage.status.revision')}</dt><dd>{status.revision}</dd></div>
        </dl>
        {status.providerMessage && <p role="status">{status.providerMessage}</p>}
        {status.providerHint && <p className="storage-hint">{status.providerHint}</p>}
        {status.activeProvider === 'local' && <p className="storage-path"><span>{t('storage.status.localPath')}</span><code>{status.configuration.local.path}</code></p>}
      </Surface>

      <Surface className="storage-provider" variant="standard">
        <h2>{t('storage.provider.title')}</h2>
        <p className="section-description">{t('storage.provider.description')}</p>
        <FormField htmlFor="storage-provider" label={t('storage.provider.label')}>
          <select id="storage-provider" onChange={(event) => setProvider(event.target.value === 's3' ? 's3' : 'local')} value={provider}>
            <option value="local">{t('storage.provider.local')}</option>
            <option value="s3">{t('storage.provider.s3')}</option>
          </select>
        </FormField>
        {provider === 's3' && <div className="storage-provider__fields">
          <FormField htmlFor="storage-endpoint" label={t('storage.provider.endpoint')} hint={t('storage.provider.endpointHint')}>
            <input id="storage-endpoint" onChange={(event) => setS3({ ...s3, endpoint: event.target.value })} placeholder="https://s3.example.com" type="url" value={s3.endpoint} />
          </FormField>
          <FormField htmlFor="storage-region" label={t('storage.provider.region')}>
            <input id="storage-region" onChange={(event) => setS3({ ...s3, region: event.target.value })} value={s3.region} />
          </FormField>
          <FormField htmlFor="storage-bucket" label={t('storage.provider.bucket')}>
            <input id="storage-bucket" onChange={(event) => setS3({ ...s3, bucket: event.target.value })} value={s3.bucket} />
          </FormField>
          <FormField htmlFor="storage-key-prefix" label={t('storage.provider.keyPrefix')} hint={t('storage.provider.keyPrefixHint')}>
            <input id="storage-key-prefix" onChange={(event) => setS3({ ...s3, keyPrefix: event.target.value })} value={s3.keyPrefix} />
          </FormField>
          <FormField htmlFor="storage-path-style" label={t('storage.provider.pathStyle')}>
            <input checked={s3.pathStyle ?? true} id="storage-path-style" onChange={(event) => setS3({ ...s3, pathStyle: event.target.checked })} type="checkbox" />
          </FormField>
          <FormField htmlFor="storage-access-key" label={t('storage.provider.accessKey')}>
            <select id="storage-access-key" onChange={(event) => setS3({ ...s3, accessKeySecretId: event.target.value })} value={s3.accessKeySecretId}>
              <option value="">{t('storage.provider.chooseSecret')}</option>
              {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
            </select>
          </FormField>
          <FormField htmlFor="storage-secret-key" label={t('storage.provider.secretKey')}>
            <select id="storage-secret-key" onChange={(event) => setS3({ ...s3, secretKeySecretId: event.target.value })} value={s3.secretKeySecretId}>
              <option value="">{t('storage.provider.chooseSecret')}</option>
              {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
            </select>
          </FormField>
          <FormField htmlFor="storage-session-token" label={t('storage.provider.sessionToken')}>
            <select id="storage-session-token" onChange={(event) => setS3({ ...s3, sessionTokenSecretId: event.target.value })} value={s3.sessionTokenSecretId ?? ''}>
              <option value="">{t('storage.provider.noSessionToken')}</option>
              {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
            </select>
          </FormField>
          {secrets.length === 0 && <p className="storage-hint">{t('storage.provider.noSecrets')} <Link to="/secrets">{t('storage.provider.createSecret')}</Link></p>}
        </div>}
        <div className="storage-actions">
          {provider === 's3' && <Button disabled={busy !== null} onClick={() => void testConnection()} size="small" type="button" variant="secondary">{t('storage.provider.test')}</Button>}
          <Button disabled={busy !== null} onClick={() => void saveProvider()} size="small" type="button" variant="primary">{t('storage.provider.save')}</Button>
        </div>
        {testResult !== null && <p role="status">{testResult.state === 'ready' ? t('storage.provider.testReady') : t('storage.provider.testUnavailable')} · {testResult.message}</p>}
      </Surface>
      <Surface className="storage-migration" variant="standard">
        <div className="storage-status__heading">
          <span className="scope-icon"><ShieldCheck aria-hidden="true" size={17} /></span>
          <div>
            <p className="eyebrow">{t('storage.migration.eyebrow')}</p>
            <h2>{t('storage.migration.title')}</h2>
          </div>
        </div>
        <p className="section-description">{t('storage.migration.description')}</p>
        {status.migration.latest && <div className="storage-migration__state">
          <StatusChip state={status.migration.latest.status === 'completed' ? 'ready' : status.migration.latest.status === 'failed' ? 'unavailable' : 'degraded'}>
            {t(migrationStateKey(status.migration.latest.status))}
          </StatusChip>
          <span>{t('storage.migration.progress', { copied: status.migration.latest.copiedObjects, total: status.migration.latest.totalObjects })}</span>
          {status.migration.latest.targetEndpointHost && <span>{status.migration.latest.targetEndpointHost}</span>}
        </div>}
        {status.migration.latest?.status === 'interrupted' && <p role="status">{t('storage.migration.interruptedHint')}</p>}
        {status.migration.latest?.status === 'failed' && <p role="alert">{t('storage.migration.failedHint')}</p>}
        {status.migration.latest?.status === 'completed' && <p role="status">{t('storage.migration.completedHint')}</p>}
        <div className="storage-actions">
          <Button disabled={busy !== null || status.migration.active} onClick={() => void migrate()} size="small" type="button" variant="primary">
            {t('storage.migration.start')} · {targetLabel}
          </Button>
          {activeMigration && <Button disabled={busy !== null} onClick={() => void cancelMigration(activeMigration.id)} size="small" type="button" variant="quiet">{t('storage.migration.cancel')}</Button>}
          <Button disabled={busy !== null} onClick={refresh} size="small" type="button" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('storage.refresh')}</Button>
        </div>
        {migrations.length > 0 && <ul className="storage-migration__history">
          {migrations.slice(0, 5).map((item) => <li key={item.id}>
            <code>{item.id}</code>
            <span>{item.sourceProvider} → {item.targetProvider}</span>
            <span>{t(migrationStateKey(item.status))}</span>
            <span>{item.copiedObjects}/{item.totalObjects}</span>
          </li>)}
        </ul>}
      </Surface>

      {actionError !== undefined && <ErrorState title={t('storage.actionFailed')} description={actionMessage(actionError, t)} />}
      {notice !== null && <p role="status">{notice}</p>}
    </div>
  );
}