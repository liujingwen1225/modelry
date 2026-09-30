import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, RefreshCw, Search } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ApiClientError } from './client';
import { allApplicationEndpoints, endpointOpenApiSnippet, endpointsForCollection, type EndpointDefinition } from './endpoints';
import { runApplicationRequest, type ApplicationRunResult } from './workspace-client';
import { getAccessRules, listAllCollections, type AccessRuleMode, type AccessRulesState, type Collection } from '../collections/client';
import { useCollectionWorkspace } from '../collections/workspace-context';
import { Button, ButtonLink, CopyButton, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n/i18n';

type Translate = ReturnType<typeof useI18n>['t'];

// HTTP 方法胶囊：仅表达方法语义的视觉，不携带行为；保持小号 monospace。
const methodTones: Record<string, string> = {
  get: 'bg-success-soft text-success',
  post: 'bg-accent-cta-soft text-accent-cta-ink',
  patch: 'bg-warning-soft text-warning',
  put: 'bg-warning-soft text-warning',
  delete: 'bg-danger-soft text-danger',
};

function MethodPill({ method }: { method: string }) {
  return <span className={`inline-flex min-w-14 shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none ${methodTones[method.toLowerCase()] ?? 'bg-muted text-ink-secondary'}`}>{method}</span>;
}

function errorCopy(error: unknown, fallback: string, t: Translate, errorMessage: ReturnType<typeof useI18n>['errorMessage']) {
  if (error instanceof ApiClientError) {
    return { title: errorMessage(error.apiError.code) ?? t('errors.requestFailed'), detail: [t('common.errorCode'), error.apiError.code, `${t('common.requestId')}: ${error.apiError.requestId}`, t('common.tryAgainWhenAvailable')].join(' · ') };
  }
  return { title: fallback, detail: t('common.tryAgainWhenAvailable') };
}

function selectedEndpoint(endpoints: EndpointDefinition[], selectedId: string | null) {
  return endpoints.find((endpoint) => endpoint.operationId === selectedId) ?? endpoints[0];
}

function endpointTitle(endpoint: EndpointDefinition, t: Translate) {
  return t(endpoint.titleKey);
}

function accessRuleLabel(mode: AccessRuleMode | undefined, t: Translate) {
  return mode ? t(`accessModes.${mode}.label`) : t('common.unavailable');
}

function collectionTypeLabel(collection: Collection, t: Translate) {
  return t(collection.type === 'Auth' ? 'collections.typeAuth' : 'collections.typeNormal');
}

function EndpointWorkspace({ collections, fixedCollection }: { collections: Collection[]; fixedCollection?: Collection }) {
  const { t, formatNumber, errorMessage } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(searchParams.get('runLimit') ?? '25');
  const [searchValue, setSearchValue] = useState(searchParams.get('runSearch') ?? '');
  const [filter, setFilter] = useState(searchParams.get('runFilter') ?? '');
  const [sort, setSort] = useState(searchParams.get('runSort') ?? 'createdAt desc');
  const [body, setBody] = useState('');
  const [appSession, setAppSession] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<unknown>();
  const [result, setResult] = useState<ApplicationRunResult>();
  const [loadedAccessRules, setLoadedAccessRules] = useState<{ collectionId: string; state: AccessRulesState }>();
  const location = useLocation();
  const endpoints = useMemo(() => fixedCollection ? endpointsForCollection(fixedCollection) : allApplicationEndpoints(collections), [fixedCollection, collections]);
  const collectionFilter = searchParams.get('collection') ?? '';
  const filteredCollections = useMemo(() => collections.filter((item) => !collectionFilter || item.id === collectionFilter), [collections, collectionFilter]);
  const visibleEndpoints = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return allApplicationEndpoints(fixedCollection ? [fixedCollection] : filteredCollections).filter((endpoint) => {
      const collection = collections.find((item) => item.id === endpoint.collectionId) ?? fixedCollection;
      const text = `${t(endpoint.titleKey)} ${endpoint.title} ${endpoint.operationId} ${endpoint.path} ${collection?.name ?? ''}`.toLocaleLowerCase();
      return !normalized || text.includes(normalized);
    });
  }, [collections, filteredCollections, fixedCollection, search, t]);
  const endpoint = selectedEndpoint(visibleEndpoints.length ? visibleEndpoints : endpoints, searchParams.get('endpoint'));
  const selectedCollection = collections.find((item) => item.id === endpoint?.collectionId) ?? fixedCollection;
  const genericAccessOperation: Record<string, 'list' | 'create' | 'view' | 'update' | 'delete'> = {
    listApplicationRecords: 'list',
    createApplicationRecord: 'create',
    getApplicationRecord: 'view',
    readApplicationRecordFile: 'view',
    updateApplicationRecord: 'update',
    deleteApplicationRecord: 'delete',
  };
  const accessOperation = endpoint ? genericAccessOperation[endpoint.operationId] : undefined;
  const ruleReady = Boolean(selectedCollection && loadedAccessRules?.collectionId === selectedCollection.id);
  const appliedAccessMode = ruleReady && accessOperation
    ? loadedAccessRules?.state.applied.find((item) => item.operation === accessOperation)?.mode ?? 'noAccess'
    : undefined;
  const activeEndpoint = endpoint && accessOperation && ruleReady
    ? { ...endpoint, requiresSession: appliedAccessMode !== 'anyone', accessRuleMode: appliedAccessMode }
    : endpoint;

  useEffect(() => {
    setSearch(searchParams.get('q') ?? '');
  }, [searchParams.get('q')]);

  useEffect(() => {
    if (!selectedCollection) {
      return;
    }
    const controller = new AbortController();
    void getAccessRules(selectedCollection.id, controller.signal).then((state) => {
      if (controller.signal.aborted) return;
      setLoadedAccessRules({ collectionId: selectedCollection.id, state });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLoadedAccessRules({ collectionId: selectedCollection.id, state: { applied: [], pending: [], version: 0 } });
    });
    return () => controller.abort();
  }, [selectedCollection?.id]);

  useEffect(() => {
    if (!endpoint?.bodySchema) { setBody(''); return; }
    const samples: Record<string, unknown> = {
      RecordWriteRequest: { values: {} },
      ApplicationRegistrationRequest: { profile: {}, password: '' },
      ApplicationLoginRequest: { email: '', password: '' },
      ChangePasswordRequest: { currentPassword: '', newPassword: '' },
    };
    setBody(JSON.stringify(samples[endpoint.bodySchema] ?? {}, null, 2));
    setResult(undefined);
    setRunError(undefined);
  }, [endpoint?.operationId, endpoint?.bodySchema]);

  function updateParam(name: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next, { replace: true });
  }

  function selectEndpoint(operationId: string) {
    const next = new URLSearchParams(searchParams);
    next.set('endpoint', operationId);
    setSearchParams(next, { replace: true });
  }

  function buildPath() {
    if (!endpoint) return '';
    let path = endpoint.path;
    const pathParameters: Array<[string, TranslationKey]> = [['recordId', 'api.recordIdLabel'], ['sessionId', 'api.sessionIdLabel'], ['fieldName', 'api.fileFieldLabel']];
    for (const [key, labelKey] of pathParameters) {
      if (path.includes(`{${key}}`)) {
        const value = pathValues[key]?.trim();
        if (!value) throw new Error(t('api.missingPathValue', { name: t(labelKey) }));
        path = path.replace(`{${key}}`, encodeURIComponent(value));
      }
    }
    if (endpoint.operationId === 'listApplicationRecords') {
      const query = new URLSearchParams();
      query.set('limit', limit || '25');
      if (searchValue.trim()) query.set('search', searchValue.trim());
      if (filter.trim()) query.set('filter', filter.trim());
      if (sort.trim()) query.set('sort', sort.trim());
      path += `?${query.toString()}`;
    }
    return path;
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!endpoint) return;
    setRunning(true);
    setRunError(undefined);
    setResult(undefined);
    try {
      const path = buildPath();
      if (endpoint.bodySchema && body.trim()) JSON.parse(body);
      const response = await runApplicationRequest({
        method: endpoint.method,
        path,
        ...(endpoint.accept ? { accept: endpoint.accept } : {}),
        ...(endpoint.bodySchema ? { body } : {}),
        ...(appSession && (!endpoint.authOnly || endpoint.requiresSession) ? { applicationSession: appSession } : {}),
      });
      setResult(response);
    } catch (error) {
      setRunError(error);
    } finally {
      setRunning(false);
    }
  }

  if (!endpoints.length) return <EmptyState title={t('api.noEndpointsTitle')} description={t('api.noEndpointsDescription')} />;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Surface className="overflow-hidden p-0" variant="standard">
        {!fixedCollection && <div className="flex flex-wrap items-end gap-4 border-b p-4">
          <label className="flex min-w-56 flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3 text-muted-foreground focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring">
            <Search aria-hidden="true" size={16} />
            <span className="sr-only">{t('api.searchEndpoints')}</span>
            <input aria-label={t('api.searchEndpoints')} className="min-h-9 w-full border-0 bg-transparent py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground" onChange={(event) => { setSearch(event.target.value); updateParam('q', event.target.value); }} placeholder={t('api.searchEndpointsPlaceholder')} type="search" value={search} />
          </label>
          <label className="grid min-w-48 gap-1 text-[11px] text-muted-foreground">
            <span>{t('api.collectionFilter')}</span>
            <select aria-label={t('api.filterByCollection')} className="min-h-9 w-full rounded-lg border border-input bg-card px-3 py-2 text-xs text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring" onChange={(event) => updateParam('collection', event.target.value)} value={collectionFilter}><option value="">{t('api.allCollections')}</option>{collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>
        </div>}
        <div className="grid min-h-[38rem] min-[681px]:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
          <nav aria-label={t('api.endpointsLabel')} className="max-h-56 min-w-0 overflow-auto border-b p-3 min-[681px]:max-h-none min-[681px]:overflow-visible min-[681px]:border-r min-[681px]:border-b-0" data-api-endpoint-list>
            <div className="flex items-center justify-between px-2 pt-1 pb-2 text-[10px] font-bold tracking-[0.08em] text-muted-foreground uppercase">{t('api.endpointsSection')} <span className="text-ink-secondary">{formatNumber(visibleEndpoints.length)}</span></div>
            {visibleEndpoints.map((item) => <button aria-current={endpoint?.operationId === item.operationId ? 'page' : undefined} className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${endpoint?.operationId === item.operationId ? 'border-primary bg-secondary' : 'border-transparent hover:border-input hover:bg-secondary'}`} data-api-endpoint-option key={`${item.collectionId}:${item.operationId}`} onClick={() => selectEndpoint(item.operationId)} type="button">
              <MethodPill method={item.method} /><span className="grid min-w-0 gap-0.5"><strong className="text-xs font-semibold text-foreground">{endpointTitle(item, t)}</strong><small className="truncate font-mono text-[10px] text-muted-foreground">{item.path}</small>{!fixedCollection && <small className="truncate text-[10px] text-muted-foreground">{item.collectionName}</small>}</span>
            </button>)}
            {!visibleEndpoints.length && <p className="px-2 py-3 text-xs text-muted-foreground">{t('api.noEndpointsMatch')}</p>}
          </nav>

          {activeEndpoint && selectedCollection ? <section aria-label={t('api.endpointDetailsLabel')} className="min-w-0 p-4 min-[681px]:p-5">
            <header className="flex min-w-0 flex-col items-start justify-between gap-4 min-[681px]:flex-row" data-api-endpoint-heading><div className="min-w-0 flex-1"><p className="eyebrow">{selectedCollection.name} · {collectionTypeLabel(selectedCollection, t)}</p><h2 className="mt-1 mb-3">{endpointTitle(activeEndpoint, t)}</h2><p className="m-0 flex min-w-0 flex-wrap items-center gap-2.5 break-words"><MethodPill method={activeEndpoint.method} /><code className="min-w-0 font-mono text-xs break-all text-foreground">{activeEndpoint.path}</code></p></div><div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5" data-api-heading-actions><CopyButton label={t('api.copyEndpointPath')} value={activeEndpoint.path} /><details className="relative max-w-full" data-api-openapi><summary className="w-fit max-w-full cursor-pointer list-none rounded-md border border-input bg-card px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary [&::-webkit-details-marker]:hidden">{t('api.viewOpenApi')}</summary><pre className="absolute top-9 right-0 z-30 max-h-96 w-[42rem] max-w-[70vw] overflow-auto rounded-lg border bg-secondary p-3.5 text-[11px] shadow-soft"><code className="font-mono">{JSON.stringify(endpointOpenApiSnippet(activeEndpoint, selectedCollection), null, 2)}</code></pre></details></div></header>
            <div className="mt-5 flex flex-wrap gap-x-7 gap-y-3 border-y py-3" data-api-endpoint-meta><span className="grid gap-1 text-xs text-ink-secondary"><strong className="text-[10px] font-bold tracking-[0.05em] text-muted-foreground uppercase">{t('api.operationLabel')}</strong>{activeEndpoint.operationId}</span><span className="grid gap-1 text-xs text-ink-secondary"><strong className="text-[10px] font-bold tracking-[0.05em] text-muted-foreground uppercase">{t('api.collectionModelLabel')}</strong>{t('api.collectionModelValue', { version: selectedCollection.schemaVersion ?? 1, count: selectedCollection.fields.length })}</span>{accessOperation && <span className="grid gap-1 text-xs text-ink-secondary"><strong className="text-[10px] font-bold tracking-[0.05em] text-muted-foreground uppercase">{t('api.appliedAccessLabel')}</strong>{ruleReady ? accessRuleLabel(appliedAccessMode, t) : t('api.loadingAccess')}</span>}</div>
            <div className="my-4 flex flex-col gap-2"><strong className="text-[10px] font-bold tracking-[0.05em] text-muted-foreground uppercase">{t('api.appliedFields')}</strong><div className="flex flex-wrap gap-2">{selectedCollection.fields.map((field) => <span className="inline-flex items-center gap-2 rounded-full border bg-muted px-2 py-1" key={field.id ?? field.name}><code className="font-mono text-[11px] text-foreground">{field.name}</code><small className="text-[10px] text-muted-foreground">{field.type}{field.required ? t('api.fieldRequired') : ''}</small></span>)}</div></div>
            <section className="rounded-lg border bg-muted p-4">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="eyebrow">{t('api.runnerEyebrow')}</p><h3>{t('api.runnerTitle')}</h3></div><Link className="inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-primary hover:underline" to={`/requests?collection=${encodeURIComponent(selectedCollection.id)}`}>{t('api.viewCollectionRequests')} <ArrowRight aria-hidden="true" size={14} /></Link></div>
              <form className="flex flex-col gap-3.5" onSubmit={(event) => void run(event)}>
                {activeEndpoint.template.includes('{recordId}') && <FormField htmlFor="api-record-id" label={t('api.recordIdLabel')}><input autoComplete="off" id="api-record-id" onChange={(event) => setPathValues((value) => ({ ...value, recordId: event.target.value }))} value={pathValues.recordId ?? ''} /></FormField>}
                {activeEndpoint.template.includes('{sessionId}') && <FormField htmlFor="api-session-id" label={t('api.sessionIdLabel')}><input autoComplete="off" id="api-session-id" onChange={(event) => setPathValues((value) => ({ ...value, sessionId: event.target.value }))} value={pathValues.sessionId ?? ''} /></FormField>}
                {activeEndpoint.template.includes('{fieldName}') && <FormField htmlFor="api-file-field" label={t('api.fileFieldLabel')}><select id="api-file-field" onChange={(event) => setPathValues((value) => ({ ...value, fieldName: event.target.value }))} value={pathValues.fieldName ?? ''}><option value="">{t('api.chooseFileField')}</option>{selectedCollection.fields.filter((field) => field.type === 'file').map((field) => <option key={field.id ?? field.name} value={field.name}>{field.name}</option>)}</select></FormField>}
                {activeEndpoint.operationId === 'listApplicationRecords' && <div className="grid gap-3.5 min-[681px]:grid-cols-2"><FormField htmlFor="api-limit" label={t('api.limitLabel')}><input id="api-limit" max="100" min="1" onChange={(event) => { setLimit(event.target.value); updateParam('runLimit', event.target.value); }} type="number" value={limit} /></FormField><FormField htmlFor="api-search" label={t('api.searchLabel')}><input id="api-search" onChange={(event) => { setSearchValue(event.target.value); updateParam('runSearch', event.target.value); }} value={searchValue} /></FormField><FormField htmlFor="api-filter" hint={t('api.filterHint')} label={t('api.filterLabel')}><input id="api-filter" onChange={(event) => { setFilter(event.target.value); updateParam('runFilter', event.target.value); }} value={filter} /></FormField><FormField htmlFor="api-sort" label={t('api.sortLabel')} hint={t('api.sortHint')}><input id="api-sort" onChange={(event) => { setSort(event.target.value); updateParam('runSort', event.target.value); }} value={sort} /></FormField></div>}
                {(!activeEndpoint.authOnly || activeEndpoint.requiresSession) && <FormField htmlFor="api-app-session" hint={t('api.appSessionHint')} label={t('api.appSessionLabel')}><input autoComplete="off" id="api-app-session" onChange={(event) => setAppSession(event.target.value)} type="password" value={appSession} /></FormField>}
                {activeEndpoint.bodySchema && <FormField htmlFor="api-request-body" hint={t('api.jsonBodyHint', { schema: activeEndpoint.bodySchema })} label={t('api.jsonBodyLabel')}><textarea autoComplete="off" className="min-h-40 font-mono" id="api-request-body" onChange={(event) => setBody(event.target.value)} rows={8} spellCheck={false} value={body} />{runError instanceof SyntaxError && <span className="text-[11px] font-semibold text-danger" role="alert">{t('api.invalidJson')}</span>}</FormField>}
                {runError !== undefined && !(runError instanceof SyntaxError) && (() => { const copy = errorCopy(runError, t('api.requestFailed'), t, errorMessage); return <ErrorState description={copy.detail} title={copy.title} />; })()}
                <div className="flex flex-wrap items-center gap-2"><Button disabled={running} type="submit" variant="primary">{running ? <><RefreshCw aria-hidden="true" className="animate-spin" size={15} /> {t('api.sending')}</> : t('api.sendRequest', { method: activeEndpoint.method })}</Button><CopyButton label={t('api.copyCommand')} value={`curl -X ${activeEndpoint.method} '${activeEndpoint.path}'`} /></div>
              </form>
              {running && <LoadingState label={t('api.sendingLabel')} />}
              {result && <ApplicationResponse result={result} location={location} endpoint={activeEndpoint} />}
            </section>
          </section> : <EmptyState title={t('api.selectEndpointTitle')} description={t('api.selectEndpointDescription')} />}
        </div>
      </Surface>
    </div>
  );
}

function ApplicationResponse({ result, location, endpoint }: { result: ApplicationRunResult; location: ReturnType<typeof useLocation>; endpoint: EndpointDefinition }) {
  const { t, formatNumber, errorMessage } = useI18n();
  const from = `${location.pathname}${location.search}`;
  return <section aria-label={t('api.responseLabel')} className="mt-4 flex flex-col gap-3 border-t pt-3.5" role="region">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="eyebrow">{t('api.responseEyebrow')}</p><h3>{t('api.responseTitle')}</h3></div><StatusChip state={result.status < 400 ? 'success' : 'error'}>{result.status}</StatusChip></header>
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs" data-api-response-metadata>
      {result.requestId && <><dt className="text-muted-foreground">{t('common.requestId')}</dt><dd className="m-0 flex min-w-0 flex-wrap items-center gap-2 break-words"><code className="font-mono text-[11px] text-foreground">{result.requestId}</code><CopyButton label={t('api.copyRequestId')} value={result.requestId} /></dd></>}
      <dt className="text-muted-foreground">{t('api.durationLabel')}</dt><dd className="m-0">{formatNumber(result.durationMs)} ms</dd><dt className="text-muted-foreground">{t('api.endpointLabel')}</dt><dd className="m-0 min-w-0 break-words"><code className="font-mono text-[11px] text-foreground">{endpoint.method} {endpoint.path}</code></dd>
      {result.structuredError && <><dt className="text-muted-foreground">{t('api.errorLabel')}</dt><dd className="m-0 break-words"><strong>{result.structuredError.code}</strong> · {errorMessage(result.structuredError.code) ?? t('errors.requestFailed')}</dd></>}
    </dl>
    {result.textResponseHidden && <p className="m-0 text-xs text-muted-foreground">{t('api.hiddenContent')}</p>}
    {result.body !== undefined && <pre className="m-0 max-h-96 overflow-auto rounded-lg border bg-card p-3.5 text-[11px]" data-api-response-body><code className="font-mono">{JSON.stringify(result.body, null, 2)}</code></pre>}
    <div className="flex flex-wrap items-center gap-2.5">
      {result.requestId && result.requestRecordPersisted && <ButtonLink size="small" to={`/requests/${encodeURIComponent(result.requestId)}?from=${encodeURIComponent(from)}`}>{t('api.viewRequestDetails')} <ArrowRight aria-hidden="true" size={14} /></ButtonLink>}
      {result.requestId && !result.requestRecordPersisted && <span className="text-xs text-muted-foreground">{t('api.requestUnavailable')}</span>}
    </div>
  </section>;
}

function APIPageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="flex min-w-0 flex-wrap items-end justify-between gap-4"><div className="min-w-0"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{description}</p></div></header>;
}

export function CollectionAPIPage() {
  const { collection } = useCollectionWorkspace();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const activeTab = params.get('tab') === 'realtime' ? 'realtime' : 'endpoints';
  const sample = realtimeExample(collection.name, t);

  function selectTab(tab: 'endpoints' | 'realtime') {
    const next = new URLSearchParams(params);
    if (tab === 'endpoints') next.delete('tab');
    else next.set('tab', tab);
    setParams(next, { replace: true });
  }

  return <div className="flex min-w-0 flex-col gap-6">
    <APIPageHeader description={t('api.collectionDescription')} eyebrow="API" title={t('api.collectionTitle', { name: collection.name })} />
    <nav aria-label={t('api.collectionSections')} className="flex flex-wrap items-center gap-1 overflow-x-auto border-b">
      <button aria-current={activeTab === 'endpoints' ? 'page' : undefined} className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${activeTab === 'endpoints' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => selectTab('endpoints')} type="button">{t('api.endpointsTab')}</button>
      <button aria-current={activeTab === 'realtime' ? 'page' : undefined} className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${activeTab === 'realtime' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => selectTab('realtime')} type="button">{t('api.realtimeTab')}</button>
    </nav>
    {activeTab === 'realtime' ? <RealtimeWorkspace collection={collection} example={sample} /> : <EndpointWorkspace collections={[collection]} fixedCollection={collection} />}
  </div>;
}

function realtimeExample(collectionName: string, t: (key: TranslationKey) => string) {
  const path = `/api/v1/${encodeURIComponent(collectionName)}/events`;
  return `const endpoint = ${JSON.stringify(path)};
const sessionToken = undefined; // ${t('api.realtimeSampleSessionHint')}
let lastEventId;
let reloadAfterReady = true;

async function reloadCurrentRecords() {
  // ${t('api.realtimeSampleReloadHint')}
}

async function applyRecordEvent(eventType, payload) {
  // ${t('api.realtimeSampleApplyHint')}
}

const pause = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
  if (signal.aborted) finish();
});

async function subscribe(signal) {
  let retryDelay = 1000;
  while (!signal.aborted) {
    const headers = { Accept: 'text/event-stream' };
    if (sessionToken) headers.Authorization = \`Bearer \${sessionToken}\`;
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    let response;
    try {
      response = await fetch(endpoint, { headers, cache: 'no-store', credentials: 'omit', signal });
    } catch {
      if (signal.aborted) return;
      await pause(retryDelay, signal);
      retryDelay = Math.min(retryDelay * 2, 15000);
      continue;
    }
    if (response.status === 410) {
      await response.body?.cancel();
      lastEventId = undefined;
      reloadAfterReady = true;
      continue;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
      await response.body?.cancel();
      await pause(Math.min(Math.max(retryAfter || retryDelay, retryDelay), 15000), signal);
      retryDelay = Math.min(retryDelay * 2, 15000);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(\`${t('api.realtimeSampleRequestFailed')} \${response.status}\`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\\r\\n/g, '\\n');
        let boundary;
        while ((boundary = buffer.indexOf('\\n\\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let id;
          let eventType = 'message';
          const data = [];
          for (const line of frame.split('\\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('id:')) id = line.slice(3).trimStart();
            else if (line.startsWith('event:')) eventType = line.slice(6).trimStart();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length && !id) continue; // ${t('api.realtimeSampleHeartbeatHint')}
          if (!id || !data.length) throw new Error(${JSON.stringify(t('api.realtimeSampleMalformedFrame'))});
          const payload = JSON.parse(data.join('\\n'));
          if (eventType === 'stream.ready' && reloadAfterReady) {
            await reloadCurrentRecords();
            reloadAfterReady = false;
          } else if (['record.created', 'record.updated', 'record.deleted', 'record.removed'].includes(eventType)) {
            await applyRecordEvent(eventType, payload);
          } else if (eventType !== 'stream.ready') throw new Error(\`${t('api.realtimeSampleUnsupportedEvent')} \${eventType}\`);
          lastEventId = id; // ${t('api.realtimeSampleCursorHint')}
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof TypeError)) throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!signal.aborted) {
      await pause(retryDelay, signal);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  }
}

const controller = new AbortController();
void subscribe(controller.signal);
// ${t('api.realtimeSampleStopHint')}`;
}

function RealtimeWorkspace({ collection, example }: { collection: Collection; example: string }) {
  const { t } = useI18n();
  const [ruleState, setRuleState] = useState<AccessRulesState>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void getAccessRules(collection.id, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setRuleState(value);
      setState('ready');
    }).catch(() => {
      if (controller.signal.aborted) return;
      setState('error');
    });
    return () => controller.abort();
  }, [collection.id]);

  const listMode = ruleState?.applied.find((rule) => rule.operation === 'list')?.mode;
  const endpoint = `/api/v1/${encodeURIComponent(collection.name)}/events`;

  return <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0"><p className="eyebrow">{t('api.realtimeProtocol')}</p><h2 className="mt-1 mb-2">{t('api.realtimeHeading')}</h2><p className="m-0 max-w-[52rem] text-[13px] text-ink-secondary">{t('api.realtimeDescription')}</p></div>
      <CopyButton label={t('api.copyRealtimeExample')} value={example} />
    </header>
    <dl className="m-0 grid gap-4 border-y py-3.5 min-[681px]:grid-cols-2" data-api-realtime-metadata>
      <div className="grid min-w-0 gap-1.5"><dt className="text-[10px] font-bold tracking-[0.04em] text-muted-foreground uppercase">{t('api.realtimeEndpoint')}</dt><dd className="m-0 flex min-w-0 flex-wrap items-center gap-2.5 break-words"><MethodPill method="GET" /><code className="font-mono text-[11px] break-all text-foreground">{endpoint}</code></dd></div>
      <div className="grid min-w-0 gap-1.5"><dt className="text-[10px] font-bold tracking-[0.04em] text-muted-foreground uppercase">{t('api.realtimeAccess')}</dt><dd className="m-0 flex min-w-0 flex-wrap items-center gap-2.5 text-xs break-words">{state === 'loading' ? <LoadingState label={t('runtime.connecting')} /> : state === 'error' ? t('api.realtimeUnavailable') : listMode ? accessRuleLabel(listMode, t) : t('api.realtimeUnavailable')}</dd></div>
    </dl>
    <p className="m-0 text-xs text-muted-foreground">{t('api.realtimeAccessHint')}</p>
    {state === 'error' && <ErrorState description={t('api.realtimeUnavailableHint')} title={t('api.realtimeUnavailable')} />}
    <section className="grid gap-3 rounded-lg border bg-muted p-4" data-api-realtime-example>
      <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h3>{t('api.realtimeExampleHeading')}</h3><p className="mt-1 mb-0 text-[13px] text-ink-secondary">{t('api.realtimeExampleDescription')}</p></div></header>
      <pre className="m-0 max-h-[36rem] overflow-auto rounded-md border bg-card p-3.5 text-[11px] leading-relaxed"><code className="font-mono whitespace-pre">{example}</code></pre>
      <p className="m-0 text-xs text-muted-foreground">{t('api.realtimeExampleCallbackHint')}</p>
    </section>
  </Surface>;
}

export function GlobalAPIPage() {
  const { t, errorMessage } = useI18n();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listAllCollections(controller.signal).then((value) => { if (!controller.signal.aborted) { setCollections(value); setState('ready'); setError(undefined); } }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(reason); setState('error'); } });
    return () => controller.abort();
  }, [reload]);

  // Spec 0001 §3.1：Request 日志属于 Observe，不在 Connect 内复制一份列表。
  return <div className="flex min-w-0 flex-col gap-6">
    <APIPageHeader description={t('api.workspaceDescription')} eyebrow="API" title={t('api.workspaceTitle')} />
    <div className="flex flex-wrap items-center gap-2">
      <ButtonLink size="small" to="/requests">{t('navigation.requests')} <ArrowRight aria-hidden="true" size={14} /></ButtonLink>
    </div>
    {state === 'loading' ? <LoadingState label={t('api.loadingWorkspace')} /> : state === 'error' ? (() => { const copy = errorCopy(error, t('api.collectionsLoadFailed'), t, errorMessage); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></ErrorState>; })() : <EndpointWorkspace collections={collections} />}
  </div>;
}
