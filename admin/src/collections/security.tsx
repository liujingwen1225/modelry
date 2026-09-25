import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, KeyRound, RefreshCw, Search, Shield, ShieldCheck, UserRound } from 'lucide-react';
import { ApiClientError } from '../api/client';
import { Button, EmptyState, ErrorState, FormField, LoadingState, Surface } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import {
  applyAccessRules,
  applyAuthenticationConfiguration,
  discardAuthenticationConfiguration,
  discardAccessRules,
  getApplicationUserSessions,
  getAuthenticationConfiguration,
  getAccessRules,
  getRecord,
  listApplicationUsers,
  listAllCollections,
  revokeAllApplicationUserSessions,
  revokeApplicationUserSession,
  saveAccessRules,
  saveAuthenticationConfiguration,
  setApplicationUserPassword,
  type AccessExpression,
  type AccessOperation,
  type AccessPredicate,
  type AccessRule,
  type AccessRuleMode,
  type AccessRulesState,
  type ApplicationSession,
  type ApplicationUser,
  type AuthenticationConfiguration,
  type AuthenticationConfigurationState,
  type Collection,
  type EmailVerificationMode,
  type FieldDefinition,
} from './client';
import { AccessRuleSimulation } from './simulate';
import { useCollectionWorkspace } from './workspace-context';

const OPERATIONS: AccessOperation[] = ['list', 'view', 'create', 'update', 'delete'];
const MODES: AccessRuleMode[] = ['noAccess', 'anyone', 'signedInUsers', 'recordOwner', 'custom'];
type Translate = ReturnType<typeof useI18n>['t'];

type ConditionDraft = { fieldId: string; operator: 'eq' | 'neq' | 'in'; value: string };

