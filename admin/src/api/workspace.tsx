import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, Search } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiClientError } from './client';
import { allApplicationEndpoints, endpointOpenApiSnippet, endpointsForCollection, type EndpointDefinition } from './endpoints';
import { getRequestRecord, listRequestRecords, runApplicationRequest, type ApplicationRunResult, type RequestRecord } from './workspace-client';
import { getAccessRules, listAllCollections, type AccessRuleMode, type AccessRulesState, type Collection } from '../collections/client';
import { useCollectionWorkspace } from '../collections/workspace-context';
import { Button, CopyButton, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import './api-workspace.css';

function errorCopy(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) {
    return { title: error.apiError.message, detail: [error.apiError.code, error.apiError.hint, `Request ID: ${error.apiError.requestId}`].filter(Boolean).join(' · ') };
  }
  return { title: fallback, detail: error instanceof Error ? error.message : 'Try again when the project is available.' };
}

function selectedEndpoint(endpoints: EndpointDefinition[], selectedId: string | null) {
  return endpoints.find((endpoint) => endpoint.operationId === selectedId) ?? endpoints[0];
}

function accessRuleLabel(mode: AccessRuleMode | undefined) {
  const labels: Record<AccessRuleMode, string> = {
    anyone: 'Anyone',
    signedInUsers: 'Signed-in users',
    recordOwner: 'Record owner',
    custom: 'Custom rule',
    noAccess: 'No access',
  };
  return mode ? labels[mode] : 'Unavailable';
}

