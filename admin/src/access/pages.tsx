import { TabContent } from '../components/tab-content';
import { SearchInput } from '@/components/ui/search-input';
import { Input, Textarea } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, KeyRound, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiClientError } from '../api/client';
import { AdministratorsPage } from '../administrators/pages';
import { useOwnerSession } from '../auth/owner-session';
import { Button } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { FormField } from '../components/form-field';
import { Dialog } from '../components/overlays';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { mapLegacyPath } from '../route-map';
import { ApplicationAuthPanel } from './auth-panel';
import {
  createAPIKey, createServiceAccount, getAuditRecord, getServiceAccount, listAPIKeys, listAuditRecords, listServiceAccounts,
  revokeAPIKey, setServiceAccountEnabled, updateServiceAccount,
  type APIKey, type APIKeyReveal, type AuditRecord, type CustomPermissionOperation, type PermissionPreset, type ServiceAccount,
} from './client';

const advancedAuditFilters = ['actorId', 'resourceKind', 'resourceId', 'from', 'to'] as const;

type Translate = ReturnType<typeof useI18n>['t'];

function accessStatusLabel(status: string, t: Translate): string {
  return status === 'active' || status === 'disabled' || status === 'revoked'
    ? t(`access.statuses.${status}` as TranslationKey)
    : status;
}

function auditActorLabel(kind: string, t: Translate): string {
  if (kind === 'owner') return t('access.auditActorOwner');
  if (kind === 'serviceAccount') return t('access.auditActorServiceAccount');
  return kind;
}

function auditResultLabel(result: string, t: Translate): string {
  if (result === 'success' || result === 'denied' || result === 'failure') {
    return t(`access.auditResults.${result}` as TranslationKey);
  }
  return result;
}

const operationGroups: Array<{ labelKey: TranslationKey; operations: CustomPermissionOperation[] }> = [
  { labelKey: 'access.permissionGroups.runtime', operations: ['runtime.read', 'storage.read'] },
  { labelKey: 'access.permissionGroups.collections', operations: ['collections.read', 'collections.create', 'records.read', 'records.create', 'records.update', 'records.delete', 'files.read', 'files.write'] },
  { labelKey: 'access.permissionGroups.model', operations: ['schema.read', 'schema.write', 'schema.apply', 'accessRules.read', 'accessRules.write', 'accessRules.apply', 'authentication.read', 'authentication.write', 'authentication.apply'] },
  { labelKey: 'access.permissionGroups.users', operations: ['users.read', 'users.create', 'users.managePassword', 'sessions.read', 'sessions.revoke'] },
  { labelKey: 'access.permissionGroups.access', operations: ['serviceAccounts.read', 'serviceAccounts.manage', 'apiKeys.read', 'apiKeys.create', 'apiKeys.revoke', 'requests.read', 'audit.read'] },
];

