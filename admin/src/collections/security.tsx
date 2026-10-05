import { TabContent } from '../components/tab-content';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { Button as ControlButton } from '@/components/ui/button';
import { Textarea, Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, KeyRound, RefreshCw, Shield, ShieldCheck, UserRound } from 'lucide-react';
import { ApiClientError } from '../api/client';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '../components/button';
import { FormField } from '../components/form-field';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
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

function errorCopy(error: unknown, fallback: string, t: Translate, errorMessage: ReturnType<typeof useI18n>['errorMessage']) {
  if (!(error instanceof ApiClientError)) return { title: fallback, message: t('common.tryAgainWhenAvailable') };
  return {
    title: errorMessage(error.apiError.code) ?? t('errors.requestFailed'),
    message: [t('common.errorCode'), error.apiError.code, `${t('common.requestId')}: ${error.apiError.requestId}`, t('common.tryAgainWhenAvailable')].join(' · '),
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
    return <Textarea aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} placeholder={operator === 'in' ? '["one", "two"]' : '{"status":"active"}'} rows={2} value={value} />;
  }
  if (field.type === 'boolean') return <SelectField aria-label={t('security.conditionValue')} onValueChange={(selectedValue) => onChange(selectedValue)} value={value || 'true'} options={[({ value: "true", label: t('common.yes') }), ({ value: "false", label: t('common.no') }), ({ value: "", label: t('security.nullOption') })]} />;
  if (field.type === 'number') return <Input aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} type="number" value={value} />;
  if (field.type === 'dateTime') return <Input aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} placeholder="2026-09-24T10:00:00Z" type="text" value={value} />;
  return <Input aria-label={t('security.conditionValue')} onChange={(event) => onChange(event.target.value)} type="text" value={value} />;
}

