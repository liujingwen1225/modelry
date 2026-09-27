import { render as renderRTL, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { LocaleProvider } from '../i18n/i18n';
import { ChangesPage } from './changes';
// render 用 LocaleProvider 包裹页面，因为页面文案现在来自共享 i18n 层。
async function render(ui: React.ReactNode) {
  const result = renderRTL(<LocaleProvider>{ui}</LocaleProvider>);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
}

describe('Changes page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores a recovery deep link and keeps the selected Collection actionable', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/admin/api/v1/changes?limit=100')) return Promise.resolve(Response.json({ data: [
        { changeSetId: 'chg_failed', collectionId: 'col_posts', version: 2, status: 'failed', operations: [
          { id: 'op_1', kind: 'field', action: 'add', definition: { name: 'subtitle', type: 'text' } },
        ] },
      ] }));
      if (path.endsWith('/admin/api/v1/collections?limit=100')) return Promise.resolve(Response.json({ data: [
        { id: 'col_posts', name: 'posts', type: 'Normal', fields: [] },
      ] }));
      if (path.endsWith('/admin/api/v1/changes/chg_failed')) return Promise.resolve(Response.json({ data: {
        changeSetId: 'chg_failed', collectionId: 'col_posts', status: 'failed', version: 2,
        operations: [{ id: 'op_1', kind: 'field', action: 'add', definition: { name: 'subtitle', type: 'text' } }],
        applyAttempts: [{ id: 'attempt_1', changeSetId: 'chg_failed', status: 'recoveryRequired', startedAt: '2026-09-24T10:00:00Z', errorCode: 'PROJECTION_REPAIR_REQUIRED', recoveryState: { state: 'retryable', summary: 'The model projection needs a retry.' } }],
        recoveryState: { state: 'retryable', summary: 'The model projection needs a retry.', actions: ['Review the current model.', 'Retry the apply.'] },
      } }));
      return Promise.resolve(Response.json({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/changes?q=posts&view=pending&changeSet=chg_failed']}><ChangesPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'posts' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search changes' })).toHaveValue('posts');
    expect(screen.getAllByText('The model projection needs a retry.')).toHaveLength(1);
    expect(screen.getByText('PROJECTION_REPAIR_REQUIRED')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue recovery in Schema' })).toHaveAttribute('href', '/collections/col_posts/schema');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/changes/chg_failed', expect.objectContaining({
      method: 'GET', credentials: 'include', mode: 'same-origin',
    }));
  });
});
