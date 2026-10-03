import { Input } from '@/components/ui/input';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, CircleAlert, Command, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ApiClientError } from '../api/client';
import { Button } from '../components/button';
import { ButtonAnchor } from '@/components/ui/button';
import { FormField } from '../components/form-field';
import { LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import {
  createOwner,
  fetchBootstrapStatus,
  loginOwner,
  type AuthenticatedOwner,
  type OwnerCredentials,
} from './client';

type AuthViolation = { path: string; code: string; message: string };

const titleClass = 'm-0 text-2xl font-semibold leading-tight tracking-tight text-foreground';
const copyClass = 'mt-2 text-sm leading-relaxed text-muted-foreground';
const submitClass = 'min-h-10 w-full [&_svg]:ml-auto';

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
    <section
      aria-label={title}
      className="mb-3.5 flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger-soft p-3 text-danger"
      role="alert"
    >
      <span aria-hidden="true" className="grid shrink-0 place-items-center pt-px"><CircleAlert size={17} /></span>
      <div className="min-w-0">
        <h2 className="m-0 mb-1 text-base font-semibold text-danger">{title}</h2>
        <p className="m-0 break-words text-sm leading-relaxed text-ink-secondary">{apiError ? errorMessage(apiError.code) ?? fallback : fallback}</p>
        {apiError && <p className="mt-1.5 text-sm text-muted-foreground">{t('ownerAuth.errorCode')} <code className="font-mono text-[13px] font-medium text-danger">{apiError.code}</code></p>}
        {violations.length > 0 && (
          <ul className="mt-2 grid list-disc gap-1 break-words pl-4 text-xs text-ink-secondary">
            {violations.map((violation, index) => (
              <li className="min-w-0" key={`${violation.path}-${violation.code}-${index}`}>
                <code className="font-mono text-[13px] font-medium text-danger">{violation.path}</code> <code className="font-mono text-[13px] font-medium text-danger">{violation.code}</code> {authViolationMessage(violation, t)}
              </li>
            ))}
          </ul>
        )}
        {apiError && <p className="mt-2 text-sm text-muted-foreground">{t('ownerAuth.requestId')} <code className="font-mono text-[13px] font-medium text-danger">{apiError.requestId}</code></p>}
      </div>
    </section>
  );
}

