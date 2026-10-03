import { WorkspaceActions } from '../components/workspace-toolbar';
import { TabContent } from '../components/tab-content';
import { Input, Textarea } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { SelectField } from '@/components/ui/select-field';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Button, ButtonLink } from '../components/button';
import { FormField } from '../components/form-field';
import { Dialog } from '../components/overlays';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { listAllCollections } from '../collections/client';
import { useI18n } from '../i18n/i18n';
import {
  createExtension,
  createSecret,
  deleteSecret,
  getExtension,
  getExtensionRun,
  listExtensionRuns,
  listExtensions,
  listSecrets,
  replaceExtension,
  replaceSecretValue,
  renameSecret,
  setExtensionEnabled,
  type CollectionOption,
  type ExtensionBinding,
  type ExtensionDetail,
  type ExtensionDraft,
  type ExtensionLanguage,
  type ExtensionOperation,
  type ExtensionPhase,
  type ExtensionRun,
  type ExtensionSummary,
  type SecretMetadata,
} from './client';

type ViewState = 'loading' | 'ready' | 'error';

const LINK_CLASS = 'inline-flex min-h-11 w-fit items-center gap-1.5 text-xs font-semibold text-primary hover:underline';
const CODE_CONTROL_CLASS = 'min-h-[190px] font-mono leading-relaxed';
const SECTION_HEADING_CLASS = 'flex flex-wrap items-start justify-between gap-3 border-b pb-3';
const SECTION_HEADING_COPY_CLASS = 'min-w-0';
const SECTION_DESCRIPTION_CLASS = 'mt-1 text-xs text-muted-foreground';

function safeError(error: unknown, t: ReturnType<typeof useI18n>['t']) {
  const code = error instanceof ApiClientError ? error.apiError.code : '';
  const details = error instanceof ApiClientError ? error.apiError.details : {};
  const message = code === 'BINDING_CONFLICT' ? t('extensions.errors.bindingConflict')
    : code === 'VALIDATION_FAILED' ? t('extensions.errors.validation')
      : code === 'NOT_FOUND' ? t('extensions.errors.notFound')
        : code === 'FORBIDDEN' ? t('extensions.errors.forbidden')
          : code === 'SECRET_KEY_UNAVAILABLE' || code === 'SECRET_NOT_AVAILABLE' ? t('extensions.errors.secretUnavailable')
            : t('extensions.errors.generic');
  const violations = Array.isArray(details.violations)
    ? details.violations.filter((item): item is { path: string; code: string; message: string } =>
      typeof item === 'object' && item !== null &&
      typeof item.path === 'string' && typeof item.code === 'string' && typeof item.message === 'string',
    )
    : [];
  const conflict = typeof details.collectionId === 'string' &&
    (details.operation === 'create' || details.operation === 'update' || details.operation === 'delete') &&
    (details.phase === 'before' || details.phase === 'afterCommit')
    ? { collectionId: details.collectionId, operation: details.operation, phase: details.phase }
    : undefined;
  return {
    message,
    requestId: error instanceof ApiClientError ? error.apiError.requestId : undefined,
    violations,
    conflict,
  };
}

function validationCodeMessage(code: string, t: ReturnType<typeof useI18n>['t']) {
  switch (code) {
    case 'required': return t('extensions.validationCodes.required');
    case 'invalidName': return t('extensions.validationCodes.invalidName');
    case 'unsupportedLanguage': return t('extensions.validationCodes.unsupportedLanguage');
    case 'invalidSource': return t('extensions.validationCodes.invalidSource');
    case 'invalidCollection': return t('extensions.validationCodes.invalidCollection');
    case 'invalidOperation':
    case 'unsupportedOperation': return t('extensions.validationCodes.invalidOperation');
    case 'invalidPhase': return t('extensions.validationCodes.invalidPhase');
    case 'duplicateBinding': return t('extensions.validationCodes.duplicateBinding');
    case 'tooManyBindings': return t('extensions.validationCodes.tooManyBindings');
    case 'invalidAlias': return t('extensions.validationCodes.invalidAlias');
    case 'invalidSecretReference': return t('extensions.validationCodes.invalidSecretReference');
    case 'duplicateAlias': return t('extensions.validationCodes.duplicateAlias');
    case 'tooManyOrigins': return t('extensions.validationCodes.tooManyOrigins');
    case 'invalidOrigin': return t('extensions.validationCodes.invalidOrigin');
    case 'duplicateOrigin': return t('extensions.validationCodes.duplicateOrigin');
    case 'duplicateName': return t('extensions.validationCodes.duplicateName');
    case 'invalidSecretValue': return t('extensions.validationCodes.invalidSecretValue');
    default: return t('extensions.validationCodes.generic');
  }
}

function errorDetails(error: unknown, t: ReturnType<typeof useI18n>['t']) {
  const copy = safeError(error, t);
  const lines = [copy.message];
  if (copy.conflict) {
    const operation = copy.conflict.operation === 'create' ? t('extensions.operations.create')
      : copy.conflict.operation === 'update' ? t('extensions.operations.update') : t('extensions.operations.delete');
    const phase = copy.conflict.phase === 'before' ? t('extensions.phases.before') : t('extensions.phases.afterCommit');
    lines.push(t('extensions.errors.bindingConflictAt', { collectionId: copy.conflict.collectionId, operation, phase }));
  }
  for (const violation of copy.violations) {
    lines.push(`${violation.path}: ${validationCodeMessage(violation.code, t)}`);
  }
  if (copy.requestId && copy.requestId !== 'unavailable') lines.push(t('extensions.requestId', { id: copy.requestId }));
  return lines.join(' ');
}

