import { SelectField } from '@/components/ui/select-field';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react';
import { AuditPage } from '../access/pages';
import { Button, ButtonLink } from '../components/button';
import { FormField } from '../components/form-field';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { mapLegacyPath } from '../route-map';
import { listAllCollections, type CollectionSummary } from '../collections/client';
import { listActivity, type ActivityFact, type ActivityKind } from './client';

type LoadState = 'loading' | 'error' | 'ready';
type ActivitySource = 'audit' | 'facts';

const activitySourceOrder: readonly ActivitySource[] = ['audit', 'facts'];

// 来源名称使用专门词条：管理面时间线（Audit）与子系统事实时间线（Activity facts）。
const activitySourceLabels: Record<ActivitySource, TranslationKey> = {
  audit: 'activity.sources.audit',
  facts: 'activity.sources.facts',
};

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

// deepLink 由 Runtime 契约返回，可能仍是旧信息架构路径；经纯函数 route-map 映射到新导航
// （spec 0001 §15），未命中映射的站内路径原样保留，站外或非绝对路径不重写。
function canonicalDeepLink(deepLink: string): string {
  if (!deepLink.startsWith('/') || deepLink.startsWith('//')) return deepLink;
  const queryIndex = deepLink.indexOf('?');
  const pathname = queryIndex >= 0 ? deepLink.slice(0, queryIndex) : deepLink;
  const search = queryIndex >= 0 ? deepLink.slice(queryIndex) : '';
  const mapped = mapLegacyPath(pathname, search);
  return mapped === null ? deepLink : `${mapped.pathname}${mapped.search}`;
}

// Spec 0001 §9.2：`活动记录` 是单一管理面审计时间线，不设置二级 Tab，
// 并且不把 API 请求日志、Webhook 投递或定时任务执行复制进来。
// Spec 0009 §3.2 的 Activity 事实时间线是已交付能力（且明确排除 Audit 与 Request Log），
// 因此两者共用一个页面：由 `?source=audit|facts` 这个筛选器（而不是 Tab）选择来源，
// `kind`、`collection` 等既有筛选参数在切换来源时原样保留（§15）。
export function ActivityWorkspacePage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const source: ActivitySource = searchParams.get('source') === 'facts' ? 'facts' : 'audit';

  // 来源选择是筛选器而不是页签（spec 0001 §3.2 规定活动记录没有二级 Tab），
  // 但状态同样进入 URL（§15）：用链接表达，可分享、可新开、可用浏览器前进/后退，
  // 切换时保留 `kind`、`collection` 等既有筛选参数。
  function sourceTarget(next: ActivitySource): string {
    const params = new URLSearchParams(searchParams);
    params.set('source', next);
    return `/activity?${params.toString()}`;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-h-12 min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-4" data-workspace-toolbar>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{t('activity.eyebrow')}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{t('activity.title')}</h1>
          <p className="mt-1.5 max-w-[680px] text-sm leading-relaxed text-muted-foreground">{source === 'facts' ? t('activity.description') : t('access.auditDescription')}</p>
        </div>
        <nav aria-label={t('activity.sourcesLabel')} className="flex flex-wrap items-center gap-1.5" data-activity-source>
          {activitySourceOrder.map((candidate) => <ButtonLink
            aria-current={source === candidate ? 'page' : undefined}
            key={candidate}
            size="small"
            to={sourceTarget(candidate)}
            variant={source === candidate ? 'primary' : 'secondary'}
          >{t(activitySourceLabels[candidate])}</ButtonLink>)}
        </nav>
      </header>

      {source === 'facts' ? <ActivityPage embedded /> : <AuditPage embedded />}
    </div>
  );
}

// embedded：作为 `活动记录`（source=facts）的内容渲染时不重复页面级标题（spec 0001 §3.2、§9.2），
// 独立渲染仍保留自己的页面标题。
export function ActivityPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
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

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('activity.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('activity.loadFailedDescription')} title={t('activity.loadFailed')}>
          <div className="mt-3">
            <Button onClick={() => setReloadKey((value) => value + 1)} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('activity.retry')}</Button>
          </div>
        </ErrorState>
        {error instanceof ApiClientError && <p className="m-0 text-sm text-danger" role="alert">{error.apiError.message}</p>}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!embedded && <header className="min-w-0">
        <div className="min-w-0">
          <p className="eyebrow">{t('activity.eyebrow')}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{t('activity.title')}</h1>
          <p className="mt-1.5 max-w-[680px] text-sm leading-relaxed text-muted-foreground">{t('activity.description')}</p>
        </div>
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ActivityIcon size={19} /></span>
      </header>}

      <Surface className="flex flex-wrap items-end gap-3" variant="section">
        <div className="w-full min-w-[190px] max-w-[220px]">
          <FormField htmlFor="activity-kind" label={t('activity.filter')}>
            <SelectField id="activity-kind" onValueChange={(selectedValue) => updateQuery('kind', selectedValue)} value={kind} options={[({ value: "", label: t('activity.filterAll') }), kinds.map((candidate) => ({ value: candidate, label: t(kindKey(candidate)) }))]} />
          </FormField>
        </div>
        <div className="w-full min-w-[220px] max-w-[280px]">
          <FormField htmlFor="activity-collection" label={t('api.filterByCollection')}>
            <SelectField id="activity-collection" onValueChange={(selectedValue) => updateQuery('collection', selectedValue)} value={collectionId} options={[({ value: "", label: t('api.allCollections') }), collections.map((collection) => ({ value: collection.id, label: collection.name }))]} />
          </FormField>
        </div>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-3" variant="section">
        {facts.length === 0
          ? <EmptyState description={t('activity.empty.description')} title={t('activity.empty.title')} />
          : (
            <ul className="m-0 flex list-none flex-col p-0">
              {facts.map((fact) => (
                <li
                  className={`flex min-w-0 flex-wrap items-start justify-between gap-3 border-b py-3${statusTone(fact.status) === 'unavailable' ? ' bg-danger-soft/30' : ''}`}
                  data-activity-kind={fact.kind}
                  key={fact.id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">{t(kindKey(fact.kind))}</h3>
                      {fact.title && <span className="truncate text-xs font-medium text-ink-secondary">{fact.title}</span>}
                    </div>
                    <p className="m-0 mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <code className="font-mono text-[13px]">{fact.resourceId}</code>
                      <span aria-hidden="true">·</span>
                      <small className="text-xs">{new Date(fact.occurredAt).toLocaleString()}</small>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusChip state={statusTone(fact.status)}>{t(('activity.statuses.' + fact.status) as TranslationKey, { status: fact.status })}</StatusChip>
                    <Link className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary hover:underline" to={canonicalDeepLink(fact.deepLink)}>{t('activity.open')}</Link>
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
