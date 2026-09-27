import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './evidence-fixtures';
import { captureRuntimeLogs, persistRuntimeLogs, redactRuntimeText } from './runtime-logs';

type ReadyRecord = { state: string; url: string; projectId: string };
type RuntimeProcess = ChildProcessWithoutNullStreams;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'sidebar-owner@example.test';
const ownerPassword = 'Very-Strong-Sidebar-Password-42!';
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
  captureRuntimeLogs(child, 'sidebar-responsive');
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
    runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-sidebar-responsive-'));
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
    throw new Error('Tablet Sidebar setup failed during "' + setupStage + '": ' + redactRuntimeText(String(error)));
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
  await persistRuntimeLogs('sidebar-responsive');
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
}, 20_000);

test('768px Tablet Sidebar can collapse, expand, and preserve primary navigation', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 768, height: 976 });
  await page.addInitScript(() => localStorage.setItem('modelry-admin-locale', 'en'));
  await page.goto(runtimeURL, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await page.goto(runtimeURL + '/api', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'API Workspace' })).toBeVisible();

  const sidebar = page.getByRole('complementary', { name: 'Project navigation' });
  const workspace = page.locator('.workspace');
  const collapse = page.getByRole('button', { name: 'Collapse project navigation' });
  await expect(collapse).toBeVisible();
  await expect.poll(async () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(210);
  await collapse.click();
  await expect(page.getByRole('button', { name: 'Expand project navigation' })).toBeVisible();
  await expect.poll(async () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(72);
  await expect.poll(async () => workspace.evaluate((element) => getComputedStyle(element).marginLeft)).toBe('72px');
  await expect(page.getByRole('heading', { name: 'API Workspace' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);

  await page.getByRole('navigation', { name: 'Project navigation' }).getByRole('link', { name: 'Collections' }).click();
  await expect(page).toHaveURL(/\/collections$/);
  await expect(page.getByRole('heading', { name: 'Collections', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand project navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand project navigation' }).click();
  await expect(page.getByRole('button', { name: 'Collapse project navigation' })).toBeVisible();
  await expect.poll(async () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(210);
  await expect(page.getByRole('navigation', { name: 'Project navigation' }).getByRole('link', { name: 'Collections' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
});
