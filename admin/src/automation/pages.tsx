import { useEffect, useMemo, useState } from 'react';
import { Activity, Clock3, Radio, Webhook as WebhookIcon } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Dialog, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { createEventHook, createJob, createWebhook, getDelivery, listAutomationCollections, listAutomationSecrets, listDeliveries, listEventHooks, listJobs, listWebhooks, retryDelivery, sendWebhookTest, setEventHookEnabled, setJobEnabled, setWebhookEnabled, updateEventHook, updateJob, updateWebhook, type CollectionOption, type DeliveryDetail, type DeliverySourceType, type DeliveryStatus, type EventHookInput, type EventHookSummary, type JobInput, type JobSummary, type SecretOption, type WebhookSummary } from './client';
import { nextCronOccurrence } from './cron';
import './automation.css';

type Tab = 'webhooks' | 'eventHooks' | 'jobs' | 'deliveries';
type ViewState = 'loading' | 'error' | 'ready';
const tabs: Array<{ id: Tab; icon: typeof WebhookIcon }> = [
  { id: 'webhooks', icon: WebhookIcon }, { id: 'eventHooks', icon: Radio },
  { id: 'jobs', icon: Clock3 }, { id: 'deliveries', icon: Activity },
];

function selectedTab(value: string | null): Tab {
  return value === 'eventHooks' || value === 'jobs' || value === 'deliveries' ? value : 'webhooks';
}

function automationCommandPath(context: { pathname: string; search: string }, tab: Tab, additions: Record<string, string> = {}): string {
  const current = new URLSearchParams(context.pathname === '/automations' ? context.search : '');
  const next = new URLSearchParams();
  const search = current.get('q');
  if (search) next.set('q', search);
  next.set('tab', tab);
  for (const [key, value] of Object.entries(additions)) next.set(key, value);
  return `/automations?${next.toString()}`;
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

export function AutomationPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const activeTab = selectedTab(params.get('tab'));
  const commands = useMemo<AdminCommand[]>(() => ([
    {
      id: 'automation.open-webhooks', category: 'commands.categories.automation', label: () => t('automation.tabs.webhooks'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'webhooks')),
    },
    {
      id: 'automation.open-event-hooks', category: 'commands.categories.automation', label: () => t('automation.tabs.eventHooks'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'eventHooks')),
    },
    {
      id: 'automation.open-jobs', category: 'commands.categories.automation', label: () => t('automation.tabs.jobs'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'jobs')),
    },
    {
      id: 'automation.open-deliveries', category: 'commands.categories.automation', label: () => t('commands.deliveryHistory'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'deliveries')),
    },
    {
      id: 'automation.create-webhook', category: 'commands.categories.automation', label: () => t('commands.createWebhook'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'webhooks', { create: '1' })),
    },
    {
      id: 'automation.create-event-hook', category: 'commands.categories.automation', label: () => t('commands.createEventHook'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'eventHooks', { create: '1' })),
    },
    {
      id: 'automation.create-job', category: 'commands.categories.automation', label: () => t('commands.createJob'),
      isVisible: (context) => context.pathname === '/automations',
      execute: (context) => context.navigate(automationCommandPath(context, 'jobs', { create: '1' })),
    },
  ]), [t]);
  useRegisterCommands(commands);

  function selectTab(tab: Tab) {
    const next = new URLSearchParams(params);
    next.set('tab', tab);
    setParams(next);
  }

  return <div className="page-stack automation-page">
    <header className="page-heading">
      <div><p className="eyebrow">{t('automation.eyebrow')}</p><h1>{t('automation.title')}</h1><p className="page-description">{t('automation.description')}</p></div>
    </header>
    <nav aria-label={t('automation.title')} className="automation-tabs" role="tablist">
      {tabs.map(({ id, icon: Icon }) => <button
        aria-selected={activeTab === id}
        className={`automation-tab${activeTab === id ? ' automation-tab--active' : ''}`}
        id={`automation-tab-${id}`}
        key={id}
        onClick={() => selectTab(id)}
        role="tab"
        type="button"
      ><Icon aria-hidden="true" size={16} />{t(`automation.tabs.${id}` as TranslationKey)}</button>)}
    </nav>
    {activeTab === 'webhooks' && <WebhooksPanel params={params} setParams={setParams} navigate={navigate} />}
    {activeTab === 'eventHooks' && <EventHooksPanel params={params} setParams={setParams} />}
    {activeTab === 'jobs' && <JobsPanel params={params} setParams={setParams} />}
    {activeTab === 'deliveries' && <DeliveriesPanel params={params} setParams={setParams} />}
  </div>;
}

