import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { useOwnerSession } from '../auth/owner-session';
import { Button, CopyButton, Dialog, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import {
  createAPIKey, createServiceAccount, getAuditRecord, getServiceAccount, listAPIKeys, listAuditRecords, listServiceAccounts,
  revokeAPIKey, setServiceAccountEnabled, updateServiceAccount,
  type APIKey, type APIKeyReveal, type AuditRecord, type CustomPermissionOperation, type PermissionPreset, type ServiceAccount,
} from './client';
import './access.css';

type Translate = ReturnType<typeof useI18n>['t'];

const operationGroups: Array<{ labelKey: TranslationKey; operations: CustomPermissionOperation[] }> = [
  { labelKey: 'access.permissionGroups.runtime', operations: ['runtime.read', 'storage.read'] },
  { labelKey: 'access.permissionGroups.collections', operations: ['collections.read', 'collections.create', 'records.read', 'records.create', 'records.update', 'records.delete', 'files.read', 'files.write'] },
  { labelKey: 'access.permissionGroups.model', operations: ['schema.read', 'schema.write', 'schema.apply', 'accessRules.read', 'accessRules.write', 'accessRules.apply', 'authentication.read', 'authentication.write', 'authentication.apply'] },
  { labelKey: 'access.permissionGroups.users', operations: ['users.read', 'users.create', 'users.managePassword', 'sessions.read', 'sessions.revoke'] },
  { labelKey: 'access.permissionGroups.access', operations: ['serviceAccounts.read', 'serviceAccounts.manage', 'apiKeys.read', 'apiKeys.create', 'apiKeys.revoke', 'requests.read', 'audit.read'] },
];

function errorCopy(error: unknown, fallback: string, t: Translate) {
  if (error instanceof ApiClientError) return { title: error.apiError.message, detail: [error.apiError.code, error.apiError.hint, `${t('common.requestId')}: ${error.apiError.requestId}`].filter(Boolean).join(' · ') };
  return { title: fallback, detail: error instanceof Error ? error.message : t('common.tryAgainWhenAvailable') };
}

function PermissionLabel({ permission }: { permission: PermissionPreset }) {
  const { t } = useI18n();
  return <>{t(`access.permissions.${permission}`)}</>;
}

function PermissionFields({ selected, onChange }: { selected: CustomPermissionOperation[]; onChange: (next: CustomPermissionOperation[]) => void }) {
  const { t } = useI18n();
  function toggle(operation: CustomPermissionOperation, checked: boolean) {
    onChange(checked ? [...new Set([...selected, operation])] : selected.filter((value) => value !== operation));
  }
  return <div className="access-custom-permissions" aria-label={t('access.customPermissionsLabel')}>
    <p>{t('access.customPermissionsDescription')}</p>
    <div className="access-permission-groups">{operationGroups.map((group) => <fieldset key={group.labelKey}>
      <legend>{t(group.labelKey)}</legend>
      {group.operations.map((operation) => <label className="access-operation" key={operation}><input checked={selected.includes(operation)} onChange={(event) => toggle(operation, event.target.checked)} type="checkbox" value={operation} /><code>{operation}</code></label>)}
    </fieldset>)}</div>
  </div>;
}

function AccountForm({
  initial, creating, busy, error, onSubmit, onCancel,
}: {
  initial?: ServiceAccount;
  creating: boolean;
  busy: boolean;
  error?: unknown;
  onSubmit: (draft: { name: string; description: string; permission: PermissionPreset; createAPIKey: boolean; customOperations: CustomPermissionOperation[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [permission, setPermission] = useState<PermissionPreset>(initial?.permission ?? 'readOnly');
  const [createKey, setCreateKey] = useState(true);
  const [customOperations, setCustomOperations] = useState<CustomPermissionOperation[]>(initial?.customOperations ?? []);
  const [validation, setValidation] = useState<TranslationKey | ''>('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) { setValidation('access.errorName'); return; }
    if (permission === 'custom' && !customOperations.length) { setValidation('access.errorOperations'); return; }
    setValidation('');
    await onSubmit({ name: name.trim(), description: description.trim(), permission, createAPIKey: creating ? createKey : false, customOperations });
  }

  return <form className="access-form" onSubmit={(event) => void submit(event)}>
    {error !== undefined && (() => { const copy = errorCopy(error, t('access.saveFailed'), t); return <ErrorState description={copy.detail} title={copy.title} />; })()}
    <FormField htmlFor="account-name" label={t('access.formName')}><input autoComplete="off" id="account-name" maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></FormField>
    <FormField htmlFor="account-description" label={t('access.formDescription')}><textarea id="account-description" maxLength={500} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} /></FormField>
    <FormField htmlFor="account-permission" hint={t('access.formPermissionHint')} label={t('access.formPermission')}>
      <select id="account-permission" onChange={(event) => setPermission(event.target.value as PermissionPreset)} value={permission}>
        <option value="fullAccess">{t('access.permissions.fullAccess')}</option><option value="readOnly">{t('access.permissions.readOnly')}</option><option value="custom">{t('access.permissions.custom')}</option>
      </select>
    </FormField>
    {permission === 'custom' && <PermissionFields onChange={setCustomOperations} selected={customOperations} />}
    {creating && <label className="access-checkbox"><input checked={createKey} onChange={(event) => setCreateKey(event.target.checked)} type="checkbox" /><span><strong>{t('access.createKey')}</strong><small>{t('access.createKeyHint')}</small></span></label>}
    {validation && <p className="access-validation" role="alert">{t(validation)}</p>}
    <div className="access-form__actions"><Button disabled={busy} type="submit" variant="primary">{busy ? t('access.saving') : creating ? t('access.create') : t('access.save')}</Button><Button disabled={busy} onClick={onCancel} type="button">{t('common.cancel')}</Button></div>
  </form>;
}

function OneTimeReveal({ value, onDone }: { value: APIKeyReveal | null; onDone: () => void }) {
  const { t } = useI18n();
  return <Dialog closeLabel={t('common.closeDialog')} open={Boolean(value)} onClose={onDone} size="wide" title={t('access.revealTitle')}>
    {value && <div className="access-reveal">
      <p role="status">{t('access.revealDescription')}</p>
      <div className="access-reveal__secret"><code>{value.secret}</code><CopyButton label={t('access.revealCopy')} value={value.secret} /></div>
      <dl><div><dt>{t('access.revealKeyName')}</dt><dd>{value.apiKey.name}</dd></div><div><dt>{t('access.revealStatus')}</dt><dd><StatusChip state={value.apiKey.status}>{value.apiKey.status}</StatusChip></dd></div></dl>
      <Button onClick={onDone} type="button" variant="primary">{t('access.revealDone')}</Button>
    </div>}
  </Dialog>;
}

function DangerDialog({ open, title, description, busy, error, onClose, onConfirm, confirmLabel }: {
  open: boolean;
  title: string;
  description: string;
  busy: boolean;
  error?: unknown;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
}) {
  const { t } = useI18n();
  return <Dialog closeLabel={t('common.closeDialog')} open={open} onClose={onClose} title={title}>
    <p>{description}</p>{error !== undefined && (() => { const copy = errorCopy(error, t('access.securityActionFailed'), t); return <ErrorState description={copy.detail} title={copy.title} />; })()}<div className="access-form__actions"><Button disabled={busy} onClick={onConfirm} type="button" variant="danger">{busy ? t('access.saving') : confirmLabel}</Button><Button disabled={busy} onClick={onClose} type="button">{t('common.cancel')}</Button></div>
  </Dialog>;
}

function AccessTabs({ active }: { active: 'access' | 'audit' }) {
  const { t } = useI18n();
  return <nav aria-label={t('access.tabsLabel')} className="access-tabs"><Link aria-current={active === 'access' ? 'page' : undefined} to="/access">{t('access.tabs.access')}</Link><Link aria-current={active === 'audit' ? 'page' : undefined} to="/access/audit">{t('access.tabs.audit')}</Link></nav>;
}

function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-heading access-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action}</header>;
}

export function AccessPage() {
  const { t, formatDate } = useI18n();
  const { state: ownerState } = useOwnerSession();
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const [reveal, setReveal] = useState<{ accountId: string; key: APIKeyReveal } | null>(null);
  const [successMessage, setSuccessMessage] = useState<TranslationKey | ''>('');
  const accountId = params.get('account') ?? '';
  const [account, setAccount] = useState<ServiceAccount>();
  const [keys, setKeys] = useState<APIKey[]>([]);
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detailError, setDetailError] = useState<unknown>();
  const [detailReload, setDetailReload] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<unknown>();
  const [keyName, setKeyName] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<unknown>();
  const [danger, setDanger] = useState<{ kind: 'disable' } | { kind: 'revoke'; key: APIKey } | null>(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerError, setDangerError] = useState<unknown>();

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    const current = params.get('cursor') ?? undefined;
    void listServiceAccounts({ limit: 50, cursor: current }, controller.signal).then((page) => {
      if (!controller.signal.aborted) { setAccounts(page.data); setCursor(page.nextCursor); setState('ready'); setError(undefined); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(reason); setState('error'); } });
    return () => controller.abort();
  }, [params.get('cursor'), reload]);

  useEffect(() => {
    if (!accountId) { setAccount(undefined); setKeys([]); setDetailState('ready'); return; }
    const controller = new AbortController();
    setDetailState('loading');
    setDetailError(undefined);
    void getServiceAccount(accountId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setAccount(value); setDetailState('ready'); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setDetailError(reason); setDetailState('error'); } });
    setKeyError(undefined);
    void listAPIKeys(accountId, controller.signal).then((page) => { if (!controller.signal.aborted) { setKeys(page.data); setKeyError(undefined); } }).catch((reason: unknown) => { if (!controller.signal.aborted) setKeyError(reason); });
    return () => controller.abort();
  }, [accountId, detailReload]);

  useEffect(() => {
    setReveal((current) => current && current.accountId !== accountId ? null : current);
  }, [accountId]);

  async function refreshList() { setReload((value) => value + 1); }
  function closeReveal() { setReveal(null); }

  async function submitCreate(draft: { name: string; description: string; permission: PermissionPreset; createAPIKey: boolean; customOperations: CustomPermissionOperation[] }) {
    setCreateBusy(true); setCreateError(undefined); setSuccessMessage('');
    try {
      const result = await createServiceAccount({
        name: draft.name,
        ...(draft.description ? { description: draft.description } : {}),
        permission: draft.permission,
        createAPIKey: draft.createAPIKey,
        ...(draft.permission === 'custom' ? { customPermissionVersion: 1, customOperations: draft.customOperations } : {}),
      });
      setCreateOpen(false);
      setParams((current) => { const next = new URLSearchParams(current); next.set('account', result.serviceAccount.id); next.delete('cursor'); return next; });
      setDetailReload((value) => value + 1);
      setReload((value) => value + 1);
      if (result.apiKeyReveal) setReveal({ accountId: result.serviceAccount.id, key: result.apiKeyReveal });
      else setSuccessMessage(draft.createAPIKey ? 'access.createdWithoutKey' : 'access.created');
    } catch (reason) { setCreateError(reason); }
    finally { setCreateBusy(false); }
  }

  async function submitEdit(draft: { name: string; description: string; permission: PermissionPreset; customOperations: CustomPermissionOperation[] }) {
    if (!account) return;
    setEditBusy(true); setEditError(undefined);
    try {
      await updateServiceAccount(account.id, {
        name: draft.name, description: draft.description, permission: draft.permission,
        ...(draft.permission === 'custom' ? { customPermissionVersion: 1, customOperations: draft.customOperations } : {}),
      });
      setEditOpen(false); setDetailReload((value) => value + 1); setReload((value) => value + 1); setSuccessMessage('access.updated');
    } catch (reason) { setEditError(reason); }
    finally { setEditBusy(false); }
  }

  async function makeKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    setKeyBusy(true); setKeyError(undefined);
    try {
      const value = await createAPIKey(account.id, keyName.trim() || undefined);
      setKeyName(''); setReveal({ accountId: account.id, key: value }); setDetailReload((current) => current + 1);
    } catch (reason) { setKeyError(reason); }
    finally { setKeyBusy(false); }
  }

  async function confirmDanger() {
    if (!account || !danger) return;
    setDangerBusy(true); setDangerError(undefined);
    try {
      if (danger.kind === 'disable') await setServiceAccountEnabled(account.id, false);
      else await revokeAPIKey(danger.key.id);
      setDanger(null); setDetailReload((value) => value + 1); setReload((value) => value + 1);
      setSuccessMessage(danger.kind === 'disable' ? 'access.disabledNotice' : 'access.keyRevoked');
    } catch (reason) { setDangerError(reason); }
    finally { setDangerBusy(false); }
  }

  async function enableAccount() {
    if (!account) return;
    setDangerBusy(true); setDangerError(undefined);
    try { await setServiceAccountEnabled(account.id, true); setDetailReload((value) => value + 1); setReload((value) => value + 1); setSuccessMessage('access.enabledNotice'); }
    catch (reason) { setDangerError(reason); }
    finally { setDangerBusy(false); }
  }

  const ownerEmail = ownerState.status === 'authenticated' ? ownerState.session.owner.email : '';
  const pageCursors = params.getAll('back');
  const visibleAccounts = accounts;

  function nextAccounts() {
    if (!cursor) return;
    const next = new URLSearchParams(params); next.append('back', params.get('cursor') ?? ''); next.set('cursor', cursor); setParams(next);
  }
  function previousAccounts() {
    if (!pageCursors.length) return;
    const next = new URLSearchParams(params); next.delete('back'); pageCursors.slice(0, -1).forEach((value) => next.append('back', value));
    const previous = pageCursors.at(-1); if (previous) next.set('cursor', previous); else next.delete('cursor'); setParams(next);
  }

  return <div className="page-stack access-page">
    <PageTitle action={!accountId ? <Button onClick={() => { setCreateOpen(true); setCreateError(undefined); }} variant="primary"><Plus aria-hidden="true" size={16} /> {t('access.create')}</Button> : undefined} description={t('access.description')} eyebrow={t('access.eyebrow')} title={t('access.title')} />
    <AccessTabs active="access" />
    {ownerEmail && <Surface className="access-owner" variant="standard"><div className="access-owner__icon"><ShieldCheck aria-hidden="true" size={18} /></div><div><strong>{t('access.owner')}</strong><span>{ownerEmail}</span></div><StatusChip state="full-access">{t('access.fullAccess')}</StatusChip></Surface>}
    {successMessage && <p className="access-success" role="status">{t(successMessage)}</p>}
    {!accountId && <>
      <div className="section-heading-row access-section-title"><div><div className="access-title-mark"><KeyRound aria-hidden="true" size={16} /></div><div><h2>{t('access.accountsTitle')}</h2><p>{t('access.accountsDescription')}</p></div></div></div>
      {state === 'loading' && <LoadingState label={t('access.loading')} />}
      {state === 'error' && (() => { const copy = errorCopy(error, t('access.loadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => void refreshList()} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></ErrorState>; })()}
      {state === 'ready' && (!visibleAccounts.length ? <EmptyState title={t('access.emptyTitle')} description={t('access.emptyDescription')}><Button onClick={() => setCreateOpen(true)} variant="primary"><Plus aria-hidden="true" size={15} /> {t('access.create')}</Button></EmptyState> : <div className="table-scroll"><table className="data-table access-account-table"><caption>{t('access.accountsTitle')}</caption><thead><tr><th scope="col">{t('access.columnName')}</th><th scope="col">{t('access.columnPermission')}</th><th scope="col">{t('access.columnStatus')}</th><th scope="col">{t('access.columnLastUsed')}</th></tr></thead><tbody>{visibleAccounts.map((item) => <tr key={item.id}><td><Link className="text-link" to={`/access?account=${encodeURIComponent(item.id)}`}>{item.name}</Link>{item.description && <small>{item.description}</small>}</td><td><PermissionLabel permission={item.permission} /></td><td><StatusChip state={item.status}>{item.status}</StatusChip></td><td>{item.lastUsedAt ? <time dateTime={item.lastUsedAt}>{formatDate(item.lastUsedAt)}</time> : t('access.never')}</td></tr>)}</tbody></table></div>)}
      {state === 'ready' && visibleAccounts.length > 0 && <nav aria-label={t('access.pagesLabel')} className="access-pagination"><Button disabled={!pageCursors.length} onClick={previousAccounts} size="small"><ArrowLeft aria-hidden="true" size={14} /> {t('access.previous')}</Button><span>{t('access.perPage')}</span><Button disabled={!cursor} onClick={nextAccounts} size="small">{t('access.next')} <ArrowRight aria-hidden="true" size={14} /></Button></nav>}
    </>}
    {accountId && <ServiceAccountDetail account={account} keys={keys} state={detailState} error={detailError} keyError={keyError} keyName={keyName} onKeyName={setKeyName} onCreateKey={makeKey} keyBusy={keyBusy} onEdit={() => { setEditOpen(true); setEditError(undefined); }} onDisable={() => setDanger({ kind: 'disable' })} onEnable={() => void enableAccount()} onRevoke={(key) => setDanger({ kind: 'revoke', key })} busy={dangerBusy} onRetry={() => setDetailReload((value) => value + 1)} />}
    {createOpen && <Dialog closeLabel={t('common.closeDialog')} onClose={() => { if (!createBusy) setCreateOpen(false); }} open title={t('access.createTitle')}><AccountForm busy={createBusy} creating error={createError} onCancel={() => setCreateOpen(false)} onSubmit={submitCreate} /></Dialog>}
    {editOpen && account && <Dialog closeLabel={t('common.closeDialog')} onClose={() => { if (!editBusy) setEditOpen(false); }} open title={t('access.editTitle')}><AccountForm busy={editBusy} creating={false} error={editError} initial={account} onCancel={() => setEditOpen(false)} onSubmit={(draft) => submitEdit(draft)} /></Dialog>}
    {reveal?.accountId === accountId && <OneTimeReveal onDone={closeReveal} value={reveal.key} />}
    {danger && <DangerDialog busy={dangerBusy} confirmLabel={danger.kind === 'disable' ? t('access.disableConfirm') : t('access.revokeConfirm')} description={danger.kind === 'disable' ? t('access.disableBody') : t('access.revokeBody', { name: danger.kind === 'revoke' ? danger.key.name : '' })} error={dangerError} onClose={() => { if (!dangerBusy) { setDanger(null); setDangerError(undefined); } }} onConfirm={() => void confirmDanger()} open title={danger.kind === 'disable' ? t('access.disableTitle') : t('access.revokeTitle')} />}
    {dangerError !== undefined && !danger && <ErrorState className="access-action-error" description={errorCopy(dangerError, t('access.securityActionFailed'), t).detail} title={errorCopy(dangerError, t('access.securityActionFailed'), t).title} />}
  </div>;
}

function ServiceAccountDetail({
  account, keys, state, error, keyError, keyName, onKeyName, onCreateKey, keyBusy, onEdit, onDisable, onEnable, onRevoke, busy, onRetry,
}: {
  account?: ServiceAccount;
  keys: APIKey[];
  state: 'loading' | 'ready' | 'error';
  error?: unknown;
  keyError?: unknown;
  keyName: string;
  onKeyName: (value: string) => void;
  onCreateKey: (event: FormEvent<HTMLFormElement>) => void;
  keyBusy: boolean;
  onEdit: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onRevoke: (key: APIKey) => void;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t, formatDate } = useI18n();
  if (state === 'loading') return <LoadingState label={t('access.detailLoading')} />;
  if (state === 'error' || !account) { const copy = errorCopy(error, t('access.detailLoadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={onRetry} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button><Link className="text-link" to="/access">{t('access.backToAccess')}</Link></ErrorState>; }
  return <section aria-label={t('access.detailLabel')} className="access-detail">
    <p className="access-back"><Link to="/access"><ArrowLeft aria-hidden="true" size={14} /> {t('access.backToAccess')}</Link></p>
    <Surface className="access-detail-card" variant="standard">
      <header className="access-detail-heading"><div><p className="eyebrow">{t('access.detailEyebrow')}</p><h2>{account.name}</h2><p>{account.description || t('access.noDescription')}</p></div><StatusChip state={account.status}>{account.status}</StatusChip><Button onClick={onEdit} size="small">{t('access.edit')}</Button>{account.status === 'active' ? <Button disabled={busy} onClick={onDisable} size="small" variant="danger">{t('access.disable')}</Button> : <Button disabled={busy} onClick={onEnable} size="small" variant="primary">{t('access.enable')}</Button>}</header>
      <dl className="access-account-meta"><div><dt>{t('access.detailPermission')}</dt><dd><PermissionLabel permission={account.permission} /></dd></div><div><dt>{t('access.detailCreated')}</dt><dd>{account.createdAt ? <time dateTime={account.createdAt}>{formatDate(account.createdAt)}</time> : '—'}</dd></div><div><dt>{t('access.detailLastUsed')}</dt><dd>{account.lastUsedAt ? <time dateTime={account.lastUsedAt}>{formatDate(account.lastUsedAt)}</time> : t('access.never')}</dd></div></dl>
      {account.permission === 'custom' && <div className="access-custom-summary"><strong>{t('access.customSummary', { version: account.customPermissionVersion ?? 1 })}</strong><ul>{(account.customOperations ?? []).map((operation) => <li key={operation}><code>{operation}</code></li>)}</ul></div>}
    </Surface>
    <Surface className="access-key-card" variant="standard"><header><div><h3>{t('access.keysTitle')}</h3><p>{t('access.keysDescription')}</p></div><form onSubmit={onCreateKey}><label className="sr-only" htmlFor="new-key-name">{t('access.newKeyName')}</label><input id="new-key-name" autoComplete="off" maxLength={80} onChange={(event) => onKeyName(event.target.value)} placeholder={t('access.keyNamePlaceholder')} value={keyName} /><Button disabled={keyBusy || account.status === 'disabled'} size="small" type="submit" variant="primary"><Plus aria-hidden="true" size={14} /> {t('access.createKeyAction')}</Button></form></header>
      {keyError !== undefined && (() => { const copy = errorCopy(keyError, t('access.keysLoadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={onRetry} size="small">{t('common.retry')}</Button></ErrorState>; })()}
      {keyError === undefined && !keys.length ? <EmptyState title={t('access.noKeysTitle')} description={t('access.noKeysDescription')} /> : keyError === undefined && <div className="table-scroll"><table className="data-table"><caption>{t('access.keysCaption')}</caption><thead><tr><th scope="col">{t('access.columnName')}</th><th scope="col">{t('access.columnCreated')}</th><th scope="col">{t('access.columnLastUsed')}</th><th scope="col">{t('access.columnStatus')}</th><th scope="col">{t('access.columnAction')}</th></tr></thead><tbody>{keys.map((key) => <tr key={key.id}><td>{key.name}</td><td><time dateTime={key.createdAt}>{formatDate(key.createdAt)}</time></td><td>{key.lastUsedAt ? <time dateTime={key.lastUsedAt}>{formatDate(key.lastUsedAt)}</time> : t('access.never')}</td><td><StatusChip state={key.status}>{key.status}</StatusChip></td><td>{key.status === 'active' ? <Button disabled={busy} onClick={() => onRevoke(key)} size="small" variant="danger">{t('access.revoke')}</Button> : '—'}</td></tr>)}</tbody></table></div>}
    </Surface>
  </section>;
}

function safeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeAuditValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /password|token|secret|credential|api.?key|authorization|cookie/i.test(key) ? '[redacted]' : safeAuditValue(child)]));
}

function localDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function serverDateTime(value: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function AuditPage() {
  const { t, formatDate } = useI18n();
  const { auditRecordId } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<AuditRecord>();
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detailError, setDetailError] = useState<unknown>();
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');
  const [actorDraft, setActorDraft] = useState(params.get('actorKind') ?? 'all');
  const [actorIdDraft, setActorIdDraft] = useState(params.get('actorId') ?? '');
  const [actionDraft, setActionDraft] = useState(params.get('action') ?? '');
  const [resourceKindDraft, setResourceKindDraft] = useState(params.get('resourceKind') ?? '');
  const [resourceIdDraft, setResourceIdDraft] = useState(params.get('resourceId') ?? '');
  const [fromDraft, setFromDraft] = useState(params.get('from') ? localDateTime(params.get('from')!) : '');
  const [toDraft, setToDraft] = useState(params.get('to') ? localDateTime(params.get('to')!) : '');
  const cursor = params.get('cursor') ?? undefined;
  const returnPath = useMemo(() => {
    const value = params.get('from');
    return value && value.startsWith('/access/audit') && !value.startsWith('//') ? value : '/access/audit';
  }, [params]);

  useEffect(() => {
    if (auditRecordId) return;
    const controller = new AbortController();
    setState('loading');
    void listAuditRecords({
      limit: 50, cursor,
      search: params.get('search') ?? undefined,
      actorKind: params.get('actorKind') ?? undefined,
      actorId: params.get('actorId') ?? undefined,
      action: params.get('action') ?? undefined,
      resourceKind: params.get('resourceKind') ?? undefined,
      resourceId: params.get('resourceId') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
    }, controller.signal).then((page) => {
      if (!controller.signal.aborted) { setRecords(page.data); setNextCursor(page.nextCursor); setState('ready'); setError(undefined); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(reason); setState('error'); } });
    return () => controller.abort();
  }, [auditRecordId, cursor, params, reload]);

  useEffect(() => {
    if (!auditRecordId) { setDetail(undefined); setDetailState('ready'); return; }
    const controller = new AbortController();
    setDetailState('loading');
    void getAuditRecord(auditRecordId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setDetail(value); setDetailState('ready'); setDetailError(undefined); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setDetailError(reason); setDetailState('error'); } });
    return () => controller.abort();
  }, [auditRecordId, reload]);

  useEffect(() => {
    setSearchDraft(params.get('search') ?? ''); setActorDraft(params.get('actorKind') ?? 'all'); setActorIdDraft(params.get('actorId') ?? ''); setActionDraft(params.get('action') ?? '');
    setResourceKindDraft(params.get('resourceKind') ?? ''); setResourceIdDraft(params.get('resourceId') ?? '');
    setFromDraft(params.get('from') ? localDateTime(params.get('from')!) : ''); setToDraft(params.get('to') ? localDateTime(params.get('to')!) : '');
  }, [params]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams(params);
    for (const key of ['cursor', 'back']) next.delete(key);
    const setOrDelete = (key: string, value: string) => value && value !== 'all' ? next.set(key, value) : next.delete(key);
    setOrDelete('search', searchDraft.trim()); setOrDelete('actorKind', actorDraft); setOrDelete('actorId', actorIdDraft.trim()); setOrDelete('action', actionDraft.trim());
    setOrDelete('resourceKind', resourceKindDraft.trim()); setOrDelete('resourceId', resourceIdDraft.trim());
    setOrDelete('from', serverDateTime(fromDraft)); setOrDelete('to', serverDateTime(toDraft));
    setParams(next, { replace: true });
  }

  if (auditRecordId) {
    if (detailState === 'loading') return <div className="page-stack access-page"><AccessTabs active="audit" /><LoadingState label={t('access.auditDetailLoading')} /></div>;
    if (detailState === 'error' || !detail) { const copy = errorCopy(detailError, t('access.auditDetailLoadFailed'), t); return <div className="page-stack access-page"><AccessTabs active="audit" /><ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button><Link className="text-link" to={returnPath}>{t('access.auditBack')}</Link></ErrorState></div>; }
    return <div className="page-stack access-page"><AccessTabs active="audit" /><p className="access-back"><Link to={returnPath}><ArrowLeft aria-hidden="true" size={14} /> {t('access.auditBack')}</Link></p><PageTitle description={t('access.auditDetailDescription')} eyebrow={t('access.auditDetailEyebrow')} title={t('access.auditDetailTitle')} /><Surface className="audit-detail-card" variant="standard">
      <header><div><p className="eyebrow">{t('access.auditRecordEyebrow')}</p><h2><code>{detail.id}</code></h2></div><StatusChip state={detail.result}>{detail.result}</StatusChip></header>
      <dl className="audit-detail-grid"><div><dt>{t('access.auditTime')}</dt><dd><time dateTime={detail.time}>{formatDate(detail.time)}</time></dd></div><div><dt>{t('access.auditActor')}</dt><dd>{detail.actor.kind} · <code>{detail.actor.id}</code></dd></div><div><dt>{t('access.auditAction')}</dt><dd><code>{detail.action}</code></dd></div><div><dt>{t('access.auditResult')}</dt><dd>{detail.result}</dd></div>{detail.requestId && <div><dt>{t('access.auditRequest')}</dt><dd><Link className="text-link" to={`/requests/${encodeURIComponent(detail.requestId)}?from=${encodeURIComponent(`/access/audit/${detail.id}`)}`}>{detail.requestId}</Link></dd></div>}</dl>
      <section className="audit-resource"><h3>{t('access.auditResource')}</h3><pre><code>{JSON.stringify(safeAuditValue(detail.resource), null, 2)}</code></pre></section>
    </Surface></div>;
  }

  const pageCursors = params.getAll('back');
  function nextPage() { if (!nextCursor) return; const next = new URLSearchParams(params); next.append('back', cursor ?? ''); next.set('cursor', nextCursor); setParams(next); }
  function previousPage() { if (!pageCursors.length) return; const next = new URLSearchParams(params); next.delete('back'); pageCursors.slice(0, -1).forEach((item) => next.append('back', item)); const previous = pageCursors.at(-1); if (previous) next.set('cursor', previous); else next.delete('cursor'); setParams(next); }

  return <div className="page-stack access-page">
    <PageTitle description={t('access.auditDescription')} eyebrow={t('access.auditEyebrow')} title={t('access.auditTitle')} />
    <AccessTabs active="audit" />
    <form className="audit-filters" onSubmit={submitFilters}>
      <FormField htmlFor="audit-search" label={t('access.auditSearch')}><input id="audit-search" onChange={(event) => setSearchDraft(event.target.value)} placeholder={t('access.auditSearchPlaceholder')} value={searchDraft} /></FormField>
      <FormField htmlFor="audit-actor" label={t('access.auditActor')}><select id="audit-actor" onChange={(event) => setActorDraft(event.target.value)} value={actorDraft}><option value="all">{t('access.auditAllActors')}</option><option value="owner">{t('access.auditActorOwner')}</option><option value="serviceAccount">{t('access.auditActorServiceAccount')}</option></select></FormField>
      <FormField htmlFor="audit-actor-id" label={t('access.auditActorId')}><input id="audit-actor-id" onChange={(event) => setActorIdDraft(event.target.value)} value={actorIdDraft} /></FormField>
      <FormField htmlFor="audit-action" hint={t('access.auditActionHint')} label={t('access.auditAction')}><input id="audit-action" onChange={(event) => setActionDraft(event.target.value)} placeholder="serviceAccount.created" value={actionDraft} /></FormField>
      <FormField htmlFor="audit-resource-kind" label={t('access.auditResourceType')}><input id="audit-resource-kind" onChange={(event) => setResourceKindDraft(event.target.value)} value={resourceKindDraft} /></FormField>
      <FormField htmlFor="audit-resource-id" label={t('access.auditResourceId')}><input id="audit-resource-id" onChange={(event) => setResourceIdDraft(event.target.value)} value={resourceIdDraft} /></FormField>
      <FormField htmlFor="audit-from" label={t('access.auditFrom')}><input id="audit-from" onChange={(event) => setFromDraft(event.target.value)} type="datetime-local" value={fromDraft} /></FormField>
      <FormField htmlFor="audit-to" label={t('access.auditTo')}><input id="audit-to" onChange={(event) => setToDraft(event.target.value)} type="datetime-local" value={toDraft} /></FormField>
      <Button type="submit" variant="primary">{t('access.auditApplyFilters')}</Button>
    </form>
    <p className="audit-filter-note">{t('access.auditFilterNote')}</p>
    {state === 'loading' && <LoadingState label={t('access.auditLoading')} />}
    {state === 'error' && (() => { const copy = errorCopy(error, t('access.auditLoadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></ErrorState>; })()}
    {state === 'ready' && (!records.length ? <EmptyState title={t('access.auditEmptyTitle')} description={t('access.auditEmptyDescription')} /> : <div className="table-scroll"><table className="data-table"><caption>{t('access.auditCaption')}</caption><thead><tr><th scope="col">{t('access.auditColumnTime')}</th><th scope="col">{t('access.auditColumnActor')}</th><th scope="col">{t('access.auditColumnAction')}</th><th scope="col">{t('access.auditColumnResource')}</th><th scope="col">{t('access.auditColumnResult')}</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td><Link className="text-link" to={`/access/audit/${encodeURIComponent(record.id)}?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`}><time dateTime={record.time}>{formatDate(record.time)}</time></Link></td><td>{record.actor.kind}<small><code>{record.actor.id}</code></small></td><td><code>{record.action}</code></td><td><code>{JSON.stringify(safeAuditValue(record.resource))}</code></td><td><StatusChip state={record.result}>{record.result}</StatusChip></td></tr>)}</tbody></table></div>)}
    {state === 'ready' && records.length > 0 && <nav aria-label={t('access.auditPagesLabel')} className="access-pagination"><Button disabled={!pageCursors.length} onClick={previousPage} size="small"><ArrowLeft aria-hidden="true" size={14} /> {t('access.previous')}</Button><span>{t('access.auditPerPage')}</span><Button disabled={!nextCursor} onClick={nextPage} size="small">{t('access.next')} <ArrowRight aria-hidden="true" size={14} /></Button></nav>}
  </div>;
}
