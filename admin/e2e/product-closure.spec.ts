import { selectOption } from './select-option';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type Page } from '@playwright/test';
import { expect, test } from './evidence-fixtures';
import { captureRuntimeLogs, persistRuntimeLogs, redactRuntimeText } from './runtime-logs';

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
  captureRuntimeLogs(child, 'product-closure');
  runtimeProcess = child;
  let stdoutBuffer = '';
  let stderr = '';
  const record = await new Promise<ReadyRecord>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime did not emit READY. stderr: ${redactRuntimeText(stderr)}`)), 60_000);
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
    child.stderr.on('data', (chunk: string) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) return;
      clearTimeout(timeout);
      reject(new Error(`Runtime exited before READY (code=${code}, signal=${signal}). stderr: ${redactRuntimeText(stderr)}`));
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
  await page.locator('[data-record-editor]').getByRole('button', { name: 'Create record', exact: true }).click();
  await expect(page.getByText('Record saved. The durable result is shown here.')).toBeVisible();
  const id = await page.locator('[data-record-identity] code').textContent();
  expect(id).toMatch(/^rec_/);
  await page.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();
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
    // 计算样式会把 oklch() 原样返回，因此这里自己做 OKLab → sRGB 转换，
    // 否则解析到的是 oklch 分量而不是 0-255 通道，对比度会算成 1:1。
    const encode = (channel: number) => {
      const clamped = Math.min(1, Math.max(0, channel));
      return Math.round((clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255);
    };
    const oklchChannels = (color: string) => {
      const match = color.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i);
      if (!match) return null;
      const lightness = match[1]!.endsWith('%') ? parseFloat(match[1]!) / 100 : parseFloat(match[1]!);
      const chroma = parseFloat(match[2]!);
      const hue = (parseFloat(match[3]!) * Math.PI) / 180;
      const a = chroma * Math.cos(hue);
      const b = chroma * Math.sin(hue);
      const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return [
        encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
      ];
    };
    const channels = (color: string) => {
      const converted = oklchChannels(color);
      if (converted) return converted;
      const match = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      return match && match.length === 3 ? match : null;
    };
    const luminance = (color: string) => {
      const values = channels(color);
      if (!values) throw new Error(`Could not read button color ${color}.`);
      const linear = values.map((value) => {
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
    return { primary: read('button bg-primary text-primary-foreground'), danger: read('button bg-destructive text-destructive-foreground') };
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
  await persistRuntimeLogs('product-closure');
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
});

test('V0.1 Product Closure: FLOW-001 through FLOW-010 on a real Runtime and empty Project Root', async ({ page }) => {
  test.setTimeout(7_200_000);
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
    await activePage.getByRole('button', { name: 'New', exact: true }).click();
    await activePage.getByLabel('Field name 1').fill('name');
    await activePage.getByRole('checkbox', { name: 'Required', exact: true }).check();
    await activePage.getByRole('button', { name: 'Create Collection', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'authors', level: 1 })).toBeVisible();
    authorsId = collectionId(activePage);
    await activePage.getByRole('button', { name: 'Create first record', exact: true }).click();
    await activePage.getByLabel('name · Required').fill('Ada Lovelace');
    await activePage.locator('[data-record-editor]').getByRole('button', { name: 'Create record', exact: true }).click();
    await expect(activePage.getByText('Record saved. The durable result is shown here.')).toBeVisible();
    authorRecordId = (await activePage.locator('[data-record-identity] code').textContent()) ?? '';
    expect(authorRecordId).toMatch(/^rec_/);
    await activePage.reload();
    await expect(activePage.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();
    const ownerState = await requestJSON(activePage, 'GET', '/admin/api/v1/bootstrap/status');
    expect(ownerState.status).toBe(200);
    expect(JSON.stringify(ownerState.body)).toContain('closed');
    const collections = await requestJSON(activePage, 'GET', '/admin/api/v1/collections');
    expect(JSON.stringify(collections.body)).toContain('authors');

    await activePage.goto(`${runtimeURL}/`);
    await expect(activePage.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    const productNavigation = activePage.getByRole('navigation', { name: 'Project navigation' });
    await expect(productNavigation.getByRole('link')).toHaveCount(9);
    // 每个入口的可见名称就是它的 accessible name（计数徽标是 aria-hidden 的装饰）。
    expect(await productNavigation.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('aria-label')))).toEqual([
      'Overview', 'Collections', 'API workspace', 'Hooks & Events', 'Scheduled jobs', 'Changes', 'Access & auth', 'Activity', 'System settings',
    ]);
    // 侧栏计数只来自真实快照。
    await expect(activePage.locator('[data-nav-count="collections"]')).toHaveText('1');
    await expect(activePage.locator('[data-nav-count="events"]')).toHaveText('0');
    await expect(activePage.locator('[data-nav-count="schedules"]')).toHaveText('0');
    // Spec 0001 §3.1：一级导航只用视觉分组 Workspace / Build / Operate / System，不形成额外页面层级。
    await expect(activePage.locator('[data-nav-group-label]')).toHaveText(['Workspace', 'Build', 'Operate', 'System']);
    await expect(activePage.locator('[data-shell-destination]')).toHaveText('Overview');
    // Spec 0001 §5.1：总览按 项目摘要 → 继续工作 / 快捷开始 → 最近活动 / 运行状态 组织，不复制诊断详情。
    await expect(activePage.locator('[data-overview-cards] [data-overview-card="collections"]')).toContainText('Collections');
    await expect(activePage.locator('[data-overview-continue]')).toContainText('authors');
    expect(await activePage.evaluate(() => {
      const cards = document.querySelector('[data-overview-cards]');
      const recentActivity = document.querySelector('[data-overview-recent-activity]');
      return Boolean(cards && recentActivity && (cards.compareDocumentPosition(recentActivity) & Node.DOCUMENT_POSITION_FOLLOWING));
    })).toBe(true);
    // MCP / 编码智能体卡片留在「快捷开始」内：命令与入口都是真实动作。
    const quickStart = activePage.locator('[data-overview-quick-start]');
    await expect(quickStart).toContainText('MCP / coding agent');
    await expect(quickStart.locator('code').first()).toContainText('modelry mcp --api-url');
    await expect(quickStart.getByRole('link', { name: 'Permissions and tokens' })).toHaveAttribute('href', '/access?tab=tokens');
    await expect(quickStart.getByRole('link', { name: 'Connection guide' })).toHaveAttribute('href', '/mcp');
    await expect(activePage.locator('.diagnostics-grid')).toHaveCount(0);
    await expect(activePage.getByRole('heading', { name: 'Needs attention' })).toHaveCount(0);
    await expect(activePage.getByText('Modelry Community', { exact: true })).toHaveCount(0);
    await expect(activePage.getByText('V0.1', { exact: true })).toHaveCount(0);
    await expect(activePage.locator('.brand-edition')).toHaveCount(0);

    // Hooks & Events：一级入口与页面内 Tab 都是真实链接，当前工作面由 aria-current 表达。
    await productNavigation.getByRole('link', { name: 'Hooks & Events' }).click();
    await expect(activePage).toHaveURL(`${runtimeURL}/events`);
    await expect(activePage.getByRole('heading', { name: 'Hooks & Events', level: 1 })).toBeVisible();
    await expect(productNavigation.getByRole('link', { name: 'Hooks & Events' })).toHaveAttribute('aria-current', 'page');
    const eventsNavigation = activePage.getByRole('navigation', { name: 'Hooks & Events sections' });
    await expect(eventsNavigation.getByRole('link', { name: 'Hooks', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(eventsNavigation.getByRole('link', { name: 'Webhooks' })).toHaveAttribute('href', '/events?tab=webhooks');
    await expect(eventsNavigation.getByRole('link', { name: 'Event triggers' })).toHaveAttribute('href', '/events?tab=triggers');
    await expect(eventsNavigation.getByRole('link', { name: 'Delivery history' })).toHaveAttribute('href', '/events?tab=deliveries');
    await expect(eventsNavigation.getByRole('link', { name: 'Extensions' })).toHaveCount(0);
    await expect(eventsNavigation.getByRole('link', { name: 'Secrets' })).toHaveCount(0);
    await eventsNavigation.getByRole('link', { name: 'Event triggers' }).click();
    await expect(activePage).toHaveURL(`${runtimeURL}/events?tab=triggers`);
    await expect(eventsNavigation.getByRole('link', { name: 'Event triggers' })).toHaveAttribute('aria-current', 'page');
    // 密钥配置属于系统设置；通过现有本地导航进入后，Hooks 不再是当前一级目的地。
    await activePage.goto(`${runtimeURL}/events`);
    await productNavigation.getByRole('link', { name: 'System settings' }).click();
    await activePage.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Secrets', exact: true }).click();
    await expect(activePage).toHaveURL(`${runtimeURL}/settings/secrets`);
    await expect(activePage.getByRole('heading', { name: 'Secrets', level: 2 })).toBeVisible();
    await expect(productNavigation.getByRole('link', { name: 'Hooks & Events' })).not.toHaveAttribute('aria-current', 'page');

    // 定时任务已从 Automations 拆成独立一级入口：旧 `?tab=jobs` 深链归一为 `/schedules?tab=jobs`。
    await activePage.goto(`${runtimeURL}/automations?tab=jobs&q=mail`);
    await expect(activePage).toHaveURL(`${runtimeURL}/schedules?tab=jobs&q=mail`);
    await expect(activePage.getByRole('heading', { name: 'Scheduled jobs', level: 1 })).toBeVisible();
    await expect(productNavigation.getByRole('link', { name: 'Scheduled jobs' })).toHaveAttribute('aria-current', 'page');
    await expect(productNavigation.getByRole('link', { name: 'Hooks & Events' })).not.toHaveAttribute('aria-current', 'page');
    const schedulesNavigation = activePage.getByRole('navigation', { name: 'Scheduled job sections' });
    // Tab 是真实链接，并且保留 `q` 这类既有筛选上下文。
    await expect(schedulesNavigation.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/schedules?tab=jobs&q=mail');
    await expect(schedulesNavigation.getByRole('link', { name: 'Execution history' })).toHaveAttribute('href', '/schedules?tab=history&q=mail');
    await expect(schedulesNavigation.getByRole('link', { name: 'Webhooks' })).toHaveCount(0);
    await expect(schedulesNavigation.getByRole('link', { name: 'Hooks', exact: true })).toHaveCount(0);

    // Access & auth：二级工作面是 管理员 / 应用认证 / API Tokens；审计时间线已并入活动记录。
    await activePage.goto(`${runtimeURL}/access`);
    await expect(activePage.getByRole('heading', { name: 'Access & auth', level: 1 })).toBeVisible();
    const accessNavigation = activePage.getByRole('navigation', { name: 'Access sections' });
    await expect(accessNavigation.getByRole('link', { name: 'Administrators' })).toHaveAttribute('href', '/access?tab=administrators');
    await expect(accessNavigation.getByRole('link', { name: 'Application auth' })).toHaveAttribute('href', '/access?tab=auth');
    await expect(accessNavigation.getByRole('link', { name: 'API Tokens' })).toHaveAttribute('href', '/access?tab=tokens');
    await expect(accessNavigation.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

    await productNavigation.getByRole('link', { name: 'System settings' }).click();
    await expect(activePage).toHaveURL(`${runtimeURL}/settings`);
    await expect(activePage.getByRole('heading', { name: 'System settings', level: 1 })).toBeVisible();
    const settingsNavigation = activePage.getByRole('navigation', { name: 'Settings sections' });
    for (const label of ['General', 'Runtime', 'Files & Storage', 'Mail', 'Secrets', 'Backup and restore', 'Data import / export']) {
      await expect(settingsNavigation.getByRole('link', { name: label })).toBeVisible();
    }

    await activePage.goto(`${runtimeURL}/settings/portability`);
    await expect(activePage).toHaveURL(`${runtimeURL}/settings/backups`);
    await expect(activePage.getByRole('heading', { name: 'Backup and restore', level: 2 })).toBeVisible();
    await expect(settingsNavigation.getByRole('link', { name: 'Backup and restore' })).toHaveAttribute('aria-current', 'page');
    await activePage.goto(`${runtimeURL}/settings/data`);
    await expect(activePage.getByRole('heading', { name: 'Data import / export', level: 2 })).toBeVisible();
    await expect(activePage.getByRole('button', { name: 'Create and download backup' })).toHaveCount(0);
    // 旧 `/settings/developer` 的契约工作面现在是 API 工作区的 OpenAPI Tab。
    await activePage.goto(`${runtimeURL}/settings/developer`);
    await expect(activePage).toHaveURL(`${runtimeURL}/api?tab=openapi`);
    await expect(activePage.getByRole('heading', { name: 'API workspace', level: 1 })).toBeVisible();
    await expect(activePage.getByRole('heading', { name: 'OpenAPI contract', level: 2 })).toBeVisible();
    await expect(activePage.getByTestId('contract-hash')).toBeVisible();
    await expect(activePage.getByRole('button', { name: 'Download openapi.json' })).toBeVisible();
    // MCP 说明不占一级菜单，由旧 `/settings/mcp` 深链归一为 `/mcp`。
    await activePage.goto(`${runtimeURL}/settings/mcp`);
    await expect(activePage).toHaveURL(`${runtimeURL}/mcp`);
    await expect(activePage.getByRole('heading', { name: 'MCP', level: 1 })).toBeVisible();
    await expect(activePage.locator('[data-shell-destination]')).toHaveText('MCP');
    // MCP 说明用真实账号权限摘要回答「智能体能做什么」，不再复述治理长段落。
    await expect(activePage.getByText('Connect a coding agent through a Service Account API Key, and see exactly what that account may do.')).toBeVisible();
    // 精确匹配：空态标题「No Service Accounts yet」也包含该子串。
    await expect(activePage.getByRole('heading', { name: 'Service Account', exact: true })).toBeVisible();

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

      await activePage.locator('[data-owner-menu] > button').click();
      const logoutResponsePromise = activePage.waitForResponse((response) =>
        new URL(response.url()).pathname === '/admin/api/v1/auth/logout' && response.request().method() === 'POST',
      );
      await activePage.getByRole('button', { name: 'Sign out', exact: true }).click();
      expect((await logoutResponsePromise).status()).toBe(204);
      await expect(activePage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(activePage.locator('[data-shell-topbar]')).toHaveCount(0);
      await expect(activePage.locator('[data-command-palette-trigger]')).toHaveCount(0);

      const revokedSession = await sessionClient.get(sessionURL, { headers: { Cookie: cookieHeader } });
      expect(revokedSession.status()).toBe(401);

      await activePage.getByLabel('Email').fill(ownerEmail);
      await activePage.getByLabel('Password').fill(ownerPassword);
      await activePage.getByRole('button', { name: 'Sign in' }).click();
      await expect(activePage).toHaveURL(`${runtimeURL}/collections/${encodeURIComponent(authorsId)}`);
      await expect(activePage.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();

      const shellDeepLink = `${runtimeURL}/collections/${encodeURIComponent(authorsId)}?tab=records#selected`;
      await activePage.goto(shellDeepLink);
      await expect(activePage.getByRole('heading', { name: 'authors', level: 1 })).toBeVisible();

      const ownerMenu = activePage.locator('[data-owner-menu]');
      await ownerMenu.locator('button').click();
      await expect(ownerMenu.getByRole('button', { name: /theme|主题/i })).toHaveCount(0);
      await ownerMenu.locator('button').click();

      const darkThemeButton = activePage.locator('[data-shell-topbar]').getByRole('button', { name: 'Switch to dark theme' });
      await expect(darkThemeButton).toBeVisible();
      await darkThemeButton.click();
      await expect(activePage.locator('html')).toHaveAttribute('data-theme', 'dark');
      await activePage.reload();
      await expect(activePage).toHaveURL(shellDeepLink);
      await expect(activePage.locator('html')).toHaveAttribute('data-theme', 'dark');
      const contrast = await actionButtonContrast(activePage);
      expect(contrast.primary).toBeGreaterThanOrEqual(4.5);
      expect(contrast.danger).toBeGreaterThanOrEqual(4.5);

      await activePage.getByRole('button', { name: 'Switch language to Simplified Chinese' }).click();
      const chineseNavigation = activePage.getByRole('navigation', { name: '项目导航' });
      await expect(chineseNavigation).toBeVisible();
      await expect(chineseNavigation.getByRole('link', { name: '集合' })).toBeVisible();
      await expect(activePage).toHaveURL(shellDeepLink);
      await expect(activePage.getByRole('heading', { name: 'authors', level: 1 })).toBeVisible();
      await activePage.reload();
      await expect(activePage).toHaveURL(shellDeepLink);
      await expect(activePage.getByRole('navigation', { name: '项目导航' })).toBeVisible();
      await expect(activePage.getByRole('button', { name: '切换语言为 English' })).toHaveText('EN');
      await expect(activePage.getByRole('heading', { name: 'authors', level: 1 })).toBeVisible();

      await activePage.getByRole('button', { name: '搜索命令' }).focus();
      await activePage.keyboard.press('Control+k');
      palette = activePage.getByRole('dialog', { name: '命令面板' });
      await expect(palette).toBeVisible();
      const paletteBounds = await palette.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const workspace = document.querySelector('[data-shell-workspace]');
        return {
          // 命令面板经 Portal 挂到 document.body，绝不能落在 Shell 工作区里（会被祖先的
          // overflow / transform 裁剪）。实现换成 base-ui Dialog 后不再有专属 overlay class，
          // 因此直接断言「有 body 级祖先，且不在 shell 工作区内」。
          mountedAtDocumentRoot: Boolean(workspace) && !workspace!.contains(element) && element.closest('body > *') !== null,
          top: bounds.top,
          bottom: bounds.bottom,
          viewportHeight: window.innerHeight,
        };
      });
      expect(paletteBounds.mountedAtDocumentRoot).toBe(true);
      expect(paletteBounds.top).toBeGreaterThanOrEqual(0);
      expect(paletteBounds.bottom).toBeLessThanOrEqual(paletteBounds.viewportHeight);
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
      await expect(activePage.getByRole('heading', { name: 'authors', level: 1 })).toBeVisible();

      await activePage.getByRole('button', { name: '切换语言为 English' }).click();
      await expect(activePage.getByRole('navigation', { name: 'Project navigation' })).toBeVisible();
      await activePage.locator('[data-shell-topbar]').getByRole('button', { name: 'Switch to light theme' }).click();
      await expect(activePage.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await sessionClient.dispose();
    }
  });

  await test.step('FLOW-002 — Create Normal and Auth Collections with their initial fields', async () => {
    await activePage.getByRole('link', { name: 'Collections', exact: true }).first().click();
    await activePage.getByRole('link', { name: 'Create Collection', exact: true }).click();
    await activePage.getByLabel('Collection name').fill('posts');
    await activePage.getByRole('button', { name: 'New', exact: true }).click();
    await activePage.getByLabel('Field name 1').fill('title');
    await activePage.getByRole('checkbox', { name: 'Required', exact: true }).check();
    await activePage.getByRole('button', { name: 'New', exact: true }).click();
    await activePage.getByLabel('Field name 2').fill('category');
    await activePage.getByRole('button', { name: 'New', exact: true }).click();
    const fileField = activePage.locator('[data-initial-field-row]').nth(2);
    await fileField.getByLabel('Field name 3').fill('attachment');
    await selectOption(activePage, fileField.getByLabel('Type', { exact: true }), 'file');
    await activePage.getByRole('button', { name: 'Create Collection', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'posts', level: 1 })).toBeVisible();
    postsId = collectionId(activePage);
    const detail = await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}`);
    expect(JSON.stringify(detail.body)).toContain('attachment');
    await activePage.reload();
    await expect(activePage.getByRole('button', { name: 'Create first record', exact: true })).toBeVisible();

    await activePage.getByRole('link', { name: 'Collections', exact: true }).first().click();
    await activePage.getByRole('link', { name: 'Create Collection', exact: true }).click();
    await activePage.getByRole('radio', { name: /Auth Collection/ }).check();
    await activePage.getByLabel('Collection name').fill('users');
    await expect(activePage.getByRole('checkbox', { name: /Allow users to sign up/ })).not.toBeChecked();
    await activePage.getByRole('button', { name: 'New', exact: true }).click();
    await activePage.getByLabel('Field name 1').fill('displayName');
    await activePage.getByRole('button', { name: 'Create Collection', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'users', level: 1 })).toBeVisible();
    usersId = collectionId(activePage);
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}`);
    await expect(activePage.getByRole('heading', { name: 'posts', level: 1 })).toBeVisible();
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
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();
    await activePage.getByLabel('Search records').fill('post-a-updated');
    await expect(activePage.getByRole('row').filter({ hasText: 'post-a-updated' })).toBeVisible();
    await activePage.reload();
    await expect(activePage.getByRole('row').filter({ hasText: 'post-a-updated' })).toBeVisible();
    await activePage.getByLabel('Search records').fill('');
    // 记录详情面板由 `?record=` 驱动：关闭编辑器后它仍然打开并覆盖表格，
    // 必须先清掉该参数（等价于关闭面板）才能点击行内操作。
    const recordsURL = new URL(activePage.url());
    recordsURL.searchParams.delete('record');
    recordsURL.searchParams.delete('edit');
    await activePage.goto(recordsURL.toString());

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
    await selectOption(activePage, activePage.getByLabel('Filter field'), 'category');
    await selectOption(activePage, activePage.getByLabel('Filter operator'), 'contains');
    await activePage.getByLabel('Filter value').fill('browse-');
    await activePage.getByLabel('Search records').fill('page-record');
    await selectOption(activePage, activePage.getByLabel('Sort field'), 'title');
    await selectOption(activePage, activePage.getByLabel('Sort direction'), 'asc');
    await expect(activePage.locator('[data-record-table] tbody tr')).toHaveCount(25);
    await expect(activePage.locator('[data-record-table] tbody tr').first()).toContainText('page-record-000');
    const nextPage = activePage.getByRole('button', { name: 'Next', exact: true });
    await expect(nextPage).toBeEnabled();
    await nextPage.click();
    await expect(activePage.locator('[data-record-table] tbody tr')).toHaveCount(1);
    const lastPageRow = activePage.locator('[data-record-table] tbody tr').first();
    await expect(lastPageRow).toContainText('page-record-025');
    const previousPage = activePage.getByRole('button', { name: 'Previous', exact: true });
    await expect(previousPage).toBeEnabled();
    await previousPage.click();
    await expect(activePage.locator('[data-record-table] tbody tr')).toHaveCount(25);
    await expect(activePage.locator('[data-record-table] tbody tr').first()).toContainText('page-record-000');
    await nextPage.click();
    await expect(activePage.locator('[data-record-table] tbody tr')).toHaveCount(1);
    await expect(activePage.locator('[data-record-table] tbody tr').first()).toContainText('page-record-025');
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
    await expect(activePage.locator('[data-record-identity] code')).toHaveText(deepLinkRecordId!);
    await expect(activePage.locator('[data-record-values]').getByText('page-record-025', { exact: true })).toBeVisible();
    await activePage.reload();
    await expect(activePage.locator('[data-record-identity] code')).toHaveText(deepLinkRecordId!);
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Edit', exact: true }).click();
    const editURL = new URL(activePage.url());
    expect(editURL.searchParams.get('record')).toBe(deepLinkRecordId);
    expect(editURL.searchParams.get('edit')).toBe('1');
    expect(editURL.searchParams.get('search')).toBe('page-record');
    expect(editURL.searchParams.get('filter')).toBe('category contains "browse-"');
    expect(editURL.searchParams.get('sort')).toBe('title asc');
    await expect(activePage.getByLabel('title · Required')).toHaveValue('page-record-025');
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(activePage.locator('[data-record-table] tbody tr')).toHaveCount(1);
    await lastPageRow.getByRole('button').filter({ hasText: 'page-record-025' }).click();
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();
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
    await activePage.getByRole('link', { name: 'Model', exact: true }).click();
    await activePage.getByRole('button', { name: 'Add field', exact: true }).click();
    await activePage.getByLabel('Field name', { exact: true }).fill('summary');
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await activePage.getByRole('button', { name: 'Relations', exact: true }).click();
    await activePage.getByRole('button', { name: 'Add relation', exact: true }).click();
    await activePage.getByLabel('Field name', { exact: true }).fill('author');
    await selectOption(activePage, activePage.getByLabel('Target Collection'), { label: 'authors' });
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await activePage.getByRole('button', { name: 'Add relation', exact: true }).click();
    await activePage.getByLabel('Field name', { exact: true }).fill('owner');
    await selectOption(activePage, activePage.getByLabel('Target Collection'), { label: 'users' });
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await activePage.getByRole('button', { name: 'Indexes', exact: true }).click();
    await activePage.getByRole('button', { name: 'Add index', exact: true }).click();
    await activePage.getByLabel('Index name').fill('posts_title_category');
    const indexFields = activePage.locator('#schema-index-fields');
    await selectOption(activePage, indexFields, [{ label: 'title' }, { label: 'category' }]);
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
    await expect(activePage).toHaveURL(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/model`);
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
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();

    await activePage.getByRole('row').filter({ hasText: 'post-a-updated' }).getByRole('button').filter({ hasText: 'post-a-updated' }).click();
    await expect(activePage.locator('[data-record-values]')).toContainText(authorRecordId);
    await expect(activePage.locator('[data-record-values]')).toContainText('Related: name: Ada Lovelace');
    await downloadAttachment(activePage, fileContents);
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();
    const collection = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}`)).body);
    expect(JSON.stringify(collection)).toContain('summary');
    expect(JSON.stringify(collection)).toContain('posts_title_category');
  });

  await test.step('FLOW-005 — Create an App User and revoke a real Session', async () => {
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(usersId)}`);
    await expect(activePage.getByRole('heading', { name: 'users', level: 1 })).toBeVisible();
    await activePage.getByRole('button', { name: /Create user/ }).first().click();
    await activePage.locator('#record-field-email').fill(appEmail);
    await activePage.locator('#record-field-displayName').fill('Ada');
    await activePage.getByLabel('Password', { exact: true }).fill(appPassword);
    await activePage.getByLabel('Confirm password').fill(appPassword);
    await activePage.locator('[data-record-editor]').getByRole('button', { name: 'Create user', exact: true }).click();
    await expect(activePage.getByText('Record saved. The durable result is shown here.')).toBeVisible();
    await expect(activePage.getByText(appEmail, { exact: true }).first()).toBeVisible();
    expect(await activePage.locator('body').innerText()).not.toContain(appPassword);
    appUserRecordId = (await activePage.locator('[data-record-identity] code').textContent()) ?? '';
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
    const appUserRow = activePage.locator('[data-user-row]').filter({ hasText: appEmail });
    await expect(appUserRow).toBeVisible();
    appUserRecordId = (await appUserRow.locator('span').textContent()) ?? '';
    expect(appUserRecordId).toMatch(/^rec_/);
    await appUserRow.getByRole('button', { name: 'View sessions' }).click();
    const activeSession = activePage.locator('[data-session-row]').filter({ hasText: 'active' });
    await expect(activeSession).toHaveCount(1);
    await activeSession.getByRole('button', { name: 'Revoke', exact: true }).click();
    await activePage.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await expect(activePage.getByText('Session revoked.', { exact: true })).toBeVisible();
    await expect(activePage.locator('[data-session-row]').filter({ hasText: 'revoked' })).toHaveCount(1);
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
    await expect(activePage.getByRole('heading', { name: 'Security', level: 2 })).toBeVisible();
    await activePage.getByRole('button', { name: 'Edit List access' }).click();
    await activePage.getByRole('radio', { name: /Signed-in users/ }).check();
    await activePage.getByRole('button', { name: 'Save pending rule' }).click();
    await activePage.getByRole('button', { name: 'Edit View access' }).click();
    await activePage.getByRole('radio', { name: /Signed-in users/ }).check();
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
      await activePage.getByRole('radio', { name: mode }).check();
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
      await activePage.getByRole('radio', { name: mode }).check();
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
      await selectOption(activePage, activePage.locator('#access-owner-field'), { label: 'owner' });
    });
    const ownerView = await requestJSON(activePage, 'GET', `/api/v1/posts/${firstPostId}`, undefined, appSession, 'omit');
    expect(ownerView.status).toBe(200);
    const nonOwnerView = await requestJSON(activePage, 'GET', `/api/v1/posts/${secondPostId}`, undefined, appSession, 'omit', [401, 403]);
    expect([401, 403]).toContain(nonOwnerView.status);

    await applyViewRule('Custom rule', async () => {
      await activePage.getByRole('button', { name: 'Add condition', exact: true }).click();
      await selectOption(activePage, activePage.getByLabel('Condition 1 field'), { label: 'title' });
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
    await activePage.locator('[data-api-endpoint-option]').filter({ hasText: 'List records' }).click();
    await expect(activePage.locator('[data-api-endpoint-meta]')).toContainText('Signed-in users');
    await activePage.getByText('View OpenAPI', { exact: true }).click();
    await expect(activePage.locator('[data-slot=popover-content] pre')).toContainText('x-modelry-access-rule');
    await expect(activePage.locator('[data-slot=popover-content] pre')).toContainText('signedInUsers');
    await activePage.getByLabel('App Session token (optional)').fill(appSession);
    const listResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/posts' && response.request().method() === 'GET');
    await activePage.getByRole('button', { name: 'Send GET request' }).click();
    expect((await listResponsePromise).status()).toBe(200);

    await activePage.locator('[data-api-endpoint-option]').filter({ hasText: 'Read a record' }).click();
    await activePage.getByLabel('Record ID').fill(firstPostId);
    await activePage.getByLabel('App Session token (optional)').fill('');
    const deniedPath = `/api/v1/posts/${firstPostId}`;
    expectedHTTPFailures.add(`403 ${new URL(deniedPath, runtimeURL).toString()}`);
    const deniedResponsePromise = activePage.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/posts/${firstPostId}`);
    await activePage.getByRole('button', { name: 'Send GET request' }).click();
    expect((await deniedResponsePromise).status()).toBe(403);
    await expect(activePage.getByText('403', { exact: true })).toBeVisible();
    const responseCodes = await activePage.locator('[data-api-response-metadata] code').allTextContents();
    deniedRequestId = responseCodes.find((value) => /^req_[A-Za-z0-9_-]{8,}$/.test(value)) ?? '';
    expect(deniedRequestId).toBeTruthy();
    await activePage.getByRole('link', { name: 'View durable request details' }).click();
    await expect(activePage).toHaveURL(new RegExp(`/api/requests/${deniedRequestId}`));
    await expect(activePage.getByText(deniedRequestId, { exact: true }).first()).toBeVisible();
    await expect(activePage.getByRole('heading', { name: 'Request details', level: 1 })).toBeVisible();
    await expect(activePage.getByRole('link', { name: 'Review access rules' })).toHaveAttribute('href', `/collections/${encodeURIComponent(postsId)}/access`);
    expect(await activePage.locator('body').innerText()).not.toContain(appSession);

    await activePage.goto(`${runtimeURL}/requests?search=${encodeURIComponent(deniedRequestId)}`);
    await expect(activePage).toHaveURL(`${runtimeURL}/api?tab=logs&search=${encodeURIComponent(deniedRequestId)}`);
    await expect(activePage.getByText(deniedRequestId, { exact: true }).first()).toBeVisible();
    await activePage.getByText(deniedRequestId, { exact: true }).first().click();
    await expect(activePage).toHaveURL(new RegExp(`/api/requests/${deniedRequestId}`));

    await activePage.goto(`${runtimeURL}/api?collection=${encodeURIComponent(postsId)}`);
    await activePage.locator('[data-api-endpoint-option]').filter({ hasText: 'Read a file attachment' }).click();
    await activePage.getByLabel('Record ID').fill(firstPostId);
    await selectOption(activePage, activePage.getByLabel('File field'), 'attachment');
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
    expect(await activePage.locator('[data-api-response-body]').count()).toBe(0);
    await activePage.getByRole('link', { name: 'View durable request details' }).click();
    await expect(activePage).toHaveURL(/\/api\/requests\/req_/);
    await expect(activePage.getByRole('region', { name: 'Request details' })).toContainText('/files/');
    await expect(activePage.getByRole('link', { name: 'Open endpoint' })).toHaveAttribute('href', '/api?tab=endpoints&collection=' + encodeURIComponent(postsId) + '&endpoint=readApplicationRecordFile');
    await expect(activePage.getByRole('link', { name: 'Open Collection API' })).toHaveAttribute('href', `/collections/${encodeURIComponent(postsId)}/api?endpoint=readApplicationRecordFile`);
  });

  await test.step('FLOW-008 — One-time Service Account key, authorization and revocation audit', async () => {
    // 服务账号与 API Key 现在位于「访问与认证」的 API Tokens 工作面。
    await activePage.goto(`${runtimeURL}/access?tab=tokens`);
    await expect(activePage.getByRole('heading', { name: 'API Tokens', level: 2 })).toBeVisible();
    await activePage.getByRole('button', { name: 'Create Service Account', exact: true }).first().click();
    const accountDialog = activePage.getByRole('dialog', { name: 'Create Service Account' });
    await accountDialog.getByLabel('Name').fill('ci-readonly');
    await expect(accountDialog.getByLabel('Permission preset')).toHaveAttribute('data-value', 'readOnly');
    await expect(accountDialog.getByRole('checkbox', { name: /Create API Key now/ })).toBeChecked();
    await accountDialog.getByRole('button', { name: 'Create Service Account', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'Copy your API Key now' })).toBeVisible();
    revokedAPIKey = (await activePage.locator('[data-access-reveal-secret] code').textContent()) ?? '';
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
    await expect(activePage.getByRole('row').filter({ hasText: 'Default API key' })).toContainText('Revoked');
    const revokedRead = await requestJSON(activePage, 'GET', '/admin/api/v1/collections', undefined, revokedAPIKey, 'omit', [401]);
    expect(revokedRead.status).toBe(401);

    const auditBody = await requestJSON(activePage, 'GET', '/admin/api/v1/audit?limit=100');
    expect(auditBody.status).toBe(200);
    expect(JSON.stringify(auditBody.body)).not.toContain(revokedAPIKey);
    // 旧 `/access/audit` 深链归一为活动记录的管理面审计来源（`source=audit` 是默认值），
    // 其余审计筛选参数原样保留。
    await activePage.goto(`${runtimeURL}/access/audit?action=${encodeURIComponent('apiKey.revoked')}`);
    await expect(activePage).toHaveURL(`${runtimeURL}/activity?action=${encodeURIComponent('apiKey.revoked')}&source=audit`);
    const auditRow = activePage.locator('[data-audit-table] tbody tr').filter({ hasText: 'apiKey.revoked' });
    await expect(auditRow).toBeVisible();
    const auditLink = auditRow.getByRole('link').first();
    await auditLink.click();
    await expect(activePage).toHaveURL(/\/activity\/audit\/[^?]+\?from=/);
    await expect(activePage.locator('[data-audit-detail-grid]')).toContainText('apiKey.revoked');
    await expect(activePage.locator('[data-audit-resource] pre')).toContainText('apiKey');
    expect(await activePage.locator('body').innerText()).not.toContain(revokedAPIKey);
  });

  await test.step('FLOW-009 — Durable unique-conflict failure and successful retry', async () => {
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/model`);
    await activePage.getByRole('row').filter({ hasText: 'category' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await activePage.getByRole('checkbox', { name: 'Unique', exact: true }).check();
    await activePage.getByRole('button', { name: 'Save to Pending Changes' }).click();
    await expect(activePage.getByRole('status').filter({ hasText: /^Saved to Pending Changes\.$/ })).toBeVisible();
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
    await activePage.goto(`${runtimeURL}/collections/${encodeURIComponent(postsId)}/model`);
    const unchanged = unwrap((await requestJSON(activePage, 'GET', `/admin/api/v1/collections/${postsId}`)).body);
    const categoryField = (unchanged as { fields: Array<{ name: string; unique?: boolean }> }).fields.find((field) => field.name === 'category');
    expect(categoryField).toBeDefined();
    expect(categoryField?.unique ?? false).toBe(false);

    await activePage.getByRole('link', { name: 'Records', exact: true }).click();
    await activePage.getByLabel('Search records').fill('post-b');
    await activePage.getByRole('row').filter({ hasText: 'post-b' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await activePage.locator('#record-field-category').fill('different-category');
    await activePage.getByRole('button', { name: 'Save changes', exact: true }).click();
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();
    await activePage.getByRole('link', { name: 'Model', exact: true }).click();
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

    // Spec 0001 §7.1/§18.5-4：MCP 子页必须展示真实命令、绑定账号的权限摘要，
    // 以及来自 Activity 的最近操作；它不复制配置，也从不回显 API Key 明文。
    await activePage.goto(`${runtimeURL}/connect/mcp`);
    await expect(activePage).toHaveURL(`${runtimeURL}/mcp`);
    await expect(activePage.getByRole('heading', { name: 'MCP', level: 1 })).toBeVisible();
    await expect(activePage.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>')).toBeVisible();
    const mcpAccountRow = activePage.locator('[data-mcp-account-row]').filter({ hasText: 'ci-readonly' });
    await expect(mcpAccountRow).toBeVisible();
    await expect(mcpAccountRow).toContainText('Read only');
    await expect(mcpAccountRow).toContainText('Active');
    // 服务账号与 API Key 的入口现在指向「访问与认证」的 API Tokens 工作面（不再复制配置）。
    await expect(activePage.locator('#main-content').getByRole('link', { name: 'Access & auth' })).toHaveAttribute('href', '/access?tab=tokens');
    expect(await activePage.locator('body').innerText()).not.toContain(revokedAPIKey);
  });

  await test.step('FLOW-010 — Close page, gracefully restart same Project Root and verify durable state', async () => {
    const beforeRestart = readyRecord;
    expect(beforeRestart?.projectId).toBe(firstReady.projectId);
    await activePage.goto(`${runtimeURL}/requests/${encodeURIComponent(attachmentRequestId)}`);
    await expect(activePage).toHaveURL(`${runtimeURL}/api/requests/${encodeURIComponent(attachmentRequestId)}`);
    await expect(activePage.getByText(attachmentRequestId, { exact: true }).first()).toBeVisible();
    await expect(activePage.getByRole('region', { name: 'Request details' })).toContainText('/files/');
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
    await expect(activePage).toHaveURL(new RegExp(`/api/requests/${attachmentRequestId}`));
    await expect(activePage.getByText(attachmentRequestId, { exact: true }).first()).toBeVisible();
    await expect(activePage.getByRole('region', { name: 'Request details' })).toContainText('/files/');

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
    await expect(activePage.locator('[data-record-values]')).toContainText(authorRecordId);
    await expect(activePage.locator('[data-record-values]')).toContainText('Related: name: Ada Lovelace');
    await downloadAttachment(activePage, fileContents);
    await activePage.locator('[data-record-editor-actions]').getByRole('button', { name: 'Close' }).click();

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
