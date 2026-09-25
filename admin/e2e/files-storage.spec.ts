import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
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
const s3AccessKey = 'MODELRY_E2E_ACCESS_KEY';
const s3SecretKey = 'MODELRY_E2E_SECRET_KEY_MARKER';
const bucketName = 'modelry-e2e-bucket';

let runtimeDirectory = '';
let projectRoot = '';
let runtimeBinary = '';
let runtimeLauncher = '';
let runtimeProcess: RuntimeProcess | undefined;
let runtimeProcessId: number | undefined;
let runtimeURL = '';
let fakeS3: { url: string; server: Server; close: () => Promise<void> } | undefined;

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
  const args = isWindows
    ? [runtimeBinary, 'start', '--project-root', root, '--listen', '127.0.0.1:0']
    : ['start', '--project-root', root, '--listen', '127.0.0.1:0'];
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

// startFakeS3 启动一个最小的 S3-compatible 端点：Runtime 用真实 SigV4 请求访问它。
async function startFakeS3(): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const objects = new Map<string, { body: Buffer; contentType: string; modified: Date }>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const listRequest = request.method === 'GET' && url.searchParams.get('list-type') === '2';
    if (listRequest) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const maxKeys = Number(url.searchParams.get('max-keys') ?? '1000');
      const keys = [...objects.keys()].filter((item) => item.startsWith(prefix)).sort().slice(0, maxKeys);
      const contents = keys.map((item) => {
        const object = objects.get(item)!;
        return '<Contents><Key>' + item + '</Key><Size>' + String(object.body.length) + '</Size><LastModified>' + object.modified.toISOString() + '</LastModified></Contents>';
      }).join('');
      const payload = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' + contents + '</ListBucketResult>';
      response.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': String(Buffer.byteLength(payload)) });
      response.end(payload);
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        objects.set(key, { body: Buffer.concat(chunks), contentType: request.headers['content-type'] ?? 'application/octet-stream', modified: new Date() });
        response.writeHead(200).end();
      });
      return;
    }
    const object = objects.get(key);
    if (request.method === 'HEAD' || request.method === 'GET') {
      if (!object) { response.writeHead(404).end(); return; }
      const headers = { 'Content-Type': object.contentType, 'Content-Length': String(object.body.length) };
      response.writeHead(200, headers);
      if (request.method === 'GET') response.end(object.body); else response.end();
      return;
    }
    if (request.method === 'DELETE') {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake S3 did not bind a TCP port');
  return {
    url: 'http://127.0.0.1:' + String(address.port),
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function requestJSON(page: Page, method: string, requestPath: string, body?: unknown, expectedStatuses: number[] = []) {
  const url = new URL(requestPath, runtimeURL).toString();
  const expected = (page as Page & { expectedHTTPFailures?: Set<string> }).expectedHTTPFailures;
  for (const status of expectedStatuses) expected?.add(String(status) + ' ' + url);
  const result = await page.evaluate(async (input) => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: input.path.startsWith('/admin/') ? 'include' : 'omit',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    return { status: response.status, text };
  }, { method, path: requestPath, body });
  return { status: result.status, body: result.text ? JSON.parse(result.text) : undefined, text: result.text };
}

async function readFileBytes(page: Page, requestPath: string): Promise<string> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'include' });
    return await response.text();
  }, requestPath);
}

async function projectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? projectFiles(entryPath) : Promise.resolve([entryPath]);
  }));
  return nested.flat();
}

async function expectMarkerAbsentFromProjectFiles(marker: string) {
  const files = await projectFiles(path.join(projectRoot, '.modelry'));
  for (const file of files) {
    const contents = await readFile(file);
    expect(contents.includes(Buffer.from(marker)), 'marker persisted in ' + file).toBe(false);
  }
}

