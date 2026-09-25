import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

type ReadyRecord = { state: string; url: string; projectId: string };
type RuntimeProcess = ChildProcessWithoutNullStreams;
type HookRun = {
  runId: string;
  recordId: string;
  phase: 'before' | 'afterCommit';
  status: string;
  errorCode: string;
  correlationId: string;
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'owner@example.test';
const ownerPassword = 'Very-Strong-Owner-Password-42!';
const secretMarker = 'WP23_WRITE_ONLY_SECRET_MARKER';

let runtimeDirectory = '';
let projectRoot = '';
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
  const child = spawn(command, args, { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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

async function requestJSON(page: Page, method: string, requestPath: string, body?: unknown, expectedStatuses: number[] = []) {
  const url = new URL(requestPath, runtimeURL).toString();
  const expected = (page as Page & { expectedHTTPFailures?: Set<string> }).expectedHTTPFailures;
  for (const status of expectedStatuses) expected?.add(`${status} ${url}`);
  const result = await page.evaluate(async (input) => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: input.path.startsWith('/admin/') ? 'include' : 'omit',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { status: response.status, body: await response.json() };
  }, { method, path: requestPath, body });
  if (expected) {
    for (const status of expectedStatuses) {
      if (status !== result.status) expected.delete(`${status} ${url}`);
    }
  }
  return result;
}

async function listRuns(page: Page, extensionId: string) {
  const response = await requestJSON(page, 'GET', `/admin/api/v1/extensions/${encodeURIComponent(extensionId)}/runs?limit=100`);
  expect(response.status).toBe(200);
  return (response.body as { data: HookRun[] }).data;
}

async function projectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? projectFiles(entryPath) : Promise.resolve([entryPath]);
  }));
  return nested.flat();
}

