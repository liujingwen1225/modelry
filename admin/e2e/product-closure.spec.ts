import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request, test, type Page } from '@playwright/test';

type ReadyRecord = { state: string; url: string; projectId: string };
type RuntimeProcess = ChildProcessWithoutNullStreams;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const expectedHTTPFailuresByPage = new WeakMap<Page, Set<string>>();
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'owner@example.test';
const ownerPassword = 'Very-Strong-Owner-Password-42!';
const appEmail = 'author@example.test';
const appPassword = 'Valid-App-Password-42!';
const wrongAppPassword = 'Wrong-App-Password-42!';
const sharedCategory = 'same-category';

let runtimeDirectory = '';
let projectRoot = '';
let runtimeBinary = '';
let runtimeLauncher = '';
let runtimeProcess: RuntimeProcess | undefined;
let runtimeProcessId: number | undefined;
let runtimeURL = '';
let readyRecord: ReadyRecord | undefined;

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
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
}

function interruptWindowsRuntime(processId: number) {
  const members = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);';
  const command = `$member = '${members}'\nAdd-Type -Namespace Modelry -Name ConsoleControl -MemberDefinition $member\n[void][Modelry.ConsoleControl]::FreeConsole()\nif (-not [Modelry.ConsoleControl]::AttachConsole([uint32]${processId})) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not attach to the Runtime console (Win32 error $errorCode)." }\nif (-not [Modelry.ConsoleControl]::GenerateConsoleCtrlEvent(1, [uint32]${processId})) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not send a graceful Runtime interrupt (Win32 error $errorCode)." }\n[void][Modelry.ConsoleControl]::FreeConsole()`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: repositoryRoot, stdio: 'inherit' });
}

async function startRuntime(root: string): Promise<ReadyRecord> {
  runtimeProcessId = undefined;
  const isWindows = process.platform === 'win32';
  const command = isWindows ? runtimeLauncher : runtimeBinary;
  const args = isWindows
    ? [runtimeBinary, 'start', '--project-root', root, '--listen', '127.0.0.1:0']
    : ['start', '--project-root', root, '--listen', '127.0.0.1:0'];
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  runtimeProcess = child;
  let stdoutBuffer = '';
  let stderr = '';
  const record = await new Promise<ReadyRecord>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime did not emit READY. stderr: ${stderr}`)), 60_000);
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
        if (line.startsWith('RUNTIME_PID ')) {
          runtimeProcessId = Number(line.slice('RUNTIME_PID '.length));
          finishWhenReady();
          continue;
        }
        if (!line.startsWith('READY ')) continue;
        try { ready = JSON.parse(line.slice('READY '.length)) as ReadyRecord; }
        catch (error) { reject(error); return; }
        finishWhenReady();
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) return;
      clearTimeout(timeout);
      reject(new Error(`Runtime exited before READY (code=${code}, signal=${signal}). stderr: ${stderr}`));
    });
  });
  if (record.state !== 'ready' || !record.url || !record.projectId) throw new Error(`Invalid READY record: ${JSON.stringify(record)}`);
  if (isWindows && (!runtimeProcessId || !Number.isInteger(runtimeProcessId))) throw new Error('Runtime launcher did not report a valid process id.');
  runtimeURL = record.url;
  readyRecord = record;
  return record;
}

async function stopRuntime() {
  const child = runtimeProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime did not stop after graceful cancellation.')), 15_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  if (process.platform === 'win32') {
    if (!runtimeProcessId) throw new Error('Runtime launcher did not report a process id.');
    interruptWindowsRuntime(runtimeProcessId);
  } else {
    child.kill('SIGINT');
  }
  const result = await exited;
  expect(result, 'Runtime must finish its graceful shutdown path').toEqual({ code: 0, signal: null });
  runtimeProcess = undefined;
}

async function requestJSON(page: Page, method: string, requestPath: string, body?: unknown, token?: string, credentials: 'include' | 'omit' = 'include', expectedStatuses: number[] = []) {
  const expectedFailures = expectedHTTPFailuresByPage.get(page);
  const responseURL = new URL(requestPath, runtimeURL).toString();
  for (const status of expectedStatuses) expectedFailures?.add(`${status} ${responseURL}`);
  const result = await page.evaluate(async (input) => {
    const headers: Record<string, string> = {};
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    const response = await fetch(input.path, {
      method: input.method,
      credentials: input.credentials,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    let responseBody: unknown;
    try { responseBody = await response.json(); }
    catch { responseBody = await response.text(); }
    return { status: response.status, requestId: response.headers.get('X-Request-Id'), body: responseBody };
  }, { method, path: requestPath, body, token, credentials });
  if (expectedFailures) {
    for (const status of expectedStatuses) {
      if (status !== result.status) expectedFailures.delete(`${status} ${responseURL}`);
    }
  }
  return result;
}

function invokeMCP(apiKey: string, tool: string, args: Record<string, unknown>) {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'product-closure', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
  ].join('\n') + '\n';
  const output = execFileSync(runtimeBinary, ['mcp', '--api-url', runtimeURL, '--api-key', apiKey], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
  });
  const response = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    id?: number;
    result?: { isError?: boolean; structuredContent?: unknown };
  }).find((item) => item.id === 2);
  if (!response?.result) throw new Error(`MCP did not return a result for ${tool}.`);
  return response.result;
}

function unwrap(value: unknown): unknown {
  let current = value;
  while (current && typeof current === 'object' && !Array.isArray(current)) {
    const item = current as Record<string, unknown>;
    if (Object.keys(item).length !== 1 || !('data' in item)) break;
    current = item.data;
  }
  return current;
}

function responseItems(value: unknown): unknown[] {
  const current = unwrap(value);
  if (Array.isArray(current)) return current;
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const data = (current as Record<string, unknown>).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

function findString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findString(item, key); if (found) return found; }
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (typeof item[key] === 'string') return item[key] as string;
  for (const child of Object.values(item)) { const found = findString(child, key); if (found) return found; }
  return undefined;
}

function addBrowserHealthGate(page: Page, issues: string[], expectedHTTPFailures: Set<string>) {
  expectedHTTPFailuresByPage.set(page, expectedHTTPFailures);
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('Failed to load resource: the server responded with a status of ')) return;
    issues.push(`Console Error: ${message.text()}`);
  });
  page.on('pageerror', (error) => issues.push(`Page Error: ${error.message}`));
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400 && !(status < 500 && expectedHTTPFailures.delete(`${status} ${response.url()}`))) {
      issues.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    if (failure.includes('ERR_ABORTED')) return;
    issues.push(`Network Failure: ${request.url()} (${failure})`);
  });
}

function collectionId(page: Page) {
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
}

async function createRecord(page: Page, title: string, category: string, file?: { name: string; mimeType: string; buffer: Buffer }) {
  const createButton = page.getByRole('button', { name: 'Create record', exact: true }).first();
  if (await page.getByRole('button', { name: 'Create first record', exact: true }).count()) {
    await page.getByRole('button', { name: 'Create first record', exact: true }).click();
  } else {
    await createButton.click();
  }
  await page.getByLabel('title · Required').fill(title);
  await page.locator('#record-field-category').fill(category);
  if (file) {
    await page.getByLabel('attachment file').setInputFiles(file);
    await expect(page.getByRole('status').filter({ hasText: 'File ready' })).toBeVisible();
  }
  await page.locator('.record-editor').getByRole('button', { name: 'Create record', exact: true }).click();
  await expect(page.getByText('Record saved. The durable result is shown here.')).toBeVisible();
  const id = await page.locator('.record-detail-identity code').textContent();
  expect(id).toMatch(/^rec_/);
  await page.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();
  return id!;
}

async function downloadAttachment(page: Page, expected: string) {
  await expect(page.getByText('File attached', { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadEvent;
  const contents = await readFile(await download.path());
  expect(contents.toString('utf8')).toBe(expected);
}

async function actionButtonContrast(page: Page) {
  return page.evaluate(() => {
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Could not read button color ${color}.`);
      const linear = channels.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const ratio = (foreground: string, background: string) => {
      const [high, low] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      return (high! + 0.05) / (low! + 0.05);
    };
    const read = (className: string) => {
      const button = document.createElement('button');
      button.className = className;
      document.body.append(button);
      const style = getComputedStyle(button);
      const result = ratio(style.color, style.backgroundColor);
      button.remove();
      return result;
    };
    return { primary: read('button button--primary'), danger: read('button button--danger') };
  });
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-v01-closure-'));
  projectRoot = path.join(runtimeDirectory, 'project');
  await mkdir(projectRoot);
  buildAdmin();
  runtimeBinary = path.join(runtimeDirectory, process.platform === 'win32' ? 'modelry.exe' : 'modelry');
  runChecked(goCommand, ['build', '-o', runtimeBinary, './cmd/modelry'], repositoryRoot);
  if (process.platform === 'win32') {
    runtimeLauncher = path.join(runtimeDirectory, 'modelry-e2e-launcher.exe');
    runChecked(goCommand, ['build', '-o', runtimeLauncher, './admin/e2e/windows-runtime-launcher'], repositoryRoot);
  }
}, 300_000);

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
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
});

