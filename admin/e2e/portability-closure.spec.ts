import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

let runtimeDirectory = '';
let projectRoot = '';
let archiveDirectory = '';
let runtimeBinary = '';
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

async function startRuntime(root: string): Promise<ReadyRecord> {
  runtimeProcessId = undefined;
  const isWindows = process.platform === 'win32';
  const command = isWindows ? runtimeLauncher : runtimeBinary;
  const args = isWindows ? [runtimeBinary, 'start', '--project-root', root, '--listen', '127.0.0.1:0'] : ['start', '--project-root', root, '--listen', '127.0.0.1:0'];
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
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-wp28-'));
  projectRoot = path.join(runtimeDirectory, 'project');
  archiveDirectory = path.join(runtimeDirectory, 'archives');
  await mkdir(projectRoot);
  await mkdir(archiveDirectory);
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

test('WP28 backup, restore preflight, export/import, and the typed contract stay product-complete', async ({ page }) => {
  test.setTimeout(300_000);
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

  await startRuntime(projectRoot);
  expectedHTTPFailures.add('401 ' + new URL('/admin/api/v1/auth/session', runtimeURL).toString());
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);

  const collection = await requestJSON(page, 'POST', '/admin/api/v1/collections', {
    name: 'posts', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }],
  });
  expect(collection.status).toBe(201);
  const collectionId = (JSON.parse(collection.text) as { data: { id: string } }).data.id;
  const record = await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/records', { values: { title: 'portable' } });
  expect(record.status).toBe(201);

  await page.goto(runtimeURL + '/settings/portability');
  await expect(page.getByRole('heading', { name: 'Developer and portability', level: 1 })).toBeVisible();
  const hash = await page.getByTestId('contract-hash').textContent();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);

  // Backup：Runtime 产生一个带 manifest 的 tar 归档。
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Create and download backup/ }).click();
  const download = await downloadPromise;
  const bundlePath = path.join(archiveDirectory, download.suggestedFilename());
  await download.saveAs(bundlePath);
  const bundle = await readFile(bundlePath);
  expect(bundle.includes(Buffer.from('manifest.json'))).toBe(true);
  expect(bundle.includes(Buffer.from('modelry.community.backup'))).toBe(true);
  expect(download.suggestedFilename()).toMatch(/^modelry-backup-[0-9a-f]{12}\.tar$/);

  // Preflight：同一个 bundle 兼容；篡改后必须报告不兼容。
  await page.getByLabel('Validate a backup bundle').setInputFiles(bundlePath);
  await expect(page.getByText('Compatible', { exact: true })).toBeVisible();
  await expect(page.getByText(/stays a CLI operation/)).toBeVisible();
  const tamperedPath = path.join(archiveDirectory, 'tampered.tar');
  const tampered = Buffer.from(bundle);
  const markerIndex = tampered.indexOf(Buffer.from('portable'));
  expect(markerIndex).toBeGreaterThan(0);
  tampered[markerIndex] = 0x78;
  await writeFile(tamperedPath, tampered);
  await page.getByLabel('Validate a backup bundle').setInputFiles(tamperedPath);
  await expect(page.getByText('Not compatible', { exact: true })).toBeVisible();

  // Export / Import：导出写入 NDJSON，导入通过 Record 语义创建记录。
  await page.getByRole('button', { name: 'Export NDJSON' }).click();
  await expect(page.getByLabel('NDJSON stream')).toHaveValue(/portable/, { timeout: 15_000 });
  await page.getByLabel('NDJSON stream').fill(
    (await page.getByLabel('NDJSON stream').inputValue()).split('\n')[0] + '\n' + '{"kind":"record","values":{"title":"imported"}}\n',
  );
  await page.getByRole('button', { name: 'Import NDJSON' }).click();
  await expect(page.getByText(/1 imported · 0 failed/)).toBeVisible();
  const listed = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + collectionId + '/records?limit=10');
  expect(JSON.parse(listed.text) as { data: unknown[] }).toBeTruthy();
  const titles = listed.text;
  expect(titles).toContain('portable');
  expect(titles).toContain('imported');

  // Request log 与 Audit 不因备份/预演而泄漏载荷；备份与预演产生审计事实。
  const audit = await requestJSON(page, 'GET', '/admin/api/v1/audit?limit=20');
  expect(audit.status).toBe(200);
  expect(audit.text).toContain('backup.created');
  expect(audit.text).toContain('restore.preflight');
  expect(audit.text).not.toContain('portable');

  await stopRuntime();
  expect(issues).toEqual([]);
});