async function expectSecretAbsentFromProjectFiles() {
  const files = await projectFiles(path.join(projectRoot, '.modelry'));
  for (const file of files) {
    const contents = await readFile(file);
    expect(contents.includes(Buffer.from(secretMarker)), `Secret value persisted in ${file}`).toBe(false);
  }
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-wp23-'));
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

test('WP23 Extension lifecycle and write-only Secrets recover on a same-root restart', async ({ page }) => {
  test.setTimeout(300_000);
  const issues: string[] = [];
  const expectedHTTPFailures = new Set<string>();
  (page as Page & { expectedHTTPFailures?: Set<string> }).expectedHTTPFailures = expectedHTTPFailures;
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: the server responded with a status of ')) issues.push(`Console: ${message.text()}`);
  });
  page.on('pageerror', (error) => issues.push(`Page: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !(response.status() < 500 && expectedHTTPFailures.delete(`${response.status()} ${response.url()}`))) {
      issues.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });

  expect(await readdir(projectRoot)).toEqual([]);
  const firstRuntime = await startRuntime(projectRoot);
  expectedHTTPFailures.add(`401 ${new URL('/admin/api/v1/auth/session', runtimeURL).toString()}`);
  const setup = await page.goto(runtimeURL);
  expect(setup?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);
  await page.getByLabel('Collection name').fill('lifecycle-items');
  await page.getByLabel('Field name 1').fill('title');
  await page.getByLabel('Required', { exact: true }).check();
  await page.getByRole('button', { name: 'Create Collection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'lifecycle-items' })).toBeVisible();
  const collectionId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  expect(collectionId).toMatch(/^col_/);

  await page.goto(`${runtimeURL}/secrets`);
  await expect(page.getByRole('heading', { name: 'Secrets', exact: true })).toBeVisible();
  await page.locator('#secret-name').fill('Lifecycle secret');
  await page.locator('#secret-value').fill(secretMarker);
  const secretResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/v1/secrets');
  await page.locator('.extension-secret-create form button[type="submit"]').click();
  const createdSecret = await secretResponse;
  expect(createdSecret.status()).toBe(201);
  expect(await createdSecret.text()).not.toContain(secretMarker);
  await expect(page.getByRole('status').filter({ hasText: 'Secret saved.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secretMarker);
  await stopRuntime();
  await expectSecretAbsentFromProjectFiles();
  const secretRestart = await startRuntime(projectRoot);
  expect(secretRestart.projectId).toBe(firstRuntime.projectId);
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.goto(`${runtimeURL}/extensions`);
  await page.locator('#extension-create-name').fill('Lifecycle guard');
  await page.locator('#extension-create-language').selectOption('typescript');
  await page.locator('#extension-create-source').fill('export function beforeCreate() { return { action: "reject" }; }');
  await page.locator('.extension-create-card form button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: 'Lifecycle guard' })).toBeVisible();
  const extensionId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
  expect(extensionId).toMatch(/^ext_/);

  await page.getByRole('button', { name: 'Add binding' }).click();
  await page.locator('#binding-collection-0').selectOption(collectionId);
  await page.getByRole('button', { name: 'Add binding' }).click();
  await page.locator('#binding-collection-1').selectOption(collectionId);
  await page.locator('#binding-phase-1').selectOption('afterCommit');
  await page.getByRole('button', { name: 'Add alias' }).click();
  await page.locator('#secret-alias-0').fill('MAIL_KEY');
  const secretId = await page.locator('#secret-id-0').inputValue();
  expect(secretId).toMatch(/^sec_/);
  await page.locator('.extension-editor button[type="submit"]').click();
  await expect(page.getByRole('button', { name: 'Enable' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible();

  const denied = await requestJSON(page, 'POST', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, {
    values: { title: 'BLOCKED_MARKER' },
  }, [422]);
  expect(denied.status).toBe(422);
  expect(JSON.stringify(denied.body)).toContain('CHANGE_REJECTED_BY_EXTENSION');
  const recordsAfterReject = await requestJSON(page, 'GET', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records?limit=100`);
  expect(recordsAfterReject.status).toBe(200);
  expect(JSON.stringify(recordsAfterReject.body)).not.toContain('BLOCKED_MARKER');

  const allowedSource = `export function beforeCreate(context: { values: Record<string, unknown> }) {
  return { action: "allow", values: { ...context.values, title: String(context.values.title) + "-hooked" } };
}
export function afterCommitCreate() {
  const secret = modelry.secrets.get("MAIL_KEY");
  if (typeof secret !== "string" || secret.length !== ${secretMarker.length}) throw new Error("secret lookup failed");
}`;
  await page.locator('#extension-source').fill(allowedSource);
  await page.locator('.extension-editor button[type="submit"]').click();
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible();
  const allowed = await requestJSON(page, 'POST', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, {
    values: { title: 'ALLOWED_MARKER' },
  });
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  const allowedRecordId = ((allowed.body as { data: { id: string } }).data.id);
  expect(allowedRecordId).toMatch(/^rec_/);
  const recordsAfterAllow = await requestJSON(page, 'GET', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records?limit=100`);
  expect(JSON.stringify(recordsAfterAllow.body)).toContain('ALLOWED_MARKER-hooked');
  expect(JSON.stringify(recordsAfterAllow.body)).not.toContain(secretMarker);

  let completedRuns: HookRun[] = [];
  await expect.poll(async () => {
    completedRuns = await listRuns(page, extensionId);
    return completedRuns.some((run) => run.recordId === allowedRecordId && run.phase === 'afterCommit' && run.status === 'succeeded');
  }, { timeout: 15_000 }).toBe(true);
  const successfulBefore = completedRuns.find((run) => run.phase === 'before' && run.status === 'succeeded');
  const successfulAfter = completedRuns.find((run) => run.recordId === allowedRecordId && run.phase === 'afterCommit');
  expect(successfulBefore?.status).toBe('succeeded');
  expect(successfulAfter?.status).toBe('succeeded');
  expect(successfulBefore?.errorCode).toBe('none');
  expect(successfulAfter?.errorCode).toBe('none');
  expect(successfulBefore?.correlationId).toMatch(/^cor_[a-f0-9]{36}$/);
  expect(successfulAfter?.correlationId).toMatch(/^cor_[a-f0-9]{36}$/);
  expect(JSON.stringify(completedRuns)).not.toContain(secretMarker);

  await stopRuntime();
  await expectSecretAbsentFromProjectFiles();
  const postHookRestart = await startRuntime(projectRoot);
  expect(postHookRestart.projectId).toBe(firstRuntime.projectId);
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto(`${runtimeURL}/extensions/${encodeURIComponent(extensionId)}`);
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible();

  const longRunningSource = `export function beforeCreate(context: { values: Record<string, unknown> }) {
  return { action: "allow", values: { ...context.values, title: String(context.values.title) + "-hooked" } };
}
export function afterCommitCreate() { while (true) {} }`;
  await page.locator('#extension-source').fill(longRunningSource);
  await page.locator('.extension-editor button[type="submit"]').click();
  const interruptedWrite = await requestJSON(page, 'POST', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, {
    values: { title: 'RESTART_MARKER' },
  });
  expect(interruptedWrite.status).toBe(201);
  const interruptedRecordId = (interruptedWrite.body as { data: { id: string } }).data.id;
  await expect.poll(async () => {
    const runs = await listRuns(page, extensionId);
    return runs.some((run) => run.recordId === interruptedRecordId && run.phase === 'afterCommit' && run.status === 'running');
  }, { timeout: 10_000 }).toBe(true);

  await stopRuntime();
  const restartedRuntime = await startRuntime(projectRoot);
  expect(restartedRuntime.projectId).toBe(firstRuntime.projectId);
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.goto(`${runtimeURL}/extensions/${encodeURIComponent(extensionId)}?tab=runs`);
  await expect(page.getByRole('heading', { name: 'Lifecycle guard' })).toBeVisible();
  await expect.poll(async () => {
    const runs = await listRuns(page, extensionId);
    return runs.find((run) => run.recordId === interruptedRecordId && run.phase === 'afterCommit')?.status;
  }, { timeout: 10_000 }).toBe('interrupted');
  await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Disable' }).click();
  await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible();
  const disabledWrite = await requestJSON(page, 'POST', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, {
    values: { title: 'DISABLED_MARKER' },
  });
  expect(disabledWrite.status).toBe(201);
  expect(JSON.stringify(disabledWrite.body)).toContain('DISABLED_MARKER');
  expect(JSON.stringify(disabledWrite.body)).not.toContain('DISABLED_MARKER-hooked');
  expect(JSON.stringify(await listRuns(page, extensionId))).not.toContain((disabledWrite.body as { data: { id: string } }).data.id);
  expect(issues).toEqual([]);
});