function WebhooksPanel({ params, setParams, navigate }: {
  params: URLSearchParams; setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void; navigate: ReturnType<typeof useNavigate>;
}) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<WebhookSummary[]>([]);
  const [secrets, setSecrets] = useState<SecretOption[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [disableItem, setDisableItem] = useState<WebhookSummary>();
  const search = params.get('q') ?? '';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void Promise.all([listWebhooks(controller.signal), listAutomationSecrets(controller.signal)]).then(([webhooks, secretOptions]) => {
      if (controller.signal.aborted) return;
      setItems(webhooks);
      setSecrets(secretOptions);
      setState('ready');
      setError(false);
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setState('error'); }
    });
    return () => controller.abort();
  }, [reload]);

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return items.filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle));
  }, [items, search]);

  function updateSearch(value: string) {
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
      navigate(`/automations?tab=deliveries&deliveryId=${encodeURIComponent(result.id)}&source=test`);
    } catch { setError(true); }
    finally { setBusyId(undefined); }
  }

  return <section aria-labelledby="automation-webhooks-heading" className="automation-tab-content" role="tabpanel">
    <div className="automation-section-heading">
      <div><h2 id="automation-webhooks-heading">{t('automation.tabs.webhooks')}</h2><p>{t('automation.webhooks.description')}</p></div>
      <Button onClick={() => { const next = new URLSearchParams(params); next.delete('edit'); next.set('create', '1'); setParams(next); }} type="button" variant="primary">{t('automation.webhooks.create')}</Button>
    </div>
    <Surface className="automation-toolbar">
      <label className="automation-search"><span className="sr-only">{t('automation.common.search')}</span><input aria-label={t('automation.common.search')} onChange={(event) => updateSearch(event.target.value)} placeholder={t('automation.common.searchPlaceholder')} type="search" value={search} /></label>
      <span className="automation-count">{t('automation.webhooks.list')} · {visible.length}</span>
    </Surface>
    {notice && <div className="automation-notice" role="status">{notice}</div>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}
    {state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && error && <p className="automation-form-error" role="alert">{t('automation.common.requestFailed')}</p>}
    {state === 'ready' && visible.length === 0 && <EmptyState description={items.length ? t('automation.common.emptySearch') : t('automation.webhooks.emptyDescription')} title={items.length ? t('automation.common.emptySearch') : t('automation.webhooks.emptyTitle')}>{items.length > 0 && search && <Button onClick={() => updateSearch('')} size="small" type="button" variant="quiet">{t('automation.common.clearSearch')}</Button>}</EmptyState>}
    {visible.length > 0 && <div aria-label={t('automation.webhooks.list')} className="automation-list">
      {visible.map((item) => <Surface className="automation-card" key={item.id}>
        <div className="automation-card__main">
          <div><h3>{item.name}</h3><p>{item.signingConfigured ? item.signingSecretName : t('automation.webhooks.secretUnavailable')} · {t('automation.common.updated', { date: formatDate(item.updatedAt) })}</p></div>
          <StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('automation.common.enabled') : t('automation.common.disabled')}</StatusChip>
        </div>
        <div className="automation-card__actions">
          <Button onClick={() => { const next = new URLSearchParams(params); next.delete('create'); next.set('edit', item.id); setParams(next); }} size="small" type="button" variant="quiet">{t('automation.webhooks.edit', { name: item.name })}</Button>
          <Button disabled={busyId === item.id || (!item.enabled && !item.signingConfigured)} onClick={() => item.enabled ? setDisableItem(item) : void toggleWebhook(item, true)} size="small" type="button" variant={item.enabled ? 'danger' : 'secondary'}>{busyId === item.id ? t('automation.common.updating') : item.enabled ? t('automation.common.disable') : t('automation.common.enable')}</Button>
          <Button disabled={busyId === item.id || !item.signingConfigured} onClick={() => void sendTest(item)} size="small" type="button" variant="secondary">{busyId === item.id ? t('automation.webhooks.testing') : t('automation.webhooks.test')}</Button>
        </div>
      </Surface>)}
    </div>}
    {formOpen && <WebhookForm editing={editing} secrets={secrets} onCancel={closeForm} onSaved={(created) => { setNotice(t(created ? 'automation.common.created' : 'automation.common.saved')); closeForm(); setReload((value) => value + 1); }} />}
    <Dialog open={Boolean(disableItem)} title={t('automation.webhooks.disableConfirmTitle')} onClose={() => setDisableItem(undefined)}>
      <p>{t('automation.webhooks.disableWarning')}</p>
      <div className="automation-form-actions">
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
  editing?: WebhookSummary; secrets: SecretOption[]; onCancel: () => void; onSaved: (created: boolean) => void;
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
      if (editing) await updateWebhook(editing.id, input); else await createWebhook(input);
      onSaved(!editing);
    } catch (reason) { setError(reason); }
    finally { setSaving(false); }
  }

  return <Surface className="automation-form-card">
    <div className="automation-section-heading"><div><p className="eyebrow">{editing ? t('automation.common.edit') : t('automation.common.create')}</p><h3>{editing ? t('automation.webhooks.editTitle') : t('automation.webhooks.createTitle')}</h3></div><Button onClick={onCancel} size="small" type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    <form className="automation-form-grid" onSubmit={(event) => void submit(event)}>
      <FormField htmlFor="automation-webhook-name" label={t('automation.common.name')}><input autoComplete="off" id="automation-webhook-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} aria-invalid={Boolean(nameError)} aria-errormessage={nameError ? 'automation-webhook-name-error' : undefined} /></FormField>
      {nameError && <p className="automation-field-error" id="automation-webhook-name-error" role="alert">{nameError}</p>}
      <FormField htmlFor="automation-webhook-target" hint={t('automation.webhooks.targetUrlHint')} label={t('automation.webhooks.targetUrl')}><input autoComplete="url" id="automation-webhook-target" onChange={(event) => setTargetUrl(event.target.value)} required type="url" value={targetUrl} aria-invalid={Boolean(targetUrlError)} aria-errormessage={targetUrlError ? 'automation-webhook-target-error' : undefined} /></FormField>
      {targetUrlError && <p className="automation-field-error" id="automation-webhook-target-error" role="alert">{targetUrlError}</p>}
      <FormField htmlFor="automation-webhook-secret" hint={t('automation.webhooks.writeOnly')} label={t('automation.webhooks.signingSecret')}><select id="automation-webhook-secret" onChange={(event) => setSecretId(event.target.value)} required value={secretId} aria-invalid={Boolean(secretError)} aria-errormessage={secretError ? 'automation-webhook-secret-error' : undefined}><option value="">{t('automation.webhooks.chooseSecret')}</option>{editing && !secrets.some((secret) => secret.id === editing.signingSecretId) && <option disabled value={editing.signingSecretId}>{t('automation.webhooks.secretUnavailable')}</option>}{secrets.filter((secret) => secret.configured).map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}</select></FormField>
      {secretError && <p className="automation-field-error" id="automation-webhook-secret-error" role="alert">{secretError}</p>}
      {!secrets.some((secret) => secret.configured) && <p className="automation-inline-note">{t('automation.webhooks.noSecrets')} <Link className="text-link" to="/secrets">{t('navigation.secrets')}</Link></p>}
      {!editing && <p className="automation-inline-note">{t('automation.webhooks.enableHint')}</p>}
      {error !== undefined && <p className="automation-form-error" role="alert">{safeErrorMessage(error, t)}</p>}
      <div className="automation-form-actions"><Button disabled={saving || !name.trim() || !targetUrl.trim() || !secretId || !secrets.some((secret) => secret.id === secretId && secret.configured)} type="submit" variant="primary">{saving ? t('automation.webhooks.saving') : t('automation.webhooks.save')}</Button><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    </form>
  </Surface>;
}

