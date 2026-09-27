import { ApiClientError, type ApiError } from '../api/client';

export type BootstrapStatus = { state: 'required' | 'closed' };

export type Owner = {
  id: string;
  email: string;
};

export type OwnerSession = {
  expiresAt: string;
};

export type ControlPlanePermission = {
  preset: 'fullAccess' | 'readOnly' | 'custom';
  customPermissionVersion?: number;
  customOperations?: string[];
};

export type ControlPlaneRole = 'owner' | 'administrator';

export type OwnerSessionResponse = {
  owner: Owner;
  expiresAt: string;
  role: ControlPlaneRole;
  permission: ControlPlanePermission;
};

export type OwnerCredentials = {
  email: string;
  password: string;
};

export type AuthenticatedOwner = {
  owner: Owner;
  session: OwnerSession;
};

type JsonResponse = {
  data: unknown;
  response: Response;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asApiError(value: unknown, response: Response): ApiError {
  const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
  return {
    code: typeof envelope.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
    message: typeof envelope.message === 'string'
      ? envelope.message
      : `The request failed with status ${response.status}.`,
    details: isRecord(envelope.details) ? envelope.details : {},
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    requestId:
      response.headers.get('X-Request-Id') ??
      (typeof envelope.requestId === 'string' ? envelope.requestId : 'unavailable'),
  };
}

async function readError(response: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return new ApiClientError(response.status, asApiError(body, response));
}

async function request(path: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    credentials: init.credentials ?? 'include',
    mode: 'same-origin',
    cache: 'no-store',
  });

  if (!response.ok) throw await readError(response);
  if (response.status === 204) return { data: undefined, response };

  try {
    return { data: await response.json(), response };
  } catch {
    throw new ApiClientError(response.status, {
      code: 'INTERNAL_ERROR',
      message: 'The Runtime returned an unreadable authentication response.',
      details: {},
      requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
    });
  }
}

function invalidResponse(response: Response, expected: string): never {
  throw new ApiClientError(response.status, {
    code: 'INTERNAL_ERROR',
    message: 'The Runtime returned an invalid authentication response.',
    details: { expected },
    requestId: response.headers.get('X-Request-Id') ?? 'unavailable',
  });
}

function parseOwner(value: unknown, response: Response): Owner {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.email !== 'string') {
    return invalidResponse(response, 'owner.id and owner.email');
  }
  return { id: value.id, email: value.email };
}

function parseSession(value: unknown, response: Response): OwnerSession {
  if (!isRecord(value) || typeof value.expiresAt !== 'string') {
    return invalidResponse(response, 'session.expiresAt');
  }
  return { expiresAt: value.expiresAt };
}

function parsePermission(value: unknown, response: Response): ControlPlanePermission {
  if (!isRecord(value)) return invalidResponse(response, 'permission.preset');
  if (value.preset !== 'fullAccess' && value.preset !== 'readOnly' && value.preset !== 'custom') {
    return invalidResponse(response, 'permission.preset');
  }
  return {
    preset: value.preset,
    ...(typeof value.customPermissionVersion === 'number' ? { customPermissionVersion: value.customPermissionVersion } : {}),
    ...(Array.isArray(value.customOperations)
      ? { customOperations: value.customOperations.filter((item): item is string => typeof item === 'string') }
      : {}),
  };
}

function parseRole(value: unknown, response: Response): ControlPlaneRole {
  if (value === 'owner' || value === 'administrator') return value;
  return invalidResponse(response, 'role: owner | administrator');
}

function parseAuthenticatedOwner(value: unknown, response: Response): AuthenticatedOwner {
  if (!isRecord(value)) return invalidResponse(response, 'owner and session');
  return {
    owner: parseOwner(value.owner, response),
    session: parseSession(value.session, response),
  };
}

export async function fetchBootstrapStatus(signal?: AbortSignal): Promise<BootstrapStatus> {
  const { data, response } = await request('/admin/api/v1/bootstrap/status', { method: 'GET', signal, credentials: 'omit' });
  if (!isRecord(data) || (data.state !== 'required' && data.state !== 'closed')) {
    return invalidResponse(response, 'state: required | closed');
  }
  return { state: data.state };
}

export async function createOwner(credentials: OwnerCredentials, signal?: AbortSignal): Promise<AuthenticatedOwner> {
  const { data, response } = await request('/admin/api/v1/bootstrap/owner', {
    method: 'POST',
    body: JSON.stringify(credentials),
    signal,
    credentials: 'include',
  });
  return parseAuthenticatedOwner(data, response);
}

export async function loginOwner(credentials: OwnerCredentials, signal?: AbortSignal): Promise<AuthenticatedOwner> {
  const { data, response } = await request('/admin/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
    signal,
  });
  return parseAuthenticatedOwner(data, response);
}

export async function fetchOwnerSession(signal?: AbortSignal): Promise<OwnerSessionResponse> {
  const { data, response } = await request('/admin/api/v1/auth/session', { method: 'GET', signal });
  if (!isRecord(data) || typeof data.expiresAt !== 'string') {
    return invalidResponse(response, 'owner, expiresAt, role and permission');
  }
  return {
    owner: parseOwner(data.owner, response),
    expiresAt: data.expiresAt,
    role: parseRole(data.role, response),
    permission: parsePermission(data.permission, response),
  };
}

export async function logoutOwner(signal?: AbortSignal): Promise<void> {
  await request('/admin/api/v1/auth/logout', { method: 'POST', signal });
}
