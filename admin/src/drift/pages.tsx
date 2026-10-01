import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, CircleAlert, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { Button } from '../components/button';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { mapLegacyPath } from '../route-map';
import { fetchDriftReport, reconcileCollectionProjection, type DriftFinding, type DriftReport, type DriftSeverity } from './client';

type LoadState = 'loading' | 'error' | 'ready';

// deepLink 由 Runtime 契约返回，可能仍是旧信息架构路径；经 route-map 映射到新导航。
function correctiveSurfaceLink(deepLink: string): string {
  const mapped = mapLegacyPath(deepLink.split('?')[0] ?? deepLink, deepLink.includes('?') ? deepLink.slice(deepLink.indexOf('?')) : '');
  return mapped === null ? deepLink : `${mapped.pathname}${mapped.search}`;
}

const storageFindingFacts: Record<string, { expected: TranslationKey; actual: TranslationKey }> = {
  'physicalProjection.tableMissing': {
    expected: 'drift.findings.expectedStorageTable',
    actual: 'drift.findings.actualStorageTable',
  },
  'runtimeState.orphanProjection': {
    expected: 'drift.findings.expectedCollectionStorage',
    actual: 'drift.findings.actualUnmatchedStorage',
  },
};

function findingFact(finding: DriftFinding, side: 'expected' | 'actual', translate: (key: TranslationKey) => string): string {
  const key = storageFindingFacts[finding.code]?.[side];
  return key ? translate(key) : finding[side];
}

function stateTone(state: DriftReport['state']): string {
  switch (state) {
    case 'healthy': return 'ready';
    case 'attention': return 'degraded';
    default: return 'unavailable';
  }
}

function severityTone(severity: DriftSeverity): string {
  switch (severity) {
    case 'error': return 'unavailable';
    case 'warning': return 'degraded';
    default: return 'info';
  }
}

