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
    cwd: repositoryRoot, stdio: 'inherit', env: process.env, shell: process.platform === 'win32',
  });
}

function interruptWindowsRuntime(processId: number) {
  const members = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);';
  const command = '$member = \'' + members + '\'\nAdd-Type -Namespace Modelry -Name ConsoleControl -MemberDefinition $member\n[void][Modelry.ConsoleControl]::FreeConsole()\nif (-not [Modelry.ConsoleControl]::AttachConsole([uint32]' + processId + ')) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not attach to the Runtime console (Win32 error $errorCode)." }\nif (-not [Modelry.ConsoleControl]::GenerateConsoleCtrlEvent(1, [uint32]' + processId + ')) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not send a graceful Runtime interrupt (Win32 error $errorCode)." }\n[void][Modelry.ConsoleControl]::FreeConsole()';
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: repositoryRoot, stdio: 'inherit' });
}

// startRuntime 可以在没有 --listen 的情况下启动，用来验证 Project Runtime Settings 驱动监听地址。
async function startRuntime(root: string, withListenFlag: boolean): Promise<ReadyRecord> {
  runtimeProcessId = undefined;
  const isWindows = process.platform === 'win32';
  const command = isWindows ? runtimeLauncher : runtimeBinary;
  const runtimeArgs = ['start', '--project-root', root];
  if (withListenFlag) runtimeArgs.push('--listen', '127.0.0.1:0');
  const args = isWindows ? [runtimeBinary, ...runtimeArgs] : runtimeArgs;
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

type ExpectedFailures = Map<string, number>;

function expectFailureCount(failures: ExpectedFailures, status: number, requestPath: string, times = 1) {
  const key = String(status) + ' ' + new URL(requestPath, runtimeURL).toString();
  failures.set(key, (failures.get(key) ?? 0) + times);
}

async function requestJSON(page: Page, method: string, requestPath: string, body?: unknown, expectedStatuses: number[] = []) {
  const expected = (page as Page & { expectedHTTPFailures?: ExpectedFailures }).expectedHTTPFailures;
  if (expected) for (const status of expectedStatuses) expectFailureCount(expected, status, requestPath);
  return page.evaluate(async (input) => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: input.path.startsWith('/admin/') ? 'include' : 'omit',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
  }, { method, path: requestPath, body });
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.topbar')).toBeVisible();
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-wp27-'));
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

test('WP27 policy simulation, activity, drift, and runtime settings stay product-complete', async ({ page }) => {
  test.setTimeout(600_000);
  const issues: string[] = [];
  const expectedHTTPFailures: ExpectedFailures = new Map();
  (page as Page & { expectedHTTPFailures?: ExpectedFailures }).expectedHTTPFailures = expectedHTTPFailures;
  const expectFailure = (status: number, requestPath: string, times = 1) => expectFailureCount(expectedHTTPFailures, status, requestPath, times);
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: the server responded with a status of ')) issues.push('Console: ' + message.text());
  });
  page.on('pageerror', (error) => issues.push('Page: ' + error.message));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const key = String(response.status()) + ' ' + response.url();
    const remaining = expectedHTTPFailures.get(key) ?? 0;
    if (remaining > 0) {
      expectedHTTPFailures.set(key, remaining - 1);
      return;
    }
    issues.push('HTTP ' + String(response.status()) + ': ' + response.url());
  });

  const firstRuntime = await startRuntime(projectRoot, true);
  expectFailure(401, '/admin/api/v1/auth/session');
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);

  // Runtime Settings：默认来源、flag 优先级、restart requirement 与持久化。
  await page.goto(runtimeURL + '/settings/runtime');
  await expect(page.getByRole('heading', { name: 'Runtime settings', level: 1 })).toBeVisible();
  await expect(page.getByText('from --listen').first()).toBeVisible();
  const saved = await requestJSON(page, 'PUT', '/admin/api/v1/settings', {
    expectedRevision: 1, listenAddress: '127.0.0.1:0', requestRetentionDays: 14,
  });
  expect(saved.status).toBe(200);
  const savedBody = saved.body as { data: { listenAddress: { source: string; restartRequired: boolean }; requestRetentionDays: { value: string; source: string } } };
  expect(savedBody.data.listenAddress.source).toBe('flag');
  expect(savedBody.data.listenAddress.restartRequired).toBe(false);
  expect(savedBody.data.requestRetentionDays).toMatchObject({ value: '14', source: 'project' });
  const invalid = await requestJSON(page, 'PUT', '/admin/api/v1/settings', {
    expectedRevision: 2, listenAddress: 'not-a-host-port', requestRetentionDays: 14,
  }, [422]);
  expect(invalid.status).toBe(422);

  // Collection + pending change：Activity 与 Drift 都必须把它呈现为「预期」，而不是不一致。
  const collection = await requestJSON(page, 'POST', '/admin/api/v1/collections', {
    name: 'posts', type: 'Normal', fields: [{ name: 'title', type: 'text' }],
  }, [201]);
  expect(collection.status).toBe(201);
  const collectionId = (collection.body as { data: { id: string } }).data.id;
  const pending = await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/schema/pending-operations', {
    kind: 'field', action: 'add', definition: { name: 'summary', type: 'text' },
  });
  expect([200, 201]).toContain(pending.status);

  await page.goto(runtimeURL + '/settings/drift');
  await expect(page.getByRole('heading', { name: 'Drift', level: 1 })).toBeVisible();
  await expect(page.getByText('A saved change is waiting for review')).toBeVisible();
  await expect(page.getByText('No drift detected')).toBeVisible();

  await page.goto(runtimeURL + '/activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  const pendingRow = page.locator('li[data-activity-kind="change.pending"]').first();
  await expect(pendingRow).toBeVisible();
  await expect(pendingRow.getByText('posts')).toBeVisible();
  await expect(pendingRow.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/collections/' + collectionId + '/schema');
  // Activity 不是请求日志：请求面产生的 RequestRecord 不出现在这里。
  expect(await page.locator('li[data-activity-kind="request.record"]').count()).toBe(0);

  // Policy Simulation：先预演默认 noAccess，再用真实匿名请求交叉验证同一 evaluator。
  await page.goto(runtimeURL + '/collections/' + collectionId + '/security');
  await expect(page.getByRole('heading', { name: 'Simulate a request' })).toBeVisible();
  await page.getByLabel('Operation').selectOption('list');
  await page.getByLabel('Principal').selectOption('anonymous');
  await page.getByRole('button', { name: 'Simulate' }).click();
  const deniedPanel = page.locator('[data-simulation-decision="deny"]');
  await expect(deniedPanel).toBeVisible();
  await expect(deniedPanel).toContainText('not authoritative');

  const realDenied = await requestJSON(page, 'GET', '/api/v1/posts?limit=1', undefined, [403]);
  expect(realDenied.status).toBe(403);

  const rules = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + collectionId + '/access-rules');
  expect(rules.status).toBe(200);
  const applied = (rules.body as { data: { applied: Array<{ operation: string; mode: string }>; version: number } }).data;
  const nextRules = applied.applied.map((rule) => rule.operation === 'list' ? { operation: 'list', mode: 'anyone' } : rule);
  const savedRules = await requestJSON(page, 'PUT', '/admin/api/v1/collections/' + collectionId + '/access-rules', {
    expectedVersion: applied.version, rules: nextRules,
  });
  expect(savedRules.status).toBe(200);
  const appliedVersion = (savedRules.body as { data: { version: number } }).data.version;
  const applyRules = await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/access-rules/apply', { expectedVersion: appliedVersion });
  expect(applyRules.status).toBe(200);

  await page.reload();
  await page.getByRole('button', { name: 'Simulate' }).click();
  const allowedPanel = page.locator('[data-simulation-decision="allow"]');
  await expect(allowedPanel).toBeVisible();
  await expect(allowedPanel).toContainText('not authoritative');
  await expect(allowedPanel).toContainText('anyone');
  const realAllowed = await requestJSON(page, 'GET', '/api/v1/posts?limit=1');
  expect(realAllowed.status).toBe(200);

  // 应用变更后 Activity 出现 change.applied，Drift 恢复 healthy。
  const pendingChange = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + collectionId + '/schema/pending-change');
  const changeVersion = (pendingChange.body as { data: { version: number } }).data.version;
  const appliedChange = await requestJSON(page, 'POST', '/admin/api/v1/collections/' + collectionId + '/schema/apply', { expectedVersion: changeVersion, confirmRisk: true });
  expect([200, 201]).toContain(appliedChange.status);
  await page.goto(runtimeURL + '/activity');
  await expect(page.locator('li[data-activity-kind="change.applied"]').first()).toBeVisible();

  // 关闭并重启：Project Runtime Settings 决定监听地址，且不再要求重启。
  await stopRuntime();
  await startRuntime(projectRoot, false);
  expectFailure(401, '/admin/api/v1/auth/session');
  await page.goto(runtimeURL);
  // Cookie 不区分端口：同一主机的耐久会话可能仍然有效，此时无需再次登录。
  if (await page.locator('.topbar').count() === 0) {
    await signIn(page, ownerEmail, ownerPassword);
  }
  const afterRestart = await requestJSON(page, 'GET', '/admin/api/v1/settings');
  const restarted = afterRestart.body as { data: { listenAddress: { source: string; restartRequired: boolean }; requestRetentionDays: { value: string } } };
  expect(restarted.data.listenAddress.source).toBe('project');
  expect(restarted.data.listenAddress.restartRequired).toBe(false);
  expect(restarted.data.requestRetentionDays.value).toBe('14');
  expect(new URL(runtimeURL).port).not.toBe(new URL(firstRuntime.url).port);

  expect(issues).toEqual([]);
});