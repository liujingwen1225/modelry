import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../i18n/i18n';
import { OwnerSessionProvider } from '../auth/owner-session';
import { AgentSettingsPage } from './settings';
import { AgentWorkspace } from './pages';
import type { AgentOperation, AgentSession } from './client';

const owner = {owner: {id: 'own_test', email: 'owner@example.test'}, role: 'owner', permission: {preset: 'fullAccess'}, expiresAt: '2027-01-01T00:00:00Z'};
const config = {baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyConfigured: true, revision: 1};
const policy = {mode: 'confirmWrites', allowedOperations: ['records.create'], autoOperations: [], revision: 0};
function renderAgent(children: React.ReactNode, path: string) {window.localStorage.setItem('modelry-admin-locale', 'zh-CN'); return render(<LocaleProvider><OwnerSessionProvider><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></OwnerSessionProvider></LocaleProvider>);}
afterEach(() => {vi.unstubAllGlobals(); window.localStorage.clear();});

describe('Agent 设置与确认', () => {
  it('模型密钥只写入，保存后清空输入且测试使用保存的配置', async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/auth/session') return Promise.resolve(Response.json(owner));
      if (path.endsWith('/agent/config')) return Promise.resolve(Response.json({data: {...config, revision: init?.method === 'PUT' ? 2 : 1}}));
      if (path.endsWith('/agent/config/test')) return Promise.resolve(Response.json({data: {connected: true}}));
      if (path.endsWith('/agent/policies/builtin')) return Promise.resolve(Response.json({data: policy}));
      if (path.endsWith('/agent/tools')) return Promise.resolve(Response.json({data: []}));
      return Promise.reject(new Error('未知测试请求'));
    });
    vi.stubGlobal('fetch', fetchMock); renderAgent(<AgentSettingsPage />, '/settings/agent');
    const input = await screen.findByLabelText('API Key');
    expect(input).toHaveAttribute('type', 'password'); expect(input).toHaveValue('');
    const user = userEvent.setup(); await user.type(input, 'test-key-only-written'); await user.click(screen.getByRole('button', {name: '保存模型设置'}));
    await waitFor(() => expect(input).toHaveValue(''));
    const save = fetchMock.mock.calls.find(([path, init]) => path.endsWith('/config') && init?.method === 'PUT');
    expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({apiKey: 'test-key-only-written', revision: 1, model: 'deepseek-flash'});
    await user.click(screen.getByRole('button', {name: '测试已保存的连接'})); expect(await screen.findByText('模型连接成功')).toBeVisible();
  });
  it('普通操作批次确认只提交固定清单，高风险操作不能加入批次', async () => {
    const operations: AgentOperation[] = ['one', 'two', 'risk'].map((id, i) => ({id, sessionId: 'ags_test', name: i < 2 ? 'records_create' : 'schema_apply', title: id, arguments: i < 2 ? {body: {values: {title: id}}, collectionId: 'col_test'} : {body: {expectedVersion: 1}, collectionId: 'col_test'}, state: 'awaitingApproval', risk: i === 2, requestId: 'req_test', createdAt: '2026-10-04T00:00:00Z'}));
    const session: AgentSession = {id: 'ags_test', title: 'MCP 测试', actor: {identity: 'sa_test', kind: 'serviceAccount', id: 'sa_test'}, state: 'awaitingApproval', operations, messages: [], dataGrants: [], sequence: 1, updatedAt: '2026-10-04T00:00:00Z'};
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/admin/api/v1/auth/session') return Promise.resolve(Response.json(owner));
      if (path.endsWith('/agent/config')) return Promise.resolve(Response.json({data: config}));
      if (path.endsWith('/agent/sessions')) return Promise.resolve(Response.json({data: [session]}));
      if (path.endsWith('/agent/sessions/ags_test')) return Promise.resolve(Response.json({data: session}));
      if (path.endsWith('/approve-batch')) {const ids = (JSON.parse(String(init?.body)) as {operationIds: string[]}).operationIds; for (const op of operations) if (ids.includes(op.id)) op.state = 'succeeded'; return Promise.resolve(Response.json({data: operations}));}
      if (path.startsWith('/admin/api/v1/collections')) return Promise.resolve(Response.json({data: []}));
      return Promise.reject(new Error('未知测试请求'));
    });
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', class {addEventListener() {} close() {}});
    renderAgent(<AgentWorkspace />, '/agent?session=ags_test');
    await screen.findByText('此会话由外部 MCP 智能体发起；可在这里复核、确认和查看结果。');
    expect(screen.getAllByRole('checkbox', { name: '加入本次批次' })).toHaveLength(2);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', {name: '选择普通操作'})); await user.click(screen.getByRole('button', {name: '确认所选 2 项'}));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/approve-batch'))).toBe(true));
    const batch = fetchMock.mock.calls.find(([path]) => path.endsWith('/approve-batch')); expect(JSON.parse(String(batch?.[1]?.body))).toEqual({operationIds: ['one', 'two']});
  });
  it('访问规则应用展示实际操作和前后访问范围', async () => {
    const operation: AgentOperation = {id:'rule', sessionId:'s_rule', name:'access_rules_apply', title:'应用访问规则', arguments:{collectionId:'col_test',body:{expectedVersion:2}}, state:'awaitingApproval', risk:true, requestId:'req_test',createdAt:'2026-10-04T00:00:00Z', before:{data:{applied:[{operation:'list',mode:'noAccess'}],pending:[{operation:'list',mode:'anyone'}]}}};
    const session: AgentSession = {id:'s_rule',title:'规则复核',actor:{identity:'builtin',kind:'owner',id:'own_test'},state:'awaitingApproval',messages:[],operations:[operation],dataGrants:[],sequence:1,updatedAt:'2026-10-04T00:00:00Z'};
    vi.stubGlobal('EventSource',class{addEventListener(){} close(){}});
    vi.stubGlobal('fetch',vi.fn((path:string)=>Promise.resolve(Response.json(path==='/admin/api/v1/auth/session'?owner:{data:path.endsWith('/config')?config:path.endsWith('/sessions')?[session]:path.includes('/sessions/')?session:[]}))));
    renderAgent(<AgentWorkspace />, '/agent?session=s_rule');
    expect(await screen.findByText('任何人')).toBeVisible(); expect(screen.getByText('无访问权限')).toBeVisible();
    expect(screen.queryByRole('checkbox',{name:'加入本次批次'})).not.toBeInTheDocument();
  });

});
