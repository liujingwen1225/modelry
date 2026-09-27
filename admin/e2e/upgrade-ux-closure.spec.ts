import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

type RuntimeProcess = ChildProcessWithoutNullStreams;
type ReadyRecord = { state: string; url: string; projectId: string };

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'owner@example.test';
const ownerPassword = 'Very-Strong-Owner-Password-42!';
const baselineRef = 'f8cf823a7ddd1e03fd2851458485bf365820d8f6';

let workspace = '';
let baselineWorktree = '';
let legacyRoot = '';
let legacyBinary = '';
let currentBinary = '';
let runtimeLauncher = '';
let runtimeProcess: RuntimeProcess | undefined;
let runtimeProcessId: number | undefined;
let runtimeURL = '';

function runChecked(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
}

function buildAdmin() {
  const npmCLI = process.env.npm_execpath;
  if (npmCLI) {
    runChecked(process.execPath, [npmCLI, '--prefix', adminDirectory, 'run', 'build'], repositoryRoot);
    return;
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCommand, ['--prefix', adminDirectory, 'run', 'build'], {
    cwd: repositoryRoot, stdio: 'inherit', env: process.env, shell: process.platform === 'win32',
  });
}

function interruptWindowsRuntime(processId: number) {
  const members = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);';
  const command = '$member = \'' + members + '\'\nAdd-Type -Namespace Modelry -Name ConsoleControl -MemberDefinition $member\n[void][Modelry.ConsoleControl]::FreeConsole()\nif (-not [Modelry.ConsoleControl]::AttachConsole([uint32]' + processId + ')) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not attach to the Runtime console (Win32 error $errorCode)." }\nif (-not [Modelry.ConsoleControl]::GenerateConsoleCtrlEvent(1, [uint32]' + processId + ')) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not send a graceful Runtime interrupt (Win32 error $errorCode)." }\n[void][Modelry.ConsoleControl]::FreeConsole()';
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: repositoryRoot, stdio: 'inherit' });
}

async function startRuntime(binary: string, root: string): Promise<ReadyRecord> {
  runtimeProcessId = undefined;
  const isWindows = process.platform === 'win32';
  const command = isWindows ? runtimeLauncher : binary;
  const runtimeArgs = ['start', '--project-root', root, '--listen', '127.0.0.1:0'];
  const args = isWindows ? [binary, ...runtimeArgs] : runtimeArgs;
  const child = spawn(command, args, { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  runtimeProcess = child;
  let stdoutBuffer = '';
  let stderr = '';
  const record = await new Promise<ReadyRecord>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime did not emit READY. stderr: ' + stderr)), 60_000);
    let ready: ReadyRecord | undefined;
    const finishWhenReady = () => {
      if (!ready || (isWindows && !runtimeProcessId)) return;
      clearTimeout(timeout);
      resolve(ready);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('RUNTIME_PID ')) { runtimeProcessId = Number(line.slice('RUNTIME_PID '.length)); finishWhenReady(); continue; }
        if (!line.startsWith('READY ')) continue;
        try { ready = JSON.parse(line.slice('READY '.length)) as ReadyRecord; } catch (error) { reject(error); return; }
        finishWhenReady();
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) return;
      clearTimeout(timeout);
      reject(new Error('Runtime exited before READY (code=' + String(code) + ', signal=' + String(signal) + '). stderr: ' + stderr));
    });
  });
  if (record.state !== 'ready' || !record.url || !record.projectId) throw new Error('Invalid READY record: ' + JSON.stringify(record));
  runtimeURL = record.url;
  return record;
}

async function stopRuntime() {
  const child = runtimeProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime did not stop after graceful cancellation.')), 15_000);
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  if (process.platform === 'win32') {
    if (!runtimeProcessId) throw new Error('Runtime launcher did not report a process id.');
    interruptWindowsRuntime(runtimeProcessId);
  } else {
    child.kill('SIGINT');
  }
  expect(await exited, 'Runtime must finish its graceful shutdown path').toEqual({ code: 0, signal: null });
  runtimeProcess = undefined;
}

