import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Filter, RefreshCw, Search, X } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { Button, ButtonLink, CopyButton, EmptyState, ErrorState, LoadingState, StatusChip, Surface } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from './client';
import { getRequestRecord, listRequestRecords, type RequestRecord } from './workspace-client';
import { endpointsForCollection } from './endpoints';
import { mapLegacyPath } from '../route-map';
import { listAllCollections, type Collection } from '../collections/client';

// Spec 0001 §9.1：Requests 是应用 HTTP 请求日志。
// 详情只展示显式 allowlist 字段：requestId、时间、method、path、status、耗时、
// 错误码、Collection、认证结果、授权结果、User-Agent 摘要。
// Raw credential / Authorization header / 完整请求体与响应体一律不展示。

const filterFields = [
  'requestId', 'time', 'collectionId', 'endpoint', 'method', 'status',
  'durationMs', 'authenticationOutcome', 'authorizationOutcome', 'errorCode',
] as const;
type FilterField = typeof filterFields[number];

const operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
type Operator = typeof operators[number];

const authenticationOutcomes = ['authenticated', 'anonymous', 'rejected', 'unknown'] as const;
const authorizationOutcomes = ['allowed', 'denied', 'notEvaluated', 'notApplicable', 'error', 'unknown'] as const;
const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

type FilterDraft = { field: FilterField; operator: Operator; value: string };

function parseFilter(raw: string): FilterDraft | null {
  const first = raw.indexOf(' ');
  if (first < 1) return null;
  const second = raw.indexOf(' ', first + 1);
  if (second < 0) return null;
  const field = raw.slice(0, first);
  const operator = raw.slice(first + 1, second);
  if (!(filterFields as readonly string[]).includes(field)) return null;
  if (!(operators as readonly string[]).includes(operator)) return null;
  return { field: field as FilterField, operator: operator as Operator, value: raw.slice(second + 1) };
}

function serializeFilter(draft: FilterDraft): string {
  return `${draft.field} ${draft.operator} ${draft.value}`;
}

// 每种字段只有一个值控件类型，避免把原始查询语法暴露成必填知识。
function isNumericField(field: FilterField): boolean {
  return field === 'status' || field === 'durationMs';
}

// Runner 的返回上下文仍是安全站内路径；旧深链接经 route-map 映射到新导航。
function internalReturnPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  const queryIndex = value.indexOf('?');
  const pathname = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const search = queryIndex >= 0 ? value.slice(queryIndex) : '';
  const mapped = mapLegacyPath(pathname, search);
  if (mapped !== null) return `${mapped.pathname}${mapped.search}`;
  if (value.startsWith('/connect/api') || value.startsWith('/collections/') || value.startsWith('/requests') || value.startsWith('/activity/audit')) return value;
  return undefined;
}

// 耐久遥测既可能是具体路径，也可能是运行时路由模板；两者都要能定位回端点契约。
function matchingEndpoint(collections: Collection[], record: RequestRecord) {
  const collection = collections.find((item) => item.id === record.collectionId);
  if (!collection) return undefined;
  const candidate = record.endpoint.split('/');
  return endpointsForCollection(collection).find((item) => {
    if (item.method !== record.method) return false;
    const pattern = item.template.split('/');
    if (pattern.length !== candidate.length) return false;
    return pattern.every((segment, index) => {
      const value = candidate[index] ?? '';
      if (segment === '{collectionName}') {
        return value === collection.name || value === encodeURIComponent(collection.name) || value === '{collectionName}';
      }
      if (segment.startsWith('{') && segment.endsWith('}')) return value.length > 0;
      return segment === value;
    });
  });
}

function errorCopy(error: unknown, fallback: string, errorMessage: (code: string) => string | undefined, requestIdLabel: string) {
  if (!(error instanceof ApiClientError)) return { title: fallback, description: '' };
  return {
    title: errorMessage(error.apiError.code) ?? fallback,
    description: `${error.apiError.code} · ${requestIdLabel}: ${error.apiError.requestId}`,
  };
}

