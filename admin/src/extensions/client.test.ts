import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { createSecret, listExtensionRuns, listSecrets, replaceExtension, setExtensionEnabled } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Extensions Control Plane client', () => {
  it('keeps Hook Run pages bounded and carries only the contract cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [], nextCursor: 'opaque-next' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listExtensionRuns('ext/one', { limit: 100, cursor: 'opaque cursor' })).resolves.toEqual({ data: [], nextCursor: 'opaque-next' });
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/extensions/ext%2Fone/runs?limit=100&cursor=opaque+cursor', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', mode: 'same-origin' }));
  });

  it('sends a write-only Secret once and never keeps the value in an error object', async () => {
    const secret = 'never-return-this-secret';
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      error: { code: 'VALIDATION_FAILED', message: `Rejected ${secret}`, details: { secret } },
    }, { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSecret('Provider token', secret)).rejects.toMatchObject({
      apiError: { code: 'VALIDATION_FAILED', details: {} },
    });
    const error = await createSecret('Provider token', secret).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/secrets', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ name: 'Provider token', value: secret }),
    }));
  });

  it('keeps only allowlisted Extension validation and Binding conflict details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: {
        code: 'VALIDATION_FAILED', message: 'bad source secret',
        details: { violations: [{ path: '/source', code: 'invalidSource', message: 'guest controlled secret' }, { path: '/bindings', code: 'tooManyBindings', message: 'ignored' }, { path: '/secret', code: 'invalidSource', message: 'ignored' }] },
      } }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ error: {
        code: 'BINDING_CONFLICT', message: 'conflict',
        details: { collectionId: 'col_profile', operation: 'create', phase: 'before', owner: 'secret' },
      } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    const validation = await replaceExtension('ext_1', {
      name: 'Profile', language: 'javascript', source: 'source', bindings: [], secretBindings: [], allowedOrigins: [],
    }).catch((reason: unknown) => reason);
    expect(validation).toMatchObject({ apiError: { details: { violations: [{ path: '/source', code: 'invalidSource', message: 'Review this field.' }, { path: '/bindings', code: 'tooManyBindings', message: 'Review this field.' }] } } });
    expect(JSON.stringify(validation)).not.toContain('guest controlled secret');

    const conflict = await setExtensionEnabled('ext_1', true).catch((reason: unknown) => reason);
    expect(conflict).toMatchObject({ apiError: { details: { collectionId: 'col_profile', operation: 'create', phase: 'before' } } });
    expect(JSON.stringify(conflict)).not.toContain('secret');
  });

  it('replaces the full Extension configuration and uses explicit enable actions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { id: 'ext_1', enabled: true } }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'ext_1', enabled: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const draft = {
      name: 'Normalize Profile', language: 'typescript' as const, source: 'export function beforeCreate() { return { action: "allow" }; }',
      bindings: [{ collectionId: 'col_1', operation: 'create' as const, phase: 'before' as const }],
      secretBindings: [{ alias: 'MAIL_KEY', secretId: 'sec_1' }], allowedOrigins: ['https://api.example.test'],
    };

    await replaceExtension('ext_1', draft);
    await expect(setExtensionEnabled('ext_1', true)).resolves.toEqual({ id: 'ext_1', enabled: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/admin/api/v1/extensions/ext_1', expect.objectContaining({ method: 'PUT', body: JSON.stringify(draft) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/admin/api/v1/extensions/ext_1/enable', expect.objectContaining({ method: 'POST' }));
  });

  it('reads metadata-only Secret lists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'sec_1', name: 'Mail', configured: true, createdAt: 'now', updatedAt: 'now' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listSecrets()).resolves.toMatchObject([{ id: 'sec_1', configured: true }]);
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/secrets', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });
});
