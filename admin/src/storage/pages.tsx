import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HardDrive, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import {
  cancelFileMigration, fetchFileStorage, listFileMigrations, listStorageSecretOptions,
  saveFileStorageProvider, startFileMigration, testFileStorageProvider,
  type FileMigration, type FileStorageStatus, type ProviderKind, type S3Input, type SecretOption,
} from './client';

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

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('storage.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState title={t('storage.loadFailed')} description={t('storage.loadFailedDescription')}>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('storage.retry')}</Button>
        </ErrorState>
        {loadError instanceof ApiClientError && loadError.apiError.code === 'UNAUTHENTICATED' && <p className="m-0 text-sm text-danger">{t('storage.errors.unauthenticated')}</p>}
      </div>
    );
  }
  if (!status) return null;

  const activeMigration = migrations.find((item) => item.status === 'running' || item.status === 'pending')
  const targetLabel = status.activeProvider === 'local' ? 'S3-compatible' : 'Local';
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">{t('storage.eyebrow')}</p>
        <h2 className="text-lg font-semibold">{t('storage.title')}</h2>
        <p className="mt-2.5 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{t('storage.description')}</p>
      </header>

      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted text-ink-secondary"><HardDrive size={17} /></span>
          <div className="min-w-0">
            <p className="eyebrow">{t('storage.status.eyebrow')}</p>
            <h2 className="text-base font-semibold">{t('storage.status.title')}</h2>
          </div>
          <div className="ml-auto">
            <StatusChip state={stateChipState(status.providerState)}>{t(providerStateKey(status.providerState))}</StatusChip>
          </div>
        </div>
        <dl className="m-0 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-storage-status-facts>
          <div className="flex min-w-0 flex-col gap-1 border-b py-3">
            <dt className="text-xs font-semibold text-muted-foreground">{t('storage.status.provider')}</dt>
            <dd className="m-0 break-words text-xs font-semibold text-ink-secondary">{status.provider}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1 border-b py-3">
            <dt className="text-xs font-semibold text-muted-foreground">{t('storage.status.referencedObjects')}</dt>
            <dd className="m-0 break-words text-xs font-semibold text-ink-secondary">{status.health.referencedObjects}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1 border-b py-3">
            <dt className="text-xs font-semibold text-muted-foreground">{t('storage.status.revision')}</dt>
            <dd className="m-0 break-words text-xs font-semibold text-ink-secondary">{status.revision}</dd>
          </div>
        </dl>
        {status.providerMessage && <p className="m-0 text-sm text-ink-secondary" role="status">{status.providerMessage}</p>}
        {status.providerHint && <p className="m-0 max-w-[720px] text-sm leading-relaxed text-muted-foreground">{status.providerHint}</p>}
        {status.activeProvider === 'local' && <p className="m-0 flex min-w-0 flex-col gap-0.5 text-sm text-muted-foreground"><span>{t('storage.status.localPath')}</span><code className="break-words font-mono text-ink-secondary">{status.configuration.local.path}</code></p>}
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('storage.provider.title')}</h2>
          <p className="mt-1.5 max-w-[720px] text-sm leading-relaxed text-muted-foreground">{t('storage.provider.description')}</p>
        </div>
        <FormField htmlFor="storage-provider" label={t('storage.provider.label')}>
          <SelectField id="storage-provider" onValueChange={(selectedValue) => setProvider(selectedValue === 's3' ? 's3' : 'local')} value={provider} options={[({ value: "local", label: t('storage.provider.local') }), ({ value: "s3", label: t('storage.provider.s3') })]} />
        </FormField>
        {provider === 's3' && <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FormField htmlFor="storage-endpoint" label={t('storage.provider.endpoint')} hint={t('storage.provider.endpointHint')}>
            <Input id="storage-endpoint" onChange={(event) => setS3({ ...s3, endpoint: event.target.value })} placeholder="https://s3.example.com" type="url" value={s3.endpoint} />
          </FormField>
          <FormField htmlFor="storage-region" label={t('storage.provider.region')}>
            <Input id="storage-region" onChange={(event) => setS3({ ...s3, region: event.target.value })} value={s3.region} />
          </FormField>
          <FormField htmlFor="storage-bucket" label={t('storage.provider.bucket')}>
            <Input id="storage-bucket" onChange={(event) => setS3({ ...s3, bucket: event.target.value })} value={s3.bucket} />
          </FormField>
          <FormField htmlFor="storage-key-prefix" label={t('storage.provider.keyPrefix')} hint={t('storage.provider.keyPrefixHint')}>
            <Input id="storage-key-prefix" onChange={(event) => setS3({ ...s3, keyPrefix: event.target.value })} value={s3.keyPrefix} />
          </FormField>
          <FormField htmlFor="storage-path-style" label={t('storage.provider.pathStyle')}>
            <Checkbox checked={s3.pathStyle ?? true} id="storage-path-style" onCheckedChange={(checked) => setS3({ ...s3, pathStyle: checked })} />
          </FormField>
          <FormField htmlFor="storage-access-key" label={t('storage.provider.accessKey')}>
            <SelectField id="storage-access-key" onValueChange={(selectedValue) => setS3({ ...s3, accessKeySecretId: selectedValue })} value={s3.accessKeySecretId} options={[({ value: "", label: t('storage.provider.chooseSecret') }), secrets.map((secret) => ({ value: secret.id, label: secret.name }))]} />
          </FormField>
          <FormField htmlFor="storage-secret-key" label={t('storage.provider.secretKey')}>
            <SelectField id="storage-secret-key" onValueChange={(selectedValue) => setS3({ ...s3, secretKeySecretId: selectedValue })} value={s3.secretKeySecretId} options={[({ value: "", label: t('storage.provider.chooseSecret') }), secrets.map((secret) => ({ value: secret.id, label: secret.name }))]} />
          </FormField>
          <FormField htmlFor="storage-session-token" label={t('storage.provider.sessionToken')}>
            <SelectField id="storage-session-token" onValueChange={(selectedValue) => setS3({ ...s3, sessionTokenSecretId: selectedValue })} value={s3.sessionTokenSecretId ?? ''} options={[({ value: "", label: t('storage.provider.noSessionToken') }), secrets.map((secret) => ({ value: secret.id, label: secret.name }))]} />
          </FormField>
          <div className="min-w-0 sm:col-span-2 xl:col-span-3">
            {secrets.length === 0
              ? <p className="m-0 text-sm text-muted-foreground">{t('storage.provider.noSecrets')} <Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('storage.provider.createSecret')}</Link></p>
              : <p className="m-0 text-sm text-muted-foreground"><Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('storage.provider.manageSecrets')}</Link></p>}
          </div>
        </div>}
        <div className="flex flex-wrap items-center gap-2">
          {provider === 's3' && <Button disabled={busy !== null} onClick={() => void testConnection()} size="small" type="button" variant="secondary">{t('storage.provider.test')}</Button>}
          <Button disabled={busy !== null} onClick={() => void saveProvider()} size="small" type="button" variant="primary">{t('storage.provider.save')}</Button>
        </div>
        {testResult !== null && <p className="m-0 text-sm text-ink-secondary" role="status">{testResult.state === 'ready' ? t('storage.provider.testReady') : t('storage.provider.testUnavailable')} · {testResult.message}</p>}
      </Surface>
      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted text-ink-secondary"><ShieldCheck size={17} /></span>
          <div className="min-w-0">
            <p className="eyebrow">{t('storage.migration.eyebrow')}</p>
            <h2 className="text-base font-semibold">{t('storage.migration.title')}</h2>
          </div>
        </div>
        <p className="m-0 max-w-[720px] text-sm leading-relaxed text-muted-foreground">{t('storage.migration.description')}</p>
        {status.migration.latest && <div className="flex flex-wrap items-center gap-2.5">
          <StatusChip state={status.migration.latest.status === 'completed' ? 'ready' : status.migration.latest.status === 'failed' ? 'unavailable' : 'degraded'}>
            {t(migrationStateKey(status.migration.latest.status))}
          </StatusChip>
          <span className="text-xs text-ink-secondary">{t('storage.migration.progress', { copied: status.migration.latest.copiedObjects, total: status.migration.latest.totalObjects })}</span>
          {status.migration.latest.targetEndpointHost && <span className="text-xs text-ink-secondary">{status.migration.latest.targetEndpointHost}</span>}
        </div>}
        {status.migration.latest?.status === 'interrupted' && <p className="m-0 text-sm text-warning" role="status">{t('storage.migration.interruptedHint')}</p>}
        {status.migration.latest?.status === 'failed' && <p className="m-0 text-sm text-danger" role="alert">{t('storage.migration.failedHint')}</p>}
        {status.migration.latest?.status === 'completed' && <p className="m-0 text-sm text-success" role="status">{t('storage.migration.completedHint')}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy !== null || status.migration.active} onClick={() => void migrate()} size="small" type="button" variant="primary">
            {t('storage.migration.start')} · {targetLabel}
          </Button>
          {activeMigration && <Button disabled={busy !== null} onClick={() => void cancelMigration(activeMigration.id)} size="small" type="button" variant="quiet">{t('storage.migration.cancel')}</Button>}
          <Button disabled={busy !== null} onClick={refresh} size="small" type="button" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('storage.refresh')}</Button>
        </div>
        {migrations.length > 0 && <ul className="m-0 grid list-none gap-1.5 p-0 text-xs">
          {migrations.slice(0, 5).map((item) => <li className="flex flex-wrap items-center gap-2.5 border-b py-1.5 last:border-b-0" key={item.id}>
            <code className="font-mono text-muted-foreground">{item.id}</code>
            <span className="text-ink-secondary">{item.sourceProvider} → {item.targetProvider}</span>
            <span className="text-ink-secondary">{t(migrationStateKey(item.status))}</span>
            <span className="text-ink-secondary">{item.copiedObjects}/{item.totalObjects}</span>
          </li>)}
        </ul>}
      </Surface>

      {actionError !== undefined && <ErrorState title={t('storage.actionFailed')} description={actionMessage(actionError, t)} />}
      {notice !== null && <p className="m-0 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-sm text-success" role="status">{notice}</p>}
    </div>
  );
}
