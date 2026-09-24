import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRequestRecord, listRequestRecords, runApplicationRequest } from './workspace-client';

afterEach(() => vi.unstubAllGlobals());

const record = {
  requestId: 'req_12345678',
  time: '2026-09-24T10:00:00Z',
  collectionId: 'col_posts',
  endpoint: '/api/v1/posts',
  method: 'GET',
  status: 200,
  durationMs: 12,
  authenticationOutcome: 'anonymous',
  authorizationOutcome: 'allowed',
};

describe('API Workspace client', () => {
  it('reads Request Records using the Owner-protected Control Plane client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [record], nextCursor: 'cursor_2' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listRequestRecords({ limit: 20, search: 'req_123', filter: 'status eq 200', sort: 'time desc' })).resolves.toEqual({ data: [record], nextCursor: 'cursor_2' });

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/admin/api/v1/requests?limit=20&search=req_123&filter=status+eq+200&sort=time+desc');
    expect(init).toEqual(expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
  });

  it('reads a Request Detail from its canonical requestId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: record }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getRequestRecord('req_12345678')).resolves.toEqual(record);
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/requests/req_12345678', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('runs a real same-origin Application request without Owner cookies and redacts credential fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { id: 'rec_1', accessToken: 'app_secret_value', password: 'password-value' } }, {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_canonical_123456', 'X-Request-Record-Persisted': 'true' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runApplicationRequest({ method: 'POST', path: '/api/v1/posts', body: '{"values":{"title":"Hello"}}', applicationSession: 'session-secret' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/posts', expect.objectContaining({
      method: 'POST',
      credentials: 'omit',
      mode: 'same-origin',
      cache: 'no-store',
      headers: expect.objectContaining({ Accept: 'application/json', Authorization: 'Bearer session-secret', 'Content-Type': 'application/json' }),
      body: '{"values":{"title":"Hello"}}',
    }));
    expect(result).toMatchObject({ status: 201, requestId: 'req_canonical_123456', requestRecordPersisted: true, body: { data: { id: 'rec_1', accessToken: '[redacted]', password: '[redacted]' } } });
    expect(JSON.stringify(result)).not.toContain('session-secret');
    expect(JSON.stringify(result)).not.toContain('app_secret_value');
  });

  it('uses the response header as canonical Request ID for a structured failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { code: 'FORBIDDEN', message: 'Access denied.', details: {}, requestId: 'req_body_12345678' } }, {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_header_12345678', 'X-Request-Record-Persisted': 'false' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runApplicationRequest({ method: 'GET', path: '/api/v1/posts' });

    expect(result).toMatchObject({ status: 403, requestId: 'req_header_12345678', requestRecordPersisted: false, structuredError: { code: 'FORBIDDEN', message: 'Access denied.' } });
  });

  it('requests file bytes with wildcard Accept and never includes them in the response preview', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('private-file-bytes', {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Request-Id': 'req_file_123456' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runApplicationRequest({ method: 'GET', path: '/api/v1/posts/rec_1/files/attachment', accept: '*/*' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/posts/rec_1/files/attachment', expect.objectContaining({ headers: expect.objectContaining({ Accept: '*/*' }) }));
    expect(result).toMatchObject({ status: 200, requestId: 'req_file_123456', textResponseHidden: true });
    expect(JSON.stringify(result)).not.toContain('private-file-bytes');
  });

  it('rejects paths outside the Application API before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runApplicationRequest({ method: 'GET', path: 'https://example.test/api/v1/posts' })).rejects.toThrow('Application API paths must stay under /api/v1/.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
