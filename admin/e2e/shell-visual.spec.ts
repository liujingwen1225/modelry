import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './evidence-fixtures';
import { captureRuntimeLogs, persistRuntimeLogs, redactRuntimeText } from './runtime-logs';

type ReadyRecord = { state: string; url: string; projectId: string };
type RuntimeProcess = ChildProcessWithoutNullStreams;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'shell-visual-owner@example.test';
const ownerPassword = 'Very-Strong-Shell-Visual-Password-42!';
let runtimeDirectory = '';
let projectRoot = '';
let runtimeBinary = '';
let runtimeLauncher = '';
let runtimeProcess: RuntimeProcess | undefined;
let runtimeProcessId: number | undefined;
let runtimeURL = '';
let setupStage = 'initializing';

function runChecked(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env, timeout: 90_000 });
}

function interruptWindowsRuntime(processId: number) {
  const members = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);';
  const command = "$member = '" + members + "'\nAdd-Type -Namespace Modelry -Name ConsoleControl -MemberDefinition $member\n[void][Modelry.ConsoleControl]::FreeConsole()\nif (-not [Modelry.ConsoleControl]::AttachConsole([uint32]" + processId + ")) { throw \"Could not attach to the Runtime console.\" }\nif (-not [Modelry.ConsoleControl]::GenerateConsoleCtrlEvent(1, [uint32]" + processId + ")) { throw \"Could not send a graceful Runtime interrupt.\" }\n[void][Modelry.ConsoleControl]::FreeConsole()";
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: repositoryRoot, stdio: 'inherit', timeout: 10_000 });
}

async function startRuntime(root: string): Promise<ReadyRecord> {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? runtimeLauncher : runtimeBinary;
  const args = isWindows
    ? [runtimeBinary, 'start', '--project-root', root, '--listen', '127.0.0.1:0']
    : ['start', '--project-root', root, '--listen', '127.0.0.1:0'];
  const child = spawn(command, args, { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  runtimeProcess = child;
  captureRuntimeLogs(child, 'shell-visual');
  let stdoutBuffer = '';
  let stderr = '';
  const ready = await new Promise<ReadyRecord>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime READY timeout; stderr: ' + redactRuntimeText(stderr))), 15_000);
    let record: ReadyRecord | undefined;
    const finish = () => {
      if (!record || (isWindows && !runtimeProcessId)) return;
      clearTimeout(timeout);
      resolve(record);
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
          finish();
        } else if (line.startsWith('READY ')) {
          try { record = JSON.parse(line.slice('READY '.length)) as ReadyRecord; }
          catch (error) { clearTimeout(timeout); reject(error); return; }
          finish();
        }
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) return;
      clearTimeout(timeout);
      reject(new Error('Runtime exited before READY (code=' + String(code) + ', signal=' + String(signal) + '); stderr: ' + redactRuntimeText(stderr)));
    });
  });
  if (ready.state !== 'ready' || !ready.url || !ready.projectId) throw new Error('Runtime emitted an invalid READY record.');
  runtimeURL = ready.url;
  return ready;
}

async function stopRuntime() {
  const child = runtimeProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime graceful shutdown timed out.')), 8_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  if (process.platform === 'win32') {
    if (!runtimeProcessId) throw new Error('Runtime launcher did not report its process id.');
    interruptWindowsRuntime(runtimeProcessId);
  } else child.kill('SIGINT');
  await exited;
  runtimeProcess = undefined;
}

test.beforeAll(async () => {
  try {
    setupStage = 'create isolated Runtime project';
    runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-shell-visual-'));
    projectRoot = path.join(runtimeDirectory, 'project');
    await mkdir(projectRoot);
    setupStage = 'build Admin assets';
    const npmCLI = process.env.npm_execpath;
    if (npmCLI) runChecked(process.execPath, [npmCLI, '--prefix', adminDirectory, 'run', 'build'], repositoryRoot);
    else runChecked(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', adminDirectory, 'run', 'build'], repositoryRoot);
    setupStage = 'build real Go Runtime';
    runtimeBinary = path.join(runtimeDirectory, process.platform === 'win32' ? 'modelry.exe' : 'modelry');
    runChecked(goCommand, ['build', '-o', runtimeBinary, './cmd/modelry'], repositoryRoot);
    if (process.platform === 'win32') {
      setupStage = 'build Windows Runtime launcher';
      runtimeLauncher = path.join(runtimeDirectory, 'modelry-e2e-launcher.exe');
      runChecked(goCommand, ['build', '-o', runtimeLauncher, './admin/e2e/windows-runtime-launcher'], repositoryRoot);
    }
    setupStage = 'start real Go Runtime';
    await startRuntime(projectRoot);
    setupStage = 'Runtime ready';
  } catch (error) {
    throw new Error('Shell visual acceptance setup failed during "' + setupStage + '": ' + redactRuntimeText(String(error)));
  }
}, 140_000);

test.afterAll(async () => {
  if (runtimeProcess && runtimeProcess.exitCode === null && runtimeProcess.signalCode === null) {
    try { await stopRuntime(); }
    catch {
      runtimeProcess?.kill();
      await new Promise<void>((resolve) => runtimeProcess?.once('exit', () => resolve()));
      runtimeProcess = undefined;
    }
  }
  await persistRuntimeLogs('shell-visual');
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
}, 20_000);

async function signIn(page: Page) {
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.locator('[data-shell-topbar]')).toBeVisible();
}

