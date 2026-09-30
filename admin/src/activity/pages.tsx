import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listAllCollections, type CollectionSummary } from '../collections/client';
import { listActivity, type ActivityFact, type ActivityKind } from './client';

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
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>('loading');
  const [facts, setFacts] = useState<ActivityFact[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // URL 是 Kind 与 Collection 两个过滤器的唯一事实来源（spec §9.2），
  // 因此过滤状态可分享、可刷新、可用浏览器前进/后退。
  const requestedKind = searchParams.get('kind') ?? '';
  const kind: ActivityKind | '' = (kinds as readonly string[]).includes(requestedKind) ? (requestedKind as ActivityKind) : '';
  const collectionId = searchParams.get('collection') ?? '';

  // Collection 选项只加载一次；失败时省略选项，过滤器本身仍然可用。
  useEffect(() => {
    const controller = new AbortController();
    void listAllCollections(controller.signal).then((values) => {
      if (!controller.signal.aborted) setCollections(values);
    }).catch(() => {
      if (!controller.signal.aborted) setCollections([]);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setError(undefined);
    listActivity({ limit: 20, ...(kind ? { kinds: [kind] } : {}), ...(collectionId ? { collectionId } : {}) }, controller.signal).then(
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
  }, [collectionId, kind, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await listActivity({ limit: 20, cursor: nextCursor, ...(kind ? { kinds: [kind] } : {}), ...(collectionId ? { collectionId } : {}) });
      setFacts((current) => [...current, ...page.data]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }, [collectionId, kind, nextCursor]);

  function updateQuery(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

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

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('activity.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('activity.loadFailedDescription')} title={t('activity.loadFailed')}>
          <div className="mt-3">
            <Button onClick={() => setReloadKey((value) => value + 1)} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('activity.retry')}</Button>
          </div>
        </ErrorState>
        {error instanceof ApiClientError && <p className="m-0 text-xs text-danger" role="alert">{error.apiError.message}</p>}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{t('activity.eyebrow')}</p>
          <h1>{t('activity.title')}</h1>
          <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('activity.description')}</p>
        </div>
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ActivityIcon size={19} /></span>
      </header>

      <Surface className="flex flex-wrap items-end gap-3 p-3" variant="standard">
        <div className="w-full min-w-[190px] max-w-[220px]">
          <FormField htmlFor="activity-kind" label={t('activity.filter')}>
            <select id="activity-kind" onChange={(event) => updateQuery('kind', event.target.value)} value={kind}>
              <option value="">{t('activity.filterAll')}</option>
              {kinds.map((candidate) => <option key={candidate} value={candidate}>{t(kindKey(candidate))}</option>)}
            </select>
          </FormField>
        </div>
        <div className="w-full min-w-[220px] max-w-[280px]">
          <FormField htmlFor="activity-collection" label={t('api.filterByCollection')}>
            <select id="activity-collection" onChange={(event) => updateQuery('collection', event.target.value)} value={collectionId}>
              <option value="">{t('api.allCollections')}</option>
              {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
            </select>
          </FormField>
        </div>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-3 p-4" variant="standard">
        {facts.length === 0
          ? <EmptyState description={t('activity.empty.description')} title={t('activity.empty.title')} />
          : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {facts.map((fact) => (
                <li
                  className={`flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-3.5${statusTone(fact.status) === 'unavailable' ? ' border-danger/30' : ''}`}
                  data-activity-kind={fact.kind}
                  key={fact.id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">{t(kindKey(fact.kind))}</h3>
                      {fact.title && <span className="truncate text-xs font-medium text-ink-secondary">{fact.title}</span>}
                    </div>
                    <p className="m-0 mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <code className="font-mono text-[11px]">{fact.resourceId}</code>
                      <span aria-hidden="true">·</span>
                      <small className="text-[11px]">{new Date(fact.occurredAt).toLocaleString()}</small>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusChip state={statusTone(fact.status)}>{t(('activity.statuses.' + fact.status) as TranslationKey, { status: fact.status })}</StatusChip>
                    <Link className="text-xs font-semibold text-primary hover:underline" to={fact.deepLink}>{t('activity.open')}</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        {nextCursor && (
          <div className="flex justify-end">
            <Button disabled={busy} onClick={() => void loadMore()} size="small" type="button" variant="secondary">{busy ? t('activity.loadingMore') : t('activity.loadMore')}</Button>
          </div>
        )}
      </Surface>
    </div>
  );
}
