import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Package, RefreshCw, Upload } from 'lucide-react';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listAllCollections } from '../collections/client';
import {
  createBackup, exportCollection, fetchApplicationAPIContract, importCollection, preflightRestoreBundle,
  type ApplicationAPIContract, type BackupPreflight, type ImportSummary,
} from './client';
import './portability.css';

type LoadState = 'loading' | 'error' | 'ready';
type Collection = { id: string; name: string };
type Surface = 'backup' | 'data' | 'contract';

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function PortabilitySurface({ surface }: { surface: Surface }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [contract, setContract] = useState<ApplicationAPIContract | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<BackupPreflight | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importText, setImportText] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    const load = surface === 'contract'
      ? fetchApplicationAPIContract(controller.signal).then((value) => { setContract(value); })
      : surface === 'data'
        ? listAllCollections(controller.signal).then((listed) => {
          setCollections(listed.map((item) => ({ id: item.id, name: item.name })));
          setSelected(listed[0]?.id ?? '');
        })
        : Promise.resolve();
    void load.then(
      () => { if (!controller.signal.aborted) setState('ready'); },
      (reason: unknown) => { if (!controller.signal.aborted) { setError(reason); setState('error'); } },
    );
    return () => controller.abort();
  }, [surface]);

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: `surface.${surface}`,
      category: 'commands.categories.system',
      label: () => t(surface === 'backup' ? 'commands.backupRestore' : surface === 'data' ? 'commands.dataTransfer' : 'commands.apiContract'),
      keywords: () => [t('portability.searchKeywords')],
      execute: () => navigate(surface === 'backup' ? '/settings/backups' : surface === 'data' ? '/settings/data' : '/settings/developer'),
    },
  ], [navigate, surface, t]);
  useRegisterCommands(commands);

  async function backup() {
    setBusy('backup');
    setError(undefined);
    setNotice(null);
    try {
      const result = await createBackup();
      saveBlob(result.blob, result.fileName);
      setNotice(t('portability.notices.backedUp'));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function preflightBundle(file: File | undefined) {
    if (!file) return;
    setBusy('preflight');
    setError(undefined);
    setNotice(null);
    setPreflight(null);
    try {
      setPreflight(await preflightRestoreBundle(file));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function exportRecords() {
    if (!selected) return;
    setBusy('export');
    setError(undefined);
    setNotice(null);
    try {
      const result = await exportCollection(selected);
      saveBlob(new Blob([result.text], { type: 'application/x-ndjson' }), result.fileName);
      setImportText(result.text);
      setNotice(t('portability.notices.exported'));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function importRecords() {
    if (!selected || importText.trim() === '') return;
    setBusy('import');
    setError(undefined);
    setNotice(null);
    setImportSummary(null);
    try {
      const summary = await importCollection(selected, importText);
      setImportSummary(summary);
      setNotice(t('portability.notices.imported', { created: summary.created, failed: summary.failed }));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  function actionMessage(reason: unknown): string {
    if (!(reason instanceof ApiClientError)) return t('portability.errors.unexpected');
    switch (reason.apiError.code) {
      case 'MODEL_MISMATCH': return t('portability.errors.modelMismatch');
      case 'PROJECT_IN_USE': return t('portability.errors.projectInUse');
      case 'PROJECT_NOT_EMPTY': return t('portability.errors.projectNotEmpty');
      case 'VALIDATION_FAILED': return t('portability.errors.validationFailed');
      case 'FORBIDDEN': return t('portability.errors.forbidden');
      default: return t('portability.errors.unexpected');
    }
  }

  if (state === 'loading') return <div className="page-stack"><LoadingState label={t('portability.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="page-stack">
        <ErrorState description={t('portability.loadFailedDescription')} title={t('portability.loadFailed')}>
          <Button onClick={() => window.location.reload()} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('portability.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  if (surface === 'contract' && !contract) return null;

  const titleKey = surface === 'backup' ? 'portability.surfaces.backupTitle' : surface === 'data' ? 'portability.surfaces.dataTitle' : 'portability.surfaces.contractTitle';
  const descriptionKey = surface === 'backup' ? 'portability.surfaces.backupDescription' : surface === 'data' ? 'portability.surfaces.dataDescription' : 'portability.surfaces.contractDescription';

  return (
    <div className="page-stack portability-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t(surface === 'backup' ? 'settings.navigation.maintenance' : 'settings.navigation.developer')}</p>
          <h1>{t(titleKey as TranslationKey)}</h1>
          <p className="page-description">{t(descriptionKey as TranslationKey)}</p>
        </div>
      </header>

      {surface === 'backup' && <Surface className="portability-card" variant="standard">
        <div className="portability-card__heading">
          <span className="scope-icon"><Package aria-hidden="true" size={17} /></span>
          <div>
            <p className="eyebrow">{t('portability.backup.eyebrow')}</p>
            <h2>{t('portability.backup.title')}</h2>
          </div>
        </div>
        <p className="section-description">{t('portability.backup.description')}</p>
        <div className="portability-actions">
          <Button disabled={busy !== null} onClick={() => void backup()} size="small" type="button" variant="primary">
            <Download aria-hidden="true" size={14} /> {busy === 'backup' ? t('portability.backup.running') : t('portability.backup.action')}
          </Button>
        </div>
        <FormField hint={t('portability.restore.hint')} htmlFor="portability-restore-bundle" label={t('portability.restore.label')}>
          <input
            accept="application/x-tar,.tar"
            id="portability-restore-bundle"
            onChange={(event) => void preflightBundle(event.target.files?.[0])}
            type="file"
          />
        </FormField>
        {busy === 'preflight' && <LoadingState label={t('portability.restore.running')} />}
        {preflight && (
          <div className="portability-preflight" data-preflight-compatible={preflight.compatible ? 'true' : 'false'} role="status">
            <StatusChip state={preflight.compatible ? 'ready' : 'unavailable'}>
              {preflight.compatible ? t('portability.restore.compatible') : t('portability.restore.incompatible')}
            </StatusChip>
            <dl className="portability-facts">
              <div><dt>{t('portability.facts.projectId')}</dt><dd><code>{preflight.projectId ?? '—'}</code></dd></div>
              <div><dt>{t('portability.facts.runtimeVersion')}</dt><dd>{preflight.runtimeVersion ?? '—'}</dd></div>
              <div><dt>{t('portability.facts.collections')}</dt><dd>{preflight.counts.collections}</dd></div>
              <div><dt>{t('portability.facts.records')}</dt><dd>{preflight.counts.records}</dd></div>
              <div><dt>{t('portability.facts.objects')}</dt><dd>{preflight.counts.objects}</dd></div>
            </dl>
            {preflight.findings.length > 0 && (
              <ul className="portability-findings">
                {preflight.findings.map((finding) => (
                  <li key={finding.code + finding.message}>
                    <StatusChip state={finding.severity === 'error' ? 'unavailable' : finding.severity === 'warning' ? 'degraded' : 'info'}>
                      {t(('portability.severities.' + finding.severity) as TranslationKey)}
                    </StatusChip>
                    <span>{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="portability-hint">{t('portability.restore.adminHint')}</p>
          </div>
        )}
      </Surface>}

      {surface === 'data' && <Surface className="portability-card" variant="standard">
        <h2>{t('portability.transfer.title')}</h2>
        <p className="section-description">{t('portability.transfer.description')}</p>
        {collections.length === 0
          ? <EmptyState description={t('portability.transfer.emptyDescription')} title={t('portability.transfer.empty')} />
          : (
            <>
              <FormField htmlFor="portability-collection" label={t('portability.transfer.collection')}>
                <select id="portability-collection" onChange={(event) => setSelected(event.target.value)} value={selected}>
                  {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
                </select>
              </FormField>
              <div className="portability-actions">
                <Button disabled={busy !== null} onClick={() => void exportRecords()} size="small" type="button" variant="secondary">
                  <Download aria-hidden="true" size={14} /> {t('portability.transfer.export')}
                </Button>
                <Button disabled={busy !== null || importText.trim() === ''} onClick={() => void importRecords()} size="small" type="button" variant="primary">
                  <Upload aria-hidden="true" size={14} /> {busy === 'import' ? t('portability.transfer.importing') : t('portability.transfer.import')}
                </Button>
              </div>
              <FormField hint={t('portability.transfer.ndjsonHint')} htmlFor="portability-import" label={t('portability.transfer.ndjson')}>
                <textarea id="portability-import" onChange={(event) => setImportText(event.target.value)} rows={5} value={importText} />
              </FormField>
              {importSummary && (
                <div className="portability-import" role="status">
                  <StatusChip state={importSummary.failed === 0 ? 'ready' : 'degraded'}>
                    {t('portability.transfer.summary', { created: importSummary.created, failed: importSummary.failed })}
                  </StatusChip>
                  <ul>
                    {importSummary.results.filter((result) => result.status === 'failed').slice(0, 5).map((result) => (
                      <li key={result.index}>{t('portability.transfer.rowFailed', { index: result.index, code: result.code ?? 'INTERNAL_ERROR' })}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
      </Surface>}

      {surface === 'contract' && contract && <Surface className="portability-card" variant="standard">
        <h2>{t('portability.contract.title')}</h2>
        <p className="section-description">{t('portability.contract.description')}</p>
        <dl className="portability-facts">
          <div><dt>{t('portability.facts.runtimeVersion')}</dt><dd>{contract.version}</dd></div>
          <div><dt>{t('portability.contract.hash')}</dt><dd><code data-testid="contract-hash">{contract.contentHash}</code></dd></div>
          <div><dt>{t('portability.facts.collections')}</dt><dd>{contract.collections.length}</dd></div>
        </dl>
        <div className="portability-actions">
          <Button
            onClick={() => saveBlob(new Blob([JSON.stringify(contract, null, 2)], { type: 'application/json' }), 'application-api.json')}
            size="small"
            type="button"
            variant="secondary"
          >
            <Download aria-hidden="true" size={14} /> {t('portability.contract.download')}
          </Button>
        </div>
        <p className="portability-hint">{t('portability.contract.generateHint')}</p>
        <ul className="portability-endpoints">
          {contract.collections.slice(0, 5).map((collection) => (
            <li key={collection.id}>
              <strong>{collection.name}</strong>
              <span>{collection.type}</span>
              <code>{collection.endpoints.length} {t('portability.contract.endpoints')}</code>
            </li>
          ))}
        </ul>
      </Surface>}

      {error !== undefined && <ErrorState description={actionMessage(error)} title={t('portability.actionFailed')} />}
      {notice !== null && <p role="status">{notice}</p>}
    </div>
  );
}

export function BackupRestorePage() { return <PortabilitySurface surface="backup" />; }
export function DataTransferPage() { return <PortabilitySurface surface="data" />; }
export function APIContractPage() { return <PortabilitySurface surface="contract" />; }
export function PortabilityPage() { return <BackupRestorePage />; }
