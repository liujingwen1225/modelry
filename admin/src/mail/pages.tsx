import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, RefreshCw, Send } from 'lucide-react';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listStorageSecretOptions, type SecretOption } from '../storage/client';
import {
  fetchMailProvider, listMailDeliveries, retryMailDelivery, saveMailProvider, sendMailTest,
  type MailDelivery, type MailProvider, type MailSecurity,
} from './client';

type LoadState = 'loading' | 'error' | 'ready';

type MailInput = {
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  fromAddress: string;
  fromName: string;
  usernameSecretId: string;
  passwordSecretId: string;
};

function inputFrom(provider: MailProvider): MailInput {
  return {
    enabled: provider.enabled,
    host: provider.host,
    port: provider.port,
    security: provider.security === 'tls' ? 'tls' : provider.security === 'plaintext' ? 'plaintext' : 'startTLS',
    fromAddress: provider.fromAddress,
    fromName: provider.fromName,
    usernameSecretId: provider.username?.secretId ?? '',
    passwordSecretId: provider.password?.secretId ?? '',
  };
}

function deliveryStateKey(status: string): TranslationKey {
  switch (status) {
    case 'succeeded': return 'mail.deliveries.states.succeeded';
    case 'failed': return 'mail.deliveries.states.failed';
    case 'cancelled': return 'mail.deliveries.states.cancelled';
    case 'interrupted': return 'mail.deliveries.states.interrupted';
    case 'running': return 'mail.deliveries.states.running';
    default: return 'mail.deliveries.states.pending';
  }
}

function deliveryKindKey(kind: string): TranslationKey {
  switch (kind) {
    case 'emailVerification': return 'mail.deliveries.kinds.emailVerification';
    case 'passwordReset': return 'mail.deliveries.kinds.passwordReset';
    default: return 'mail.deliveries.kinds.test';
  }
}

function actionMessage(error: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (!(error instanceof ApiClientError)) return t('mail.errors.unexpected');
  switch (error.apiError.code) {
    case 'MAIL_NOT_CONFIGURED': return t('mail.errors.notConfigured');
    case 'MAIL_CREDENTIAL_UNAVAILABLE': return t('mail.errors.credentialUnavailable');
    case 'MAIL_UNAVAILABLE': return t('mail.errors.unavailable');
    case 'MAIL_CAPACITY_EXCEEDED': return t('mail.errors.capacity');
    case 'CONFLICT': return t('mail.errors.conflict');
    case 'INVALID_ARGUMENT': return t('mail.errors.invalidArgument');
    case 'UNAUTHENTICATED': return t('mail.errors.unauthenticated');
    default: return t('mail.errors.unexpected');
  }
}

