import { useEffect, useState } from 'react';
import { ArrowRight, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Button, ButtonLink } from '../components/button';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n } from '../i18n/i18n';
import { listAllCollections, type CollectionSummary } from '../collections/client';

type LoadState = 'loading' | 'ready' | 'error';

// Spec 0001 §11.1：应用认证属于每个 Auth Collection，项目级页面只做汇总与跳转，
// 因此这里只读取一次 Collection 列表并在本地筛选 Auth 类型，
// 不发起逐 Collection 的认证配置请求（避免 N+1），也不展示未支持的 OAuth Provider。
// 未知记录数写成 Unavailable，不用 0 代替未知（§14）。
function recordCountLabel(count: number | undefined, translate: ReturnType<typeof useI18n>['t'], formatNumber: ReturnType<typeof useI18n>['formatNumber']) {
  if (typeof count !== 'number') return translate('common.unavailable');
  return translate(count === 1 ? 'collections.count.recordOne' : 'collections.count.recordMany', { count: formatNumber(count) });
}

export function ApplicationAuthPanel() {
  const { t, errorMessage, formatNumber } = useI18n();
  const [state, setState] = useState<LoadState>('loading');
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listAllCollections(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setCollections(value.filter((collection) => collection.type === 'Auth'));
      setState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setState('error');
    });
    return () => controller.abort();
  }, [reload]);

  const copy = error instanceof ApiClientError
    ? {
      title: errorMessage(error.apiError.code) ?? t('access.authLoadFailed'),
      detail: [t('common.errorCode'), error.apiError.code, `${t('common.requestId')}: ${error.apiError.requestId}`, t('common.tryAgainWhenAvailable')].join(' · '),
    }
    : { title: t('access.authLoadFailed'), detail: t('common.tryAgainWhenAvailable') };

  return <section aria-label={t('access.authTitle')} className="flex min-w-0 flex-col gap-4">
    <div className="min-w-0">
      <h2 className="text-base font-semibold">{t('access.authTitle')}</h2>
      <p className="mt-1.5 max-w-[680px] text-sm leading-relaxed text-muted-foreground">{t('access.authDescription')}</p>
    </div>

    {state === 'loading' && <LoadingState label={t('access.authLoading')} />}
    {state === 'error' && <ErrorState description={copy.detail} title={copy.title}><div className="mt-3"><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div></ErrorState>}

    {state === 'ready' && collections.length === 0 && <EmptyState description={t('access.authEmptyDescription')} title={t('access.authEmptyTitle')}>
      <ButtonLink className="mt-2" size="small" to="/collections/new" variant="primary"><Plus aria-hidden="true" size={15} /> {t('access.authCreateCollection')}</ButtonLink>
    </EmptyState>}

    {state === 'ready' && collections.length > 0 && <Surface className="flex min-w-0 flex-col gap-3" variant="section">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ShieldCheck size={16} /></span>
        <p className="m-0 min-w-0 flex-1 text-sm text-muted-foreground">{t('access.authCollectionCount', { count: formatNumber(collections.length) })}</p>
        <ButtonLink size="small" to="/collections/new" variant="secondary"><Plus aria-hidden="true" size={14} /> {t('access.authCreateCollection')}</ButtonLink>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {collections.map((collection) => <li className="flex min-w-0 flex-wrap items-center gap-3 border-b py-3" key={collection.id}>
          <div className="min-w-0 flex-1">
            <strong className="block break-words text-sm font-semibold text-foreground">{collection.name}</strong>
            <span className="text-xs text-muted-foreground">{recordCountLabel(collection.recordCount, t, formatNumber)}</span>
          </div>
          <Link className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-primary hover:underline" to={`/collections/${encodeURIComponent(collection.id)}/access?panel=authentication`}>{t('access.authOpenCollection')} <ArrowRight aria-hidden="true" size={14} /></Link>
        </li>)}
      </ul>
    </Surface>}
  </section>;
}
