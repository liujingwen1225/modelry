import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessPage, AuditPage } from './pages';

const mocks = vi.hoisted(() => ({
  listServiceAccounts: vi.fn(), createServiceAccount: vi.fn(), getServiceAccount: vi.fn(), updateServiceAccount: vi.fn(),
  listAPIKeys: vi.fn(), createAPIKey: vi.fn(), revokeAPIKey: vi.fn(), setServiceAccountEnabled: vi.fn(),
  listAuditRecords: vi.fn(), getAuditRecord: vi.fn(),
}));

vi.mock('./client', () => mocks);
vi.mock('../auth/owner-session', () => ({ useOwnerSession: () => ({ state: { status: 'authenticated', session: { owner: { id: 'own_1', email: 'owner@example.com' }, expiresAt: '2026-09-24T12:00:00Z' } } }) }));

const account = { id: 'sa_1', name: 'ci-readonly', description: 'Build pipeline', permission: 'readOnly' as const, status: 'active' as const, createdAt: '2026-09-24T10:00:00Z' };
const activeKey = { id: 'key_1', name: 'build-key', status: 'active' as const, createdAt: '2026-09-24T10:00:00Z' };
const revokedKey = { ...activeKey, status: 'revoked' as const };
const audit = { id: 'audit_1', requestId: 'req_1', time: '2026-09-24T10:00:00Z', actor: { kind: 'owner' as const, id: 'own_1' }, action: 'serviceAccount.created', resource: { kind: 'serviceAccount', id: 'sa_1', name: 'ci-readonly' }, result: 'success' };

function CurrentLocation() { const location = useLocation(); return <output data-testid="current-location">{location.pathname}{location.search}</output>; }

function renderAccess(path = '/access') {
  return render(<MemoryRouter initialEntries={[path]}><CurrentLocation /><Routes>
    <Route element={<AccessPage />} path="/access" />
    <Route element={<AuditPage />} path="/access/audit" />
    <Route element={<AuditPage />} path="/access/audit/:auditRecordId" />
  </Routes></MemoryRouter>);
}

describe('Access and Audit pages', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listServiceAccounts.mockResolvedValue({ data: [] });
    mocks.createServiceAccount.mockResolvedValue({ serviceAccount: account, apiKeyReveal: { apiKey: activeKey, secret: 'once-secret-value', revealedOnce: true } });
    mocks.getServiceAccount.mockResolvedValue(account);
    mocks.listAPIKeys.mockResolvedValue({ data: [activeKey] });
    mocks.createAPIKey.mockResolvedValue({ apiKey: { ...activeKey, id: 'key_2' }, secret: 'new-once-secret', revealedOnce: true });
    mocks.revokeAPIKey.mockResolvedValue(undefined);
    mocks.setServiceAccountEnabled.mockResolvedValue(undefined);
    mocks.listAuditRecords.mockResolvedValue({ data: [audit], nextCursor: 'audit_cursor_2' });
    mocks.getAuditRecord.mockResolvedValue(audit);
  });

  it('creates a Read only Service Account with a one-time Key reveal, then never shows the secret in detail', async () => {
    const user = userEvent.setup();
    let revoked = false;
    mocks.listAPIKeys.mockImplementation(async () => ({ data: [revoked ? revokedKey : activeKey] }));
    renderAccess();

    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('No Service Accounts yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Create Service Account' })[0]!);
    const createForm = document.querySelector<HTMLFormElement>('form.access-form')!;
    await user.type(createForm.querySelector('#account-name')!, 'ci-readonly');
    await user.click(createForm.querySelector('button[type="submit"]')!);

    expect(await screen.findByText('once-secret-value')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Copy your API Key now' })).toBeInTheDocument();
    expect(screen.getByText('once-secret-value')).toBeInTheDocument();
    expect(mocks.createServiceAccount).toHaveBeenCalledWith(expect.objectContaining({ name: 'ci-readonly', permission: 'readOnly', createAPIKey: true }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'ci-readonly' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('once-secret-value');
    expect(screen.getByRole('table', { name: 'API Key metadata' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const revokeDialog = screen.getByRole('dialog', { name: 'Revoke this API Key?' });
    revoked = true;
    await user.click(within(revokeDialog).getByRole('button', { name: 'Revoke API Key' }));
    expect(await screen.findByText('revoked')).toBeInTheDocument();
    expect(mocks.revokeAPIKey).toHaveBeenCalledWith('key_1');
    expect(document.body.textContent).not.toContain('once-secret-value');
  });

  it('saves Custom Permission as a typed versioned operation set', async () => {
    const user = userEvent.setup();
    mocks.createServiceAccount.mockResolvedValue({ serviceAccount: { ...account, permission: 'custom', customPermissionVersion: 1, customOperations: ['collections.read'] } });
    renderAccess();
    await user.click(await screen.findByRole('button', { name: 'Create Service Account' }));
    const form = document.querySelector<HTMLFormElement>('form.access-form')!;
    await user.type(form.querySelector('#account-name')!, 'model-reader');
    await user.selectOptions(form.querySelector('#account-permission')!, 'custom');
    await user.click(form.querySelector('input[value="collections.read"]')!);
    await user.click(form.querySelector('.access-checkbox input')!);
    await user.click(form.querySelector('button[type="submit"]')!);
    await waitFor(() => expect(mocks.createServiceAccount).toHaveBeenCalledWith(expect.objectContaining({ permission: 'custom', customPermissionVersion: 1, customOperations: ['collections.read'], createAPIKey: false })));
  });

  it('sends Audit filters to the server and retains them across cursor pages and detail links', async () => {
    const user = userEvent.setup();
    const path = '/access/audit?search=schema&actorKind=owner&actorId=own_1&action=schema.change.applied&resourceKind=collection&resourceId=col_1&from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-24T23%3A59%3A59.000Z';
    renderAccess(path);

    expect(await screen.findByRole('link', { name: /2026/ })).toBeInTheDocument();
    expect(mocks.listAuditRecords).toHaveBeenCalledWith(expect.objectContaining({ search: 'schema', actorKind: 'owner', actorId: 'own_1', action: 'schema.change.applied', resourceKind: 'collection', resourceId: 'col_1', from: '2026-09-24T00:00:00.000Z', to: '2026-09-24T23:59:59.000Z', limit: 50 }), expect.any(AbortSignal));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getByTestId('current-location').textContent).toContain('cursor=audit_cursor_2'));
    expect(screen.getByTestId('current-location').textContent).toContain('actorKind=owner');
    expect(screen.getByTestId('current-location').textContent).toContain('resourceId=col_1');
  });

  it('opens an Audit detail through a durable deep link and redacts nested secret metadata', async () => {
    mocks.getAuditRecord.mockResolvedValue({ ...audit, resource: { kind: 'serviceAccount', id: 'sa_1', nested: { apiKeySecret: 'do-not-render' } } });
    renderAccess('/access/audit/audit_1?from=%2Faccess%2Faudit%3Faction%3DserviceAccount.created');

    expect(await screen.findByRole('heading', { name: 'Audit details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Audit' })).toHaveAttribute('href', '/access/audit?action=serviceAccount.created');
    expect(document.body.textContent).toContain('[redacted]');
    expect(document.body.textContent).not.toContain('do-not-render');
  });
});