function PageHeading({ eyebrow, title, description, action, level = 1 }: { eyebrow: string; title: string; description: string; action?: ReactNode; level?: 1 | 2 }) {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        {level === 1 ? <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{title}</h1> : <h2 className="text-base font-semibold">{title}</h2>}
        <p className="mt-2.5 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-3">{action}</div>}
    </header>
  );
}

// Hook 列表工作面由 `/events?tab=hooks` 复用，导航提供可见上下文，
// 工作面只展示操作与内容，标题语义留给屏幕阅读器（spec 0001 §3.1）。
export function HooksPanel() {
  const { t, formatDate } = useI18n();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<ExtensionSummary[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const search = params.get('q') ?? '';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listExtensions(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setItems(result);
      setState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason); setState('error'); }
    });
    return () => controller.abort();
  }, [reload]);

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return [...items].filter((item) => !query || item.name.toLocaleLowerCase().includes(query))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
  }, [items, search]);

  function updateQuery(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set('q', value); else next.delete('q');
    setParams(next, { replace: true });
  }

  return <section aria-labelledby="events-hooks-heading" className="flex min-w-0 flex-col gap-4">
    <header className="min-w-0"><h2 className="text-base font-semibold" id="events-hooks-heading">{t('events.tabs.hooks')}</h2><p className="mt-1 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{t('extensions.description')}</p></header>
    <WorkspaceActions><div className="flex flex-wrap items-center justify-end gap-3">

      <div className="flex flex-wrap items-center gap-3"><ButtonLink to={`/events/hooks/new${search ? `?q=${encodeURIComponent(search)}` : ''}`} variant="primary"><Plus aria-hidden="true" size={15} />{t('extensions.createAction')}</ButtonLink></div>
    </div></WorkspaceActions>
    <Surface className="flex flex-wrap items-center justify-between gap-3" variant="section">
      <SearchInput aria-label={t('extensions.search')} onChange={(event) => updateQuery(event.target.value)} placeholder={t('extensions.searchPlaceholder')} value={search} className="min-w-[200px] flex-1 md:max-w-sm" />
      <span className="whitespace-nowrap text-xs font-medium tabular-nums text-muted-foreground">{t('extensions.count', { count: visible.length })}</span>
    </Surface>
    {state === 'loading' && <LoadingState label={t('extensions.loading')} />}
    {state === 'error' && <ErrorState description={errorDetails(error, t)} title={t('extensions.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && items.length === 0 && <EmptyState title={t('extensions.emptyTitle')} description={t('extensions.emptyDescription')} />}
    {state === 'ready' && visible.length === 0 && items.length > 0 && <EmptyState title={t('extensions.noMatches')} description={t('extensions.noMatchesDescription')} />}
    {visible.length > 0 && <nav className="flex min-w-0 flex-col gap-2" aria-label={t('extensions.list')}>
      {visible.map((item) => <Link className="group flex flex-wrap items-center gap-3 border-b px-1 py-4 last:border-b-0 transition-colors" key={item.id} to={`/events/hooks/${encodeURIComponent(item.id)}`}>
        <span className="grid min-w-0 flex-1 gap-1">
          <strong className="truncate text-sm font-semibold text-foreground group-hover:text-primary">{item.name}</strong>
          <span className="truncate text-xs text-muted-foreground">{t('extensions.listMeta', { language: t(`extensions.languages.${item.language}`), revision: item.activeRevision, date: formatDate(item.updatedAt) })}</span>
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2"><span className="whitespace-nowrap text-xs text-muted-foreground">{t('extensions.bindingsCount', { count: item.bindingCount })}</span>
        <StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('extensions.enabled') : t('extensions.disabled')}</StatusChip>
        <ArrowRight aria-hidden="true" className="shrink-0 text-subtle-foreground" size={15} /></span>
      </Link>)}
    </nav>}
  </section>;
}

// Hook 创建使用独立工作面，为代码输入和错误恢复保留足够空间。
export function HookCreatePage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const backToList = `/events?tab=hooks${params.get('q') ? `&q=${encodeURIComponent(params.get('q')!)}` : ''}`;
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<ExtensionLanguage>('javascript');
  const [source, setSource] = useState('export function beforeCreate(context) {\n  return { action: "allow" };\n}\n');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (new TextEncoder().encode(source).byteLength > 262144) { setCreateError(new Error('source-limit')); return; }
    setSaving(true);
    setCreateError(undefined);
    try {
      const created = await createExtension({ name: name.trim(), language, source });
      navigate(`/events/hooks/${encodeURIComponent(created.id)}`);
    } catch (reason) { setCreateError(reason); }
    finally { setSaving(false); }
  }

  return <div className="flex min-w-0 flex-col gap-6">
    <Link className={LINK_CLASS} to={backToList}><ArrowLeft aria-hidden="true" size={15} />{t('extensions.backToList')}</Link>
    <PageHeading eyebrow={t('extensions.createEyebrow')} title={t('extensions.createTitle')} description={t('extensions.createDescription')} />
    <div className="min-w-0" data-extension-create-card>
      <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
        <form className="grid max-w-[820px] gap-3.5" onSubmit={(event) => void submit(event)}>
          <FormField htmlFor="extension-create-name" label={t('extensions.name')}><Input autoComplete="off" id="extension-create-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></FormField>
          <FormField htmlFor="extension-create-language" label={t('extensions.language')}><SelectField id="extension-create-language" onValueChange={(selectedValue) => setLanguage(selectedValue as ExtensionLanguage)} value={language} options={[({ value: "javascript", label: t('extensions.languages.javascript') }), ({ value: "typescript", label: t('extensions.languages.typescript') })]} /></FormField>
          <FormField htmlFor="extension-create-source" hint={t('extensions.sourceHint')} label={t('extensions.source')}><Textarea className={CODE_CONTROL_CLASS} id="extension-create-source" onChange={(event) => setSource(event.target.value)} required spellCheck={false} value={source} /></FormField>
          <span className={`text-xs tabular-nums ${new TextEncoder().encode(source).byteLength > 262144 ? 'text-danger' : 'text-muted-foreground'}`}>{t('extensions.byteCount', { count: new TextEncoder().encode(source).byteLength, limit: 262144 })}</span>
          {createError !== undefined ? <p className="m-0 text-xs leading-relaxed text-danger" role="alert">{createError instanceof Error && createError.message === 'source-limit' ? t('extensions.sourceTooLarge') : errorDetails(createError, t)}</p> : null}
          <div className="flex flex-wrap justify-end gap-2"><ButtonLink to={backToList}>{t('automation.common.cancel')}</ButtonLink><Button disabled={saving || !name.trim() || !source.trim() || new TextEncoder().encode(source).byteLength > 262144} type="submit" variant="primary"><Plus aria-hidden="true" size={15} />{saving ? t('extensions.creating') : t('extensions.createAction')}</Button></div>
        </form>
      </Surface>
    </div>
  </div>;
}

