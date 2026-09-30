import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { Dialog } from '../components/overlays';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import {
  administratorOperations, createAdministrator, deleteAdministrator, listAdministratorSessions,
  listAdministrators, revokeAdministratorSessions, setAdministratorEnabled, setAdministratorPassword,
  type Administrator, type AdministratorPermission, type AdministratorSession, type PermissionPreset,
} from './client';

type LoadState = 'loading' | 'error' | 'ready';

function emptyPermission(): AdministratorPermission {
  return { preset: 'readOnly' };
}

function permissionLabelKey(preset: PermissionPreset): TranslationKey {
  switch (preset) {
    case 'fullAccess': return 'administrators.create.presets.fullAccess';
    case 'custom': return 'administrators.create.presets.custom';
    default: return 'administrators.create.presets.readOnly';
  }
}

function actionMessage(error: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (!(error instanceof ApiClientError)) return t('administrators.errors.unexpected');
  switch (error.apiError.code) {
    case 'CONFLICT': return t('administrators.errors.conflict');
    case 'FORBIDDEN': return t('administrators.errors.forbidden');
    case 'NOT_FOUND': return t('administrators.errors.notFound');
    case 'INVALID_ARGUMENT': return t('administrators.errors.invalidArgument');
    case 'VALIDATION_FAILED': return t('administrators.errors.validationFailed');
    case 'UNAUTHENTICATED': return t('administrators.errors.unauthenticated');
    default: return t('administrators.errors.unexpected');
  }
}