function EndpointWorkspace({ collections, fixedCollection }: { collections: Collection[]; fixedCollection?: Collection }) {
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
      const text = `${endpoint.title} ${endpoint.operationId} ${endpoint.path} ${collection?.name ?? ''}`.toLocaleLowerCase();
      return !normalized || text.includes(normalized);
    });
  }, [collections, filteredCollections, fixedCollection, search]);
  const endpoint = selectedEndpoint(visibleEndpoints.length ? visibleEndpoints : endpoints, searchParams.get('endpoint'));
  const selectedCollection = collections.find((item) => item.id === endpoint?.collectionId) ?? fixedCollection;
  const genericAccessOperation: Record<string, 'list' | 'create' | 'view' | 'update' | 'delete'> = {
    listApplicationRecords: 'list',
    createApplicationRecord: 'create',
    getApplicationRecord: 'view',
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
    for (const key of ['recordId', 'sessionId']) {
      if (path.includes(`{${key}}`)) {
        const value = pathValues[key]?.trim();
        if (!value) throw new Error(`${key === 'recordId' ? 'Record ID' : 'Session ID'} is required for this endpoint.`);
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

  if (!endpoints.length) return <EmptyState title="No API endpoints yet" description="Create and apply a Collection to discover its Application API routes." />;

  return (
    <div className="api-workspace">
      <Surface className="api-explorer" variant="standard">
        {!fixedCollection && <div className="api-explorer__filters">
          <label className="api-search"><Search aria-hidden="true" size={16} /><span className="sr-only">Search endpoints</span><input aria-label="Search endpoints" onChange={(event) => { setSearch(event.target.value); updateParam('q', event.target.value); }} placeholder="Search endpoints or Collections" type="search" value={search} /></label>
          <label className="api-filter"><span>Collection</span><select aria-label="Filter by Collection" onChange={(event) => updateParam('collection', event.target.value)} value={collectionFilter}><option value="">All Collections</option>{collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>}
        <div className="api-explorer__layout">
          <nav aria-label="Application endpoints" className="api-endpoint-list">
            <div className="api-section-label">ENDPOINTS <span>{visibleEndpoints.length}</span></div>
            {visibleEndpoints.map((item) => <button aria-current={endpoint?.operationId === item.operationId ? 'page' : undefined} className="api-endpoint-option" key={`${item.collectionId}:${item.operationId}`} onClick={() => selectEndpoint(item.operationId)} type="button">
              <span className={`api-method api-method--${item.method.toLowerCase()}`}>{item.method}</span><span className="api-endpoint-option__copy"><strong>{item.title}</strong><small>{item.path}</small>{!fixedCollection && <small>{item.collectionName}</small>}</span>
            </button>)}
            {!visibleEndpoints.length && <p className="api-muted api-endpoint-list__empty">No endpoints match this search.</p>}
          </nav>

          {activeEndpoint && selectedCollection ? <section aria-label="Endpoint details" className="api-endpoint-detail">
            <header className="api-endpoint-heading"><div><p className="eyebrow">{selectedCollection.name} · {selectedCollection.type} Collection</p><h2>{activeEndpoint.title}</h2><p className="api-route"><span className={`api-method api-method--${activeEndpoint.method.toLowerCase()}`}>{activeEndpoint.method}</span><code>{activeEndpoint.path}</code></p></div><div className="api-heading-actions"><CopyButton label="Copy endpoint path" value={activeEndpoint.path} /><details className="api-openapi"><summary>View OpenAPI</summary><pre><code>{JSON.stringify(endpointOpenApiSnippet(activeEndpoint, selectedCollection), null, 2)}</code></pre></details></div></header>
            <div className="api-endpoint-meta"><span><strong>Operation</strong>{activeEndpoint.operationId}</span><span><strong>Collection model</strong>v{selectedCollection.schemaVersion ?? 1} · {selectedCollection.fields.length} fields</span>{accessOperation && <span><strong>Applied access</strong>{ruleReady ? accessRuleLabel(appliedAccessMode) : 'Loading…'}</span>}</div>
            <div className="api-fields"><strong>Applied Fields</strong><div>{selectedCollection.fields.map((field) => <span className="api-field-chip" key={field.id ?? field.name}><code>{field.name}</code><small>{field.type}{field.required ? ' · required' : ''}</small></span>)}</div></div>
            <section className="api-runner">
              <div className="api-runner__heading"><div><p className="eyebrow">REAL HTTP REQUEST</p><h3>Try this endpoint</h3></div><Link className="text-link" to={`/api?tab=requests&filter=${encodeURIComponent(`collectionId eq "${selectedCollection.id}"`)}`}>View Collection requests <ArrowRight aria-hidden="true" size={14} /></Link></div>
              <form onSubmit={(event) => void run(event)}>
                {activeEndpoint.template.includes('{recordId}') && <FormField htmlFor="api-record-id" label="Record ID"><input autoComplete="off" id="api-record-id" onChange={(event) => setPathValues((value) => ({ ...value, recordId: event.target.value }))} value={pathValues.recordId ?? ''} /></FormField>}
                {activeEndpoint.template.includes('{sessionId}') && <FormField htmlFor="api-session-id" label="Session ID"><input autoComplete="off" id="api-session-id" onChange={(event) => setPathValues((value) => ({ ...value, sessionId: event.target.value }))} value={pathValues.sessionId ?? ''} /></FormField>}
                {activeEndpoint.operationId === 'listApplicationRecords' && <div className="api-runner__query-fields"><FormField htmlFor="api-limit" label="Limit"><input id="api-limit" max="100" min="1" onChange={(event) => { setLimit(event.target.value); updateParam('runLimit', event.target.value); }} type="number" value={limit} /></FormField><FormField htmlFor="api-search" label="Search"><input id="api-search" onChange={(event) => { setSearchValue(event.target.value); updateParam('runSearch', event.target.value); }} value={searchValue} /></FormField><FormField htmlFor="api-filter" hint={'Example: status eq 200 or title contains "hello"'} label="Filter"><input id="api-filter" onChange={(event) => { setFilter(event.target.value); updateParam('runFilter', event.target.value); }} value={filter} /></FormField><FormField htmlFor="api-sort" label="Sort" hint="Comma-separated field and direction pairs."><input id="api-sort" onChange={(event) => { setSort(event.target.value); updateParam('runSort', event.target.value); }} value={sort} /></FormField></div>}
                {(!activeEndpoint.authOnly || activeEndpoint.requiresSession) && <FormField htmlFor="api-app-session" hint="Kept in this page's memory only. It is never saved or shown in request history." label="App Session token (optional)"><input autoComplete="off" id="api-app-session" onChange={(event) => setAppSession(event.target.value)} type="password" value={appSession} /></FormField>}
                {activeEndpoint.bodySchema && <FormField htmlFor="api-request-body" hint={`${activeEndpoint.bodySchema} · Request body stays in this page and is not stored in request history.`} label="JSON body"><textarea autoComplete="off" id="api-request-body" onChange={(event) => setBody(event.target.value)} rows={8} spellCheck={false} value={body} />{runError instanceof SyntaxError && <span className="api-validation" role="alert">Enter valid JSON before sending the request.</span>}</FormField>}
                {runError !== undefined && !(runError instanceof SyntaxError) && (() => { const copy = errorCopy(runError, 'Request could not be sent.'); return <ErrorState description={copy.detail} title={copy.title} />; })()}
                <div className="api-runner__actions"><Button disabled={running} type="submit" variant="primary">{running ? <><RefreshCw aria-hidden="true" className="spin" size={15} /> Sending…</> : `Send ${activeEndpoint.method} request`}</Button><CopyButton label="Copy request command without credentials or body" value={`curl -X ${activeEndpoint.method} '${activeEndpoint.path}'`} /></div>
              </form>
              {running && <LoadingState label="Sending Application request" />}
              {result && <ApplicationResponse result={result} location={location} endpoint={activeEndpoint} />}
            </section>
          </section> : <EmptyState title="Select an endpoint" description="Choose an endpoint to inspect its contract and send a request." />}
        </div>
      </Surface>
    </div>
  );
}

function ApplicationResponse({ result, location, endpoint }: { result: ApplicationRunResult; location: ReturnType<typeof useLocation>; endpoint: EndpointDefinition }) {
  const from = `${location.pathname}${location.search}`;
  return <section aria-label="Request response" className="api-response" role="region">
    <header><div><p className="eyebrow">RESPONSE</p><h3>Request finished</h3></div><StatusChip state={result.status < 400 ? 'success' : 'error'}>{result.status}</StatusChip></header>
    <dl className="api-response__metadata">
      {result.requestId && <><dt>Request ID</dt><dd><code>{result.requestId}</code><CopyButton label="Copy Request ID" value={result.requestId} /></dd></>}
      <dt>Duration</dt><dd>{result.durationMs} ms</dd><dt>Endpoint</dt><dd><code>{endpoint.method} {endpoint.path}</code></dd>
      {result.structuredError && <><dt>Error</dt><dd><strong>{result.structuredError.code}</strong> · {result.structuredError.message}</dd></>}
    </dl>
    {result.textResponseHidden && <p className="api-muted">Response content is hidden because it is not JSON.</p>}
    {result.body !== undefined && <pre className="api-response__body"><code>{JSON.stringify(result.body, null, 2)}</code></pre>}
    <div className="api-response__actions">
      {result.requestId && result.requestRecordPersisted && <Link className="button button--secondary button--small" to={`/requests/${encodeURIComponent(result.requestId)}?from=${encodeURIComponent(from)}`}>View durable request details <ArrowRight aria-hidden="true" size={14} /></Link>}
      {result.requestId && !result.requestRecordPersisted && <span className="api-muted">Request details are unavailable because a durable Request Record was not confirmed.</span>}
    </div>
  </section>;
}

function paginationParams(current: URLSearchParams, cursor?: string) {
  const next = new URLSearchParams(current);
  next.delete('cursor');
  next.delete('back');
  if (cursor) next.set('cursor', cursor);
  return next;
}

function RequestHistory({ collections }: { collections: Collection[] }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');
  const [filterDraft, setFilterDraft] = useState(params.get('filter') ?? '');
  const [sortDraft, setSortDraft] = useState(params.get('sort') ?? 'time desc');
  const [page, setPage] = useState<{ data: RequestRecord[]; nextCursor?: string }>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const search = params.get('search') ?? '';
  const filter = params.get('filter') ?? '';
  const sort = params.get('sort') ?? 'time desc';
  const cursor = params.get('cursor') ?? undefined;
  const collectionNames = useMemo(() => new Map(collections.map((item) => [item.id, item.name])), [collections]);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listRequestRecords({ limit: 25, cursor, search, filter, sort }, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPage(value); setState('ready'); setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason); setState('error');
    });
    return () => controller.abort();
  }, [cursor, filter, reload, search, sort]);

  useEffect(() => {
    setSearchDraft(search);
    setFilterDraft(filter);
    setSortDraft(sort);
  }, [search, filter, sort]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = paginationParams(params);
    if (searchDraft.trim()) next.set('search', searchDraft.trim()); else next.delete('search');
    if (filterDraft.trim()) next.set('filter', filterDraft.trim()); else next.delete('filter');
    if (sortDraft.trim()) next.set('sort', sortDraft.trim()); else next.delete('sort');
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

  return <section aria-label="Request history" className="api-requests">
    <form className="api-request-filters" onSubmit={submit}>
      <FormField htmlFor="request-search" label="Search"><input id="request-search" onChange={(event) => setSearchDraft(event.target.value)} placeholder="Request ID, endpoint, or error code" value={searchDraft} /></FormField>
      <FormField htmlFor="request-filter" hint={'One condition, for example: status eq 403'} label="Filter"><input id="request-filter" onChange={(event) => setFilterDraft(event.target.value)} placeholder={'status eq 403'} value={filterDraft} /></FormField>
      <FormField htmlFor="request-sort" hint="Server sorts up to three fields; default is newest first." label="Sort"><input id="request-sort" onChange={(event) => setSortDraft(event.target.value)} value={sortDraft} /></FormField>
      <Button type="submit" variant="primary">Apply filters</Button>
    </form>
    {state === 'loading' && <LoadingState label="Loading Request Records" />}
    {state === 'error' && (() => { const copy = errorCopy(error, 'Request Records could not be loaded.'); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> Retry</Button></ErrorState>; })()}
    {state === 'ready' && (!page?.data.length ? <EmptyState title="No requests match these filters" description="Adjust the search or filter, then try again." /> : <div className="table-scroll"><table className="data-table api-request-table"><caption>Application Request Records</caption><thead><tr><th scope="col">Request</th><th scope="col">Time</th><th scope="col">Endpoint</th><th scope="col">Result</th><th scope="col">Access</th></tr></thead><tbody>{page.data.map((record) => <tr key={record.requestId}>
      <td><Link className="text-link" to={`/requests/${encodeURIComponent(record.requestId)}?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`}>{record.requestId}</Link></td>
      <td><time dateTime={record.time}>{new Date(record.time).toLocaleString()}</time><small>{record.durationMs} ms</small></td>
      <td><span className={`api-method api-method--${record.method.toLowerCase()}`}>{record.method}</span> <code>{record.endpoint}</code>{record.collectionId && <small>{collectionNames.get(record.collectionId) ?? 'Collection'}</small>}</td>
      <td><StatusChip state={record.status < 400 ? 'success' : 'error'}>{record.status}</StatusChip>{record.errorCode && <small>{record.errorCode}</small>}</td>
      <td>{record.authenticationOutcome ?? '—'}<small>{record.authorizationOutcome ?? '—'}</small></td>
    </tr>)}</tbody></table></div>)}
    {state === 'ready' && page?.data.length ? <nav aria-label="Request history pages" className="api-pagination"><Button disabled={!params.getAll('back').length} onClick={previousPage} size="small"><ArrowLeft aria-hidden="true" size={14} /> Previous</Button><span>Cursor-based results</span><Button disabled={!page.nextCursor} onClick={nextPage} size="small">Next <ArrowRight aria-hidden="true" size={14} /></Button></nav> : null}
  </section>;
}

function APIPageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-heading api-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div></header>;
}

export function CollectionAPIPage() {
  const { collection } = useCollectionWorkspace();
  return <div className="page-stack api-page"><APIPageHeader description="Discover the applied contract and send real Application requests." eyebrow="API" title={`${collection.name} API`} /><EndpointWorkspace collections={[collection]} fixedCollection={collection} /></div>;
}

export function GlobalAPIPage() {
  const [params, setParams] = useSearchParams();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const tab = params.get('tab') === 'requests' ? 'requests' : 'endpoints';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listAllCollections(controller.signal).then((value) => { if (!controller.signal.aborted) { setCollections(value); setState('ready'); setError(undefined); } }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(reason); setState('error'); } });
    return () => controller.abort();
  }, [reload]);

  return <div className="page-stack api-page"><APIPageHeader description="Inspect Application endpoints and review durable request outcomes." eyebrow="API" title="API Workspace" />
    <nav aria-label="API workspace" className="api-tabs"><button aria-current={tab === 'endpoints' ? 'page' : undefined} onClick={() => { const next = new URLSearchParams(params); next.set('tab', 'endpoints'); setParams(next, { replace: true }); }} type="button">Endpoints</button><button aria-current={tab === 'requests' ? 'page' : undefined} onClick={() => { const next = new URLSearchParams(params); next.set('tab', 'requests'); setParams(next, { replace: true }); }} type="button">Requests</button></nav>
    {tab === 'requests' ? <RequestHistory collections={collections} /> : state === 'loading' ? <LoadingState label="Loading Collections and API endpoints" /> : state === 'error' ? (() => { const copy = errorCopy(error, 'Collections could not be loaded.'); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> Retry</Button></ErrorState>; })() : <EndpointWorkspace collections={collections} />}
  </div>;
}
function internalReturnPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  if (!value.startsWith('/api') && !value.startsWith('/collections/') && !value.startsWith('/access/audit')) return undefined;
  return value;
}