// Hook 编辑器：`/events/hooks/:extensionId` 的页面主体（spec 0001 §3.1）。
export function ExtensionEditor({ extensionId }: { extensionId: string }) {
  const { t } = useI18n();
  const location = useLocation();
  const [params] = useSearchParams();
  const [detail, setDetail] = useState<ExtensionDetail>();
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState<unknown>();
  const [saveError, setSaveError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<ExtensionDraft>();
  const [originsText, setOriginsText] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void Promise.all([getExtension(extensionId, controller.signal), listAllCollections(controller.signal), listSecrets(controller.signal)]).then(([loaded, available, secretList]) => {
      if (controller.signal.aborted) return;
      setDetail(loaded);
      setCollections(available.map(({ id, name, type }) => ({ id, name, type })));
      setSecrets(secretList);
      setDraft({
        name: loaded.name, language: loaded.language, source: loaded.source,
        bindings: loaded.bindings.map((binding) => ({ ...binding })),
        secretBindings: loaded.secretBindings.map(({ alias, secretId }) => ({ alias, secretId })),
        allowedOrigins: [...loaded.allowedOrigins],
      });
      setOriginsText(loaded.allowedOrigins.join('\n'));
      setState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason); setState('error'); }
    });
    return () => controller.abort();
  }, [extensionId, reload]);

  const tab = params.get('tab') === 'runs' ? 'runs' : 'settings';
  // Hook 详情内部的二级 Tab 同样由 URL 表达：可分享、可新标签页打开（spec 0001 §3.1、§17.4）。
  function tabTarget(nextTab: 'settings' | 'runs') {
    const next = new URLSearchParams(params);
    // 运行面板的分页与详情参数只属于 `?tab=runs`。
    next.delete('cursor');
    next.delete('back');
    next.delete('run');
    if (nextTab === 'settings') next.delete('tab'); else next.set('tab', 'runs');
    const serialized = next.toString();
    return `${location.pathname}${serialized ? `?${serialized}` : ''}`;
  }

  function updateDraft<T extends keyof ExtensionDraft>(key: T, value: ExtensionDraft[T]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  const pendingDraft: ExtensionDraft = {
    ...draft!,
    allowedOrigins: originsText.split(/\r?\n/).map((origin) => origin.trim()).filter(Boolean),
  };
  const savedDraft: ExtensionDraft = {
    name: detail?.name ?? '', language: detail?.language ?? 'javascript', source: detail?.source ?? '',
    bindings: detail?.bindings ?? [],
    secretBindings: detail?.secretBindings.map(({ alias, secretId }) => ({ alias, secretId })) ?? [],
    allowedOrigins: detail?.allowedOrigins ?? [],
  };
  const hasUnsavedChanges = JSON.stringify(pendingDraft) !== JSON.stringify(savedDraft);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const originValues = originsText.split(/\r?\n/).map((origin) => origin.trim()).filter(Boolean);
    if (!originValues.every(isHTTPSOrigin)) { setSaveError(new Error('origin-invalid')); return; }
    const sourceBytes = new TextEncoder().encode(draft.source).byteLength;
    if (sourceBytes > 262144) { setSaveError(new Error('source-limit')); return; }
    if (new Set(draft.bindings.map(bindingKey)).size !== draft.bindings.length) { setSaveError(new Error('binding-duplicate')); return; }
    if (new Set(draft.secretBindings.map((binding) => binding.alias.toLocaleLowerCase())).size !== draft.secretBindings.length) { setSaveError(new Error('alias-duplicate')); return; }
    if (draft.secretBindings.some(({ alias, secretId }) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(alias) || !secretId)) { setSaveError(new Error('alias-invalid')); return; }
    setSaving(true);
    setSaveError(undefined);
    try {
      const saved = await replaceExtension(extensionId, { ...draft, allowedOrigins: originValues });
      setDetail(saved);
      setDraft({
        name: saved.name, language: saved.language, source: saved.source,
        bindings: saved.bindings.map((binding) => ({ ...binding })),
        secretBindings: saved.secretBindings.map(({ alias, secretId }) => ({ alias, secretId })),
        allowedOrigins: [...saved.allowedOrigins],
      });
      setOriginsText(saved.allowedOrigins.join('\n'));
    } catch (reason) { setSaveError(reason); }
    finally { setSaving(false); }
  }

  async function toggleEnabled() {
    if (!detail || hasUnsavedChanges) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const result = await setExtensionEnabled(extensionId, !detail.enabled);
      setDetail((current) => current ? { ...current, enabled: result.enabled } : current);
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }

  const hookContext = <>
    <Link className={LINK_CLASS} to="/events?tab=hooks"><ArrowLeft aria-hidden="true" size={15} />{t('extensions.backToList')}</Link>
    <PageHeading eyebrow={t('extensions.eyebrow')} title={detail?.name ?? t('events.tabs.hooks')} description={t('extensions.description')} />
    <code className="break-all font-mono text-[13px] text-muted-foreground">{extensionId}</code>
  </>;
  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6">{hookContext}<LoadingState label={t('extensions.loadingDetail')} /></div>;
  if (state === 'error' || !detail || !draft) return <div className="flex min-w-0 flex-col gap-6">{hookContext}<ErrorState description={errorDetails(error, t)} title={t('extensions.loadFailed')}><div className="mt-3 flex flex-wrap items-center gap-3"><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.retry')}</Button></div></ErrorState></div>;

  return <div className="flex min-w-0 flex-col gap-6">
    <Link className={LINK_CLASS} to="/events?tab=hooks"><ArrowLeft aria-hidden="true" size={15} />{t('extensions.backToList')}</Link>
    <PageHeading eyebrow={t('extensions.eyebrow')} title={detail.name} description={t('extensions.detailDescription', { revision: detail.activeRevision })} action={<div className="grid justify-items-end gap-1.5"><Button disabled={busy || hasUnsavedChanges} onClick={() => void toggleEnabled()} variant={detail.enabled ? 'danger' : 'primary'}>{detail.enabled ? t('extensions.disable') : t('extensions.enable')}</Button>{hasUnsavedChanges && <span className="max-w-[240px] text-right text-xs leading-relaxed text-muted-foreground" role="status">{t('extensions.saveBeforeStateChange')}</span>}</div>} />
    {actionError !== undefined ? <ErrorState description={errorDetails(actionError, t)} title={t('extensions.actionFailed')} /> : null}
    <nav aria-label={t('extensions.tabs')} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b">
      {(['settings', 'runs'] as const).map((nextTab) => <Link
        aria-current={tab === nextTab ? 'page' : undefined}
        className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium no-underline transition-colors  ${tab === nextTab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        key={nextTab}
        replace
        to={tabTarget(nextTab)}
      >{nextTab === 'settings' ? t('extensions.configuration') : t('extensions.runs')}</Link>)}
    </nav>
    <TabContent activeKey={tab}>
    {tab === 'settings' ? <form className="flex min-w-0 flex-col gap-3.5" data-extension-editor onSubmit={(event) => void save(event)}>
      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className={SECTION_HEADING_CLASS}><div className={SECTION_HEADING_COPY_CLASS}><p className="eyebrow">{t('extensions.sourceEyebrow')}</p><h2 className="text-base font-semibold">{t('extensions.sourceSection')}</h2><p className={SECTION_DESCRIPTION_CLASS}>{t('extensions.sourceDescription')}</p></div></div>
        <div className="grid max-w-[820px] gap-3.5">
          <FormField htmlFor="extension-name" label={t('extensions.name')}><Input autoComplete="off" id="extension-name" maxLength={120} onChange={(event) => updateDraft('name', event.target.value)} required value={draft.name} /></FormField>
          <FormField htmlFor="extension-language" label={t('extensions.language')}><SelectField id="extension-language" onValueChange={(selectedValue) => updateDraft('language', selectedValue as ExtensionLanguage)} value={draft.language} options={[({ value: "javascript", label: t('extensions.languages.javascript') }), ({ value: "typescript", label: t('extensions.languages.typescript') })]} /></FormField>
          <FormField htmlFor="extension-source" hint={t('extensions.sourceHint')} label={t('extensions.source')}><Textarea className={CODE_CONTROL_CLASS} id="extension-source" maxLength={262144} onChange={(event) => updateDraft('source', event.target.value)} required spellCheck={false} value={draft.source} /></FormField>
          <span className={`text-xs tabular-nums ${new TextEncoder().encode(draft.source).byteLength > 262144 ? 'text-danger' : 'text-muted-foreground'}`}>{t('extensions.byteCount', { count: new TextEncoder().encode(draft.source).byteLength, limit: 262144 })}</span>
        </div>
      </Surface>
      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className={SECTION_HEADING_CLASS}><div className={SECTION_HEADING_COPY_CLASS}><p className="eyebrow">{t('extensions.bindingEyebrow')}</p><h2 className="text-base font-semibold">{t('extensions.bindings')}</h2><p className={SECTION_DESCRIPTION_CLASS}>{t('extensions.bindingDescription')}</p></div><Button onClick={() => updateDraft('bindings', [...draft.bindings, { collectionId: collections[0]?.id ?? '', operation: 'create', phase: 'before' }])} size="small" type="button"><Plus aria-hidden="true" size={14} />{t('extensions.addBinding')}</Button></div>
        {draft.bindings.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{t('extensions.noBindings')}</p> : <div className="grid gap-2.5">{draft.bindings.map((binding, index) => <div className="grid items-end gap-2.5 border-b py-3 min-[761px]:grid-cols-[minmax(180px,1.2fr)_minmax(130px,0.8fr)_minmax(140px,0.8fr)_auto]" key={`${bindingKey(binding)}-${index}`}>
          <FormField htmlFor={`binding-collection-${index}`} label={t('extensions.collection')}><SelectField id={`binding-collection-${index}`} onValueChange={(selectedValue) => updateDraft('bindings', draft.bindings.map((item, position) => position === index ? { ...item, collectionId: selectedValue } : item))} required value={binding.collectionId} options={[({ value: "", label: t('extensions.chooseCollection') }), collections.map((collection) => ({ value: collection.id, label: <>{collection.name}{collection.type === 'Auth' ? ` · ${t('extensions.authCollection')}` : ''}</> }))]} /></FormField>
          <FormField htmlFor={`binding-operation-${index}`} label={t('extensions.operation')}><SelectField id={`binding-operation-${index}`} onValueChange={(selectedValue) => updateDraft('bindings', draft.bindings.map((item, position) => position === index ? { ...item, operation: selectedValue as ExtensionOperation } : item))} value={binding.operation} options={[(['create', 'update', 'delete'] as const).map((operation) => ({ value: operation, label: t(`extensions.operations.${operation}`) }))]} /></FormField>
          <FormField htmlFor={`binding-phase-${index}`} label={t('extensions.phase')}><SelectField id={`binding-phase-${index}`} onValueChange={(selectedValue) => updateDraft('bindings', draft.bindings.map((item, position) => position === index ? { ...item, phase: selectedValue as ExtensionPhase } : item))} value={binding.phase} options={[({ value: "before", label: t('extensions.phases.before') }), ({ value: "afterCommit", label: t('extensions.phases.afterCommit') })]} /></FormField>
          <Button aria-label={t('extensions.removeBinding')} className="justify-self-end" onClick={() => updateDraft('bindings', draft.bindings.filter((_, position) => position !== index))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={15} /></Button>
        </div>)}</div>}
      </Surface>
      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className={SECTION_HEADING_CLASS}><div className={SECTION_HEADING_COPY_CLASS}><p className="eyebrow">{t('extensions.capabilitiesEyebrow')}</p><h2 className="text-base font-semibold">{t('extensions.secretsAndOrigins')}</h2><p className={SECTION_DESCRIPTION_CLASS}>{t('extensions.capabilitiesDescription')}</p></div></div>
        <section className="grid gap-3 border-t pt-3"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xs font-semibold text-ink-secondary">{t('extensions.secretAliases')}</h3><Link className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary hover:underline" to="/settings/secrets">{t('extensions.manageSecrets')}</Link></div>
          {draft.secretBindings.map((binding, index) => <div className="grid items-end gap-2.5 border-b py-3 min-[761px]:grid-cols-[minmax(180px,1fr)_minmax(160px,1fr)_auto_auto]" key={`secret-${index}`}>
            <FormField htmlFor={`secret-alias-${index}`} label={t('extensions.alias')}><Input autoComplete="off" id={`secret-alias-${index}`} maxLength={64} onChange={(event) => updateDraft('secretBindings', draft.secretBindings.map((item, position) => position === index ? { ...item, alias: event.target.value } : item))} pattern="[A-Za-z][A-Za-z0-9_]{0,63}" required value={binding.alias} /></FormField>
            <FormField htmlFor={`secret-id-${index}`} label={t('extensions.secret')}><SelectField id={`secret-id-${index}`} onValueChange={(selectedValue) => updateDraft('secretBindings', draft.secretBindings.map((item, position) => position === index ? { ...item, secretId: selectedValue } : item))} required value={binding.secretId} options={[({ value: "", label: t('extensions.chooseSecret') }), secrets.map((secret) => ({ value: secret.id, label: secret.name }))]} /></FormField>
            <span className="self-center text-xs text-muted-foreground">{t('extensions.writeOnlyConfigured')}</span>
            <Button aria-label={t('extensions.removeSecretAlias')} className="justify-self-end" onClick={() => updateDraft('secretBindings', draft.secretBindings.filter((_, position) => position !== index))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={15} /></Button>
          </div>)}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!secrets.length} onClick={() => updateDraft('secretBindings', [...draft.secretBindings, { alias: '', secretId: secrets[0]?.id ?? '' }])} size="small" type="button"><Plus aria-hidden="true" size={14} />{t('extensions.addAlias')}</Button>
            {!secrets.length && <p className="m-0 text-xs text-muted-foreground">{t('extensions.noSecretsAvailable')} <Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('extensions.createSecretLink')}</Link></p>}
          </div>
        </section>
        <section className="grid gap-3 border-t pt-3"><FormField htmlFor="extension-origins" hint={t('extensions.originsHint')} label={t('extensions.allowedOrigins')}><Textarea autoCapitalize="off" autoCorrect="off" className={CODE_CONTROL_CLASS} id="extension-origins" onChange={(event) => setOriginsText(event.target.value)} placeholder={t('extensions.originPlaceholder')} spellCheck={false} value={originsText} /></FormField></section>
      </Surface>
      {saveError !== undefined ? <ErrorState description={saveError instanceof Error && saveError.message === 'origin-invalid' ? t('extensions.invalidOrigin') : saveError instanceof Error && saveError.message === 'source-limit' ? t('extensions.sourceTooLarge') : saveError instanceof Error && saveError.message === 'binding-duplicate' ? t('extensions.duplicateBinding') : saveError instanceof Error && saveError.message === 'alias-duplicate' ? t('extensions.duplicateAlias') : saveError instanceof Error && saveError.message === 'alias-invalid' ? t('extensions.invalidAlias') : errorDetails(saveError, t)} title={t('extensions.saveFailed')} /> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3.5"><Button disabled={saving || !draft.name.trim() || !draft.source.trim() || new TextEncoder().encode(draft.source).byteLength > 262144} type="submit" variant="primary"><Save aria-hidden="true" size={15} />{saving ? t('extensions.saving') : t('extensions.save')}</Button></div>
    </form> : <HookRunsPanel extensionId={extensionId} />}
    </TabContent>
  </div>;
}

function HookRunsPanel({ extensionId }: { extensionId: string }) {
  const { t, formatDate, formatNumber } = useI18n();
  const [params, setParams] = useSearchParams();
  const cursor = params.get('cursor') ?? undefined;
  const backCursors = params.getAll('back');
  const [runs, setRuns] = useState<ExtensionRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ExtensionRun>();
  const [detailState, setDetailState] = useState<ViewState>('ready');
  const selectedId = params.get('run');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listExtensionRuns(extensionId, { limit: 100, cursor }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setRuns(page.data); setNextCursor(page.nextCursor); setState('ready'); setError(undefined);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason); setState('error'); }
    });
    return () => controller.abort();
  }, [extensionId, cursor, reload]);

  useEffect(() => {
    if (!selectedId) { setSelected(undefined); setDetailState('ready'); return; }
    const controller = new AbortController();
    setDetailState('loading');
    void getExtensionRun(extensionId, selectedId, controller.signal).then((run) => {
      if (!controller.signal.aborted) { setSelected(run); setDetailState('ready'); }
    }).catch(() => { if (!controller.signal.aborted) { setSelected(undefined); setDetailState('error'); } });
    return () => controller.abort();
  }, [extensionId, selectedId]);

  function pageTo(nextCursorValue?: string) {
    const next = new URLSearchParams(params);
    next.delete('run');
    if (nextCursorValue) {
      if (cursor) next.append('back', cursor);
      next.set('cursor', nextCursorValue);
    } else {
      next.delete('cursor');
      const previous = backCursors.slice(0, -1);
      next.delete('back'); previous.forEach((value) => next.append('back', value));
      const prior = backCursors.at(-1);
      if (prior) next.set('cursor', prior);
    }
    setParams(next);
  }

  function selectRun(runId?: string) {
    const next = new URLSearchParams(params);
    if (runId) next.set('run', runId); else next.delete('run');
    setParams(next, { replace: true });
  }

  return <div className="flex min-w-0 flex-col gap-4">
    <Surface className="flex flex-wrap items-start justify-between gap-3" variant="section"><div className={SECTION_HEADING_COPY_CLASS}><p className="eyebrow">{t('extensions.runsEyebrow')}</p><h2 className="text-base font-semibold">{t('extensions.runs')}</h2><p className={SECTION_DESCRIPTION_CLASS}>{t('extensions.runsDescription')}</p></div><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.refresh')}</Button></Surface>
    {state === 'loading' && <LoadingState label={t('extensions.loadingRuns')} />}
    {state === 'error' && <ErrorState description={errorDetails(error, t)} title={t('extensions.runsFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('extensions.retry')}</Button></ErrorState>}
    {state === 'ready' && runs.length === 0 && <EmptyState title={t('extensions.noRuns')} description={t('extensions.noRunsDescription')} />}
    {state === 'ready' && runs.length > 0 && <div className="grid gap-2.5" role="list" aria-label={t('extensions.runs')}>
      {runs.map((run) => <article className="grid items-center gap-4 border-b px-1 py-4 last:border-b-0 min-[761px]:grid-cols-[minmax(170px,1fr)_minmax(130px,0.75fr)_auto]" key={run.runId} role="listitem">
        <div className="grid min-w-0 justify-items-start gap-1 text-xs text-muted-foreground"><div className="flex flex-wrap items-center gap-2"><StatusChip state={run.status}>{t(`extensions.statuses.${run.status}`)}</StatusChip><span>{t(`extensions.operations.${run.operation}`)} · {t(`extensions.phases.${run.phase}`)}</span></div><strong className="text-xs font-semibold text-foreground">{t('extensions.runRevision', { revision: run.revision })}</strong><span>{formatDate(run.startedAt)}{typeof run.durationMs === 'number' ? ` · ${t('extensions.duration', { duration: formatNumber(run.durationMs) })}` : ''}</span></div>
        <div className="grid min-w-0 justify-items-start gap-1 text-xs text-muted-foreground"><span className="break-all">{t('extensions.collectionId', { id: run.collectionId })}</span>{run.recordId && <Link className="font-semibold text-primary hover:underline" to={`/collections/${encodeURIComponent(run.collectionId)}?record=${encodeURIComponent(run.recordId)}`}>{t('extensions.recordId', { id: run.recordId })}</Link>}{run.eventId && <span className="break-all">{t('extensions.eventId', { id: run.eventId })}</span>}</div>
        <div className="grid min-w-0 justify-items-start gap-1 text-xs text-muted-foreground min-[761px]:justify-items-end min-[761px]:text-right"><span>{run.errorCode !== 'none' ? t(`extensions.errorCodes.${run.errorCode}` as never) : ''}</span><Button onClick={() => selectRun(run.runId)} size="small">{t('extensions.safeDetails')}</Button></div>
      </article>)}
      <nav aria-label={t('extensions.runPages')} className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><Button disabled={!backCursors.length} onClick={() => pageTo()} size="small"><ArrowLeft aria-hidden="true" size={14} />{t('extensions.previous')}</Button><span>{t('extensions.pageLimit')}</span><Button disabled={!nextCursor} onClick={() => pageTo(nextCursor)} size="small">{t('extensions.next')}<ArrowRight aria-hidden="true" size={14} /></Button></nav>
    </div>}
    {selectedId && <Surface className="flex min-w-0 flex-col gap-3.5 p-4" variant="standard"><div className="flex flex-wrap items-start justify-between gap-3"><div className={SECTION_HEADING_COPY_CLASS}><p className="eyebrow">{t('extensions.safeDiagnostics')}</p><h3>{t('extensions.runDetail')}</h3><p className={SECTION_DESCRIPTION_CLASS}>{t('extensions.safeDiagnosticsDescription')}</p></div><Button aria-label={t('extensions.closeDetails')} onClick={() => selectRun()} size="small" variant="quiet">×</Button></div>
      {detailState === 'loading' && <LoadingState label={t('extensions.loadingRun')} />}
      {detailState === 'error' && <ErrorState description={t('extensions.runNotFound')} title={t('extensions.runDetailFailed')} />}
      {detailState === 'ready' && selected && <dl className="m-0 grid grid-cols-1 gap-2.5 min-[561px]:grid-cols-2 min-[561px]:gap-x-5">
        <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.runId')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary"><code className="font-mono">{selected.runId}</code></dd></div><div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.status')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{t(`extensions.statuses.${selected.status}`)}</dd></div>
        <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.revision')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{selected.revision}</dd></div><div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.operation')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{t(`extensions.operations.${selected.operation}`)} · {t(`extensions.phases.${selected.phase}`)}</dd></div>
        <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.collection')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary"><Link className="font-semibold text-primary hover:underline" to={`/collections/${encodeURIComponent(selected.collectionId)}`}>{selected.collectionId}</Link></dd></div>
        {selected.recordId && <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.record')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary"><Link className="font-semibold text-primary hover:underline" to={`/collections/${encodeURIComponent(selected.collectionId)}?record=${encodeURIComponent(selected.recordId)}`}>{selected.recordId}</Link></dd></div>}
        {selected.eventId && <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.event')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{selected.eventId}</dd></div>}
        <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.startedAt')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{formatDate(selected.startedAt)}</dd></div>{selected.completedAt && <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.completedAt')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{formatDate(selected.completedAt)}</dd></div>}
        {typeof selected.durationMs === 'number' && <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.durationLabel')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{t('extensions.duration', { duration: formatNumber(selected.durationMs) })}</dd></div>}
        <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.errorCategory')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary">{selected.errorCode === 'none' ? t('extensions.noError') : t(`extensions.errorCodes.${selected.errorCode}` as never)}</dd></div>{selected.correlationId && <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted-foreground">{t('extensions.correlationId')}</dt><dd className="m-0 min-w-0 break-words text-xs text-ink-secondary"><code className="font-mono">{selected.correlationId}</code></dd></div>}
      </dl>}
    </Surface>}
  </div>;
}

function bindingKey(binding: ExtensionBinding) {
  return `${binding.collectionId}|${binding.operation}|${binding.phase}`;
}

function isHTTPSOrigin(input: string) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      && !url.hostname.startsWith('[') && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch { return false; }
}