function errorCopy(error: unknown, fallback: string, t: Translate) {
  if (error instanceof ApiClientError) {
    const messageKey: Record<string, TranslationKey> = {
      UNAUTHENTICATED: 'errors.unauthenticated', UNAUTHORIZED: 'errors.unauthenticated',
      AUTHORIZATION_DENIED: 'errors.authorizationDenied', FORBIDDEN: 'errors.authorizationDenied',
      NOT_FOUND: 'errors.notFound', VALIDATION_FAILED: 'errors.validationFailed',
    };
    const localizedMessageKey = messageKey[error.apiError.code];
    return {
      title: localizedMessageKey ? t(localizedMessageKey) : fallback,
      detail: [`${t('common.errorCode')}: ${error.apiError.code}`, `${t('common.requestId')}: ${error.apiError.requestId}`].join(' · '),
    };
  }
  return { title: fallback, detail: t('common.tryAgainWhenAvailable') };
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
  return <div aria-label={t('access.customPermissionsLabel')} className="grid gap-2">
    <p className="m-0 text-[11px] text-muted-foreground">{t('access.customPermissionsDescription')}</p>
    <div className="grid max-h-80 grid-cols-1 gap-2 overflow-auto min-[561px]:grid-cols-2">{operationGroups.map((group) => <fieldset className="grid min-w-0 content-start gap-1.5 rounded-lg border p-2.5" key={group.labelKey}>
      <legend className="px-1 text-[11px] font-semibold text-ink-secondary">{t(group.labelKey)}</legend>
      {group.operations.map((operation) => <Label className="flex items-center gap-2 text-xs text-ink-secondary" key={operation}><Checkbox checked={selected.includes(operation)} onCheckedChange={(checked) => toggle(operation, checked)}  value={operation} /><code className="font-mono text-[11px]">{operation}</code></Label>)}
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

  return <form className="grid gap-4" data-access-form onSubmit={(event) => void submit(event)}>
    {error !== undefined && (() => { const copy = errorCopy(error, t('access.saveFailed'), t); return <ErrorState description={copy.detail} title={copy.title} />; })()}
    <FormField htmlFor="account-name" label={t('access.formName')}><Input autoComplete="off" id="account-name" maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></FormField>
    <FormField htmlFor="account-description" label={t('access.formDescription')}><Textarea id="account-description" maxLength={500} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} /></FormField>
    <FormField htmlFor="account-permission" hint={t('access.formPermissionHint')} label={t('access.formPermission')}>
      <SelectField id="account-permission" onValueChange={(selectedValue) => setPermission(selectedValue as PermissionPreset)} value={permission} options={[({ value: "fullAccess", label: t('access.permissions.fullAccess') }), ({ value: "readOnly", label: t('access.permissions.readOnly') }), ({ value: "custom", label: t('access.permissions.custom') })]} />
    </FormField>
    {permission === 'custom' && <PermissionFields onChange={setCustomOperations} selected={customOperations} />}
    {creating && <Label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-input bg-secondary p-3" data-access-create-key><Checkbox checked={createKey} className="mt-0.5" onCheckedChange={(checked) => setCreateKey(checked)} /><span className="grid gap-0.5"><strong className="text-xs font-semibold text-ink-secondary">{t('access.createKey')}</strong><small className="text-[11px] text-muted-foreground">{t('access.createKeyHint')}</small></span></Label>}
    {validation && <p className="m-0 text-[11px] font-semibold text-danger" role="alert">{t(validation)}</p>}
    <div className="flex flex-wrap items-center gap-1.5"><Button disabled={busy} type="submit" variant="primary">{busy ? t('access.saving') : creating ? t('access.create') : t('access.save')}</Button><Button disabled={busy} onClick={onCancel} type="button">{t('common.cancel')}</Button></div>
  </form>;
}

function OneTimeReveal({ value, onDone }: { value: APIKeyReveal | null; onDone: () => void }) {
  const { t } = useI18n();
  return <Dialog closeLabel={t('common.closeDialog')} open={Boolean(value)} onClose={onDone} size="wide" title={t('access.revealTitle')}>
    {value && <div className="grid gap-3">
      <p className="m-0 text-xs text-warning" role="status">{t('access.revealDescription')}</p>
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted px-3 py-2.5" data-access-reveal-secret><code className="min-w-0 select-all break-words font-mono text-xs text-ink-secondary">{value.secret}</code><CopyButton label={t('access.revealCopy')} value={value.secret} /></div>
      <dl className="m-0 flex flex-wrap gap-x-8 gap-y-2"><div className="grid gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.revealKeyName')}</dt><dd className="m-0 text-xs text-ink-secondary">{value.apiKey.name}</dd></div><div className="grid gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.revealStatus')}</dt><dd className="m-0"><StatusChip state={value.apiKey.status}>{accessStatusLabel(value.apiKey.status, t)}</StatusChip></dd></div></dl>
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
    <p className="m-0 text-xs leading-relaxed text-ink-secondary">{description}</p>{error !== undefined && (() => { const copy = errorCopy(error, t('access.securityActionFailed'), t); return <ErrorState description={copy.detail} title={copy.title} />; })()}<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3.5"><Button disabled={busy} onClick={onConfirm} type="button" variant="danger">{busy ? t('access.saving') : confirmLabel}</Button><Button disabled={busy} onClick={onClose} type="button">{t('common.cancel')}</Button></div>
  </Dialog>;
}

type AccessTab = 'administrators' | 'auth' | 'tokens';

const accessTabOrder: readonly AccessTab[] = ['administrators', 'auth', 'tokens'];

const accessTabLabels: Record<AccessTab, TranslationKey> = {
  administrators: 'access.tabs.administrators',
  auth: 'access.tabs.auth',
  tokens: 'access.tabs.tokens',
};

function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className={action ? "flex min-w-0 flex-wrap items-center justify-end gap-3" : "sr-only"}><div className="sr-only"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{description}</p></div>{action}</header>;
}

// Spec 0001 §3.2、§11.1：`访问与认证` 的二级工作面固定为 管理员 / 应用认证 / API Tokens。
// 工作面状态存放在 URL 的 `?tab=`（§15，可分享、可刷新），未知值回落到默认的管理员。
// 集合级 Application Access Rules 仍留在具体 Collection 工作区，这里只做项目级身份与凭据；
// 管理面审计已归入 `活动记录`（§9.2），因此本页不再有指向审计的第二个入口。
export function AccessWorkspacePage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  // Spec 0001 §15：`account` / `cursor` 是 API Tokens 的 resource identity，
  // 未显式给出 tab 的旧深链接落到 tokens，避免丢掉用户要打开的服务账号。
  const activeTab: AccessTab = requestedTab === 'auth' || requestedTab === 'tokens'
    ? requestedTab
    : requestedTab === null && (searchParams.has('account') || searchParams.has('cursor')) ? 'tokens' : 'administrators';

  function tabTarget(tab: AccessTab): string {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    return `/access?${next.toString()}`;
  }

  return <div className="flex min-w-0 flex-col gap-6">
    <header className="sr-only">
      <p className="eyebrow">{t('access.eyebrow')}</p>
      <h1>{t('access.title')}</h1>
      <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('access.description')}</p>
    </header>

    <nav aria-label={t('access.tabsLabel')} className="flex flex-wrap items-center gap-1 overflow-x-auto border-b" data-access-workspace-tabs>
      {accessTabOrder.map((tab) => <Link
        aria-current={activeTab === tab ? 'page' : undefined}
        className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-none ${activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        key={tab}
        to={tabTarget(tab)}
      >{t(accessTabLabels[tab])}</Link>)}
    </nav>

    <TabContent activeKey={activeTab}>
    {activeTab === 'administrators' && <AdministratorsPage embedded />}
    {activeTab === 'auth' && <ApplicationAuthPanel />}
    {activeTab === 'tokens' && <AccessPage embedded />}
    </TabContent>
  </div>;
}

// embedded：作为 `/access?tab=tokens` 的内容渲染时不重复页面级标题（spec 0001 §3.2），
// 独立渲染仍保留自己的页面标题与主操作。
export function AccessPage({ embedded = false }: { embedded?: boolean }) {
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

  return <div className="flex min-w-0 flex-col gap-6">
    {embedded
      ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
        <div className="sr-only">
          <h2>{t('access.tokensTitle')}</h2>
          <p className="mt-1.5 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('access.tokensDescription')}</p>
        </div>
        {!accountId && <Button onClick={() => { setCreateOpen(true); setCreateError(undefined); }} variant="primary"><Plus aria-hidden="true" size={16} /> {t('access.create')}</Button>}
      </div>
      : <PageTitle action={!accountId ? <Button onClick={() => { setCreateOpen(true); setCreateError(undefined); }} variant="primary"><Plus aria-hidden="true" size={16} /> {t('access.create')}</Button> : undefined} description={t('access.description')} eyebrow={t('access.eyebrow')} title={t('access.title')} />}
    {ownerEmail && <Surface className="flex flex-wrap items-center gap-3 p-4" variant="standard"><span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ShieldCheck size={18} /></span><div className="grid min-w-0 flex-1 gap-0.5"><strong className="text-xs font-semibold text-foreground">{t('access.owner')}</strong><span className="truncate text-[11px] text-muted-foreground">{ownerEmail}</span></div><StatusChip state="full-access">{t('access.fullAccess')}</StatusChip></Surface>}
    {successMessage && <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status"><Check aria-hidden="true" className="shrink-0 text-success" size={15} />{t(successMessage)}</div>}
    {!accountId && <>
      {/* 作为 `/access?tab=tokens` 内容渲染时，工作面标题已经由 tokensTitle/tokensDescription 承担，
          这里不再重复同一段说明（spec 0001 §13.2、§17.4）。 */}
      {!embedded && <div className="flex flex-wrap items-end justify-between gap-3"><div className="flex items-center gap-2.5"><span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><KeyRound size={16} /></span><div><h2>{t('access.accountsTitle')}</h2><p className="text-xs text-muted-foreground">{t('access.accountsDescription')}</p></div></div></div>}
      {state === 'loading' && <LoadingState label={t('access.loading')} />}
      {state === 'error' && (() => { const copy = errorCopy(error, t('access.loadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => void refreshList()} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></ErrorState>; })()}
      {state === 'ready' && (!visibleAccounts.length ? <EmptyState title={t('access.emptyTitle')} description={t('access.emptyDescription')}><Button onClick={() => setCreateOpen(true)} variant="primary"><Plus aria-hidden="true" size={15} /> {t('access.create')}</Button></EmptyState> : <Table><TableCaption>{t('access.accountsTitle')}</TableCaption><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead scope="col">{t('access.columnName')}</TableHead><TableHead scope="col">{t('access.columnPermission')}</TableHead><TableHead scope="col">{t('access.columnStatus')}</TableHead><TableHead scope="col">{t('access.columnLastUsed')}</TableHead></TableRow></TableHeader><TableBody>{visibleAccounts.map((item) => <TableRow key={item.id}><TableCell><Link className="text-xs font-semibold text-primary hover:underline" to={`/access?tab=tokens&account=${encodeURIComponent(item.id)}`}>{item.name}</Link>{item.description && <small className="mt-0.5 block text-[11px] text-muted-foreground">{item.description}</small>}</TableCell><TableCell><PermissionLabel permission={item.permission} /></TableCell><TableCell><StatusChip state={item.status}>{accessStatusLabel(item.status, t)}</StatusChip></TableCell><TableCell>{item.lastUsedAt ? <time dateTime={item.lastUsedAt}>{formatDate(item.lastUsedAt)}</time> : t('access.never')}</TableCell></TableRow>)}</TableBody></Table>)}
      {state === 'ready' && visibleAccounts.length > 0 && <nav aria-label={t('access.pagesLabel')} className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><Button disabled={!pageCursors.length} onClick={previousAccounts} size="small"><ArrowLeft aria-hidden="true" size={14} /> {t('access.previous')}</Button><span>{t('access.perPage')}</span><Button disabled={!cursor} onClick={nextAccounts} size="small">{t('access.next')} <ArrowRight aria-hidden="true" size={14} /></Button></nav>}
    </>}
    {accountId && <ServiceAccountDetail account={account} keys={keys} state={detailState} error={detailError} keyError={keyError} keyName={keyName} onKeyName={setKeyName} onCreateKey={makeKey} keyBusy={keyBusy} onEdit={() => { setEditOpen(true); setEditError(undefined); }} onDisable={() => setDanger({ kind: 'disable' })} onEnable={() => void enableAccount()} onRevoke={(key) => setDanger({ kind: 'revoke', key })} busy={dangerBusy} onRetry={() => setDetailReload((value) => value + 1)} />}
    {createOpen && <Dialog closeLabel={t('common.closeDialog')} onClose={() => { if (!createBusy) setCreateOpen(false); }} open title={t('access.createTitle')}><AccountForm busy={createBusy} creating error={createError} onCancel={() => setCreateOpen(false)} onSubmit={submitCreate} /></Dialog>}
    {editOpen && account && <Dialog closeLabel={t('common.closeDialog')} onClose={() => { if (!editBusy) setEditOpen(false); }} open title={t('access.editTitle')}><AccountForm busy={editBusy} creating={false} error={editError} initial={account} onCancel={() => setEditOpen(false)} onSubmit={(draft) => submitEdit(draft)} /></Dialog>}
    {reveal?.accountId === accountId && <OneTimeReveal onDone={closeReveal} value={reveal.key} />}
    {danger && <DangerDialog busy={dangerBusy} confirmLabel={danger.kind === 'disable' ? t('access.disableConfirm') : t('access.revokeConfirm')} description={danger.kind === 'disable' ? t('access.disableBody') : t('access.revokeBody', { name: danger.kind === 'revoke' ? danger.key.name : '' })} error={dangerError} onClose={() => { if (!dangerBusy) { setDanger(null); setDangerError(undefined); } }} onConfirm={() => void confirmDanger()} open title={danger.kind === 'disable' ? t('access.disableTitle') : t('access.revokeTitle')} />}
    {dangerError !== undefined && !danger && <ErrorState className="mt-3" description={errorCopy(dangerError, t('access.securityActionFailed'), t).detail} title={errorCopy(dangerError, t('access.securityActionFailed'), t).title} />}
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
  if (state === 'error' || !account) { const copy = errorCopy(error, t('access.detailLoadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><div className="mt-3 flex flex-wrap items-center gap-3"><Button onClick={onRetry} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button><Link className="text-xs font-semibold text-primary hover:underline" to="/access?tab=tokens">{t('access.backToAccess')}</Link></div></ErrorState>; }
  return <section aria-label={t('access.detailLabel')} className="flex min-w-0 flex-col gap-4">
    <p className="m-0"><Link className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground" to="/access?tab=tokens"><ArrowLeft aria-hidden="true" size={14} /> {t('access.backToAccess')}</Link></p>
    <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
      <header className="flex flex-wrap items-center gap-3 border-b pb-3"><div className="min-w-0 flex-1"><p className="eyebrow">{t('access.detailEyebrow')}</p><h2 className="mt-0.5 break-words">{account.name}</h2><p className="mt-1 text-xs text-muted-foreground">{account.description || t('access.noDescription')}</p></div><StatusChip state={account.status}>{accessStatusLabel(account.status, t)}</StatusChip><Button onClick={onEdit} size="small">{t('access.edit')}</Button>{account.status === 'active' ? <Button disabled={busy} onClick={onDisable} size="small" variant="danger">{t('access.disable')}</Button> : <Button disabled={busy} onClick={onEnable} size="small" variant="primary">{t('access.enable')}</Button>}</header>
      <dl className="m-0 flex flex-wrap gap-x-8 gap-y-3"><div className="grid gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.detailPermission')}</dt><dd className="m-0 text-xs text-ink-secondary"><PermissionLabel permission={account.permission} /></dd></div><div className="grid gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.detailCreated')}</dt><dd className="m-0 text-xs text-ink-secondary">{account.createdAt ? <time dateTime={account.createdAt}>{formatDate(account.createdAt)}</time> : '—'}</dd></div><div className="grid gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.detailLastUsed')}</dt><dd className="m-0 text-xs text-ink-secondary">{account.lastUsedAt ? <time dateTime={account.lastUsedAt}>{formatDate(account.lastUsedAt)}</time> : t('access.never')}</dd></div></dl>
      {account.permission === 'custom' && <div className="grid gap-2 border-t pt-3"><strong className="text-xs font-semibold text-ink-secondary">{t('access.customSummary', { version: account.customPermissionVersion ?? 1 })}</strong><ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">{(account.customOperations ?? []).map((operation) => <li className="rounded-md border bg-muted px-1.5 py-1" key={operation}><code className="font-mono text-[11px]">{operation}</code></li>)}</ul></div>}
    </Surface>
    <Surface className="flex min-w-0 flex-col gap-3 p-4" variant="standard"><header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3>{t('access.keysTitle')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('access.keysDescription')}</p></div><form className="flex w-full items-center gap-1.5 min-[561px]:w-auto" onSubmit={onCreateKey}><Label className="sr-only" htmlFor="new-key-name">{t('access.newKeyName')}</Label><Input className="min-[561px]:w-48" id="new-key-name" autoComplete="off" maxLength={80} onChange={(event) => onKeyName(event.target.value)} placeholder={t('access.keyNamePlaceholder')} value={keyName} /><Button disabled={keyBusy || account.status === 'disabled'} size="small" type="submit" variant="primary"><Plus aria-hidden="true" size={14} /> {t('access.createKeyAction')}</Button></form></header>
      {keyError !== undefined && (() => { const copy = errorCopy(keyError, t('access.keysLoadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={onRetry} size="small">{t('common.retry')}</Button></ErrorState>; })()}
      {keyError === undefined && !keys.length ? <EmptyState title={t('access.noKeysTitle')} description={t('access.noKeysDescription')} /> : keyError === undefined && <Table><TableCaption>{t('access.keysCaption')}</TableCaption><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead scope="col">{t('access.columnName')}</TableHead><TableHead scope="col">{t('access.columnCreated')}</TableHead><TableHead scope="col">{t('access.columnLastUsed')}</TableHead><TableHead scope="col">{t('access.columnStatus')}</TableHead><TableHead scope="col">{t('access.columnAction')}</TableHead></TableRow></TableHeader><TableBody>{keys.map((key) => <TableRow key={key.id}><TableCell>{key.name}</TableCell><TableCell><time dateTime={key.createdAt}>{formatDate(key.createdAt)}</time></TableCell><TableCell>{key.lastUsedAt ? <time dateTime={key.lastUsedAt}>{formatDate(key.lastUsedAt)}</time> : t('access.never')}</TableCell><TableCell><StatusChip state={key.status}>{accessStatusLabel(key.status, t)}</StatusChip></TableCell><TableCell>{key.status === 'active' ? <Button disabled={busy} onClick={() => onRevoke(key)} size="small" variant="danger">{t('access.revoke')}</Button> : '—'}</TableCell></TableRow>)}</TableBody></Table>}
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

// embedded：作为 `活动记录`（source=audit）的内容渲染时不重复页面级标题（spec 0001 §3.2、§9.2），
// 独立渲染（审计详情深链接落地）仍保留自己的页面标题。
export function AuditPage({ embedded = false }: { embedded?: boolean }) {
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
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(() => advancedAuditFilters.some((key) => Boolean(params.get(key))));
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');
  const [actorDraft, setActorDraft] = useState(params.get('actorKind') ?? 'all');
  const [actorIdDraft, setActorIdDraft] = useState(params.get('actorId') ?? '');
  const [actionDraft, setActionDraft] = useState(params.get('action') ?? '');
  const [resourceKindDraft, setResourceKindDraft] = useState(params.get('resourceKind') ?? '');
  const [resourceIdDraft, setResourceIdDraft] = useState(params.get('resourceId') ?? '');
  const [fromDraft, setFromDraft] = useState(params.get('from') ? localDateTime(params.get('from')!) : '');
  const [toDraft, setToDraft] = useState(params.get('to') ? localDateTime(params.get('to')!) : '');
  const cursor = params.get('cursor') ?? undefined;
  // 返回路径只接受活动记录内部的来源；旧 `/access/audit` 深链接经 route-map 归一到新导航（spec 0001 §15）。
  const returnPath = useMemo(() => {
    const value = params.get('from');
    const fallback = '/activity?source=audit';
    if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
    const queryIndex = value.indexOf('?');
    const mapped = mapLegacyPath(queryIndex >= 0 ? value.slice(0, queryIndex) : value, queryIndex >= 0 ? value.slice(queryIndex) : '');
    const candidate = mapped === null ? value : `${mapped.pathname}${mapped.search}`;
    return candidate === '/activity' || candidate.startsWith('/activity?') || candidate.startsWith('/activity/audit') ? candidate : fallback;
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
    if (advancedAuditFilters.some((key) => Boolean(params.get(key)))) setMoreFiltersOpen(true);
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
    if (detailState === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('access.auditDetailLoading')} /></div>;
    if (detailState === 'error' || !detail) { const copy = errorCopy(detailError, t('access.auditDetailLoadFailed'), t); return <div className="flex min-w-0 flex-col gap-6"><ErrorState description={copy.detail} title={copy.title}><div className="mt-3 flex flex-wrap items-center gap-3"><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button><Link className="text-xs font-semibold text-primary hover:underline" to={returnPath}>{t('access.auditBack')}</Link></div></ErrorState></div>; }
    return <div className="flex min-w-0 flex-col gap-6"><p className="m-0"><Link className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground" to={returnPath}><ArrowLeft aria-hidden="true" size={14} /> {t('access.auditBack')}</Link></p>{!embedded && <PageTitle description={t('access.auditDetailDescription')} eyebrow={t('access.auditDetailEyebrow')} title={t('access.auditDetailTitle')} />}<Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
      <header className="flex flex-wrap items-center gap-3 border-b pb-3"><div className="min-w-0 flex-1"><p className="eyebrow">{t('access.auditRecordEyebrow')}</p><h2 className="mt-0.5 break-words"><code className="font-mono text-sm">{detail.id}</code></h2></div><StatusChip state={detail.result}>{auditResultLabel(detail.result, t)}</StatusChip></header>
      <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 min-[701px]:grid-cols-2" data-audit-detail-grid><div className="grid min-w-0 gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.auditTime')}</dt><dd className="m-0 break-words text-xs text-ink-secondary"><time dateTime={detail.time}>{formatDate(detail.time)}</time></dd></div><div className="grid min-w-0 gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.auditActor')}</dt><dd className="m-0 break-words text-xs text-ink-secondary">{auditActorLabel(detail.actor.kind, t)} · <code className="font-mono text-[11px]">{detail.actor.id}</code></dd></div><div className="grid min-w-0 gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.auditAction')}</dt><dd className="m-0 break-words text-xs text-ink-secondary"><code className="font-mono text-[11px]">{detail.action}</code></dd></div><div className="grid min-w-0 gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.auditResult')}</dt><dd className="m-0 break-words text-xs text-ink-secondary">{auditResultLabel(detail.result, t)}</dd></div>{detail.requestId && <div className="grid min-w-0 gap-0.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('access.auditRequest')}</dt><dd className="m-0 break-words text-xs text-ink-secondary"><Link className="text-xs font-semibold text-primary hover:underline" to={`/requests/${encodeURIComponent(detail.requestId)}?from=${encodeURIComponent(`/activity/audit/${detail.id}`)}`}>{detail.requestId}</Link></dd></div>}</dl>
      <section className="border-t pt-3" data-audit-resource><h3 className="m-0 mb-1.5">{t('access.auditResource')}</h3><pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted p-3 font-mono text-[11px] leading-relaxed text-ink-secondary"><code>{JSON.stringify(safeAuditValue(detail.resource), null, 2)}</code></pre></section>
    </Surface></div>;
  }

  const pageCursors = params.getAll('back');
  function nextPage() { if (!nextCursor) return; const next = new URLSearchParams(params); next.append('back', cursor ?? ''); next.set('cursor', nextCursor); setParams(next); }
  function previousPage() { if (!pageCursors.length) return; const next = new URLSearchParams(params); next.delete('back'); pageCursors.slice(0, -1).forEach((item) => next.append('back', item)); const previous = pageCursors.at(-1); if (previous) next.set('cursor', previous); else next.delete('cursor'); setParams(next); }

  return <div className="flex min-w-0 flex-col gap-6">
    {!embedded && <PageTitle description={t('access.auditDescription')} eyebrow={t('access.auditEyebrow')} title={t('access.auditTitle')} />}
    <form className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3" onSubmit={submitFilters}>
      <div className="grid min-w-0 items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(200px,1fr)_180px_220px_auto]">
        <FormField htmlFor="audit-search" label={t('access.auditSearch')}><SearchInput id="audit-search" onChange={(event) => setSearchDraft(event.target.value)} placeholder={t('access.auditSearchPlaceholder')} value={searchDraft} /></FormField>
        <FormField htmlFor="audit-actor" label={t('access.auditActor')}><SelectField id="audit-actor" onValueChange={(selectedValue) => setActorDraft(selectedValue)} value={actorDraft} options={[({ value: "all", label: t('access.auditAllActors') }), ({ value: "owner", label: t('access.auditActorOwner') }), ({ value: "serviceAccount", label: t('access.auditActorServiceAccount') })]} /></FormField>
        <FormField htmlFor="audit-action" label={t('access.auditAction')}><Input aria-describedby="audit-action-note" id="audit-action" onChange={(event) => setActionDraft(event.target.value)} placeholder="serviceAccount.created" value={actionDraft} /></FormField>
        <div className="flex items-center justify-end gap-2">
          <Button aria-controls="audit-more-filters" aria-expanded={moreFiltersOpen} onClick={() => setMoreFiltersOpen((value) => !value)} type="button" variant="secondary"><ChevronDown aria-hidden="true" className={moreFiltersOpen ? 'rotate-180' : ''} size={14} />{t('access.auditMoreFilters')}</Button>
          <Button type="submit" variant="primary">{t('access.auditApplyFilters')}</Button>
        </div>
      </div>
      <p className="sr-only" id="audit-action-note">{t('access.auditActionHint')}</p>
      {moreFiltersOpen && <div className="flex min-w-0 flex-col gap-3 border-t pt-3" id="audit-more-filters">
        <div className="grid min-w-0 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField htmlFor="audit-actor-id" label={t('access.auditActorId')}><Input id="audit-actor-id" onChange={(event) => setActorIdDraft(event.target.value)} value={actorIdDraft} /></FormField>
          <FormField htmlFor="audit-resource-kind" label={t('access.auditResourceType')}><Input id="audit-resource-kind" onChange={(event) => setResourceKindDraft(event.target.value)} value={resourceKindDraft} /></FormField>
          <FormField htmlFor="audit-resource-id" label={t('access.auditResourceId')}><Input id="audit-resource-id" onChange={(event) => setResourceIdDraft(event.target.value)} value={resourceIdDraft} /></FormField>
          <FormField htmlFor="audit-from" label={t('access.auditFrom')}><Input id="audit-from" onChange={(event) => setFromDraft(event.target.value)} type="datetime-local" value={fromDraft} /></FormField>
          <FormField htmlFor="audit-to" label={t('access.auditTo')}><Input id="audit-to" onChange={(event) => setToDraft(event.target.value)} type="datetime-local" value={toDraft} /></FormField>
        </div>
        <p className="m-0 text-[11px] text-muted-foreground">{t('access.auditActionHint')} {t('access.auditFilterNote')}</p>
      </div>}
    </form>
    {state === 'loading' && <LoadingState label={t('access.auditLoading')} />}
    {state === 'error' && (() => { const copy = errorCopy(error, t('access.auditLoadFailed'), t); return <ErrorState description={copy.detail} title={copy.title}><Button onClick={() => setReload((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></ErrorState>; })()}
    {state === 'ready' && (!records.length ? <EmptyState title={t('access.auditEmptyTitle')} description={t('access.auditEmptyDescription')} /> : <Table data-audit-table><TableCaption>{t('access.auditCaption')}</TableCaption><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead scope="col">{t('access.auditColumnTime')}</TableHead><TableHead scope="col">{t('access.auditColumnActor')}</TableHead><TableHead scope="col">{t('access.auditColumnAction')}</TableHead><TableHead scope="col">{t('access.auditColumnResource')}</TableHead><TableHead scope="col">{t('access.auditColumnResult')}</TableHead></TableRow></TableHeader><TableBody>{records.map((record) => <TableRow key={record.id}><TableCell><Link className="text-xs font-semibold text-primary hover:underline" to={`/activity/audit/${encodeURIComponent(record.id)}?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`}><time dateTime={record.time}>{formatDate(record.time)}</time></Link></TableCell><TableCell>{auditActorLabel(record.actor.kind, t)}<small className="mt-0.5 block text-[11px] text-muted-foreground"><code className="font-mono text-[11px]">{record.actor.id}</code></small></TableCell><TableCell><code className="font-mono text-[11px]">{record.action}</code></TableCell><TableCell className="max-w-[280px]"><code className="break-words font-mono text-[11px]">{JSON.stringify(safeAuditValue(record.resource))}</code></TableCell><TableCell><StatusChip state={record.result}>{auditResultLabel(record.result, t)}</StatusChip></TableCell></TableRow>)}</TableBody></Table>)}
    {state === 'ready' && records.length > 0 && <nav aria-label={t('access.auditPagesLabel')} className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><Button disabled={!pageCursors.length} onClick={previousPage} size="small"><ArrowLeft aria-hidden="true" size={14} /> {t('access.previous')}</Button><span>{t('access.auditPerPage')}</span><Button disabled={!nextCursor} onClick={nextPage} size="small">{t('access.next')} <ArrowRight aria-hidden="true" size={14} /></Button></nav>}
  </div>;
}