async function createCollection(page: Page, name: string): Promise<string> {
  const created = await page.evaluate(async (collectionName) => {
    const response = await fetch('/admin/api/v1/collections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: collectionName, type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] }),
    });
    return { status: response.status, body: await response.json() as { data?: { id?: string } } };
  }, name);
  expect(created.status).toBe(201);
  const id = created.body.data?.id;
  expect(id).toBeTruthy();
  return id!;
}

// Spec 0001 §18.6：真实浏览器验收覆盖四个断点、刷新/深链/返回、locale+theme 持久化、
// 纯键盘流程与焦点返回，以及控制台异常和意外 5xx。
test('Shell visual acceptance: breakpoints, durable preferences, keyboard flow and console health', async ({ page }) => {
  test.setTimeout(300_000);
  const consoleErrors: string[] = [];
  const unexpectedFailures: string[] = [];
  const expectedFailures = new Set<string>();
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // 未登录时的 /auth/session 401 是正常的引导探测（其它规格同样登记为预期失败），
    // 不属于控制台健康问题。
    if (text.includes('401') && (message.location()?.url ?? '').includes('/auth/session')) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => { consoleErrors.push(String(error)); });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(runtimeURL).origin) return;
    if (response.status() < 500) return;
    if (expectedFailures.has(`${response.status()} ${url.pathname}`)) return;
    unexpectedFailures.push(`${response.status()} ${url.pathname}`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  // 只在没有已保存偏好时给一个起点：否则每次 reload 都会把用户刚选的 locale 覆盖回 en，
  // 后面的「偏好跨刷新保持」断言就没有意义了。
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('modelry-admin-locale')) window.localStorage.setItem('modelry-admin-locale', 'en');
  });
  await page.goto(runtimeURL, { timeout: 20_000 });
  await signIn(page);
  const collectionId = await createCollection(page, 'shell_visual_records');

  // 390 / 768 / 1024 / 1440：主操作与资源上下文都不能丢，且不得出现横向溢出。
  const widths = [390, 768, 1024, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}`, { timeout: 20_000 });
    // exact：集合名（如 shell_visual_records）也包含 "records" 子串。
    await expect(page.getByRole('heading', { name: 'Records', level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create record', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Collection workspace' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(width);
  }

  // 刷新与深链接保留当前页面；返回回到上一页。
  // 旧 `/changes?view=pending` 仍可深链，但会被 route mapper 归一为 canonical `?tab=pending`。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${runtimeURL}/changes?view=pending`, { timeout: 20_000 });
  await expect(page).toHaveURL(/\/changes\?tab=pending$/);
  await page.reload({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/changes\?tab=pending$/);
  await expect(page.getByRole('heading', { name: 'Changes', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Change sections' })).toBeVisible();
  await page.goto(`${runtimeURL}/activity/audit`, { timeout: 20_000 });
  await page.goBack({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/changes\?tab=pending$/);

  // locale + theme 选择在刷新后保持，且不改变当前深链接。
  await page.getByRole('button', { name: 'Switch language to Simplified Chinese' }).click();
  await expect(page.getByRole('heading', { name: '变更', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '切换为深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('heading', { name: '变更', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/changes\?tab=pending$/);
  await page.getByRole('button', { name: '切换语言为 English' }).click();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // 纯键盘：跳过链接 → 命令面板 → Escape 后焦点回到触发控件。
  await page.goto(`${runtimeURL}/collections`, { timeout: 20_000 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  const paletteTrigger = page.locator('[data-command-palette-trigger]');
  await paletteTrigger.focus();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Search commands' }).fill('System settings');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await paletteTrigger.focus();
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(paletteTrigger).toBeFocused();

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(unexpectedFailures, `unexpected 5xx: ${unexpectedFailures.join(' | ')}`).toEqual([]);
});
