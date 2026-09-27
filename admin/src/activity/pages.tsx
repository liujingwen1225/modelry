import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listActivity, type ActivityFact, type ActivityKind } from './client';
import './activity.css';

type LoadState = 'loading' | 'error' | 'ready';

const kinds: ActivityKind[] = [
  'change.applied', 'change.pending', 'change.failed', 'webhook.delivery', 'job.run',
  'extension.run', 'mail.delivery', 'storage.migration', 'auth.recovery',
];

function kindKey(kind: ActivityKind): TranslationKey {
  return ('activity.kinds.' + kind) as TranslationKey;
}

function statusTone(status: string): string {
  switch (status) {
    case 'succeeded': case 'applied': case 'confirmed': return 'ready';
    case 'failed': case 'rejected': case 'cancelled': return 'unavailable';
    case 'pending': case 'ready': case 'needsReview': case 'requested': case 'running': return 'degraded';
    default: return 'info';
  }
}

export function ActivityPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [facts, setFacts] = useState<ActivityFact[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<ActivityKind | ''>('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setError(undefined);
    listActivity({ limit: 20, ...(kind ? { kinds: [kind] } : {}) }, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setFacts(page.data);
        setNextCursor(page.nextCursor);
        setState('ready');
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason);
        setState('error');
      },
    );
    return () => controller.abort();
  }, [kind]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await listActivity({ limit: 20, cursor: nextCursor, ...(kind ? { kinds: [kind] } : {}) });
      setFacts((current) => [...current, ...page.data]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }, [kind, nextCursor]);

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'surface.activity',
      category: 'commands.categories.system',
      label: () => t('commands.activity'),
      keywords: () => [t('activity.searchKeywords')],
      execute: () => navigate('/activity'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  if (state === 'loading') return <div className="page-stack"><LoadingState label={t('activity.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="page-stack">
        <ErrorState description={t('activity.loadFailedDescription')} title={t('activity.loadFailed')}>
          <Button onClick={() => setKind((current) => current)} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('activity.retry')}</Button>
        </ErrorState>
        {error instanceof ApiClientError && <p role="alert">{error.apiError.message}</p>}
      </div>
    );
  }

  return (
    <div className="page-stack activity-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('activity.eyebrow')}</p>
          <h1>{t('activity.title')}</h1>
          <p className="page-description">{t('activity.description')}</p>
        </div>
      </header>

      <Surface className="activity-list" variant="standard">
        <div className="activity-list__heading">
          <span className="scope-icon"><ActivityIcon aria-hidden="true" size={17} /></span>
          <FormField htmlFor="activity-kind" label={t('activity.filter')}>
            <select id="activity-kind" onChange={(event) => setKind(event.target.value as ActivityKind | '')} value={kind}>
              <option value="">{t('activity.filterAll')}</option>
              {kinds.map((candidate) => <option key={candidate} value={candidate}>{t(kindKey(candidate))}</option>)}
            </select>
          </FormField>
        </div>
        {facts.length === 0
          ? <EmptyState description={t('activity.empty.description')} title={t('activity.empty.title')} />
          : (
            <ul className="activity-facts">
              {facts.map((fact) => (
                <li data-activity-kind={fact.kind} key={fact.id}>
                  <div className="activity-fact__main">
                    <strong>{t(kindKey(fact.kind))}</strong>
                    {fact.title && <span className="activity-fact__title">{fact.title}</span>}
                    <code>{fact.resourceId}</code>
                    <small>{new Date(fact.occurredAt).toLocaleString()}</small>
                  </div>
                  <StatusChip state={statusTone(fact.status)}>{t(('activity.statuses.' + fact.status) as TranslationKey, { status: fact.status })}</StatusChip>
                  <Link className="activity-fact__link" to={fact.deepLink}>{t('activity.open')}</Link>
                </li>
              ))}
            </ul>
          )}
        {nextCursor && <Button disabled={busy} onClick={() => void loadMore()} size="small" type="button" variant="secondary">{busy ? t('activity.loadingMore') : t('activity.loadMore')}</Button>}
      </Surface>
    </div>
  );
}