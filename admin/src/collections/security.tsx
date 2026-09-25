import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, KeyRound, RefreshCw, Search, Shield, ShieldCheck, UserRound } from 'lucide-react';
import { ApiClientError } from '../api/client';
import { Button, EmptyState, ErrorState, FormField, LoadingState, Surface } from '../components/ui';
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
import { useCollectionWorkspace } from './workspace-context';

const OPERATIONS: AccessOperation[] = ['list', 'view', 'create', 'update', 'delete'];
const MODES: Array<{ value: AccessRuleMode; label: string; description: string }> = [
  { value: 'noAccess', label: 'No access', description: 'No Application request can perform this operation.' },
  { value: 'anyone', label: 'Anyone', description: 'Requests do not need an Application User session.' },
  { value: 'signedInUsers', label: 'Signed-in users', description: 'A valid Application User session is required.' },
  { value: 'recordOwner', label: 'Record owner', description: 'The related signed-in User must own the record.' },
  { value: 'custom', label: 'Custom rule', description: 'Every typed field condition must match.' },
];

type ConditionDraft = { fieldId: string; operator: 'eq' | 'neq' | 'in'; value: string };

function errorCopy(error: unknown, fallback: string) {
  if (!(error instanceof ApiClientError)) return { title: fallback, message: error instanceof Error ? error.message : 'Try again when the project is available.' };
  return {
    title: error.apiError.message,
    message: [error.apiError.code, error.apiError.hint, `Request ID: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
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

function operationLabel(operation: AccessOperation) {
  return operation.charAt(0).toUpperCase() + operation.slice(1);
}

function modeLabel(mode: AccessRuleMode) {
  return MODES.find((item) => item.value === mode)?.label ?? 'No access';
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

function predicateValueControl(field: FieldDefinition, operator: string, value: string, onChange: (value: string) => void) {
  if (operator === 'in' || field.type === 'json') {
    return <textarea aria-label="Condition value" onChange={(event) => onChange(event.target.value)} placeholder={operator === 'in' ? '["one", "two"]' : '{"status":"active"}'} rows={2} value={value} />;
  }
  if (field.type === 'boolean') return <select aria-label="Condition value" onChange={(event) => onChange(event.target.value)} value={value || 'true'}><option value="true">Yes</option><option value="false">No</option><option value="">Null</option></select>;
  if (field.type === 'number') return <input aria-label="Condition value" onChange={(event) => onChange(event.target.value)} type="number" value={value} />;
  if (field.type === 'dateTime') return <input aria-label="Condition value" onChange={(event) => onChange(event.target.value)} placeholder="2026-09-24T10:00:00Z" type="text" value={value} />;
  return <input aria-label="Condition value" onChange={(event) => onChange(event.target.value)} type="text" value={value} />;
}

export function CollectionSecurityPage() {
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
  const [message, setMessage] = useState('');
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
      setMessage('Access rule saved as a pending change.');
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
      setMessage('Access rules applied. The Runtime confirmed the durable state.');
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
      setMessage('Pending access rule changes were discarded.');
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
      <header className="page-heading collection-heading"><div><p className="eyebrow">{collection.name} · SECURITY</p><h1>Security</h1><p className="page-description">Manage Application access and authentication for this Collection.</p></div><span className="security-heading-icon"><Shield aria-hidden="true" size={19} /></span></header>
      <nav aria-label="Collection security" className="security-tabs" role="tablist">
        <button aria-controls="security-panel-rules" aria-selected={activePanel === 'rules'} id="security-tab-rules" onClick={() => selectPanel('rules')} role="tab" type="button">Access Rules</button>
        {authTabs && <>
          <button aria-controls="security-panel-authentication" aria-selected={activePanel === 'authentication'} id="security-tab-authentication" onClick={() => selectPanel('authentication')} role="tab" type="button">Authentication</button>
          <button aria-controls="security-panel-users" aria-selected={activePanel === 'users'} id="security-tab-users" onClick={() => selectPanel('users')} role="tab" type="button">App Users</button>
          <button aria-controls="security-panel-sessions" aria-selected={activePanel === 'sessions'} id="security-tab-sessions" onClick={() => selectPanel('sessions')} role="tab" type="button">Sessions</button>
        </>}
      </nav>
      {activePanel === 'rules' && <div aria-labelledby="security-tab-rules" className="page-stack security-panel" id="security-panel-rules" role="tabpanel">
      {loadState === 'loading' && <LoadingState label="Loading access rules" />}
      {loadState === 'error' && (() => { const copy = errorCopy(error, 'Access rules could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
      {loadState === 'ready' && state && <>
        {referenceError && <div className="security-dependency-error" role="status">Related Collections could not be loaded. Record owner rules are unavailable until references can be checked. <Button onClick={() => setReloadKey((value) => value + 1)} size="small">Retry</Button></div>}
        {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{message}</div>}
        {actionError && (() => { const copy = errorCopy(actionError, 'The access rule change could not be completed.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Reload rules</Button></ErrorState>; })()}
        <Surface className="security-rules-card" variant="standard">
          <div className="security-rules-heading"><div><h2>Applied access</h2><p>Application requests are evaluated against these rules.</p></div><span className="security-version">Version {state.version}</span></div>
          <div className="security-rule-list" role="list">{OPERATIONS.map((operation) => {
            const current = pending.find((rule) => rule.operation === operation)!;
            const previous = applied.find((rule) => rule.operation === operation)!;
            const isChanged = JSON.stringify(current) !== JSON.stringify(previous);
            const ownerField = collection.fields.find((field) => field.id === current.ownerFieldId);
            return <article className="security-rule-row" key={operation} role="listitem">
              <div className="security-rule-operation"><span>{operationLabel(operation)}</span>{isChanged && <span className="security-pending-mark">Pending</span>}</div>
              <div className="security-rule-summary"><strong>{modeLabel(current.mode)}</strong>{current.mode === 'recordOwner' && <span>{ownerField?.name ?? 'Relation field'}</span>}{current.mode === 'custom' && <span>{expressionConditions(current.expression).length} field conditions</span>}</div>
              <Button aria-label={`Edit ${operationLabel(operation)} access`} disabled={busy || editing === operation} onClick={() => { setActionError(undefined); setEditing(operation); }} size="small">Edit</Button>
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
          {changedCount > 0 ? <div aria-label="Pending access changes" className="security-pending-panel" role="region">
            <div><strong>{changedCount} pending {changedCount === 1 ? 'access rule change' : 'access rule changes'}</strong><span>Saved changes remain pending until you apply them.</span></div>
            <div className="security-pending-actions"><Button disabled={busy} onClick={() => setConfirmDiscard(true)} size="small">Discard</Button><Button disabled={busy} onClick={() => setConfirmApply(true)} variant="primary">Apply {changedCount} {changedCount === 1 ? 'change' : 'changes'}</Button></div>
          </div> : <div className="security-applied-state"><ShieldCheck aria-hidden="true" size={15} />All access rule changes are applied.</div>}
          {confirmApply && <div className="security-confirm-panel" role="alert"><strong>Apply these access rule changes?</strong><span>Application requests will use the new rules as soon as the Runtime applies them. No access simulation is available here.</span><div><Button disabled={busy} onClick={() => setConfirmApply(false)} size="small">Cancel</Button><Button disabled={busy} onClick={() => void apply()} size="small" variant="primary">{busy ? 'Applying…' : 'Confirm & apply'}</Button></div></div>}
          {confirmDiscard && <div className="security-confirm-panel" role="alert"><strong>Discard pending access rules?</strong><span>The applied rules will remain in effect.</span><div><Button disabled={busy} onClick={() => setConfirmDiscard(false)} size="small">Cancel</Button><Button disabled={busy} onClick={() => void discard()} size="small" variant="danger">{busy ? 'Discarding…' : 'Discard pending rules'}</Button></div></div>}
        </Surface>
        {customFields.length === 0 && <EmptyState description="Apply one or more non-system fields before creating custom field conditions." title="Custom rules need an Applied Field" />}
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
  const [mode, setMode] = useState<AccessRuleMode>(rule.mode);
  const [ownerFieldId, setOwnerFieldId] = useState(rule.ownerFieldId ?? '');
  const [conditions, setConditions] = useState<ConditionDraft[]>(() => expressionConditions(rule.expression).map((item) => ({ fieldId: item.fieldId, operator: item.operator, value: valueForControl(item.value, item.operator) })));
  const [validationError, setValidationError] = useState('');
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
      if (!ownerFields.some((field) => field.id === ownerFieldId)) { setValidationError('Choose an Applied Relation field that points to an Auth Collection.'); return; }
      next.ownerFieldId = ownerFieldId;
    }
    if (mode === 'custom') {
      if (!conditions.length || conditions.length > 16) { setValidationError('Add between 1 and 16 field conditions.'); return; }
      const predicates: AccessPredicate[] = [];
      for (const [index, condition] of conditions.entries()) {
        const field = conditionField(condition.fieldId);
        if (!field?.id) { setValidationError(`Choose an Applied Field for condition ${index + 1}.`); return; }
        const parsed = parseTypedValue(condition.value, field, condition.operator);
        if (!parsed.valid) { setValidationError(`Enter a value that matches ${field.name}${condition.operator === 'in' ? ' and use a JSON array with 1–32 values' : ''}.`); return; }
        predicates.push({ fieldId: field.id, operator: condition.operator, value: parsed.value });
      }
      next.expression = { version: 1, all: predicates };
    }
    onSave(next);
  }

  return <form className="security-rule-editor" onSubmit={submit}>
    <div className="security-rule-editor-heading"><div><p className="eyebrow">EDIT ACCESS</p><h3>{operationLabel(rule.operation)} access</h3></div><span>Changes are saved separately from Schema.</span></div>
    <fieldset className="security-mode-options"><legend>Who can {rule.operation === 'list' ? 'list' : rule.operation} records?</legend>
      {MODES.map((option) => <label className="security-mode-option" key={option.value}>
        <input checked={mode === option.value} disabled={option.value === 'recordOwner' && !canUseRecordOwner} name={`access-${rule.operation}`} onChange={() => setMode(option.value)} type="radio" value={option.value} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}
      {!canUseRecordOwner && <p className="security-form-hint">Record owner needs an Applied Relation field to an Auth Collection.</p>}
    </fieldset>
    {mode === 'recordOwner' && <FormField htmlFor="access-owner-field" label="Owner field" hint="Choose a Relation field that points to an Auth Collection.">
      <select id="access-owner-field" onChange={(event) => setOwnerFieldId(event.target.value)} value={ownerFieldId}><option value="">Choose a field</option>{ownerFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select>
    </FormField>}
    {mode === 'custom' && <section aria-label="Custom field conditions" className="security-custom-editor">
      <div className="security-custom-heading"><div><h4>All conditions must match</h4><p>Only Applied fields are available. Expressions use the supported typed rule format.</p></div><Button disabled={conditions.length >= 16 || customFields.length === 0} onClick={addCondition} size="small" type="button">Add condition</Button></div>
      {conditions.map((condition, index) => {
        const field = conditionField(condition.fieldId);
        return <div className="security-condition" key={`${index}-${condition.fieldId}`}>
          <label><span>Field</span><select aria-label={`Condition ${index + 1} field`} onChange={(event) => updateCondition(index, { fieldId: event.target.value, value: '' })} value={condition.fieldId}>{customFields.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
          <label><span>Operator</span><select aria-label={`Condition ${index + 1} operator`} onChange={(event) => updateCondition(index, { operator: event.target.value as ConditionDraft['operator'], value: '' })} value={condition.operator}><option value="eq">Equals</option><option value="neq">Does not equal</option><option value="in">Is one of</option></select></label>
          <label className="security-condition-value"><span>Value{condition.operator === 'in' ? ' · JSON array' : ''}</span>{field ? predicateValueControl(field, condition.operator, condition.value, (value) => updateCondition(index, { value })) : <input aria-label="Condition value" disabled value="" />}</label>
          <Button aria-label={`Remove condition ${index + 1}`} disabled={conditions.length === 1} onClick={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))} size="small" type="button" variant="quiet">Remove</Button>
        </div>;
      })}
    </section>}
    {validationError && <div className="record-field-error" role="alert">{validationError}</div>}
    <div className="security-rule-editor-actions"><Button disabled={busy} onClick={onCancel} type="button" variant="quiet">Cancel</Button><Button disabled={busy || (mode === 'custom' && customFields.length === 0)} type="submit" variant="primary">{busy ? 'Saving…' : 'Save pending rule'}</Button></div>
  </form>;
}

function emailVerificationLabel(mode: EmailVerificationMode | undefined): string {
  switch (mode) {
    case 'required': return 'Required';
    case 'optional': return 'Optional';
    default: return 'Off';
  }
}

function emailVerificationHint(mode: EmailVerificationMode | undefined): string {
  switch (mode) {
    case 'required': return 'Application users cannot sign in until they confirm their email address.';
    case 'optional': return 'Application users can confirm their email address but sign-in is not blocked.';
    default: return 'No email confirmation is requested and sign-in is never blocked.';
  }
}
function AuthenticationPanel({ collectionId }: { collectionId: string }) {
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
  const [message, setMessage] = useState('');

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
      setMessage('Authentication settings saved as a pending change.');
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
      setMessage('Authentication settings applied. The Runtime confirmed the durable state.');
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
      setMessage('Pending authentication settings were discarded.');
    } catch (reason) { setActionError(reason); }
    finally { setSaving(false); }
  }

  return <div aria-labelledby="security-tab-authentication" className="page-stack security-panel" id="security-panel-authentication" role="tabpanel">
    {loadState === 'loading' && <LoadingState label="Loading authentication settings" />}
    {loadState === 'error' && (() => { const copy = errorCopy(error, 'Authentication settings could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
    {loadState === 'ready' && state && draft && <>
      {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{message}</div>}
      {actionError && (() => { const copy = errorCopy(actionError, 'Authentication settings could not be changed.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Reload settings</Button></ErrorState>; })()}
      <Surface className="security-auth-card" variant="standard">
        <div className="security-rules-heading"><div><h2>Authentication</h2><p>Email is the Auth identifier. The password is stored securely and is never shown again.</p></div><span className="security-version">Version {state.version}</span></div>
        {!editing ? <dl className="security-auth-values">
          <div><dt>Email + password</dt><dd><strong>{state.pending.emailPasswordEnabled ? 'Enabled' : 'Disabled'}</strong><span>{state.pending.emailPasswordEnabled ? 'Application users can authenticate with their email and password.' : 'Email and password login is unavailable.'}</span></dd></div>
          <div><dt>Self registration</dt><dd><strong>{state.pending.selfRegistration ? 'Enabled' : 'Disabled'}</strong><span>{state.pending.selfRegistration ? 'Users can create their own accounts.' : 'Only an Administrator can create users.'}</span></dd></div>
          <div><dt>Session duration</dt><dd><strong>{state.pending.sessionDurationDays} days</strong><span>New Application sessions expire after this period.</span></dd></div>
          <div><dt>Email verification</dt><dd><strong>{emailVerificationLabel(state.pending.emailVerification)}</strong><span>{emailVerificationHint(state.pending.emailVerification)}</span></dd></div>
        </dl> : <form className="security-auth-editor" onSubmit={(event) => void save(event)}>
          <FormField htmlFor="auth-email-password" hint="Email remains the Auth identifier field." label="Email + password"><select id="auth-email-password" onChange={(event) => setDraft({ ...draft, emailPasswordEnabled: event.target.value === 'enabled' })} value={draft.emailPasswordEnabled ? 'enabled' : 'disabled'}><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></FormField>
          <FormField htmlFor="auth-self-registration" label="Self registration"><select id="auth-self-registration" onChange={(event) => setDraft({ ...draft, selfRegistration: event.target.value === 'enabled' })} value={draft.selfRegistration ? 'enabled' : 'disabled'}><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select></FormField>
          <FormField htmlFor="auth-session-days" hint="At least 1 day." label="Session duration (days)"><input id="auth-session-days" min="1" onChange={(event) => setDraft({ ...draft, sessionDurationDays: Number(event.target.value) })} type="number" value={draft.sessionDurationDays} /></FormField>
          <FormField htmlFor="auth-email-verification" hint="Applies to Application sign-in. Required blocks sign-in until the address is confirmed." label="Email verification"><select id="auth-email-verification" onChange={(event) => setDraft({ ...draft, emailVerification: event.target.value as EmailVerificationMode })} value={draft.emailVerification ?? 'off'}><option value="off">Off</option><option value="optional">Optional</option><option value="required">Required</option></select></FormField>
          <div className="security-rule-editor-actions"><Button disabled={saving} onClick={() => { setDraft(state.pending); setEditing(false); }} type="button" variant="quiet">Cancel</Button><Button disabled={saving || draft.sessionDurationDays < 1 || !Number.isInteger(draft.sessionDurationDays)} type="submit" variant="primary">{saving ? 'Saving…' : 'Save pending settings'}</Button></div>
        </form>}
        {!editing && <div className="security-auth-actions"><Button disabled={saving} onClick={() => { setDraft(state.pending); setEditing(true); }} size="small">Edit</Button></div>}
        {hasPending ? <div aria-label="Pending authentication settings" className="security-pending-panel" role="region"><div><strong>Pending authentication settings</strong><span>These settings are durable but not active until applied.</span></div><div className="security-pending-actions"><Button disabled={saving} onClick={() => setConfirmDiscard(true)} size="small">Discard</Button><Button disabled={saving} onClick={() => setConfirmApply(true)} size="small" variant="primary">Apply settings</Button></div></div> : <div className="security-applied-state"><ShieldCheck aria-hidden="true" size={15} />Authentication settings are applied.</div>}
        {confirmApply && <div className="security-confirm-panel" role="alert"><strong>Apply these authentication settings?</strong><span>New Application sign-ins will use these settings after the Runtime applies them.</span><div><Button disabled={saving} onClick={() => setConfirmApply(false)} size="small">Cancel</Button><Button disabled={saving} onClick={() => void apply()} size="small" variant="primary">{saving ? 'Applying…' : 'Confirm & apply'}</Button></div></div>}
        {confirmDiscard && <div className="security-confirm-panel" role="alert"><strong>Discard pending authentication settings?</strong><span>The applied settings will remain in effect.</span><div><Button disabled={saving} onClick={() => setConfirmDiscard(false)} size="small">Cancel</Button><Button disabled={saving} onClick={() => void discard()} size="small" variant="danger">{saving ? 'Discarding…' : 'Discard pending settings'}</Button></div></div>}
      </Surface>
    </>}
  </div>;
}

function ApplicationUsersPanel({ collection }: { collection: Collection }) {
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
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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
    if (!password) { setPasswordError('Enter a new password.'); return; }
    if (password !== confirmPassword) { setPasswordError('Passwords do not match.'); return; }
    setBusy(true);
    setPasswordError('');
    setMessage('');
    try {
      await setApplicationUserPassword(collection.id, selectedUserId, password);
      setPassword('');
      setConfirmPassword('');
      setMessage('Password changed. All existing sessions for this user were revoked.');
    } catch (reason) { setPasswordError(errorCopy(reason, 'The password could not be changed.').title); }
    finally { setBusy(false); }
  }

  const filtered = users.filter((user) => `${user.email} ${user.recordId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedEmail = users.find((user) => user.recordId === selectedUserId)?.email ?? (typeof profile?.email === 'string' ? profile.email : 'App User');

  return <div aria-labelledby="security-tab-users" className="page-stack security-panel" id="security-panel-users" role="tabpanel">
    <Surface className="security-users-toolbar" variant="standard"><div><h2>App Users</h2><p>Profiles and passwords are managed through the Auth Collection workflow.</p></div><Link className="button button--primary button--small" to={`/collections/${encodeURIComponent(collection.id)}?new=1`}><UserRound aria-hidden="true" size={14} />Create user</Link></Surface>
    <label className="collection-search security-users-search"><Search aria-hidden="true" size={15} /><span className="sr-only">Search users</span><input aria-label="Search users" onChange={(event) => updateQuery({ userSearch: event.target.value || undefined })} placeholder="Search users…" type="search" value={search} /></label>
    {loadState === 'loading' && <LoadingState label="Loading App Users" />}
    {loadState === 'error' && (() => { const copy = errorCopy(error, 'App Users could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
    {loadState === 'ready' && filtered.length === 0 && <EmptyState description={users.length ? 'Try another email or User ID.' : 'Create the first App User to allow Application sign-in.'} title={users.length ? 'No users match this search' : 'No App Users yet'}>{!users.length && <Link className="button button--primary" to={`/collections/${encodeURIComponent(collection.id)}?new=1`}>Create user</Link>}</EmptyState>}
    {loadState === 'ready' && filtered.length > 0 && <Surface className="security-users-list" variant="standard"><div className="security-users-list-heading"><span>{filtered.length} users on this page</span><span>Search covers this page</span></div><div role="list">{filtered.map((user) => <article className="security-user-row" key={user.recordId} role="listitem"><div className="security-user-avatar"><UserRound aria-hidden="true" size={15} /></div><div><strong>{user.email}</strong><span>{user.recordId}</span></div><Button onClick={() => selectUser(user.recordId)} size="small">{selectedUserId === user.recordId ? 'Selected' : 'View user'}</Button><Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'sessions'); next.set('user', user.recordId); setSearchParams(next); }} size="small" variant="quiet">Sessions</Button></article>)}</div><div className="records-pagination"><span>Page {cursorStack.length + 1}</span><div><Button disabled={!cursorStack.length} onClick={previousUsersPage} size="small">Previous</Button><Button disabled={!nextCursor} onClick={nextUsersPage} size="small">Next</Button></div></div></Surface>}
    {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{message}</div>}
    {selectedUserId && <Surface className="security-user-detail" variant="standard">
      <div className="security-rules-heading"><div><h2>{selectedEmail}</h2><p>{selectedUserId}</p></div><Button onClick={() => updateQuery({ user: undefined })} size="small" variant="quiet">Close</Button></div>
      {profileState === 'loading' && <LoadingState label="Loading user profile" />}
      {profileState === 'error' && (() => { const copy = errorCopy(profileError, 'The user profile could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => selectUser(selectedUserId)} size="small">Retry</Button></ErrorState>; })()}
      {profileState === 'ready' && profile && <dl className="security-profile-values">{Object.entries(profile).filter(([key]) => !['id', 'createdAt', 'updatedAt'].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatSecurityValue(value)}</dd></div>)}</dl>}
      <form className="security-password-form" onSubmit={(event) => void changePassword(event)}><div><KeyRound aria-hidden="true" size={15} /><strong>Change password</strong><span>Password values are write-only. Changing a password revokes the user’s existing sessions.</span></div><FormField htmlFor="app-user-new-password" label="New password"><input autoComplete="new-password" disabled={busy} id="app-user-new-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></FormField><FormField htmlFor="app-user-confirm-password" label="Confirm password"><input autoComplete="new-password" disabled={busy} id="app-user-confirm-password" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></FormField>{passwordError && <span className="record-field-error" role="alert">{passwordError}</span>}<div className="security-rule-editor-actions"><Button disabled={busy} type="submit" variant="primary">{busy ? 'Changing…' : 'Change password'}</Button></div></form>
      <Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'sessions'); next.set('user', selectedUserId); setSearchParams(next); }} size="small" variant="quiet">View sessions</Button>
    </Surface>}
  </div>;
}

function ApplicationSessionsPanel({ collection }: { collection: Collection }) {
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
  const [message, setMessage] = useState('');
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
      setMessage(sessionId ? 'Session revoked.' : 'All sessions for this user were revoked.');
      setReloadKey((value) => value + 1);
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }

  return <div aria-labelledby="security-tab-sessions" className="page-stack security-panel" id="security-panel-sessions" role="tabpanel">
    {!selectedUserId ? <>
      <Surface className="security-users-toolbar" variant="standard"><div><h2>Sessions</h2><p>Choose an App User to review and revoke their sessions.</p></div><button className="button button--quiet button--small" onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'users'); setSearchParams(next); }} type="button">Manage users</button></Surface>
      <label className="collection-search security-users-search"><Search aria-hidden="true" size={15} /><span className="sr-only">Search user</span><input aria-label="Search user" onChange={(event) => updateQuery({ userSearch: event.target.value || undefined })} placeholder="Search user email…" type="search" value={search} /></label>
      {usersLoadState === 'loading' && <LoadingState label="Loading App Users" />}
      {usersLoadState === 'error' && (() => { const copy = errorCopy(usersError, 'App Users could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setUsersReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
      {usersLoadState === 'ready' && <Surface className="security-users-list" variant="standard">
        {filteredUsers.length === 0 ? <EmptyState description={users.length ? 'Try another email or User ID on this page.' : 'Create an App User to manage its sessions.'} title={users.length ? 'No users match this search' : 'No App Users yet'} /> : <>
          <div className="security-users-list-heading"><span>{filteredUsers.length} users on this page</span><span>Search covers users on this page</span></div>
          <div role="list">{filteredUsers.map((user) => <article className="security-user-row" key={user.recordId} role="listitem"><div className="security-user-avatar"><UserRound aria-hidden="true" size={15} /></div><div><strong>{user.email}</strong><span>{user.recordId}</span></div><Button onClick={() => updateQuery({ user: user.recordId })} size="small">View sessions</Button></article>)}</div>
        </>}
        {(filteredUsers.length > 0 || usersCursorStack.length > 0 || usersNextCursor) && <div className="records-pagination"><span>Page {usersCursorStack.length + 1}</span><div><Button disabled={!usersCursorStack.length} onClick={previousUsersPage} size="small">Previous</Button><Button disabled={!usersNextCursor} onClick={nextUsersPage} size="small">Next</Button></div></div>}
      </Surface>}
    </> : <>
      <Surface className="security-session-toolbar" variant="standard"><div><h2>Sessions</h2><p>{identity || selectedUserId}</p></div><div><Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'users'); setSearchParams(next); }} size="small" variant="quiet">Change user</Button><Button disabled={busy} onClick={() => setConfirm('all')} size="small" variant="danger">Revoke all</Button></div></Surface>
      {message && <div className="records-success" role="status"><Check aria-hidden="true" size={14} />{message}</div>}
      {loadState === 'loading' && <LoadingState label="Loading sessions" />}
      {loadState === 'error' && (() => { const copy = errorCopy(error, 'Sessions could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
      {loadState === 'ready' && sessions.length === 0 && <EmptyState description="This user has no Application sessions." title="No sessions" />}
      {loadState === 'ready' && sessions.length > 0 && <Surface className="security-session-list" variant="standard"><div className="security-session-list-heading"><span>{sessions.filter((session) => session.status === 'active').length} active</span><span>{sessions.length} total</span></div><div role="list">{sessions.map((session) => <article className="security-session-row" key={session.id} role="listitem"><div className={`security-session-status security-session-status--${session.status}`}><span aria-hidden="true" />{session.status}</div><dl><div><dt>Created</dt><dd>{displaySecurityDate(session.createdAt)}</dd></div><div><dt>Last used</dt><dd>{displaySecurityDate(session.lastUsedAt)}</dd></div><div><dt>Expires</dt><dd>{displaySecurityDate(session.expiresAt)}</dd></div></dl>{session.status === 'active' && <Button disabled={busy} onClick={() => setConfirm(session.id)} size="small" variant="danger">Revoke</Button>}</article>)}</div></Surface>}
      {confirm && <div className="security-confirm-panel" role="alert"><strong>{confirm === 'all' ? 'Revoke all sessions for this user?' : 'Revoke this session?'}</strong><span>The selected session will no longer be accepted by the Application.</span><div><Button disabled={busy} onClick={() => setConfirm(undefined)} size="small">Cancel</Button><Button disabled={busy} onClick={() => void revoke(confirm === 'all' ? undefined : confirm)} size="small" variant="danger">{busy ? 'Revoking…' : 'Confirm revoke'}</Button></div></div>}
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

function displaySecurityDate(value: string | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