export function CollectionSecurityPage() {
  const { t, errorMessage } = useI18n();
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
    <div className="flex min-w-0 flex-col gap-4">
      <h2 className="sr-only">{t('security.title')}</h2>
      <nav aria-label={t('security.sectionsLabel')} className="flex flex-wrap items-center gap-1 overflow-x-auto overflow-y-hidden border-b" role="tablist">
        <ControlButton variant="unstyled"
          aria-controls="security-panel-rules"
          aria-selected={activePanel === 'rules'}
          className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors  ${activePanel === 'rules' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          id="security-tab-rules"
          onClick={() => selectPanel('rules')}
          role="tab"
          type="button"
        >{t('security.tabs.rules')}</ControlButton>
        {authTabs && <>
          <ControlButton variant="unstyled"
            aria-controls="security-panel-authentication"
            aria-selected={activePanel === 'authentication'}
            className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors  ${activePanel === 'authentication' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            id="security-tab-authentication"
            onClick={() => selectPanel('authentication')}
            role="tab"
            type="button"
          >{t('security.tabs.authentication')}</ControlButton>
          <ControlButton variant="unstyled"
            aria-controls="security-panel-users"
            aria-selected={activePanel === 'users'}
            className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors  ${activePanel === 'users' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            id="security-tab-users"
            onClick={() => selectPanel('users')}
            role="tab"
            type="button"
          >{t('security.tabs.users')}</ControlButton>
          <ControlButton variant="unstyled"
            aria-controls="security-panel-sessions"
            aria-selected={activePanel === 'sessions'}
            className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors  ${activePanel === 'sessions' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            id="security-tab-sessions"
            onClick={() => selectPanel('sessions')}
            role="tab"
            type="button"
          >{t('security.tabs.sessions')}</ControlButton>
        </>}
      </nav>
    <TabContent activeKey={activePanel}>
      {activePanel === 'rules' && <div aria-labelledby="security-tab-rules" className="flex min-w-0 flex-col gap-4" id="security-panel-rules" role="tabpanel">
      {loadState === 'ready' && <AccessRuleSimulation collectionId={collection.id} />}
      {loadState === 'loading' && <LoadingState label={t('security.loadingRules')} />}
      {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.loadFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
      {loadState === 'ready' && state && <>
        {referenceError && <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-xs text-warning" role="status">{t('security.referencesUnavailable')} <Button onClick={() => setReloadKey((value) => value + 1)} size="small">{t('common.retry')}</Button></div>}
        {message && <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status"><Check aria-hidden="true" className="shrink-0 text-success" size={15} />{t(message)}</div>}
        {actionError && (() => { const copy = errorCopy(actionError, t('security.changeFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('security.reloadRules')}</Button></ErrorState>; })()}
        <Surface className="flex min-w-0 flex-col gap-4" variant="section">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{t('security.appliedTitle')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('security.appliedDescription')}</p>
            </div>
            <Badge variant="outline">{t('security.version', { version: state.version })}</Badge>
          </div>
          <div className="flex min-w-0 flex-col" role="list">{OPERATIONS.map((operation) => {
            const current = pending.find((rule) => rule.operation === operation)!;
            const previous = applied.find((rule) => rule.operation === operation)!;
            const isChanged = JSON.stringify(current) !== JSON.stringify(previous);
            const ownerField = collection.fields.find((field) => field.id === current.ownerFieldId);
            return <article className="flex flex-wrap items-center gap-3 border-b px-1 py-2.5 last:border-b-0" key={operation} role="listitem">
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><Shield size={16} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm font-semibold text-foreground">{t(`security.operations.${operation}`)}</strong>
                  {isChanged && <Badge variant="warning">{t('security.pendingMark')}</Badge>}
                </div>
                <div className="mt-0.5 grid gap-0.5">
                  <strong className="text-sm font-medium text-ink-secondary">{t(`accessModes.${current.mode}.label`)}</strong>
                  {current.mode === 'recordOwner' && <span className="text-xs text-muted-foreground">{ownerField?.name ?? t('security.relationField')}</span>}
                  {current.mode === 'custom' && <span className="text-xs text-muted-foreground">{t('security.conditionCount', { count: expressionConditions(current.expression).length })}</span>}
                </div>
              </div>
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
          {changedCount > 0 ? <div aria-label={t('security.pendingPanelLabel')} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3" role="region">
            <div className="grid gap-0.5">
              <strong className="text-xs font-semibold text-warning">{t(changedCount === 1 ? 'security.pendingOne' : 'security.pendingMany', { count: changedCount })}</strong>
              <span className="text-xs text-ink-secondary">{t('security.pendingHint')}</span>
            </div>
            <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setConfirmDiscard(true)} size="small">{t('security.discard')}</Button><Button disabled={busy} onClick={() => setConfirmApply(true)} variant="primary">{t(changedCount === 1 ? 'security.applyOne' : 'security.applyMany', { count: changedCount })}</Button></div>
          </div> : <div className="flex items-center gap-2 text-xs text-success"><ShieldCheck aria-hidden="true" size={15} />{t('security.allApplied')}</div>}
          {confirmApply && <div className="grid gap-2 rounded-lg border border-input bg-secondary p-3.5" role="alert">
            <strong className="text-sm font-semibold text-foreground">{t('security.confirmApplyTitle')}</strong>
            <span className="text-xs leading-relaxed text-muted-foreground">{t('security.confirmApplyBody')}</span>
            <div className="flex justify-end gap-1.5 pt-0.5"><Button disabled={busy} onClick={() => setConfirmApply(false)} size="small">{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void apply()} size="small" variant="primary">{busy ? t('security.applying') : t('security.confirmAndApply')}</Button></div>
          </div>}
          {confirmDiscard && <div className="grid gap-2 rounded-lg border border-input bg-secondary p-3.5" role="alert">
            <strong className="text-sm font-semibold text-foreground">{t('security.discardConfirmTitle')}</strong>
            <span className="text-xs leading-relaxed text-muted-foreground">{t('security.discardConfirmBody')}</span>
            <div className="flex justify-end gap-1.5 pt-0.5"><Button disabled={busy} onClick={() => setConfirmDiscard(false)} size="small">{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void discard()} size="small" variant="danger">{busy ? t('security.discarding') : t('security.discardPending')}</Button></div>
          </div>}
        </Surface>
        {customFields.length === 0 && <EmptyState description={t('security.customNeedsFieldDescription')} title={t('security.customNeedsFieldTitle')} />}
      </>}
      </div>}
      {activePanel === 'authentication' && <AuthenticationPanel collectionId={collection.id} />}
      {activePanel === 'users' && <ApplicationUsersPanel collection={collection} />}
      {activePanel === 'sessions' && <ApplicationSessionsPanel collection={collection} />}
    </TabContent>
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

  return <form className="flex min-w-0 flex-col gap-4 rounded-lg border bg-secondary p-4" onSubmit={submit}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
      <div className="min-w-0">
        <p className="eyebrow">{t('security.editorEyebrow')}</p>
        <h3>{t('security.editAccess', { operation: t(`security.operations.${rule.operation}`) })}</h3>
      </div>
      <span className="text-xs text-muted-foreground">{t('security.editorDescription')}</span>
    </div>
    <fieldset className="m-0 grid gap-2 border-0 p-0"><legend className="mb-1.5 text-xs font-semibold text-ink-secondary">{t('security.whoCan', { operation: t(`security.operationVerbs.${rule.operation}`) })}</legend>
      <RadioGroup aria-label={t('security.whoCan', { operation: t(`security.operationVerbs.${rule.operation}`) })} className="grid gap-2" name={`access-${rule.operation}`} value={mode} onValueChange={setMode}>
      {MODES.map((value) => <Label className="grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-2 rounded-lg border border-input bg-card p-2.5 transition-colors has-[[data-checked]]:border-primary has-[[data-checked]]:bg-accent-cta-soft" key={value}>
        <RadioGroupItem className="mt-0.5" disabled={value === 'recordOwner' && !canUseRecordOwner} value={value} />
        <span className="grid gap-0.5"><strong className="text-sm font-medium text-ink-secondary">{t(`accessModes.${value}.label`)}</strong><small className="text-xs text-muted-foreground">{t(`accessModes.${value}.description`)}</small></span>
      </Label>)}
      </RadioGroup>
      {!canUseRecordOwner && <p className="m-0 text-xs text-warning">{t('security.recordOwnerNeedsField')}</p>}
    </fieldset>
    {mode === 'recordOwner' && <FormField htmlFor="access-owner-field" label={t('security.ownerField')} hint={t('security.ownerFieldHint')}>
      <SelectField id="access-owner-field" onValueChange={(selectedValue) => setOwnerFieldId(selectedValue)} value={ownerFieldId} options={[({ value: "", label: t('security.chooseField') }), ownerFields.map((field) => ({ value: field.id ?? field.name, label: field.name }))]} />
    </FormField>}
    {mode === 'custom' && <section aria-label={t('security.conditionsLabel')} className="grid gap-3 border-t pt-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-ink-secondary">{t('security.conditionsTitle')}</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('security.conditionsDescription')}</p>
        </div>
        <Button disabled={conditions.length >= 16 || customFields.length === 0} onClick={addCondition} size="small" type="button">{t('security.addCondition')}</Button>
      </div>
      {conditions.map((condition, index) => {
        const field = conditionField(condition.fieldId);
        return <div className="grid items-end gap-2.5 border-b py-3 min-[761px]:grid-cols-[minmax(110px,1fr)_minmax(115px,0.8fr)_minmax(140px,1.2fr)_auto]" key={`${index}-${condition.fieldId}`}>
          <Label className="grid min-w-0 gap-1 text-xs text-muted-foreground"><span>{t('security.field')}</span><SelectField aria-label={t('security.conditionField', { index: index + 1 })} onValueChange={(selectedValue) => updateCondition(index, { fieldId: selectedValue, value: '' })} value={condition.fieldId} options={[customFields.map((option) => ({ value: option.id ?? option.name, label: option.name }))]} /></Label>
          <Label className="grid min-w-0 gap-1 text-xs text-muted-foreground"><span>{t('security.operator')}</span><SelectField aria-label={t('security.conditionOperator', { index: index + 1 })} onValueChange={(selectedValue) => updateCondition(index, { operator: selectedValue as ConditionDraft['operator'], value: '' })} value={condition.operator} options={[({ value: "eq", label: t('security.operators.eq') }), ({ value: "neq", label: t('security.operators.neq') }), ({ value: "in", label: t('security.operators.in') })]} /></Label>
          <Label className="grid min-w-0 gap-1 text-xs text-muted-foreground min-[761px]:col-span-1 max-[760px]:col-span-full"><span>{condition.operator === 'in' ? t('security.valueJsonArray') : t('security.value')}</span>{field ? predicateValueControl(field, condition.operator, condition.value, (value) => updateCondition(index, { value }), t) : <Input aria-label={t('security.conditionValue')} disabled value="" />}</Label>
          <Button aria-label={t('security.removeCondition', { index: index + 1 })} disabled={conditions.length === 1} onClick={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))} size="small" type="button" variant="quiet">{t('security.remove')}</Button>
        </div>;
      })}
    </section>}
    {validationError && <div className="text-xs font-semibold text-danger" role="alert">{t(validationError, validationValues)}</div>}
    <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3"><Button disabled={busy} onClick={onCancel} type="button" variant="quiet">{t('common.cancel')}</Button><Button disabled={busy || (mode === 'custom' && customFields.length === 0)} type="submit" variant="primary">{busy ? t('security.saving') : t('security.save')}</Button></div>
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
  const { t, errorMessage } = useI18n();
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

  return <div aria-labelledby="security-tab-authentication" className="flex min-w-0 flex-col gap-4" id="security-panel-authentication" role="tabpanel">
    {loadState === 'loading' && <LoadingState label={t('security.authenticationLoading')} />}
    {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.authenticationLoadFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
    {loadState === 'ready' && state && draft && <>
      {message && <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status"><Check aria-hidden="true" className="shrink-0 text-success" size={15} />{t(message)}</div>}
      {actionError && (() => { const copy = errorCopy(actionError, t('security.authenticationChangeFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('security.authenticationReload')}</Button></ErrorState>; })()}
      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t('security.authenticationTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('security.authenticationDescription')}</p>
          </div>
          <Badge variant="outline">{t('security.version', { version: state.version })}</Badge>
        </div>
        {!editing ? <dl className="m-0 grid gap-0">
          <div className="grid gap-1 border-b px-0.5 py-2.5 min-[561px]:grid-cols-[minmax(130px,0.5fr)_minmax(0,1.5fr)] min-[561px]:gap-3"><dt className="text-xs font-semibold text-muted-foreground">{t('security.emailPassword')}</dt><dd className="m-0 grid gap-0.5"><strong className="text-xs font-medium text-foreground">{t(state.pending.emailPasswordEnabled ? 'security.enabled' : 'security.disabled')}</strong><span className="text-xs text-muted-foreground">{t(state.pending.emailPasswordEnabled ? 'security.emailPasswordEnabled' : 'security.emailPasswordDisabled')}</span></dd></div>
          <div className="grid gap-1 border-b px-0.5 py-2.5 min-[561px]:grid-cols-[minmax(130px,0.5fr)_minmax(0,1.5fr)] min-[561px]:gap-3"><dt className="text-xs font-semibold text-muted-foreground">{t('security.selfRegistration')}</dt><dd className="m-0 grid gap-0.5"><strong className="text-xs font-medium text-foreground">{t(state.pending.selfRegistration ? 'security.enabled' : 'security.disabled')}</strong><span className="text-xs text-muted-foreground">{t(state.pending.selfRegistration ? 'security.selfRegistrationEnabled' : 'security.selfRegistrationDisabled')}</span></dd></div>
          <div className="grid gap-1 border-b px-0.5 py-2.5 min-[561px]:grid-cols-[minmax(130px,0.5fr)_minmax(0,1.5fr)] min-[561px]:gap-3"><dt className="text-xs font-semibold text-muted-foreground">{t('security.sessionDuration')}</dt><dd className="m-0 grid gap-0.5"><strong className="text-xs font-medium text-foreground">{t('security.sessionDurationValue', { count: state.pending.sessionDurationDays })}</strong><span className="text-xs text-muted-foreground">{t('security.sessionDurationExpiry')}</span></dd></div>
          <div className="grid gap-1 border-b px-0.5 py-2.5 min-[561px]:grid-cols-[minmax(130px,0.5fr)_minmax(0,1.5fr)] min-[561px]:gap-3"><dt className="text-xs font-semibold text-muted-foreground">{t('security.emailVerification')}</dt><dd className="m-0 grid gap-0.5"><strong className="text-xs font-medium text-foreground">{emailVerificationLabel(state.pending.emailVerification, t)}</strong><span className="text-xs text-muted-foreground">{emailVerificationHint(state.pending.emailVerification, t)}</span></dd></div>
        </dl> : <form className="grid max-w-[600px] gap-3" onSubmit={(event) => void save(event)}>
          <FormField htmlFor="auth-email-password" hint={t('security.authEmailPasswordHint')} label={t('security.emailPassword')}><SelectField id="auth-email-password" onValueChange={(selectedValue) => setDraft({ ...draft, emailPasswordEnabled: selectedValue === 'enabled' })} value={draft.emailPasswordEnabled ? 'enabled' : 'disabled'} options={[({ value: "enabled", label: t('security.enabled') }), ({ value: "disabled", label: t('security.disabled') })]} /></FormField>
          <FormField htmlFor="auth-self-registration" label={t('security.selfRegistration')}><SelectField id="auth-self-registration" onValueChange={(selectedValue) => setDraft({ ...draft, selfRegistration: selectedValue === 'enabled' })} value={draft.selfRegistration ? 'enabled' : 'disabled'} options={[({ value: "disabled", label: t('security.disabled') }), ({ value: "enabled", label: t('security.enabled') })]} /></FormField>
          <FormField htmlFor="auth-session-days" hint={t('security.authSessionDaysHint')} label={t('security.authSessionDays')}><Input id="auth-session-days" min="1" onChange={(event) => setDraft({ ...draft, sessionDurationDays: Number(event.target.value) })} type="number" value={draft.sessionDurationDays} /></FormField>
          <FormField htmlFor="auth-email-verification" hint={t('security.authEmailVerificationHint')} label={t('security.emailVerification')}><SelectField id="auth-email-verification" onValueChange={(selectedValue) => setDraft({ ...draft, emailVerification: selectedValue as EmailVerificationMode })} value={draft.emailVerification ?? 'off'} options={[({ value: "off", label: t('security.emailVerificationLabels.off') }), ({ value: "optional", label: t('security.emailVerificationLabels.optional') }), ({ value: "required", label: t('security.emailVerificationLabels.required') })]} /></FormField>
          <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3"><Button disabled={saving} onClick={() => { setDraft(state.pending); setEditing(false); }} type="button" variant="quiet">{t('common.cancel')}</Button><Button disabled={saving || draft.sessionDurationDays < 1 || !Number.isInteger(draft.sessionDurationDays)} type="submit" variant="primary">{saving ? t('security.saving') : t('security.authSave')}</Button></div>
        </form>}
        {!editing && <div className="flex justify-end"><Button disabled={saving} onClick={() => { setDraft(state.pending); setEditing(true); }} size="small">{t('security.edit')}</Button></div>}
        {hasPending ? <div aria-label={t('security.authPendingPanelLabel')} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3" role="region">
          <div className="grid gap-0.5"><strong className="text-xs font-semibold text-warning">{t('security.authPendingTitle')}</strong><span className="text-xs text-ink-secondary">{t('security.authPendingHint')}</span></div>
          <div className="flex flex-wrap gap-2"><Button disabled={saving} onClick={() => setConfirmDiscard(true)} size="small">{t('security.discard')}</Button><Button disabled={saving} onClick={() => setConfirmApply(true)} size="small" variant="primary">{t('security.authApply')}</Button></div>
        </div> : <div className="flex items-center gap-2 text-xs text-success"><ShieldCheck aria-hidden="true" size={15} />{t('security.authAllApplied')}</div>}
        {confirmApply && <div className="grid gap-2 rounded-lg border border-input bg-secondary p-3.5" role="alert"><strong className="text-sm font-semibold text-foreground">{t('security.authApplyConfirmTitle')}</strong><span className="text-xs leading-relaxed text-muted-foreground">{t('security.authApplyConfirmBody')}</span><div className="flex justify-end gap-1.5 pt-0.5"><Button disabled={saving} onClick={() => setConfirmApply(false)} size="small">{t('common.cancel')}</Button><Button disabled={saving} onClick={() => void apply()} size="small" variant="primary">{saving ? t('security.applying') : t('security.confirmAndApply')}</Button></div></div>}
        {confirmDiscard && <div className="grid gap-2 rounded-lg border border-input bg-secondary p-3.5" role="alert"><strong className="text-sm font-semibold text-foreground">{t('security.authDiscardConfirmTitle')}</strong><span className="text-xs leading-relaxed text-muted-foreground">{t('security.authDiscardConfirmBody')}</span><div className="flex justify-end gap-1.5 pt-0.5"><Button disabled={saving} onClick={() => setConfirmDiscard(false)} size="small">{t('common.cancel')}</Button><Button disabled={saving} onClick={() => void discard()} size="small" variant="danger">{saving ? t('security.discarding') : t('security.authDiscardPending')}</Button></div></div>}
      </Surface>
    </>}
  </div>;
}

function ApplicationUsersPanel({ collection }: { collection: Collection }) {
  const { t, errorMessage } = useI18n();
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
  // 密码失败文案按稳定错误码本地化，辅助信息只保留错误码和请求 ID。
  const [passwordError, setPasswordError] = useState('');
  const [passwordErrorDetails, setPasswordErrorDetails] = useState('');
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
    if (!password) { setPasswordError(t('security.passwordEmpty')); setPasswordErrorDetails(''); return; }
    if (password !== confirmPassword) { setPasswordError(t('security.passwordMismatch')); setPasswordErrorDetails(''); return; }
    setBusy(true);
    setPasswordError('');
    setPasswordErrorDetails('');
    setMessage('');
    try {
      await setApplicationUserPassword(collection.id, selectedUserId, password);
      setPassword('');
      setConfirmPassword('');
      setMessage('security.passwordChanged');
    } catch (reason) {
      const copy = errorCopy(reason, t('security.passwordFailed'), t, errorMessage);
      setPasswordError(copy.title);
      setPasswordErrorDetails(copy.message);
    }
    finally { setBusy(false); }
  }

  const filtered = users.filter((user) => `${user.email} ${user.recordId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedEmail = users.find((user) => user.recordId === selectedUserId)?.email ?? (typeof profile?.email === 'string' ? profile.email : t('security.profileFallback'));

  return <div aria-labelledby="security-tab-users" className="flex min-w-0 flex-col gap-4" id="security-panel-users" role="tabpanel">
    <Surface className="flex flex-wrap items-center justify-between gap-3" variant="section">
      <div className="grid min-w-0 gap-0.5">
        <h2 className="text-base font-semibold">{t('security.usersTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('security.usersDescription')}</p>
      </div>
      <ButtonLink size="small" to={`/collections/${encodeURIComponent(collection.id)}?new=1`} variant="primary"><UserRound aria-hidden="true" size={14} />{t('security.createUser')}</ButtonLink>
    </Surface>
    <SearchInput aria-label={t('security.searchUsers')} onChange={(event) => updateQuery({ userSearch: event.target.value || undefined })} placeholder={t('security.searchUsersPlaceholder')} value={search} className="w-full max-w-[420px]" />
    {loadState === 'loading' && <LoadingState label={t('security.usersLoading')} />}
    {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.usersLoadFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
    {loadState === 'ready' && filtered.length === 0 && <EmptyState description={users.length ? t('security.usersNoMatchDescription') : t('security.usersEmptyDescription')} title={users.length ? t('security.usersNoMatchTitle') : t('security.usersEmptyTitle')}>{!users.length && <ButtonLink to={`/collections/${encodeURIComponent(collection.id)}?new=1`} variant="primary">{t('security.createUser')}</ButtonLink>}</EmptyState>}
    {loadState === 'ready' && filtered.length > 0 && <Surface className="flex min-w-0 flex-col gap-3" variant="section">
      <div className="flex flex-wrap justify-between gap-2.5 text-xs text-muted-foreground"><span>{t('security.usersPageSummary', { count: filtered.length })}</span><span>{t('security.usersSearchHint')}</span></div>
      <div className="flex min-w-0 flex-col" role="list">{filtered.map((user) => <article className="flex flex-wrap items-center gap-3 border-b px-1 py-2.5 last:border-b-0" data-user-row key={user.recordId} role="listitem">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><UserRound aria-hidden="true" size={15} /></div>
        <div className="grid min-w-0 flex-1 gap-0.5"><strong className="truncate text-sm font-medium text-ink-secondary">{user.email}</strong><span className="truncate font-mono text-[13px] text-muted-foreground">{user.recordId}</span></div>
        <Button onClick={() => selectUser(user.recordId)} size="small">{selectedUserId === user.recordId ? t('security.selected') : t('security.viewUser')}</Button>
        <Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'sessions'); next.set('user', user.recordId); setSearchParams(next); }} size="small" variant="quiet">{t('security.sessions')}</Button>
      </article>)}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t('security.page', { page: cursorStack.length + 1 })}</span><div className="flex gap-1.5"><Button disabled={!cursorStack.length} onClick={previousUsersPage} size="small">{t('security.previous')}</Button><Button disabled={!nextCursor} onClick={nextUsersPage} size="small">{t('security.next')}</Button></div></div>
    </Surface>}
    {message && <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status"><Check aria-hidden="true" className="shrink-0 text-success" size={15} />{t(message)}</div>}
    {selectedUserId && <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0"><h2 className="text-base font-semibold">{selectedEmail}</h2><p className="mt-1 text-xs text-muted-foreground">{selectedUserId}</p></div>
        <Button onClick={() => updateQuery({ user: undefined })} size="small" variant="quiet">{t('security.close')}</Button>
      </div>
      {profileState === 'loading' && <LoadingState label={t('security.profileLoading')} />}
      {profileState === 'error' && (() => { const copy = errorCopy(profileError, t('security.profileLoadFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => selectUser(selectedUserId)} size="small">{t('common.retry')}</Button></ErrorState>; })()}
      {profileState === 'ready' && profile && <dl className="m-0 grid gap-0">{Object.entries(profile).filter(([key]) => !['id', 'createdAt', 'updatedAt'].includes(key)).map(([key, value]) => <div className="grid gap-1 border-b px-0.5 py-2 last:border-b-0 min-[561px]:grid-cols-[minmax(100px,0.35fr)_minmax(0,1fr)] min-[561px]:gap-2.5" key={key}><dt className="text-xs font-semibold text-muted-foreground">{key}</dt><dd className="m-0 break-words text-xs text-ink-secondary">{formatSecurityValue(value)}</dd></div>)}</dl>}
      <form className="grid max-w-[520px] gap-3 border-t pt-3" onSubmit={(event) => void changePassword(event)}>
        <div className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1 text-ink-secondary"><KeyRound aria-hidden="true" size={15} /><strong className="text-xs font-semibold">{t('security.changePassword')}</strong><span className="col-start-2 text-xs text-muted-foreground">{t('security.changePasswordHint')}</span></div>
        <FormField htmlFor="app-user-new-password" label={t('security.newPassword')}><Input autoComplete="new-password" disabled={busy} id="app-user-new-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></FormField>
        <FormField htmlFor="app-user-confirm-password" label={t('security.confirmPassword')}><Input autoComplete="new-password" disabled={busy} id="app-user-confirm-password" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></FormField>
        {passwordError && <span className="block text-xs font-semibold text-danger" role="alert">{passwordError}</span>}
        {passwordErrorDetails && <span className="text-xs text-muted-foreground">{passwordErrorDetails}</span>}
        <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3"><Button disabled={busy} type="submit" variant="primary">{busy ? t('security.changing') : t('security.changePassword')}</Button></div>
      </form>
      <Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'sessions'); next.set('user', selectedUserId); setSearchParams(next); }} size="small" variant="quiet">{t('security.viewSessions')}</Button>
    </Surface>}
  </div>;
}

function ApplicationSessionsPanel({ collection }: { collection: Collection }) {
  const { t, formatDate, errorMessage } = useI18n();
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

  return <div aria-labelledby="security-tab-sessions" className="flex min-w-0 flex-col gap-4" id="security-panel-sessions" role="tabpanel">
    {!selectedUserId ? <>
      <Surface className="flex flex-wrap items-center justify-between gap-3" variant="section">
        <div className="grid min-w-0 gap-0.5">
          <h2 className="text-base font-semibold">{t('security.sessions')}</h2>
          <p className="text-xs text-muted-foreground">{t('security.sessionsDescription')}</p>
        </div>
        <Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'users'); setSearchParams(next); }} size="small" type="button" variant="quiet">{t('security.manageUsers')}</Button>
      </Surface>
      <SearchInput aria-label={t('security.searchUser')} onChange={(event) => updateQuery({ userSearch: event.target.value || undefined })} placeholder={t('security.searchUserPlaceholder')} value={search} className="w-full max-w-[420px]" />
      {usersLoadState === 'loading' && <LoadingState label={t('security.usersLoading')} />}
      {usersLoadState === 'error' && (() => { const copy = errorCopy(usersError, t('security.usersLoadFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setUsersReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
      {usersLoadState === 'ready' && <Surface className="flex min-w-0 flex-col gap-3" variant="section">
        {filteredUsers.length === 0 ? <EmptyState description={users.length ? t('security.sessionsNoUsersMatchDescription') : t('security.sessionsNoUsersDescription')} title={users.length ? t('security.sessionsNoUsersMatchTitle') : t('security.sessionsNoUsersTitle')} /> : <>
          <div className="flex flex-wrap justify-between gap-2.5 text-xs text-muted-foreground"><span>{t('security.usersPageSummary', { count: filteredUsers.length })}</span><span>{t('security.sessionsSearchHint')}</span></div>
          <div className="flex min-w-0 flex-col" role="list">{filteredUsers.map((user) => <article className="flex flex-wrap items-center gap-3 border-b px-1 py-2.5 last:border-b-0" data-user-row key={user.recordId} role="listitem"><div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><UserRound aria-hidden="true" size={15} /></div><div className="grid min-w-0 flex-1 gap-0.5"><strong className="truncate text-sm font-medium text-ink-secondary">{user.email}</strong><span className="truncate font-mono text-[13px] text-muted-foreground">{user.recordId}</span></div><Button onClick={() => updateQuery({ user: user.recordId })} size="small">{t('security.viewSessions')}</Button></article>)}</div>
        </>}
        {(filteredUsers.length > 0 || usersCursorStack.length > 0 || usersNextCursor) && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t('security.page', { page: usersCursorStack.length + 1 })}</span><div className="flex gap-1.5"><Button disabled={!usersCursorStack.length} onClick={previousUsersPage} size="small">{t('security.previous')}</Button><Button disabled={!usersNextCursor} onClick={nextUsersPage} size="small">{t('security.next')}</Button></div></div>}
      </Surface>}
    </> : <>
      <Surface className="flex flex-wrap items-start justify-between gap-3" variant="section">
        <div className="grid min-w-0 gap-0.5">
          <h2 className="text-base font-semibold">{t('security.sessions')}</h2>
          <p className="text-xs text-muted-foreground">{identity || selectedUserId}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => { const next = new URLSearchParams(searchParams); next.set('panel', 'users'); setSearchParams(next); }} size="small" variant="quiet">{t('security.changeUser')}</Button>
          <Button disabled={busy} onClick={() => setConfirm('all')} size="small" variant="danger">{t('security.sessionRevokeAll')}</Button>
        </div>
      </Surface>
      {message && <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status"><Check aria-hidden="true" className="shrink-0 text-success" size={15} />{t(message)}</div>}
      {loadState === 'loading' && <LoadingState label={t('security.sessionsLoading')} />}
      {loadState === 'error' && (() => { const copy = errorCopy(error, t('security.sessionsLoadFailed'), t, errorMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('common.retry')}</Button></ErrorState>; })()}
      {loadState === 'ready' && sessions.length === 0 && <EmptyState description={t('security.sessionsEmptyDescription')} title={t('security.sessionsEmptyTitle')} />}
      {loadState === 'ready' && sessions.length > 0 && <Surface className="flex min-w-0 flex-col gap-3" variant="section">
        <div className="flex flex-wrap justify-between gap-2.5 text-xs text-muted-foreground"><span>{t('security.sessionsActive', { count: sessions.filter((session) => session.status === 'active').length })}</span><span>{t('security.sessionsTotal', { count: sessions.length })}</span></div>
        <div className="flex min-w-0 flex-col" role="list">{sessions.map((session) => <article className="flex flex-wrap items-center gap-3 border-b px-1 py-2.5 last:border-b-0" data-session-row key={session.id} role="listitem">
          <StatusChip state={session.status === 'active' ? 'ready' : 'disabled'}>{session.status === 'active' || session.status === 'revoked' || session.status === 'expired' ? t(`security.sessionStatuses.${session.status}` as TranslationKey) : session.status}</StatusChip>
          <dl className="m-0 grid min-w-0 flex-1 grid-cols-1 gap-2 min-[561px]:grid-cols-3"><div className="grid gap-0.5"><dt className="text-xs uppercase text-muted-foreground">{t('security.sessionCreated')}</dt><dd className="m-0 text-xs text-ink-secondary">{displaySecurityDate(session.createdAt, formatDate)}</dd></div><div className="grid gap-0.5"><dt className="text-xs uppercase text-muted-foreground">{t('security.sessionLastUsed')}</dt><dd className="m-0 text-xs text-ink-secondary">{displaySecurityDate(session.lastUsedAt, formatDate)}</dd></div><div className="grid gap-0.5"><dt className="text-xs uppercase text-muted-foreground">{t('security.sessionExpires')}</dt><dd className="m-0 text-xs text-ink-secondary">{displaySecurityDate(session.expiresAt, formatDate)}</dd></div></dl>
          {session.status === 'active' && <Button disabled={busy} onClick={() => setConfirm(session.id)} size="small" variant="danger">{t('security.sessionRevoke')}</Button>}
        </article>)}</div>
      </Surface>}
      {confirm && <div className="grid gap-2 rounded-lg border border-input bg-secondary p-3.5" role="alert"><strong className="text-sm font-semibold text-foreground">{confirm === 'all' ? t('security.sessionConfirmAllTitle') : t('security.sessionConfirmOneTitle')}</strong><span className="text-xs leading-relaxed text-muted-foreground">{t('security.sessionConfirmBody')}</span><div className="flex justify-end gap-1.5 pt-0.5"><Button disabled={busy} onClick={() => setConfirm(undefined)} size="small">{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void revoke(confirm === 'all' ? undefined : confirm)} size="small" variant="danger">{busy ? t('security.sessionRevoking') : t('security.sessionConfirm')}</Button></div></div>}
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