function matchingEndpoint(collections: Collection[], record: RequestRecord) {
  const collection = collections.find((item) => item.id === record.collectionId);
  if (!collection) return undefined;
  return endpointsForCollection(collection).find((item) => {
    if (item.method !== record.method) return false;
    const escaped = item.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(?:recordId|sessionId)\\\}/g, '[^/]+');
    return new RegExp(`^${escaped}/?$`).test(record.endpoint);
  });
}

export function RequestDetailPage() {
  const { requestId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState<RequestRecord>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const from = internalReturnPath(params.get('from'));
  const endpoint = useMemo(() => record ? matchingEndpoint(collections, record) : undefined, [collections, record]);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void getRequestRecord(requestId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setRecord(value); setState('ready'); setError(undefined); }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason); setState('error'); }
    });
    void listAllCollections(controller.signal).then((items) => { if (!controller.signal.aborted) setCollections(items); }).catch(() => { if (!controller.signal.aborted) setCollections([]); });
    return () => controller.abort();
  }, [requestId, reload]);

  if (state === 'loading') return <div className="page-stack api-page"><LoadingState label="Loading Request details" /></div>;
  if (state === 'error' || !record) {
    const copy = errorCopy(error, 'Request details could not be loaded.');
    return <div className="page-stack api-page"><ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> Retry</Button><Link className="text-link" to="/api?tab=requests">Back to Requests</Link></ErrorState></div>;
  }
  const collection = collections.find((item) => item.id === record.collectionId);
  const endpointLink = endpoint ? `/api?tab=endpoints&collection=${encodeURIComponent(endpoint.collectionId)}&endpoint=${encodeURIComponent(endpoint.operationId)}` : '/api?tab=endpoints';
  const collectionLink = collection && endpoint ? `/collections/${encodeURIComponent(collection.id)}/api?endpoint=${encodeURIComponent(endpoint.operationId)}` : undefined;

  return <div className="page-stack api-page api-request-detail">
    <p className="api-breadcrumb"><Link to={from ?? '/api?tab=requests'}><ArrowLeft aria-hidden="true" size={14} /> {from ? 'Back to request context' : 'All requests'}</Link></p>
    <APIPageHeader description="Durable metadata for one Application request." eyebrow="OBSERVE · REQUEST" title="Request details" />
    <Surface className="api-detail-card" variant="standard">
      <header><div><p className="eyebrow">CANONICAL REQUEST ID</p><h2><code>{record.requestId}</code></h2></div><StatusChip state={record.status < 400 ? 'success' : 'error'}>{record.status}</StatusChip><CopyButton label="Copy Request ID" value={record.requestId} /></header>
      <dl className="api-detail-grid">
        <div><dt>Time</dt><dd><time dateTime={record.time}>{new Date(record.time).toLocaleString()}</time></dd></div>
        <div><dt>Duration</dt><dd>{record.durationMs} ms</dd></div>
        <div><dt>Method and route</dt><dd><span className={`api-method api-method--${record.method.toLowerCase()}`}>{record.method}</span> <code>{record.endpoint}</code></dd></div>
        <div><dt>Collection</dt><dd>{collection?.name ?? record.collectionId ?? '—'}</dd></div>
        <div><dt>Authentication</dt><dd>{record.authenticationOutcome ?? 'Not recorded'}</dd></div>
        <div><dt>Authorization</dt><dd>{record.authorizationOutcome ?? 'Not recorded'}</dd></div>
        <div><dt>Error code</dt><dd>{record.errorCode ?? '—'}</dd></div>
      </dl>
      <div className="api-detail-actions"><Link className="button button--secondary button--small" to={endpointLink}>Open endpoint</Link>{collectionLink && <Link className="button button--secondary button--small" to={collectionLink}>Open Collection API</Link>}<Button onClick={() => navigate('/api?tab=requests&search=' + encodeURIComponent(record.requestId))} size="small">Find in Requests</Button></div>
    </Surface>
  </div>;
}