async function waitForMigrationCompletion(page: Page, migrationId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await requestJSON(page, 'GET', '/admin/api/v1/storage/files/migrations/' + migrationId);
    expect(response.status).toBe(200);
    const status = (response.body as { data: { status: string } }).data.status;
    if (status === 'completed') return;
    if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
      throw new Error('migration ended as ' + status + ': ' + response.text);
    }
    await page.waitForTimeout(500);
  }
  throw new Error('migration ' + migrationId + ' did not complete');
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-wp25-'));
  projectRoot = path.join(runtimeDirectory, 'project');
  await mkdir(projectRoot);
  buildAdmin();
  runtimeBinary = path.join(runtimeDirectory, process.platform === 'win32' ? 'modelry.exe' : 'modelry');
  runChecked(goCommand, ['build', '-o', runtimeBinary, './cmd/modelry'], repositoryRoot);
  if (process.platform === 'win32') {
    runtimeLauncher = path.join(runtimeDirectory, 'modelry-e2e-launcher.exe');
    runChecked(goCommand, ['build', '-o', runtimeLauncher, './admin/e2e/windows-runtime-launcher'], repositoryRoot);
  }
  fakeS3 = await startFakeS3();
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
  if (fakeS3) await fakeS3.close();
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
});

test('WP25 multiple File values, Provider migration, and same-root restart stay product-complete', async ({ page }) => {
  test.setTimeout(300_000);
  const issues: string[] = [];
  const expectedHTTPFailures = new Set<string>();
  (page as Page & { expectedHTTPFailures?: Set<string> }).expectedHTTPFailures = expectedHTTPFailures;
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: the server responded with a status of ')) issues.push('Console: ' + message.text());
  });
  page.on('pageerror', (error) => issues.push('Page: ' + error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && !(response.status() < 500 && expectedHTTPFailures.delete(String(response.status()) + ' ' + response.url()))) {
      issues.push('HTTP ' + String(response.status()) + ': ' + response.url());
    }
  });

  expect(await readdir(projectRoot)).toEqual([]);
  await startRuntime(projectRoot);
  expectedHTTPFailures.add('401 ' + new URL('/admin/api/v1/auth/session', runtimeURL).toString());
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);

  // Collection with a required text field and an ordered files field.
  await page.getByLabel('Collection name').fill('documents');
  const titleFieldRow = page.locator('.initial-field-row').nth(0);
  await titleFieldRow.getByLabel('Field name 1').fill('title');
  await titleFieldRow.getByLabel('Required', { exact: true }).check();
  await titleFieldRow.getByLabel('Field name 1').press('Enter');
  const filesFieldRow = page.locator('.initial-field-row').nth(1);
  await filesFieldRow.getByLabel('Field name 2').fill('attachments');
  await filesFieldRow.getByLabel('Type', { exact: true }).selectOption('files');
  await page.getByRole('button', { name: 'Create Collection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'documents' })).toBeVisible();
  const collectionId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  expect(collectionId).toMatch(/^col_/);

  // Create a Record with two ordered File values through the Admin UI.
  await page.getByRole('button', { name: 'Create record' }).first().click();
  await page.locator('#record-field-title').fill('quarterly bundle');
  await page.getByLabel('attachments files').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first attachment bytes') },
    { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second attachment bytes') },
  ]);
  await expect(page.getByText('first attachment bytes', { exact: false })).toHaveCount(0);
  await page.locator('.record-editor-actions button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: /quarterly bundle|documents/ })).toBeVisible();

  const listed = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records?limit=10');
  expect(listed.status).toBe(200);
  const recordId = (listed.body as { data: Array<{ id: string }> }).data[0]?.id ?? '';
  expect(recordId).toMatch(/^rec_/);
  const created = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId));
  expect(created.status).toBe(200);
  const attachments = (created.body as { data: { attachments: string[] } }).data.attachments;
  expect(Array.isArray(attachments)).toBe(true);
  expect(attachments.length).toBe(2);
  for (const key of attachments) expect(key).toMatch(/^obj_[0-9a-f]{32}$/);

  const firstBytes = await readFileBytes(page, '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments/0');
  const secondBytes = await readFileBytes(page, '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments/1');
  expect(firstBytes).toBe('first attachment bytes');
  expect(secondBytes).toBe('second attachment bytes');
  const outOfRange = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments/5', undefined, [404]);
  expect(outOfRange.status).toBe(404);
  const singleRoute = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments', undefined, [400]);
  expect(singleRoute.status).toBe(400);

  // Files & storage shows the Local Provider with two referenced objects.
  await page.goto(runtimeURL + '/settings/storage');
  await expect(page.getByRole('heading', { name: 'Files & storage' })).toBeVisible();
  await expect(page.getByText('Local', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Referenced files')).toBeVisible();
  await expect(page.locator('.storage-status__facts')).toContainText('2');

  // Two write-only Secrets hold the S3 credentials.
  await page.goto(runtimeURL + '/secrets');
  await expect(page.getByRole('heading', { name: 'Secrets', exact: true })).toBeVisible();
  for (const secret of [{ name: 'S3 access key', value: s3AccessKey }, { name: 'S3 secret key', value: s3SecretKey }]) {
    await page.locator('#secret-name').fill(secret.name);
    await page.locator('#secret-value').fill(secret.value);
    const created2 = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/v1/secrets');
    await page.locator('.extension-secret-create form button[type="submit"]').click();
    expect((await created2).status()).toBe(201);
    await expect(page.locator('body')).not.toContainText(secret.value);
  }

  // Configure the S3-compatible Provider and prove that referenced objects require a migration first.
  await page.goto(runtimeURL + '/settings/storage');
  await expect(page.getByRole('heading', { name: 'Files & storage' })).toBeVisible();
  await page.getByLabel('Provider').selectOption('s3');
  await page.getByLabel('Endpoint').fill(fakeS3!.url);
  await page.getByLabel('Region').fill('us-east-1');
  await page.getByLabel('Bucket').fill(bucketName);
  await page.getByLabel('Key prefix').fill('modelry');
  await page.getByLabel('Access key Secret').selectOption({ label: 'S3 access key' });
  await page.getByLabel('Secret key Secret').selectOption({ label: 'S3 secret key' });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/S3-compatible Storage is responding/)).toBeVisible();
  expectedHTTPFailures.add('409 ' + new URL('/admin/api/v1/storage/files/provider', runtimeURL).toString());
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.getByText(/Start a migration before changing the Provider/)).toBeVisible();

  // Start the durable migration and wait for the Provider switch.
  const migrationResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/v1/storage/files/migrations');
  await page.getByRole('button', { name: /Start migration/ }).click();
  const started = await migrationResponse;
  expect(started.status()).toBe(202);
  const migrationId = ((await started.json()) as { data: { id: string } }).data.id;
  expect(migrationId).toMatch(/^fmig_[0-9a-f]{32}$/);
  await waitForMigrationCompletion(page, migrationId);

  // The Provider switched, the Record value did not change, and reads still work.
  const afterMigration = await requestJSON(page, 'GET', '/admin/api/v1/storage/files');
  expect(afterMigration.status).toBe(200);
  expect((afterMigration.body as { data: { activeProvider: string } }).data.activeProvider).toBe('s3');
  const unchanged = await requestJSON(page, 'GET', '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId));
  expect((unchanged.body as { data: { attachments: string[] } }).data.attachments).toEqual(attachments);
  expect(await readFileBytes(page, '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments/0')).toBe('first attachment bytes');
  expect(await readFileBytes(page, '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments/1')).toBe('second attachment bytes');
  await page.goto(runtimeURL + '/settings/storage');
  await expect(page.getByText('S3-compatible', { exact: true }).first()).toBeVisible();

  // Credentials never reach the Project directory.
  await stopRuntime();
  await expectMarkerAbsentFromProjectFiles(s3SecretKey);
  await expectMarkerAbsentFromProjectFiles(s3AccessKey);

  // Same-root restart keeps the Provider, the migration history, and file reads.
  await startRuntime(projectRoot);
  await page.goto(runtimeURL + '/settings/storage');
  await expect(page.getByRole('heading', { name: 'Files & storage' })).toBeVisible();
  const migrationAfterRestart = await requestJSON(page, 'GET', '/admin/api/v1/storage/files/migrations/' + migrationId);
  expect(migrationAfterRestart.status).toBe(200);
  expect((migrationAfterRestart.body as { data: { status: string; copiedObjects: number } }).data).toMatchObject({ status: 'completed', copiedObjects: 2 });
  const storageAfterRestart = await requestJSON(page, 'GET', '/admin/api/v1/storage/files');
  expect((storageAfterRestart.body as { data: { activeProvider: string } }).data.activeProvider).toBe('s3');
  expect(await readFileBytes(page, '/admin/api/v1/collections/' + encodeURIComponent(collectionId) + '/records/' + encodeURIComponent(recordId) + '/files/attachments/0')).toBe('first attachment bytes');

  expect(issues).toEqual([]);
});