async function requestJSON(page: Page, method: string, requestPath: string, body?: unknown) {
  return page.evaluate(async (input) => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: input.path.startsWith('/admin/') ? 'include' : 'omit',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    return { status: response.status, text };
  }, { method, path: requestPath, body });
}

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'modelry-wp29-'));
  legacyRoot = path.join(workspace, 'legacy-project');
  await mkdir(legacyRoot);
  buildAdmin();
  currentBinary = path.join(workspace, process.platform === 'win32' ? 'modelry-current.exe' : 'modelry-current');
  runChecked(goCommand, ['build', '-o', currentBinary, './cmd/modelry'], repositoryRoot);
  legacyBinary = path.join(workspace, process.platform === 'win32' ? 'modelry-v01.exe' : 'modelry-v01');
  baselineWorktree = path.join(workspace, 'baseline');
  runChecked('git', ['worktree', 'add', '--detach', baselineWorktree, baselineRef], repositoryRoot);
  runChecked(goCommand, ['build', '-o', legacyBinary, './cmd/modelry'], baselineWorktree);
  if (process.platform === 'win32') {
    runtimeLauncher = path.join(workspace, 'modelry-e2e-launcher.exe');
    runChecked(goCommand, ['build', '-o', runtimeLauncher, './admin/e2e/windows-runtime-launcher'], repositoryRoot);
  }
}, 600_000);