export function SecretsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<SecretMetadata[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>();
  const [notice, setNotice] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SecretMetadata>();
  const [deleteError, setDeleteError] = useState<unknown>();
  const search = params.get('q') ?? '';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listSecrets(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setItems(result); setState('ready'); setError(undefined);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason); setState('error'); }
    });
    return () => controller.abort();
  }, [reload]);

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items.filter((item) => !query || item.name.toLocaleLowerCase().includes(query)).sort((left, right) => left.name.localeCompare(right.name));
  }, [items, search]);

  function updateQuery(nextValue: string) {
    const next = new URLSearchParams(params);
    if (nextValue) next.set('q', nextValue); else next.delete('q');
    setParams(next, { replace: true });
  }

  async function addSecret(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validSecretValue(value)) { setFormError(new Error('secret-limit')); return; }
    setSaving(true); setFormError(undefined); setNotice(false);
    try {
      await createSecret(name.trim(), value);
      setName(''); setValue(''); setNotice(true); setReload((current) => current + 1);
    } catch (reason) { setFormError(reason); }
    finally { setSaving(false); }
  }

  async function confirmRevocation() {
    if (!confirmDelete) return;
    setSaving(true); setFormError(undefined);
    try {
      await deleteSecret(confirmDelete.id);
      setConfirmDelete(undefined); setReload((current) => current + 1);
    } catch (reason) { setDeleteError(reason); }
    finally { setSaving(false); }
  }

  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeading level={2} eyebrow={t('secrets.eyebrow')} title={t('secrets.title')} description={t('secrets.description')} />
    <Surface className="flex flex-wrap items-start gap-2.5 border-warning/35 bg-warning-soft px-4 py-3.5 text-warning" variant="standard"><ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={19} /><p className="m-0 text-xs leading-relaxed text-ink-secondary">{t('secrets.writeOnlyNotice')}</p></Surface>
    <div className="min-w-0" data-extension-secret-create>
      <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
        <div className={SECTION_HEADING_CLASS}><div className={SECTION_HEADING_COPY_CLASS}><p className="eyebrow">{t('secrets.createEyebrow')}</p><h2 className="text-base font-semibold">{t('secrets.createTitle')}</h2><p className={SECTION_DESCRIPTION_CLASS}>{t('secrets.createDescription')}</p></div></div>
        <form className="grid max-w-[820px] gap-3.5" onSubmit={(event) => void addSecret(event)}>
          <FormField htmlFor="secret-name" label={t('secrets.name')}><Input autoComplete="off" id="secret-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></FormField>
          <FormField htmlFor="secret-value" hint={t('secrets.valueHint')} label={t('secrets.value')}><Input autoComplete="new-password" id="secret-value" onChange={(event) => setValue(event.target.value)} required type="password" value={value} /></FormField>
          <span className={`text-xs tabular-nums ${new TextEncoder().encode(value).byteLength > 16384 ? 'text-danger' : 'text-muted-foreground'}`}>{t('secrets.byteCount', { count: new TextEncoder().encode(value).byteLength, limit: 16384 })}</span>
          {formError !== undefined ? <p className="m-0 text-xs leading-relaxed text-danger" role="alert">{formError instanceof Error && formError.message === 'secret-limit' ? t('secrets.valueTooLarge') : errorDetails(formError, t)}</p> : null}
          {notice && <p className="m-0 text-xs leading-relaxed text-success" role="status">{t('secrets.createdNotice')}</p>}
          <div className="flex flex-wrap justify-end gap-2"><Button disabled={saving || !name.trim() || !value || !validSecretValue(value)} type="submit" variant="primary"><Plus aria-hidden="true" size={15} />{saving ? t('secrets.saving') : t('secrets.createAction')}</Button></div>
        </form>
      </Surface>
    </div>
    <Surface className="flex flex-wrap items-center gap-3" variant="section">
      <SearchInput aria-label={t('secrets.search')} onChange={(event) => updateQuery(event.target.value)} placeholder={t('secrets.searchPlaceholder')} value={search} className="min-h-9 min-w-[180px] max-w-[450px] flex-1" />
      <span className="whitespace-nowrap text-xs font-medium tabular-nums text-muted-foreground">{t('secrets.count', { count: visible.length })}</span>
    </Surface>
    {state === 'loading' && <LoadingState label={t('secrets.loading')} />}
    {state === 'error' && <ErrorState description={errorDetails(error, t)} title={t('secrets.loadFailed')}><Button onClick={() => setReload((current) => current + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && items.length === 0 && <EmptyState title={t('secrets.emptyTitle')} description={t('secrets.emptyDescription')} />}
    {state === 'ready' && visible.length === 0 && items.length > 0 && <EmptyState title={t('secrets.noMatches')} description={t('secrets.noMatchesDescription')} />}
    {visible.length > 0 && <div className="grid gap-2.5" role="list" aria-label={t('secrets.list')}>
      {visible.map((secret) => <div key={secret.id} role="listitem"><SecretRow onChanged={() => setReload((current) => current + 1)} onDelete={() => { setDeleteError(undefined); setConfirmDelete(secret); }} secret={secret} /></div>)}
    </div>}
    <Dialog closeLabel={t('secrets.cancel')} open={Boolean(confirmDelete)} title={confirmDelete ? t('secrets.deleteTitle', { name: confirmDelete.name }) : ''} onClose={() => { setConfirmDelete(undefined); setDeleteError(undefined); }}>
      <div className="grid gap-3.5"><p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('secrets.deleteDescription')}</p>{deleteError !== undefined ? <ErrorState description={errorDetails(deleteError, t)} title={t('secrets.deleteFailed')} /> : null}<div className="flex flex-wrap justify-end gap-2"><Button disabled={saving} onClick={() => { setConfirmDelete(undefined); setDeleteError(undefined); }}>{t('secrets.cancel')}</Button><Button disabled={saving} onClick={() => void confirmRevocation()} variant="danger"><Trash2 aria-hidden="true" size={14} />{saving ? t('secrets.deleting') : t('secrets.deleteAction')}</Button></div></div>
    </Dialog>
  </div>;
}

