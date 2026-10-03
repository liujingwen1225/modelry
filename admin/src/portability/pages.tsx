import { Input, Textarea } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Package, RefreshCw, Upload } from 'lucide-react';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listAllCollections } from '../collections/client';
import {
  createBackup, exportCollection, importCollection, preflightRestoreBundle,
  type BackupPreflight, type ImportSummary,
} from './client';

type LoadState = 'loading' | 'error' | 'ready';
type Collection = { id: string; name: string };
// 契约 / SDK 工作面已经归入 API 工作区的 OpenAPI Tab（spec 0001 §3.1、§15），
// 因此这里只剩系统设置里的「备份与恢复」与「数据导入导出」两个分节。
type Surface = 'backup' | 'data';

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
    const load = surface === 'data'
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
      label: () => t(surface === 'backup' ? 'commands.backupRestore' : 'commands.dataTransfer'),
      keywords: () => [t('portability.searchKeywords')],
      // 新 IA：备份与恢复、数据导入导出留在系统设置（spec 0001 §3.1、§11.2）；
      // API 契约 / SDK 归入 API 工作区的 OpenAPI 工作面，因此不再有 `/settings/developer`。
      execute: () => navigate(surface === 'backup' ? '/settings/backups' : '/settings/data'),
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

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('portability.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('portability.loadFailedDescription')} title={t('portability.loadFailed')}>
          <Button onClick={() => window.location.reload()} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('portability.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  const titleKey = surface === 'backup' ? 'portability.surfaces.backupTitle' : 'portability.surfaces.dataTitle';
  const descriptionKey = surface === 'backup' ? 'portability.surfaces.backupDescription' : 'portability.surfaces.dataDescription';
  // 眉标沿用系统设置分节词汇（spec 0001 §3.1、§11.2）。
  const eyebrowKey = surface === 'backup' ? 'settings.navigation.backupRestore' : 'settings.navigation.dataTransfer';

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">{t(eyebrowKey)}</p>
        <h2 className="text-lg font-semibold">{t(titleKey as TranslationKey)}</h2>
        <p className="mt-2.5 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{t(descriptionKey as TranslationKey)}</p>
      </header>

      {surface === 'backup' && <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted text-ink-secondary"><Package size={17} /></span>
          <div className="min-w-0">
            <p className="eyebrow">{t('portability.backup.eyebrow')}</p>
            <h2 className="text-base font-semibold">{t('portability.backup.title')}</h2>
          </div>
        </div>
        <p className="m-0 max-w-[720px] text-sm leading-relaxed text-muted-foreground">{t('portability.backup.description')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy !== null} onClick={() => void backup()} size="small" type="button" variant="primary">
            <Download aria-hidden="true" size={14} /> {busy === 'backup' ? t('portability.backup.running') : t('portability.backup.action')}
          </Button>
        </div>
        <FormField hint={t('portability.restore.hint')} htmlFor="portability-restore-bundle" label={t('portability.restore.label')}>
          <Input
            accept="application/x-tar,.tar"
            id="portability-restore-bundle"
            onChange={(event) => void preflightBundle(event.target.files?.[0])}
            type="file"
          />
        </FormField>
        {busy === 'preflight' && <LoadingState label={t('portability.restore.running')} />}
        {preflight && (
          <div className="flex min-w-0 flex-col gap-3 border-t pt-3" data-preflight-compatible={preflight.compatible ? 'true' : 'false'} role="status">
            <StatusChip state={preflight.compatible ? 'ready' : 'unavailable'}>
              {preflight.compatible ? t('portability.restore.compatible') : t('portability.restore.incompatible')}
            </StatusChip>
            <dl className="m-0 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              <div className="border-b py-3"><dt className="text-xs font-semibold text-muted-foreground">{t('portability.facts.projectId')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary"><code className="font-mono">{preflight.projectId ?? '—'}</code></dd></div>
              <div className="border-b py-3"><dt className="text-xs font-semibold text-muted-foreground">{t('portability.facts.runtimeVersion')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary">{preflight.runtimeVersion ?? '—'}</dd></div>
              <div className="border-b py-3"><dt className="text-xs font-semibold text-muted-foreground">{t('portability.facts.collections')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary">{preflight.counts.collections}</dd></div>
              <div className="border-b py-3"><dt className="text-xs font-semibold text-muted-foreground">{t('portability.facts.records')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary">{preflight.counts.records}</dd></div>
              <div className="border-b py-3"><dt className="text-xs font-semibold text-muted-foreground">{t('portability.facts.objects')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary">{preflight.counts.objects}</dd></div>
            </dl>
            {preflight.findings.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
                {preflight.findings.map((finding) => (
                  <li className="flex items-center gap-2" key={finding.code + finding.message}>
                    <StatusChip state={finding.severity === 'error' ? 'unavailable' : finding.severity === 'warning' ? 'degraded' : 'info'}>
                      {t(('portability.severities.' + finding.severity) as TranslationKey)}
                    </StatusChip>
                    <span className="min-w-0 text-ink-secondary">{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="m-0 text-sm text-muted-foreground">{t('portability.restore.adminHint')}</p>
          </div>
        )}
      </Surface>}

      {surface === 'data' && <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('portability.transfer.title')}</h2>
          <p className="mt-1.5 max-w-[720px] text-sm leading-relaxed text-muted-foreground">{t('portability.transfer.description')}</p>
        </div>
        {collections.length === 0
          ? <EmptyState description={t('portability.transfer.emptyDescription')} title={t('portability.transfer.empty')} />
          : (
            <>
              <FormField htmlFor="portability-collection" label={t('portability.transfer.collection')}>
                <SelectField id="portability-collection" onValueChange={(selectedValue) => setSelected(selectedValue)} value={selected} options={[collections.map((collection) => ({ value: collection.id, label: collection.name }))]} />
              </FormField>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy !== null} onClick={() => void exportRecords()} size="small" type="button" variant="secondary">
                  <Download aria-hidden="true" size={14} /> {t('portability.transfer.export')}
                </Button>
                <Button disabled={busy !== null || importText.trim() === ''} onClick={() => void importRecords()} size="small" type="button" variant="primary">
                  <Upload aria-hidden="true" size={14} /> {busy === 'import' ? t('portability.transfer.importing') : t('portability.transfer.import')}
                </Button>
              </div>
              <FormField hint={t('portability.transfer.ndjsonHint')} htmlFor="portability-import" label={t('portability.transfer.ndjson')}>
                <Textarea id="portability-import" onChange={(event) => setImportText(event.target.value)} rows={5} value={importText} />
              </FormField>
              {importSummary && (
                <div className="flex flex-col gap-2 rounded-lg border bg-secondary px-3 py-3" role="status">
                  <StatusChip state={importSummary.failed === 0 ? 'ready' : 'degraded'}>
                    {t('portability.transfer.summary', { created: importSummary.created, failed: importSummary.failed })}
                  </StatusChip>
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-[18px] text-xs text-ink-secondary">
                    {importSummary.results.filter((result) => result.status === 'failed').slice(0, 5).map((result) => (
                      <li key={result.index}>{t('portability.transfer.rowFailed', { index: result.index, code: result.code ?? 'INTERNAL_ERROR' })}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
      </Surface>}

      {error !== undefined && <ErrorState description={actionMessage(error)} title={t('portability.actionFailed')} />}
      {notice !== null && <p className="m-0 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-sm text-success" role="status">{notice}</p>}
    </div>
  );
}

export function BackupRestorePage() { return <PortabilitySurface surface="backup" />; }
export function DataTransferPage() { return <PortabilitySurface surface="data" />; }
