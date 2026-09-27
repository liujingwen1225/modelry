import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, FileClock, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { Button, EmptyState, ErrorState, LoadingState, PartialState, StatusChip, Surface } from '../components/ui';
import { getChange, listAllChanges, listAllCollections, type ChangeDetail, type ChangeListItem, type Collection, type PendingChange, type PendingOperation } from './client';
import './collections.css';

type ChangesView = 'all' | 'pending' | 'applied';

function isPending(item: ChangeListItem): item is PendingChange {
  return 'status' in item;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function changeError(error: unknown, translate: ReturnType<typeof useI18n>['t']) {
  if (!(error instanceof ApiClientError)) return { title: translate('changes.loadFailed'), message: error instanceof Error ? error.message : translate('changes.loadFailedHint') };
  return {
    title: error.apiError.message,
    message: [error.apiError.code, error.apiError.hint, `Request ID: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
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
  const { t } = useI18n();
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
    <div className="page-stack collection-page changes-page">
      <header className="page-heading collection-heading"><div><p className="eyebrow">{t('changes.eyebrow')}</p><h1>{t('changes.title')}</h1><p className="page-description">{t('changes.description')}</p></div></header>
      {collectionError && state === 'ready' && <PartialState className="changes-partial">{t('changes.partial')}</PartialState>}
      <Surface className="changes-toolbar" variant="standard">
        <label className="collection-search"><Search aria-hidden="true" size={16} /><span className="sr-only">{t('changes.search')}</span><input aria-label={t('changes.search')} onChange={(event) => updateQuery('q', event.target.value)} placeholder={t('changes.searchPlaceholder')} type="search" value={query} /></label>
        <nav aria-label={t('changes.filterLabel')} className="changes-filter-tabs">
          {(['all', 'pending', 'applied'] as const).map((filter) => <button aria-pressed={view === filter} key={filter} onClick={() => selectView(filter)} type="button">{filter === 'all' ? t('changes.filterAll') : filter === 'pending' ? t('changes.filterPending') : t('changes.filterApplied')}</button>)}
        </nav>
      </Surface>
      {state === 'loading' && <LoadingState label={t('changes.loading')} />}
      {state === 'error' && (() => { const copy = changeError(error, t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('changes.retry')}</Button></ErrorState>; })()}
      {state === 'ready' && visible.length === 0 && items.length === 0 && <EmptyState description={t('changes.emptyDescription')} title={t('changes.emptyTitle')}><Link className="text-link" to="/collections">{t('changes.browseCollections')} <ArrowRight aria-hidden="true" size={14} /></Link></EmptyState>}
      {state === 'ready' && visible.length === 0 && items.length > 0 && <EmptyState description={t('changes.noMatchDescription')} title={t('changes.noMatchTitle')} />}
      {state === 'ready' && visible.length > 0 && <div className={`changes-layout${selectedId ? ' changes-layout--selected' : ''}`}>
        <section aria-label={t('changes.listLabel')} className="changes-list">
          {visible.map((item) => {
            const pending = isPending(item);
            const collectionId = pending ? item.collectionId : item.collectionId;
            const label = collectionNames.get(collectionId ?? '') ?? t('changes.collection');
            const status = pending ? statusLabel(item.status, t) : t('changes.statuses.applied');
            const id = pending ? item.changeSetId : item.changeSetId;
            return <Link aria-current={selectedId === id ? 'page' : undefined} className="changes-list-item" key={`${pending ? 'pending' : 'applied'}-${id}`} onClick={(event) => { event.preventDefault(); updateQuery('changeSet', id); }} to={`/changes?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(view !== 'all' ? { view } : {}), changeSet: id }).toString()}`}>
              <span className={`changes-item-icon${pending && item.status === 'failed' ? ' changes-item-icon--failed' : ''}`}>{pending ? item.status === 'failed' ? <AlertTriangle aria-hidden="true" size={16} /> : <FileClock aria-hidden="true" size={16} /> : <Check aria-hidden="true" size={16} />}</span>
              <span className="changes-item-copy"><strong>{label}</strong><span>{summaryFor(item, t)}</span><small>{pending ? t(item.operations.length === 1 ? 'changes.pendingOne' : 'changes.pendingMany', { count: item.operations.length }) : new Date(item.appliedAt).toLocaleString()}</small></span>
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
  const { t } = useI18n();
  if (detailState === 'loading') return <aside aria-label={t('changes.detailLabel')} className="changes-detail"><LoadingState label={t('changes.loadingDetail')} /></aside>;
  if (detailState === 'error' || !detail) {
    const copy = changeError(detailError, t);
    return <aside aria-label={t('changes.detailLabel')} className="changes-detail"><ErrorState description={copy.message} title={copy.title}><Button onClick={onRetry} size="small">{t('changes.retry')}</Button></ErrorState></aside>;
  }
  const failed = detail.status === 'failed';
  const recovery = safeRecord(detail.recoveryState);
  return <aside aria-label={t('changes.detailLabel')} className="changes-detail">
    <div className="changes-detail__heading"><div><p className="eyebrow">{t('changes.detailEyebrow')}</p><h2>{collectionNames.get(detail.collectionId) ?? t('changes.collection')}</h2><span>{statusLabel(detail.status, t)}</span></div><StatusChip state={detail.status}>{statusLabel(detail.status, t)}</StatusChip></div>
    {failed && <div className="changes-detail__recovery" role="alert"><AlertTriangle aria-hidden="true" size={16} /><div><strong>{t('changes.recoveryNeeded')}</strong><span>{typeof recovery.summary === 'string' ? recovery.summary : t('changes.recoverySummary')}</span></div></div>}
    {detail.status === 'needsReview' && <div className="changes-detail__review" role="status"><ShieldAlert aria-hidden="true" size={15} /><span>{t('changes.reviewHint')}</span></div>}
    {detail.operations && detail.operations.length > 0 && <section className="changes-detail-section"><h3>{t('changes.pendingChanges')}</h3><ul>{detail.operations.map((operation) => <li key={operation.id}>{operationSummary(operation, t)}</li>)}</ul></section>}
    {detail.applyAttempts.length > 0 && <section className="changes-detail-section"><h3>{t('changes.applyAttempts')}</h3><ol className="changes-attempt-list">{detail.applyAttempts.map((rawAttempt, index) => {
      const attempt = safeRecord(rawAttempt);
      return <li key={String(attempt.id ?? index)}><div><strong>{typeof attempt.status === 'string' ? statusLabel(attempt.status, t) : t('changes.attempt')}</strong><time>{typeof attempt.startedAt === 'string' ? new Date(attempt.startedAt).toLocaleString() : ''}</time></div>{typeof attempt.errorCode === 'string' && <span className="changes-error-code">{attempt.errorCode}</span>}<details><summary>{t('changes.technicalDetails')}</summary><pre>{JSON.stringify(rawAttempt, null, 2)}</pre></details></li>;
    })}</ol></section>}
    {detail.appliedMigration && <section className="changes-detail-section"><h3>{t('changes.appliedModel')}</h3><div className="changes-applied-state"><Check aria-hidden="true" size={15} /><span>{t('changes.appliedAt', { date: new Date(detail.appliedMigration.appliedAt).toLocaleString() })}</span></div>{detail.appliedMigration.diff && <ul>{detail.appliedMigration.diff.map((diff, index) => <li key={index}>{String(diff.action ?? t('changes.changed'))} {String(diff.kind ?? t('changes.schema'))} {String(diff.name ?? '')}</li>)}</ul>}</section>}
    {detail.recoveryState && Array.isArray(recovery.actions) && recovery.actions.length > 0 && <section className="changes-detail-section"><h3>{t('changes.recommendedSteps')}</h3><ul>{recovery.actions.map((action, index) => <li key={index}>{String(action)}</li>)}</ul></section>}
    {(detail.status === 'ready' || detail.status === 'needsReview' || detail.status === 'failed') && <Link className="button button--primary changes-detail__action" to={`/collections/${encodeURIComponent(detail.collectionId)}/schema`}>{failed ? t('changes.continueRecovery') : t('changes.reviewInSchema')}<ArrowRight aria-hidden="true" size={14} /></Link>}
    {detail.appliedMigration && <details className="changes-technical"><summary>{t('changes.technicalDetails')}</summary><dl><div><dt>{t('changes.changeReference')}</dt><dd><code>{detail.changeSetId}</code></dd></div><div><dt>{t('changes.appliedModelRecord')}</dt><dd><code>{detail.appliedMigration.id}</code></dd></div><div><dt>{t('changes.applyAttempt')}</dt><dd><code>{detail.appliedMigration.applyAttemptId}</code></dd></div></dl></details>}
  </aside>;
}
