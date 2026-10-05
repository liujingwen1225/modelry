import { WorkspaceActions } from '../components/workspace-toolbar';
import { Label } from '@/components/ui/label';
import { SearchInput } from '@/components/ui/search-input';
import { SelectField } from '@/components/ui/select-field';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Pencil, RefreshCw, Webhook as WebhookIcon } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { FormField } from '../components/form-field';
import { Dialog, Sheet } from '../components/overlays';
import { EmptyState, ErrorState, LoadingState, PartialState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { createEventHook, createJob, createWebhook, getDelivery, listAutomationCollections, listAutomationSecrets, listDeliveries, listEventHooks, listJobs, listWebhooks, retryDelivery, runJob, sendWebhookTest, setEventHookEnabled, setJobEnabled, setWebhookEnabled, updateEventHook, updateJob, updateWebhook, type CollectionOption, type DeliveryDetail, type DeliverySourceType, type DeliveryStatus, type EventHookInput, type EventHookSummary, type JobInput, type JobSummary, type SecretOption, type WebhookSummary } from './client';
import { nextCronOccurrence } from './cron';

type ViewState = 'loading' | 'error' | 'ready';

export type PanelProps = { params: URLSearchParams; setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void };

// 页面内二级 Tab 的共享实现（spec 0001 §3.1）：`?tab=` 是唯一事实来源，
// Hooks & Events 与定时任务两个页面复用同一套 Tab 结构与样式，不各写一份（§17.4）。
export type PanelTab<T extends string> = { id: T; label: TranslationKey; icon: typeof WebhookIcon };

// 切换工作面时关闭表单与详情，Events 各页签分别恢复自己的搜索和筛选。
const surfaceContextKeys = ['create', 'edit', 'deliveryId', 'cursor'];

export function PanelTabNav<T extends string>({ active, idPrefix, label, tabs }: {
  active: T; idPrefix: string; label: string; tabs: ReadonlyArray<PanelTab<T>>;
}) {
  const { t } = useI18n();
  const { pathname, search } = useLocation();
  const tabSearches = useRef<Record<string, string>>({});
  tabSearches.current[active] = search;
  // 每个 Tab 都是真实链接：工作面可分享、可新标签页打开、可前进后退，
  // Events 目标 URL 来自该页签上次的 query，避免搜索、来源和状态筛选串用。
  const linkTo = (id: T) => {
    const next = new URLSearchParams(idPrefix === 'events' ? tabSearches.current[id] ?? '' : search);
    for (const key of surfaceContextKeys) next.delete(key);
    next.set('tab', id);
    const serialized = next.toString();
    return `${pathname}${serialized ? `?${serialized}` : ''}`;
  };
  return <nav aria-label={label} className="flex flex-wrap items-center gap-1 overflow-x-auto overflow-y-hidden" data-panel-tabs={idPrefix}>
    {tabs.map(({ id, label: tabLabel, icon: Icon }) => {
      const selected = active === id;
      return <Link
        aria-current={selected ? 'page' : undefined}
        className={`inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium no-underline transition-colors  ${selected ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        id={`${idPrefix}-tab-${id}`}
        key={id}
        replace
        to={linkTo(id)}
      ><Icon aria-hidden="true" size={16} />{t(tabLabel)}</Link>;
    })}
  </nav>;
}

const validationTranslations: Record<string, TranslationKey> = {
  invalidName: 'automation.errors.invalidName', invalidWebhookUrl: 'automation.errors.invalidWebhookUrl',
  invalidSecretReference: 'automation.errors.invalidSecretReference', invalidCollection: 'automation.errors.invalidCollection',
  invalidEventType: 'automation.errors.invalidEventType', duplicateEventHook: 'automation.errors.duplicateEventHook',
  invalidCron: 'automation.errors.invalidCron', tooManyWebhooks: 'automation.errors.tooManyWebhooks',
  tooManyEventHooks: 'automation.errors.tooManyEventHooks', tooManyJobs: 'automation.errors.tooManyJobs',
};

function validationCode(error: unknown, path: string): string | undefined {
  if (!(error instanceof ApiClientError)) return undefined;
  return error.apiError.details.violations?.find((item) => item.path === path)?.code;
}

function safeErrorMessage(error: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (!(error instanceof ApiClientError)) return t('automation.common.requestFailed');
  const code = error.apiError.code;
  if (code === 'VALIDATION_FAILED') return t('automation.errors.validation');
  if (code === 'UNAUTHENTICATED') return t('automation.errors.unauthenticated');
  if (code === 'DELIVERY_CAPACITY_EXCEEDED') return t('automation.deliveries.capacity');
  if (code === 'DELIVERY_NOT_RETRYABLE') return t('automation.deliveries.errors.deliveryNotRetryable');
  return t('automation.common.requestFailed');
}

function fieldErrorMessage(error: unknown, path: string, t: ReturnType<typeof useI18n>['t']): string | undefined {
  const code = validationCode(error, path);
  const key = code ? validationTranslations[code] : undefined;
  return key ? t(key) : undefined;
}

export function WebhooksPanel({ params, setParams }: PanelProps) {
  const { t, formatDate } = useI18n();
  const navigate = useNavigate();
  const [items, setItems] = useState<WebhookSummary[]>([]);
  const [secrets, setSecrets] = useState<SecretOption[]>([]);
  const [secretsUnavailable, setSecretsUnavailable] = useState(false);
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [savedId, setSavedId] = useState<string>();
  const [disableItem, setDisableItem] = useState<WebhookSummary>();
  const search = params.get('q') ?? '';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    // Secret 列表只服务于表单与「可测试」判断：它加载失败时仍展示可用的 Webhook，
    // 并在页面内说明缺失的部分，而不是把整页降级为错误状态（spec 0001 §13.5）。
    void Promise.all([listWebhooks(controller.signal), listAutomationSecrets(controller.signal).catch(() => undefined)]).then(([webhooks, secretOptions]) => {
      if (controller.signal.aborted) return;
      setItems(webhooks);
      setSecrets(secretOptions ?? []);
      setSecretsUnavailable(secretOptions === undefined);
      setState('ready');
      setError(false);
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setState('error'); }
    });
    return () => controller.abort();
  }, [reload]);

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return items.filter((item) => item.id === savedId || !needle || item.name.toLocaleLowerCase().includes(needle));
  }, [items, savedId, search]);

  function updateSearch(value: string) {
    setSavedId(undefined);
    const next = new URLSearchParams(params);
    if (value) next.set('q', value); else next.delete('q');
    setParams(next, { replace: true });
  }

  const editId = params.get('edit');
  const creating = params.get('create') === '1';
  const editing = editId ? items.find((item) => item.id === editId) : undefined;
  const formOpen = creating || Boolean(editId);

  function closeForm() {
    const next = new URLSearchParams(params);
    next.delete('create');
    next.delete('edit');
    setParams(next);
  }

  async function sendTest(item: WebhookSummary) {
    setBusyId(item.id);
    try {
      const result = await sendWebhookTest(item.id);
      // 测试投递的真实结果只存在于投递历史：直接进入 Hooks & Events / 投递历史并打开该条记录。
      navigate(`/events?tab=deliveries&deliveryId=${encodeURIComponent(result.id)}&source=test`);
    } catch { setError(true); }
    finally { setBusyId(undefined); }
  }

  return <section aria-labelledby="automation-webhooks-heading" className="flex min-w-0 flex-col gap-4">
    <h2 className="sr-only" id="automation-webhooks-heading">{t('automation.tabs.webhooks')}</h2>
    <WorkspaceActions><div className="flex flex-wrap items-center justify-end gap-3">

      <Button onClick={() => { const next = new URLSearchParams(params); next.delete('edit'); next.set('create', '1'); setParams(next); }} type="button" variant="primary">{t('automation.webhooks.create')}</Button>
    </div></WorkspaceActions>
    <Surface className="flex flex-wrap items-center justify-between gap-3 border-t-0 pt-0" variant="section">
      <SearchInput aria-label={t('automation.common.search')} onChange={(event) => updateSearch(event.target.value)} placeholder={t('automation.common.searchPlaceholder')} value={search} className="min-w-[200px] flex-1 md:max-w-sm" />
      <span className="text-xs text-muted-foreground">{t('automation.webhooks.list')} · {visible.length}</span>
    </Surface>
    {notice && <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success" role="status"><Check aria-hidden="true" className="shrink-0" size={15} />{notice}</div>}
    {secretsUnavailable && <PartialState>{t('navigation.secrets')} · {t('automation.common.loadFailed')}</PartialState>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}
    {state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && error && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger" role="alert">{t('automation.common.requestFailed')}</p>}
    {state === 'ready' && visible.length === 0 && <EmptyState description={items.length ? t('automation.common.emptySearch') : t('automation.webhooks.emptyDescription')} title={items.length ? t('automation.common.emptySearch') : t('automation.webhooks.emptyTitle')}>{items.length > 0 && search && <Button onClick={() => updateSearch('')} size="small" type="button" variant="quiet">{t('automation.common.clearSearch')}</Button>}</EmptyState>}
    {visible.length > 0 && <div aria-label={t('automation.webhooks.list')} className="flex min-w-0 flex-col gap-2">
      {visible.map((item) => <article className="flex min-w-0 flex-wrap items-center gap-3 border-b px-1 py-4 last:border-b-0" data-automation-card key={item.id}>
        <div className="min-w-0 flex-1 basis-56"><h3 className="truncate text-sm font-semibold text-foreground">{item.name}</h3><p className="mt-0.5 break-words text-xs text-muted-foreground">{item.signingConfigured ? item.signingSecretName : t('automation.webhooks.secretUnavailable')} · {t('automation.common.updated', { date: formatDate(item.updatedAt) })}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('automation.common.enabled') : t('automation.common.disabled')}</StatusChip>
          <Button aria-label={t('automation.webhooks.edit', { name: item.name })} onClick={() => { const next = new URLSearchParams(params); next.delete('create'); next.set('edit', item.id); setParams(next); }} size="small" type="button" variant="secondary"><Pencil aria-hidden="true" size={14} />{t('automation.common.edit')}</Button>
          <Button disabled={busyId === item.id || (!item.enabled && !item.signingConfigured)} onClick={() => item.enabled ? setDisableItem(item) : void toggleWebhook(item, true)} size="small" type="button" variant={item.enabled ? 'danger' : 'secondary'}>{busyId === item.id ? t('automation.common.updating') : item.enabled ? t('automation.common.disable') : t('automation.common.enable')}</Button>
          <Button disabled={busyId === item.id || !item.signingConfigured} onClick={() => void sendTest(item)} size="small" type="button" variant="secondary">{busyId === item.id ? t('automation.webhooks.testing') : t('automation.webhooks.test')}</Button>
        </div>
      </article>)}
    </div>}
    {state === 'ready' && formOpen && (!editId || editing) && <WebhookForm key={editId ?? 'new'} editing={editing} secrets={secrets} onCancel={closeForm} onSaved={(created, id) => { setSavedId(id); setNotice(t(created ? 'automation.common.created' : 'automation.common.saved')); closeForm(); setReload((value) => value + 1); }} />}
    <Dialog closeLabel={t('automation.common.cancel')} open={Boolean(disableItem)} title={t('automation.webhooks.disableConfirmTitle')} onClose={() => setDisableItem(undefined)}>
      <p className="m-0 text-xs leading-relaxed text-ink-secondary">{t('automation.webhooks.disableWarning')}</p>
      <div className="flex flex-wrap justify-end gap-2 pt-3">
        <Button onClick={() => setDisableItem(undefined)} type="button" variant="quiet">{t('automation.common.cancel')}</Button>
        <Button disabled={Boolean(disableItem && busyId === disableItem.id)} onClick={() => disableItem && void toggleWebhook(disableItem, false)} type="button" variant="danger">{t('automation.webhooks.disableConfirmAction')}</Button>
      </div>
    </Dialog>
  </section>;

  async function toggleWebhook(item: WebhookSummary, enabled: boolean) {
    setBusyId(item.id);
    try {
      await setWebhookEnabled(item.id, enabled);
      setDisableItem(undefined);
      setReload((value) => value + 1);
    } catch { setError(true); }
    finally { setBusyId(undefined); }
  }
}

function WebhookForm({ editing, secrets, onCancel, onSaved }: {
  editing?: WebhookSummary; secrets: SecretOption[]; onCancel: () => void; onSaved: (created: boolean, id: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(editing?.name ?? '');
  const [targetUrl, setTargetUrl] = useState(editing?.targetUrl ?? '');
  const [secretId, setSecretId] = useState(editing?.signingSecretId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const nameError = fieldErrorMessage(error, '/name', t);
  const targetUrlError = fieldErrorMessage(error, '/targetUrl', t);
  const secretError = fieldErrorMessage(error, '/signingSecretId', t);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const input = { name: name.trim(), targetUrl: targetUrl.trim(), signingSecretId: secretId };
      const saved = editing ? await updateWebhook(editing.id, input) : await createWebhook(input);
      onSaved(!editing, saved.id);
    } catch (reason) { setError(reason); }
    finally { setSaving(false); }
  }

  return <Sheet open title={editing ? t('automation.webhooks.editTitle') : t('automation.webhooks.createTitle')} onClose={() => { if (!saving) onCancel(); }} closeLabel={t('automation.common.close')} size="wide">
    <form className="grid max-w-[64rem] gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-webhook-name" label={t('automation.common.name')}><Input autoComplete="off" id="automation-webhook-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} aria-invalid={Boolean(nameError)} aria-errormessage={nameError ? 'automation-webhook-name-error' : undefined} /></FormField>
        {nameError && <p className="m-0 text-xs font-semibold text-danger" id="automation-webhook-name-error" role="alert">{nameError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-webhook-target" hint={t('automation.webhooks.targetUrlHint')} label={t('automation.webhooks.targetUrl')}><Input autoComplete="url" id="automation-webhook-target" onChange={(event) => setTargetUrl(event.target.value)} required type="url" value={targetUrl} aria-invalid={Boolean(targetUrlError)} aria-errormessage={targetUrlError ? 'automation-webhook-target-error' : undefined} /></FormField>
        {targetUrlError && <p className="m-0 text-xs font-semibold text-danger" id="automation-webhook-target-error" role="alert">{targetUrlError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-webhook-secret" hint={t('automation.webhooks.writeOnly')} label={t('automation.webhooks.signingSecret')}><SelectField id="automation-webhook-secret" onValueChange={(selectedValue) => setSecretId(selectedValue)} required value={secretId} aria-invalid={Boolean(secretError)} aria-errormessage={secretError ? 'automation-webhook-secret-error' : undefined} options={[({ value: "", label: t('automation.webhooks.chooseSecret') }), editing && !secrets.some((secret) => secret.id === editing.signingSecretId) && ({ value: editing.signingSecretId, label: t('automation.webhooks.secretUnavailable'), disabled: true }), secrets.filter((secret) => secret.configured).map((secret) => ({ value: secret.id, label: secret.name }))]} /></FormField>
        {secretError && <p className="m-0 text-xs font-semibold text-danger" id="automation-webhook-secret-error" role="alert">{secretError}</p>}
      </div>
      {secrets.some((secret) => secret.configured)
        ? <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2"><Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('automation.webhooks.manageSecrets')}</Link></p>
        : <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.webhooks.noSecrets')} <Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('navigation.secrets')}</Link></p>}
      {!editing && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.webhooks.enableHint')}</p>}
      {error !== undefined && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger sm:col-span-2" role="alert">{safeErrorMessage(error, t)}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1 sm:col-span-2"><Button disabled={saving || !name.trim() || !targetUrl.trim() || !secretId || !secrets.some((secret) => secret.id === secretId && secret.configured)} type="submit" variant="primary">{saving ? t('automation.webhooks.saving') : t('automation.webhooks.save')}</Button><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    </form>
  </Sheet>;
}

export function EventHooksPanel({ params, setParams }: PanelProps) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<EventHookSummary[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [webhooksUnavailable, setWebhooksUnavailable] = useState(false);
  const [state, setState] = useState<ViewState>('loading');
  const [failedAction, setFailedAction] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [savedId, setSavedId] = useState<string>();
  const search = params.get('q') ?? '';
  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    // Webhook 列表只用于提示「目标 Webhook 已停用」：它失败时事件触发列表仍然可用。
    void Promise.all([listEventHooks(controller.signal), listAutomationCollections(controller.signal), listWebhooks(controller.signal).catch(() => undefined)]).then(([hooks, collectionOptions, webhookOptions]) => {
      if (controller.signal.aborted) return;
      setItems(hooks); setCollections(collectionOptions); setWebhooks(webhookOptions ?? []);
      setWebhooksUnavailable(webhookOptions === undefined);
      setState('ready');
    }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [reload]);
  const visible = useMemo(() => items.filter((item) => item.id === savedId || !search || `${item.name} ${item.collectionName} ${item.webhookName}`.toLowerCase().includes(search.toLowerCase())), [items, savedId, search]);
  const editId = params.get('edit');
  const editing = editId ? items.find((item) => item.id === editId) : undefined;
  const formOpen = params.get('create') === '1' || Boolean(editId);
  function updateSearch(value: string) {
    setSavedId(undefined); const next = new URLSearchParams(params); if (value) next.set('q', value); else next.delete('q'); setParams(next, { replace: true }); }
  function closeForm() { const next = new URLSearchParams(params); next.delete('create'); next.delete('edit'); setParams(next); }
  async function toggle(item: EventHookSummary) {
    setBusyId(item.id);
    try { await setEventHookEnabled(item.id, !item.enabled); setReload((value) => value + 1); }
    catch { setFailedAction(true); }
    finally { setBusyId(undefined); }
  }
  return <section aria-labelledby="automation-event-hooks-heading" className="flex min-w-0 flex-col gap-4">
    <h2 className="sr-only" id="automation-event-hooks-heading">{t('automation.tabs.eventHooks')}</h2>
    <WorkspaceActions><div className="flex flex-wrap items-center justify-end gap-3"><Button onClick={() => { const next = new URLSearchParams(params); next.delete('edit'); next.set('create', '1'); setParams(next); }} type="button" variant="primary">{t('automation.eventHooks.create')}</Button></div></WorkspaceActions>
    <Surface className="flex flex-wrap items-center justify-between gap-3 border-t-0 pt-0" variant="section"><SearchInput aria-label={t('automation.common.search')} onChange={(event) => updateSearch(event.target.value)} placeholder={t('automation.common.searchPlaceholder')} value={search} className="min-w-[200px] flex-1 md:max-w-sm" /><span className="text-xs text-muted-foreground">{t('automation.eventHooks.list')} · {visible.length}</span></Surface>
    {notice && <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success" role="status"><Check aria-hidden="true" className="shrink-0" size={15} />{notice}</div>}
    {failedAction && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger" role="alert">{t('automation.common.requestFailed')}</p>}
    {webhooksUnavailable && <PartialState>{t('automation.webhooks.list')} · {t('automation.common.loadFailed')}</PartialState>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}
    {state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && <EmptyState description={items.length ? t('automation.common.emptySearch') : t('automation.eventHooks.emptyDescription')} title={items.length ? t('automation.common.emptySearch') : t('automation.eventHooks.emptyTitle')}>{items.length > 0 && search && <Button onClick={() => updateSearch('')} size="small" type="button" variant="quiet">{t('automation.common.clearSearch')}</Button>}</EmptyState>}
    {state === 'ready' && visible.length > 0 && <div aria-label={t('automation.eventHooks.list')} className="flex min-w-0 flex-col gap-2">{visible.map((item) => <article className="flex min-w-0 flex-wrap items-center gap-3 border-b px-1 py-4 last:border-b-0" data-automation-card key={item.id}><div className="min-w-0 flex-1 basis-56"><h3 className="truncate text-sm font-semibold text-foreground">{item.name}</h3><p className="mt-0.5 break-words text-xs text-muted-foreground">{item.collectionName} · {t(`automation.eventHooks.eventTypes.${eventTypeKey(item.eventType)}` as TranslationKey)} · {item.webhookName} · {t('automation.common.updated', { date: formatDate(item.updatedAt) })}</p>{item.enabled && !webhooks.find((hook) => hook.id === item.webhookId)?.enabled && <p className="m-0 mt-1.5 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">{t('automation.eventHooks.webhookDormant')}</p>}</div><div className="ml-auto flex flex-wrap items-center justify-end gap-1.5"><StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('automation.common.enabled') : t('automation.common.disabled')}</StatusChip><Button aria-label={t('automation.eventHooks.edit', { name: item.name })} onClick={() => { const next = new URLSearchParams(params); next.delete('create'); next.set('edit', item.id); setParams(next); }} size="small" variant="secondary"><Pencil aria-hidden="true" size={14} />{t('automation.common.edit')}</Button><Button disabled={busyId === item.id} onClick={() => void toggle(item)} size="small" variant={item.enabled ? 'danger' : 'secondary'}>{busyId === item.id ? t('automation.common.updating') : item.enabled ? t('automation.common.disable') : t('automation.common.enable')}</Button></div></article>)}</div>}
    {state === 'ready' && formOpen && (!editId || editing) && <EventHookForm key={editId ?? 'new'} editing={editing} collections={collections} webhooks={webhooks} onCancel={closeForm} onSaved={(created, id) => { setSavedId(id); setNotice(t(created ? 'automation.common.created' : 'automation.common.saved')); closeForm(); setReload((value) => value + 1); }} />}
  </section>;
}

function eventTypeKey(type: string): string { return type === 'record.updated' ? 'updated' : type === 'record.deleted' ? 'deleted' : 'created'; }

function deliveryEventTypeLabel(type: string, t: ReturnType<typeof useI18n>['t']): string {
  if (type === 'record.created') return t('automation.eventHooks.eventTypes.created');
  if (type === 'record.updated') return t('automation.eventHooks.eventTypes.updated');
  if (type === 'record.deleted') return t('automation.eventHooks.eventTypes.deleted');
  return type;
}

function EventHookForm({ editing, collections, webhooks, onCancel, onSaved }: {
  editing?: EventHookSummary; collections: CollectionOption[]; webhooks: WebhookSummary[]; onCancel: () => void; onSaved: (created: boolean, id: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(editing?.name ?? '');
  const [collectionId, setCollectionId] = useState(editing?.collectionId ?? '');
  const [eventType, setEventType] = useState<EventHookInput['eventType']>(editing?.eventType ?? 'record.created');
  const [webhookId, setWebhookId] = useState(editing?.webhookId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(undefined);
    try { const input: EventHookInput = { name: name.trim(), collectionId, eventType, webhookId }; const saved = editing ? await updateEventHook(editing.id, input) : await createEventHook(input); onSaved(!editing, saved.id); }
    catch (reason) { setError(reason); }
    finally { setSaving(false); }
  }
  const nameError = fieldErrorMessage(error, '/name', t);
  const collectionError = fieldErrorMessage(error, '/collectionId', t);
  const eventTypeError = fieldErrorMessage(error, '/eventType', t);
  const webhookError = fieldErrorMessage(error, '/webhookId', t);
  return <Sheet open title={editing ? t('automation.eventHooks.editTitle') : t('automation.eventHooks.createTitle')} onClose={() => { if (!saving) onCancel(); }} closeLabel={t('automation.common.close')} size="wide">
    <form className="grid max-w-[64rem] gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-event-name" label={t('automation.common.name')}><Input autoComplete="off" id="automation-event-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} aria-invalid={Boolean(nameError)} /></FormField>
        {nameError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{nameError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-event-collection" label={t('automation.eventHooks.collection')}><SelectField aria-invalid={Boolean(collectionError)} id="automation-event-collection" onValueChange={(selectedValue) => setCollectionId(selectedValue)} required value={collectionId} options={[({ value: "", label: t('automation.eventHooks.chooseCollection') }), collections.map((item) => ({ value: item.id, label: item.name }))]} /></FormField>
        {collectionError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{collectionError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-event-type" label={t('automation.eventHooks.eventType')}><SelectField aria-invalid={Boolean(eventTypeError)} id="automation-event-type" onValueChange={(selectedValue) => setEventType(selectedValue as EventHookInput['eventType'])} value={eventType} options={[({ value: "record.created", label: t('automation.eventHooks.eventTypes.created') }), ({ value: "record.updated", label: t('automation.eventHooks.eventTypes.updated') }), ({ value: "record.deleted", label: t('automation.eventHooks.eventTypes.deleted') })]} /></FormField>
        {eventTypeError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{eventTypeError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-event-webhook" label={t('automation.eventHooks.webhook')}><SelectField aria-invalid={Boolean(webhookError)} id="automation-event-webhook" onValueChange={(selectedValue) => setWebhookId(selectedValue)} required value={webhookId} options={[({ value: "", label: t('automation.eventHooks.chooseWebhook') }), webhooks.map((item) => ({ value: item.id, label: <>{item.name}{item.enabled ? '' : ` · ${t('automation.common.disabled')}`}</> }))]} /></FormField>
        {webhookError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{webhookError}</p>}
      </div>
      {collections.length === 0 && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.eventHooks.noCollections')} <Link className="font-semibold text-primary hover:underline" to="/collections">{t('automation.eventHooks.collectionsLink')}</Link></p>}
      {webhooks.length === 0 && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.eventHooks.noWebhooks')} <Link className="font-semibold text-primary hover:underline" to="/events?tab=webhooks&create=1">{t('automation.eventHooks.createWebhookLink')}</Link></p>}
      <p className={`m-0 rounded-md border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-xs leading-relaxed text-warning sm:col-span-2`}>{t('automation.eventHooks.valuesNotice')}</p>
      {webhookId && !webhooks.find((item) => item.id === webhookId)?.enabled && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.eventHooks.webhookDormant')}</p>}
      {error !== undefined && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger sm:col-span-2" role="alert">{safeErrorMessage(error, t)}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1 sm:col-span-2"><Button disabled={saving || !name.trim() || !collectionId || !webhookId} type="submit" variant="primary">{saving ? t('automation.eventHooks.saving') : t('automation.eventHooks.save')}</Button><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    </form>
  </Sheet>;
}

// 手动运行的 422 是字段级校验：`/webhookId`（目标 Webhook 未启用）与 `/signingSecretId`
//（签名 Secret 未配置）对用户是同一个恢复动作，因此共用一条可恢复文案
//（automation-http-contract §/jobs/{jobId}/run）。
function jobRunErrorMessage(error: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (error instanceof ApiClientError) {
    const violations = error.apiError.details.violations ?? [];
    if (violations.some((item) => item.code === 'invalidWebhook' || item.code === 'invalidSecretReference')) {
      return t('schedules.runFailedWebhook');
    }
  }
  return t('automation.common.requestFailed');
}

export function JobsPanel({ onRunRecorded, params, setParams }: PanelProps & {
  /** 服务器已接受一次手动运行时通知宿主，让执行历史重新加载（spec 0001 §8）。 */
  onRunRecorded?: (deliveryId: string) => void;
}) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<JobSummary[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [webhooksUnavailable, setWebhooksUnavailable] = useState(false);
  const [state, setState] = useState<ViewState>('loading');
  const [failedAction, setFailedAction] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [savedId, setSavedId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [runResult, setRunResult] = useState<{ jobName: string; deliveryId: string }>();
  const [runFailure, setRunFailure] = useState<{ jobName: string; message: string }>();
  const search = params.get('q') ?? '';
  useEffect(() => {
    const controller = new AbortController(); setState('loading');
    // 与事件触发一致：Webhook 列表只影响「目标 Webhook 已停用」提示，不决定任务列表是否可用。
    void Promise.all([listJobs(controller.signal), listWebhooks(controller.signal).catch(() => undefined)]).then(([jobs, hooks]) => { if (!controller.signal.aborted) { setItems(jobs); setWebhooks(hooks ?? []); setWebhooksUnavailable(hooks === undefined); setState('ready'); } }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [reload]);
  const visible = useMemo(() => items.filter((item) => item.id === savedId || !search || `${item.name} ${item.webhookName}`.toLowerCase().includes(search.toLowerCase())), [items, savedId, search]);
  const editId = params.get('edit'); const editing = editId ? items.find((item) => item.id === editId) : undefined; const formOpen = params.get('create') === '1' || Boolean(editId);
  function updateSearch(value: string) { setSavedId(undefined); const next = new URLSearchParams(params); if (value) next.set('q', value); else next.delete('q'); setParams(next, { replace: true }); }
  function closeForm() { const next = new URLSearchParams(params); next.delete('create'); next.delete('edit'); setParams(next); }
  async function toggle(item: JobSummary) { setBusyId(item.id); try { await setJobEnabled(item.id, !item.enabled); setReload((value) => value + 1); } catch { setFailedAction(true); } finally { setBusyId(undefined); } }

  // 手动运行以服务器响应为准：只有 202 + Delivery 才算「已请求」，
  // 不显示乐观成功；终态 capacityExceeded 与 422 字段级校验都给出恢复路径。
  async function runNow(item: JobSummary) {
    setRunId(item.id);
    setRunResult(undefined);
    setRunFailure(undefined);
    try {
      const created = await runJob(item.id);
      if (created.status === 'failed' && created.errorCode === 'capacityExceeded') {
        setRunFailure({ jobName: item.name, message: t('schedules.runCapacityExceeded') });
        return;
      }
      setRunResult({ jobName: item.name, deliveryId: created.id });
      // 刷新任务列表（最近一次运行事实），并让执行历史重新加载。
      setReload((value) => value + 1);
      onRunRecorded?.(created.id);
    } catch (reason) {
      setRunFailure({ jobName: item.name, message: jobRunErrorMessage(reason, t) });
    } finally {
      setRunId(undefined);
    }
  }

  return <section aria-labelledby="automation-jobs-heading" className="flex min-w-0 flex-col gap-4">
    <h2 className="sr-only" id="automation-jobs-heading">{t('automation.tabs.jobs')}</h2>
    <WorkspaceActions><div className="flex flex-wrap items-center justify-end gap-3"><Button onClick={() => { const next = new URLSearchParams(params); next.delete('edit'); next.set('create', '1'); setParams(next); }} type="button" variant="primary">{t('automation.jobs.create')}</Button></div></WorkspaceActions>
    <Surface className="flex flex-wrap items-center justify-between gap-3 border-t-0 pt-0" variant="section"><SearchInput aria-label={t('automation.common.search')} onChange={(event) => updateSearch(event.target.value)} placeholder={t('automation.common.searchPlaceholder')} value={search} className="min-w-[200px] flex-1 md:max-w-sm" /><span className="text-xs text-muted-foreground">{t('automation.jobs.list')} · {visible.length}</span></Surface>
    {notice && <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success" role="status"><Check aria-hidden="true" className="shrink-0" size={15} />{notice}</div>}{failedAction && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger" role="alert">{t('automation.common.requestFailed')}</p>}
    {webhooksUnavailable && <PartialState>{t('automation.webhooks.list')} · {t('automation.common.loadFailed')}</PartialState>}
    {/* 手动运行结果耐久留在面板内：成功直达执行历史，失败说明恢复动作。 */}
    {runResult && <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success" role="status">
      <Check aria-hidden="true" className="shrink-0" size={15} />
      <span className="min-w-0 flex-1"><strong className="font-semibold">{runResult.jobName}</strong> · <span>{t('schedules.runRequested', { id: runResult.deliveryId })}</span></span>
      <CopyButton label={t('common.copy')} value={runResult.deliveryId} />
      {/* 链接文案与「执行历史」Tab 区分开，避免两个同名链接指向不同位置。 */}
      <Link className="font-semibold underline" to={`/schedules?tab=history&deliveryId=${encodeURIComponent(runResult.deliveryId)}`}>{t('schedules.openHistory')}</Link>
    </div>}
    {runFailure && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger" role="alert"><strong className="font-semibold">{runFailure.jobName}</strong> · <span>{runFailure.message}</span></p>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}{state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && <EmptyState description={items.length ? t('automation.common.emptySearch') : t('automation.jobs.emptyDescription')} title={items.length ? t('automation.common.emptySearch') : t('automation.jobs.emptyTitle')}>{items.length > 0 && search && <Button onClick={() => updateSearch('')} size="small" type="button" variant="quiet">{t('automation.common.clearSearch')}</Button>}</EmptyState>}
    {state === 'ready' && visible.length > 0 && <div aria-label={t('automation.jobs.list')} className="flex min-w-0 flex-col gap-2">
      {visible.map((item) => <article className="flex min-w-0 flex-wrap items-center gap-3 border-b px-1 py-4 last:border-b-0" data-automation-card key={item.id}>
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="truncate text-sm font-semibold text-foreground">{item.name}</h3>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.cron} UTC · {item.webhookName} · {t('automation.jobs.nextRun')}: {formatDate(item.nextRunAt)}</p>
          {item.enabled && !webhooksUnavailable && !webhooks.find((hook) => hook.id === item.webhookId)?.enabled && <p className="m-0 mt-1.5 text-xs text-warning">{t('automation.jobs.webhookDormant')}</p>}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('automation.common.enabled') : t('automation.common.disabled')}</StatusChip>
          <Button aria-label={t('automation.jobs.edit', { name: item.name })} onClick={() => { const next = new URLSearchParams(params); next.delete('create'); next.set('edit', item.id); setParams(next); }} size="small" type="button" variant="secondary"><Pencil aria-hidden="true" size={14} />{t('automation.common.edit')}</Button>
          <Button disabled={busyId === item.id || runId === item.id} onClick={() => void toggle(item)} size="small" variant={item.enabled ? 'danger' : 'secondary'}>{busyId === item.id ? t('automation.common.updating') : item.enabled ? t('automation.common.disable') : t('automation.common.enable')}</Button>
          <Button disabled={busyId === item.id || runId === item.id} onClick={() => void runNow(item)} size="small" type="button" variant="secondary">{runId === item.id ? t('schedules.running') : t('schedules.runNow')}</Button>
        </div>
      </article>)}
    </div>}
    {state === 'ready' && formOpen && (!editId || editing) && <JobForm key={editId ?? 'new'} editing={editing} webhooks={webhooks} onCancel={closeForm} onSaved={(created, id) => { setSavedId(id); setNotice(t(created ? 'automation.common.created' : 'automation.common.saved')); closeForm(); setReload((value) => value + 1); }} />}
  </section>;
}

function JobForm({ editing, webhooks, onCancel, onSaved }: { editing?: JobSummary; webhooks: WebhookSummary[]; onCancel: () => void; onSaved: (created: boolean, id: string) => void }) {
  const { t, formatDate } = useI18n();
  const [name, setName] = useState(editing?.name ?? ''); const [webhookId, setWebhookId] = useState(editing?.webhookId ?? ''); const [cron, setCron] = useState(editing?.cron ?? ''); const [now] = useState(() => new Date()); const [saving, setSaving] = useState(false); const [error, setError] = useState<unknown>();
  const next = nextCronOccurrence(cron, now); const validCron = Boolean(next);
  const nameError = fieldErrorMessage(error, '/name', t); const webhookError = fieldErrorMessage(error, '/webhookId', t); const cronError = fieldErrorMessage(error, '/cron', t);
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); setError(undefined); try { const input: JobInput = { name: name.trim(), webhookId, cron: cron.trim() }; const saved = editing ? await updateJob(editing.id, input) : await createJob(input); onSaved(!editing, saved.id); } catch (reason) { setError(reason); } finally { setSaving(false); } }
  return <Sheet open title={editing ? t('automation.jobs.editTitle') : t('automation.jobs.createTitle')} onClose={() => { if (!saving) onCancel(); }} closeLabel={t('automation.common.close')} size="wide">
    <form className="grid max-w-[64rem] gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-job-name" label={t('automation.common.name')}><Input autoComplete="off" id="automation-job-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} aria-invalid={Boolean(nameError)} /></FormField>
        {nameError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{nameError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-job-webhook" label={t('automation.common.webhook')}><SelectField aria-invalid={Boolean(webhookError)} id="automation-job-webhook" onValueChange={(selectedValue) => setWebhookId(selectedValue)} required value={webhookId} options={[({ value: "", label: t('automation.eventHooks.chooseWebhook') }), webhooks.map((item) => ({ value: item.id, label: <>{item.name}{item.signingConfigured ? '' : ` · ${t('automation.webhooks.secretUnavailable')}`}</> }))]} /></FormField>
        {webhookError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{webhookError}</p>}
      </div>
      <div className="grid content-start gap-1.5">
        <FormField htmlFor="automation-job-cron" hint={t('automation.jobs.cronHint')} label={t('automation.jobs.cron')}><Input autoComplete="off" id="automation-job-cron" onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * *" required value={cron} aria-invalid={Boolean(cron.trim()) && !validCron} /></FormField>
        {Boolean(cron.trim()) && !validCron && <p className="m-0 text-xs font-semibold text-danger" role="alert">{cronError ?? t('automation.jobs.cronInvalid')}</p>}{validCron && cronError && <p className="m-0 text-xs font-semibold text-danger" role="alert">{cronError}</p>}
      </div>
      {webhooks.length === 0 && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.jobs.noWebhooks')} <Link className="font-semibold text-primary hover:underline" to="/events?tab=webhooks&create=1">{t('automation.jobs.createWebhookLink')}</Link></p>}
      {validCron && next && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2"><strong>{t('automation.jobs.nextRunPreview')}:</strong> {formatDate(next, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</p>}
      {editing && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.jobs.disabledDueHint')}</p>}
      {webhookId && !webhooks.find((item) => item.id === webhookId)?.enabled && <p className="m-0 text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('automation.jobs.webhookDormant')}</p>}
      {error !== undefined && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger sm:col-span-2" role="alert">{safeErrorMessage(error, t)}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1 sm:col-span-2"><Button disabled={saving || !name.trim() || !webhookId || !validCron} type="submit" variant="primary">{saving ? t('automation.jobs.saving') : t('automation.jobs.save')}</Button><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    </form>
  </Sheet>;
}

export type DeliveriesPanelCopy = { title: string; description: string; emptyTitle?: string; emptyDescription?: string };

export function DeliveriesPanel({ copy, fixedSourceType, params, reloadKey = 0, setParams, showTriggerColumn = fixedSourceType === 'job' }: PanelProps & {
  /** 固定来源时隐藏来源筛选并始终按该来源查询：定时任务执行历史 = job（spec 0001 §3.2）。 */
  fixedSourceType?: DeliverySourceType;
  /** 由投递事件的 eventType 推导的「触发方式」列，只对定时任务执行历史有意义。 */
  showTriggerColumn?: boolean;
  /** 执行历史 Tab 的专属标题、说明与空态文案。 */
  copy?: DeliveriesPanelCopy;
  /** 外部触发重新加载的信号（例如刚刚请求了一次手动运行）。 */
  reloadKey?: number;
}) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<Awaited<ReturnType<typeof listDeliveries>>['data']>([]);
  const [detail, setDetail] = useState<DeliveryDetail>(); const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>(); const [state, setState] = useState<ViewState>('loading'); const [reload, setReload] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>(); const [partial, setPartial] = useState(false);
  const requestedSource = params.get('source'); const source = fixedSourceType ?? (validSource(requestedSource) ? requestedSource : undefined); const status = params.get('status') as DeliveryStatus | null; const cursor = params.get('cursor') ?? undefined; const deliveryId = params.get('deliveryId');
  useEffect(() => {
    const controller = new AbortController(); setState('loading'); setPartial(false);
    // 投递列表是主体，详情与 Webhook 修订只是辅助信息：辅助请求失败时保留可用列表（§13.5）。
    void Promise.all([
      listDeliveries({ cursor, limit: 50, sourceType: source, status: validStatus(status) ? status : undefined }, controller.signal),
      deliveryId ? getDelivery(deliveryId, controller.signal).catch(() => undefined) : Promise.resolve(undefined),
      deliveryId ? listWebhooks(controller.signal).catch(() => undefined) : Promise.resolve(undefined),
    ]).then(([page, selected, hooks]) => { if (!controller.signal.aborted) { setItems(page.data); setNextCursor(page.nextCursor); setDetail(selected); setWebhooks(hooks ?? []); setPartial(Boolean(deliveryId) && (selected === undefined || hooks === undefined)); setState('ready'); setError(undefined); } }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [cursor, deliveryId, reload, reloadKey, source, status]);
  function changeFilter(key: 'source' | 'status', value: string) { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); next.delete('cursor'); next.delete('deliveryId'); setParams(next); }
  function closeDetail() { const next = new URLSearchParams(params); next.delete('deliveryId'); setParams(next); }
  async function retry() { if (!detail) return; setBusy(true); setError(undefined); setNotice(undefined); try { await retryDelivery(detail.id); setNotice(t('automation.deliveries.retrySuccess')); setReload((value) => value + 1); } catch (reason) { setError(safeErrorMessage(reason, t)); } finally { setBusy(false); } }
  const currentWebhook = detail ? webhooks.find((item) => item.id === detail.webhookId) : undefined;
  const lastAttempt = detail?.attempts.at(-1);
  const configChanged = Boolean(lastAttempt && currentWebhook && currentWebhook.revision !== lastAttempt.webhookRevision);
  const canRetry = Boolean(detail && detail.status === 'failed' && detail.errorCode !== 'capacityExceeded' && detail.manualRedriveCount < 3 && currentWebhook?.enabled && currentWebhook.signingConfigured);
  const headingId = fixedSourceType ? `${fixedSourceType}-deliveries-heading` : 'automation-deliveries-heading';
  const title = copy?.title ?? t('automation.deliveries.list');
  return <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
    <h2 className="sr-only" id={headingId}>{title}</h2>
    <WorkspaceActions><div className="flex flex-wrap items-center justify-end gap-3"><Button disabled={state === 'loading'} onClick={() => setReload((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={15} />{t('automation.common.refresh')}</Button></div></WorkspaceActions>
    <Surface className="flex flex-wrap items-end justify-between gap-3 border-t-0 pt-0" variant="section"><div aria-label={t('automation.deliveries.filters')} className="flex flex-wrap items-end gap-3">{!fixedSourceType && <Label className="grid gap-1 text-xs font-semibold text-ink-secondary">{t('automation.deliveries.source')}<SelectField aria-label={t('automation.deliveries.source')} onValueChange={(selectedValue) => changeFilter('source', selectedValue)} value={requestedSource ?? ''} options={[({ value: "", label: t('automation.deliveries.allSources') }), ({ value: "eventHook", label: t('automation.sources.eventHook') }), ({ value: "job", label: t('automation.sources.job') }), ({ value: "test", label: t('automation.sources.test') })]} /></Label>}<Label className="grid gap-1 text-xs font-semibold text-ink-secondary">{t('automation.deliveries.status')}<SelectField aria-label={t('automation.deliveries.status')} onValueChange={(selectedValue) => changeFilter('status', selectedValue)} value={status ?? ''} options={[({ value: "", label: t('automation.deliveries.allStatuses') }), (['pending', 'running', 'succeeded', 'failed', 'cancelled'] as DeliveryStatus[]).map((value) => ({ value: value, label: t(`automation.statuses.${value}` as TranslationKey) }))]} /></Label></div><span className="text-xs text-muted-foreground">{items.length}</span></Surface>
    {notice && <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success" role="status"><Check aria-hidden="true" className="shrink-0" size={15} />{notice}</div>}{error && <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-xs text-danger" role="alert">{error}</p>}
    {partial && <PartialState>{t('automation.deliveries.detail')} · {t('automation.common.loadFailed')}</PartialState>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}{state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && items.length === 0 && <EmptyState description={copy?.emptyDescription ?? t('automation.deliveries.emptyDescription')} title={copy?.emptyTitle ?? t('automation.deliveries.emptyTitle')} />}
    {state === 'ready' && items.length > 0 && <div aria-label={t('automation.deliveries.list')} className="flex min-w-0 flex-col gap-2">{items.map((item) => <article className={`flex min-w-0 flex-wrap items-center gap-3 border-b px-1 py-4 last:border-b-0${item.status === 'failed' ? ' border-danger/30' : ''}`} data-automation-card key={item.id}><div className="min-w-0 flex-1 basis-56"><h3 className="truncate text-sm font-semibold text-foreground">{item.webhookName}</h3><p className="mt-0.5 break-words text-xs text-muted-foreground">{t(`automation.sources.${item.sourceType}` as TranslationKey)} · {deliveryEventTypeLabel(item.eventType, t)} · {formatDate(item.createdAt)}</p>{showTriggerColumn && <p className="mt-0.5 break-words text-xs text-muted-foreground"><span className="font-medium text-ink-secondary">{t('schedules.trigger')}</span>: <span>{deliveryTriggerLabel(item.eventType, t)}</span></p>}<p className="mt-0.5 break-words text-xs text-muted-foreground">{t('automation.deliveries.attempts')}: {item.attemptCount} · {item.lastHttpStatus ?? '—'}</p>{item.errorCode !== 'none' && <p className="m-0 mt-1.5 flex items-center gap-1.5 text-xs text-danger"><CircleAlert aria-hidden="true" className="shrink-0" size={14} />{errorLabel(item.errorCode, t)}</p>}</div><div className="ml-auto flex flex-wrap items-center justify-end gap-1.5"><StatusChip state={item.status}>{t(`automation.statuses.${item.status}` as TranslationKey)}</StatusChip><Button onClick={() => { const next = new URLSearchParams(params); next.set('deliveryId', item.id); setParams(next); }} size="small" variant="quiet">{t('automation.deliveries.view')}</Button></div></article>)}</div>}
    {state === 'ready' && nextCursor && <div className="flex flex-wrap items-center gap-2"><Button onClick={() => { const next = new URLSearchParams(params); next.set('cursor', nextCursor); setParams(next); }} type="button">{t('automation.common.next')}</Button></div>}
    {detail && <Sheet open title={detail.webhookName} onClose={closeDetail} closeLabel={t('automation.common.close')} size="wide">
      <p className="m-0 text-xs text-muted-foreground">{t(`automation.sources.${detail.sourceType}` as TranslationKey)} · {deliveryEventTypeLabel(detail.eventType, t)} · {t(`automation.statuses.${detail.status}` as TranslationKey)}</p>
      {configChanged && <p className="m-0 rounded-md border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-xs leading-relaxed text-warning">{t('automation.deliveries.configChanged')}</p>}
      <div className="border-t pt-4"><dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs"><dt className="text-muted-foreground">{t('automation.deliveries.deliveryId')}</dt><dd className="m-0 break-words"><code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">{detail.id}</code></dd><dt className="text-muted-foreground">{t('automation.deliveries.createdAt')}</dt><dd className="m-0 break-words text-ink-secondary">{formatDate(detail.createdAt)}</dd><dt className="text-muted-foreground">{t('automation.deliveries.outcome')}</dt><dd className="m-0 break-words text-ink-secondary">{errorLabel(detail.errorCode, t)}</dd><dt className="text-muted-foreground">{t('automation.deliveries.attempts')}</dt><dd className="m-0 break-words text-ink-secondary">{detail.attemptCount}</dd>{showTriggerColumn && <><dt className="text-muted-foreground">{t('schedules.trigger')}</dt><dd className="m-0 break-words text-ink-secondary">{deliveryTriggerLabel(detail.eventType, t)}</dd></>}</dl></div>
      <h4 className="m-0 text-sm font-semibold text-foreground">{t('automation.deliveries.attemptHistory')}</h4>{detail.attempts.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{t('automation.deliveries.noAttempts')}</p> : <Table><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead scope="col">{t('automation.deliveries.round')}</TableHead><TableHead scope="col">{t('automation.deliveries.attempt')}</TableHead><TableHead scope="col">{t('automation.deliveries.attemptStatus')}</TableHead><TableHead scope="col">{t('automation.deliveries.startedAt')}</TableHead><TableHead scope="col">{t('automation.deliveries.duration')}</TableHead><TableHead scope="col">{t('automation.deliveries.httpStatus')}</TableHead><TableHead scope="col">{t('automation.deliveries.errorCode')}</TableHead></TableRow></TableHeader><TableBody>{detail.attempts.map((attempt, index) => <TableRow key={`${attempt.round}-${attempt.attempt}-${index}`}><TableCell>{attempt.round}</TableCell><TableCell>{attempt.attempt}</TableCell><TableCell>{t(`automation.statuses.${attempt.status}` as TranslationKey)}</TableCell><TableCell>{formatDate(attempt.startedAt)}</TableCell><TableCell>{attempt.durationMs} ms</TableCell><TableCell>{attempt.httpStatus ?? '—'}</TableCell><TableCell>{errorLabel(attempt.errorCode, t)}</TableCell></TableRow>)}</TableBody></Table>}
      {detail.status === 'failed' && !canRetry && <p className="m-0 text-xs leading-relaxed text-ink-secondary">{detail.manualRedriveCount >= 3 ? t('automation.deliveries.retryLimit') : detail.errorCode === 'capacityExceeded' ? t('automation.deliveries.capacity') : t('automation.deliveries.retryUnavailable')}</p>}
      {canRetry && <div className="flex flex-wrap items-center gap-2 border-t pt-4"><Button disabled={busy} onClick={() => void retry()} type="button" variant="primary">{busy ? t('automation.deliveries.retrying') : t('automation.deliveries.retry')}</Button></div>}
    </Sheet>}
  </section>;
}

// 「触发方式」由投递事实推导：`job.manual` 来自手动运行，`job.scheduled` 来自计划槽位；
// 其它事件类型回落到事件标签，不猜测语义（automation-http-contract）。
function deliveryTriggerLabel(type: string, t: ReturnType<typeof useI18n>['t']): string {
  if (type === 'job.manual') return t('schedules.triggerManual');
  if (type === 'job.scheduled') return t('schedules.triggerSchedule');
  return deliveryEventTypeLabel(type, t);
}

function validSource(value: string | null | undefined): value is DeliverySourceType { return value === 'eventHook' || value === 'job' || value === 'test'; }
function validStatus(value: string | null): value is DeliveryStatus { return value === 'pending' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled'; }
function errorLabel(code: string, t: ReturnType<typeof useI18n>['t']): string { return code === 'none' ? t('automation.deliveries.noError') : t(`automation.errors.${code}` as TranslationKey); }