test('V0.1 Product Closure: FLOW-001 through FLOW-010 on a real Runtime and empty Project Root', async ({ page }) => {
  test.setTimeout(300_000);
  const healthIssues: string[] = [];
  const expectedHTTPFailures = new Set<string>();
  addBrowserHealthGate(page, healthIssues, expectedHTTPFailures);
  expect(await readdir(projectRoot)).toEqual([]);
  const firstReady = await startRuntime(projectRoot);
  expectedHTTPFailures.add(`401 ${new URL('/admin/api/v1/auth/session', runtimeURL).toString()}`);
  let activePage = page;
  const browserContext = page.context();
  const fileContents = 'Modelry local file survives the real Runtime restart.\n';

  let authorsId = '';
  let authorRecordId = '';
  let postsId = '';
  let firstPostId = '';
  let secondPostId = '';
  let deletedPostId = '';
  let usersId = '';
  let appUserRecordId = '';
  let appSession = '';
  let wrongLoginRequestId = '';
  let successfulLoginRequestId = '';
  let successfulLoginSession = '';
  let deniedRequestId = '';
  let attachmentRequestId = '';
  let changeSetId = '';
  let serviceAccountId = '';
  let revokedAPIKey = '';

  await test.step('FLOW-001 — Bootstrap Owner, create the first Collection and Record', async () => {
    const response = await activePage.goto(runtimeURL);
    expect(response?.status()).toBe(200);
    await expect(activePage.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
    await activePage.getByLabel('Email').fill(ownerEmail);
    await activePage.getByLabel('Password').fill(ownerPassword);
    await activePage.getByRole('button', { name: 'Complete setup' }).click();
    await expect(activePage).toHaveURL(/\/collections\/new$/);
    await activePage.getByLabel('Collection name').fill('authors');
    await activePage.getByLabel('Field name 1').fill('name');
    await activePage.getByLabel('Required', { exact: true }).check();
    await activePage.getByRole('button', { name: 'Create Collection', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'authors' })).toBeVisible();
    authorsId = collectionId(activePage);
    await activePage.getByRole('button', { name: 'Create first record', exact: true }).click();
    await activePage.getByLabel('name · Required').fill('Ada Lovelace');
    await activePage.locator('.record-editor').getByRole('button', { name: 'Create record', exact: true }).click();
    await expect(activePage.getByText('Record saved. The durable result is shown here.')).toBeVisible();
    authorRecordId = (await activePage.locator('.record-detail-identity code').textContent()) ?? '';
    expect(authorRecordId).toMatch(/^rec_/);
    await activePage.reload();
    await expect(activePage.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();
    const ownerState = await requestJSON(activePage, 'GET', '/admin/api/v1/bootstrap/status');
    expect(ownerState.status).toBe(200);
    expect(JSON.stringify(ownerState.body)).toContain('closed');
    const collections = await requestJSON(activePage, 'GET', '/admin/api/v1/collections');
    expect(JSON.stringify(collections.body)).toContain('authors');

    await activePage.goto(`${runtimeURL}/collections`);
    await activePage.getByRole('button', { name: /Search commands/ }).focus();
    await activePage.keyboard.press('Control+k');
    let palette = activePage.getByRole('dialog', { name: 'Command palette' });
    let paletteInput = palette.getByRole('combobox', { name: 'Search commands' });
    await paletteInput.fill('Open authors');
    await expect(palette.getByRole('option', { name: 'Open authors' })).toBeVisible();
    await activePage.keyboard.press('Enter');
    await expect(activePage).toHaveURL(`${runtimeURL}/collections/${encodeURIComponent(authorsId)}`);

    await activePage.goto(`${runtimeURL}/collections`);
    await activePage.getByRole('button', { name: /Search commands/ }).focus();
    await activePage.keyboard.press('Control+k');
    palette = activePage.getByRole('dialog', { name: 'Command palette' });
    paletteInput = palette.getByRole('combobox', { name: 'Search commands' });
    await paletteInput.fill('Create record');
    await expect(palette.getByRole('option')).toHaveCount(0);
    await expect(palette.getByRole('status')).toContainText('No commands match');
    await activePage.keyboard.press('Escape');
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(authorsId)}`);

    const ownerCookie = (await browserContext.cookies(`${runtimeURL}/admin/api/v1`)).find((cookie) => cookie.name === 'modelry_admin_session');
    expect(ownerCookie?.value).toBeTruthy();
    const sessionClient = await request.newContext();
    try {
      const sessionURL = `${runtimeURL}/admin/api/v1/auth/session`;
      const cookieHeader = `${ownerCookie!.name}=${ownerCookie!.value}`;
      expect((await sessionClient.get(sessionURL, { headers: { Cookie: cookieHeader } })).status()).toBe(200);

      await activePage.locator('.owner-menu summary').click();
      const logoutResponsePromise = activePage.waitForResponse((response) =>
        new URL(response.url()).pathname === '/admin/api/v1/auth/logout' && response.request().method() === 'POST',
      );
      await activePage.getByRole('button', { name: 'Sign out', exact: true }).click();
      expect((await logoutResponsePromise).status()).toBe(204);
      await expect(activePage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(activePage.locator('.topbar')).toHaveCount(0);
      await expect(activePage.locator('.command-palette-trigger')).toHaveCount(0);

      const revokedSession = await sessionClient.get(sessionURL, { headers: { Cookie: cookieHeader } });
      expect(revokedSession.status()).toBe(401);

      await activePage.getByLabel('Email').fill(ownerEmail);
      await activePage.getByLabel('Password').fill(ownerPassword);
      await activePage.getByRole('button', { name: 'Sign in' }).click();
      await expect(activePage).toHaveURL(`${runtimeURL}/collections/${encodeURIComponent(authorsId)}`);
      await expect(activePage.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();

      const shellDeepLink = `${runtimeURL}/collections/${encodeURIComponent(authorsId)}?tab=records#selected`;
      await activePage.goto(shellDeepLink);
      await expect(activePage.getByRole('heading', { name: 'authors' })).toBeVisible();

      const ownerMenu = activePage.locator('.owner-menu');
      await ownerMenu.locator('summary').click();
      await expect(ownerMenu.getByRole('button', { name: /theme|主题/i })).toHaveCount(0);
      await ownerMenu.locator('summary').click();

      const darkThemeButton = activePage.locator('.topbar').getByRole('button', { name: 'Switch to dark theme' });
      await expect(darkThemeButton).toBeVisible();
      await darkThemeButton.click();
      await expect(activePage.locator('html')).toHaveAttribute('data-theme', 'dark');
      await activePage.reload();
      await expect(activePage).toHaveURL(shellDeepLink);
      await expect(activePage.locator('html')).toHaveAttribute('data-theme', 'dark');
      const contrast = await actionButtonContrast(activePage);
      expect(contrast.primary).toBeGreaterThanOrEqual(4.5);
      expect(contrast.danger).toBeGreaterThanOrEqual(4.5);

      await activePage.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
      const chineseNavigation = activePage.getByRole('navigation', { name: '项目导航' });
      await expect(chineseNavigation).toBeVisible();
      await expect(chineseNavigation.getByRole('link', { name: '集合' })).toBeVisible();
      await expect(activePage).toHaveURL(shellDeepLink);
      await expect(activePage.getByRole('heading', { name: 'authors' })).toBeVisible();
      await activePage.reload();
      await expect(activePage).toHaveURL(shellDeepLink);
      await expect(activePage.getByRole('navigation', { name: '项目导航' })).toBeVisible();
      await expect(activePage.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN');
      await expect(activePage.getByRole('heading', { name: 'authors' })).toBeVisible();

      await activePage.getByRole('button', { name: '搜索命令' }).focus();
      await activePage.keyboard.press('Control+k');
      palette = activePage.getByRole('dialog', { name: '命令面板' });
      await expect(palette).toBeVisible();
      paletteInput = palette.getByRole('combobox', { name: '搜索命令' });
      await paletteInput.fill('创建记录');
      await expect(palette.getByRole('option', { name: '在 authors 中创建记录' })).toBeVisible();
      await activePage.keyboard.press('Escape');
      await expect(activePage.getByRole('button', { name: '搜索命令' })).toBeFocused();

      await activePage.keyboard.press('Control+k');
      palette = activePage.getByRole('dialog', { name: '命令面板' });
      await expect(palette).toBeVisible();
      await palette.getByRole('combobox', { name: '搜索命令' }).fill('');
      await activePage.keyboard.press('ArrowDown');
      await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
      await activePage.keyboard.press('Enter');
      await expect(activePage).toHaveURL(`${runtimeURL}/collections`);
      await activePage.goto(shellDeepLink);
      await expect(activePage.getByRole('heading', { name: 'authors' })).toBeVisible();

      await activePage.getByRole('combobox', { name: '语言' }).selectOption('en');
      await expect(activePage.getByRole('navigation', { name: 'Project navigation' })).toBeVisible();
      await activePage.locator('.topbar').getByRole('button', { name: 'Switch to light theme' }).click();
      await expect(activePage.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await sessionClient.dispose();
    }
  });

  await test.step('FLOW-002 — Create Normal and Auth Collections with their initial fields', async () => {
    await activePage.getByRole('link', { name: 'Collections', exact: true }).first().click();
    await activePage.getByRole('link', { name: 'Create Collection', exact: true }).click();
    await activePage.getByLabel('Collection name').fill('posts');
    await activePage.getByLabel('Field name 1').fill('title');
    await activePage.getByLabel('Required', { exact: true }).check();
    await activePage.getByRole('button', { name: 'Add initial field' }).click();
    await activePage.getByLabel('Field name 2').fill('category');
    await activePage.getByRole('button', { name: 'Add initial field' }).click();
    const fileField = activePage.locator('.initial-field-row').nth(2);
    await fileField.getByLabel('Field name 3').fill('attachment');
    await fileField.getByLabel('Type', { exact: true }).selectOption('file');
    await activePage.getByRole('button', { name: 'Create Collection', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'posts' })).toBeVisible();
    postsId = collectionId(activePage);
    const detail = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}`);
    expect(JSON.stringify(detail.body)).toContain('attachment');
    await activePage.reload();
    await expect(activePage.getByRole('button', { name: 'Create first record', exact: true })).toBeVisible();

    await activePage.getByRole('link', { name: 'Collections', exact: true }).first().click();
    await activePage.getByRole('link', { name: 'Create Collection', exact: true }).click();
    await activePage.getByLabel('Auth Collection').check();
    await activePage.getByLabel('Collection name').fill('users');
    await expect(activePage.getByLabel('Allow users to sign up')).not.toBeChecked();
    await activePage.getByLabel('Field name 1').fill('displayName');
    await activePage.getByRole('button', { name: 'Create Collection', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'users' })).toBeVisible();
    usersId = collectionId(activePage);
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}`);
    await expect(activePage.getByRole('heading', { name: 'posts' })).toBeVisible();
  });

  await test.step('FLOW-003 — Record CRUD, relation values and Local Single-file Field', async () => {
    firstPostId = await createRecord(activePage, 'post-a', sharedCategory, {
      name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from(fileContents),
    });
    secondPostId = await createRecord(activePage, 'post-b', sharedCategory);
    deletedPostId = await createRecord(activePage, 'delete-target', 'temporary');

    const firstRow = activePage.getByRole('row').filter({ hasText: 'post-a' });
    await firstRow.getByRole('button', { name: 'Edit', exact: true }).click();
    await activePage.getByLabel('title · Required').fill('post-a-updated');
    await activePage.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(activePage.getByRole('row').filter({ hasText: 'post-a-updated' })).toBeVisible();
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();
    await activePage.getByLabel('Search records').fill('post-a-updated');
    await expect(activePage.getByRole('row').filter({ hasText: 'post-a-updated' })).toBeVisible();
    await activePage.reload();
    await expect(activePage.getByRole('row').filter({ hasText: 'post-a-updated' })).toBeVisible();
    await activePage.getByLabel('Search records').fill('');

    const deleteRow = activePage.getByRole('button', { name: `Delete record ${deletedPostId}` });
    await deleteRow.click();
    const deleteDialog = activePage.getByRole('dialog', { name: 'Delete this record?' });
    await deleteDialog.getByRole('button', { name: 'Delete record', exact: true }).click();
    await expect(activePage.getByText('Record deleted.', { exact: true })).toBeVisible();
    await expect(activePage.getByRole('row').filter({ hasText: 'delete-target' })).toHaveCount(0);

    for (let index = 0; index < 26; index++) {
      const suffix = String(index).padStart(3, '0');
      const created = await requestJSON(activePage, 'POST', `/admin/api/v1/collections/${postsId}/records`, {
        values: { title: `page-record-${suffix}`, category: `browse-${suffix}` },
      });
      expect(created.status, `Create pagination fixture ${suffix}`).toBe(201);
    }
    await activePage.reload();
    await activePage.getByLabel('Filter field').selectOption('category');
    await activePage.getByLabel('Filter operator').selectOption('contains');
    await activePage.getByLabel('Filter value').fill('browse-');
    await activePage.getByLabel('Search records').fill('page-record');
    await activePage.getByLabel('Sort field').selectOption('title');
    await activePage.getByLabel('Sort direction').selectOption('asc');
    await expect(activePage.locator('.records-table tbody tr')).toHaveCount(25);
    await expect(activePage.locator('.records-table tbody tr').first()).toContainText('page-record-000');
    const nextPage = activePage.getByRole('button', { name: 'Next', exact: true });
    await expect(nextPage).toBeEnabled();
    await nextPage.click();
    await expect(activePage.locator('.records-table tbody tr')).toHaveCount(1);
    const lastPageRow = activePage.locator('.records-table tbody tr').first();
    await expect(lastPageRow).toContainText('page-record-025');
    const previousPage = activePage.getByRole('button', { name: 'Previous', exact: true });
    await expect(previousPage).toBeEnabled();
    await previousPage.click();
    await expect(activePage.locator('.records-table tbody tr')).toHaveCount(25);
    await expect(activePage.locator('.records-table tbody tr').first()).toContainText('page-record-000');
    await nextPage.click();
    await expect(activePage.locator('.records-table tbody tr')).toHaveCount(1);
    await expect(activePage.locator('.records-table tbody tr').first()).toContainText('page-record-025');
    const contextURL = new URL(activePage.url());
    expect(contextURL.searchParams.get('search')).toBe('page-record');
    expect(contextURL.searchParams.get('filter')).toBe('category contains "browse-"');
    expect(contextURL.searchParams.get('sort')).toBe('title asc');
    expect(contextURL.searchParams.get('cursor')).toBeTruthy();
    expect(contextURL.searchParams.get('cursorStack')).toBeTruthy();
    const deepLinkRecordId = await lastPageRow.locator('button').first().textContent();
    expect(deepLinkRecordId).toMatch(/^rec_/);
    await lastPageRow.getByRole('button').filter({ hasText: 'page-record-025' }).click();
    const detailURL = activePage.url();
    expect(new URL(detailURL).searchParams.get('record')).toBe(deepLinkRecordId);
    await activePage.goto(detailURL);
    await expect(activePage.locator('.record-detail-identity code')).toHaveText(deepLinkRecordId!);
    await expect(activePage.locator('.record-detail-values').getByText('page-record-025', { exact: true })).toBeVisible();
    await activePage.reload();
    await expect(activePage.locator('.record-detail-identity code')).toHaveText(deepLinkRecordId!);
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Edit', exact: true }).click();
    const editURL = new URL(activePage.url());
    expect(editURL.searchParams.get('record')).toBe(deepLinkRecordId);
    expect(editURL.searchParams.get('edit')).toBe('1');
    expect(editURL.searchParams.get('search')).toBe('page-record');
    expect(editURL.searchParams.get('filter')).toBe('category contains "browse-"');
    expect(editURL.searchParams.get('sort')).toBe('title asc');
    await expect(activePage.getByLabel('title · Required')).toHaveValue('page-record-025');
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(activePage.locator('.records-table tbody tr')).toHaveCount(1);
    await lastPageRow.getByRole('button').filter({ hasText: 'page-record-025' }).click();
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();
    const returnedURL = new URL(activePage.url());
    expect(returnedURL.searchParams.get('record')).toBeNull();
    expect(returnedURL.searchParams.get('search')).toBe('page-record');
    expect(returnedURL.searchParams.get('filter')).toBe('category contains "browse-"');
    expect(returnedURL.searchParams.get('sort')).toBe('title asc');
    expect(returnedURL.searchParams.get('cursor')).toBe(contextURL.searchParams.get('cursor'));
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}`);

    const listed = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/records/${firstPostId}`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain('post-a-updated');
    const deletedRecordPath = `/admin/api/v1/collections/${postsId}/records/${deletedPostId}`;
    const deleted = await requestJSON(activePage, 'GET', deletedRecordPath, undefined, undefined, 'include', [404]);
    expect(deleted.status).toBe(404);
  });

  await test.step('FLOW-004 — Accumulate and apply durable Schema Pending Changes', async () => {
    await activePage.getByRole('link', { name: 'Schema', exact: true }).click();
    await activePage.getByRole('button', { name: 'Add field', exact: true }).click();
    await activePage.getByLabel('Field name', { exact: true }).fill('summary');
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await activePage.getByRole('button', { name: 'Relations', exact: true }).click();
    await activePage.getByRole('button', { name: 'Add relation', exact: true }).click();
    await activePage.getByLabel('Field name', { exact: true }).fill('author');
    await activePage.getByLabel('Target Collection').selectOption({ label: 'authors' });
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await activePage.getByRole('button', { name: 'Add relation', exact: true }).click();
    await activePage.getByLabel('Field name', { exact: true }).fill('owner');
    await activePage.getByLabel('Target Collection').selectOption({ label: 'users' });
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await activePage.getByRole('button', { name: 'Indexes', exact: true }).click();
    await activePage.getByRole('button', { name: 'Add index', exact: true }).click();
    await activePage.getByLabel('Index name').fill('posts_title_category');
    const indexFields = activePage.locator('#schema-index-fields');
    const selectedFieldValues = await indexFields.locator('option').evaluateAll((options) => options
      .filter((option) => ['title', 'category'].includes((option as HTMLOptionElement).label))
      .map((option) => (option as HTMLOptionElement).value));
    expect(selectedFieldValues).toHaveLength(2);
    await indexFields.selectOption(selectedFieldValues);
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();

    const pending = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/schema/pending-change`)).body);
    expect(pending).toMatchObject({ status: 'ready' });
    changeSetId = findString(pending, 'changeSetId') ?? '';
    expect(changeSetId).toBeTruthy();
    await activePage.getByRole('link', { name: 'Records', exact: true }).click();
    await activePage.getByRole('button', { name: /Search commands/ }).focus();
    await activePage.keyboard.press('Control+k');
    let palette = activePage.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox', { name: 'Search commands' }).fill('Open pending change: posts');
    await expect(palette.getByRole('option', { name: 'Open pending change: posts' })).toBeVisible();
    await activePage.keyboard.press('Enter');
    await expect(activePage).toHaveURL(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/schema`);
    await activePage.getByRole('button', { name: 'Fields', exact: true }).click();
    await activePage.reload();
    await expect(activePage.getByRole('row').filter({ hasText: 'summary' })).toBeVisible();
    await expect(activePage.getByRole('row').filter({ hasText: 'author' })).toBeVisible();
    await activePage.getByRole('button', { name: 'Indexes', exact: true }).click();
    await expect(activePage.getByRole('row').filter({ hasText: 'posts_title_category' })).toBeVisible();
    const previewResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === `/admin/api/v1/collections/${postsId}/schema/preview` && response.request().method() === 'POST');
    await activePage.getByRole('button', { name: /Review.*apply/ }).click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status()).toBe(200);
    const preview = unwrap(await previewResponse.json()) as { risk: string };
    expect(['safe', 'review']).toContain(preview.risk);
    const confirm = activePage.getByRole('button', { name: 'Confirm & apply', exact: true });
    if (preview.risk === 'review') {
      await expect(confirm).toBeVisible();
      await confirm.click();
    }
    await expect.poll(async () => unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/schema/pending-change`)).body), { timeout: 15_000 }).toBeNull();
    await activePage.reload();
    await activePage.getByRole('button', { name: 'Indexes', exact: true }).click();
    const appliedIndexRows = activePage.getByRole('row').filter({ hasText: 'posts_title_category' });
    await expect(appliedIndexRows).toHaveCount(1);
    await expect(appliedIndexRows.first()).toContainText('Applied');

    await activePage.getByRole('link', { name: 'Records', exact: true }).click();
    await activePage.getByLabel('Search records').fill('post-a-updated');
    await activePage.getByRole('row').filter({ hasText: 'post-a-updated' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await activePage.locator('#record-field-author').fill(authorRecordId);
    await activePage.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(activePage.getByText(authorRecordId, { exact: true })).toBeVisible();
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();

    await activePage.getByRole('row').filter({ hasText: 'post-a-updated' }).getByRole('button').filter({ hasText: 'post-a-updated' }).click();
    await expect(activePage.locator('.record-detail-values')).toContainText(authorRecordId);
    await expect(activePage.locator('.record-detail-values')).toContainText('Related: name: Ada Lovelace');
    await downloadAttachment(activePage, fileContents);
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();
    const collection = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}`)).body);
    expect(JSON.stringify(collection)).toContain('summary');
    expect(JSON.stringify(collection)).toContain('posts_title_category');
  });

  await test.step('FLOW-005 — Create an App User and revoke a real Session', async () => {
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(usersId)}`);
    await expect(activePage.getByRole('heading', { name: 'users' })).toBeVisible();
    await activePage.getByRole('button', { name: /Create user/ }).first().click();
    await activePage.locator('#record-field-email').fill(appEmail);
    await activePage.locator('#record-field-displayName').fill('Ada');
    await activePage.getByLabel('Password', { exact: true }).fill(appPassword);
    await activePage.getByLabel('Confirm password').fill(appPassword);
    await activePage.locator('.record-editor').getByRole('button', { name: 'Create user', exact: true }).click();
    await expect(activePage.getByText('Record saved. The durable result is shown here.')).toBeVisible();
    await expect(activePage.getByText(appEmail, { exact: true }).first()).toBeVisible();
    expect(await activePage.locator('body').innerText()).not.toContain(appPassword);
    appUserRecordId = (await activePage.locator('.record-detail-identity code').textContent()) ?? '';
    expect(appUserRecordId).toMatch(/^rec_/);
    const appUserRecord = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${usersId}/records/${appUserRecordId}`);
    expect(appUserRecord.status).toBe(200);
    expect(JSON.stringify(appUserRecord.body)).not.toContain(appPassword);
    expect(JSON.stringify(appUserRecord.body)).not.toContain('accessToken');

    const wrongLogin = await requestJSON(activePage, 'POST', '/api/v1/auth/users/login', { email: appEmail, password: wrongAppPassword }, undefined, 'omit', [401]);
    expect(wrongLogin.status).toBe(401);
    expect(JSON.stringify(wrongLogin.body)).not.toContain('accessToken');
    expect(JSON.stringify(wrongLogin.body)).not.toContain(wrongAppPassword);
    wrongLoginRequestId = wrongLogin.requestId ?? '';
    expect(wrongLoginRequestId).toMatch(/^req_/);
    const sessionWithoutToken = await requestJSON(activePage, 'GET', '/api/v1/auth/users/session', undefined, undefined, 'omit', [401]);
    expect(sessionWithoutToken.status).toBe(401);
    const wrongLoginDetail = await requestJSON(activePage, 'GET', `/admin/api/v1/requests/${wrongLoginRequestId}`);
    expect(wrongLoginDetail.status).toBe(200);
    expect(JSON.stringify(wrongLoginDetail.body)).not.toContain(appPassword);
    expect(JSON.stringify(wrongLoginDetail.body)).not.toContain(wrongAppPassword);
    expect(JSON.stringify(wrongLoginDetail.body)).not.toContain('accessToken');

    const loginURL = `${runtimeURL}/api?collection=${encodeURIComponent(usersId)}&endpoint=loginApplicationUser`;
    await activePage.goto(loginURL);
    await expect(activePage.getByRole('heading', { name: 'Log in an App User' })).toBeVisible();
    await activePage.getByLabel('JSON body').fill(JSON.stringify({ email: appEmail, password: appPassword }, null, 2));
    const loginResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/users/login');
    await activePage.getByRole('button', { name: 'Send POST request' }).click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.status()).toBe(200);
    successfulLoginRequestId = loginResponse.headers()['x-request-id'] ?? '';
    expect(successfulLoginRequestId).toMatch(/^req_/);
    const loginBody = await loginResponse.json() as unknown;
    appSession = findString(loginBody, 'accessToken') ?? '';
    expect(appSession).toMatch(/^app_/);
    successfulLoginSession = appSession;
    expect(await activePage.locator('body').innerText()).not.toContain(appSession);
    const appSessionCheck = await requestJSON(activePage, 'GET', '/api/v1/auth/users/session', undefined, appSession, 'omit');
    expect(appSessionCheck.status).toBe(200);
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(usersId)}/security`);
    await activePage.getByRole('tab', { name: 'Sessions', exact: true }).click();
    const appUserRow = activePage.locator('.security-user-row').filter({ hasText: appEmail });
    await expect(appUserRow).toBeVisible();
    appUserRecordId = (await appUserRow.locator('span').textContent()) ?? '';
    expect(appUserRecordId).toMatch(/^rec_/);
    await appUserRow.getByRole('button', { name: 'View sessions' }).click();
    const activeSession = activePage.locator('.security-session-row').filter({ hasText: 'active' });
    await expect(activeSession).toHaveCount(1);
    await activeSession.getByRole('button', { name: 'Revoke', exact: true }).click();
    await activePage.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await expect(activePage.getByText('Session revoked.', { exact: true })).toBeVisible();
    await expect(activePage.locator('.security-session-row').filter({ hasText: 'revoked' })).toHaveCount(1);
    const revokedAppSession = await requestJSON(activePage, 'GET', '/api/v1/auth/users/session', undefined, appSession, 'omit', [401, 403]);
    expect([401, 403]).toContain(revokedAppSession.status);

    const renewedLogin = await requestJSON(activePage, 'POST', '/api/v1/auth/users/login', { email: appEmail, password: appPassword }, undefined, 'omit');
    expect(renewedLogin.status).toBe(200);
    appSession = findString(renewedLogin.body, 'accessToken') ?? '';
    expect(appSession).toMatch(/^app_/);
    const renewedLoginRequestId = renewedLogin.requestId ?? '';
    expect(renewedLoginRequestId).toMatch(/^req_/);
    for (const requestId of [successfulLoginRequestId, renewedLoginRequestId]) {
      const loginRequestDetail = await requestJSON(activePage, 'GET', `/admin/api/v1/requests/${requestId}`);
      expect(loginRequestDetail.status).toBe(200);
      expect(JSON.stringify(loginRequestDetail.body)).not.toContain(appPassword);
      expect(JSON.stringify(loginRequestDetail.body)).not.toContain(appSession);
      expect(JSON.stringify(loginRequestDetail.body)).not.toContain(successfulLoginSession);
      expect(JSON.stringify(loginRequestDetail.body)).not.toContain('accessToken');
    }
  });

  await test.step('FLOW-006 — Apply independent Access Rules and verify fail-closed HTTP behavior', async () => {
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/security`);
    await expect(activePage.getByRole('heading', { name: 'Security' })).toBeVisible();
    await activePage.getByRole('button', { name: 'Edit List access' }).click();
    await activePage.getByLabel('Signed-in users').check();
    await activePage.getByRole('button', { name: 'Save pending rule' }).click();
    await activePage.getByRole('button', { name: 'Edit View access' }).click();
    await activePage.getByLabel('Signed-in users').check();
    await activePage.getByRole('button', { name: 'Save pending rule' }).click();
    await activePage.getByRole('button', { name: 'Apply 2 changes' }).click();
    await activePage.getByRole('button', { name: 'Confirm & apply' }).click();
    await expect(activePage.getByText('All access rule changes are applied.')).toBeVisible();

    const anonymousList = await requestJSON(activePage, 'GET', '/api/v1/posts', undefined, undefined, 'omit', [401, 403]);
    expect([401, 403]).toContain(anonymousList.status);
    const signedInList = await requestJSON(activePage, 'GET', '/api/v1/posts', undefined, appSession, 'omit');
    expect(signedInList.status).toBe(200);
    const anonymousView = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, undefined, 'omit', [401, 403]);
    expect([401, 403]).toContain(anonymousView.status);
    const signedInView = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, appSession, 'omit');
    expect(signedInView.status).toBe(200);

    const applyCollectionViewRule = async (collectionID: string, mode: string) => {
      await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionID)}/security`);
      await activePage.getByRole('button', { name: 'Edit View access' }).click();
      await activePage.getByLabel(mode).check();
      await activePage.getByRole('button', { name: 'Save pending rule' }).click();
      await activePage.getByRole('button', { name: /Apply 1 change/ }).click();
      await activePage.getByRole('button', { name: 'Confirm & apply' }).click();
      await expect(activePage.getByText('All access rule changes are applied.')).toBeVisible();
    };

    await applyCollectionViewRule(authorsId, 'Anyone');
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/security`);
    const visibleRelation = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}?expand=author`, undefined, appSession, 'omit');
    expect(visibleRelation.status).toBe(200);
    const visibleRelationRecord = unwrap(visibleRelation.body) as { author: string; _expand?: { author?: { id?: string; name?: string } } };
    expect(visibleRelationRecord.author).toBe(authorRecordId);
    expect(visibleRelationRecord._expand?.author).toMatchObject({ id: authorRecordId, name: 'Ada Lovelace' });
    const listExpand = await requestJSON(activePage, 'GET', '/api/v1/posts?expand=author', undefined, appSession, 'omit', [400]);
    expect(listExpand.status).toBe(400);
    const adminListExpand = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/records?expand=author`, undefined, undefined, 'include', [400]);
    expect(adminListExpand.status).toBe(400);

    await applyCollectionViewRule(authorsId, 'No access');
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/security`);
    const hiddenRelation = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}?expand=author`, undefined, appSession, 'omit');
    expect(hiddenRelation.status).toBe(200);
    const hiddenRelationRecord = unwrap(hiddenRelation.body) as { author: string; _expand?: unknown };
    expect(hiddenRelationRecord.author).toBe(authorRecordId);
    expect(hiddenRelationRecord._expand).toBeUndefined();
    expect(JSON.stringify(hiddenRelation.body)).not.toContain('Ada Lovelace');
    await applyCollectionViewRule(authorsId, 'Anyone');
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/security`);

    const applyViewRule = async (mode: string, configure?: () => Promise<void>) => {
      await activePage.getByRole('button', { name: 'Edit View access' }).click();
      await activePage.getByLabel(mode).check();
      if (configure) await configure();
      await activePage.getByRole('button', { name: 'Save pending rule' }).click();
      await activePage.getByRole('button', { name: /Apply 1 change/ }).click();
      await activePage.getByRole('button', { name: 'Confirm & apply' }).click();
      await expect(activePage.getByText('All access rule changes are applied.')).toBeVisible();
    };

    await applyViewRule('No access');
    const signedInNoAccess = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, appSession, 'omit', [401, 403]);
    expect([401, 403]).toContain(signedInNoAccess.status);

    await applyViewRule('Anyone');
    const anonymousAnyoneView = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, undefined, 'omit');
    expect(anonymousAnyoneView.status).toBe(200);

    const assignOwner = await requestJSON(activePage, 'PATCH', `/admin/api/v1/collections/${postsId}/records/${firstPostId}`, {
      values: { owner: appUserRecordId },
    });
    expect(assignOwner.status).toBe(200);
    await applyViewRule('Record owner', async () => {
      await activePage.locator('#access-owner-field').selectOption({ label: 'owner' });
    });
    const ownerView = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, appSession, 'omit');
    expect(ownerView.status).toBe(200);
    const nonOwnerView = await requestJSON(activePage, 'GET', `/api/v1/posts/${secondPostId}`, undefined, appSession, 'omit', [401, 403]);
    expect([401, 403]).toContain(nonOwnerView.status);

    await applyViewRule('Custom rule', async () => {
      await activePage.getByRole('button', { name: 'Add condition', exact: true }).click();
      await activePage.getByLabel('Condition 1 field').selectOption({ label: 'title' });
      await activePage.getByLabel('Condition value', { exact: true }).fill('post-a-updated');
    });
    const matchingCustomView = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, appSession, 'omit');
    expect(matchingCustomView.status).toBe(200);
    const nonMatchingCustomView = await requestJSON(activePage, 'GET', `/api/v1/posts/${secondPostId}`, undefined, appSession, 'omit', [401, 403]);
    expect([401, 403]).toContain(nonMatchingCustomView.status);

    await applyViewRule('Signed-in users');
    await activePage.reload();
    await expect(activePage.getByText('All access rule changes are applied.')).toBeVisible();
  });

  await test.step('FLOW-007 — Real API Runner, correlated Request Detail and Requests search', async () => {
    await activePage.goto(`${runtimeURL}/api?collection=${encodeURIComponent(postsId)}`);
    await activePage.locator('.api-endpoint-option').filter({ hasText: 'List records' }).click();
    await expect(activePage.locator('.api-endpoint-meta')).toContainText('Signed-in users');
    await activePage.getByText('View OpenAPI', { exact: true }).click();
    await expect(activePage.locator('.api-openapi pre')).toContainText('x-modelry-access-rule');
    await expect(activePage.locator('.api-openapi pre')).toContainText('signedInUsers');
    await activePage.getByLabel('App Session token (optional)').fill(appSession);
    const listResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/posts' && response.request().method() === 'GET');
    await activePage.getByRole('button', { name: 'Send GET request' }).click();
    expect((await listResponsePromise).status()).toBe(200);

    await activePage.locator('.api-endpoint-option').filter({ hasText: 'Read a record' }).click();
    await activePage.getByLabel('Record ID').fill(firstPostId);
    await activePage.getByLabel('App Session token (optional)').fill('');
    const deniedPath = `/api/v1/posts/${firstPostId}`;
    expectedHTTPFailures.add(`403 ${new URL(deniedPath, runtimeURL).toString()}`);
    const deniedResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/posts/${firstPostId}`);
    await activePage.getByRole('button', { name: 'Send GET request' }).click();
    expect((await deniedResponsePromise).status()).toBe(403);
    await expect(activePage.getByText('403', { exact: true })).toBeVisible();
    const responseCodes = await activePage.locator('.api-response__metadata code').allTextContents();
    deniedRequestId = responseCodes.find((value) => /^req_[A-Za-z0-9_-]{8,}$/.test(value)) ?? '';
    expect(deniedRequestId).toBeTruthy();
    await activePage.getByRole('link', { name: 'View durable request details' }).click();
    await expect(activePage).toHaveURL(new RegExp(`/requests/${deniedRequestId}`));
    await expect(activePage.getByText(deniedRequestId, { exact: true }).first()).toBeVisible();
    await expect(activePage.getByRole('heading', { name: /Request/ })).toBeVisible();
    expect(await activePage.locator('body').innerText()).not.toContain(appSession);

    await activePage.goto(`${runtimeURL}/api?tab=requests&search=${encodeURIComponent(deniedRequestId)}`);
    await expect(activePage.getByText(deniedRequestId, { exact: true }).first()).toBeVisible();
    await activePage.getByText(deniedRequestId, { exact: true }).first().click();
    await expect(activePage).toHaveURL(new RegExp(`/requests/${deniedRequestId}`));

    await activePage.goto(`${runtimeURL}/api?collection=${encodeURIComponent(postsId)}`);
    await activePage.locator('.api-endpoint-option').filter({ hasText: 'Read a file attachment' }).click();
    await activePage.getByLabel('Record ID').fill(firstPostId);
    await activePage.getByLabel('File field').selectOption('attachment');
    await activePage.getByLabel('App Session token (optional)').fill(appSession);
    const attachmentResponsePromise = activePage.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1/posts/${firstPostId}/files/attachment`,
    );
    await activePage.getByRole('button', { name: 'Send GET request' }).click();
    const attachmentResponse = await attachmentResponsePromise;
    expect(attachmentResponse.status()).toBe(200);
    attachmentRequestId = attachmentResponse.headers()['x-request-id'] ?? '';
    expect(attachmentRequestId).toMatch(/^req_[A-Za-z0-9_-]{8,}$/);
    expect(attachmentResponse.headers()['x-request-record-persisted']).toBe('true');
    expect(attachmentResponse.headers()['content-type']).toBe('text/plain');
    expect(attachmentResponse.headers()['content-disposition']).toBe('attachment');
    expect(attachmentResponse.headers()['cache-control']).toBe('private, no-store');
    expect(attachmentResponse.headers()['x-content-type-options']).toBe('nosniff');
    const fileClient = await request.newContext();
    try {
      const fileResponse = await fileClient.get(`${runtimeURL}/api/v1/posts/${encodeURIComponent(firstPostId)}/files/attachment`, {
        headers: { Authorization: `Bearer ${appSession}` },
      });
      expect(fileResponse.status()).toBe(200);
      expect((await fileResponse.body()).toString('utf8')).toBe(fileContents);
    } finally {
      await fileClient.dispose();
    }
    await expect(activePage.getByText('Response content is hidden because it is not JSON.')).toBeVisible();
    expect(await activePage.locator('.api-response__body').count()).toBe(0);
    await activePage.getByRole('link', { name: 'View durable request details' }).click();
    await expect(activePage).toHaveURL(/\/requests\/req_/);
    await expect(activePage.getByText(`${Buffer.byteLength(fileContents)} bytes`, { exact: true })).toBeVisible();
    await expect(activePage.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=' + encodeURIComponent(postsId) + '&endpoint=readApplicationRecordFile');
    await expect(activePage.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', `/collections/${encodeURIComponent(postsId)}/api?endpoint=readApplicationRecordFile`);
  });

  await test.step('FLOW-008 — One-time Service Account key, authorization and revocation audit', async () => {
    await activePage.goto(`${runtimeURL}/access`);
    await activePage.getByRole('button', { name: 'Create Service Account', exact: true }).first().click();
    const accountDialog = activePage.getByRole('dialog', { name: 'Create Service Account' });
    await accountDialog.getByLabel('Name').fill('ci-readonly');
    await expect(accountDialog.getByLabel('Permission preset')).toHaveValue('readOnly');
    await expect(accountDialog.getByLabel('Create API Key now')).toBeChecked();
    await accountDialog.getByRole('button', { name: 'Create Service Account', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'Copy your API Key now' })).toBeVisible();
    revokedAPIKey = (await activePage.locator('.access-reveal__secret code').textContent()) ?? '';
    expect(revokedAPIKey).toMatch(/^mdl_/);
    await activePage.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await activePage.locator('body').innerText()).not.toContain(revokedAPIKey);
    const accountMatch = new URL(activePage.url()).searchParams.get('account');
    serviceAccountId = accountMatch ?? '';
    expect(serviceAccountId).toBeTruthy();

    const keyRead = await requestJSON(activePage, 'GET', '/admin/api/v1/collections', undefined, revokedAPIKey, 'omit');
    expect(keyRead.status).toBe(200);
    const postsSummary = responseItems(keyRead.body).find((item) => findString(item, 'id') === postsId) as Record<string, unknown> | undefined;
    expect(postsSummary?.recordCount).toBe(28);
    expect(postsSummary?.pendingChangeStatus).toBeUndefined();
    const httpRecords = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/records?limit=100`, undefined, revokedAPIKey, 'omit');
    expect(httpRecords.status).toBe(200);
    const expectedRecordIds = responseItems(httpRecords.body).map((record) => findString(record, 'id')).sort();
    const cliRecords = JSON.parse(execFileSync(runtimeBinary, [
      'admin', 'records', 'list', postsId, '--api-url', runtimeURL, '--api-key', revokedAPIKey, '--limit', '100',
    ], { cwd: repositoryRoot, encoding: 'utf8' })) as unknown;
    expect(responseItems(cliRecords).map((record) => findString(record, 'id')).sort()).toEqual(expectedRecordIds);
    const mcpRecords = invokeMCP(revokedAPIKey, 'records_list', { collectionId: postsId, limit: 100 });
    expect(responseItems(mcpRecords.structuredContent).map((record) => findString(record, 'id')).sort()).toEqual(expectedRecordIds);

    const deniedRecordBody = { values: { title: 'blocked-by-http', category: 'blocked' } };
    const deniedHTTPWrite = await requestJSON(activePage, 'POST', `/admin/api/v1/collections/${postsId}/records`, deniedRecordBody, revokedAPIKey, 'omit', [403]);
    expect(deniedHTTPWrite.status).toBe(403);
    const deniedCLIWrite = spawnSync(runtimeBinary, [
      'admin', 'records', 'create', postsId, '--api-url', runtimeURL, '--api-key', revokedAPIKey,
      '--data', JSON.stringify({ values: { title: 'blocked-by-cli', category: 'blocked' } }),
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    expect(deniedCLIWrite.status).toBe(1);
    expect(JSON.parse(deniedCLIWrite.stderr).error.code).toBe('FORBIDDEN');
    const deniedMCPWrite = invokeMCP(revokedAPIKey, 'records_create', {
      collectionId: postsId, body: { values: { title: 'blocked-by-mcp', category: 'blocked' } },
    });
    expect(deniedMCPWrite.isError).toBe(true);
    expect((deniedMCPWrite.structuredContent as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN');

    const keyWrite = await requestJSON(activePage, 'POST', '/admin/api/v1/collections', {}, revokedAPIKey, 'omit', [403]);
    expect(keyWrite.status).toBe(403);
    const keyAsAppSession = await requestJSON(activePage, 'GET', '/api/v1/auth/users/session', undefined, revokedAPIKey, 'omit', [401]);
    expect(keyAsAppSession.status).toBe(401);

    const activeKeyRow = activePage.getByRole('row').filter({ hasText: 'active' });
    await activeKeyRow.getByRole('button', { name: 'Revoke', exact: true }).click();
    const revokeDialog = activePage.getByRole('dialog', { name: 'Revoke this API Key?' });
    await revokeDialog.getByRole('button', { name: 'Revoke API Key', exact: true }).click();
    await expect(activePage.getByText('revoked', { exact: true })).toBeVisible();
    const revokedRead = await requestJSON(activePage, 'GET', '/admin/api/v1/collections', undefined, revokedAPIKey, 'omit', [401]);
    expect(revokedRead.status).toBe(401);

    const auditBody = await requestJSON(activePage, 'GET', '/admin/api/v1/audit?limit=100');
    expect(auditBody.status).toBe(200);
    expect(JSON.stringify(auditBody.body)).not.toContain(revokedAPIKey);
    await activePage.goto(`${runtimeURL}/access/audit?action=${encodeURIComponent('apiKey.revoked')}`);
    const auditRow = activePage.locator('.data-table tbody tr').filter({ hasText: 'apiKey.revoked' });
    await expect(auditRow).toBeVisible();
    const auditLink = auditRow.getByRole('link').first();
    await auditLink.click();
    await expect(activePage).toHaveURL(/\/access\/audit\/[^?]+\?from=/);
    await expect(activePage.locator('.audit-detail-grid')).toContainText('apiKey.revoked');
    await expect(activePage.locator('.audit-resource pre')).toContainText('apiKey');
    expect(await activePage.locator('body').innerText()).not.toContain(revokedAPIKey);
  });

  await test.step('FLOW-009 — Durable unique-conflict failure and successful retry', async () => {
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/schema`);
    await activePage.getByRole('row').filter({ hasText: 'category' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await activePage.getByLabel('Unique', { exact: true }).check();
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    const pending = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/schema/pending-change`)).body);
    changeSetId = findString(pending, 'changeSetId') ?? '';
    expect(changeSetId).toBeTruthy();
    await activePage.getByRole('button', { name: 'Review & apply', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'Existing values conflict with this unique change' })).toBeVisible();
    const schemaApplyPath = `/admin/api/v1/collections/${postsId}/schema/apply`;
    const failedApplyStatuses = [400, 409, 422];
    for (const status of failedApplyStatuses) expectedHTTPFailures.add(`${status} ${new URL(schemaApplyPath, runtimeURL).toString()}`);
    const failedApplyResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === schemaApplyPath && response.request().method() === 'POST');
    await activePage.getByRole('button', { name: 'Attempt apply', exact: true }).click();
    const failedApplyResponse = await failedApplyResponsePromise;
    expect(failedApplyStatuses).toContain(failedApplyResponse.status());
    for (const status of failedApplyStatuses) {
      if (status !== failedApplyResponse.status()) expectedHTTPFailures.delete(`${status} ${new URL(schemaApplyPath, runtimeURL).toString()}`);
    }
    await expect(activePage.getByRole('button', { name: 'Review and retry', exact: true })).toBeVisible();
    const failedChange = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/changes/${changeSetId}`)).body) as Record<string, unknown>;
    expect(failedChange.status).toBe('failed');
    expect(failedChange.applyAttempts).toHaveLength(1);
    await activePage.getByRole('button', { name: /Search commands/ }).focus();
    await activePage.keyboard.press('Control+k');
    const failedChangePalette = activePage.getByRole('dialog', { name: 'Command palette' });
    await failedChangePalette.getByRole('combobox', { name: 'Search commands' }).fill('Open failed change: posts');
    await expect(failedChangePalette.getByRole('option', { name: 'Open failed change: posts' })).toBeVisible();
    await activePage.keyboard.press('Enter');
    await expect(activePage).toHaveURL(`${runtimeURL}/changes?changeSet=${encodeURIComponent(changeSetId)}`);
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/schema`);
    const unchanged = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}`)).body);
    const categoryField = (unchanged as { fields: Array<{ name: string; unique?: boolean }> }).fields.find((field) => field.name === 'category');
    expect(categoryField).toBeDefined();
    expect(categoryField?.unique ?? false).toBe(false);

    await activePage.getByRole('link', { name: 'Records', exact: true }).click();
    await activePage.getByLabel('Search records').fill('post-b');
    await activePage.getByRole('row').filter({ hasText: 'post-b' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await activePage.locator('#record-field-category').fill('different-category');
    await activePage.getByRole('button', { name: 'Save changes', exact: true }).click();
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();
    await activePage.getByRole('link', { name: 'Schema', exact: true }).click();
    await activePage.getByRole('button', { name: 'Review and retry', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'Review schema changes' })).toBeVisible();
    await activePage.getByRole('button', { name: 'Confirm & apply', exact: true }).click();
    await expect(activePage.getByRole('row').filter({ hasText: 'category' })).toContainText('Yes');
    await expect(activePage.getByRole('row').filter({ hasText: 'category' })).toContainText('Applied');
    const appliedChange = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/changes/${changeSetId}`)).body) as Record<string, unknown>;
    expect(appliedChange.status).toBe('applied');
    expect(appliedChange.applyAttempts).toHaveLength(2);
    expect(appliedChange.appliedMigration).toBeTruthy();
    const duplicateAfterApply = await requestJSON(activePage, 'POST', `/admin/api/v1/collections/${postsId}/records`, {
      values: { title: 'duplicate-check', category: sharedCategory },
    }, undefined, 'include', [400, 409, 422]);
    expect([400, 409, 422]).toContain(duplicateAfterApply.status);
  });

  await test.step('FLOW-010 — Close page, gracefully restart same Project Root and verify durable state', async () => {
    const beforeRestart = readyRecord;
    expect(beforeRestart?.projectId).toBe(firstReady.projectId);
    await activePage.goto(`${runtimeURL}/requests/${encodeURIComponent(attachmentRequestId)}`);
    await expect(activePage.getByText(attachmentRequestId, { exact: true }).first()).toBeVisible();
    await expect(activePage.getByText(`${Buffer.byteLength(fileContents)} bytes`, { exact: true })).toBeVisible();
    await activePage.close();
    await stopRuntime();

    const statusOutput = execFileSync(runtimeBinary, ['status', '--project-root', projectRoot, '--json'], { cwd: repositoryRoot, encoding: 'utf8' });
    const diskStatus = JSON.parse(statusOutput) as { state: string; projectId: string; databasePath: string; localStorageState: string };
    expect(diskStatus.state).toBe('initialized');
    expect(diskStatus.projectId).toBe(firstReady.projectId);
    expect(diskStatus.databasePath).toContain('.modelry');
    expect(diskStatus.localStorageState).toBe('ready');

    const restarted = await startRuntime(projectRoot);
    expect(restarted.projectId).toBe(firstReady.projectId);
    await browserContext.clearCookies();
    activePage = await browserContext.newPage();
    addBrowserHealthGate(activePage, healthIssues, expectedHTTPFailures);
    expectedHTTPFailures.add(`401 ${new URL('/admin/api/v1/auth/session', runtimeURL).toString()}`);
    const deepLink = await activePage.goto(`${runtimeURL}/requests/${encodeURIComponent(attachmentRequestId)}`);
    expect(deepLink?.status()).toBe(200);
    await expect(activePage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await activePage.getByLabel('Email').fill(ownerEmail);
    await activePage.getByLabel('Password').fill(ownerPassword);
    await activePage.getByRole('button', { name: 'Sign in' }).click();
    await expect(activePage).toHaveURL(new RegExp(`/requests/${attachmentRequestId}`));
    await expect(activePage.getByText(attachmentRequestId, { exact: true }).first()).toBeVisible();
    await expect(activePage.getByText(`${Buffer.byteLength(fileContents)} bytes`, { exact: true })).toBeVisible();

    const runtimeStatus = unwrap((await requestJSON(activePage, 'GET', '/admin/api/v1/runtime/status')).body) as {
      state: string;
      database: { state: string };
      localStorage: { state: string };
    };
    expect(runtimeStatus.state).toBe('ready');
    expect(runtimeStatus.database.state).toBe('ready');
    expect(runtimeStatus.localStorage.state).toBe('ready');
    const durableSchemaHistory = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}/schema/history?limit=100`);
    expect(durableSchemaHistory.status).toBe(200);
    expect(JSON.stringify(durableSchemaHistory.body)).toContain(changeSetId);
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}`);
    await activePage.getByLabel('Search records').fill('post-');
    await expect(activePage.getByRole('row').filter({ hasText: 'post-a-updated' })).toBeVisible();
    await expect(activePage.getByRole('row').filter({ hasText: 'post-b' })).toBeVisible();
    await activePage.getByRole('row').filter({ hasText: 'post-a-updated' }).getByRole('button').filter({ hasText: 'post-a-updated' }).click();
    await expect(activePage.locator('.record-detail-values')).toContainText(authorRecordId);
    await expect(activePage.locator('.record-detail-values')).toContainText('Related: name: Ada Lovelace');
    await downloadAttachment(activePage, fileContents);
    await activePage.locator('.record-editor-actions').getByRole('button', { name: 'Close' }).click();

    const durableSession = await requestJSON(activePage, 'GET', '/api/v1/auth/users/session', undefined, appSession, 'omit');
    expect(durableSession.status).toBe(200);
    expect((await requestJSON(activePage, 'GET', '/api/v1/posts', undefined, appSession, 'omit')).status).toBe(200);
    expect([401, 403]).toContain((await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, undefined, 'omit', [401, 403])).status);
    expect((await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, appSession, 'omit')).status).toBe(200);
    expect((await requestJSON(activePage, 'GET', '/admin/api/v1/collections', undefined, revokedAPIKey, 'omit', [401])).status).toBe(401);
    const serviceAccount = await requestJSON(activePage, 'GET', `/admin/api/v1/service-accounts/${serviceAccountId}`);
    expect(serviceAccount.status).toBe(200);
    const requestDetail = await requestJSON(activePage, 'GET', `/admin/api/v1/requests/${deniedRequestId}`);
    expect(requestDetail.status).toBe(200);
    expect(JSON.stringify(requestDetail.body)).not.toContain(appSession);
    expect(JSON.stringify(requestDetail.body)).not.toContain(revokedAPIKey);
    const audit = await requestJSON(activePage, 'GET', '/admin/api/v1/audit?limit=100');
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain(revokedAPIKey);
    expect(healthIssues, 'Browser Health Gate: console/page errors, unexpected 5xx, and failed requests').toEqual([]);
  });
});