function errorCopy(error: unknown, fallback: string, t: Translate) {
  if (!(error instanceof ApiClientError)) return { title: fallback, message: error instanceof Error ? error.message : t('common.tryAgainWhenAvailable') };
  return {
    title: error.apiError.message,
    message: [error.apiError.code, error.apiError.hint, `${t('common.requestId')}: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
  };
}

function orderedRules(rules: AccessRule[]) {
  return OPERATIONS.map((operation) => rules.find((rule) => rule.operation === operation) ?? { operation, mode: 'noAccess' as const });
}

function cloneRule(rule: AccessRule): AccessRule {
  return JSON.parse(JSON.stringify(rule)) as AccessRule;
}

function expressionConditions(expression?: AccessExpression): AccessPredicate[] {
  return expression && expression.version === 1 && Array.isArray(expression.all) ? expression.all : [];
}

function valueForControl(value: unknown, operator: string) {
  return operator === 'in' ? JSON.stringify(value, null, 2) : value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value);
}

function countChanged(applied: AccessRule[], pending: AccessRule[]) {
  const original = orderedRules(applied);
  const draft = orderedRules(pending);
  return draft.filter((rule, index) => JSON.stringify(rule) !== JSON.stringify(original[index])).length;
}

function parseTypedValue(raw: string, field: FieldDefinition, operator: string): { valid: boolean; value?: unknown } {
  if (operator === 'in') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) return { valid: false };
      const typed = parsed.map((item) => parsePrimitive(item, field));
      return typed.every((item) => item.valid) ? { valid: true, value: typed.map((item) => item.value) } : { valid: false };
    } catch { return { valid: false }; }
  }
  let value: unknown = raw;
  if (field.type === 'number') {
    const number = Number(raw);
    if (!Number.isFinite(number)) return { valid: false };
    value = number;
  } else if (field.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') return { valid: false };
    value = raw === 'true';
  } else if (field.type === 'json') {
    try { value = JSON.parse(raw) as unknown; } catch { return { valid: false }; }
  }
  return parsePrimitive(value, field);
}

function parsePrimitive(value: unknown, field: FieldDefinition): { valid: boolean; value?: unknown } {
  if (value === null) return { valid: true, value };
  if (field.type === 'text' || field.type === 'dateTime' || field.type === 'relation') {
    if (typeof value !== 'string') return { valid: false };
    if (field.type === 'dateTime' && Number.isNaN(Date.parse(value))) return { valid: false };
    return { valid: true, value };
  }
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? { valid: true, value } : { valid: false };
  if (field.type === 'boolean') return typeof value === 'boolean' ? { valid: true, value } : { valid: false };
  if (field.type === 'json') return { valid: true, value };
  return { valid: false };
}

function predicateValueControl(field: FieldDefinition, operator: string, value: string, onChange: (value: string) => void, t: Translate) {
  if (operator === 'in' || field.type === 'json') {
    return <textarea aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} placeholder={operator === 'in' ? '["one", "two"]' : '{"status":"active"}'} rows={2} value={value} />;
  }
  if (field.type === 'boolean') return <select aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} value={value || 'true'}><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option><option value="">{t('security.nullOption')}</option></select>;
  if (field.type === 'number') return <input aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} type="number" value={value} />;
  if (field.type === 'dateTime') return <input aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} placeholder="2026-09-24T10:00:00Z" type="text" value={value} />;
  return <input aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} type="text" value={value} />;
}

export function CollectionSecurityPage() {
  const { t } = useI18n();
  const { collection } = useCollectionWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const authTabs = collection.type === 'Auth';
  const requestedPanel = searchParams.get('panel') ?? 'rules';
  const activePanel = authTabs && ['authentication', 'users', 'sessions'].includes(requestedPanel) ? requestedPanel : 'rules';
  const [state, setState] = useState<AccessRulesState>();
  const [references, setReferences] = useState<Collection[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [referenceError, setReferenceError] = useState(false);
  const [editing, setEditing] = useState<AccessOperation>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [message, setMessage] = useState<TranslationKey | ''>('');
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = orderedRules(state?.pending ?? []);
  const applied = orderedRules(state?.applied ?? []);
  const changedCount = state ? countChanged(applied, pending) : 0;
  const authIds = useMemo(() => new Set(references.filter((item) => item.type === 'Auth').map((item) => item.id)), [references]);
  const ownerFields = collection.fields.filter((field) => field.type === 'relation' && field.id && field.relation && authIds.has(field.relation.targetCollectionId));
  const customFields = collection.fields.filter((field) => !field.system && field.id && field.type !== 'file');

  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    setError(undefined);
    void Promise.allSettled([getAccessRules(collection.id, controller.signal), listAllCollections(controller.signal)]).then(([rulesResult, collectionsResult]) => {
      if (controller.signal.aborted) return;
      if (rulesResult.status === 'rejected') throw rulesResult.reason;
      setState({ ...rulesResult.value, applied: orderedRules(rulesResult.value.applied), pending: orderedRules(rulesResult.value.pending) });
      if (collectionsResult.status === 'fulfilled') {
        setReferences(collectionsResult.value);
        setReferenceError(false);
      } else {
        setReferences([]);
        setReferenceError(true);
      }
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setLoadState('error');
    });
    return () => controller.abort();
  }, [collection.id, reloadKey]);

  async function saveRule(rule: AccessRule) {
    if (!state) return;
    const rules = orderedRules(state.pending).map((item) => item.operation === rule.operation ? rule : item);
    setBusy(true);
    setActionError(undefined);
    setMessage('');
    try {
      const next = await saveAccessRules(collection.id, state.version, rules);
      setState({ ...next, applied: orderedRules(next.applied), pending: orderedRules(next.pending) });
      setEditing(undefined);
      setMessage('security.savedPending');
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!state || !changedCount) return;
    setBusy(true);
    setActionError(undefined);
    setMessage('');
    try {
      await applyAccessRules(collection.id, state.version);
      const current = await getAccessRules(collection.id);
      setState({ ...current, applied: orderedRules(current.applied), pending: orderedRules(current.pending) });
      setConfirmApply(false);
      setMessage('security.applied');
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }

  async function discard() {
    if (!state || !changedCount) return;
    setBusy(true);
    setActionError(undefined);
    setMessage('');
    try {
      const current = await discardAccessRules(collection.id, state.version);
      setState({ ...current, applied: orderedRules(current.applied), pending: orderedRules(current.pending) });
      setConfirmDiscard(false);
      setMessage('security.discarded');
      setEditing(undefined);
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }

  function selectPanel(panel: string) {
    const next = new URLSearchParams(searchParams);
    if (panel === 'rules') next.delete('panel');
    else next.set('panel', panel);
    setSearchParams(next);
  }

  return (
    <div className="page-stack collection-page security-page">
      <header className="page-heading collection-heading"><div><p className="eyebrow">{collection.name} · {t('security.eyebrow')}</p><h1>{t('security.title')}</h1><p className="page-description">{t('security.description')}</p></div><span className="security-heading-icon"><Shield aria-hidden="true" size={19} /></span></header>
      <nav aria-label={t('security.sectionsLabel')} className="security-tabs" role="tablist">
        <button aria-controls="security-panel-rules" aria-selected={activePanel === 'rules'} id="security-tab-rules" onClick={() => selectPanel('rules')} role="tab" type="button">{t('security.tabs.rules')}</button>
        {authTabs && <>
          <button aria-controls="security-panel-authentication" aria-selected={activePanel === 'authentication'} id="security-tab-authentication" onClick={() => selectPanel('authentication')} role="tab" type="button">{t('security.tabs.authentication')}</button>
          <button aria-controls="security-panel-users" aria-selected={activePanel === 'users'} id="security-tab-users" onClick={() => selectPanel('users')} role="tab" type="button">{t('security.tabs.users')}</button>
          <button aria-controls="security-panel-sessions" aria-selected={activePanel === 'sessions'} id="security-tab-sessions" onClick={() => selectPanel('sessions')} role="tab" type="button">{t('security.tabs.sessions')}</button>
        </>}
      </nav>
      {activePanel === 'rules' && <div aria-labelledby="security-tab-rules" className="page-stack security-panel" id="security-panel-rules" role="tabpanel">
      {loadState === 'ready' && <AccessRuleSimulation collectionId={collection.id} />}
      {loadState === 'loading' && <LoadingState label={t('security.loadingRules')} />}
      {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.loadFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
      {loadState === 'ready' && state && <>
        {referenceError && <div className="security-dependency-error" role="status">{t('security.referencesUnavailable')} <Button onClick={() => setReloadKey((value) => value + 1)} size="small">{t('common.retry')}</Button></div>}
        {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{t(message)}</div>}
        {actionError && (() => { const copy = errorCopy(actionError, t('security.changeFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('security.reloadRules')}</Button></ErrorState>; })()}
        <Surface className="security-rules-card" variant="standard">
          <div className="security-rules-heading"><div><h2>{t('security.appliedTitle')}</h2><p>{t('security.appliedDescription')}</p></div><span className="security-version">{t('security.version', { version: state.version })}</span></div>
          <div className="security-rule-list" role="list">{OPERATIONS.map((operation) => {
            const current = pending.find((rule) => rule.operation === operation)!;
            const previous = applied.find((rule) => rule.operation === operation)!;
            const isChanged = JSON.stringify(current) !== JSON.stringify(previous);
            const ownerField = collection.fields.find((field) => field.id === current.ownerFieldId);
            return <article className="security-rule-row" key={operation} role="listitem">
              <div className="security-rule-operation"><span>{t(`security.operations.${operation}`)}</span>{isChanged && <span className="security-pending-mark">{t('security.pendingMark')}</span>}</div>
              <div className="security-rule-summary"><strong>{t(`accessModes.${current.mode}.label`)}</strong>{current.mode === 'recordOwner' && <span>{ownerField?.name ?? t('security.relationField')}</span>}{current.mode === 'custom' && <span>{t('security.conditionCount', { count: expressionConditions(current.expression).length })}</span>}</div>
              <Button aria-label={t('security.editAccess', { operation: t(`security.operations.${operation}`) })} disabled={busy || editing === operation} onClick={() => { setActionError(undefined); setEditing(operation); }} size="small">{t('security.edit')}</Button>
            </article>;
          })}</div>
          {editing && <AccessRuleEditor
          busy={busy}
            customFields={customFields}
            onCancel={() => setEditing(undefined)}
            onSave={(rule) => void saveRule(rule)}
            ownerFields={ownerFields}
            rule={cloneRule(pending.find((item) => item.operation === editing)!)}
          />}
          {changedCount > 0 ? <div aria-label={t('security.pendingPanelLabel')} className="security-pending-panel" role="region">
            <div><strong>{t(changedCount === 1 ? 'security.pendingOne' : 'security.pendingMany', { count: changedCount })}</strong><span>{t('security.pendingHint')}</span></div>
            <div className="security-pending-actions"><Button disabled={busy} onClick={() => setConfirmDiscard(true)} size="small">{t('security.discard')}</Button><Button disabled={busy} onClick={() => setConfirmApply(true)} variant="primary">{t(changedCount === 1 ? 'security.applyOne' : 'security.applyMany', { count: changedCount })}</Button></div>
          </div> : <div className="security-applied-state"><ShieldCheck aria-hidden="true" size={15} />{t('security.allApplied')}</div>}
          {confirmApply && <div className="security-confirm-panel" role="alert"><strong>{t('security.confirmApplyTitle')}</strong><span>{t('security.confirmApplyBody')}</span><div><Button disabled={busy} onClick={() => setConfirmApply(false)} size="small">{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void apply()} size="small" variant="primary">{busy ? t('security.applying') : t('security.confirmAndApply')}</Button></div></div>}
          {confirmDiscard && <div className="security-confirm-panel" role="alert"><strong>{t('security.discardConfirmTitle')}</strong><span>{t('security.discardConfirmBody')}</span><div><Button disabled={busy} onClick={() => setConfirmDiscard(false)} size="small">{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void discard()} size="small" variant="danger">{busy ? t('security.discarding') : t('security.discardPending')}</Button></div></div>}
        </Surface>
        {customFields.length === 0 && <EmptyState description={t('security.customNeedsFieldDescription')} title={t('security.customNeedsFieldTitle')} />}
      </>}
      </div>}
      {activePanel === 'authentication' && <AuthenticationPanel collectionId={collection.id} />}
      {activePanel === 'users' && <ApplicationUsersPanel collection={collection} />}
      {activePanel === 'sessions' && <ApplicationSessionsPanel collection={collection} />}
    </div>
  );
}

function AccessRuleEditor({ rule, ownerFields, customFields, busy, onSave, onCancel }: {
  rule: AccessRule;
  ownerFields: FieldDefinition[];
  customFields: FieldDefinition[];
  busy: boolean;
  onSave: (rule: AccessRule) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<AccessRuleMode>(rule.mode);
  const [ownerFieldId, setOwnerFieldId] = useState(rule.ownerFieldId ?? '');
  const [conditions, setConditions] = useState<ConditionDraft[]>(() => expressionConditions(rule.expression).map((item) => ({ fieldId: item.fieldId, operator: item.operator, value: valueForControl(item.value, item.operator) })));
  const [validationError, setValidationError] = useState<TranslationKey | ''>('');
  const [validationValues, setValidationValues] = useState<{ index?: number; name?: string }>({});
  const canUseRecordOwner = ownerFields.length > 0;
  const conditionField = (id: string) => customFields.find((field) => field.id === id);

  function updateCondition(index: number, patch: Partial<ConditionDraft>) {
    setConditions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
    setValidationError('');
  }

  function addCondition() {
    const field = customFields[0];
    if (field?.id) setConditions((current) => [...current, { fieldId: field.id!, operator: 'eq', value: '' }]);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setValidationError('');
    const next: AccessRule = { operation: rule.operation, mode };
    if (mode === 'recordOwner') {
      if (!ownerFields.some((field) => field.id === ownerFieldId)) { setValidationError('security.errorOwnerField'); return; }
      next.ownerFieldId = ownerFieldId;
    }
    if (mode === 'custom') {
      if (!conditions.length || conditions.length > 16) { setValidationError('security.errorConditionCount'); return; }
      const predicates: AccessPredicate[] = [];
      for (const [index, condition] of conditions.entries()) {
        const field = conditionField(condition.fieldId);
        if (!field?.id) { setValidationError('security.errorConditionField'); setValidationValues({ index: index + 1 }); return; }
        const parsed = parseTypedValue(condition.value, field, condition.operator);
        if (!parsed.valid) {
          setValidationError(condition.operator === 'in' ? 'security.errorConditionValueArray' : 'security.errorConditionValue');
          setValidationValues({ name: field.name });
          return;
        }
        predicates.push({ fieldId: field.id, operator: condition.operator, value: parsed.value });
      }
      next.expression = { version: 1, all: predicates };
    }
    onSave(next);
  }

  return <form className="security-rule-editor" onSubmit={submit}>
    <div className="security-rule-editor-heading"><div><p className="eyebrow">{t('security.editorEyebrow')}</p><h3>{t('security.editAccess', { operation: t(`security.operations.${rule.operation}`) })}</h3></div><span>{t('security.editorDescription')}</span></div>
    <fieldset className="security-mode-options"><legend>{t('security.whoCan', { operation: t(`security.operationVerbs.${rule.operation}`) })}</legend>
      {MODES.map((value) => <label className="security-mode-option" key={value}>
        <input checked={mode === value} disabled={value === 'recordOwner' && !canUseRecordOwner} name={`access-${rule.operation}`} onChange={() => setMode(value)} type="radio" value={value} />
        <span><strong>{t(`accessModes.${value}.label`)}</strong><small>{t(`accessModes.${value}.description`)}</small></span>
      </label>)}
      {!canUseRecordOwner && <p className="security-form-hint">{t('security.recordOwnerNeedsField')}</p>}
    </fieldset>
    {mode === 'recordOwner' && <FormField htmlFor="access-owner-field" label={t('security.ownerField')} hint={t('security.ownerFieldHint')}>
      <select id="access-owner-field" onChange={(event) => setOwnerFieldId(event.target.value)} value={ownerFieldId}><option value="">{t('security.chooseField')}</option>{ownerFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select>
    </FormField>}
    {mode === 'custom' && <section aria-label={t('security.conditionsLabel')} className="security-custom-editor">
      <div className="security-custom-heading"><div><h4>{t('security.conditionsTitle')}</h4><p>{t('security.conditionsDescription')}</p></div><Button disabled={conditions.length >= 16 || customFields.length === 0} onClick={addCondition} size="small" type="button">{t('security.addCondition')}</Button></div>
      {conditions.map((condition, index) => {
        const field = conditionField(condition.fieldId);
        return <div className="security-condition" key={`${index}-${condition.fieldId}`}>
          <label><span>{t('security.field')}</span><select aria-label={t('security.conditionField', { index: index + 1 })} onChange={(event) => updateCondition(index, { fieldId: event.target.value, value: '' })} value={condition.fieldId}>{customFields.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
          <label><span>{t('security.operator')}</span><select aria-label={t('security.conditionOperator', { index: index + 1 })} onChange={(event) => updateCondition(index, { operator: event.target.value as ConditionDraft['operator'], value: '' })} value={condition.operator}><option value="eq">{t('security.operators.eq')}</option><option value="neq">{t('security.operators.neq')}</option><option value="in">{t('security.operators.in')}</option></select></label>
          <label className="security-condition-value"><span>{condition.operator === 'in' ? t('security.valueJsonArray') : t('security.value')}</span>{field ? predicateValueControl(field, condition.operator, condition.value, (value) => updateCondition(index, { value }), t) : <input aria-label={t('security.conditionValue')} disabled value="" />}</label>
          <Button aria-label={t('security.removeCondition', { index: index + 1 })} disabled={conditions.length === 1} onClick={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))} size="small" type="button" variant="quiet">{t('security.remove')}</Button>
        </div>;
      })}
    </section>}
    {validationError && <div className="record-field-error" role="alert">{t(validationError, validationValues)}</div>}
    <div className="security-rule-editor-actions"><Button disabled={busy} onClick={onCancel} type="button" variant="quiet">{t('common.cancel')}</Button><Button disabled={busy || (mode === 'custom' && customFields.length === 0)} type="submit" variant="primary">{busy ? t('security.saving') : t('security.save')}</Button></div>
  </form>;
}

function emailVerificationLabel(mode: EmailVerificationMode | undefined, t: Translate): string {
  switch (mode) {
    case 'required': return t('security.emailVerificationLabels.required');
    case 'optional': return t('security.emailVerificationLabels.optional');
    default: return t('security.emailVerificationLabels.off');
  }
}

function emailVerificationHint(mode: EmailVerificationMode | undefined, t: Translate): string {
  switch (mode) {
    case 'required': return t('security.emailVerificationHints.required');
    case 'optional': return t('security.emailVerificationHints.optional');
    default: return t('security.emailVerificationHints.off');
  }
}
function AuthenticationPanel({ collectionId }: { collectionId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<AuthenticationConfigurationState>();
  const [draft, setDraft] = useState<AuthenticationConfiguration>();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [message, setMessage] = useState<TranslationKey | ''>('');

  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    void getAuthenticationConfiguration(collectionId, controller.signal).then((configuration) => {
      if (controller.signal.aborted) return;
      setState(configuration);
      setDraft(configuration.pending);
      setLoadState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setLoadState('error');
    });
    return () => controller.abort();
  }, [collectionId, reloadKey]);

  const hasPending = Boolean(state && JSON.stringify(state.applied) !== JSON.stringify(state.pending));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!state || !draft || draft.sessionDurationDays < 1 || !Number.isInteger(draft.sessionDurationDays)) return;
    setSaving(true);
    setActionError(undefined);
    try {
      const next = await saveAuthenticationConfiguration(collectionId, state.version, draft);
      setState(next);
      setDraft(next.pending);
      setEditing(false);
      setMessage('security.authSaved');
    } catch (reason) { setActionError(reason); }
    finally { setSaving(false); }
  }

  async function apply() {
    if (!state || !hasPending) return;
    setSaving(true);
    setActionError(undefined);
    try {
      await applyAuthenticationConfiguration(collectionId, state.version);
      const next = await getAuthenticationConfiguration(collectionId);
      setState(next);
      setDraft(next.pending);
      setConfirmApply(false);
      setMessage('security.authApplied');
    } catch (reason) { setActionError(reason); }
    finally { setSaving(false); }
  }

  async function discard() {
    if (!state || !hasPending) return;
    setSaving(true);
    setActionError(undefined);
    try {
      const next = await discardAuthenticationConfiguration(collectionId, state.version);
      setState(next);
      setDraft(next.pending);
      setEditing(false);
      setConfirmDiscard(false);
      setMessage('security.authDiscarded');
    } catch (reason) { setActionError(reason); }
    finally { setSaving(false); }
  }

  return <div aria-labelledby="security-tab-authentication" className="page-stack security-panel" id="security-panel-authentication" role="tabpanel">
    {loadState === 'loading' && <LoadingState label={t('security.authenticationLoading')} />}
    {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.authenticationLoadFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
    {loadState === 'ready' && state && draft && <>
      {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{t(message)}</div>}
      {actionError && (() => { const copy = errorCopy(actionError, t('security.authenticationChangeFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('security.authenticationReload')}</Button></ErrorState>; })()}
      <Surface className="security-auth-card" variant="standard">
        <div className="security-rules-heading"><div><h2>{t('security.authenticationTitle')}</h2><p>{t('security.authenticationDescription')}</p></div><span className="security-version">{t('security.version', { version: state.version })}</span></div>
        {!editing ? <dl className="security-auth-values">
          <div><dt>{t('security.emailPassword')}</dt><dd><strong>{t(state.pending.emailPasswordEnabled ? 'security.enabled' : 'security.disabled')}</strong><span>{t(state.pending.emailPasswordEnabled ? 'security.emailPasswordEnabled' : 'security.emailPasswordDisabled')}</span></dd></div>
          <div><dt>{t('security.selfRegistration')}</dt><dd><strong>{t(state.pending.selfRegistration ? 'security.enabled' : 'security.disabled')}</strong><span>{t(state.pending.selfRegistration ? 'security.selfRegistrationEnabled' : 'security.selfRegistrationDisabled')}</span></dd></div>
          <div><dt>{t('security.sessionDuration')}</dt><dd><strong>{t('security.sessionDurationValue', { count: state.pending.sessionDurationDays })}</strong><span>{t('security.sessionDurationExpiry')}</span></dd></div>
          <div><dt>{t('security.emailVerification')}</dt><dd><strong>{emailVerificationLabel(state.pending.emailVerification, t)}</strong><span>{emailVerificationHint(state.pending.emailVerification, t)}</span></dd></div>
        </dl> : <form className="security-auth-editor" onSubmit={(event) => void save(event)}>
          <FormField htmlFor="auth-email-password" hint={t('security.authEmailPasswordHint')} label={t('security.emailPassword')}><select id="auth-email-password" onChange={(event) => setDraft({ ...draft, emailPasswordEnabled: event.target.value === 'enabled' })} value={draft.emailPasswordEnabled ? 'enabled' : 'disabled'}><option value="enabled">{t('security.enabled')}</option><option value="disabled">{t('security.disabled')}</option></select></FormField>
          <FormField htmlFor="auth-self-registration" label={t('security.selfRegistration')}><select id="auth-self-registration" onChange={(event) => setDraft({ ...draft, selfRegistration: event.target.value === 'enabled' })} value={draft.selfRegistration ? 'enabled' : 'disabled'}><option value="disabled">{t('security.disabled')}</option><option value="enabled">{t('security.enabled')}</option></select></FormField>
          <FormField htmlFor="auth-session-days" hint={t('security.authSessionDaysHint')} label={t('security.authSessionDays')}><input id="auth-session-days" min="1" onChange={(event) => setDraft({ ...draft, sessionDurationDays: Number(event.target.value) })} type="number" value={draft.sessionDurationDays} /></FormField>
          <FormField htmlFor="auth-email-verification" hint={t('security.authEmailVerificationHint')} label={t('security.emailVerification')}><select id="auth-email-verification" onChange={(event) => setDraft({ ...draft, emailVerification: event.target.value as EmailVerificationMode })} value={draft.emailVerification ?? 'off'}><option value="off">{t('security.emailVerificationLabels.off')}</option><option value="optional">{t('security.emailVerificationLabels.optional')}</option><option value="required">{t('security.emailVerificationLabels.required')}</option></select></FormField>
          <div className="security-rule-editor-actions"><Button disabled={saving} onClick={() => { setDraft(state.pending); setEditing(false); }} type="button" variant="quiet">{t('common.cancel')}</Button><Button disabled={saving || draft.sessionDurationDays < 1 || !Number.isInteger(draft.sessionDurationDays)} type="submit" variant="primary">{saving ? t('security.saving') : t('security.authSave')}</Button></div>
        </form>}
        {!editing && <div className="security-auth-actions"><Button disabled={saving} onClick={() => { setDraft(state.pending); setEditing(true); }} size="small">{t('security.edit')}</Button></div>}
        {hasPending ? <div aria-label={t('security.authPendingPanelLabel')} className="security-pending-panel" role="region"><div><strong>{t('security.authPendingTitle')}</strong><span>{t('security.authPendingHint')}</span></div><div className="security-pending-actions"><Button disabled={saving} onClick={() => setConfirmDiscard(true)} size="small">{t('security.discard')}</Button><Button disabled={saving} onClick={() => setConfirmApply(true)} size="small" variant="primary">{t('security.authApply')}</Button></div></div> : <div className="security-applied-state"><ShieldCheck aria-hidden="true" size={15} />{t('security.authAllApplied')}</div>}
        {confirmApply && <div className="security-confirm-panel" role="alert"><strong>{t('security.authApplyConfirmTitle')}</strong><span>{t('security.authApplyConfirmBody')}</span><div><Button disabled={saving} onClick={() => setConfirmApply(false)} size="small">{t('common.cancel')}</Button><Button disabled={saving} onClick={() => void apply()} size="small" variant="primary">{saving ? t('security.applying') : t('security.confirmAndApply')}</Button></div></div>}
        {confirmDiscard && <div className="security-confirm-panel" role="alert"><strong>{t('security.authDiscardConfirmTitle')}</strong><span>{t('security.authDiscardConfirmBody')}</span><div><Button disabled={saving} onClick={() => setConfirmDiscard(false)} size="small">{t('common.cancel')}</Button><Button disabled={saving} onClick={() => void discard()} size="small" variant="danger">{saving ? t('security.discarding') : t('security.authDiscardPending')}</Button></div></div>}
      </Surface>
    </>}
  </div>;
}

function ApplicationUsersPanel({ collection }: { collection: Collection }) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const cursor = searchParams.get('usersCursor') ?? '';
  const cursorStack = parseCursorStack(searchParams.get('usersCursorStack'));
  const search = searchParams.get('userSearch') ?? '';
  const selectedUserId = searchParams.get('user') ?? '';
  const [users, setUsers] = useState<ApplicationUser[]>([]);
  const [nextCursor, setNextCursor] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [profile, setProfile] = useState<Record<string, unknown>>();
  const [profileState, setProfileState] = useState<'loading' | 'ready' | 'error'>('ready');
  const [profileError, setProfileError] = useState<unknown>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<TranslationKey | ''>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<TranslationKey | ''>('');

  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    void listApplicationUsers(collection.id, { cursor: cursor || undefined, limit: 50 }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setUsers(result.data);
      setNextCursor(result.nextCursor ?? '');
      setLoadState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setLoadState('error');
    });
    return () => controller.abort();
  }, [collection.id, cursor, reloadKey]);

  useEffect(() => {
    if (!selectedUserId) { setProfile(undefined); setProfileState('ready'); return; }
    const controller = new AbortController();
    setProfileState('loading');
    void getRecord(collection.id, selectedUserId, controller.signal).then((record) => {
      if (controller.signal.aborted) return;
      setProfile(record);
      setProfileState('ready');
      setProfileError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setProfileError(reason);
      setProfileState('error');
    });
    return () => controller.abort();
  }, [collection.id, selectedUserId]);

  function updateQuery(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
    if (Object.hasOwn(patch, 'userSearch')) {
      next.delete('usersCursor');
      next.delete('usersCursorStack');
    }
    setSearchParams(next, { replace: true });
  }

  function selectUser(userId: string) {
    updateQuery({ user: userId });
    setMessage('');
  }

  function nextUsersPage() {
    if (!nextCursor) return;
    const next = new URLSearchParams(searchParams);
    next.set('usersCursorStack', JSON.stringify([...cursorStack, cursor]));
    next.set('usersCursor', nextCursor);
    next.delete('user');
    setSearchParams(next);
  }

  function previousUsersPage() {
    if (!cursorStack.length) return;
    const next = new URLSearchParams(searchParams);
    const prior = cursorStack.at(-1) ?? '';
    const remaining = cursorStack.slice(0, -1);
    next.set('usersCursorStack', JSON.stringify(remaining));
    if (prior) next.set('usersCursor', prior);
    else next.delete('usersCursor');
    next.delete('user');
    setSearchParams(next);
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (!selectedUserId) return;
    if (!password) { setPasswordError('security.passwordEmpty'); return; }
    if (password !== confirmPassword) { setPasswordError('security.passwordMismatch'); return; }
    setBusy(true);
    setPasswordError('');
    setMessage('');
    try {
      await setApplicationUserPassword(collection.id, selectedUserId, password);
      setPassword('');
      setConfirmPassword('');
      setMessage('security.passwordChanged');
    } catch (reason) { setPasswordError(errorCopy(reason, t('security.passwordFailed'), t).title as TranslationKey); }
    finally { setBusy(false); }
  }

  const filtered = users.filter((user) => `${user.email} ${user.recordId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedEmail = users.find((user) => user.recordId === selectedUserId)?.email ?? (typeof profile?.email === 'string' ? profile.email : t('security.profileFallback'));

  return <div aria-labelledby="security-tab-users" className="page-stack security-panel" id="security-panel-users" role="tabpanel">
    <Surface className="security-users-toolbar" variant="standard"><div><h2>{t('security.usersTitle')}</h2><p>{t('security.usersDescription')}</p></div><Link className="button button--primary button--small" to={`/collections/${encodeURIComponent(collection.id)}?new=1`}><UserRound aria-hidden="true" size={14} />{t('security.createUser')}</Link></Surface>
    <label className="collection-search security-users-search"><Search aria-hidden="true" size={15} /><span className="sr-only">{t('security.searchUsers')}</span><input aria-label={t('security.searchUsers')} onChange={(event) => updateQuery({ userSearch: event.target.value || undefined })} placeholder={t('security.searchUsersPlaceholder')} type="search" value={search} /></label>
    {loadState === 'loading' && <LoadingState label={t('security.usersLoading')} />}
    {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.usersLoadFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
    {loadState === 'ready' && filtered.length === 0 && <EmptyState description={users.length ? t('security.usersNoMatchDescription') : t('security.usersEmptyDescription')} title={users.length ? t('security.usersNoMatchTitle') : t('security.usersEmptyTitle')}>{!users.length && <Link className="button button--primary" to={`/collections/${encodeURIComponent(collection.id)}?new=1`}>{t('security.createUser')}</Link>}</EmptyState>}
    {loadState === 'ready' && filtered.length > 0 && <Surface className="security-users-list" variant="standard"><div className="security-users-list-heading"><span>{t('security.usersPageSummary', { count: filtered.length })}</span><span>{t('security.usersSearchHint')}</span></div><div role="list">{filtered.map((user) => <article className="security-user-row" key={user.recordId} role="listitem"><div className="security-user-avatar"><UserRound aria-hidden="true" size={15} /></div><div><strong>{user.email}</strong><span>{user.recordId}</span></div><Button onClick={() => selectUser(user.recordId)} size="small">{selectedUserId === user.recordId ? t('security.selected') : t('security.viewUser')}</Button><Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'sessions'); next.set('user', user.recordId); setSearchParams(next); }} size="small" variant="quiet">{t('security.sessions')}</Button></article>)}</div><div className="records-pagination"><span>{t('security.page', { page: cursorStack.length + 1 })}</span><div><Button disabled={!cursorStack.length} onClick={previousUsersPage} size="small">{t('security.previous')}</Button><Button disabled={!nextCursor} onClick={nextUsersPage} size="small">{t('security.next')}</Button></div></div></Surface>}
    {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{t(message)}</div>}
    {selectedUserId && <Surface className="security-user-detail" variant="standard">
      <div className="security-rules-heading"><div><h2>{selectedEmail}</h2><p>{selectedUserId}</p></div><Button onClick={() => updateQuery({ user: undefined })} size="small" variant="quiet">{t('security.close')}</Button></div>
      {profileState === 'loading' && <LoadingState label={t('security.profileLoading')} />}
      {profileState === 'error' && (() => { const copy = errorCopy(profileError, t('security.profileLoadFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => selectUser(selectedUserId)} size="small">{t('common.retry')}</Button></ErrorState>; })()}
      {profileState === 'ready' && profile && <dl className="security-profile-values">{Object.entries(profile).filter(([key]) => !['id', 'createdAt', 'updatedAt'].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatSecurityValue(value)}</dd></div>)}</dl>}
      <form className="security-password-form" onSubmit={(event) => void changePassword(event)}><div><KeyRound aria-hidden="true" size={15} /><strong>{t('security.changePassword')}</strong><span>{t('security.changePasswordHint')}</span></div><FormField htmlFor="app-user-new-password" label={t('security.newPassword')}><input autoComplete="new-password" disabled={busy} id="app-user-new-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></FormField><FormField htmlFor="app-user-confirm-password" label={t('security.confirmPassword')}><input autoComplete="new-password" disabled={busy} id="app-user-confirm-password" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></FormField>{passwordError && <span className="record-field-error" role="alert">{t(passwordError)}</span>}<div className="security-rule-editor-actions"><Button disabled={busy} type="submit" variant="primary">{busy ? t('security.changing') : t('security.changePassword')}</Button></div></form>
      <Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'sessions'); next.set('user', selectedUserId); setSearchParams(next); }} size="small" variant="quiet">{t('security.viewSessions')}</Button>
    </Surface>}
  </div>;
}

function ApplicationSessionsPanel({ collection }: { collection: Collection }) {
  const { t, formatDate } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedUserId = searchParams.get('user') ?? '';
  const search = searchParams.get('userSearch') ?? '';
  const usersCursor = searchParams.get('usersCursor') ?? '';
  const usersCursorStack = parseCursorStack(searchParams.get('usersCursorStack'));
  const [users, setUsers] = useState<ApplicationUser[]>([]);
  const [usersNextCursor, setUsersNextCursor] = useState('');
  const [usersLoadState, setUsersLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [usersError, setUsersError] = useState<unknown>();
  const [usersReloadKey, setUsersReloadKey] = useState(0);
  const [sessions, setSessions] = useState<ApplicationSession[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [confirm, setConfirm] = useState<'all' | string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<TranslationKey | ''>('');
  const [identity, setIdentity] = useState('');
  const filteredUsers = users.filter((user) => `${user.email} ${user.recordId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => {
    const controller = new AbortController();
    setUsersLoadState('loading');
    void listApplicationUsers(collection.id, { limit: 50, cursor: usersCursor || undefined }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setUsers(page.data);
      setUsersNextCursor(page.nextCursor ?? '');
      setUsersLoadState('ready');
      setUsersError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setUsersError(reason);
      setUsersLoadState('error');
    });
    return () => controller.abort();
  }, [collection.id, usersCursor, usersReloadKey]);

  useEffect(() => {
    if (!selectedUserId) { setLoadState('ready'); setSessions([]); setIdentity(''); return; }
    const controller = new AbortController();
    setLoadState('loading');
    void Promise.allSettled([getApplicationUserSessions(collection.id, selectedUserId, controller.signal), getRecord(collection.id, selectedUserId, controller.signal)]).then(([sessionResult, profileResult]) => {
      if (controller.signal.aborted) return;
      if (sessionResult.status === 'rejected') {
        setError(sessionResult.reason);
        setLoadState('error');
        return;
      }
      setSessions(sessionResult.value);
      const profile = profileResult.status === 'fulfilled' ? profileResult.value : undefined;
      setIdentity(typeof profile?.email === 'string' ? profile.email : users.find((user) => user.recordId === selectedUserId)?.email ?? selectedUserId);
      setLoadState('ready');
      setError(undefined);
    });
    return () => controller.abort();
  }, [collection.id, selectedUserId, reloadKey]);

  useEffect(() => {
    const user = users.find((item) => item.recordId === selectedUserId);
    if (user) setIdentity(user.email);
  }, [selectedUserId, users]);

  function updateQuery(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
    if (Object.hasOwn(patch, 'userSearch')) {
      next.delete('usersCursor');
      next.delete('usersCursorStack');
    }
    setSearchParams(next, { replace: true });
  }

  function nextUsersPage() {
    if (!usersNextCursor) return;
    const next = new URLSearchParams(searchParams);
    next.set('usersCursorStack', JSON.stringify([...usersCursorStack, usersCursor]));
    next.set('usersCursor', usersNextCursor);
    setSearchParams(next);
  }

  function previousUsersPage() {
    if (!usersCursorStack.length) return;
    const next = new URLSearchParams(searchParams);
    const prior = usersCursorStack.at(-1) ?? '';
    const remaining = usersCursorStack.slice(0, -1);
    if (remaining.length) next.set('usersCursorStack', JSON.stringify(remaining));
    else next.delete('usersCursorStack');
    if (prior) next.set('usersCursor', prior);
    else next.delete('usersCursor');
    setSearchParams(next);
  }

  async function revoke(sessionId?: string) {
    if (!selectedUserId) return;
    setBusy(true);
    setError(undefined);
    setMessage('');
    try {
      if (sessionId) await revokeApplicationUserSession(collection.id, sessionId);
      else await revokeAllApplicationUserSessions(collection.id, selectedUserId);
      setConfirm(undefined);
      setMessage(sessionId ? 'security.sessionRevoked' : 'security.sessionRevokedAll');
      setReloadKey((value) => value + 1);
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }

  return <div aria-labelledby="security-tab-sessions" className="page-stack security-panel" id="security-panel-sessions" role="tabpanel">
    {!selectedUserId ? <>
      <Surface className="security-users-toolbar" variant="standard"><div><h2>{t('security.sessions')}</h2><p>{t('security.sessionsDescription')}</p></div><button className="button button--quiet button--small" onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'users'); setSearchParams(next); }} type="button">{t('security.manageUsers')}</button></Surface>
      <label className="collection-search security-users-search"><Search aria-hidden="true" size={15} /><span className="sr-only">{t('security.searchUser')}</span><input aria-label={t('security.searchUser')} onChange={(event) => updateQuery({ userSearch: event.target.value || undefined })} placeholder={t('security.searchUserPlaceholder')} type="search" value={search} /></label>
      {usersLoadState === 'loading' && <LoadingState label={t('security.usersLoading')} />}
      {usersLoadState === 'error' && (() => { const copy = errorCopy(usersError, t('security.usersLoadFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setUsersReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
      {usersLoadState === 'ready' && <Surface className="security-users-list" variant="standard">
        {filteredUsers.length === 0 ? <EmptyState description={users.length ? t('security.sessionsNoUsersMatchDescription') : t('security.sessionsNoUsersDescription')} title={users.length ? t('security.sessionsNoUsersMatchTitle') : t('security.sessionsNoUsersTitle')} /> : <>
          <div className="security-users-list-heading"><span>{t('security.usersPageSummary', { count: filteredUsers.length })}</span><span>{t('security.sessionsSearchHint')}</span></div>
          <div role="list">{filteredUsers.map((user) => <article className="security-user-row" key={user.recordId} role="listitem"><div className="security-user-avatar"><UserRound aria-hidden="true" size={15} /></div><div><strong>{user.email}</strong><span>{user.recordId}</span></div><Button onClick={() => updateQuery({ user: user.recordId })} size="small">{t('security.viewSessions')}</Button></article>)}</div>
        </>}
        {(filteredUsers.length > 0 || usersCursorStack.length > 0 || usersNextCursor) && <div className="records-pagination"><span>{t('security.page', { page: usersCursorStack.length + 1 })}</span><div><Button disabled={!usersCursorStack.length} onClick={previousUsersPage} size="small">{t('security.previous')}</Button><Button disabled={!usersNextCursor} onClick={nextUsersPage} size="small">{t('security.next')}</Button></div></div>}
      </Surface>}
    </> : <>
      <Surface className="security-session-toolbar" variant="standard"><div><h2>{t('security.sessions')}</h2><p>{identity || selectedUserId}</p></div><div><Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'users'); setSearchParams(next); }} size="small" variant="quiet">{t('security.changeUser')}</Button><Button disabled={busy} onClick={() => setConfirm('all')} size="small" variant="danger">{t('security.sessionRevokeAll')}</Button></div></Surface>
      {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{t(message)}</div>}
      {loadState === 'loading' && <LoadingState label={t('security.sessionsLoading')} />}
      {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.sessionsLoadFailed'), t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
      {loadState === 'ready' && sessions.length === 0 && <EmptyState description={t('security.sessionsEmptyDescription')} title={t('security.sessionsEmptyTitle')} />}
      {loadState === 'ready' && sessions.length > 0 && <Surface className="security-session-list" variant="standard"><div className="security-session-list-heading"><span>{t('security.sessionsActive', { count: sessions.filter((session) => session.status === 'active').length })}</span><span>{t('security.sessionsTotal', { count: sessions.length })}</span></div><div role="list">{sessions.map((session) => <article className="security-session-row" key={session.id} role="listitem"><div className={`security-session-status security-session-status--${session.status}`}><span aria-hidden="true" />{session.status}</div><dl><div><dt>{t('security.sessionCreated')}</dt><dd>{displaySecurityDate(session.createdAt, formatDate)}</dd></div><div><dt>{t('security.sessionLastUsed')}</dt><dd>{displaySecurityDate(session.lastUsedAt, formatDate)}</dd></div><div><dt>{t('security.sessionExpires')}</dt><dd>{displaySecurityDate(session.expiresAt, formatDate)}</dd></div></dl>{session.status === 'active' && <Button disabled={busy} onClick={() => setConfirm(session.id)} size="small" variant="danger">{t('security.sessionRevoke')}</Button>}</article>)}</div></Surface>}
      {confirm && <div className="security-confirm-panel" role="alert"><strong>{confirm === 'all' ? t('security.sessionConfirmAllTitle') : t('security.sessionConfirmOneTitle')}</strong><span>{t('security.sessionConfirmBody')}</span><div><Button disabled={busy} onClick={() => setConfirm(undefined)} size="small">{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void revoke(confirm === 'all' ? undefined : confirm)} size="small" variant="danger">{busy ? t('security.sessionRevoking') : t('security.sessionConfirm')}</Button></div></div>}
    </>}
  </div>;
}

function parseCursorStack(raw: string | null) {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value as string[] : [];
  } catch { return []; }
}

function formatSecurityValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function displaySecurityDate(value: string | undefined, formatDate: ReturnType<typeof useI18n>['formatDate']) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : formatDate(date);
}
