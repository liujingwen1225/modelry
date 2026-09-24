import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAPIKey, createServiceAccount, listAPIKeys, listAuditRecords, listServiceAccounts, revokeAPIKey, setServiceAccountEnabled, updateServiceAccount } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Access and Audit client', () => {
  it('uses the Owner Control Plane client for Service Account lists and preserves cursors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'sa_1', name: 'ci', permission: 'readOnly', status: 'active' }], nextCursor: 'cursor_2' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listServiceAccounts({ limit: 20, cursor: 'cursor_1' })).resolves.toEqual({ data: [{ id: 'sa_1', name: 'ci', permission: 'readOnly', status: 'active' }], nextCursor: 'cursor_2' });
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/service-accounts?limit=20&cursor=cursor_1', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
  });

  it('creates a custom account and creates a one-time API Key reveal without returning a secret from later lists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { serviceAccount: { id: 'sa_1', name: 'deploy', permission: 'custom', status: 'active', customPermissionVersion: 1, customOperations: ['collections.read'] }, apiKeyReveal: { apiKey: { id: 'key_1', name: 'deploy-key', status: 'active', createdAt: '2026-09-24T10:00:00Z' }, secret: 'once-secret', revealedOnce: true } } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'key_1', name: 'deploy-key', status: 'active', createdAt: '2026-09-24T10:00:00Z' }] }))
      .mockResolvedValueOnce(Response.json({ data: { apiKey: { id: 'key_2', name: 'new-key', status: 'active', createdAt: '2026-09-24T10:00:00Z' }, secret: 'second-once-secret', revealedOnce: true } }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const created = await createServiceAccount({ name: 'deploy', permission: 'custom', createAPIKey: true, customPermissionVersion: 1, customOperations: ['collections.read'] });
    expect(created.apiKeyReveal?.secret).toBe('once-secret');
    const list = await listAPIKeys('sa_1');
    expect(list.data[0]).not.toHaveProperty('secret');
    const createdKey = await createAPIKey('sa_1', 'new-key');
    expect(createdKey.secret).toBe('second-once-secret');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ credentials: 'same-origin', body: JSON.stringify({ name: 'deploy', permission: 'custom', createAPIKey: true, customPermissionVersion: 1, customOperations: ['collections.read'] }) }));
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/admin/api/v1/service-accounts/sa_1/api-keys');
  });

  it('sends permission edits, enable/disable, and key revoke only to canonical Control Plane routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { id: 'sa_1', name: 'ci', permission: 'readOnly', status: 'active' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await updateServiceAccount('sa_1', { permission: 'readOnly' });
    await setServiceAccountEnabled('sa_1', false);
    await setServiceAccountEnabled('sa_1', true);
    await revokeAPIKey('key_1');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/admin/api/v1/service-accounts/sa_1',
      '/admin/api/v1/service-accounts/sa_1/disable',
      '/admin/api/v1/service-accounts/sa_1/enable',
      '/admin/api/v1/api-keys/key_1/revoke',
    ]);
  });

  it('applies Audit search and structured filters on the server before pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [], nextCursor: 'cursor_next' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAuditRecords({ limit: 50, cursor: 'cursor_1', search: 'schema', actorKind: 'owner', actorId: 'own_1', action: 'schema.change.applied', resourceKind: 'collection', resourceId: 'col_1', from: '2026-09-24T00:00:00Z', to: '2026-09-24T23:59:59Z' })).resolves.toEqual({ data: [], nextCursor: 'cursor_next' });
    const path = String(fetchMock.mock.calls[0]?.[0]);
    expect(path).toContain('/admin/api/v1/audit?');
    for (const field of ['search=schema', 'actorKind=owner', 'actorId=own_1', 'action=schema.change.applied', 'resourceKind=collection', 'resourceId=col_1', 'from=2026-09-24T00%3A00%3A00Z', 'to=2026-09-24T23%3A59%3A59Z', 'cursor=cursor_1']) expect(path).toContain(field);
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });
});