function AuthFrame({ children, eyebrow, mode }: { children: ReactNode; eyebrow: string; mode: 'setup' | 'login' }) {
  const { t } = useI18n();
  return (
    <main className="grid min-h-screen place-items-center bg-background px-[18px] py-[clamp(24px,6vh,56px)]">
      <div className="mx-auto w-full max-w-[420px]">
        <a aria-label="Modelry" className="mx-auto mb-6 flex w-fit items-center gap-2.5 text-foreground" href="/">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted text-ink-secondary"><Command size={18} strokeWidth={2.2} /></span>
          <span className="text-xl font-bold tracking-[-1.1px]">modelry</span>
          <StatusChip state="ready">{t('shell.localContext')}</StatusChip>
        </a>
        <Surface className="p-6" variant="standard">
          <div className="mb-2 flex items-center gap-2.5">
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted text-ink-secondary">
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
      <Input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
        autoComplete={autoComplete}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        required
        type={type}
        value={value}
      />
      {error && <span className="text-xs text-danger" id={errorId}>{error}</span>}
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
    <div className="grid justify-items-start" role="status">
      <span aria-hidden="true" className="mb-3 grid size-9 place-items-center rounded-xl border border-success/20 bg-success-soft text-success"><Check size={19} /></span>
      <h1 className={titleClass}>{title}</h1>
      <p className={copyClass}>{description}</p>
      <dl className="my-5 grid w-full gap-0 border-y py-0.5">
        <div className="grid grid-cols-[minmax(96px,0.55fr)_minmax(0,1fr)] gap-3 border-b py-2.5 last:border-b-0 max-[420px]:grid-cols-1 max-[420px]:gap-1"><dt className="text-xs text-muted-foreground">{t('ownerAuth.ownerAccount')}</dt><dd className="m-0 min-w-0 break-words text-xs font-semibold text-ink-secondary">{result.owner.email}</dd></div>
        <div className="grid grid-cols-[minmax(96px,0.55fr)_minmax(0,1fr)] gap-3 border-b py-2.5 last:border-b-0 max-[420px]:grid-cols-1 max-[420px]:gap-1"><dt className="text-xs text-muted-foreground">{t('ownerAuth.session')}</dt><dd className="m-0 min-w-0"><StatusChip state="ready">{t('ownerAuth.active')}</StatusChip></dd></div>
        <div className="grid grid-cols-[minmax(96px,0.55fr)_minmax(0,1fr)] gap-3 border-b py-2.5 last:border-b-0 max-[420px]:grid-cols-1 max-[420px]:gap-1"><dt className="text-xs text-muted-foreground">{t('ownerAuth.sessionExpires')}</dt><dd className="m-0 min-w-0 break-words text-xs font-semibold text-ink-secondary"><time dateTime={result.session.expiresAt}>{result.session.expiresAt}</time></dd></div>
      </dl>
      {onContinue && (
        <Button className={submitClass} onClick={onContinue} type="button" variant="primary">
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
        <div className="mb-5"><h1 className={titleClass}>{t('ownerAuth.connectTitle')}</h1><p className={copyClass}>{t('ownerAuth.setupUnavailable')}</p></div>
        <AuthError error={statusError} fallback={t('ownerAuth.runtimeUnavailable')} title={t('ownerAuth.setupLoadFailed')} />
        <Button className={submitClass} onClick={() => void checkStatus()} type="button" variant="primary">{t('ownerAuth.retrySetup')}</Button>
      </AuthFrame>
    );
  }

  if (state === 'closed') {
    return (
      <AuthFrame eyebrow={t('ownerAuth.firstRun')} mode="setup">
        <div className="mb-5"><h1 className={titleClass}>{t('ownerAuth.setupAlreadyComplete')}</h1><p className={copyClass}>{t('ownerAuth.setupAlreadyCompleteDescription')}</p></div>
        <ButtonAnchor className="min-h-10 w-full" href={loginHref}>{t('ownerAuth.signIn')} <ArrowRight aria-hidden="true" size={15} /></ButtonAnchor>
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
      <div className="mb-5">
        <h1 className={titleClass}>{t('ownerAuth.createOwner')}</h1>
        <p className={copyClass}>{t('ownerAuth.createOwnerDescription')}</p>
      </div>
      {submitError !== undefined && (
        <>
          <AuthError error={submitError} fallback={t('ownerAuth.setupFailedDescription')} title={t('ownerAuth.setupFailed')} />
          <Button className="-ml-2 -mt-2 mb-2" disabled={submitting} onClick={() => void checkStatus()} size="small" type="button" variant="quiet">{t('ownerAuth.checkSetup')}</Button>
        </>
      )}
      <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
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
        <Button className={submitClass} disabled={submitting} type="submit" variant="primary">
          {submitting ? t('ownerAuth.creatingOwner') : t('ownerAuth.completeSetup')}
          {!submitting && <ArrowRight aria-hidden="true" size={16} />}
        </Button>
      </form>
      <p className="mt-4 flex items-center gap-2 text-sm text-subtle-foreground"><KeyRound aria-hidden="true" className="shrink-0 text-ink-secondary" size={14} /> {t('ownerAuth.bootstrapNotice')}</p>
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
      <div className="mb-5"><h1 className={titleClass}>{t('ownerAuth.signInTitle')}</h1><p className={copyClass}>{t('ownerAuth.signInDescription')}</p></div>
      {sessionExpired && <p className="mb-3.5 rounded-lg border border-info/30 bg-info-soft px-3 py-2.5 text-sm text-info" role="status">{t('ownerAuth.sessionExpired')}</p>}
      {error !== undefined && <AuthError error={error} fallback={t('ownerAuth.signInFailedDescription')} title={t('ownerAuth.signInFailed')} />}
      <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
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
        <Button className={submitClass} disabled={submitting} type="submit" variant="primary">
          {submitting ? t('ownerAuth.signingIn') : t('ownerAuth.signIn')}
          {!submitting && <ArrowRight aria-hidden="true" size={16} />}
        </Button>
      </form>
      {submitting && <span className="sr-only" role="status">{t('ownerAuth.signingIn')}</span>}
    </AuthFrame>
  );
}