function outcomeLabel(prefix: 'authenticationOutcomes' | 'authorizationOutcomes', value: string | undefined, t: (key: TranslationKey) => string) {
  if (!value) return t('api.notRecorded');
  return t(`requests.${prefix}.${value}` as TranslationKey);
}

export function RequestsPage() {
  const { t, formatDate, formatNumber, errorMessage } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [page, setPage] = useState<{ data: RequestRecord[]; nextCursor?: string }>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);

  const search = params.get('search') ?? '';
  const filter = params.get('filter') ?? '';
  const sort = params.get('sort') ?? 'time desc';
  const cursor = params.get('cursor') ?? undefined;
  const collectionParam = params.get('collection') ?? '';
  const activeFilter = useMemo(() => parseFilter(filter), [filter]);
  const [searchDraft, setSearchDraft] = useState(search);
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(
    () => activeFilter ?? { field: 'status', operator: 'eq', value: '' },
  );

  const collectionNames = useMemo(() => new Map(collections.map((item) => [item.id, item.name])), [collections]);

  useEffect(() => {
    const controller = new AbortController();
    void listAllCollections(controller.signal).then((items) => {
      if (!controller.signal.aborted) setCollections(items);
    }).catch(() => { if (!controller.signal.aborted) setCollections([]); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    // 来自集合工作区的深链接只带 collection=<id>；这里映射回同一个 filter 语法，
    // 避免页面存在两套互相冲突的筛选状态。
    const effectiveFilter = filter || (collectionParam ? `collectionId eq "${collectionParam}"` : '');
    void listRequestRecords({ limit: 25, cursor, search, filter: effectiveFilter, sort }, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPage(value);
      setState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setState('error');
    });
    return () => controller.abort();
  }, [collectionParam, cursor, filter, reload, search, sort]);

  useEffect(() => {
    setSearchDraft(search);
    if (activeFilter) setFilterDraft(activeFilter);
  }, [activeFilter, search]);

  const commands = useMemo<AdminCommand[]>(() => [{
    id: 'surface.requests',
    category: 'commands.categories.system',
    label: () => t('navigation.requests'),
    keywords: () => ['requests', 'http log', 'application requests'],
    execute: () => navigate('/requests'),
  }], [navigate, t]);
  useRegisterCommands(commands);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (searchDraft.trim()) next.set('search', searchDraft.trim());
    if (filterDraft.value.trim()) next.set('filter', serializeFilter({ ...filterDraft, value: filterDraft.value.trim() }));
    if (sort !== 'time desc') next.set('sort', sort);
    setParams(next, { replace: true });
  }

  function clearFilter() {
    const next = new URLSearchParams(params);
    for (const key of ['filter', 'collection', 'cursor', 'back']) next.delete(key);
    setParams(next, { replace: true });
  }

  function changeSort(value: string) {
    const next = new URLSearchParams(params);
    for (const key of ['cursor', 'back']) next.delete(key);
    if (value === 'time desc') next.delete('sort'); else next.set('sort', value);
    setParams(next, { replace: true });
  }

  function nextPage() {
    if (!page?.nextCursor) return;
    const next = new URLSearchParams(params);
    next.append('back', cursor ?? '');
    next.set('cursor', page.nextCursor);
    setParams(next, { replace: true });
  }

  function previousPage() {
    const back = params.getAll('back');
    if (!back.length) return;
    const previous = back[back.length - 1];
    const next = new URLSearchParams(params);
    next.delete('back');
    back.slice(0, -1).forEach((entry) => next.append('back', entry));
    if (previous) next.set('cursor', previous); else next.delete('cursor');
    setParams(next, { replace: true });
  }

  const activeCollectionId = activeFilter?.field === 'collectionId' ? activeFilter.value : collectionParam;
  const from = `${location.pathname}${location.search}`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">{t('requests.eyebrow')}</p>
        <h1>{t('requests.title')}</h1>
        <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('requests.description')}</p>
      </header>

      <Surface className="flex min-w-0 flex-col gap-3 p-3" variant="standard">
        <form className="flex flex-wrap items-end gap-3" onSubmit={applyFilters}>
          <div className="relative min-w-[200px] flex-1 md:max-w-xs">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
            <label className="sr-only" htmlFor="requests-search">{t('api.searchLabel')}</label>
            <input
              className="min-h-9 w-full rounded-lg border border-input bg-card py-2 pl-9 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              id="requests-search"
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t('api.requestSearchPlaceholder')}
              type="search"
              value={searchDraft}
            />
          </div>
          <label className="grid gap-1.5 text-[11px] font-semibold text-ink-secondary">
            {t('requests.filterField')}
            <select
              className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              onChange={(event) => setFilterDraft((current) => ({ ...current, field: event.target.value as FilterField, value: '' }))}
              value={filterDraft.field}
            >
              {filterFields.map((field) => <option key={field} value={field}>{field}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-[11px] font-semibold text-ink-secondary">
            {t('requests.filterOperator')}
            <select
              className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              onChange={(event) => setFilterDraft((current) => ({ ...current, operator: event.target.value as Operator }))}
              value={filterDraft.operator}
            >
              {operators.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-[11px] font-semibold text-ink-secondary">
            {t('requests.filterValue')}
            {filterDraft.field === 'collectionId' ? (
              <select
                className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
                value={filterDraft.value}
              >
                <option value="">{t('api.allCollections')}</option>
                {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            ) : filterDraft.field === 'method' ? (
              <select
                className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
                value={filterDraft.value}
              >
                <option value="">{t('api.allCollections')}</option>
                {methods.map((method) => <option key={method} value={method}>{method}</option>)}
              </select>
            ) : filterDraft.field === 'authenticationOutcome' ? (
              <select
                className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
                value={filterDraft.value}
              >
                {authenticationOutcomes.map((value) => <option key={value} value={value}>{t(`requests.authenticationOutcomes.${value}` as TranslationKey)}</option>)}
              </select>
            ) : filterDraft.field === 'authorizationOutcome' ? (
              <select
                className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
                value={filterDraft.value}
              >
                {authorizationOutcomes.map((value) => <option key={value} value={value}>{t(`requests.authorizationOutcomes.${value}` as TranslationKey)}</option>)}
              </select>
            ) : (
              <input
                className="min-h-9 w-[140px] rounded-lg border border-input bg-card px-3 text-xs text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
                type={isNumericField(filterDraft.field) ? 'number' : 'text'}
                value={filterDraft.value}
              />
            )}
          </label>
          <Button type="submit" variant="primary"><Filter aria-hidden="true" size={14} />{t('requests.applyFilters')}</Button>
          {(filter || collectionParam) && <Button onClick={clearFilter} size="small" type="button" variant="quiet"><X aria-hidden="true" size={14} />{t('requests.clearFilter')}</Button>}
          <label className="ml-auto grid gap-1.5 text-[11px] font-semibold text-ink-secondary">
            {t('api.sortLabel')}
            <select
              className="min-h-9 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              onChange={(event) => changeSort(event.target.value)}
              value={sort}
            >
              <option value="time desc">{t('requests.sortNewest')}</option>
              <option value="time asc">{t('requests.sortOldest')}</option>
              <option value="durationMs desc">{t('requests.sortSlowest')}</option>
            </select>
          </label>
        </form>
        <p className="m-0 text-[10px] text-muted-foreground">{t('requests.filterHint')}</p>
      </Surface>

      {state === 'loading' && <LoadingState label={t('requests.loading')} />}
      {state === 'error' && (() => {
        const copy = errorCopy(error, t('requests.loadFailed'), errorMessage, t('common.requestId'));
        return (
          <ErrorState description={copy.description} title={copy.title}>
            <div className="mt-3"><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
          </ErrorState>
        );
      })()}
      {state === 'ready' && !page?.data.length && (
        (search || filter || collectionParam)
          ? <EmptyState description={t('api.noRequestsDescription')} title={t('api.noRequestsTitle')} />
          : <EmptyState description={t('requests.emptyDescription')} title={t('requests.emptyTitle')}>
            <div className="mt-3"><ButtonLink size="small" to="/connect/api" variant="primary">{t('navigation.connectApi')}</ButtonLink></div>
          </EmptyState>
      )}
      {state === 'ready' && !!page?.data.length && (
        <Table aria-label={t('api.requestsCaption')}>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead scope="col">{t('api.columnTime')}</TableHead>
              <TableHead scope="col">{t('api.columnRequest')}</TableHead>
              <TableHead scope="col">{t('api.columnEndpoint')}</TableHead>
              <TableHead scope="col">{t('requests.columnStatus')}</TableHead>
              <TableHead scope="col">{t('requests.columnDuration')}</TableHead>
              <TableHead scope="col">{t('requests.columnCollection')}</TableHead>
              <TableHead scope="col">{t('api.columnAccess')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.data.map((record) => (
              <TableRow key={record.requestId}>
                <TableCell className="align-top whitespace-nowrap"><time dateTime={record.time}>{formatDate(record.time)}</time></TableCell>
                <TableCell className="align-top"><Link className="font-mono text-[11px] font-semibold text-primary hover:underline" to={`/requests/${encodeURIComponent(record.requestId)}?from=${encodeURIComponent(from)}`}>{record.requestId}</Link></TableCell>
                <TableCell className="align-top"><strong className="mr-1.5 font-mono text-[11px] text-foreground">{record.method}</strong><code className="break-all font-mono text-[11px] text-ink-secondary">{record.endpoint}</code></TableCell>
                <TableCell className="align-top"><StatusChip state={record.status < 400 ? 'success' : 'error'}>{record.status}</StatusChip>{record.errorCode && <small className="mt-1 block font-mono text-[10px] text-muted-foreground">{record.errorCode}</small>}</TableCell>
                <TableCell className="align-top whitespace-nowrap">{formatNumber(record.durationMs)} ms</TableCell>
                <TableCell className="align-top">{record.collectionId ? collectionNames.get(record.collectionId) ?? record.collectionId : '—'}</TableCell>
                <TableCell className="align-top">
                  <span className="grid gap-0.5 text-[11px]">
                    <span>{outcomeLabel('authenticationOutcomes', record.authenticationOutcome, t)}</span>
                    <span className="text-muted-foreground">{outcomeLabel('authorizationOutcomes', record.authorizationOutcome, t)}</span>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {state === 'ready' && !!page?.data.length && (
        <nav aria-label={t('api.requestPagesLabel')} className="flex flex-wrap items-center justify-between gap-2">
          <Button disabled={!params.getAll('back').length} onClick={previousPage} size="small"><ArrowLeft aria-hidden="true" size={14} /> {t('api.previous')}</Button>
          {activeCollectionId && collectionNames.get(activeCollectionId) && <span className="text-xs text-muted-foreground">{collectionNames.get(activeCollectionId)}</span>}
          <Button disabled={!page.nextCursor} onClick={nextPage} size="small">{t('api.next')} <ArrowRight aria-hidden="true" size={14} /></Button>
        </nav>
      )}
    </div>
  );
}

export function RequestDetailPage() {
  const { t, formatDate, formatNumber, errorMessage } = useI18n();
  const { requestId = '' } = useParams();
  const [params] = useSearchParams();
  const [record, setRecord] = useState<RequestRecord>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const from = internalReturnPath(params.get('from'));
  const returnTo = from ?? '/requests';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void getRequestRecord(requestId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setRecord(value); setState('ready'); setError(undefined); }
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setState('error');
    });
    void listAllCollections(controller.signal).then((items) => {
      if (!controller.signal.aborted) setCollections(items);
    }).catch(() => { if (!controller.signal.aborted) setCollections([]); });
    return () => controller.abort();
  }, [reload, requestId]);

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('api.requestDetailLoading')} /></div>;
  if (state === 'error' || !record) {
    const copy = errorCopy(error, t('api.requestDetailLoadFailed'), errorMessage, t('common.requestId'));
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={copy.description} title={copy.title}>
          <div className="mt-3"><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
        </ErrorState>
        <Link className="inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-primary hover:underline" to="/requests"><ArrowLeft aria-hidden="true" size={14} /> {t('api.allRequests')}</Link>
      </div>
    );
  }

  const collection = collections.find((item) => item.id === record.collectionId);
  const endpoint = matchingEndpoint(collections, record);
  const endpointLink = endpoint
    ? `/connect/api?tab=endpoints&collection=${encodeURIComponent(endpoint.collectionId)}&endpoint=${encodeURIComponent(endpoint.operationId)}`
    : `/connect/api?tab=endpoints${record.collectionId ? `&collection=${encodeURIComponent(record.collectionId)}` : ''}`;
  const collectionLink = collection && endpoint ? `/collections/${encodeURIComponent(collection.id)}/api?endpoint=${encodeURIComponent(endpoint.operationId)}` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link className="inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-primary hover:underline" to={returnTo}><ArrowLeft aria-hidden="true" size={14} /> {from ? t('api.backToRequestContext') : t('api.allRequests')}</Link>
      <header className="min-w-0">
        <p className="eyebrow">{t('api.requestDetailEyebrow')}</p>
        <h1>{t('api.requestDetailTitle')}</h1>
        <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('api.requestDetailDescription')}</p>
      </header>

      <section aria-label={t('requests.detailRegion')} role="region" className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">{t('api.canonicalRequestId')}</p>
            <h2 className="break-all"><code className="font-mono text-base">{record.requestId}</code></h2>
          </div>
          <div className="flex items-center gap-2">
            <StatusChip state={record.status < 400 ? 'success' : 'error'}>{record.status}</StatusChip>
            <CopyButton label={t('api.copyRequestId')} value={record.requestId} />
          </div>
        </div>

        <dl className="m-0 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('api.columnTime')}</dt>
            <dd className="m-0 text-xs text-ink-secondary"><time dateTime={record.time}>{formatDate(record.time)}</time></dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('requests.columnDuration')}</dt>
            <dd className="m-0 text-xs text-ink-secondary">{formatNumber(record.durationMs)} ms</dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('api.methodAndRoute')}</dt>
            <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5"><strong className="font-mono text-xs text-foreground">{record.method}</strong><code className="break-all font-mono text-[11px] text-ink-secondary">{record.endpoint}</code></dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('api.collectionLabel')}</dt>
            <dd className="m-0 text-xs text-ink-secondary">{collection?.name ?? record.collectionId ?? '—'}</dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('api.authentication')}</dt>
            <dd className="m-0"><Badge variant={record.authenticationOutcome === 'authenticated' ? 'success' : record.authenticationOutcome === 'rejected' ? 'danger' : 'outline'}>{outcomeLabel('authenticationOutcomes', record.authenticationOutcome, t)}</Badge></dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('api.authorization')}</dt>
            <dd className="m-0"><Badge variant={record.authorizationOutcome === 'allowed' ? 'success' : record.authorizationOutcome === 'denied' ? 'danger' : 'outline'}>{outcomeLabel('authorizationOutcomes', record.authorizationOutcome, t)}</Badge></dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('api.errorCode')}</dt>
            <dd className="m-0 font-mono text-xs text-ink-secondary">{record.errorCode ?? '—'}</dd>
          </div>
          <div className="grid gap-0.5 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('requests.userAgent')}</dt>
            <dd className="m-0 text-xs text-ink-secondary">{t('api.notRecorded')}</dd>
          </div>
        </dl>

        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">{t('requests.allowlistNote')}</p>

        <div className="flex flex-wrap gap-2">
          <ButtonLink size="small" to={endpointLink}>{t('api.openEndpoint')}</ButtonLink>
          {collectionLink && <ButtonLink size="small" to={collectionLink}>{t('api.openCollectionApi')}</ButtonLink>}
          {record.authorizationOutcome === 'denied' && record.collectionId && <ButtonLink size="small" to={`/collections/${encodeURIComponent(record.collectionId)}/access`}>{t('api.reviewAccessRules')}</ButtonLink>}
          <ButtonLink size="small" to={`/requests?search=${encodeURIComponent(record.requestId)}`}>{t('api.findInRequests')}</ButtonLink>
        </div>
      </section>
    </div>
  );
}