type PanelProps = { params: URLSearchParams; setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void };

function EventHooksPanel({ params, setParams }: PanelProps) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<EventHookSummary[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [failedAction, setFailedAction] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const search = params.get('q') ?? '';
  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void Promise.all([listEventHooks(controller.signal), listAutomationCollections(controller.signal), listWebhooks(controller.signal)]).then(([hooks, collectionOptions, webhookOptions]) => {
      if (controller.signal.aborted) return;
      setItems(hooks); setCollections(collectionOptions); setWebhooks(webhookOptions); setState('ready');
    }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [reload]);
  const visible = useMemo(() => items.filter((item) => !search || `${item.name} ${item.collectionName} ${item.webhookName}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const editId = params.get('edit');
  const editing = editId ? items.find((item) => item.id === editId) : undefined;
  const formOpen = params.get('create') === '1' || Boolean(editId);
  function updateSearch(value: string) { const next = new URLSearchParams(params); if (value) next.set('q', value); else next.delete('q'); setParams(next, { replace: true }); }
  function closeForm() { const next = new URLSearchParams(params); next.delete('create'); next.delete('edit'); setParams(next); }
  async function toggle(item: EventHookSummary) {
    setBusyId(item.id);
    try { await setEventHookEnabled(item.id, !item.enabled); setReload((value) => value + 1); }
    catch { setFailedAction(true); }
    finally { setBusyId(undefined); }
  }
  return <section aria-labelledby="automation-event-hooks-heading" className="automation-tab-content" role="tabpanel">
    <div className="automation-section-heading"><div><h2 id="automation-event-hooks-heading">{t('automation.tabs.eventHooks')}</h2><p>{t('automation.eventHooks.description')}</p></div><Button onClick={() => { const next = new URLSearchParams(params); next.delete('edit'); next.set('create', '1'); setParams(next); }} type="button" variant="primary">{t('automation.eventHooks.create')}</Button></div>
    <Surface className="automation-toolbar"><label className="automation-search"><span className="sr-only">{t('automation.common.search')}</span><input aria-label={t('automation.common.search')} onChange={(event) => updateSearch(event.target.value)} placeholder={t('automation.common.searchPlaceholder')} type="search" value={search} /></label><span className="automation-count">{t('automation.eventHooks.list')} · {visible.length}</span></Surface>
    {notice && <p className="automation-notice" role="status">{notice}</p>}
    {failedAction && <p className="automation-form-error" role="alert">{t('automation.common.requestFailed')}</p>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}
    {state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && <EmptyState description={items.length ? t('automation.common.emptySearch') : t('automation.eventHooks.emptyDescription')} title={items.length ? t('automation.common.emptySearch') : t('automation.eventHooks.emptyTitle')}>{items.length > 0 && search && <Button onClick={() => updateSearch('')} size="small" type="button" variant="quiet">{t('automation.common.clearSearch')}</Button>}</EmptyState>}
    {state === 'ready' && visible.length > 0 && <div aria-label={t('automation.eventHooks.list')} className="automation-list">{visible.map((item) => <Surface className="automation-card" key={item.id}><div className="automation-card__main"><div><h3>{item.name}</h3><p>{item.collectionName} · {t(`automation.eventHooks.eventTypes.${eventTypeKey(item.eventType)}` as TranslationKey)} · {item.webhookName}</p><p>{t('automation.common.updated', { date: formatDate(item.updatedAt) })}</p>{item.enabled && !webhooks.find((hook) => hook.id === item.webhookId)?.enabled && <p className="automation-inline-note">{t('automation.eventHooks.webhookDormant')}</p>}</div><StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('automation.common.enabled') : t('automation.common.disabled')}</StatusChip></div><div className="automation-card__actions"><Button onClick={() => { const next = new URLSearchParams(params); next.delete('create'); next.set('edit', item.id); setParams(next); }} size="small" variant="quiet">{t('automation.eventHooks.edit', { name: item.name })}</Button><Button disabled={busyId === item.id} onClick={() => void toggle(item)} size="small" variant={item.enabled ? 'danger' : 'secondary'}>{busyId === item.id ? t('automation.common.updating') : item.enabled ? t('automation.common.disable') : t('automation.common.enable')}</Button></div></Surface>)}</div>}
    {state === 'ready' && formOpen && <EventHookForm editing={editing} collections={collections} webhooks={webhooks} onCancel={closeForm} onSaved={(created) => { setNotice(t(created ? 'automation.common.created' : 'automation.common.saved')); closeForm(); setReload((value) => value + 1); }} />}
  </section>;
}

function eventTypeKey(type: string): string { return type === 'record.updated' ? 'updated' : type === 'record.deleted' ? 'deleted' : 'created'; }

function EventHookForm({ editing, collections, webhooks, onCancel, onSaved }: {
  editing?: EventHookSummary; collections: CollectionOption[]; webhooks: WebhookSummary[]; onCancel: () => void; onSaved: (created: boolean) => void;
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
    try { const input: EventHookInput = { name: name.trim(), collectionId, eventType, webhookId }; if (editing) await updateEventHook(editing.id, input); else await createEventHook(input); onSaved(!editing); }
    catch (reason) { setError(reason); }
    finally { setSaving(false); }
  }
  const nameError = fieldErrorMessage(error, '/name', t);
  const collectionError = fieldErrorMessage(error, '/collectionId', t);
  const eventTypeError = fieldErrorMessage(error, '/eventType', t);
  const webhookError = fieldErrorMessage(error, '/webhookId', t);
  return <Surface className="automation-form-card"><div className="automation-section-heading"><div><p className="eyebrow">{editing ? t('automation.common.edit') : t('automation.common.create')}</p><h3>{editing ? t('automation.eventHooks.editTitle') : t('automation.eventHooks.createTitle')}</h3></div><Button onClick={onCancel} size="small" type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    <form className="automation-form-grid" onSubmit={(event) => void submit(event)}>
      <FormField htmlFor="automation-event-name" label={t('automation.common.name')}><input autoComplete="off" id="automation-event-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} aria-invalid={Boolean(nameError)} /></FormField>
      {nameError && <p className="automation-field-error" role="alert">{nameError}</p>}
      <FormField htmlFor="automation-event-collection" label={t('automation.eventHooks.collection')}><select aria-invalid={Boolean(collectionError)} id="automation-event-collection" onChange={(event) => setCollectionId(event.target.value)} required value={collectionId}><option value="">{t('automation.eventHooks.chooseCollection')}</option>{collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>{collectionError && <p className="automation-field-error" role="alert">{collectionError}</p>}
      <FormField htmlFor="automation-event-type" label={t('automation.eventHooks.eventType')}><select aria-invalid={Boolean(eventTypeError)} id="automation-event-type" onChange={(event) => setEventType(event.target.value as EventHookInput['eventType'])} value={eventType}><option value="record.created">{t('automation.eventHooks.eventTypes.created')}</option><option value="record.updated">{t('automation.eventHooks.eventTypes.updated')}</option><option value="record.deleted">{t('automation.eventHooks.eventTypes.deleted')}</option></select></FormField>{eventTypeError && <p className="automation-field-error" role="alert">{eventTypeError}</p>}
      <FormField htmlFor="automation-event-webhook" label={t('automation.eventHooks.webhook')}><select aria-invalid={Boolean(webhookError)} id="automation-event-webhook" onChange={(event) => setWebhookId(event.target.value)} required value={webhookId}><option value="">{t('automation.eventHooks.chooseWebhook')}</option>{webhooks.map((item) => <option key={item.id} value={item.id}>{item.name}{item.enabled ? '' : ` · ${t('automation.common.disabled')}`}</option>)}</select></FormField>{webhookError && <p className="automation-field-error" role="alert">{webhookError}</p>}
      {collections.length === 0 && <p className="automation-inline-note">{t('automation.eventHooks.noCollections')} <Link className="text-link" to="/collections">{t('automation.eventHooks.collectionsLink')}</Link></p>}
      {webhooks.length === 0 && <p className="automation-inline-note">{t('automation.eventHooks.noWebhooks')} <Link className="text-link" to="/automations?tab=webhooks&create=1">{t('automation.eventHooks.createWebhookLink')}</Link></p>}
      <p className="automation-warning">{t('automation.eventHooks.valuesNotice')}</p>
      {webhookId && !webhooks.find((item) => item.id === webhookId)?.enabled && <p className="automation-inline-note">{t('automation.eventHooks.webhookDormant')}</p>}
      {error !== undefined && <p className="automation-form-error" role="alert">{safeErrorMessage(error, t)}</p>}
      <div className="automation-form-actions"><Button disabled={saving || !name.trim() || !collectionId || !webhookId} type="submit" variant="primary">{saving ? t('automation.eventHooks.saving') : t('automation.eventHooks.save')}</Button><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    </form>
  </Surface>;
}

function JobsPanel({ params, setParams }: PanelProps) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<JobSummary[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [failedAction, setFailedAction] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const search = params.get('q') ?? '';
  useEffect(() => {
    const controller = new AbortController(); setState('loading');
    void Promise.all([listJobs(controller.signal), listWebhooks(controller.signal)]).then(([jobs, hooks]) => { if (!controller.signal.aborted) { setItems(jobs); setWebhooks(hooks); setState('ready'); } }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [reload]);
  const visible = useMemo(() => items.filter((item) => !search || `${item.name} ${item.webhookName}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const editId = params.get('edit'); const editing = editId ? items.find((item) => item.id === editId) : undefined; const formOpen = params.get('create') === '1' || Boolean(editId);
  function updateSearch(value: string) { const next = new URLSearchParams(params); if (value) next.set('q', value); else next.delete('q'); setParams(next, { replace: true }); }
  function closeForm() { const next = new URLSearchParams(params); next.delete('create'); next.delete('edit'); setParams(next); }
  async function toggle(item: JobSummary) { setBusyId(item.id); try { await setJobEnabled(item.id, !item.enabled); setReload((value) => value + 1); } catch { setFailedAction(true); } finally { setBusyId(undefined); } }
  return <section aria-labelledby="automation-jobs-heading" className="automation-tab-content" role="tabpanel">
    <div className="automation-section-heading"><div><h2 id="automation-jobs-heading">{t('automation.tabs.jobs')}</h2><p>{t('automation.jobs.description')}</p></div><Button onClick={() => { const next = new URLSearchParams(params); next.delete('edit'); next.set('create', '1'); setParams(next); }} type="button" variant="primary">{t('automation.jobs.create')}</Button></div>
    <Surface className="automation-toolbar"><label className="automation-search"><span className="sr-only">{t('automation.common.search')}</span><input aria-label={t('automation.common.search')} onChange={(event) => updateSearch(event.target.value)} placeholder={t('automation.common.searchPlaceholder')} type="search" value={search} /></label><span className="automation-count">{t('automation.jobs.list')} · {visible.length}</span></Surface>
    {notice && <p className="automation-notice" role="status">{notice}</p>}{failedAction && <p className="automation-form-error" role="alert">{t('automation.common.requestFailed')}</p>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}{state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && <EmptyState description={items.length ? t('automation.common.emptySearch') : t('automation.jobs.emptyDescription')} title={items.length ? t('automation.common.emptySearch') : t('automation.jobs.emptyTitle')}>{items.length > 0 && search && <Button onClick={() => updateSearch('')} size="small" type="button" variant="quiet">{t('automation.common.clearSearch')}</Button>}</EmptyState>}
    {state === 'ready' && visible.length > 0 && <div aria-label={t('automation.jobs.list')} className="automation-list">{visible.map((item) => <Surface className="automation-card" key={item.id}><div className="automation-card__main"><div><h3>{item.name}</h3><p>{item.cron} UTC · {item.webhookName}</p><p>{t('automation.jobs.nextRun')}: {formatDate(item.nextRunAt)}</p>{item.enabled && !webhooks.find((hook) => hook.id === item.webhookId)?.enabled && <p className="automation-inline-note">{t('automation.jobs.webhookDormant')}</p>}</div><StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('automation.common.enabled') : t('automation.common.disabled')}</StatusChip></div><div className="automation-card__actions"><Button onClick={() => { const next = new URLSearchParams(params); next.delete('create'); next.set('edit', item.id); setParams(next); }} size="small" variant="quiet">{t('automation.jobs.edit', { name: item.name })}</Button><Button disabled={busyId === item.id} onClick={() => void toggle(item)} size="small" variant={item.enabled ? 'danger' : 'secondary'}>{busyId === item.id ? t('automation.common.updating') : item.enabled ? t('automation.common.disable') : t('automation.common.enable')}</Button></div></Surface>)}</div>}
    {state === 'ready' && formOpen && <JobForm editing={editing} webhooks={webhooks} onCancel={closeForm} onSaved={(created) => { setNotice(t(created ? 'automation.common.created' : 'automation.common.saved')); closeForm(); setReload((value) => value + 1); }} />}
  </section>;
}

function JobForm({ editing, webhooks, onCancel, onSaved }: { editing?: JobSummary; webhooks: WebhookSummary[]; onCancel: () => void; onSaved: (created: boolean) => void }) {
  const { t, formatDate } = useI18n();
  const [name, setName] = useState(editing?.name ?? ''); const [webhookId, setWebhookId] = useState(editing?.webhookId ?? ''); const [cron, setCron] = useState(editing?.cron ?? ''); const [now] = useState(() => new Date()); const [saving, setSaving] = useState(false); const [error, setError] = useState<unknown>();
  const next = nextCronOccurrence(cron, now); const validCron = Boolean(next);
  const nameError = fieldErrorMessage(error, '/name', t); const webhookError = fieldErrorMessage(error, '/webhookId', t); const cronError = fieldErrorMessage(error, '/cron', t);
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setSaving(true); setError(undefined); try { const input: JobInput = { name: name.trim(), webhookId, cron: cron.trim() }; if (editing) await updateJob(editing.id, input); else await createJob(input); onSaved(!editing); } catch (reason) { setError(reason); } finally { setSaving(false); } }
  return <Surface className="automation-form-card"><div className="automation-section-heading"><div><p className="eyebrow">{editing ? t('automation.common.edit') : t('automation.common.create')}</p><h3>{editing ? t('automation.jobs.editTitle') : t('automation.jobs.createTitle')}</h3></div><Button onClick={onCancel} size="small" type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    <form className="automation-form-grid" onSubmit={(event) => void submit(event)}>
      <FormField htmlFor="automation-job-name" label={t('automation.common.name')}><input autoComplete="off" id="automation-job-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} aria-invalid={Boolean(nameError)} /></FormField>{nameError && <p className="automation-field-error" role="alert">{nameError}</p>}
      <FormField htmlFor="automation-job-webhook" label={t('automation.common.webhook')}><select aria-invalid={Boolean(webhookError)} id="automation-job-webhook" onChange={(event) => setWebhookId(event.target.value)} required value={webhookId}><option value="">{t('automation.eventHooks.chooseWebhook')}</option>{webhooks.map((item) => <option key={item.id} value={item.id}>{item.name}{item.signingConfigured ? '' : ` · ${t('automation.webhooks.secretUnavailable')}`}</option>)}</select></FormField>{webhookError && <p className="automation-field-error" role="alert">{webhookError}</p>}
      <FormField htmlFor="automation-job-cron" hint={t('automation.jobs.cronHint')} label={t('automation.jobs.cron')}><input autoComplete="off" id="automation-job-cron" onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * *" required value={cron} aria-invalid={Boolean(cron.trim()) && !validCron} /></FormField>{Boolean(cron.trim()) && !validCron && <p className="automation-field-error" role="alert">{cronError ?? t('automation.jobs.cronInvalid')}</p>}{validCron && cronError && <p className="automation-field-error" role="alert">{cronError}</p>}
      {webhooks.length === 0 && <p className="automation-inline-note">{t('automation.jobs.noWebhooks')} <Link className="text-link" to="/automations?tab=webhooks&create=1">{t('automation.jobs.createWebhookLink')}</Link></p>}
      {validCron && next && <p className="automation-inline-note"><strong>{t('automation.jobs.nextRunPreview')}:</strong> {formatDate(next, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</p>}
      {editing && <p className="automation-inline-note">{t('automation.jobs.disabledDueHint')}</p>}
      {webhookId && !webhooks.find((item) => item.id === webhookId)?.enabled && <p className="automation-inline-note">{t('automation.jobs.webhookDormant')}</p>}
      {error !== undefined && <p className="automation-form-error" role="alert">{safeErrorMessage(error, t)}</p>}
      <div className="automation-form-actions"><Button disabled={saving || !name.trim() || !webhookId || !validCron} type="submit" variant="primary">{saving ? t('automation.jobs.saving') : t('automation.jobs.save')}</Button><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('automation.common.cancel')}</Button></div>
    </form>
  </Surface>;
}

function DeliveriesPanel({ params, setParams }: PanelProps) {
  const { t, formatDate } = useI18n();
  const [items, setItems] = useState<Awaited<ReturnType<typeof listDeliveries>>['data']>([]);
  const [detail, setDetail] = useState<DeliveryDetail>(); const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>(); const [state, setState] = useState<ViewState>('loading'); const [reload, setReload] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>();
  const source = params.get('source') as DeliverySourceType | null; const status = params.get('status') as DeliveryStatus | null; const cursor = params.get('cursor') ?? undefined; const deliveryId = params.get('deliveryId');
  useEffect(() => {
    const controller = new AbortController(); setState('loading');
    void Promise.all([listDeliveries({ cursor, limit: 50, sourceType: validSource(source) ? source : undefined, status: validStatus(status) ? status : undefined }, controller.signal), deliveryId ? getDelivery(deliveryId, controller.signal) : Promise.resolve(undefined), deliveryId ? listWebhooks(controller.signal) : Promise.resolve([])]).then(([page, selected, hooks]) => { if (!controller.signal.aborted) { setItems(page.data); setNextCursor(page.nextCursor); setDetail(selected); setWebhooks(hooks); setState('ready'); setError(undefined); } }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [cursor, deliveryId, reload, source, status]);
  function changeFilter(key: 'source' | 'status', value: string) { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); next.delete('cursor'); next.delete('deliveryId'); setParams(next); }
  function closeDetail() { const next = new URLSearchParams(params); next.delete('deliveryId'); setParams(next); }
  async function retry() { if (!detail) return; setBusy(true); setError(undefined); setNotice(undefined); try { await retryDelivery(detail.id); setNotice(t('automation.deliveries.retrySuccess')); setReload((value) => value + 1); } catch (reason) { setError(safeErrorMessage(reason, t)); } finally { setBusy(false); } }
  const currentWebhook = detail ? webhooks.find((item) => item.id === detail.webhookId) : undefined;
  const lastAttempt = detail?.attempts.at(-1);
  const configChanged = Boolean(lastAttempt && currentWebhook && currentWebhook.revision !== lastAttempt.webhookRevision);
  const canRetry = Boolean(detail && detail.status === 'failed' && detail.errorCode !== 'capacityExceeded' && detail.manualRedriveCount < 3 && currentWebhook?.enabled && currentWebhook.signingConfigured);
  return <section aria-labelledby="automation-deliveries-heading" className="automation-tab-content" role="tabpanel">
    <div className="automation-section-heading"><div><h2 id="automation-deliveries-heading">{t('automation.deliveries.list')}</h2><p>{t('automation.deliveries.description')}</p></div></div>
    <Surface className="automation-toolbar"><div aria-label={t('automation.deliveries.filters')} className="automation-filters"><label>{t('automation.deliveries.source')}<select aria-label={t('automation.deliveries.source')} onChange={(event) => changeFilter('source', event.target.value)} value={source ?? ''}><option value="">{t('automation.deliveries.allSources')}</option><option value="eventHook">{t('automation.sources.eventHook')}</option><option value="job">{t('automation.sources.job')}</option><option value="test">{t('automation.sources.test')}</option></select></label><label>{t('automation.deliveries.status')}<select aria-label={t('automation.deliveries.status')} onChange={(event) => changeFilter('status', event.target.value)} value={status ?? ''}><option value="">{t('automation.deliveries.allStatuses')}</option>{(['pending', 'running', 'succeeded', 'failed', 'cancelled'] as DeliveryStatus[]).map((value) => <option key={value} value={value}>{t(`automation.statuses.${value}` as TranslationKey)}</option>)}</select></label></div><span className="automation-count">{items.length}</span></Surface>
    {notice && <p className="automation-notice" role="status">{notice}</p>}{error && <p className="automation-form-error" role="alert">{error}</p>}
    {state === 'loading' && <LoadingState label={t('automation.common.loading')} />}{state === 'error' && <ErrorState description={t('automation.common.loadRetry')} title={t('automation.common.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('automation.common.retry')}</Button></ErrorState>}
    {state === 'ready' && items.length === 0 && <EmptyState description={t('automation.deliveries.emptyDescription')} title={t('automation.deliveries.emptyTitle')} />}
    {state === 'ready' && items.length > 0 && <div aria-label={t('automation.deliveries.list')} className="automation-list">{items.map((item) => <Surface className="automation-card" key={item.id}><div className="automation-card__main"><div><h3>{item.webhookName}</h3><p>{t(`automation.sources.${item.sourceType}` as TranslationKey)} · {item.eventType} · {formatDate(item.createdAt)}</p><p>{t('automation.deliveries.attempts')}: {item.attemptCount} · {item.lastHttpStatus ?? '—'}</p>{item.errorCode !== 'none' && <p>{errorLabel(item.errorCode, t)}</p>}</div><StatusChip state={item.status}>{t(`automation.statuses.${item.status}` as TranslationKey)}</StatusChip></div><div className="automation-card__actions"><Button onClick={() => { const next = new URLSearchParams(params); next.set('deliveryId', item.id); setParams(next); }} size="small" variant="quiet">{t('automation.deliveries.view')}</Button></div></Surface>)}</div>}
    {state === 'ready' && nextCursor && <div className="automation-form-actions"><Button onClick={() => { const next = new URLSearchParams(params); next.set('cursor', nextCursor); setParams(next); }} type="button">{t('automation.common.next')}</Button></div>}
    {detail && <Surface className="automation-form-card"><div className="automation-section-heading"><div><p className="eyebrow">{t('automation.deliveries.detail')}</p><h3>{detail.webhookName}</h3><p>{t(`automation.sources.${detail.sourceType}` as TranslationKey)} · {detail.eventType} · {t(`automation.statuses.${detail.status}` as TranslationKey)}</p></div><Button onClick={closeDetail} size="small" type="button" variant="quiet">{t('automation.common.close')}</Button></div>
      {configChanged && <p className="automation-warning">{t('automation.deliveries.configChanged')}</p>}
      <div className="automation-details"><dl><dt>{t('automation.deliveries.deliveryId')}</dt><dd><code>{detail.id}</code></dd><dt>{t('automation.deliveries.createdAt')}</dt><dd>{formatDate(detail.createdAt)}</dd><dt>{t('automation.deliveries.outcome')}</dt><dd>{errorLabel(detail.errorCode, t)}</dd><dt>{t('automation.deliveries.attempts')}</dt><dd>{detail.attemptCount}</dd></dl></div>
      <h4>{t('automation.deliveries.attemptHistory')}</h4>{detail.attempts.length === 0 ? <p className="automation-recovery">{t('automation.deliveries.noAttempts')}</p> : <div className="automation-details"><table className="automation-attempts"><thead><tr><th>{t('automation.deliveries.round')}</th><th>{t('automation.deliveries.attempt')}</th><th>{t('automation.deliveries.attemptStatus')}</th><th>{t('automation.deliveries.startedAt')}</th><th>{t('automation.deliveries.duration')}</th><th>{t('automation.deliveries.httpStatus')}</th><th>{t('automation.deliveries.errorCode')}</th></tr></thead><tbody>{detail.attempts.map((attempt, index) => <tr key={`${attempt.round}-${attempt.attempt}-${index}`}><td>{attempt.round}</td><td>{attempt.attempt}</td><td>{t(`automation.statuses.${attempt.status}` as TranslationKey)}</td><td>{formatDate(attempt.startedAt)}</td><td>{attempt.durationMs} ms</td><td>{attempt.httpStatus ?? '—'}</td><td>{errorLabel(attempt.errorCode, t)}</td></tr>)}</tbody></table></div>}
      {detail.status === 'failed' && !canRetry && <p className="automation-inline-note">{detail.manualRedriveCount >= 3 ? t('automation.deliveries.retryLimit') : detail.errorCode === 'capacityExceeded' ? t('automation.deliveries.capacity') : t('automation.deliveries.retryUnavailable')}</p>}
      {canRetry && <div className="automation-form-actions"><Button disabled={busy} onClick={() => void retry()} type="button" variant="primary">{busy ? t('automation.deliveries.retrying') : t('automation.deliveries.retry')}</Button></div>}
    </Surface>}
  </section>;
}

function validSource(value: string | null): value is DeliverySourceType { return value === 'eventHook' || value === 'job' || value === 'test'; }
function validStatus(value: string | null): value is DeliveryStatus { return value === 'pending' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled'; }
function errorLabel(code: string, t: ReturnType<typeof useI18n>['t']): string { return code === 'none' ? t('automation.deliveries.noError') : t(`automation.errors.${code}` as TranslationKey); }
