import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Button, Dialog, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
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
import './extensions.css';

type ViewState = 'loading' | 'ready' | 'error';

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

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-heading extension-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action && <div className="extension-heading__action">{action}</div>}</header>;
}

export function ExtensionsPage() {
  const { extensionId } = useParams();
  return extensionId ? <ExtensionEditor extensionId={extensionId} /> : <ExtensionList />;
}

function ExtensionList() {
  const { t, formatDate } = useI18n();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<ExtensionSummary[]>([]);
  const [state, setState] = useState<ViewState>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<ExtensionLanguage>('javascript');
  const [source, setSource] = useState('export function beforeCreate(context) {\n  return { action: "allow" };\n}\n');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const navigate = useNavigate();
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (new TextEncoder().encode(source).byteLength > 262144) { setCreateError(new Error('source-limit')); return; }
    setSaving(true);
    setCreateError(undefined);
    try {
      const created = await createExtension({ name: name.trim(), language, source });
      navigate(`/extensions/${encodeURIComponent(created.id)}`);
    } catch (reason) { setCreateError(reason); }
    finally { setSaving(false); }
  }

  return <div className="page-stack extension-page">
    <PageHeading eyebrow={t('extensions.eyebrow')} title={t('extensions.title')} description={t('extensions.description')} />
    <Surface className="extension-toolbar">
      <label className="extension-search"><span className="sr-only">{t('extensions.search')}</span><input aria-label={t('extensions.search')} onChange={(event) => updateQuery(event.target.value)} placeholder={t('extensions.searchPlaceholder')} type="search" value={search} /></label>
      <span className="extension-count">{t('extensions.count', { count: visible.length })}</span>
    </Surface>
    {state === 'loading' && <LoadingState label={t('extensions.loading')} />}
    {state === 'error' && <ErrorState description={errorDetails(error, t)} title={t('extensions.loadFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && items.length === 0 && <EmptyState title={t('extensions.emptyTitle')} description={t('extensions.emptyDescription')} />}
    {state === 'ready' && visible.length === 0 && items.length > 0 && <EmptyState title={t('extensions.noMatches')} description={t('extensions.noMatchesDescription')} />}
    {visible.length > 0 && <nav className="extension-list" aria-label={t('extensions.list')}>
      {visible.map((item) => <Link className="extension-list__item" key={item.id} to={`/extensions/${encodeURIComponent(item.id)}`}>
        <span className="extension-list__identity"><strong>{item.name}</strong><span>{t('extensions.listMeta', { language: t(`extensions.languages.${item.language}`), revision: item.activeRevision, date: formatDate(item.updatedAt) })}</span></span>
        <span className="extension-list__counts">{t('extensions.bindingsCount', { count: item.bindingCount })} · {t('extensions.runs')}</span>
        <StatusChip state={item.enabled ? 'enabled' : 'disabled'}>{item.enabled ? t('extensions.enabled') : t('extensions.disabled')}</StatusChip>
        <ArrowRight aria-hidden="true" size={15} />
      </Link>)}
    </nav>}
    <Surface className="extension-create-card">
      <div className="extension-section-heading"><div><p className="eyebrow">{t('extensions.createEyebrow')}</p><h2>{t('extensions.createTitle')}</h2><p>{t('extensions.createDescription')}</p></div></div>
      <form className="extension-form-grid" onSubmit={(event) => void submit(event)}>
        <FormField htmlFor="extension-create-name" label={t('extensions.name')}><input autoComplete="off" id="extension-create-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></FormField>
        <FormField htmlFor="extension-create-language" label={t('extensions.language')}><select id="extension-create-language" onChange={(event) => setLanguage(event.target.value as ExtensionLanguage)} value={language}><option value="javascript">{t('extensions.languages.javascript')}</option><option value="typescript">{t('extensions.languages.typescript')}</option></select></FormField>
        <FormField htmlFor="extension-create-source" hint={t('extensions.sourceHint')} label={t('extensions.source')}><textarea id="extension-create-source" onChange={(event) => setSource(event.target.value)} required spellCheck={false} value={source} /></FormField>
        <span className={`extension-byte-count${new TextEncoder().encode(source).byteLength > 262144 ? ' extension-byte-count--error' : ''}`}>{t('extensions.byteCount', { count: new TextEncoder().encode(source).byteLength, limit: 262144 })}</span>
        {createError !== undefined ? <p className="extension-form-error" role="alert">{createError instanceof Error && createError.message === 'source-limit' ? t('extensions.sourceTooLarge') : errorDetails(createError, t)}</p> : null}
        <div className="extension-form-actions"><Button disabled={saving || !name.trim() || !source.trim() || new TextEncoder().encode(source).byteLength > 262144} type="submit" variant="primary"><Plus aria-hidden="true" size={15} />{saving ? t('extensions.creating') : t('extensions.createAction')}</Button></div>
      </form>
    </Surface>
  </div>;
}

function ExtensionEditor({ extensionId }: { extensionId: string }) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
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
  function selectTab(nextTab: 'settings' | 'runs') {
    const next = new URLSearchParams(params);
    if (nextTab === 'settings') { next.delete('tab'); next.delete('cursor'); next.delete('back'); next.delete('run'); }
    else { next.set('tab', 'runs'); next.delete('cursor'); next.delete('back'); next.delete('run'); }
    setParams(next, { replace: true });
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

  if (state === 'loading') return <div className="page-stack extension-page"><LoadingState label={t('extensions.loadingDetail')} /></div>;
  if (state === 'error' || !detail || !draft) return <div className="page-stack extension-page"><ErrorState description={errorDetails(error, t)} title={t('extensions.loadFailed')}><Link className="text-link" to="/extensions">{t('extensions.backToList')}</Link><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.retry')}</Button></ErrorState></div>;

  return <div className="page-stack extension-page">
    <Link className="text-link extension-back" to="/extensions"><ArrowLeft aria-hidden="true" size={15} />{t('extensions.backToList')}</Link>
    <PageHeading eyebrow={t('extensions.eyebrow')} title={detail.name} description={t('extensions.detailDescription', { revision: detail.activeRevision })} action={<div className="extension-state-action"><Button disabled={busy || hasUnsavedChanges} onClick={() => void toggleEnabled()} variant={detail.enabled ? 'danger' : 'primary'}>{detail.enabled ? t('extensions.disable') : t('extensions.enable')}</Button>{hasUnsavedChanges && <span role="status">{t('extensions.saveBeforeStateChange')}</span>}</div>} />
    {actionError !== undefined ? <ErrorState description={errorDetails(actionError, t)} title={t('extensions.actionFailed')} /> : null}
    <div className="extension-tabs" aria-label={t('extensions.tabs')} role="tablist">
      <button aria-selected={tab === 'settings'} onClick={() => selectTab('settings')} role="tab" type="button">{t('extensions.configuration')}</button>
      <button aria-selected={tab === 'runs'} onClick={() => selectTab('runs')} role="tab" type="button">{t('extensions.runs')}</button>
    </div>
    {tab === 'settings' ? <form className="extension-editor" onSubmit={(event) => void save(event)}>
      <Surface className="extension-editor-section">
        <div className="extension-section-heading"><div><p className="eyebrow">{t('extensions.sourceEyebrow')}</p><h2>{t('extensions.sourceSection')}</h2><p>{t('extensions.sourceDescription')}</p></div></div>
        <div className="extension-form-grid">
          <FormField htmlFor="extension-name" label={t('extensions.name')}><input autoComplete="off" id="extension-name" maxLength={120} onChange={(event) => updateDraft('name', event.target.value)} required value={draft.name} /></FormField>
          <FormField htmlFor="extension-language" label={t('extensions.language')}><select id="extension-language" onChange={(event) => updateDraft('language', event.target.value as ExtensionLanguage)} value={draft.language}><option value="javascript">{t('extensions.languages.javascript')}</option><option value="typescript">{t('extensions.languages.typescript')}</option></select></FormField>
          <FormField htmlFor="extension-source" hint={t('extensions.sourceHint')} label={t('extensions.source')}><textarea id="extension-source" maxLength={262144} onChange={(event) => updateDraft('source', event.target.value)} required spellCheck={false} value={draft.source} /></FormField>
          <span className={`extension-byte-count${new TextEncoder().encode(draft.source).byteLength > 262144 ? ' extension-byte-count--error' : ''}`}>{t('extensions.byteCount', { count: new TextEncoder().encode(draft.source).byteLength, limit: 262144 })}</span>
        </div>
      </Surface>
      <Surface className="extension-editor-section">
        <div className="extension-section-heading"><div><p className="eyebrow">{t('extensions.bindingEyebrow')}</p><h2>{t('extensions.bindings')}</h2><p>{t('extensions.bindingDescription')}</p></div><Button onClick={() => updateDraft('bindings', [...draft.bindings, { collectionId: collections[0]?.id ?? '', operation: 'create', phase: 'before' }])} size="small" type="button"><Plus aria-hidden="true" size={14} />{t('extensions.addBinding')}</Button></div>
        {draft.bindings.length === 0 ? <p className="extension-muted">{t('extensions.noBindings')}</p> : <div className="extension-config-list">{draft.bindings.map((binding, index) => <div className="extension-config-row" key={`${bindingKey(binding)}-${index}`}>
          <FormField htmlFor={`binding-collection-${index}`} label={t('extensions.collection')}><select id={`binding-collection-${index}`} onChange={(event) => updateDraft('bindings', draft.bindings.map((item, position) => position === index ? { ...item, collectionId: event.target.value } : item))} required value={binding.collectionId}><option value="">{t('extensions.chooseCollection')}</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}{collection.type === 'Auth' ? ` · ${t('extensions.authCollection')}` : ''}</option>)}</select></FormField>
          <FormField htmlFor={`binding-operation-${index}`} label={t('extensions.operation')}><select id={`binding-operation-${index}`} onChange={(event) => updateDraft('bindings', draft.bindings.map((item, position) => position === index ? { ...item, operation: event.target.value as ExtensionOperation } : item))} value={binding.operation}>{(['create', 'update', 'delete'] as const).map((operation) => <option key={operation} value={operation}>{t(`extensions.operations.${operation}`)}</option>)}</select></FormField>
          <FormField htmlFor={`binding-phase-${index}`} label={t('extensions.phase')}><select id={`binding-phase-${index}`} onChange={(event) => updateDraft('bindings', draft.bindings.map((item, position) => position === index ? { ...item, phase: event.target.value as ExtensionPhase } : item))} value={binding.phase}><option value="before">{t('extensions.phases.before')}</option><option value="afterCommit">{t('extensions.phases.afterCommit')}</option></select></FormField>
          <Button aria-label={t('extensions.removeBinding')} onClick={() => updateDraft('bindings', draft.bindings.filter((_, position) => position !== index))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={15} /></Button>
        </div>)}</div>}
      </Surface>
      <Surface className="extension-editor-section">
        <div className="extension-section-heading"><div><p className="eyebrow">{t('extensions.capabilitiesEyebrow')}</p><h2>{t('extensions.secretsAndOrigins')}</h2><p>{t('extensions.capabilitiesDescription')}</p></div></div>
        <section className="extension-subsection"><div className="extension-subsection-heading"><h3>{t('extensions.secretAliases')}</h3><Link className="text-link" to="/secrets">{t('extensions.manageSecrets')}</Link></div>
          {draft.secretBindings.map((binding, index) => <div className="extension-config-row" key={`secret-${index}`}>
            <FormField htmlFor={`secret-alias-${index}`} label={t('extensions.alias')}><input autoComplete="off" id={`secret-alias-${index}`} maxLength={64} onChange={(event) => updateDraft('secretBindings', draft.secretBindings.map((item, position) => position === index ? { ...item, alias: event.target.value } : item))} pattern="[A-Za-z][A-Za-z0-9_]{0,63}" required value={binding.alias} /></FormField>
            <FormField htmlFor={`secret-id-${index}`} label={t('extensions.secret')}><select id={`secret-id-${index}`} onChange={(event) => updateDraft('secretBindings', draft.secretBindings.map((item, position) => position === index ? { ...item, secretId: event.target.value } : item))} required value={binding.secretId}><option value="">{t('extensions.chooseSecret')}</option>{secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}</select></FormField>
            <span className="extension-config-row__status">{t('extensions.writeOnlyConfigured')}</span>
            <Button aria-label={t('extensions.removeSecretAlias')} onClick={() => updateDraft('secretBindings', draft.secretBindings.filter((_, position) => position !== index))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={15} /></Button>
          </div>)}
          <Button disabled={!secrets.length} onClick={() => updateDraft('secretBindings', [...draft.secretBindings, { alias: '', secretId: secrets[0]?.id ?? '' }])} size="small" type="button"><Plus aria-hidden="true" size={14} />{t('extensions.addAlias')}</Button>
          {!secrets.length && <p className="extension-muted">{t('extensions.noSecretsAvailable')} <Link className="text-link" to="/secrets">{t('extensions.createSecretLink')}</Link></p>}
        </section>
        <section className="extension-subsection"><FormField htmlFor="extension-origins" hint={t('extensions.originsHint')} label={t('extensions.allowedOrigins')}><textarea autoCapitalize="off" autoCorrect="off" id="extension-origins" onChange={(event) => setOriginsText(event.target.value)} placeholder={t('extensions.originPlaceholder')} spellCheck={false} value={originsText} /></FormField></section>
      </Surface>
      {saveError !== undefined ? <ErrorState description={saveError instanceof Error && saveError.message === 'origin-invalid' ? t('extensions.invalidOrigin') : saveError instanceof Error && saveError.message === 'source-limit' ? t('extensions.sourceTooLarge') : saveError instanceof Error && saveError.message === 'binding-duplicate' ? t('extensions.duplicateBinding') : saveError instanceof Error && saveError.message === 'alias-duplicate' ? t('extensions.duplicateAlias') : saveError instanceof Error && saveError.message === 'alias-invalid' ? t('extensions.invalidAlias') : errorDetails(saveError, t)} title={t('extensions.saveFailed')} /> : null}
      <div className="extension-form-actions"><Button disabled={saving || !draft.name.trim() || !draft.source.trim() || new TextEncoder().encode(draft.source).byteLength > 262144} type="submit" variant="primary"><Save aria-hidden="true" size={15} />{saving ? t('extensions.saving') : t('extensions.save')}</Button></div>
    </form> : <HookRunsPanel extensionId={extensionId} />}
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

  return <div className="page-stack extension-runs-page">
    <Surface className="extension-runs-intro"><div><p className="eyebrow">{t('extensions.runsEyebrow')}</p><h2>{t('extensions.runs')}</h2><p>{t('extensions.runsDescription')}</p></div><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.refresh')}</Button></Surface>
    {state === 'loading' && <LoadingState label={t('extensions.loadingRuns')} />}
    {state === 'error' && <ErrorState description={errorDetails(error, t)} title={t('extensions.runsFailed')}><Button onClick={() => setReload((value) => value + 1)} size="small">{t('extensions.retry')}</Button></ErrorState>}
    {state === 'ready' && runs.length === 0 && <EmptyState title={t('extensions.noRuns')} description={t('extensions.noRunsDescription')} />}
    {state === 'ready' && runs.length > 0 && <div className="extension-run-list" role="list" aria-label={t('extensions.runs')}>
      {runs.map((run) => <article className="extension-run-card" key={run.runId} role="listitem">
        <div className="extension-run-card__main"><div className="extension-run-card__heading"><StatusChip state={run.status}>{t(`extensions.statuses.${run.status}`)}</StatusChip><span>{t(`extensions.operations.${run.operation}`)} · {t(`extensions.phases.${run.phase}`)}</span></div><strong>{t('extensions.runRevision', { revision: run.revision })}</strong><span>{formatDate(run.startedAt)}{typeof run.durationMs === 'number' ? ` · ${t('extensions.duration', { duration: formatNumber(run.durationMs) })}` : ''}</span></div>
        <div className="extension-run-card__context"><span>{t('extensions.collectionId', { id: run.collectionId })}</span>{run.recordId && <Link className="text-link" to={`/collections/${encodeURIComponent(run.collectionId)}?record=${encodeURIComponent(run.recordId)}`}>{t('extensions.recordId', { id: run.recordId })}</Link>}{run.eventId && <span>{t('extensions.eventId', { id: run.eventId })}</span>}</div>
        <div className="extension-run-card__end"><span>{run.errorCode !== 'none' ? t(`extensions.errorCodes.${run.errorCode}` as never) : ''}</span><Button onClick={() => selectRun(run.runId)} size="small">{t('extensions.safeDetails')}</Button></div>
      </article>)}
      <nav aria-label={t('extensions.runPages')} className="extension-pagination"><Button disabled={!backCursors.length} onClick={() => pageTo()} size="small"><ArrowLeft aria-hidden="true" size={14} />{t('extensions.previous')}</Button><span>{t('extensions.pageLimit')}</span><Button disabled={!nextCursor} onClick={() => pageTo(nextCursor)} size="small">{t('extensions.next')}<ArrowRight aria-hidden="true" size={14} /></Button></nav>
    </div>}
    {selectedId && <Surface className="extension-run-detail"><div className="extension-section-heading"><div><p className="eyebrow">{t('extensions.safeDiagnostics')}</p><h3>{t('extensions.runDetail')}</h3><p>{t('extensions.safeDiagnosticsDescription')}</p></div><Button aria-label={t('extensions.closeDetails')} onClick={() => selectRun()} size="small" variant="quiet">×</Button></div>
      {detailState === 'loading' && <LoadingState label={t('extensions.loadingRun')} />}
      {detailState === 'error' && <ErrorState description={t('extensions.runNotFound')} title={t('extensions.runDetailFailed')} />}
      {detailState === 'ready' && selected && <dl className="extension-run-metadata">
        <div><dt>{t('extensions.runId')}</dt><dd><code>{selected.runId}</code></dd></div><div><dt>{t('extensions.status')}</dt><dd>{t(`extensions.statuses.${selected.status}`)}</dd></div>
        <div><dt>{t('extensions.revision')}</dt><dd>{selected.revision}</dd></div><div><dt>{t('extensions.operation')}</dt><dd>{t(`extensions.operations.${selected.operation}`)} · {t(`extensions.phases.${selected.phase}`)}</dd></div>
        <div><dt>{t('extensions.collection')}</dt><dd><Link className="text-link" to={`/collections/${encodeURIComponent(selected.collectionId)}`}>{selected.collectionId}</Link></dd></div>
        {selected.recordId && <div><dt>{t('extensions.record')}</dt><dd><Link className="text-link" to={`/collections/${encodeURIComponent(selected.collectionId)}?record=${encodeURIComponent(selected.recordId)}`}>{selected.recordId}</Link></dd></div>}
        {selected.eventId && <div><dt>{t('extensions.event')}</dt><dd>{selected.eventId}</dd></div>}
        <div><dt>{t('extensions.startedAt')}</dt><dd>{formatDate(selected.startedAt)}</dd></div>{selected.completedAt && <div><dt>{t('extensions.completedAt')}</dt><dd>{formatDate(selected.completedAt)}</dd></div>}
        {typeof selected.durationMs === 'number' && <div><dt>{t('extensions.durationLabel')}</dt><dd>{t('extensions.duration', { duration: formatNumber(selected.durationMs) })}</dd></div>}
        <div><dt>{t('extensions.errorCategory')}</dt><dd>{selected.errorCode === 'none' ? t('extensions.noError') : t(`extensions.errorCodes.${selected.errorCode}` as never)}</dd></div>{selected.correlationId && <div><dt>{t('extensions.correlationId')}</dt><dd><code>{selected.correlationId}</code></dd></div>}
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

  return <div className="page-stack extension-page">
    <PageHeading eyebrow={t('secrets.eyebrow')} title={t('secrets.title')} description={t('secrets.description')} />
    <Surface className="extension-secret-warning"><ShieldAlert aria-hidden="true" size={19} /><p>{t('secrets.writeOnlyNotice')}</p></Surface>
    <Surface className="extension-secret-create">
      <div className="extension-section-heading"><div><p className="eyebrow">{t('secrets.createEyebrow')}</p><h2>{t('secrets.createTitle')}</h2><p>{t('secrets.createDescription')}</p></div></div>
      <form className="extension-form-grid" onSubmit={(event) => void addSecret(event)}>
        <FormField htmlFor="secret-name" label={t('secrets.name')}><input autoComplete="off" id="secret-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></FormField>
        <FormField htmlFor="secret-value" hint={t('secrets.valueHint')} label={t('secrets.value')}><input autoComplete="new-password" id="secret-value" onChange={(event) => setValue(event.target.value)} required type="password" value={value} /></FormField>
        <span className={`extension-byte-count${new TextEncoder().encode(value).byteLength > 16384 ? ' extension-byte-count--error' : ''}`}>{t('secrets.byteCount', { count: new TextEncoder().encode(value).byteLength, limit: 16384 })}</span>
        {formError !== undefined ? <p className="extension-form-error" role="alert">{formError instanceof Error && formError.message === 'secret-limit' ? t('secrets.valueTooLarge') : errorDetails(formError, t)}</p> : null}
        {notice && <p className="extension-form-notice" role="status">{t('secrets.createdNotice')}</p>}
        <div className="extension-form-actions"><Button disabled={saving || !name.trim() || !value || !validSecretValue(value)} type="submit" variant="primary"><Plus aria-hidden="true" size={15} />{saving ? t('secrets.saving') : t('secrets.createAction')}</Button></div>
      </form>
    </Surface>
    <Surface className="extension-toolbar">
      <label className="extension-search"><span className="sr-only">{t('secrets.search')}</span><input aria-label={t('secrets.search')} onChange={(event) => updateQuery(event.target.value)} placeholder={t('secrets.searchPlaceholder')} type="search" value={search} /></label>
      <span className="extension-count">{t('secrets.count', { count: visible.length })}</span>
    </Surface>
    {state === 'loading' && <LoadingState label={t('secrets.loading')} />}
    {state === 'error' && <ErrorState description={errorDetails(error, t)} title={t('secrets.loadFailed')}><Button onClick={() => setReload((current) => current + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('extensions.retry')}</Button></ErrorState>}
    {state === 'ready' && visible.length === 0 && items.length === 0 && <EmptyState title={t('secrets.emptyTitle')} description={t('secrets.emptyDescription')} />}
    {state === 'ready' && visible.length === 0 && items.length > 0 && <EmptyState title={t('secrets.noMatches')} description={t('secrets.noMatchesDescription')} />}
    {visible.length > 0 && <div className="extension-secret-list" role="list" aria-label={t('secrets.list')}>
      {visible.map((secret) => <div key={secret.id} role="listitem"><SecretRow onChanged={() => setReload((current) => current + 1)} onDelete={() => { setDeleteError(undefined); setConfirmDelete(secret); }} secret={secret} /></div>)}
    </div>}
    <Dialog closeLabel={t('secrets.cancel')} open={Boolean(confirmDelete)} title={confirmDelete ? t('secrets.deleteTitle', { name: confirmDelete.name }) : ''} onClose={() => { setConfirmDelete(undefined); setDeleteError(undefined); }}>
      <div className="extension-confirm-content"><p>{t('secrets.deleteDescription')}</p>{deleteError !== undefined ? <ErrorState description={errorDetails(deleteError, t)} title={t('secrets.deleteFailed')} /> : null}<div className="extension-form-actions"><Button disabled={saving} onClick={() => { setConfirmDelete(undefined); setDeleteError(undefined); }}>{t('secrets.cancel')}</Button><Button disabled={saving} onClick={() => void confirmRevocation()} variant="danger"><Trash2 aria-hidden="true" size={14} />{saving ? t('secrets.deleting') : t('secrets.deleteAction')}</Button></div></div>
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

  return <Surface className="extension-secret-row">
    <div className="extension-secret-row__heading"><div><h2>{secret.name}</h2><p>{t('secrets.secretMeta', { date: formatDate(secret.updatedAt) })}</p></div><StatusChip state="configured">{t('secrets.configured')}</StatusChip></div>
    <div className="extension-secret-actions">
      <div className="extension-secret-rename"><FormField htmlFor={`secret-rename-${secret.id}`} label={t('secrets.rename')}><input autoComplete="off" id={`secret-rename-${secret.id}`} maxLength={120} onChange={(event) => setName(event.target.value)} value={name} /></FormField><Button disabled={busy || !name.trim() || name.trim() === secret.name} onClick={() => void saveName()} size="small" type="button">{t('secrets.saveName')}</Button></div>
      <form className="extension-secret-replace" onSubmit={(event) => void saveValue(event)}><FormField htmlFor={`secret-value-${secret.id}`} hint={t('secrets.replaceHint')} label={t('secrets.replaceValue')}><input autoComplete="new-password" id={`secret-value-${secret.id}`} onChange={(event) => setValue(event.target.value)} type="password" value={value} /></FormField><Button disabled={busy || !value || !validSecretValue(value)} size="small" type="submit"><Save aria-hidden="true" size={14} />{t('secrets.replaceAction')}</Button></form>
      <Button disabled={busy} onClick={onDelete} size="small" type="button" variant="danger"><Trash2 aria-hidden="true" size={14} />{t('secrets.revoke')}</Button>
    </div>
    {error !== undefined ? <p className="extension-form-error" role="alert">{error instanceof Error && error.message === 'secret-limit' ? t('secrets.valueTooLarge') : errorDetails(error, t)}</p> : null}
    {notice && <p className="extension-form-notice" role="status">{notice}</p>}
  </Surface>;
}

function validSecretValue(value: string) {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 16384;
}
