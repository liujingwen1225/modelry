import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, CircleAlert, Command, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ApiClientError } from '../api/client';
import { Button, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import {
  createOwner,
  fetchBootstrapStatus,
  loginOwner,
  type AuthenticatedOwner,
  type OwnerCredentials,
} from './client';
import './auth.css';

type AuthViolation = { path: string; code: string; message: string };

const authViolationKeys: Record<string, TranslationKey> = {
  INVALID_EMAIL: 'ownerAuth.invalidEmail',
  REQUIRED: 'ownerAuth.requiredValue',
  TOO_LONG: 'ownerAuth.passwordTooLong',
  TOO_SHORT: 'ownerAuth.passwordLength',
};

function authViolationMessage(violation: AuthViolation, t: ReturnType<typeof useI18n>['t']): string {
  return t(authViolationKeys[violation.code] ?? 'ownerAuth.validationReview', { code: violation.code });
}

function readViolations(error: unknown): AuthViolation[] {
  if (!(error instanceof ApiClientError)) return [];
  const violations = error.apiError.details.violations;
  if (!Array.isArray(violations)) return [];
  return violations.filter((item): item is AuthViolation =>
    typeof item === 'object' && item !== null &&
    typeof item.path === 'string' && typeof item.code === 'string' && typeof item.message === 'string',
  );
}

function fieldViolation(error: unknown, field: 'email' | 'password', t: ReturnType<typeof useI18n>['t']): string | undefined {
  const violation = readViolations(error).find((item) => item.path.split('/').at(-1) === field);
  return violation ? authViolationMessage(violation, t) : undefined;
}

function AuthError({ error, fallback, title }: { error: unknown; fallback: string; title: string }) {
  const apiError = error instanceof ApiClientError ? error.apiError : undefined;
  const violations = readViolations(error);
  const { errorMessage, t } = useI18n();
  return (
    <section aria-label={title} className="auth-error" role="alert">
      <span aria-hidden="true" className="auth-error__icon"><CircleAlert size={17} /></span>
      <div className="auth-error__content">
        <h2>{title}</h2>
        <p>{apiError ? errorMessage(apiError.code) ?? fallback : fallback}</p>
        {apiError && <p className="auth-error__code">{t('ownerAuth.errorCode')} <code>{apiError.code}</code></p>}
        {violations.length > 0 && (
          <ul className="auth-error__violations">
            {violations.map((violation, index) => (
              <li key={`${violation.path}-${violation.code}-${index}`}>
                <code>{violation.path}</code> <code>{violation.code}</code> {authViolationMessage(violation, t)}
              </li>
            ))}
          </ul>
        )}
        {apiError && <p className="auth-error__request">{t('ownerAuth.requestId')} <code>{apiError.requestId}</code></p>}
      </div>
    </section>
  );
}

function AuthFrame({ children, eyebrow, mode }: { children: ReactNode; eyebrow: string; mode: 'setup' | 'login' }) {
  const { t } = useI18n();
  return (
    <main className="auth-screen">
      <div className="auth-layout">
        <a aria-label="Modelry" className="auth-brand" href="/">
          <span aria-hidden="true" className="auth-brand__mark"><Command size={18} strokeWidth={2.2} /></span>
          <span className="auth-brand__word">modelry</span>
          <StatusChip state="ready">{t('shell.localContext')}</StatusChip>
        </a>
        <Surface className="auth-card" variant="raised">
          <div className="auth-card__heading">
            <span aria-hidden="true" className="auth-card__icon">
              {mode === 'setup' ? <ShieldCheck size={20} /> : <LockKeyhole size={20} />}
            </span>
            <p className="eyebrow">{eyebrow}</p>
          </div>
          {children}
        </Surface>
      </div>
    </main>
  );
}

function AuthInput({
  autoComplete,
  error,
  id,
  label,
  onChange,
  type,
  value,
}: {
  autoComplete: string;
  error?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  type: 'email' | 'password';
  value: string;
}) {
  const errorId = `${id}-error`;
  return (
    <FormField htmlFor={id} label={label}>
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
        autoComplete={autoComplete}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        required
        type={type}
        value={value}
      />
      {error && <span className="auth-field-error" id={errorId}>{error}</span>}
    </FormField>
  );
}

function AuthSuccess({
  actionLabel,
  description,
  onContinue,
  result,
  title,
}: {
  actionLabel: string;
  description: string;
  onContinue?: () => void;
  result: AuthenticatedOwner;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <div className="auth-success" role="status">
      <span aria-hidden="true" className="auth-success__icon"><Check size={19} /></span>
      <h1>{title}</h1>
      <p className="auth-success__description">{description}</p>
      <dl className="auth-identity">
        <div><dt>{t('ownerAuth.ownerAccount')}</dt><dd>{result.owner.email}</dd></div>
        <div><dt>{t('ownerAuth.session')}</dt><dd><StatusChip state="ready">{t('ownerAuth.active')}</StatusChip></dd></div>
        <div><dt>{t('ownerAuth.sessionExpires')}</dt><dd><time dateTime={result.session.expiresAt}>{result.session.expiresAt}</time></dd></div>
      </dl>
      {onContinue && (
        <Button className="auth-submit" onClick={onContinue} type="button" variant="primary">
          {actionLabel}<ArrowRight aria-hidden="true" size={16} />
        </Button>
      )}
    </div>
  );
}

export type BootstrapPageProps = {
  /** 首次设置成功后，以 Runtime 返回的 Owner 与 Session 调用。 */
  onAuthenticated?: (result: AuthenticatedOwner) => void;
  loginHref?: string;
};

type BootstrapState = 'checking' | 'required' | 'closed' | 'unavailable' | 'complete';

export function BootstrapPage({ onAuthenticated, loginHref = '/login' }: BootstrapPageProps) {
  const { t } = useI18n();
  const [state, setState] = useState<BootstrapState>('checking');
  const [statusError, setStatusError] = useState<unknown>();
  const [submitError, setSubmitError] = useState<unknown>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<AuthenticatedOwner>();
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);

  const checkStatus = useCallback(async () => {
    setState('checking');
    setStatusError(undefined);
    try {
      const status = await fetchBootstrapStatus();
      setState(status.state);
    } catch (error) {
      setStatusError(error);
      setState('unavailable');
    }
  }, []);

  useEffect(() => { void checkStatus(); }, [checkStatus]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || !event.currentTarget.reportValidity()) return;
    submissionLock.current = true;
    setSubmitting(true);
    setSubmitError(undefined);
    const credentials: OwnerCredentials = { email: email.trim(), password };
    let created: AuthenticatedOwner;
    try {
      created = await createOwner(credentials);
    } catch (error) {
      setSubmitError(error);
      return;
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
    setResult(created);
    setState('complete');
    onAuthenticated?.(created);
  }

  if (state === 'checking') {
    return <AuthFrame eyebrow={t('ownerAuth.firstRun')} mode="setup"><LoadingState label={t('ownerAuth.loadingSetup')} /></AuthFrame>;
  }

  if (state === 'unavailable') {
    return (
      <AuthFrame eyebrow={t('ownerAuth.firstRun')} mode="setup">
        <div className="auth-copy"><h1>{t('ownerAuth.connectTitle')}</h1><p>{t('ownerAuth.setupUnavailable')}</p></div>
        <AuthError error={statusError} fallback={t('ownerAuth.runtimeUnavailable')} title={t('ownerAuth.setupLoadFailed')} />
        <Button className="auth-submit" onClick={() => void checkStatus()} type="button" variant="primary">{t('ownerAuth.retrySetup')}</Button>
      </AuthFrame>
    );
  }

  if (state === 'closed') {
    return (
      <AuthFrame eyebrow={t('ownerAuth.firstRun')} mode="setup">
        <div className="auth-copy"><h1>{t('ownerAuth.setupAlreadyComplete')}</h1><p>{t('ownerAuth.setupAlreadyCompleteDescription')}</p></div>
        <a className="auth-link auth-link--button" href={loginHref}>{t('ownerAuth.signIn')} <ArrowRight aria-hidden="true" size={15} /></a>
      </AuthFrame>
    );
  }

  if (state === 'complete' && result) {
    return (
      <AuthFrame eyebrow={t('ownerAuth.firstRun')} mode="setup">
        <AuthSuccess
          actionLabel={t('ownerAuth.continueToModelry')}
          description={t('ownerAuth.setupCompleteDescription')}
          onContinue={onAuthenticated ? undefined : () => { window.location.assign('/'); }}
          result={result}
          title={t('ownerAuth.ownerReady')}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame eyebrow={t('ownerAuth.firstRun')} mode="setup">
      <div className="auth-copy">
        <h1>{t('ownerAuth.createOwner')}</h1>
        <p>{t('ownerAuth.createOwnerDescription')}</p>
      </div>
      {submitError !== undefined && (
        <>
          <AuthError error={submitError} fallback={t('ownerAuth.setupFailedDescription')} title={t('ownerAuth.setupFailed')} />
          <Button className="auth-recheck" disabled={submitting} onClick={() => void checkStatus()} type="button" variant="quiet">{t('ownerAuth.checkSetup')}</Button>
        </>
      )}
      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        <AuthInput
          autoComplete="email"
          error={fieldViolation(submitError, 'email', t)}
          id="bootstrap-email"
          label={t('ownerAuth.email')}
          onChange={setEmail}
          type="email"
          value={email}
        />
        <AuthInput
          autoComplete="new-password"
          error={fieldViolation(submitError, 'password', t)}
          id="bootstrap-password"
          label={t('ownerAuth.password')}
          onChange={setPassword}
          type="password"
          value={password}
        />
        <Button className="auth-submit" disabled={submitting} type="submit" variant="primary">
          {submitting ? t('ownerAuth.creatingOwner') : t('ownerAuth.completeSetup')}
          {!submitting && <ArrowRight aria-hidden="true" size={16} />}
        </Button>
      </form>
      <p className="auth-note"><KeyRound aria-hidden="true" size={14} /> {t('ownerAuth.bootstrapNotice')}</p>
    </AuthFrame>
  );
}

export type LoginPageProps = {
  /** 凭证有效并建立 Owner Session 后调用。 */
  onAuthenticated?: (result: AuthenticatedOwner, returnTo?: string) => void;
  returnTo?: string;
  sessionExpired?: boolean;
};

export function resolveOwnerReturnTo(candidate: string | undefined, origin = window.location.origin): string | undefined {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) return undefined;
  try {
    const target = new URL(candidate, origin);
    if (target.origin !== origin) return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}

function getReturnTo(value: string | undefined): string | undefined {
  const candidate = value ?? new URLSearchParams(window.location.search).get('returnTo') ?? undefined;
  return resolveOwnerReturnTo(candidate);
}

export function LoginPage({ onAuthenticated, returnTo, sessionExpired = false }: LoginPageProps) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<AuthenticatedOwner>();
  const submissionLock = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || !event.currentTarget.reportValidity()) return;
    submissionLock.current = true;
    setSubmitting(true);
    setError(undefined);
    const credentials: OwnerCredentials = { email: email.trim(), password };
    let authenticated: AuthenticatedOwner;
    try {
      authenticated = await loginOwner(credentials);
    } catch (requestError) {
      setError(requestError);
      return;
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
    setPassword('');
    setResult(authenticated);
    onAuthenticated?.(authenticated, getReturnTo(returnTo));
  }

  if (result) {
    const destination = getReturnTo(returnTo) ?? '/';
    return (
      <AuthFrame eyebrow={t('ownerAuth.signInEyebrow')} mode="login">
        <AuthSuccess
          actionLabel={t('ownerAuth.continueToModelry')}
          description={t('ownerAuth.signInSuccessDescription')}
          onContinue={onAuthenticated ? undefined : () => { window.location.assign(destination); }}
          result={result}
          title={t('ownerAuth.ownerSessionActive')}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame eyebrow={t('ownerAuth.signInEyebrow')} mode="login">
      <div className="auth-copy"><h1>{t('ownerAuth.signInTitle')}</h1><p>{t('ownerAuth.signInDescription')}</p></div>
      {sessionExpired && <p className="auth-session-notice" role="status">{t('ownerAuth.sessionExpired')}</p>}
      {error !== undefined && <AuthError error={error} fallback={t('ownerAuth.signInFailedDescription')} title={t('ownerAuth.signInFailed')} />}
      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        <AuthInput
          autoComplete="username"
          error={fieldViolation(error, 'email', t)}
          id="login-email"
          label={t('ownerAuth.email')}
          onChange={setEmail}
          type="email"
          value={email}
        />
        <AuthInput
          autoComplete="current-password"
          error={fieldViolation(error, 'password', t)}
          id="login-password"
          label={t('ownerAuth.password')}
          onChange={setPassword}
          type="password"
          value={password}
        />
        <Button className="auth-submit" disabled={submitting} type="submit" variant="primary">
          {submitting ? t('ownerAuth.signingIn') : t('ownerAuth.signIn')}
          {!submitting && <ArrowRight aria-hidden="true" size={16} />}
        </Button>
      </form>
      {submitting && <span className="sr-only" role="status">{t('ownerAuth.signingIn')}</span>}
    </AuthFrame>
  );
}