// embedded：作为 `/changes?tab=drift` 的内容渲染时不再重复页面级标题，
// 由 Changes 工作区提供唯一的 h1（spec 0001 §3.2、§16.2）；独立渲染仍保留自己的标题。
export function DriftPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [report, setReport] = useState<DriftReport | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setState('loading');
    setError(undefined);
    return fetchDriftReport(undefined, signal).then(
      (value) => { setReport(value); setState('ready'); },
      (reason: unknown) => { setError(reason); setState('error'); },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function reconcile(finding: DriftFinding) {
    if (!finding.collectionId) return;
    setBusy(finding.id);
    setNotice(null);
    setError(undefined);
    try {
      setReport(await reconcileCollectionProjection(finding.collectionId));
      setNotice(t('drift.notices.reconciled'));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'surface.drift',
      category: 'commands.categories.system',
      label: () => t('commands.drift'),
      keywords: () => [t('drift.searchKeywords')],
      // 结构漂移已并入「变更」工作区的 `结构漂移` 页签（spec 0001 §3.2、§15）。
      execute: () => navigate('/changes?tab=drift'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('drift.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('drift.loadFailedDescription')} title={t('drift.loadFailed')}>
          <div className="mt-3">
            <Button onClick={() => void load()} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('drift.retry')}</Button>
          </div>
        </ErrorState>
      </div>
    );
  }
  if (!report) return null;

  const actionable = report.findings.filter((finding) => !finding.expectedPendingChange);
  const expected = report.findings.filter((finding) => finding.expectedPendingChange);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {embedded
        ? <div className="flex flex-wrap items-center justify-end gap-2">
          <Button disabled={busy !== null} onClick={() => void load()} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> {t('drift.refresh')}
          </Button>
        </div>
        : <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">{t('drift.eyebrow')}</p>
            <h1>{t('drift.title')}</h1>
            <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('drift.description')}</p>
          </div>
          <Button disabled={busy !== null} onClick={() => void load()} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> {t('drift.refresh')}
          </Button>
        </header>}

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ShieldCheck size={16} /></span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{t('drift.state.eyebrow')}</p>
            <h2>{t('drift.state.title')}</h2>
          </div>
          <StatusChip state={stateTone(report.state)}>{t(('drift.states.' + report.state) as TranslationKey)}</StatusChip>
        </div>
        <dl className="m-0 grid gap-2.5 sm:grid-cols-3">
          <div className="rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] text-muted-foreground">{t('drift.state.findings')}</dt>
            <dd className="m-0 mt-1 text-sm font-semibold text-foreground">{actionable.length}</dd>
          </div>
          <div className="rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] text-muted-foreground">{t('drift.state.expected')}</dt>
            <dd className="m-0 mt-1 text-sm font-semibold text-foreground">{expected.length}</dd>
          </div>
          <div className="rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] text-muted-foreground">{t('drift.state.detected')}</dt>
            <dd className="m-0 mt-1 text-sm font-semibold text-foreground">{new Date(report.detectedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="min-w-0">
          <h2>{t('drift.findings.title')}</h2>
          <p className="m-0 mt-1 max-w-[620px] text-xs leading-relaxed text-muted-foreground">{t('drift.findings.description')}</p>
        </div>
        {actionable.length === 0
          ? <EmptyState description={t('drift.findings.emptyDescription')} title={t('drift.findings.empty')} />
          : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {actionable.map((finding) => (
                <li
                  className={`flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3.5${finding.severity === 'error' ? ' border-danger/30' : ''}`}
                  data-drift-code={finding.code}
                  key={finding.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
                        {finding.severity === 'error' && <CircleAlert aria-hidden="true" className="shrink-0 text-danger" size={15} />}
                        <span className="truncate">{t(('drift.codes.' + finding.code) as TranslationKey, { code: finding.code })}</span>
                      </h3>
                      {finding.collectionName && <p className="m-0 mt-0.5 break-words text-xs text-muted-foreground">{finding.collectionName}</p>}
                    </div>
                    <StatusChip state={severityTone(finding.severity)}>{t(('drift.severities.' + finding.severity) as TranslationKey)}</StatusChip>
                  </div>
                  <dl className="m-0 grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-0.5 rounded-md border bg-secondary px-3 py-2">
                      <dt className="text-[11px] font-semibold text-muted-foreground">{t('drift.findings.expected')}</dt>
                      <dd className="m-0 text-xs text-ink-secondary [overflow-wrap:anywhere]">{findingFact(finding, 'expected', t)}</dd>
                    </div>
                    <div className="grid gap-0.5 rounded-md border bg-secondary px-3 py-2">
                      <dt className="text-[11px] font-semibold text-muted-foreground">{t('drift.findings.actual')}</dt>
                      <dd className="m-0 text-xs text-ink-secondary [overflow-wrap:anywhere]">{findingFact(finding, 'actual', t)}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2.5">
                    {finding.remedy === 'reconcile' && finding.collectionId && (
                      <Button disabled={busy !== null} onClick={() => void reconcile(finding)} size="small" type="button" variant="primary">
                        <Wrench aria-hidden="true" size={14} /> {busy === finding.id ? t('drift.reconciling') : t('drift.reconcile')}
                      </Button>
                    )}
                    {finding.remedy === 'manual' && <span className="text-xs text-muted-foreground">{t('drift.manualRemedy')}</span>}
                    <Link className="text-xs font-semibold text-primary hover:underline" to={correctiveSurfaceLink(finding.deepLink)}>{t('drift.openCorrectiveSurface')}</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Surface>

      {expected.length > 0 && (
        <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
          <div className="min-w-0">
            <h2>{t('drift.expected.title')}</h2>
            <p className="m-0 mt-1 max-w-[620px] text-xs leading-relaxed text-muted-foreground">{t('drift.expected.description')}</p>
          </div>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {expected.map((finding) => (
              <li className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3.5" key={finding.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-foreground">{finding.expectedPendingChange ? t('drift.expected.pendingChange') : finding.code}</h3>
                    {finding.collectionName && <p className="m-0 mt-0.5 break-words text-xs text-muted-foreground">{finding.collectionName}</p>}
                  </div>
                  <StatusChip state="info">{t('drift.expected.badge')}</StatusChip>
                </div>
                <div>
                  <Link className="text-xs font-semibold text-primary hover:underline" to={correctiveSurfaceLink(finding.deepLink)}>{t('drift.openCorrectiveSurface')}</Link>
                </div>
              </li>
            ))}
          </ul>
        </Surface>
      )}

      {error !== undefined && <ErrorState description={error instanceof ApiClientError ? error.apiError.message : t('drift.loadFailedDescription')} title={t('drift.actionFailed')} />}
      {notice !== null && (
        <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status">
          <Check aria-hidden="true" className="shrink-0 text-success" size={15} />{notice}
        </div>
      )}
    </div>
  );
}
