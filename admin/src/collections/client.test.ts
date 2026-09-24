import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySchemaChange, applyAccessRules, applyAuthenticationConfiguration, createCollection, createRecord, getApplicationUserSessions, listApplicationUsers, listCollections, listRecords, revokeAllApplicationUserSessions, revokeApplicationUserSession, saveAccessRules, saveAuthenticationConfiguration, savePendingOperation, setApplicationUserPassword, uploadCollectionFile } from './client';

describe('Collections API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends same-origin Control Plane requests with the Owner session cookie', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes('/collections?')) {
        return Promise.resolve(Response.json({ data: [{ id: 'col_1', name: 'posts', type: 'Normal', fields: [] }] }));
      }
      if (String(input).endsWith('/collections')) {
        return Promise.resolve(Response.json({ data: { id: 'col_2', name: 'posts', type: 'Normal', fields: [] } }, { status: 201 }));
      }
      return Promise.resolve(Response.json({ data: { changeSetId: 'chg_1', collectionId: 'col_2', version: 1, status: 'ready', operations: [] } }, { status: 201 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await listCollections();
    await createCollection({ name: 'posts', type: 'Normal', fields: [] });
    await savePendingOperation('col_2', { kind: 'field', action: 'add', definition: { name: 'title', type: 'text' } });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/admin/api/v1/collections?limit=100', expect.objectContaining({
      method: 'GET', credentials: 'include', mode: 'same-origin', cache: 'no-store',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/admin/api/v1/collections', expect.objectContaining({
      method: 'POST', credentials: 'include', mode: 'same-origin',
      body: JSON.stringify({ name: 'posts', type: 'Normal', fields: [] }),
    }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ credentials: 'include', mode: 'same-origin' }));
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/admin/api/v1/collections/col_2/schema/pending-operations');

    fetchMock.mockResolvedValueOnce(Response.json({ data: { state: 'applied' } }));
    await applySchemaChange('col_2', 1, false);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/admin/api/v1/collections/col_2/schema/apply');
  });

  it('preserves structured errors and request IDs for recovery UI', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      error: {
        code: 'CONFLICT', message: 'The schema changed elsewhere.',
        details: { violations: [{ path: '/expectedVersion', code: 'STALE', message: 'Reload the schema.' }] },
        hint: 'Refresh the page and review the current schema.', requestId: 'req_schema_1',
      },
    }, { status: 409, headers: { 'X-Request-Id': 'req_schema_1' } }))));

    await expect(applySchemaChange('col_2', 1, false)).rejects.toMatchObject({
      status: 409,
      apiError: {
        code: 'CONFLICT', message: 'The schema changed elsewhere.', requestId: 'req_schema_1',
        details: { violations: [{ path: '/expectedVersion', code: 'STALE', message: 'Reload the schema.' }] },
      },
    });
  });

  it('sends Record and Access Rule requests with same-origin Owner credentials and preserves URL context', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.includes('/records?')) return Promise.resolve(Response.json({ data: [], nextCursor: 'next-1' }));
      if (path.endsWith('/access-rules/apply')) return Promise.resolve(Response.json({ data: { applied: [], pending: [], version: 2 } }));
      if (path.endsWith('/access-rules')) return Promise.resolve(Response.json({ data: { applied: [], pending: [], version: 2 } }));
      if (path.endsWith('/records')) return Promise.resolve(Response.json({ data: { id: 'rec_1', createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z', title: 'Saved' } }, { status: 201 }));
      return Promise.resolve(Response.json({ data: { temporaryId: 'tmp_1', contentType: 'text/plain', size: 4 } }, { status: 201 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await listRecords('col/1', { search: 'hello world', filter: 'title eq "hello"', sort: 'title asc', cursor: 'cursor/1' });
    await createRecord('col/1', { title: 'Saved' });
    await saveAccessRules('col/1', 1, []);
    await applyAccessRules('col/1', 2);
    await uploadCollectionFile('col/1', 'attachment', new Blob(['data']));

    expect(page.nextCursor).toBe('next-1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/v1/collections/col%2F1/records?limit=50&cursor=cursor%2F1&search=hello+world&filter=title+eq+%22hello%22&sort=title+asc');
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ credentials: 'include', mode: 'same-origin', cache: 'no-store' }));
    }
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ values: { title: 'Saved' } }) }));
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/admin/api/v1/collections/col%2F1/access-rules');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/admin/api/v1/collections/col%2F1/access-rules/apply');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/admin/api/v1/collections/col%2F1/files?fieldName=attachment');
    expect(fetchMock.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' } }));
  });

  it('uses the independent Auth configuration and App User session contracts', async () => {
    const configuration = { emailPasswordEnabled: true, selfRegistration: false, sessionDurationDays: 7 };
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/users?limit=50')) return Promise.resolve(Response.json({ data: [{ recordId: 'rec_user', email: 'person@example.test' }], nextCursor: 'cursor_2' }));
      if (path.endsWith('/sessions')) return Promise.resolve(Response.json({ data: [{ id: 'ses_1', createdAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', status: 'active' }] }));
      if (path.endsWith('/authentication/apply')) return Promise.resolve(Response.json({ data: { applied: configuration, pending: configuration, version: 3 } }));
      if (path.endsWith('/authentication')) return Promise.resolve(Response.json({ data: { applied: configuration, pending: configuration, version: 2 } }));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await listApplicationUsers('col_auth')).data[0]?.email).toBe('person@example.test');
    expect((await getApplicationUserSessions('col_auth', 'rec_user'))[0]?.status).toBe('active');
    await saveAuthenticationConfiguration('col_auth', 2, configuration);
    expect((await applyAuthenticationConfiguration('col_auth', 3)).version).toBe(3);
    await setApplicationUserPassword('col_auth', 'rec_user', 'new-password');
    await revokeApplicationUserSession('col_auth', 'ses_1');
    await revokeAllApplicationUserSessions('col_auth', 'rec_user');

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      '/admin/api/v1/collections/col_auth/users?limit=50',
      '/admin/api/v1/collections/col_auth/users/rec_user/sessions',
      '/admin/api/v1/collections/col_auth/authentication',
      '/admin/api/v1/collections/col_auth/authentication/apply',
      '/admin/api/v1/collections/col_auth/users/rec_user/password',
      '/admin/api/v1/collections/col_auth/sessions/ses_1/revoke',
      '/admin/api/v1/collections/col_auth/users/rec_user/sessions/revoke-all',
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedVersion: 2, configuration }) }));
    expect(fetchMock.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ method: 'PUT', body: JSON.stringify({ password: 'new-password' }) }));
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === 'include' && init.mode === 'same-origin')).toBe(true);
  });
});
