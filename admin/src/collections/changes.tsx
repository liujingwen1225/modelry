import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, FileClock, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { Button, ButtonLink, EmptyState, ErrorState, LoadingState, PartialState, StatusChip } from '../components/ui';
import { getChange, listAllChanges, listAllCollections, type ChangeDetail, type ChangeListItem, type Collection, type PendingChange, type PendingOperation } from './client';
import './collections.css';

type ChangesView = 'all' | 'pending' | 'applied';

function isPending(item: ChangeListItem): item is PendingChange {
  return 'status' in item;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const userCopyFields = new Set(['actions', 'description', 'hint', 'message', 'notice', 'reason', 'summary', 'title']);

function diagnosticDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(diagnosticDetails);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !userCopyFields.has(key.toLowerCase()) && !(key.toLowerCase() === 'error' && typeof entry === 'string'))
    .map(([key, entry]) => [key, diagnosticDetails(entry)]));
}

function changeError(
  error: unknown,
  translate: ReturnType<typeof useI18n>['t'],
  errorMessage: ReturnType<typeof useI18n>['errorMessage'],
) {
  if (!(error instanceof ApiClientError)) return { title: translate('changes.loadFailed'), message: translate('changes.loadFailedHint') };
  return {
    title: errorMessage(error.apiError.code) ?? translate('errors.requestFailed'),
    message: [translate('common.errorCode'), error.apiError.code, `${translate('common.requestId')}: ${error.apiError.requestId}`, translate('common.tryAgainWhenAvailable')].join(' · '),
  };
}

function operationSummary(operation: PendingOperation, translate: ReturnType<typeof useI18n>['t']) {
  const definition = safeRecord(operation.definition);
  const name = typeof definition.name === 'string' ? definition.name : operation.targetId ? translate('changes.savedItem') : translate('changes.schema');
  const subject = operation.kind === 'relation' ? translate('changes.relation') : operation.kind;
  const action = operation.action === 'add' ? translate('changes.added') : operation.action === 'update' ? translate('changes.updated') : translate('changes.removed');
  return `${action} ${subject} ${name}`;
}

function summaryFor(item: ChangeListItem, translate: ReturnType<typeof useI18n>['t']) {
  if (isPending(item)) {
    return item.operations.length === 1 ? operationSummary(item.operations[0]!, translate) : translate('changes.schemaChanges', { count: item.operations.length });
  }
  const count = item.diff?.length ?? 0;
  return translate(count === 1 ? 'changes.appliedSchemaChange' : 'changes.appliedSchemaChanges', { count });
}

function statusLabel(status: string, translate: ReturnType<typeof useI18n>['t']) {
  const labels: Record<string, TranslationKey> = {
    ready: 'changes.statuses.ready', needsReview: 'changes.statuses.needsReview', failed: 'changes.statuses.failed',
    applied: 'changes.statuses.applied', discarded: 'changes.statuses.discarded', inProgress: 'changes.statuses.inProgress',
    succeeded: 'changes.statuses.succeeded', recoveryRequired: 'changes.statuses.recoveryRequired', interrupted: 'changes.statuses.interrupted',
  };
  const key = labels[status];
  return key ? translate(key) : translate('changes.statuses.unavailable');
}

