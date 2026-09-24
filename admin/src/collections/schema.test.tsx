import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from './client';
import { CollectionWorkspacePage } from './pages';
import { CollectionSchemaPage } from './schema';
import { CommandRegistryProvider } from '../components/command-registry';
import { LocaleProvider } from '../i18n/i18n';

const collection: Collection = {
  id: 'col_posts', name: 'posts', type: 'Normal', schemaVersion: 1,
  fields: [
    { id: 'fld_id', name: 'id', type: 'text', required: true, system: true },
    { id: 'fld_created', name: 'createdAt', type: 'dateTime', required: true, system: true },
    { id: 'fld_updated', name: 'updatedAt', type: 'dateTime', required: true, system: true },
    { id: 'fld_title', name: 'title', type: 'text', required: true },
  ],
};

function renderSchema() {
  return render(<LocaleProvider><CommandRegistryProvider><MemoryRouter initialEntries={['/collections/col_posts/schema']}>
    <Routes>
      <Route element={<CollectionWorkspacePage />} path="/collections/:collectionId">
        <Route element={<CollectionSchemaPage />} path="schema" />
      </Route>
    </Routes>
  </MemoryRouter></CommandRegistryProvider></LocaleProvider>);
}

describe('Collection schema workflow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps system Fields locked, stages a durable edit, previews risk in place, and applies it', async () => {
    const user = userEvent.setup();
    let pending: Record<string, unknown> | null = null;
    let currentCollection = collection;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/schema/pending-change')) return Promise.resolve(Response.json({ data: pending }));
      if (path.includes('/schema/history')) return Promise.resolve(Response.json({ data: pending ? [] : [{
        id: 'mig_1', changeSetId: 'chg_1', collectionId: 'col_posts', applyAttemptId: 'attempt_1',
        appliedAt: '2026-09-24T10:00:00Z', diff: [{ kind: 'field', action: 'add', name: 'subtitle' }],
      }] }));
      if (path.endsWith('/schema/pending-operations') && init?.method === 'POST') {
        pending = {
          changeSetId: 'chg_1', collectionId: 'col_posts', version: 1, status: 'ready',
          operations: [{ id: 'op_1', kind: 'field', action: 'add', definition: { name: 'subtitle', type: 'text', required: false, unique: false } }],
        };
        return Promise.resolve(Response.json({ data: pending }, { status: 201 }));
      }
      if (path.endsWith('/schema/preview')) return Promise.resolve(Response.json({ data: {
        risk: 'review', version: 1,
        diff: [{ kind: 'field', action: 'add', name: 'subtitle' }],
        preconditions: [{ status: 'passed', message: 'The field name is available.' }],
        impact: { affectedCollections: 1, affectedFields: 1, affectedIndexes: 0, affectedRecords: 0, summary: 'No existing records are affected.' },
      } }));
      if (path.endsWith('/schema/apply')) {
        currentCollection = { ...collection, schemaVersion: 2, fields: [...collection.fields, { id: 'fld_subtitle', name: 'subtitle', type: 'text' }] };
        pending = null;
        return Promise.resolve(Response.json({ data: { state: 'applied', appliedMigrationId: 'mig_1', applyAttemptId: 'attempt_1' } }));
      }
      return Promise.resolve(Response.json({ data: currentCollection }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSchema();

    expect(await screen.findByRole('heading', { name: 'posts' })).toBeInTheDocument();
    expect(screen.getAllByText('System · Locked')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Remove id' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name' }), 'subtitle');
    await user.click(screen.getByRole('button', { name: 'Save to Pending Changes' }));

    expect(await screen.findByRole('region', { name: 'Pending schema changes' })).toHaveTextContent('1 pending change');
    expect(await screen.findByRole('rowheader', { name: 'subtitle' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review & apply' }));
    expect(await screen.findByRole('heading', { name: 'Review schema changes' })).toBeInTheDocument();
    expect(screen.getByText('No existing records are affected.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/schema/apply'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }));

    expect(await screen.findByText(/Schema changes applied\. The Collection now uses the updated model\./)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections/col_posts/schema/apply', expect.objectContaining({
      method: 'POST', credentials: 'include', mode: 'same-origin', body: JSON.stringify({ expectedVersion: 1, confirmRisk: true }),
    })));
    expect(screen.queryByRole('region', { name: 'Pending schema changes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Applied history' }));
    expect(await screen.findByText('Schema changes applied')).toBeInTheDocument();
    expect(screen.getByText('Technical details')).toBeInTheDocument();
  });

  it('restores a durable Pending Change after the page loads from a deep link', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/schema/pending-change')) return Promise.resolve(Response.json({ data: {
        changeSetId: 'chg_saved', collectionId: 'col_posts', version: 2, status: 'failed',
        operations: [{ id: 'op_saved', kind: 'field', action: 'add', definition: { name: 'summary', type: 'text' } }],
        recoveryState: { state: 'retryable', summary: 'The projection needs a retry.' },
      } }));
      return Promise.resolve(Response.json({ data: collection }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSchema();

    expect(await screen.findByRole('region', { name: 'Pending schema changes' })).toHaveTextContent('1 pending change');
    expect(screen.getAllByText('The projection needs a retry.')).toHaveLength(1);
    expect(await screen.findByRole('link', { name: 'Open recovery details' })).toHaveAttribute('href', '/changes?changeSet=chg_saved');
    expect(screen.getByRole('button', { name: 'Review and retry' })).toBeInTheDocument();
  });
});