function SecretRow({ secret, onChanged, onDelete }: { secret: SecretMetadata; onChanged: () => void; onDelete: () => void }) {
  const { t, formatDate } = useI18n();
  const [name, setName] = useState(secret.name);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');

  async function saveName() {
    if (!name.trim() || name.trim() === secret.name) return;
    setBusy(true); setError(undefined); setNotice('');
    try { await renameSecret(secret.id, name.trim()); setNotice(t('secrets.renamedNotice')); onChanged(); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }

  async function saveValue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validSecretValue(value)) { setError(new Error('secret-limit')); return; }
    setBusy(true); setError(undefined); setNotice('');
    try { await replaceSecretValue(secret.id, value); setValue(''); setNotice(t('secrets.replacedNotice')); onChanged(); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }

  return <Surface className="flex min-w-0 flex-col gap-3.5" variant="section">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className={SECTION_HEADING_COPY_CLASS}><h2 className="truncate text-base font-semibold text-foreground">{secret.name}</h2><p className="mt-1 text-xs text-muted-foreground">{t('secrets.secretMeta', { date: formatDate(secret.updatedAt) })}</p></div><StatusChip state="configured">{t('secrets.configured')}</StatusChip></div>
    <div className="grid items-end gap-3 min-[761px]:grid-cols-[minmax(210px,1fr)_minmax(240px,1fr)_auto]">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2"><FormField htmlFor={`secret-rename-${secret.id}`} label={t('secrets.rename')}><Input autoComplete="off" id={`secret-rename-${secret.id}`} maxLength={120} onChange={(event) => setName(event.target.value)} value={name} /></FormField><Button disabled={busy || !name.trim() || name.trim() === secret.name} onClick={() => void saveName()} size="small" type="button">{t('secrets.saveName')}</Button></div>
      <form className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2" onSubmit={(event) => void saveValue(event)}><FormField htmlFor={`secret-value-${secret.id}`} hint={t('secrets.replaceHint')} label={t('secrets.replaceValue')}><Input autoComplete="new-password" id={`secret-value-${secret.id}`} onChange={(event) => setValue(event.target.value)} type="password" value={value} /></FormField><Button disabled={busy || !value || !validSecretValue(value)} size="small" type="submit"><Save aria-hidden="true" size={14} />{t('secrets.replaceAction')}</Button></form>
      <Button className="justify-self-end" disabled={busy} onClick={onDelete} size="small" type="button" variant="danger"><Trash2 aria-hidden="true" size={14} />{t('secrets.revoke')}</Button>
    </div>
    {error !== undefined ? <p className="m-0 text-xs leading-relaxed text-danger" role="alert">{error instanceof Error && error.message === 'secret-limit' ? t('secrets.valueTooLarge') : errorDetails(error, t)}</p> : null}
    {notice && <p className="m-0 text-xs leading-relaxed text-success" role="status">{notice}</p>}
  </Surface>;
}

function validSecretValue(value: string) {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 16384;
}
