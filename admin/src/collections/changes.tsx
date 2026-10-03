import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { SearchInput } from '@/components/ui/search-input';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, FileClock, LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { Button, ButtonLink } from '../components/button';
import { EmptyState, ErrorState, LoadingState, PartialState, StatusChip } from '../components/states';
import { diffLabel, preconditionMessage, preconditionStatus } from './preview-copy';
import { applySchemaChange, discardSchemaChange, getChange, listAllChanges, listAllCollections, previewSchemaChange, type ChangeDetail, type ChangeListItem, type Collection, type PendingChange, type PendingOperation, type SchemaPreview } from './client';

// Spec 0001 §3.2：`变更` 的二级工作面固定为「待应用 / 已应用历史 / 结构漂移」，
// 本组件承担前两个工作面；选择存放在 URL 的 `?tab=`，未知值回落到默认的待应用。
// Spec 0001 §15：可分享的页签必须进入 URL，因此 `q` 与 `changeSet` 等参数原样保留。
type ChangesTab = 'pending' | 'history';

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

// embedded：作为 `/changes` 工作区的内容渲染时不重复页面级标题（spec 0001 §3.2、§17.3），
// 独立渲染（组件测试、深链接落地前）仍保留自己的页面标题。
export function ChangesPage({ embedded = false }: { embedded?: boolean }) {
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
  const tab: ChangesTab = searchParams.get('tab') === 'history' ? 'history' : 'pending';
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

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const pending = isPending(item);
      // 页签决定工作面：待应用只列出待应用变化，已应用历史只列出已应用事实。
      if (tab === 'history' ? pending : !pending) return false;
      const name = collectionNames.get(item.collectionId ?? '') ?? '';
      return !normalized || `${name} ${summaryFor(item, t)} ${pending ? statusLabel(item.status, t) : t('changes.statuses.applied')}`.toLocaleLowerCase().includes(normalized);
    });
  }, [collectionNames, items, query, t, tab]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!embedded && <header className="min-w-0">
        <p className="eyebrow">{t('changes.eyebrow')}</p>
        <h1 className="text-2xl font-semibold">{t('changes.title')}</h1>
        <p className="mt-1.5 max-w-[680px] text-sm leading-relaxed text-muted-foreground">{t('changes.description')}</p>
      </header>}
      {collectionError && state === 'ready' && <PartialState>{t('changes.partial')}</PartialState>}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput aria-label={t('changes.search')} onChange={(event) => updateQuery('q', event.target.value)} placeholder={t('changes.searchPlaceholder')} value={query} className="min-w-[220px] flex-1 md:max-w-sm" />
      </div>
      {state === 'loading' && <LoadingState label={t('changes.loading')} />}
      {state === 'error' && (() => { const copy = changeError(error, t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('changes.retry')}</Button></div></ErrorState>; })()}
      {state === 'ready' && visible.length === 0 && !selectedId && items.length === 0 && <EmptyState description={t('changes.emptyDescription')} title={t('changes.emptyTitle')}><Link className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/collections">{t('changes.browseCollections')} <ArrowRight aria-hidden="true" size={14} /></Link></EmptyState>}
      {state === 'ready' && visible.length === 0 && !selectedId && items.length > 0 && <EmptyState description={t('changes.noMatchDescription')} title={t('changes.noMatchTitle')} />}
      {/* 选中的变更即使不在当前工作面的列表里也保持可见：`changeSet` 深链接（§15）必须继续打开同一对象。 */}
      {state === 'ready' && (visible.length > 0 || selectedId) && <div className={`grid min-w-0 items-start gap-5 ${selectedId ? 'lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]' : ''}`}>
        <section aria-label={t('changes.listLabel')} className="flex min-w-0 flex-col gap-2">
          {visible.map((item) => {
            const pending = isPending(item);
            const label = collectionNames.get(item.collectionId ?? '') ?? t('changes.collection');
            const status = pending ? statusLabel(item.status, t) : t('changes.statuses.applied');
            const id = item.changeSetId;
            const failed = pending && item.status === 'failed';
            return <Link
              aria-current={selectedId === id ? 'page' : undefined}
              className={`flex min-w-0 items-start gap-3 border-b px-1 py-4 transition-colors  ${selectedId === id ? 'bg-muted' : 'hover:bg-muted/50'}`}
              key={`${pending ? 'pending' : 'applied'}-${id}`}
              onClick={(event) => { event.preventDefault(); updateQuery('changeSet', id); }}
              to={`/changes?${new URLSearchParams({ ...(query ? { q: query } : {}), tab, changeSet: id }).toString()}`}
            >
              <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-md ${failed ? 'bg-danger-soft text-danger' : 'bg-muted text-ink-secondary'}`}>{pending ? failed ? <AlertTriangle size={16} /> : <FileClock size={16} /> : <Check size={16} />}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-sm font-semibold text-foreground">{label}</strong>
                <span className="truncate text-xs text-ink-secondary">{summaryFor(item, t)}</span>
                <small className="text-xs text-muted-foreground">{pending ? t(item.operations.length === 1 ? 'changes.pendingOne' : 'changes.pendingMany', { count: item.operations.length }) : new Date(item.appliedAt).toLocaleString()}</small>
              </span>
              <StatusChip state={pending ? item.status : 'applied'}>{status}</StatusChip>
            </Link>;
          })}
          {visible.length === 0 && <EmptyState description={t('changes.noMatchDescription')} title={t('changes.noMatchTitle')} />}
        </section>
        {selectedId && <ChangeDetailPanel detail={detail} detailError={detailError} detailState={detailState} onChanged={() => setReloadKey((value) => value + 1)} onRetry={() => { setDetailError(undefined); setDetailState('loading'); void getChange(selectedId).then((value) => { setDetail(value); setDetailState('ready'); }).catch((reason: unknown) => { setDetailError(reason); setDetailState('error'); }); }} collectionNames={collectionNames} />}
      </div>}
    </div>
  );
}

function ChangeDetailPanel({
  detail, detailError, detailState, onRetry, onChanged, collectionNames,
}: {
  detail: ChangeDetail | null;
  detailError: unknown;
  detailState: 'idle' | 'loading' | 'ready' | 'error';
  onRetry: () => void;
  onChanged: () => void;
  collectionNames: Map<string, string>;
}) {
  const { t, errorMessage, formatNumber } = useI18n();
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState<TranslationKey | ''>('');
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  if (detailState === 'loading') return <aside aria-label={t('changes.detailLabel')} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"><LoadingState label={t('changes.loadingDetail')} /></aside>;
  if (detailState === 'error' || !detail) {
    const copy = changeError(detailError, t, errorMessage);
    return <aside aria-label={t('changes.detailLabel')} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"><ErrorState description={copy.message} title={copy.title}><div className="mt-3"><Button onClick={onRetry} size="small">{t('changes.retry')}</Button></div></ErrorState></aside>;
  }

  const failed = detail.status === 'failed';
  const pending = detail.status === 'ready' || detail.status === 'needsReview' || detail.status === 'failed';
  const operations = detail.operations ?? [];
  const recovery = safeRecord(detail.recoveryState);
  const recoveryActions = recovery.state === 'retryable'
    ? [t('changes.recoveryActions.reviewCurrentModel'), t('changes.recoveryActions.retryApply')]
    : [t('changes.recoveryActions.openDetails')];

  // Spec 0001 §10.2：Runtime 是风险的权威判定者。SAFE 变化直接应用，
  // 需要复核的变化在页面内说明影响后再确认；重复提交在应用期间被锁定。
  async function review() {
    setWorking(true);
    setActionError(undefined);
    setNotice('');
    try {
      const result = await previewSchemaChange(detail!.collectionId, detail!.version);
      setPreview(result);
      if (result.risk === 'safe') {
        await apply(result.version ?? detail!.version, { safe: true });
      }
    } catch (error) { setActionError(error); }
    finally { setWorking(false); }
  }

  async function apply(version: number, options: { safe: boolean; current?: SchemaPreview }) {
    setWorking(true);
    setActionError(undefined);
    try {
      const result = await applySchemaChange(detail!.collectionId, version, !options.safe);
      setConfirmApply(false);
      setPreview(null);
      if (result.state === 'recoveryRequired') {
        setNotice('changes.recoveryRequired');
        onRetry();
      } else {
        setNotice('changes.appliedResult');
      }
      onChanged();
    } catch (error) {
      setActionError(error);
      onRetry();
    }
    finally { setWorking(false); }
  }

  async function discard() {
    setWorking(true);
    setActionError(undefined);
    setNotice('');
    try {
      await discardSchemaChange(detail!.collectionId, detail!.version);
      setConfirmDiscard(false);
      setPreview(null);
      setNotice('changes.statuses.discarded');
      onChanged();
      onRetry();
    } catch (error) { setActionError(error); }
    finally { setWorking(false); }
  }

  const uniqueConflict = preview?.risk === 'blocked'
    && preview.preconditions.some((item) => item.code === 'UNIQUE_VALUES_CONFLICT' && item.status === 'failed');

  return <aside aria-label={t('changes.detailLabel')} className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="eyebrow">{t('changes.detailEyebrow')}</p>
        <h2 className="truncate text-base font-semibold">{collectionNames.get(detail.collectionId) ?? t('changes.collection')}</h2>
        <span className="text-xs text-muted-foreground">{statusLabel(detail.status, t)}</span>
      </div>
      <StatusChip state={detail.status}>{statusLabel(detail.status, t)}</StatusChip>
    </div>

    {notice && <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3 py-2.5 text-xs text-ink-secondary" role="status"><Check aria-hidden="true" className="shrink-0 text-success" size={15} />{t(notice)}</div>}
    {actionError !== undefined && (() => { const copy = changeError(actionError, t, errorMessage); return <ErrorState description={copy.message} title={copy.title} />; })()}
    {failed && <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs text-danger" role="alert"><AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={16} /><div className="min-w-0"><strong className="block">{t('changes.recoveryNeeded')}</strong><span className="opacity-90">{t('changes.recoverySummary')}</span></div></div>}
    {detail.status === 'needsReview' && <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-warning" role="status"><ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={15} /><span>{t('changes.reviewHint')}</span></div>}
    {operations.length > 0 && <section className="flex flex-col gap-1.5"><h3>{t('changes.pendingChanges')}</h3><ul className="m-0 flex list-none flex-col gap-1 p-0">{operations.map((operation) => <li className="border-b py-3 text-sm text-ink-secondary" key={operation.id}>{operationSummary(operation, t)}</li>)}</ul></section>}

    {pending && operations.length > 0 && (
      <section aria-label={t('changes.reviewTitle')} className="flex min-w-0 flex-col gap-3 border-t pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0">{t('changes.reviewTitle')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('changes.reviewDescription', { name: collectionNames.get(detail.collectionId) ?? t('changes.collection') })}</p>
          </div>
          <Button disabled={working} onClick={() => void review()} size="small" type="button" variant="primary">
            {working ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={14} />{t('schema.working')}</> : t('changes.reviewChanges')}
          </Button>
        </div>

        {preview && (
          <div className={`flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3.5 ${preview.risk === 'blocked' ? 'border-danger/40' : 'border-warning/40'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary">{preview.risk === 'blocked' ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />}</span>
                <div className="min-w-0">
                  <h4 className="m-0 text-xs font-semibold text-foreground">
                    {preview.risk === 'blocked'
                      ? uniqueConflict ? t('schema.previewBlockedUniqueTitle') : t('schema.previewBlockedTitle')
                      : t('schema.previewReviewTitle')}
                  </h4>
                  <p className="mt-1 text-xs text-ink-secondary">
                    {uniqueConflict ? t('schema.previewBlockedUniqueBody') : preview.risk === 'blocked' ? t('schema.previewBlockedBody') : t('schema.previewReviewBody')}
                  </p>
                </div>
              </div>
              <StatusChip state={preview.risk === 'blocked' ? 'blocked' : 'pending'}>{preview.risk === 'review' ? t('schema.riskReview') : t('schema.riskBlocked')}</StatusChip>
            </div>

            {preview.diff.length > 0 && <div className="flex flex-col gap-1.5">
              <h5 className="m-0 text-xs font-semibold text-foreground">{t('schema.whatWillChange')}</h5>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {preview.diff.map((change, index) => (
                  <li className="flex items-center gap-2 border-b py-3 text-[13px]" key={index}>
                    <span aria-hidden="true" className="font-mono font-bold text-ink-secondary">{change.action === 'remove' ? '−' : change.action === 'update' ? '~' : '+'}</span>
                    <span className="min-w-0 truncate text-ink-secondary">{diffLabel(change, t)}</span>
                    <code className="ml-auto text-xs text-muted-foreground">{String(change.kind ?? '')}</code>
                  </li>
                ))}
              </ul>
            </div>}

            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-secondary px-3 py-2 text-xs">
              <strong className="font-semibold text-foreground">{t('schema.impact')}</strong>
              <span className="text-ink-secondary">{typeof preview.impact.summary === 'string' ? preview.impact.summary : t('schema.impactFallback')}</span>
              {typeof preview.impact.affectedRecords === 'number' && <span className="text-muted-foreground">{t('schema.recordsAffected', { count: formatNumber(preview.impact.affectedRecords) })}</span>}
            </div>

            {preview.preconditions.length > 0 && <div className="flex flex-col gap-1.5">
              <h5 className="m-0 text-xs font-semibold text-foreground">{t('schema.checks')}</h5>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {preview.preconditions.map((condition, index) => (
                  <li className="flex flex-wrap items-center gap-2 rounded-md border bg-secondary px-3 py-2 text-xs" key={index}>
                    <span className="min-w-0 text-ink-secondary">{preconditionMessage(condition.code, t)}</span>
                    <span className="ml-auto"><StatusChip state={String(condition.status ?? 'unknown')}>{preconditionStatus(condition.status, t)}</StatusChip></span>
                  </li>
                ))}
              </ul>
            </div>}

            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={working} onClick={() => setPreview(null)} size="small" type="button" variant="quiet">{t('common.cancel')}</Button>
              {uniqueConflict && <Button disabled={working} onClick={() => void apply(preview.version ?? detail.version, { safe: false })} size="small" type="button" variant="primary">{working ? t('schema.applying') : t('schema.attemptApply')}<ArrowRight aria-hidden="true" size={14} /></Button>}
              {preview.risk === 'review' && <Button disabled={working} onClick={() => void apply(preview.version ?? detail.version, { safe: false })} size="small" type="button" variant="primary">{working ? t('schema.applying') : t('schema.confirmAndApply')}<ArrowRight aria-hidden="true" size={14} /></Button>}
            </div>
          </div>
        )}

        {!preview && !confirmApply && !confirmDiscard && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={working} onClick={() => setConfirmDiscard(true)} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} />{t('schema.discard')}</Button>
          </div>
        )}

        {confirmApply && (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-xs text-warning" role="alert">
            <strong>{t('changes.confirmApplyTitle')}</strong>
            <span className="opacity-90">{t('changes.confirmApplyBody')}</span>
            <div className="flex justify-end gap-2">
              <Button disabled={working} onClick={() => setConfirmApply(false)} size="small" type="button">{t('common.cancel')}</Button>
              <Button disabled={working} onClick={() => void apply(preview?.version ?? detail.version, { safe: false })} size="small" type="button" variant="primary">{working ? t('schema.applying') : t('schema.confirmAndApply')}</Button>
            </div>
          </div>
        )}

        {confirmDiscard && (
          <div className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs text-danger" role="alert">
            <strong>{t('changes.discardConfirmTitle')}</strong>
            <span className="opacity-90">{t('changes.discardConfirmBody', { count: operations.length })}</span>
            <div className="flex justify-end gap-2">
              <Button disabled={working} onClick={() => setConfirmDiscard(false)} size="small" type="button">{t('common.cancel')}</Button>
              <Button disabled={working} onClick={() => void discard()} size="small" type="button" variant="danger">{working ? t('schema.working') : t('changes.discardPending')}</Button>
            </div>
          </div>
        )}
      </section>
    )}

    {detail.applyAttempts.length > 0 && <section className="flex flex-col gap-1.5"><h3>{t('changes.applyAttempts')}</h3><ol className="m-0 flex list-none flex-col gap-2 p-0">{detail.applyAttempts.map((rawAttempt, index) => {
      const attempt = safeRecord(rawAttempt);
      return <li className="flex flex-col gap-1 rounded-md border bg-secondary px-3 py-2" key={String(attempt.id ?? index)}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><strong className="font-semibold text-foreground">{typeof attempt.status === 'string' ? statusLabel(attempt.status, t) : t('changes.attempt')}</strong><time className="text-xs text-muted-foreground">{typeof attempt.startedAt === 'string' ? new Date(attempt.startedAt).toLocaleString() : ''}</time></div>
        {typeof attempt.errorCode === 'string' && <span className="w-fit rounded border border-danger/30 bg-danger-soft px-1.5 py-0.5 font-mono text-[13px] text-danger">{attempt.errorCode}</span>}
        <Collapsible data-slot="collapsible" className="text-xs text-muted-foreground [&_pre]:mt-1.5 [&_pre]:max-h-52 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-card [&_pre]:p-2 [&_pre]:text-[13px] [&_[data-slot=collapsible-trigger]]:w-fit [&_[data-slot=collapsible-trigger]]:cursor-pointer [&_[data-slot=collapsible-trigger]]:font-semibold [&_[data-slot=collapsible-trigger]:hover]:text-foreground"><CollapsibleTrigger>{t('changes.technicalDetails')}</CollapsibleTrigger><CollapsibleContent><pre>{JSON.stringify(diagnosticDetails(rawAttempt), null, 2)}</pre></CollapsibleContent></Collapsible>
      </li>;
    })}</ol></section>}
    {detail.appliedMigration && <section className="flex flex-col gap-1.5"><h3>{t('changes.appliedModel')}</h3><div className="flex items-center gap-2 border-b py-3 text-sm text-ink-secondary"><Check aria-hidden="true" className="shrink-0 text-success" size={15} /><span>{t('changes.appliedAt', { date: new Date(detail.appliedMigration.appliedAt).toLocaleString() })}</span></div>{detail.appliedMigration.diff && <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink-secondary">{detail.appliedMigration.diff.map((diff, index) => <li key={index}>{String(diff.action ?? t('changes.changed'))} {String(diff.kind ?? t('changes.schema'))} {String(diff.name ?? '')}</li>)}</ul>}</section>}
    {detail.recoveryState && <section className="flex flex-col gap-1.5"><h3>{t('changes.recommendedSteps')}</h3><ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink-secondary">{recoveryActions.map((action, index) => <li key={index}>{action}</li>)}</ul></section>}
    <div className="flex flex-wrap gap-2"><ButtonLink size="small" to={`/collections/${encodeURIComponent(detail.collectionId)}/model`}>{failed ? t('changes.continueRecovery') : t('changes.reviewInSchema')}<ArrowRight aria-hidden="true" size={14} /></ButtonLink></div>
    {detail.appliedMigration && <Collapsible data-slot="collapsible" className="border-t pt-3 text-xs text-muted-foreground [&_dl]:mt-2 [&_dl]:grid [&_dl]:gap-1 [&_[data-slot=collapsible-trigger]]:w-fit [&_[data-slot=collapsible-trigger]]:cursor-pointer [&_[data-slot=collapsible-trigger]]:font-semibold [&_[data-slot=collapsible-trigger]:hover]:text-foreground"><CollapsibleTrigger>{t('changes.technicalDetails')}</CollapsibleTrigger><CollapsibleContent><dl><div className="flex gap-2"><dt className="font-semibold">{t('changes.changeReference')}</dt><dd className="m-0"><code>{detail.changeSetId}</code></dd></div><div className="flex gap-2"><dt className="font-semibold">{t('changes.appliedModelRecord')}</dt><dd className="m-0"><code>{detail.appliedMigration.id}</code></dd></div><div className="flex gap-2"><dt className="font-semibold">{t('changes.applyAttempt')}</dt><dd className="m-0"><code>{detail.appliedMigration.applyAttemptId}</code></dd></div></dl></CollapsibleContent></Collapsible>}
  </aside>;
}
