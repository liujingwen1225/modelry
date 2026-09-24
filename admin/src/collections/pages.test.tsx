import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionsPage, CreateCollectionPage } from './pages';

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
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('Normal');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/v1/collections?limit=100', expect.objectContaining({
      credentials: 'include', mode: 'same-origin',
    }));
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
    expect(screen.getAllByText('System · Locked')).toHaveLength(3);
    await user.type(screen.getByRole('textbox', { name: 'Collection name' }), 'posts');
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

  it('marks duplicate initial field names inline and does not issue a create request', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/collections/new']}><CreateCollectionPage /></MemoryRouter>);

    await user.type(await screen.findByRole('textbox', { name: 'Collection name' }), 'posts');
    await user.type(screen.getByRole('textbox', { name: 'Field name 1' }), 'title');
    await user.click(screen.getByRole('button', { name: 'Add initial field' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name 2' }), 'TITLE');
    await user.click(screen.getByRole('button', { name: 'Create Collection' }));

    expect(await screen.findByText('Field names must be unique.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
