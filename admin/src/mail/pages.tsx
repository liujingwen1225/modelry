import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, RefreshCw, Send } from 'lucide-react';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listStorageSecretOptions, type SecretOption } from '../storage/client';
import {
  fetchMailProvider, listMailDeliveries, retryMailDelivery, saveMailProvider, sendMailTest,
  type MailDelivery, type MailProvider, type MailSecurity,
} from './client';
import './mail.css';

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

  if (state === 'loading') return <div className="page-stack"><LoadingState label={t('mail.loading')} /></div>;
  if (state === 'error') {
    return (
      <div className="page-stack">
        <ErrorState description={t('mail.loadFailedDescription')} title={t('mail.loadFailed')}>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={14} /> {t('mail.retry')}</Button>
        </ErrorState>
      </div>
    );
  }
  if (!provider || !input) return null;

  return (
    <div className="page-stack mail-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('mail.eyebrow')}</p>
          <h1>{t('mail.title')}</h1>
          <p className="page-description">{t('mail.description')}</p>
        </div>
        <div className="mail-page__actions">
          <Button disabled={busy !== null} onClick={refresh} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={14} /> {t('mail.refresh')}
          </Button>
        </div>
      </header>

      <Surface className="mail-provider" variant="standard">
        <div className="mail-provider__heading">
          <span className="scope-icon"><Mail aria-hidden="true" size={17} /></span>
          <div>
            <p className="eyebrow">{t('mail.provider.title')}</p>
            <h2>{t('mail.title')}</h2>
          </div>
          <StatusChip state={provider.enabled ? 'ready' : 'unavailable'}>
            {t(provider.enabled ? 'mail.provider.on' : 'mail.provider.off')}
          </StatusChip>
        </div>
        <p className="section-description">{t('mail.provider.description')}</p>
        <form className="mail-provider__fields" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FormField htmlFor="mail-enabled" label={t('mail.provider.enabled')}>
            <select id="mail-enabled" onChange={(event) => setInput({ ...input, enabled: event.target.value === 'enabled' })} value={input.enabled ? 'enabled' : 'disabled'}>
              <option value="disabled">{t('mail.provider.off')}</option>
              <option value="enabled">{t('mail.provider.on')}</option>
            </select>
          </FormField>
          <FormField htmlFor="mail-host" label={t('mail.provider.host')}>
            <input id="mail-host" onChange={(event) => setInput({ ...input, host: event.target.value })} value={input.host} />
          </FormField>
          <FormField htmlFor="mail-port" label={t('mail.provider.port')}>
            <input id="mail-port" min="1" max="65535" onChange={(event) => setInput({ ...input, port: Number(event.target.value) })} type="number" value={input.port} />
          </FormField>
          <FormField htmlFor="mail-security" label={t('mail.provider.security')}>
            <select id="mail-security" onChange={(event) => setInput({ ...input, security: event.target.value === 'tls' ? 'tls' : event.target.value === 'plaintext' ? 'plaintext' : 'startTLS' })} value={input.security}>
              <option value="startTLS">{t('mail.provider.securityStartTLS')}</option>
              <option value="tls">{t('mail.provider.securityTLS')}</option>
              <option value="plaintext">{t('mail.provider.securityPlaintext')}</option>
            </select>
          </FormField>
          <FormField htmlFor="mail-from-address" label={t('mail.provider.fromAddress')}>
            <input id="mail-from-address" onChange={(event) => setInput({ ...input, fromAddress: event.target.value })} type="email" value={input.fromAddress} />
          </FormField>
          <FormField htmlFor="mail-from-name" label={t('mail.provider.fromName')}>
            <input id="mail-from-name" onChange={(event) => setInput({ ...input, fromName: event.target.value })} value={input.fromName} />
          </FormField>
          <FormField htmlFor="mail-username" label={t('mail.provider.username')}>
            <select id="mail-username" onChange={(event) => setInput({ ...input, usernameSecretId: event.target.value })} value={input.usernameSecretId}>
              <option value="">{t('mail.provider.chooseSecret')}</option>
              {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
            </select>
          </FormField>
          <FormField htmlFor="mail-password" label={t('mail.provider.password')}>
            <select id="mail-password" onChange={(event) => setInput({ ...input, passwordSecretId: event.target.value })} value={input.passwordSecretId}>
              <option value="">{t('mail.provider.chooseSecret')}</option>
              {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
            </select>
          </FormField>
          {secrets.length === 0 && <p className="mail-hint">{t('mail.provider.noSecrets')} <Link to="/secrets">{t('mail.provider.createSecret')}</Link></p>}
          <div className="mail-actions">
            <Button disabled={busy !== null} type="submit" size="small" variant="primary">
              {busy === 'save' ? t('mail.provider.saving') : t('mail.provider.save')}
            </Button>
          </div>
        </form>
        <div className="mail-test">
          <FormField htmlFor="mail-test-recipient" label={t('mail.provider.testRecipient')}>
            <input id="mail-test-recipient" onChange={(event) => setTestRecipient(event.target.value)} type="email" value={testRecipient} />
          </FormField>
          <Button disabled={busy !== null || testRecipient.trim() === ''} onClick={() => void sendTest()} size="small" type="button" variant="secondary">
            <Send aria-hidden="true" size={14} /> {busy === 'test' ? t('mail.provider.testing') : t('mail.provider.test')}
          </Button>
        </div>
        {testResult !== null && <p role="status">{testResult}</p>}
      </Surface>

      <Surface className="mail-deliveries" variant="standard">
        <div className="mail-deliveries__heading">
          <div>
            <p className="eyebrow">{t('mail.deliveries.title')}</p>
            <h2>{t('mail.deliveries.title')}</h2>
          </div>
        </div>
        <p className="section-description">{t('mail.deliveries.description')}</p>
        {deliveries.length === 0
          ? <EmptyState description={t('mail.deliveries.description')} title={t('mail.deliveries.empty')} />
          : (
            <div className="table-scroll">
              <table className="data-table mail-deliveries__table">
                <caption>{t('mail.deliveries.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('mail.deliveries.columns.kind')}</th>
                    <th scope="col">{t('mail.deliveries.columns.recipient')}</th>
                    <th scope="col">{t('mail.deliveries.columns.status')}</th>
                    <th scope="col">{t('mail.deliveries.columns.attempts')}</th>
                    <th scope="col">{t('mail.deliveries.columns.created')}</th>
                    <th scope="col">{t('mail.deliveries.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((delivery) => (
                    <tr data-delivery-id={delivery.id} key={delivery.id}>
                      <td>{t(deliveryKindKey(delivery.kind))}</td>
                      <td>{delivery.recipient}</td>
                      <td>
                        <StatusChip state={delivery.status === 'succeeded' ? 'ready' : delivery.status === 'failed' || delivery.status === 'interrupted' ? 'unavailable' : 'degraded'}>
                          {t(deliveryStateKey(delivery.status))}
                        </StatusChip>
                        {delivery.errorCode !== '' && <span className="mail-delivery-error">{delivery.errorCode}</span>}
                      </td>
                      <td>{delivery.attempts}</td>
                      <td>{new Date(delivery.createdAt).toLocaleString()}</td>
                      <td>
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Surface>

      {actionError !== undefined && <ErrorState description={actionMessage(actionError, t)} title={t('mail.actionFailed')} />}
      {notice !== null && <p role="status">{notice}</p>}
    </div>
  );
}