export function MailPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [provider, setProvider] = useState<MailProvider | null>(null);
  const [input, setInput] = useState<MailInput | null>(null);
  const [secrets, setSecrets] = useState<SecretOption[]>([]);
  const [deliveries, setDeliveries] = useState<MailDelivery[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState<string | null>(null);
  const [testRecipient, setTestRecipient] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    Promise.all([
      fetchMailProvider(controller.signal),
      listStorageSecretOptions(controller.signal).catch(() => [] as SecretOption[]),
      listMailDeliveries(controller.signal).catch(() => [] as MailDelivery[]),
    ]).then(
      ([value, secretOptions, history]) => {
        if (controller.signal.aborted) return;
        setProvider(value);
        setInput(inputFrom(value));
        setSecrets(secretOptions);
        setDeliveries(history);
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

  const refresh = useCallback(() => { setNotice(null); setActionError(undefined); setTestResult(null); setGeneration((value) => value + 1); }, []);

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'surface.mail',
      category: 'commands.categories.system',
      label: () => t('commands.mail'),
      keywords: () => [t('mail.searchKeywords')],
      execute: () => navigate('/settings/mail'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  async function save() {
    if (!provider || !input) return;
    setBusy('save');
    setActionError(undefined);
    setNotice(null);
    try {
      const saved = await saveMailProvider({ expectedRevision: provider.revision, ...input });
      setProvider(saved);
      setInput(inputFrom(saved));
      setNotice(t('mail.notices.saved'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    setActionError(undefined);
    setTestResult(null);
    try {
      const result = await sendMailTest(testRecipient);
      setTestResult(result.state === 'delivered' ? t('mail.provider.testAccepted') + ' · ' + result.message : t('mail.provider.testRejected') + ' · ' + result.message);
      setNotice(result.state === 'delivered' ? t('mail.notices.testSent') : null);
      setGeneration((value) => value + 1);
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function retry(deliveryId: string) {
    setBusy(deliveryId);
    setActionError(undefined);
    try {
      const updated = await retryMailDelivery(deliveryId);
      setDeliveries((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(t('mail.notices.retried'));
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading') return <div className="flex min-w-0 flex-col gap-6"><LoadingState label={t('mail.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={t('mail.loadFailedDescription')} title={t('mail.loadFailed')}>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('mail.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  if (!provider || !input) return null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-h-12 min-w-0 flex-wrap items-center justify-end gap-3 border-b pb-2" data-workspace-toolbar>
        <div className="sr-only">
          <p className="eyebrow">{t('mail.eyebrow')}</p>
          <h1>{t('mail.title')}</h1>
          <p className="mt-2.5 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('mail.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy !== null} onClick={refresh} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> {t('mail.refresh')}
          </Button>
        </div>
      </header>

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted text-ink-secondary"><Mail size={17} /></span>
          <div className="min-w-0">
            <p className="eyebrow">{t('mail.provider.title')}</p>
            <h2>{t('mail.title')}</h2>
          </div>
          <div className="ml-auto">
            <StatusChip state={provider.enabled ? 'ready' : 'unavailable'}>
              {t(provider.enabled ? 'mail.provider.on' : 'mail.provider.off')}
            </StatusChip>
          </div>
        </div>
        <p className="m-0 max-w-[720px] text-[13px] leading-relaxed text-muted-foreground">{t('mail.provider.description')}</p>
        <form className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FormField htmlFor="mail-enabled" label={t('mail.provider.enabled')}>
            <SelectField id="mail-enabled" onValueChange={(selectedValue) => setInput({ ...input, enabled: selectedValue === 'enabled' })} value={input.enabled ? 'enabled' : 'disabled'} options={[({ value: "disabled", label: t('mail.provider.off') }), ({ value: "enabled", label: t('mail.provider.on') })]} />
          </FormField>
          <FormField htmlFor="mail-host" label={t('mail.provider.host')}>
            <Input id="mail-host" onChange={(event) => setInput({ ...input, host: event.target.value })} value={input.host} />
          </FormField>
          <FormField htmlFor="mail-port" label={t('mail.provider.port')}>
            <Input id="mail-port" min="1" max="65535" onChange={(event) => setInput({ ...input, port: Number(event.target.value) })} type="number" value={input.port} />
          </FormField>
          <FormField htmlFor="mail-security" label={t('mail.provider.security')}>
            <SelectField id="mail-security" onValueChange={(selectedValue) => setInput({ ...input, security: selectedValue === 'tls' ? 'tls' : selectedValue === 'plaintext' ? 'plaintext' : 'startTLS' })} value={input.security} options={[({ value: "startTLS", label: t('mail.provider.securityStartTLS') }), ({ value: "tls", label: t('mail.provider.securityTLS') }), ({ value: "plaintext", label: t('mail.provider.securityPlaintext') })]} />
          </FormField>
          <FormField htmlFor="mail-from-address" label={t('mail.provider.fromAddress')}>
            <Input id="mail-from-address" onChange={(event) => setInput({ ...input, fromAddress: event.target.value })} type="email" value={input.fromAddress} />
          </FormField>
          <FormField htmlFor="mail-from-name" label={t('mail.provider.fromName')}>
            <Input id="mail-from-name" onChange={(event) => setInput({ ...input, fromName: event.target.value })} value={input.fromName} />
          </FormField>
          <FormField htmlFor="mail-username" label={t('mail.provider.username')}>
            <SelectField id="mail-username" onValueChange={(selectedValue) => setInput({ ...input, usernameSecretId: selectedValue })} value={input.usernameSecretId} options={[({ value: "", label: t('mail.provider.chooseSecret') }), secrets.map((secret) => ({ value: secret.id, label: secret.name }))]} />
          </FormField>
          <FormField htmlFor="mail-password" label={t('mail.provider.password')}>
            <SelectField id="mail-password" onValueChange={(selectedValue) => setInput({ ...input, passwordSecretId: selectedValue })} value={input.passwordSecretId} options={[({ value: "", label: t('mail.provider.chooseSecret') }), secrets.map((secret) => ({ value: secret.id, label: secret.name }))]} />
          </FormField>
          <div className="min-w-0 sm:col-span-2 xl:col-span-3">
            {secrets.length === 0
              ? <p className="m-0 text-[11px] text-muted-foreground">{t('mail.provider.noSecrets')} <Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('mail.provider.createSecret')}</Link></p>
              : <p className="m-0 text-[11px] text-muted-foreground"><Link className="font-semibold text-primary hover:underline" to="/settings/secrets">{t('mail.provider.manageSecrets')}</Link></p>}
          </div>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-3">
            <Button disabled={busy !== null} type="submit" size="small" variant="primary">
              {busy === 'save' ? t('mail.provider.saving') : t('mail.provider.save')}
            </Button>
          </div>
        </form>
        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <div className="min-w-[220px] flex-1">
            <FormField htmlFor="mail-test-recipient" label={t('mail.provider.testRecipient')}>
              <Input id="mail-test-recipient" onChange={(event) => setTestRecipient(event.target.value)} type="email" value={testRecipient} />
            </FormField>
          </div>
          <Button disabled={busy !== null || testRecipient.trim() === ''} onClick={() => void sendTest()} size="small" type="button" variant="secondary">
            <Send aria-hidden="true" size={14} /> {busy === 'test' ? t('mail.provider.testing') : t('mail.provider.test')}
          </Button>
        </div>
        {testResult !== null && <p className="m-0 text-xs text-ink-secondary" role="status">{testResult}</p>}
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="min-w-0">
          <p className="eyebrow">{t('mail.deliveries.title')}</p>
          <h2>{t('mail.deliveries.title')}</h2>
        </div>
        <p className="m-0 max-w-[720px] text-[13px] leading-relaxed text-muted-foreground">{t('mail.deliveries.description')}</p>
        {deliveries.length === 0
          ? <EmptyState description={t('mail.deliveries.description')} title={t('mail.deliveries.empty')} />
          : (
            <Table>
              <TableCaption>{t('mail.deliveries.caption')}</TableCaption>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead scope="col">{t('mail.deliveries.columns.kind')}</TableHead>
                  <TableHead scope="col">{t('mail.deliveries.columns.recipient')}</TableHead>
                  <TableHead scope="col">{t('mail.deliveries.columns.status')}</TableHead>
                  <TableHead scope="col">{t('mail.deliveries.columns.attempts')}</TableHead>
                  <TableHead scope="col">{t('mail.deliveries.columns.created')}</TableHead>
                  <TableHead scope="col">{t('mail.deliveries.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((delivery) => (
                  <TableRow data-delivery-id={delivery.id} key={delivery.id}>
                    <TableCell>{t(deliveryKindKey(delivery.kind))}</TableCell>
                    <TableCell>{delivery.recipient}</TableCell>
                    <TableCell>
                      <StatusChip state={delivery.status === 'succeeded' ? 'ready' : delivery.status === 'failed' || delivery.status === 'interrupted' ? 'unavailable' : 'degraded'}>
                        {t(deliveryStateKey(delivery.status))}
                      </StatusChip>
                      {delivery.errorCode !== '' && <span className="mt-1 block text-[11px] text-muted-foreground">{delivery.errorCode}</span>}
                    </TableCell>
                    <TableCell>{delivery.attempts}</TableCell>
                    <TableCell>{new Date(delivery.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Button
                        aria-label={t('mail.deliveries.retry') + ' ' + delivery.recipient}
                        disabled={busy !== null || delivery.status === 'succeeded'}
                        onClick={() => void retry(delivery.id)}
                        size="small"
                        type="button"
                        variant="secondary"
                      >
                        {busy === delivery.id ? t('mail.deliveries.retrying') : t('mail.deliveries.retry')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Surface>

      {actionError !== undefined && <ErrorState description={actionMessage(actionError, t)} title={t('mail.actionFailed')} />}
      {notice !== null && <p className="m-0 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-xs text-success" role="status">{notice}</p>}
    </div>
  );
}
