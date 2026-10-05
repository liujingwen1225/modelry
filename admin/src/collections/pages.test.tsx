import { render as renderRTL, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../i18n/i18n';
import { CollectionsPage, CreateCollectionPage } from './pages';

// render 用 LocaleProvider 包裹页面，因为页面文案现在来自共享 i18n 层。
async function render(ui: React.ReactNode) {
  const result = renderRTL(<LocaleProvider>{ui}</LocaleProvider>);
  await waitFor(() => expect(document.querySelector('.locale-load-state')).toBeNull());
  return result;
}

function response(data: unknown, status = 200) {
  return Response.json({ data }, { status });
}

describe('Collections pages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retains collection search, type, and sort state in the URL', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({
      data: [
        { id: 'col_posts', name: 'posts', type: 'Normal', description: 'Editorial content', fields: [{ id: 'fld_title', name: 'title', type: 'text' }] },
        { id: 'col_users', name: 'users', type: 'Auth', fields: [{ id: 'fld_email', name: 'email', type: 'text' }] },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/collections?q=post&type=Normal&sort=name']}><CollectionsPage /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: /posts/i })).toHaveAttribute('href', '/collections/col_posts');
    expect(screen.queryByRole('link', { name: /users/i })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search collections' })).toHaveValue('post');
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveTextContent('Normal');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections?limit=100', expect.objectContaining({
      credentials: 'include', mode: 'same-origin',
    }));
  });

  it('shows record and user Field counts in Cards and List and surfaces only active Change states', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({
      data: [
        { id: 'col_posts', name: 'posts', type: 'Normal', fields: [{ id: 'fld_id', name: 'id', type: 'text', system: true }, { id: 'fld_title', name: 'title', type: 'text' }, { id: 'fld_summary', name: 'summary', type: 'text' }], recordCount: 12, pendingChangeStatus: 'ready' },
        { id: 'col_authors', name: 'authors', type: 'Normal', fields: [{ id: 'fld_id', name: 'id', type: 'text', system: true }, { id: 'fld_name', name: 'name', type: 'text' }], recordCount: 0 },
        { id: 'col_drafts', name: 'drafts', type: 'Normal', fields: [{ id: 'fld_title', name: 'title', type: 'text' }], recordCount: 3, pendingChangeStatus: 'failed' },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/collections']}><CollectionsPage /></MemoryRouter>);

    expect(await screen.findByText('12 records')).toBeInTheDocument();
    expect(screen.getByText('2 fields')).toBeInTheDocument();
    expect(screen.getByText('Pending change')).toBeInTheDocument();
    expect(screen.getByText('0 records')).toBeInTheDocument();
    expect(screen.getAllByText('1 field')).toHaveLength(2);
    expect(screen.getByText('Failed change')).toBeInTheDocument();
    expect(screen.queryByText('No pending changes')).not.toBeInTheDocument();
    // 默认卡片，切换列表后仍保留同一组事实。
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('posts').closest('a')).toHaveTextContent('12 records');
    expect(screen.getByText('posts').closest('tr')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    const postsRow = screen.getByText('posts').closest('tr');
    expect(postsRow).toHaveTextContent('12 records · 2 fields');
    expect(postsRow).toHaveTextContent('Pending change');
    const authorsRow = screen.getByText('authors').closest('tr');
    expect(authorsRow).toHaveTextContent('0 records · 1 field');
    expect(authorsRow).not.toHaveTextContent('change');

    // 密度切换：Cards 视图保留同一组事实。
    await user.click(screen.getByRole('button', { name: 'Cards' }));
    expect(screen.getByText('posts').closest('a')).toHaveTextContent('12 records');
    expect(screen.getByText('Pending change')).toBeInTheDocument();
    expect(screen.getByText('Failed change')).toBeInTheDocument();
    expect(screen.getByText('authors').closest('a')).not.toHaveTextContent('change');
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByText('posts').closest('tr')).toHaveTextContent('12 records · 2 fields');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a Collection with its initial Fields and shows the durable result in the workspace', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/collections') && init?.method === 'POST') {
        return Promise.resolve(response({
          id: 'col_posts', name: 'posts', type: 'Normal', fields: [
            { id: 'fld_id', name: 'id', type: 'text', system: true },
            { id: 'fld_created', name: 'createdAt', type: 'dateTime', system: true },
            { id: 'fld_updated', name: 'updatedAt', type: 'dateTime', system: true },
            { id: 'fld_title', name: 'title', type: 'text', required: true },
          ],
        }, 201));
      }
      return Promise.resolve(Response.json({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/collections/new']}>
        <Routes>
          <Route element={<CreateCollectionPage />} path="/collections/new" />
          <Route element={<h1>Workspace for posts</h1>} path="/collections/:collectionId" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Create Collection' })).toBeInTheDocument();
    expect(screen.getByText('System fields')).toBeInTheDocument();
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('createdAt')).toBeInTheDocument();
    expect(screen.getByText('updatedAt')).toBeInTheDocument();
    expect(screen.getAllByText('System · Locked')).toHaveLength(1);
    await user.type(screen.getByRole('textbox', { name: 'Collection name' }), 'posts');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    await user.clear(screen.getByRole('textbox', { name: 'Field name 1' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name 1' }), 'title');
    await user.click(screen.getByRole('checkbox', { name: 'Required' }));
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));

    expect(await screen.findByRole('heading', { name: 'Workspace for posts' })).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith('/collections') && init?.method === 'POST');
    expect(createCall?.[1]).toEqual(expect.objectContaining({
      credentials: 'include', mode: 'same-origin', method: 'POST',
      body: JSON.stringify({
        name: 'posts', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true, unique: false }],
      }),
    }));
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/collections?limit=100'))).toBe(true);
  });

  it('keeps Auth defaults visible and submits changes with the Auth Collection', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/collections') && init?.method === 'POST') {
        return Promise.resolve(response({ id: 'col_members', name: 'members', type: 'Auth', fields: [] }, 201));
      }
      return Promise.resolve(Response.json({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/collections/new']}>
        <Routes>
          <Route element={<CreateCollectionPage />} path="/collections/new" />
          <Route element={<h1>Workspace for members</h1>} path="/collections/:collectionId" />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('radio', { name: 'Auth Collection' }));
    expect(screen.getByText('Email + password')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Allow users to sign up' })).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Session duration (days)' })).toHaveValue(7);
    await user.type(screen.getByRole('textbox', { name: 'Collection name' }), 'members');
    await user.click(screen.getByRole('checkbox', { name: 'Allow users to sign up' }));
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));

    expect(await screen.findByRole('heading', { name: 'Workspace for members' })).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith('/collections') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual(expect.objectContaining({
      name: 'members', type: 'Auth', authentication: {
        emailPasswordEnabled: true, selfRegistration: true, sessionDurationDays: 7,
      },
    }));
  });

  it('adds fields beneath id and submits removed timestamps and advanced settings', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(
      init?.method === 'POST' ? { id: 'col_minimal', name: 'minimal', type: 'Normal', fields: [] } : [],
    )));
    vi.stubGlobal('fetch', fetchMock);
    await render(<MemoryRouter><CreateCollectionPage /></MemoryRouter>);
    expect(screen.queryByRole('textbox', { name: 'Field name 1' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    await user.clear(screen.getByRole('textbox', { name: 'Field name 1' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name 1' }), 'title');
    const rows = document.querySelector('[data-field-list]')!.querySelectorAll('[data-locked-field-row], [data-initial-field-row]');
    expect(rows[0]).toHaveTextContent('id');
    expect(rows[1]).toContainElement(screen.getByRole('textbox', { name: 'Field name 1' }));
    expect(screen.queryByRole('textbox', { name: 'Default value (JSON)' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Field settings: title' }));
    await user.type(screen.getByRole('textbox', { name: 'Default value (JSON)' }), '"untitled"');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove createdAt' }));
    await user.click(screen.getByRole('button', { name: 'Remove updatedAt' }));
    expect(screen.queryByText('createdAt')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove id' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Collection name' }), 'minimal');
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({name: 'minimal', type: 'Normal', fields: [{name: 'title', type: 'text', required: false, unique: false, default: 'untitled'}], omitSystemFields: ['createdAt', 'updatedAt']});
  });

  it('selects a type before inserting a field and supplies an editable unused name', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(
      init?.method === 'POST' ? { id: 'col_counts', name: 'counts', type: 'Normal', fields: [] } : [],
    )));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><CreateCollectionPage /></MemoryRouter>);
    await user.type(await screen.findByRole('textbox', { name: 'Collection name' }), 'counts');
    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.queryByRole('textbox', { name: 'Field name 1' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Number' }));
    const first = screen.getByRole('textbox', { name: 'Field name 1' });
    expect(first).toHaveValue('number_1');
    await user.clear(first);
    await user.type(first, 'NUMBER_2');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Number' }));
    expect(screen.getByRole('textbox', { name: 'Field name 2' })).toHaveValue('number_1');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('button', { name: 'Number' }));
    expect(screen.getByRole('textbox', { name: 'Field name 3' })).toHaveValue('number_3');
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body)).fields).toEqual([
      { name: 'NUMBER_2', type: 'number', required: false, unique: false },
      { name: 'number_1', type: 'number', required: false, unique: false },
      { name: 'number_3', type: 'number', required: false, unique: false },
    ]);
  });

  it('marks duplicate initial field names inline and does not issue a create request', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/collections/new']}><CreateCollectionPage /></MemoryRouter>);

    await user.type(await screen.findByRole('textbox', { name: 'Collection name' }), 'posts');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    await user.clear(screen.getByRole('textbox', { name: 'Field name 1' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name 1' }), 'title');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    await user.clear(screen.getByRole('textbox', { name: 'Field name 2' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name 2' }), 'TITLE');
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));

    expect(await screen.findByText('Field names must be unique.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