test.afterAll(async () => {
  if (runtimeProcess && runtimeProcess.exitCode === null && runtimeProcess.signalCode === null) {
    try { await stopRuntime(); }
    catch {
      const child = runtimeProcess;
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      runtimeProcess = undefined;
    }
  }
  if (baselineWorktree) {
    try { runChecked('git', ['worktree', 'remove', '--force', baselineWorktree], repositoryRoot); }
    catch { /* 工作树清理失败不影响断言结果。 */ }
  }
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test('WP29 V0.1 to V0.1.x upgrade, UX closure, restart and recovery hold together', async ({ page }) => {
  test.setTimeout(600_000);
  const issues: string[] = [];
  const expectedHTTPFailures = new Set<string>();
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: the server responded with a status of ')) issues.push('Console: ' + message.text());
  });
  page.on('pageerror', (error) => issues.push('Page: ' + error.message));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const key = String(response.status()) + ' ' + response.url();
    if (expectedHTTPFailures.delete(key)) return;
    issues.push('HTTP ' + String(response.status()) + ': ' + response.url());
  });

  // 1) 用 V0.1 基线二进制创建真实项目。
  const legacy = await startRuntime(legacyBinary, legacyRoot);
  expectedHTTPFailures.add('401 ' + new URL('/admin/api/v1/auth/session', runtimeURL).toString());
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);

  const created = await requestJSON(page, 'POST', '/admin/api/v1/collections', {
    name: 'posts', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }],
  });
  expect(created.status).toBe(201);
  const collectionId = (JSON.parse(created.text) as { data: { id: string } }).data.id;
  const record = await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/records', { values: { title: 'legacy record' } });
  expect(record.status).toBe(201);
  const rules = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + collectionId + '/access-rules');
  const applied = (JSON.parse(rules.text) as { data: { applied: Array<{ operation: string; mode: string }>; version: number } }).data;
  const nextRules = applied.applied.map((rule) => rule.operation === 'list' ? { operation: 'list', mode: 'anyone' } : rule);
  const savedRules = await requestJSON(page, 'PUT', '/admin/api/v1/collections/' + collectionId + '/access-rules', { expectedVersion: applied.version, rules: nextRules });
  expect(savedRules.status).toBe(200);
  const applyVersion = (JSON.parse(savedRules.text) as { data: { version: number } }).data.version;
  expect((await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/access-rules/apply', { expectedVersion: applyVersion })).status).toBe(200);
  await stopRuntime();

  // 2) 用 V0.1.x 打开同一个 root：数据与语义不得漂移。
  const current = await startRuntime(currentBinary, legacyRoot);
  expect(current.projectId).toBe(legacy.projectId);
  expectedHTTPFailures.add('401 ' + new URL('/admin/api/v1/auth/session', runtimeURL).toString());
  await page.goto(runtimeURL);
  if (await page.locator('.topbar').count() === 0) {
    await page.getByLabel('Email').fill(ownerEmail);
    await page.getByLabel('Password').fill(ownerPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.topbar')).toBeVisible();
  }
  const upgradedRecords = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + collectionId + '/records?limit=10');
  expect(upgradedRecords.status).toBe(200);
  expect(upgradedRecords.text).toContain('legacy record');
  // Access Rule 语义继续生效：匿名 List 仍然允许。
  expect((await requestJSON(page, 'GET', '/api/v1/posts?limit=1')).status).toBe(200);
  // 新 V0.1.x 能力在旧项目上立即可用。
  const drift = await requestJSON(page, 'GET', '/admin/api/v1/drift');
  expect(drift.status).toBe(200);
  expect(drift.text).toContain('"state":"healthy"');
  expect((await requestJSON(page, 'GET', '/admin/api/v1/settings')).status).toBe(200);
  const activity = await requestJSON(page, 'GET', '/admin/api/v1/activity?limit=20');
  expect(activity.status).toBe(200);
  expect(activity.text).toContain('"data":[');
  // 在升级后的项目上产生一个 V0.1.x 运维事实：保存待应用变更后必须出现在 Activity 中。
  const pendingOnLegacy = await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/schema/pending-operations', {
    kind: 'field', action: 'add', definition: { name: 'summary', type: 'text' },
  });
  expect([200, 201]).toContain(pendingOnLegacy.status);
  const activityAfterChange = await requestJSON(page, 'GET', '/admin/api/v1/activity?limit=20');
  expect(activityAfterChange.text).toContain('change.pending');
  expect((await requestJSON(page, 'GET', '/admin/api/v1/developer/contract')).status).toBe(200);

  // 3) 顶栏顺序与 Theme 语义。
  await page.goto(runtimeURL + '/');
  const actions = page.locator('.topbar__actions');
  const order = await actions.locator('> *:not(.topbar__action-divider)').evaluateAll((nodes) => nodes.map((node) => {
    if (node.classList.contains('command-palette-trigger')) return 'palette';
    if (node.classList.contains('locale-switcher')) return 'language';
    if (node.classList.contains('theme-button')) return 'theme';
    if (node.classList.contains('owner-menu')) return 'user';
    return 'runtime';
  }));
  expect(order).toEqual(['palette', 'runtime', 'language', 'theme', 'user']);
  const themeButton = page.locator('.theme-button');
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  await themeButton.click();
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  expect(themeAfter).not.toBe(themeBefore);
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? '')).toBe(themeAfter);

  // 4) Command Palette 键盘流程：Ctrl+K → 输入 → Enter 导航 → Escape 关闭并恢复焦点。
  await page.goto(runtimeURL + '/settings?filter=keep#selected');
  await page.locator('.command-palette-trigger').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.command-palette-trigger')).toBeFocused();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Search commands' }).fill('activity');
  await palette.getByRole('option').first().click();
  await expect(page).toHaveURL(/\/activity$/);

  // 5) 语言切换保留当前路由与深链上下文。
  await page.goto(runtimeURL + '/settings/runtime?filter=keep#selected');
  await page.locator('.locale-switcher select').selectOption('zh-CN');
  await expect(page).toHaveURL(/\/settings\/runtime\?filter=keep#selected$/);
  await expect(page.getByRole('heading', { name: '运行时设置', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: '活动' })).toBeVisible();
  // 迁移到共享 i18n 的 V0.1 时代页面同样必须以中文渲染。
  await page.goto(runtimeURL + '/');
  await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '运行时与存储' }).first()).toBeVisible();
  await page.goto(runtimeURL + '/settings');
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await page.locator('.locale-switcher select').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.goto(runtimeURL + '/settings/runtime');
  await expect(page.getByRole('heading', { name: 'Runtime settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Activity' })).toBeVisible();

  // 5b) V0.1 时代的四个产品面（Collection Schema / Collection Security / Access · Audit /
  //     Application API Workspace）必须在两种语言下都完整可用，且不得残留另一语言的界面文案。
  const collectionBase = runtimeURL + '/collections/' + collectionId;
  await page.locator('.locale-switcher select').selectOption('zh-CN');

  await page.goto(collectionBase + '/schema?view=indexes');
  await expect(page.getByRole('heading', { name: '结构', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加索引' })).toBeVisible();
  await expect(page.getByRole('button', { name: '已应用历史' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '暂无额外索引' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schema', level: 2 })).toHaveCount(0);
  // 语言切换必须保留 Schema 深链上下文（view=indexes 不能被重置）。
  await page.locator('.locale-switcher select').selectOption('en');
  await expect(page).toHaveURL(/\/collections\/[^/]+\/schema\?view=indexes$/);
  await expect(page.getByRole('heading', { name: 'Schema', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add index' })).toBeVisible();
  // 深链上下文在两种语言下都保持：Indexes 仍是当前视图。
  await expect(page.getByRole('button', { name: 'Indexes', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '索引', exact: true })).toHaveCount(0);
  await page.locator('.locale-switcher select').selectOption('zh-CN');
  await expect(page.getByRole('button', { name: '添加索引' })).toBeVisible();

  await page.goto(collectionBase + '/security');
  await expect(page.getByRole('heading', { name: '安全设置', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: '访问规则' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '模拟一次请求' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '已应用的访问规则' })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑列表访问规则' })).toBeVisible();
  // Collection 名与 Access 模式之外的领域词汇（列 / view / create …）保持英文原文。
  await expect(page.getByText('Applied access')).toHaveCount(0);
  await page.locator('.locale-switcher select').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit List access' })).toBeVisible();

  await page.locator('.locale-switcher select').selectOption('zh-CN');
  await page.goto(runtimeURL + '/access');
  await expect(page.getByRole('heading', { name: '访问', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: '审计' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建服务账号' }).first()).toBeVisible();
  await page.getByRole('link', { name: '审计' }).click();
  await expect(page.getByRole('heading', { name: '审计', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: '应用筛选' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '主体' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply filters' })).toHaveCount(0);
  await page.locator('.locale-switcher select').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Audit', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply filters' })).toBeVisible();

  await page.locator('.locale-switcher select').selectOption('zh-CN');
  await page.goto(collectionBase + '/api');
  await expect(page.getByRole('heading', { name: 'posts API', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /列出记录/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送 GET 请求' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '试一试该端点' })).toBeVisible();
  await expect(page.getByText('View OpenAPI')).toHaveCount(0);
  // operationId 与路由是契约标识，任何时候都不翻译，只有它们周围的产品文案切换语言。
  await expect(page.locator('.api-endpoint-meta')).toContainText('listApplicationRecords');
  await expect(page.locator('.api-endpoint-meta')).toContainText('操作');
  await expect(page.locator('.api-endpoint-option').first()).toContainText('/api/v1/posts');
  await page.goto(runtimeURL + '/api?tab=requests');
  await expect(page.getByRole('heading', { name: 'API 工作区', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: '应用请求记录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '应用筛选' })).toBeVisible();
  await page.locator('.locale-switcher select').selectOption('en');
  await expect(page.getByRole('heading', { name: 'API Workspace', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Application Request Records' })).toBeVisible();

  // 6) 同 root 重启后新持久资源仍然可用（restart-aware）。
  await stopRuntime();
  await startRuntime(currentBinary, legacyRoot);
  expectedHTTPFailures.add('401 ' + new URL('/admin/api/v1/auth/session', runtimeURL).toString());
  await page.goto(runtimeURL);
  if (await page.locator('.topbar').count() === 0) {
    await page.getByLabel('Email').fill(ownerEmail);
    await page.getByLabel('Password').fill(ownerPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.topbar')).toBeVisible();
  }
  expect((await requestJSON(page, 'GET', '/admin/api/v1/drift')).status).toBe(200);
  expect((await requestJSON(page, 'GET', '/admin/api/v1/activity?limit=5')).status).toBe(200);
  expect((await requestJSON(page, 'GET', '/admin/api/v1/settings')).status).toBe(200);
  expect((await requestJSON(page, 'GET', '/admin/api/v1/collections/' + collectionId + '/export')).status).toBe(200);

  await stopRuntime();
  expect(issues).toEqual([]);
});