export function ChangesPage() {
  const { t, errorMessage } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<ChangeListItem[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [collectionError, setCollectionError] = useState(false);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailError, setDetailError] = useState<unknown>();

  const query = searchParams.get('q') ?? '';
  const rawView = searchParams.get('view');
  const view: ChangesView = rawView === 'pending' || rawView === 'applied' ? rawView : 'all';
  const selectedId = searchParams.get('changeSet') ?? '';
  const collectionNames = useMemo(() => new Map(collections.map((collection) => [collection.id, collection.name])), [collections]);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void Promise.allSettled([listAllChanges(controller.signal), listAllCollections(controller.signal)]).then(([changeResult, collectionResult]) => {
      if (controller.signal.aborted) return;
      if (changeResult.status === 'rejected') {
        setError(changeResult.reason);
        setState('error');
        return;
      }
      setItems(changeResult.value);
      setState('ready');
      setError(undefined);
      if (collectionResult.status === 'fulfilled') {
        setCollections(collectionResult.value);
        setCollectionError(false);
      } else {
        setCollections([]);
        setCollectionError(true);
      }
    });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailState('idle');
      setDetailError(undefined);
      return;
    }
    const controller = new AbortController();
    setDetailState('loading');
    void getChange(selectedId, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setDetail(value);
      setDetailError(undefined);
      setDetailState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setDetailError(reason);
      setDetail(null);
      setDetailState('error');
    });
    return () => controller.abort();
  }, [selectedId]);

  function updateQuery(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function selectView(nextView: ChangesView) {
    updateQuery('view', nextView === 'all' ? '' : nextView);
  }

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const pending = isPending(item);
      if (view === 'pending' && !pending) return false;
      if (view === 'applied' && pending) return false;
      const collectionId = pending ? item.collectionId : item.collectionId;
      const name = collectionNames.get(collectionId ?? '') ?? '';
      return !normalized || `${name} ${summaryFor(item, t)} ${pending ? statusLabel(item.status, t) : t('changes.statuses.applied')}`.toLocaleLowerCase().includes(normalized);
    });
  }, [collectionNames, items, query, t, view]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">{t('changes.eyebrow')}</p>
        <h1>{t('changes.title')}</h1>
        <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('changes.description')}</p>
      </header>
      {collectionError && state === 'ready' && <PartialState>{t('changes.partial')}</PartialState>}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
          <input
            aria-label={t('changes.search')}
            className="min-h-9 w-full rounded-lg border border-input bg-card py-2 pl-9 pr-3 text-xs text-foreground outline-none transition-[color,border-color] placeholder:text-muted-foreground hover:border-subtle-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            onChange={(event) => updateQuery('q', event.target.value)}
            placeholder={t('changes.searchPlaceholder')}
            type="search"
            value={query}
          />
        </div>
        <nav aria-label={t('changes.filterLabel')} className="flex overflow-hidden rounded-lg border border-input">
          {(['all', 'pending', 'applied'] as const).map((filter) => (
            <button
              aria-pressed={view === filter}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${view === filter ? 'bg-primary text-primary-foreground' : 'bg-card text-ink-secondary hover:bg-accent hover:text-accent-foreground'}`}
              key={filter}
              onClick={() => selectView(filter)}
              type="button"
            >{filter === 'all' ? t('changes.filterAll') : filter === 'pending' ? t('changes.filterPending') : t('changes.filterApplied')}</button>
          ))}
        </nav>
      </div>
      {state === 'loading' && <LoadingState label={t('changes.loading')} />}
      {state === 'error' && (() => { const copy = changeError(error, t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('changes.retry')}</Button></div></ErrorState>; })()}
      {state === 'ready' && visible.length === 0 && items.length === 0 && <EmptyState description={t('changes.emptyDescription')} title={t('changes.emptyTitle')}><Link className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/collections">{t('changes.browseCollections')} <ArrowRight aria-hidden="true" size={14} /></Link></EmptyState>}
      {state === 'ready' && visible.length === 0 && items.length > 0 && <EmptyState description={t('changes.noMatchDescription')} title={t('changes.noMatchTitle')} />}
      {state === 'ready' && visible.length > 0 && <div className={`grid min-w-0 items-start gap-5 ${selectedId ? 'lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]' : ''}`}>
        <section aria-label={t('changes.listLabel')} className="flex min-w-0 flex-col gap-2">
          {visible.map((item) => {
            const pending = isPending(item);
            const collectionId = pending ? item.collectionId : item.collectionId;
            const label = collectionNames.get(collectionId ?? '') ?? t('changes.collection');
            const status = pending ? statusLabel(item.status, t) : t('changes.statuses.applied');
            const id = pending ? item.changeSetId : item.changeSetId;
            const failed = pending && item.status === 'failed';
            return <Link
              aria-current={selectedId === id ? 'page' : undefined}
              className={`flex min-w-0 items-start gap-3 rounded-lg border bg-card p-3.5 transition-colors hover:border-subtle-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${selectedId === id ? 'border-primary' : 'border-input'}`}
              key={`${pending ? 'pending' : 'applied'}-${id}`}
              onClick={(event) => { event.preventDefault(); updateQuery('changeSet', id); }}
              to={`/changes?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(view !== 'all' ? { view } : {}), changeSet: id }).toString()}`}
            >
              <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-md ${failed ? 'bg-danger-soft text-danger' : 'bg-muted text-ink-secondary'}`}>{pending ? failed ? <AlertTriangle size={16} /> : <FileClock size={16} /> : <Check size={16} />}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-xs font-semibold text-foreground">{label}</strong>
                <span className="truncate text-[11px] text-ink-secondary">{summaryFor(item, t)}</span>
                <small className="text-[10px] text-muted-foreground">{pending ? t(item.operations.length === 1 ? 'changes.pendingOne' : 'changes.pendingMany', { count: item.operations.length }) : new Date(item.appliedAt).toLocaleString()}</small>
              </span>
              <StatusChip state={pending ? item.status : 'applied'}>{status}</StatusChip>
            </Link>;
          })}
        </section>
        {selectedId && <ChangeDetailPanel detail={detail} detailError={detailError} detailState={detailState} onRetry={() => { setDetailError(undefined); setDetailState('loading'); void getChange(selectedId).then((value) => { setDetail(value); setDetailState('ready'); }).catch((reason: unknown) => { setDetailError(reason); setDetailState('error'); }); }} collectionNames={collectionNames} />}
      </div>}
    </div>
  );
}

