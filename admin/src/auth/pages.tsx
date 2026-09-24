import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, CircleAlert, Command, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ApiClientError } from '../api/client';
import { Button, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import {
  createOwner,
  fetchBootstrapStatus,
  loginOwner,
  type AuthenticatedOwner,
  type OwnerCredentials,
} from './client';
import './auth.css';

type AuthViolation = { path: string; code: string; message: string };

function readViolations(error: unknown): AuthViolation[] {
  if (!(error instanceof ApiClientError)) return [];
  const violations = error.apiError.details.violations;
  if (!Array.isArray(violations)) return [];
  return violations.filter((item): item is AuthViolation =>
    typeof item === 'object' && item !== null &&
    typeof item.path === 'string' && typeof item.code === 'string' && typeof item.message === 'string',
  );
}

function fieldViolation(error: unknown, field: 'email' | 'password'): string | undefined {
  return readViolations(error).find((violation) => violation.path.split('/').at(-1) === field)?.message;
}

function AuthError({ error, fallback, title }: { error: unknown; fallback: string; title: string }) {
  const apiError = error instanceof ApiClientError ? error.apiError : undefined;
  const violations = readViolations(error);
  return (
    <section aria-label={title} className="auth-error" role="alert">
      <span aria-hidden="true" className="auth-error__icon"><CircleAlert size={17} /></span>
      <div className="auth-error__content">
        <h2>{title}</h2>
        <p>{apiError?.message ?? fallback}</p>
        {apiError && <p className="auth-error__code">Error code <code>{apiError.code}</code></p>}
        {apiError?.hint && <p className="auth-error__hint">{apiError.hint}</p>}
        {violations.length > 0 && (
          <ul className="auth-error__violations">
            {violations.map((violation, index) => (
              <li key={`${violation.path}-${violation.code}-${index}`}>
                <code>{violation.path}</code> {violation.message}
              </li>
            ))}
          </ul>
        )}
        {apiError && <p className="auth-error__request">Request ID <code>{apiError.requestId}</code></p>}
      </div>
    </section>
  );
}

function AuthFrame({ children, eyebrow }: { children: ReactNode; eyebrow: string }) {
  return (
    <main className="auth-screen">
      <div className="auth-layout">
        <a aria-label="Modelry" className="auth-brand" href="/">
          <span aria-hidden="true" className="auth-brand__mark"><Command size={18} strokeWidth={2.2} /></span>
          <span className="auth-brand__word">modelry</span>
          <StatusChip state="ready">COMMUNITY</StatusChip>
        </a>
        <Surface className="auth-card" variant="raised">
          <div className="auth-card__heading">
            <span aria-hidden="true" className="auth-card__icon">
              {eyebrow === 'FIRST RUN' ? <ShieldCheck size={20} /> : <LockKeyhole size={20} />}
            </span>
            <p className="eyebrow">{eyebrow}</p>
          </div>
          {children}
        </Surface>
        <footer className="auth-footer"><span>Modelry Community</span><span aria-hidden="true">·</span><span>Control Plane</span></footer>
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
  return (
    <div className="auth-success" role="status">
      <span aria-hidden="true" className="auth-success__icon"><Check size={19} /></span>
      <h1>{title}</h1>
      <p className="auth-success__description">{description}</p>
      <dl className="auth-identity">
        <div><dt>Owner account</dt><dd>{result.owner.email}</dd></div>
        <div><dt>Session</dt><dd><StatusChip state="ready">Active</StatusChip></dd></div>
        <div><dt>Session expires</dt><dd><time dateTime={result.session.expiresAt}>{result.session.expiresAt}</time></dd></div>
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
    return <AuthFrame eyebrow="FIRST RUN"><LoadingState label="Checking project setup" /></AuthFrame>;
  }

  if (state === 'unavailable') {
    return (
      <AuthFrame eyebrow="FIRST RUN">
        <div className="auth-copy"><h1>Connect to your Modelry project</h1><p>Setup status is unavailable right now. Check that the Runtime is running, then try again.</p></div>
        <AuthError error={statusError} fallback="The Runtime could not be reached." title="Setup status could not be loaded" />
        <Button className="auth-submit" onClick={() => void checkStatus()} type="button" variant="primary">Retry setup check</Button>
      </AuthFrame>
    );
  }

  if (state === 'closed') {
    return (
      <AuthFrame eyebrow="FIRST RUN">
        <div className="auth-copy"><h1>Setup is already complete</h1><p>This project already has its Owner. Sign in to continue to the Admin.</p></div>
        <a className="auth-link auth-link--button" href={loginHref}>Sign in <ArrowRight aria-hidden="true" size={15} /></a>
      </AuthFrame>
    );
  }

  if (state === 'complete' && result) {
    return (
      <AuthFrame eyebrow="FIRST RUN">
        <AuthSuccess
          actionLabel="Continue to Modelry"
          description="Setup is complete. Your Owner session is active for this project."
          onContinue={onAuthenticated ? undefined : () => { window.location.assign('/'); }}
          result={result}
          title="Owner account ready"
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame eyebrow="FIRST RUN">
      <div className="auth-copy">
        <h1>Create your Modelry owner</h1>
        <p>This Owner manages the Modelry project. Use an email and password you can keep secure.</p>
      </div>
      {submitError !== undefined && (
        <>
          <AuthError error={submitError} fallback="The Runtime could not complete setup. Check the connection and try again." title="Owner setup could not be completed" />
          <Button className="auth-recheck" disabled={submitting} onClick={() => void checkStatus()} type="button" variant="quiet">Check setup status</Button>
        </>
      )}
      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        <AuthInput
          autoComplete="email"
          error={fieldViolation(submitError, 'email')}
          id="bootstrap-email"
          label="Email"
          onChange={setEmail}
          type="email"
          value={email}
        />
        <AuthInput
          autoComplete="new-password"
          error={fieldViolation(submitError, 'password')}
          id="bootstrap-password"
          label="Password"
          onChange={setPassword}
          type="password"
          value={password}
        />
        <Button className="auth-submit" disabled={submitting} type="submit" variant="primary">
          {submitting ? 'Creating owner…' : 'Complete setup'}
          {!submitting && <ArrowRight aria-hidden="true" size={16} />}
        </Button>
      </form>
      <p className="auth-note"><KeyRound aria-hidden="true" size={14} /> Bootstrap closes after the first Owner is created.</p>
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
      <AuthFrame eyebrow="OWNER SIGN IN">
        <AuthSuccess
          actionLabel="Continue to Modelry"
          description="You are signed in to this project with an active Owner session."
          onContinue={onAuthenticated ? undefined : () => { window.location.assign(destination); }}
          result={result}
          title="Owner session active"
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame eyebrow="OWNER SIGN IN">
      <div className="auth-copy"><h1>Sign in</h1><p>Use your Modelry Owner account to open this project.</p></div>
      {sessionExpired && <p className="auth-session-notice" role="status">Your session expired. Sign in to continue.</p>}
      {error !== undefined && <AuthError error={error} fallback="The Runtime could not complete sign in. Check the connection and try again." title="Could not sign in" />}
      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        <AuthInput
          autoComplete="username"
          error={fieldViolation(error, 'email')}
          id="login-email"
          label="Email"
          onChange={setEmail}
          type="email"
          value={email}
        />
        <AuthInput
          autoComplete="current-password"
          error={fieldViolation(error, 'password')}
          id="login-password"
          label="Password"
          onChange={setPassword}
          type="password"
          value={password}
        />
        <Button className="auth-submit" disabled={submitting} type="submit" variant="primary">
          {submitting ? 'Signing in…' : 'Sign in'}
          {!submitting && <ArrowRight aria-hidden="true" size={16} />}
        </Button>
      </form>
      {submitting && <span className="sr-only" role="status">Signing in</span>}
    </AuthFrame>
  );
}
