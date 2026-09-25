import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { Button, EmptyState, ErrorState, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { fetchDriftReport, reconcileCollectionProjection, type DriftFinding, type DriftReport, type DriftSeverity } from './client';
import './drift.css';

type LoadState = 'loading' | 'error' | 'ready';

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

export function DriftPage() {
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
      execute: () => navigate('/settings/drift'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  if (state === 'loading') return <div className="page-stack"><LoadingState label={t('drift.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="page-stack">
        <ErrorState description={t('drift.loadFailedDescription')} title={t('drift.loadFailed')}>
          <Button onClick={() => void load()} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('drift.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  if (!report) return null;

  const actionable = report.findings.filter((finding) => !finding.expectedPendingChange);
  const expected = report.findings.filter((finding) => finding.expectedPendingChange);

  return (
    <div className="page-stack drift-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('drift.eyebrow')}</p>
          <h1>{t('drift.title')}</h1>
          <p className="page-description">{t('drift.description')}</p>
        </div>
        <div className="drift-actions">
          <Button disabled={busy !== null} onClick={() => void load()} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> {t('drift.refresh')}
          </Button>
        </div>
      </header>

      <Surface className="drift-state" variant="standard">
        <div className="drift-state__heading">
          <span className="scope-icon"><ShieldCheck aria-hidden="true" size={17} /></span>
          <div>
            <p className="eyebrow">{t('drift.state.eyebrow')}</p>
            <h2>{t('drift.state.title')}</h2>
          </div>
          <StatusChip state={stateTone(report.state)}>{t(('drift.states.' + report.state) as TranslationKey)}</StatusChip>
        </div>
        <dl className="drift-state__facts">
          <div><dt>{t('drift.state.findings')}</dt><dd>{actionable.length}</dd></div>
          <div><dt>{t('drift.state.expected')}</dt><dd>{expected.length}</dd></div>
          <div><dt>{t('drift.state.detected')}</dt><dd>{new Date(report.detectedAt).toLocaleString()}</dd></div>
        </dl>
      </Surface>

      <Surface className="drift-findings" variant="standard">
        <h2>{t('drift.findings.title')}</h2>
        <p className="section-description">{t('drift.findings.description')}</p>
        {actionable.length === 0
          ? <EmptyState description={t('drift.findings.emptyDescription')} title={t('drift.findings.empty')} />
          : (
            <ul className="drift-finding-list">
              {actionable.map((finding) => (
                <li data-drift-code={finding.code} key={finding.id}>
                  <div className="drift-finding__heading">
                    <StatusChip state={severityTone(finding.severity)}>{t(('drift.severities.' + finding.severity) as TranslationKey)}</StatusChip>
                    <strong>{t(('drift.codes.' + finding.code) as TranslationKey, { code: finding.code })}</strong>
                    {finding.collectionName && <span>{finding.collectionName}</span>}
                  </div>
                  <dl className="drift-finding__values">
                    <div><dt>{t('drift.findings.expected')}</dt><dd>{finding.expected}</dd></div>
                    <div><dt>{t('drift.findings.actual')}</dt><dd>{finding.actual}</dd></div>
                  </dl>
                  <div className="drift-finding__actions">
                    {finding.remedy === 'reconcile' && finding.collectionId && (
                      <Button disabled={busy !== null} onClick={() => void reconcile(finding)} size="small" type="button" variant="primary">
                        <Wrench aria-hidden="true" size={14} /> {busy === finding.id ? t('drift.reconciling') : t('drift.reconcile')}
                      </Button>
                    )}
                    {finding.remedy === 'manual' && <span className="drift-manual">{t('drift.manualRemedy')}</span>}
                    <Link className="drift-finding__link" to={finding.deepLink}>{t('drift.openCorrectiveSurface')}</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Surface>

      {expected.length > 0 && (
        <Surface className="drift-expected" variant="standard">
          <h2>{t('drift.expected.title')}</h2>
          <p className="section-description">{t('drift.expected.description')}</p>
          <ul className="drift-finding-list">
            {expected.map((finding) => (
              <li key={finding.id}>
                <div className="drift-finding__heading">
                  <StatusChip state="info">{t('drift.expected.badge')}</StatusChip>
                  <strong>{finding.expectedPendingChange ? t('drift.expected.pendingChange') : finding.code}</strong>
                  {finding.collectionName && <span>{finding.collectionName}</span>}
                </div>
                <div className="drift-finding__actions">
                  <Link className="drift-finding__link" to={finding.deepLink}>{t('drift.openCorrectiveSurface')}</Link>
                </div>
              </li>
            ))}
          </ul>
        </Surface>
      )}

      {error !== undefined && <ErrorState description={error instanceof ApiClientError ? error.apiError.message : t('drift.loadFailedDescription')} title={t('drift.actionFailed')} />}
      {notice !== null && <p role="status">{notice}</p>}
    </div>
  );
}