import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Bot, Plus, Send, Square } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectField } from '@/components/ui/select-field';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetCloseButton } from '@/components/ui/sheet';
import { Button as ControlButton } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { LoadingState } from '../components/states';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { useOwnerSession } from '../auth/owner-session';
import { ChangeDiff } from '../collections/change-diff';
import { getJson } from '../api/client';
import { agentGet, agentSend, activeSession, type AgentConfig, type AgentOperation, type AgentSession } from './client';

const data = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function valueText(value: unknown, t: ReturnType<typeof useI18n>['t']) {if (value === undefined || value === null) return '—'; if (typeof value === 'boolean') return t(value ? 'agent.yes' : 'agent.no'); if (Array.isArray(value) && value.every(item => typeof item === 'object' && item && 'name' in item)) return value.map(item => `${item.name}${item.type ? ': ' + item.type : ''}`).join('\n'); return typeof value === 'object' ? JSON.stringify(value) : String(value);}
function OperationDetail({operation}: {operation: AgentOperation}) {
  const {t} = useI18n(); const body = data(operation.arguments.body); const definition = data(body.definition); const beforeEnvelope = data(operation.before); const before = data(beforeEnvelope.data ?? operation.before);
  const isApply = ['access_rules_apply', 'authentication_apply'].includes(operation.name);
  const after = isApply ? data(before.pending) : Object.keys(definition).length ? definition : data(body.values ?? body.configuration ?? body);
  const preview = data(before.preview);
  const schemaDiff = Array.isArray(preview.diff) ? preview.diff as Array<Record<string, unknown>> : [];
  const collection = data(before.collection);
  const definitions = Array.isArray(collection.fields) ? collection.fields.map(data) : [];
  const proposedField = operation.name.startsWith('schema_operation_') && Object.keys(definition).length ? [{kind: body.kind, action: body.action, name: definition.name, before: definitions.find(field => field.id === definition.id || field.name === definition.name), after: definition}] : [];
  const beforeValues = data(isApply ? before.applied : before.values ?? before.pending ?? before.applied ?? before);
  const rows = Object.entries(after).filter(([key]) => !['expectedVersion', 'confirmRisk'].includes(key));
  const rules = operation.name.startsWith('access_rules_') ? (isApply ? before.pending : body.rules) : undefined;
  const ruleBefore = isApply ? before.applied : before.pending ?? before.applied;
  const oldRules = Array.isArray(ruleBefore) ? ruleBefore.map(data) : [];
  const ruleRows = Array.isArray(rules) ? rules.map(data) : [];
  const result = data(data(operation.result).data ?? operation.result);
  const collectionId = operation.arguments.collectionId ?? (operation.name === 'collections_create' ? result.id : undefined);
  const ruleText = (rule: Record<string, unknown>) => {if (!rule.mode) return '—'; const mode = t(('accessModes.' + rule.mode + '.label') as TranslationKey); return mode + (rule.ownerFieldId ? ' · ' + rule.ownerFieldId : '') + (rule.expression ? ' · ' + JSON.stringify(rule.expression) : '');};
  const resource = operation.name.split('_')[0]; const action = operation.name.split('_').at(-1) ?? 'update';
  const object = definition.name ?? body.name ?? operation.arguments.recordId ?? operation.arguments.collectionId ?? operation.arguments.webhookId ?? operation.arguments.jobId ?? operation.arguments.extensionId ?? operation.arguments.eventHookId ?? '';
  return <div className="flex min-w-0 flex-col gap-2 border-l-2 border-border pl-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{t(('agent.actions.' + action) as TranslationKey)} · {t(('agent.groups.' + (resource === 'access' ? 'accessRules' : resource === 'event' ? 'eventHooks' : resource === 'deliveries' ? 'webhooks' : resource)) as TranslationKey)} {String(object)}</strong><span className="text-xs text-muted-foreground">{t(('agent.states.' + operation.state) as TranslationKey)}</span></div>
    {operation.risk && <p className="text-xs text-warning">{t('agent.riskLabel')}</p>}
    {schemaDiff.length > 0 && <ChangeDiff changes={schemaDiff} />}{proposedField.length > 0 && <ChangeDiff changes={proposedField} />}
    {!proposedField.length && !ruleRows.length && rows.length > 0 && <Table><TableHeader><TableRow><TableHead>{t('agent.attribute')}</TableHead><TableHead>{t('agent.before')}</TableHead><TableHead>{t('agent.after')}</TableHead></TableRow></TableHeader><TableBody>{rows.map(([key, value]) => <TableRow key={key}><TableCell>{['name','type','required','unique','description','default','fields','rules','source','language','bindings','targetUrl','signingSecretId','webhookId','cron','collectionId','eventType','enabled','emailPasswordEnabled','selfRegistration','sessionDurationDays','emailVerification'].includes(key) ? t(('agent.attributes.' + key) as TranslationKey) : key}</TableCell><TableCell className="max-w-36 whitespace-pre-wrap break-words">{valueText(beforeValues[key], t)}</TableCell><TableCell className="max-w-52 whitespace-pre-wrap break-words">{valueText(value, t)}</TableCell></TableRow>)}</TableBody></Table>}
    {ruleRows.length > 0 && <Table><TableHeader><TableRow><TableHead>{t('agent.attribute')}</TableHead><TableHead>{t('agent.before')}</TableHead><TableHead>{t('agent.after')}</TableHead></TableRow></TableHeader><TableBody>{ruleRows.map(rule => <TableRow key={String(rule.operation)}><TableCell>{t(('security.operations.' + rule.operation) as TranslationKey)}</TableCell><TableCell className="whitespace-pre-wrap break-words">{ruleText(oldRules.find(previous => previous.operation === rule.operation) ?? {})}</TableCell><TableCell className="whitespace-pre-wrap break-words">{ruleText(rule)}</TableCell></TableRow>)}</TableBody></Table>}
    {operation.error && <p role="alert" className="text-sm text-danger">{operation.error}</p>}
    <details className="text-xs text-muted-foreground"><summary className="inline-flex min-h-11 cursor-pointer items-center">{t('agent.technicalDetails')}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3">{JSON.stringify({tool: operation.name, arguments: operation.arguments, before: operation.before, result: operation.result, requestId: operation.requestId}, null, 2)}</pre></details>
    {Boolean(collectionId) && <Link className="inline-flex min-h-11 items-center text-sm hover:underline" to={'/collections/' + encodeURIComponent(String(collectionId))}>{t('agent.openResource')}</Link>}
  </div>;
}
function DataAuthorization({session, onSaved}: {session: AgentSession; onSaved: () => void}) {
  const {t} = useI18n();
  const [collections, setCollections] = useState<{id: string; name: string; fields: {name: string}[]}[]>([]); const [collectionId, setCollectionId] = useState(''); const [fields, setFields] = useState<string[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {const controller = new AbortController(); getJson<{data: typeof collections}>('/admin/api/v1/collections?limit=100', controller.signal).then(value => {setCollections(value.data);}, reason => {if (!controller.signal.aborted) setError(reason.message);}); return () => controller.abort();}, []);
  const selected = collections.find(c => c.id === collectionId);
  async function grant() {setBusy(true); setError(''); try {await agentSend('/sessions/' + session.id + '/data-grants', {collectionId, fields}); onSaved();} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}}
  return <details className="border-t pt-2"><summary className="inline-flex min-h-11 cursor-pointer items-center text-sm">{t('agent.dataAccess')}</summary><div className="flex flex-col gap-3 pb-3"><p className="text-xs text-muted-foreground">{t('agent.dataAccessDescription')}</p><FormField htmlFor={'agent-data-' + session.id} label={t('agent.collection')}><SelectField id={'agent-data-' + session.id} value={collectionId} options={[{value: '', label: t('agent.chooseCollection')}, ...collections.map(c => ({value: c.id, label: c.name}))]} onValueChange={value => {setCollectionId(value); setFields([]);}} /></FormField>
    <div className="flex flex-wrap gap-x-4 gap-y-1">{selected?.fields.filter(f => !/password|token|secret|credential|api.?key/i.test(f.name)).map(field => <label key={field.name} className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={fields.includes(field.name)} onCheckedChange={checked => setFields(checked ? [...fields, field.name] : fields.filter(f => f !== field.name))} />{field.name}</label>)}</div>
    {error && <p role="alert">{error}</p>}<div><Button disabled={!fields.length || busy} onClick={() => void grant()}>{t('agent.authorizeData')}</Button></div>
    {session.dataGrants.map((grant, i) => <p key={i} className="text-xs text-muted-foreground">{collections.find(c => c.id === grant.collectionId)?.name ?? grant.collectionId} · {grant.fields.join(', ')}</p>)}
  </div></details>;
}
export function AgentWorkspace({panel = false, embedded = false}: {panel?: boolean; embedded?: boolean}) {
  const {t, formatDate} = useI18n(); const location = useLocation(); const {state} = useOwnerSession(); const [params, setParams] = useSearchParams();
  const [sessions, setSessions] = useState<AgentSession[]>([]); const [id, setId] = useState(params.get('session') ?? ''); const [session, setSession] = useState<AgentSession>(); const [config, setConfig] = useState<AgentConfig>();
  const [content, setContent] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [selected, setSelected] = useState<string[]>([]); const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {try {const list = await agentGet<AgentSession[]>('/sessions'); setSessions(Array.isArray(list) ? list : []); if (id) setSession(await agentGet<AgentSession>('/sessions/' + id)); setLoading(false);} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false);}}, [id]);
  useEffect(() => {void refresh();}, [refresh]);
  useEffect(() => {agentGet<AgentConfig>('/config').then(setConfig, reason => setError(reason.message));}, []);
  useEffect(() => {if (!id) return; const events = new EventSource('/admin/api/v1/agent/sessions/' + id + '/events'); const update = (event: MessageEvent) => {try {const value = JSON.parse(event.data) as AgentSession; setSession(value); void agentGet<AgentSession[]>('/sessions').then(setSessions).catch(() => undefined);} catch {void refresh();}}; events.addEventListener('session', update as EventListener); return () => events.close();}, [id, refresh]);
  if (state.status !== 'authenticated' || state.session.role !== 'owner') return <p>{t('agent.ownerOnly')}</p>;
  function choose(sessionId: string) {setId(sessionId); setSelected([]); setError(''); if (!panel) setParams(previous => {const next = new URLSearchParams(previous); next.set('session', sessionId); return next;});}
  async function newSession() {setBusy(true); setError(''); try {const value = await agentSend<AgentSession>('/sessions'); choose(value.id); setSession(value); await refresh(); return value.id;} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason)); return undefined;} finally {setBusy(false);}}
  async function send(text = content) {if (!text.trim()) return; setBusy(true); setError(''); try {const sessionId = id || await newSession(); if (!sessionId) return; await agentSend('/sessions/' + sessionId + '/messages', {content: text, pageContext: location.pathname === '/agent' ? session?.actor.identity ?? '' : location.pathname + location.search}); setContent(''); choose(sessionId); await refresh();} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}}
  async function decide(ids: string[], action: 'approve' | 'reject') {setBusy(true); setError(''); try {if (action === 'approve' && ids.length > 1) {await agentSend('/sessions/' + id + '/approve-batch', {operationIds: ids});} else {for (const operationId of ids) {await agentSend('/operations/' + operationId + '/' + action);}} setSelected([]); await refresh();} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason)); await refresh();} finally {setBusy(false);}}
  const pending = session?.operations.filter(op => op.state === 'awaitingApproval') ?? [];
  const batchable = pending.filter(op => !op.risk);
  const running = session && activeSession(session);
  return <div className={'flex min-w-0 flex-col gap-4 ' + (panel ? 'p-4' : '')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><div hidden={embedded}><h1 className={panel ? 'sr-only' : 'text-xl font-semibold'}>{t('agent.title')}</h1>{!panel && <p className="mt-1 text-sm text-muted-foreground">{t('agent.description')}</p>}</div><div className="flex gap-2"><Link className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:underline" to="/settings/agent">{t('agent.settingsTitle')}</Link><Button size="small" disabled={busy} onClick={() => void newSession()}><Plus aria-hidden="true" size={15} />{t('agent.newSession')}</Button></div></div>
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
    {!config?.revision && <p className="text-sm text-muted-foreground">{t('agent.setupNotice')} <Link to="/settings/agent" className="underline">{t('agent.configure')}</Link></p>}
    <div className={panel ? 'flex min-w-0 flex-col gap-4' : 'grid min-w-0 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]'}>
      <nav aria-label={t('agent.sessions')} className={panel ? 'flex min-w-0 gap-2 overflow-x-auto' : 'flex min-w-0 flex-col gap-1'}>{loading && <LoadingState label={t('common.loading')} />}{sessions.map(item => <button type="button" key={item.id} className={'min-h-11 rounded-md px-3 py-2 text-left text-sm transition-colors ' + (panel ? 'max-w-52 shrink-0 ' : '') + (item.id === id ? 'bg-accent' : 'hover:bg-accent')} onClick={() => choose(item.id)}><span className="block truncate font-medium">{item.title}</span><span className="block text-xs text-muted-foreground">{item.actor.identity === 'builtin' ? t('agent.builtin') : 'MCP'} · {formatDate(item.updatedAt)}</span><span className="text-xs">{t(('agent.states.' + item.state) as TranslationKey)}{item.operations.some(op => op.state === 'awaitingApproval') ? ' · ' + t('agent.pending') : ''}</span></button>)}</nav>
      <section className="flex min-w-0 flex-col gap-4" aria-label={t('agent.conversation')}>
        {session ? <><div className="flex items-center justify-between gap-2 border-b pb-3"><strong className="truncate text-sm">{session.title}</strong><span className="shrink-0 text-xs text-muted-foreground">{t(('agent.states.' + session.state) as TranslationKey)}</span></div>
          <div className="flex flex-col gap-4" aria-live="polite">{session.messages.map((message, i) => <div key={i} className={message.role === 'user' ? 'ml-5 rounded-md bg-muted px-3 py-2' : 'mr-3'}><span className="text-xs font-medium text-muted-foreground">{message.role === 'user' ? t('agent.you') : 'Agent'}</span><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p></div>)}</div>
          {session.operations.map(operation => <div key={operation.id} className="flex flex-col gap-2"><OperationDetail operation={operation} />{operation.state === 'awaitingApproval' && <div className="flex flex-wrap items-center gap-2 pl-3">{!operation.risk && <label className="flex min-h-11 items-center gap-2 text-xs"><Checkbox checked={selected.includes(operation.id)} onCheckedChange={checked => setSelected(checked ? [...selected, operation.id] : selected.filter(s => s !== operation.id))} />{t('agent.includeBatch')}</label>}<Button size="small" disabled={busy} onClick={() => void decide([operation.id], 'approve')}>{t('agent.approve')}</Button><Button size="small" variant="secondary" disabled={busy} onClick={() => void decide([operation.id], 'reject')}>{t('agent.reject')}</Button></div>}</div>)}
          {batchable.length > 1 && <div className="flex flex-wrap items-center gap-2 border-t pt-3"><Button size="small" variant="secondary" disabled={busy} onClick={() => setSelected(batchable.map(op => op.id))}>{t('agent.selectOrdinary')}</Button><Button size="small" disabled={busy || !selected.length} onClick={() => void decide(selected, 'approve')}>{t('agent.approveSelected', {count: selected.length})}</Button></div>}
          <DataAuthorization session={session} onSaved={() => {void refresh();}} />
        </> : <div className="flex flex-col gap-3 py-6"><Bot aria-hidden="true" size={24} /><p className="text-sm text-muted-foreground">{t('agent.empty')}</p>{['inspect', 'model', 'testData'].map(task => <Button key={task} variant="secondary" onClick={() => setContent(t(('agent.tasks.' + task) as TranslationKey))}>{t(('agent.tasks.' + task) as TranslationKey)}</Button>)}</div>}
        {session?.actor.identity !== 'builtin' && session ? <p className="text-sm text-muted-foreground">{t('agent.externalSession')}</p> : <form className="flex gap-2 border-t pt-3" onSubmit={event => {event.preventDefault(); void send();}}><Input aria-label={t('agent.message')} value={content} disabled={Boolean(running) || busy} placeholder={t('agent.messagePlaceholder')} onChange={event => setContent(event.target.value)} />{running ? <Button type="button" variant="secondary" onClick={() => {void agentSend('/sessions/' + id + '/cancel').then(refresh).catch(reason => setError(reason.message));}}><Square aria-hidden="true" size={15} />{t('agent.stop')}</Button> : <Button type="submit" disabled={busy || !content.trim() || !config?.revision}><Send aria-hidden="true" size={15} />{t('agent.send')}</Button>}</form>}
      </section>
    </div>
  </div>;
}
export function AgentPanelControl() {
  const {t} = useI18n(); const [open, setOpen] = useState(false); const [pending, setPending] = useState(0);
  useEffect(() => {let cancelled = false; const refresh = () => {agentGet<AgentSession[]>('/sessions').then(list => {if (!cancelled && Array.isArray(list)) setPending(list.reduce((count, item) => count + (item.operations?.filter(op => op.state === 'awaitingApproval').length ?? 0), 0));}).catch(() => undefined);}; refresh(); const timer = setInterval(refresh, 10000); return () => {cancelled = true; clearInterval(timer);};}, []);
  return <><ControlButton size="icon" variant="ghost" aria-label={t('agent.open')} onClick={() => setOpen(true)} className="relative size-11"><Bot aria-hidden="true" size={18} />{pending > 0 && <span className="absolute right-0 top-0 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{pending}</span>}</ControlButton><Sheet open={open} onOpenChange={setOpen}><SheetContent size="wide" className="w-[min(620px,100vw)]"><SheetHeader><SheetTitle>{t('agent.title')}</SheetTitle><div className="flex items-center gap-2"><Link className="inline-flex min-h-11 items-center text-sm hover:underline" to="/agent" onClick={() => setOpen(false)}>{t('agent.openWorkspace')}</Link><SheetCloseButton aria-label={t('common.close')} /></div></SheetHeader><AgentWorkspace panel /></SheetContent></Sheet></>;
}
