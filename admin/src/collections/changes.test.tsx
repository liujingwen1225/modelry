import { render as renderRTL, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('shows the actual before and after attributes once for an applied change', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'zh-CN');
    const migration = { id: 'mig_1', collectionId: 'col_posts', changeSetId: 'chg_applied', applyAttemptId: 'attempt_1', appliedAt: '2026-10-04T10:00:00Z', diff: [{
      kind: 'field', action: 'update', name: 'afd', before: { id: 'fld_1', name: 'afd', type: 'text', required: true }, after: { id: 'fld_1', name: 'afd', type: 'text', required: true, unique: true },
    }] };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/changes?')) return Promise.resolve(Response.json({ data: [migration] }));
      if (path.includes('/collections?')) return Promise.resolve(Response.json({ data: [{ id: 'col_posts', name: 'posts', fields: [] }] }));
      return Promise.resolve(Response.json({ data: { collectionId: 'col_posts', changeSetId: 'chg_applied', status: 'applied', version: 2,
        operations: [{ id: 'op_1', kind: 'field', action: 'update', definition: { name: 'afd', unique: true } }],
        applyAttempts: [], appliedMigration: migration,
      } }));
    }));
    await render(<MemoryRouter initialEntries={['/changes?tab=history&changeSet=chg_applied']}><ChangesPage /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '修改字段 afd' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '修改前' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '修改后' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: '唯一 否 是' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: '必填' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '待应用变更' })).not.toBeInTheDocument();
    expect(screen.queryByText('update field afd')).not.toBeInTheDocument();
  });

  it('restores a recovery deep link and keeps the selected Collection actionable', async () => {
    const user = userEvent.setup();
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
        applyAttempts: [{ id: 'attempt_1', changeSetId: 'chg_failed', status: 'recoveryRequired', startedAt: '2026-09-24T10:00:00Z', errorCode: 'PROJECTION_REPAIR_REQUIRED', recoveryState: { state: 'retryable', summary: 'The model projection needs a retry.', actions: ['Retry the outdated projection now.', 'Open the internal repair console.'] } }],
        recoveryState: { state: 'retryable', summary: 'The model projection needs a retry.', actions: ['Review the current model.', 'Retry the apply.'] },
      } }));
      return Promise.resolve(Response.json({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/changes?q=posts&view=pending&changeSet=chg_failed']}><ChangesPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'posts' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search changes' })).toHaveValue('posts');
    expect(screen.getByText('The last Apply attempt did not complete. Your Pending Change remains saved.')).toBeInTheDocument();
    expect(screen.queryByText('The model projection needs a retry.')).not.toBeInTheDocument();
    expect(screen.getByText('Review the current model.')).toBeInTheDocument();
    expect(screen.getByText('Retry the apply.')).toBeInTheDocument();
    expect(screen.getByText('PROJECTION_REPAIR_REQUIRED')).toBeInTheDocument();
    const technicalDetails = screen.getByText('Technical details').closest('[data-slot=collapsible]');
    expect(technicalDetails).not.toBeNull();
    await user.click(screen.getByText('Technical details'));
    expect(technicalDetails).toHaveAttribute('data-open');
    expect(technicalDetails?.textContent).toContain('attempt_1');
    expect(technicalDetails?.textContent).toContain('PROJECTION_REPAIR_REQUIRED');
    expect(technicalDetails?.textContent).toContain('2026-09-24T10:00:00Z');
    expect(technicalDetails?.textContent).not.toContain('The model projection needs a retry.');
    expect(technicalDetails?.textContent).not.toContain('Retry the outdated projection now.');
    expect(technicalDetails?.textContent).not.toContain('Open the internal repair console.');
    expect(screen.getByRole('link', { name: 'Continue recovery in Model' })).toHaveAttribute('href', '/collections/col_posts/model');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/changes/chg_failed', expect.objectContaining({
      method: 'GET', credentials: 'include', mode: 'same-origin',
    }));
  });

  it('applies a SAFE change directly from the review panel', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/changes?limit=100')) return Promise.resolve(Response.json({ data: [
        { changeSetId: 'chg_safe', collectionId: 'col_posts', version: 4, status: 'ready', operations: [
          { id: 'op_1', kind: 'field', action: 'add', definition: { name: 'publishedAt', type: 'dateTime' } },
        ] },
      ] }));
      if (path.endsWith('/collections?limit=100')) return Promise.resolve(Response.json({ data: [{ id: 'col_posts', name: 'posts', type: 'Normal', fields: [] }] }));
      if (path.endsWith('/changes/chg_safe')) return Promise.resolve(Response.json({ data: {
        changeSetId: 'chg_safe', collectionId: 'col_posts', status: 'ready', version: 4,
        operations: [{ id: 'op_1', kind: 'field', action: 'add', definition: { name: 'publishedAt', type: 'dateTime' } }],
        applyAttempts: [],
      } }));
      if (path.endsWith('/schema/preview')) return Promise.resolve(Response.json({ data: {
        risk: 'safe', version: 4, diff: [{ kind: 'field', action: 'add', name: 'publishedAt' }], preconditions: [], impact: {},
      } }));
      if (path.endsWith('/schema/apply')) return Promise.resolve(Response.json({ data: { state: 'applied', appliedMigrationId: 'mig_9', applyAttemptId: 'attempt_9' } }));
      return Promise.resolve(Response.json({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/changes?changeSet=chg_safe']}><ChangesPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'posts' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Review changes' }));

    // SAFE 变化不增加空确认步骤：预览后直接应用。
    expect(await screen.findByText('Changes applied. The updated model is now in effect.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections/col_posts/schema/apply', expect.objectContaining({
      method: 'POST', credentials: 'include', mode: 'same-origin', body: JSON.stringify({ expectedVersion: 4, confirmRisk: false }),
    }));
  });

  it('requires an in-page confirmation before applying a risky change', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/changes?limit=100')) return Promise.resolve(Response.json({ data: [
        { changeSetId: 'chg_risky', collectionId: 'col_posts', version: 5, status: 'needsReview', operations: [
          { id: 'op_1', kind: 'field', action: 'remove', targetId: 'fld_legacy', definition: {} },
        ] },
      ] }));
      if (path.endsWith('/collections?limit=100')) return Promise.resolve(Response.json({ data: [{ id: 'col_posts', name: 'posts', type: 'Normal', fields: [] }] }));
      if (path.endsWith('/changes/chg_risky')) return Promise.resolve(Response.json({ data: {
        changeSetId: 'chg_risky', collectionId: 'col_posts', status: 'needsReview', version: 5,
        operations: [{ id: 'op_1', kind: 'field', action: 'remove', targetId: 'fld_legacy', definition: {} }],
        applyAttempts: [],
      } }));
      if (path.endsWith('/schema/preview')) return Promise.resolve(Response.json({ data: {
        risk: 'review', version: 5, diff: [{ kind: 'field', action: 'remove', name: 'legacy' }],
        preconditions: [{ status: 'passed', code: 'MODEL_COMPATIBLE' }],
        impact: { summary: 'Existing records keep their values.', affectedRecords: 12 },
      } }));
      if (path.endsWith('/schema/apply')) return Promise.resolve(Response.json({ data: { state: 'applied', appliedMigrationId: 'mig_10', applyAttemptId: 'attempt_10' } }));
      return Promise.resolve(Response.json({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/changes?changeSet=chg_risky']}><ChangesPage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText('Review schema changes')).toBeInTheDocument();
    expect(screen.getByText('Existing records keep their values.')).toBeInTheDocument();
    expect(screen.getByText('12 records affected')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/schema/apply'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }));
    expect(await screen.findByText('Changes applied. The updated model is now in effect.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections/col_posts/schema/apply', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ expectedVersion: 5, confirmRisk: true }),
    }));
  });
});
