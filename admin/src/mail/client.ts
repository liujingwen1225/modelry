import { ApiClientError, getJson, type ApiError } from '../api/client';

export type MailSecurity = 'startTLS' | 'tls' | 'plaintext';
export type MailSecretReference = { secretId: string; name: string; configured: boolean };
export type MailProvider = {
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  fromAddress: string;
  fromName: string;
  username: MailSecretReference | null;
  password: MailSecretReference | null;
  revision: number;
  updatedAt: string;
};
export type MailProviderInput = {
  expectedRevision: number;
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  fromAddress: string;
  fromName: string;
  usernameSecretId: string;
  passwordSecretId: string;
};
export type MailTestResult = { state: string; message: string };
export type MailDelivery = {
  id: string;
  kind: string;
  recipient: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string;
  createdAt: string;
  completedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown, response: Response): ApiClientError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  const apiError: ApiError = {
    code: typeof envelope.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(envelope.code) ? envelope.code : 'INTERNAL_ERROR',
    message: 'The Mail request could not be completed.',
    details: isRecord(envelope.details) ? (envelope.details as Record<string, unknown>) : {},
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  };
  return new ApiClientError(response.status, apiError);
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiClientError(0, { code: 'NETWORK_ERROR', message: 'The Runtime could not be reached.', details: {}, requestId: 'unavailable' });
  }
  if (response.status === 204) return undefined;
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) throw errorFrom(payload, response);
  return payload;
}

function unwrap<T>(value: unknown): T {
  if (isRecord(value) && 'data' in value) return value.data as T;
  throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable response.', details: {}, requestId: 'unavailable' });
}

export async function fetchMailProvider(signal?: AbortSignal): Promise<MailProvider> {
  const value = await getJson('/admin/api/v1/mail', signal);
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new ApiClientError(0, { code: 'INTERNAL_ERROR', message: 'The Runtime returned an unreadable Mail snapshot.', details: {}, requestId: 'unavailable' });
  }
  return value.data as MailProvider;
}

export async function saveMailProvider(input: MailProviderInput): Promise<MailProvider> {
  return unwrap<MailProvider>(await request('/admin/api/v1/mail', { method: 'PUT', body: JSON.stringify(input) }));
}

export async function sendMailTest(recipient: string): Promise<MailTestResult> {
  return unwrap<MailTestResult>(await request('/admin/api/v1/mail/test', { method: 'POST', body: JSON.stringify({ recipient }) }));
}

export async function listMailDeliveries(signal?: AbortSignal): Promise<MailDelivery[]> {
  const value = await request('/admin/api/v1/mail/deliveries', { signal });
  return isRecord(value) && Array.isArray(value.data) ? (value.data as MailDelivery[]) : [];
}

export async function retryMailDelivery(deliveryId: string): Promise<MailDelivery> {
  const path = '/admin/api/v1/mail/deliveries/' + encodeURIComponent(deliveryId) + '/retry';
  return unwrap<MailDelivery>(await request(path, { method: 'POST' }));
}