export function AdministratorsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [administrators, setAdministrators] = useState<Administrator[]>([]);
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createPermission, setCreatePermission] = useState<AdministratorPermission>(emptyPermission);
  const [passwordTarget, setPasswordTarget] = useState<Administrator | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [sessionsTarget, setSessionsTarget] = useState<Administrator | null>(null);
  const [sessions, setSessions] = useState<AdministratorSession[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Administrator | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    listAdministrators(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setAdministrators(value);
        setState('ready');
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setActionError(reason);
        setState('error');
      },
    );
    return () => controller.abort();
  }, [generation]);

  const refresh = useCallback(() => { setNotice(null); setActionError(undefined); setGeneration((value) => value + 1); }, []);

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'surface.administrators',
      category: 'commands.categories.system',
      label: () => t('commands.administrators'),
      keywords: () => [t('administrators.searchKeywords')],
      execute: () => navigate('/administrators'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  async function create() {
    setBusy('create');
    setActionError(undefined);
    try {
      const created = await createAdministrator({ email: createEmail, password: createPassword, permission: normalizePermission(createPermission) });
      setAdministrators((current) => [...current, created]);
      setCreateOpen(false);
      setCreateEmail('');
      setCreatePassword('');
      setCreatePermission(emptyPermission());
      setNotice(t('administrators.notices.created'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled(administrator: Administrator) {
    setBusy(administrator.id);
    setActionError(undefined);
    try {
      const updated = await setAdministratorEnabled(administrator.id, administrator.status !== 'active');
      setAdministrators((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(updated.status === 'active' ? t('administrators.notices.enabled') : t('administrators.notices.disabled'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function savePassword() {
    if (!passwordTarget) return;
    setBusy('password');
    setActionError(undefined);
    try {
      await setAdministratorPassword(passwordTarget.id, newPassword);
      setPasswordTarget(null);
      setNewPassword('');
      setNotice(t('administrators.notices.passwordSet'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function openSessions(administrator: Administrator) {
    setSessionsTarget(administrator);
    setSessions([]);
    setActionError(undefined);
    try {
      setSessions(await listAdministratorSessions(administrator.id));
    } catch (reason) {
      setActionError(reason);
    }
  }

  async function revokeSessions() {
    if (!sessionsTarget) return;
    setBusy('sessions');
    setActionError(undefined);
    try {
      await revokeAdministratorSessions(sessionsTarget.id);
      setSessions(await listAdministratorSessions(sessionsTarget.id));
      setNotice(t('administrators.notices.sessionsRevoked'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy('delete');
    setActionError(undefined);
    try {
      await deleteAdministrator(deleteTarget.id);
      setAdministrators((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      setNotice(t('administrators.notices.deleted'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('administrators.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('administrators.loadFailedDescription')} title={t('administrators.loadFailed')}>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('administrators.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{t('administrators.eyebrow')}</p>
          <h1>{t('administrators.title')}</h1>
          <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('administrators.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setCreateOpen(true)} size="small" type="button" variant="primary">
            <UserPlus aria-hidden="true" size={14} /> {t('administrators.createAction')}
          </Button>
          <Button disabled={busy !== null} onClick={refresh} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> {t('administrators.refresh')}
          </Button>
        </div>
      </header>

      <Surface className="flex min-w-0 flex-col gap-3 p-4" variant="standard">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ShieldCheck size={17} /></span>
          <div className="min-w-0">
            <p className="eyebrow">{t('administrators.list.eyebrow')}</p>
            <h2>{t('administrators.list.title')}</h2>
          </div>
        </div>
        <p className="m-0 text-xs leading-relaxed text-ink-secondary">{t('administrators.list.description')}</p>
        {administrators.length === 0
          ? <EmptyState description={t('administrators.empty.description')} title={t('administrators.empty.title')} />
          : (
            <Table>
              <TableCaption>{t('administrators.list.caption')}</TableCaption>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead scope="col">{t('administrators.columns.email')}</TableHead>
                  <TableHead scope="col">{t('administrators.columns.permission')}</TableHead>
                  <TableHead scope="col">{t('administrators.columns.status')}</TableHead>
                  <TableHead scope="col">{t('administrators.columns.lastSignIn')}</TableHead>
                  <TableHead scope="col">{t('administrators.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {administrators.map((item) => (
                  <TableRow data-administrator-email={item.email} key={item.id}>
                    <TableCell><span className="break-words font-semibold text-foreground">{item.email}</span></TableCell>
                    <TableCell>
                      <StatusChip state={item.permission.preset === 'readOnly' ? 'degraded' : 'ready'}>
                        {t(permissionLabelKey(item.permission.preset))}
                      </StatusChip>
                      {item.permission.preset === 'custom' && (
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {t('administrators.permission.operationCount', { count: item.permission.customOperations?.length ?? 0 })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusChip state={item.status === 'active' ? 'ready' : 'unavailable'}>
                        {t(item.status === 'active' ? 'administrators.status.active' : 'administrators.status.disabled')}
                      </StatusChip>
                    </TableCell>
                    <TableCell>{item.lastLoginAt ? <time dateTime={item.lastLoginAt}>{new Date(item.lastLoginAt).toLocaleString()}</time> : t('administrators.never')}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          aria-label={`${item.status === 'active' ? t('administrators.actions.disable') : t('administrators.actions.enable')} ${item.email}`}
                          disabled={busy !== null}
                          onClick={() => void toggleEnabled(item)}
                          size="small"
                          type="button"
                          variant="secondary"
                        >
                          {item.status === 'active' ? t('administrators.actions.disable') : t('administrators.actions.enable')}
                        </Button>
                        <Button
                          aria-label={`${t('administrators.actions.setPassword')} ${item.email}`}
                          disabled={busy !== null}
                          onClick={() => { setNewPassword(''); setPasswordTarget(item); }}
                          size="small"
                          type="button"
                          variant="secondary"
                        >
                          {t('administrators.actions.setPassword')}
                        </Button>
                        <Button
                          aria-label={`${t('administrators.actions.sessions')} ${item.email}`}
                          disabled={busy !== null}
                          onClick={() => void openSessions(item)}
                          size="small"
                          type="button"
                          variant="secondary"
                        >
                          {t('administrators.actions.sessions')}
                        </Button>
                        <Button
                          aria-label={`${t('administrators.actions.remove')} ${item.email}`}
                          disabled={busy !== null}
                          onClick={() => setDeleteTarget(item)}
                          size="small"
                          type="button"
                          variant="danger"
                        >
                          {t('administrators.actions.remove')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Surface>

      {actionError !== undefined && <ErrorState title={t('administrators.actionFailed')} description={actionMessage(actionError, t)} />}
      {notice !== null && (
        <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status">
          <Check aria-hidden="true" className="shrink-0 text-success" size={15} />{notice}
        </div>
      )}

      <Dialog closeLabel={t('administrators.dialogs.close')} onClose={() => setCreateOpen(false)} open={createOpen} title={t('administrators.create.title')}>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <FormField htmlFor="administrator-email" label={t('administrators.create.email')}>
            <input autoComplete="off" id="administrator-email" onChange={(event) => setCreateEmail(event.target.value)} type="email" value={createEmail} />
          </FormField>
          <FormField hint={t('administrators.create.passwordHint')} htmlFor="administrator-password" label={t('administrators.create.password')}>
            <input autoComplete="new-password" id="administrator-password" onChange={(event) => setCreatePassword(event.target.value)} type="password" value={createPassword} />
          </FormField>
          <FormField htmlFor="administrator-preset" label={t('administrators.create.preset')}>
            <select
              id="administrator-preset"
              onChange={(event) => setCreatePermission((current) => ({ ...current, preset: event.target.value as PermissionPreset }))}
              value={createPermission.preset}
            >
              <option value="fullAccess">{t('administrators.create.presets.fullAccess')}</option>
              <option value="readOnly">{t('administrators.create.presets.readOnly')}</option>
              <option value="custom">{t('administrators.create.presets.custom')}</option>
            </select>
          </FormField>
          {createPermission.preset === 'custom' && (
            <fieldset className="m-0 grid max-h-60 gap-1.5 overflow-y-auto rounded-lg border bg-secondary px-3 py-2.5">
              <legend className="px-1 text-xs font-semibold text-ink-secondary">{t('administrators.create.operations')}</legend>
              <p className="m-0 text-[10px] text-muted-foreground">{t('administrators.create.operationsHint')}</p>
              {administratorOperations.map((operation) => (
                <label className="flex items-center gap-2 text-xs text-ink-secondary" key={operation}>
                  <input
                    checked={(createPermission.customOperations ?? []).includes(operation)}
                    className="accent-primary"
                    onChange={(event) => setCreatePermission((current) => {
                      const selected = current.customOperations ?? [];
                      const next = event.target.checked ? [...selected, operation] : selected.filter((entry) => entry !== operation);
                      return { ...current, customOperations: next };
                    })}
                    type="checkbox"
                  />
                  <span className="break-words font-mono text-[11px]">{operation}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3">
            <Button onClick={() => setCreateOpen(false)} type="button" variant="quiet">{t('administrators.cancel')}</Button>
            <Button disabled={busy !== null || createEmail.trim() === '' || createPassword === ''} type="submit" variant="primary">
              {busy === 'create' ? t('administrators.create.submitting') : t('administrators.create.submit')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog closeLabel={t('administrators.dialogs.close')} onClose={() => setPasswordTarget(null)} open={passwordTarget !== null} title={t('administrators.password.title')}>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void savePassword(); }}>
          <p className="m-0 text-xs leading-relaxed text-ink-secondary">{t('administrators.password.description', { email: passwordTarget?.email ?? '' })}</p>
          <FormField hint={t('administrators.create.passwordHint')} htmlFor="administrator-new-password" label={t('administrators.password.label')}>
            <input autoComplete="new-password" id="administrator-new-password" onChange={(event) => setNewPassword(event.target.value)} type="password" value={newPassword} />
          </FormField>
          <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3">
            <Button onClick={() => setPasswordTarget(null)} type="button" variant="quiet">{t('administrators.cancel')}</Button>
            <Button disabled={busy !== null || newPassword === ''} type="submit" variant="primary">
              {busy === 'password' ? t('administrators.password.submitting') : t('administrators.password.submit')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog closeLabel={t('administrators.dialogs.close')} onClose={() => setSessionsTarget(null)} open={sessionsTarget !== null} title={t('administrators.sessions.title')}>
        <p className="m-0 text-xs leading-relaxed text-ink-secondary">{t('administrators.sessions.description', { email: sessionsTarget?.email ?? '' })}</p>
        {sessions.length === 0
          ? <p className="mt-3 mb-0 text-[11px] text-muted-foreground" role="status">{t('administrators.sessions.empty')}</p>
          : (
            <ul className="m-0 mt-3 grid list-none gap-1.5 p-0 text-[11px]">
              {sessions.map((session) => (
                <li className="flex flex-wrap items-center gap-2.5 border-b py-1.5 last:border-b-0" key={session.id}>
                  <span>{t('administrators.sessions.created', { date: new Date(session.createdAt).toLocaleString() })}</span>
                  <span>{t('administrators.sessions.expires', { date: new Date(session.expiresAt).toLocaleString() })}</span>
                  <span className="ml-auto">
                    <StatusChip state={session.status === 'active' ? 'ready' : 'unavailable'}>
                      {t(session.status === 'active' ? 'administrators.sessions.active' : session.status === 'revoked' ? 'administrators.sessions.revoked' : 'administrators.sessions.expired')}
                    </StatusChip>
                  </span>
                </li>
              ))}
            </ul>
          )}
        <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t pt-3">
          <Button onClick={() => setSessionsTarget(null)} type="button" variant="quiet">{t('administrators.dialogs.close')}</Button>
          <Button disabled={busy !== null || sessions.length === 0} onClick={() => void revokeSessions()} type="button" variant="danger">
            {busy === 'sessions' ? t('administrators.sessions.revoking') : t('administrators.sessions.revokeAll')}
          </Button>
        </div>
      </Dialog>

      <Dialog closeLabel={t('administrators.dialogs.close')} onClose={() => setDeleteTarget(null)} open={deleteTarget !== null} title={t('administrators.remove.title')}>
        <p className="m-0 text-xs leading-relaxed text-ink-secondary">{t('administrators.remove.description', { email: deleteTarget?.email ?? '' })}</p>
        <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t pt-3">
          <Button onClick={() => setDeleteTarget(null)} type="button" variant="quiet">{t('administrators.cancel')}</Button>
          <Button disabled={busy !== null} onClick={() => void remove()} type="button" variant="danger">
            {busy === 'delete' ? t('administrators.remove.submitting') : t('administrators.remove.submit')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function normalizePermission(permission: AdministratorPermission): AdministratorPermission {
  if (permission.preset !== 'custom') return { preset: permission.preset };
  return { preset: 'custom', customPermissionVersion: 1, customOperations: [...(permission.customOperations ?? [])].sort() };
}