function ChangeDetailPanel({
  detail, detailError, detailState, onRetry, collectionNames,
}: {
  detail: ChangeDetail | null;
  detailError: unknown;
  detailState: 'idle' | 'loading' | 'ready' | 'error';
  onRetry: () => void;
  collectionNames: Map<string, string>;
}) {
  const { t, errorMessage } = useI18n();
  if (detailState === 'loading') return <aside aria-label={t('changes.detailLabel')} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"><LoadingState label={t('changes.loadingDetail')} /></aside>;
  if (detailState === 'error' || !detail) {
    const copy = changeError(detailError, t, errorMessage);
    return <aside aria-label={t('changes.detailLabel')} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"><ErrorState description={copy.message} title={copy.title}><div className="mt-3"><Button onClick={onRetry} size="small">{t('changes.retry')}</Button></div></ErrorState></aside>;
  }
  const failed = detail.status === 'failed';
  const recovery = safeRecord(detail.recoveryState);
  const recoveryActions = recovery.state === 'retryable'
    ? [t('changes.recoveryActions.reviewCurrentModel'), t('changes.recoveryActions.retryApply')]
    : [t('changes.recoveryActions.openDetails')];
  return <aside aria-label={t('changes.detailLabel')} className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="eyebrow">{t('changes.detailEyebrow')}</p>
        <h2 className="truncate">{collectionNames.get(detail.collectionId) ?? t('changes.collection')}</h2>
        <span className="text-[11px] text-muted-foreground">{statusLabel(detail.status, t)}</span>
      </div>
      <StatusChip state={detail.status}>{statusLabel(detail.status, t)}</StatusChip>
    </div>
    {failed && <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs text-danger" role="alert"><AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={16} /><div className="min-w-0"><strong className="block">{t('changes.recoveryNeeded')}</strong><span className="opacity-90">{t('changes.recoverySummary')}</span></div></div>}
    {detail.status === 'needsReview' && <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-warning" role="status"><ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={15} /><span>{t('changes.reviewHint')}</span></div>}
    {detail.operations && detail.operations.length > 0 && <section className="flex flex-col gap-1.5"><h3>{t('changes.pendingChanges')}</h3><ul className="m-0 flex list-none flex-col gap-1 p-0">{detail.operations.map((operation) => <li className="rounded-md border bg-secondary px-3 py-2 text-xs text-ink-secondary" key={operation.id}>{operationSummary(operation, t)}</li>)}</ul></section>}
    {detail.applyAttempts.length > 0 && <section className="flex flex-col gap-1.5"><h3>{t('changes.applyAttempts')}</h3><ol className="m-0 flex list-none flex-col gap-2 p-0">{detail.applyAttempts.map((rawAttempt, index) => {
      const attempt = safeRecord(rawAttempt);
      return <li className="flex flex-col gap-1 rounded-md border bg-secondary px-3 py-2" key={String(attempt.id ?? index)}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><strong className="font-semibold text-foreground">{typeof attempt.status === 'string' ? statusLabel(attempt.status, t) : t('changes.attempt')}</strong><time className="text-[10px] text-muted-foreground">{typeof attempt.startedAt === 'string' ? new Date(attempt.startedAt).toLocaleString() : ''}</time></div>
        {typeof attempt.errorCode === 'string' && <span className="w-fit rounded border border-danger/30 bg-danger-soft px-1.5 py-0.5 font-mono text-[10px] text-danger">{attempt.errorCode}</span>}
        <details className="text-[11px] text-muted-foreground [&_pre]:mt-1.5 [&_pre]:max-h-52 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-card [&_pre]:p-2 [&_pre]:text-[10px] [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary:hover]:text-foreground"><summary>{t('changes.technicalDetails')}</summary><pre>{JSON.stringify(diagnosticDetails(rawAttempt), null, 2)}</pre></details>
      </li>;
    })}</ol></section>}
    {detail.appliedMigration && <section className="flex flex-col gap-1.5"><h3>{t('changes.appliedModel')}</h3><div className="flex items-center gap-2 rounded-md border bg-secondary px-3 py-2 text-xs text-ink-secondary"><Check aria-hidden="true" className="shrink-0 text-success" size={15} /><span>{t('changes.appliedAt', { date: new Date(detail.appliedMigration.appliedAt).toLocaleString() })}</span></div>{detail.appliedMigration.diff && <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink-secondary">{detail.appliedMigration.diff.map((diff, index) => <li key={index}>{String(diff.action ?? t('changes.changed'))} {String(diff.kind ?? t('changes.schema'))} {String(diff.name ?? '')}</li>)}</ul>}</section>}
    {detail.recoveryState && <section className="flex flex-col gap-1.5"><h3>{t('changes.recommendedSteps')}</h3><ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink-secondary">{recoveryActions.map((action, index) => <li key={index}>{action}</li>)}</ul></section>}
    {(detail.status === 'ready' || detail.status === 'needsReview' || detail.status === 'failed') && <div><ButtonLink to={`/collections/${encodeURIComponent(detail.collectionId)}/model`} variant="primary">{failed ? t('changes.continueRecovery') : t('changes.reviewInSchema')}<ArrowRight aria-hidden="true" size={14} /></ButtonLink></div>}
    {detail.appliedMigration && <details className="border-t pt-3 text-[11px] text-muted-foreground [&_dl]:mt-2 [&_dl]:grid [&_dl]:gap-1 [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary:hover]:text-foreground"><summary>{t('changes.technicalDetails')}</summary><dl><div className="flex gap-2"><dt className="font-semibold">{t('changes.changeReference')}</dt><dd className="m-0"><code>{detail.changeSetId}</code></dd></div><div className="flex gap-2"><dt className="font-semibold">{t('changes.appliedModelRecord')}</dt><dd className="m-0"><code>{detail.appliedMigration.id}</code></dd></div><div className="flex gap-2"><dt className="font-semibold">{t('changes.applyAttempt')}</dt><dd className="m-0"><code>{detail.appliedMigration.applyAttemptId}</code></dd></div></dl></details>}
  </aside>;
}
