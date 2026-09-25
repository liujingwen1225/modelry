import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

type ReadyRecord = { state: string; url: string; projectId: string };
type RuntimeProcess = ChildProcessWithoutNullStreams;
type CapturedRequest = { path: string; body: string; idempotencyKey: string; deliveryId: string; eventId?: string; signature: string };
type FixtureAction = { status: number; gate?: Promise<void>; received?: (request: CapturedRequest) => void };
type Delivery = {
  id: string; sourceType: string; sourceId: string; webhookId: string; eventId?: string; eventType: string;
  status: string; attemptCount: number; manualRedriveCount: number; errorCode: string;
  attempts: Array<{ round: number; attempt: number; status: string; httpStatus?: number; errorCode: string }>;
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'owner@example.test';
const ownerPassword = 'Very-Strong-Owner-Password-42!';
const privateRecordMarker = 'WP24_RECORD_PAYLOAD_MUST_STAY_PRIVATE';
const responseBodyMarker = 'WP24_FIXTURE_RESPONSE_BODY_MUST_STAY_PRIVATE';
let runtimeDirectory = '';
let projectRoot = '';
let runtimeBinary = '';
let runtimeLauncher = '';
let runtimeProcess: RuntimeProcess | undefined;
let runtimeProcessId: number | undefined;
let runtimeURL = '';
let readyRecord: ReadyRecord | undefined;
let fixture: LocalWebhookFixture | undefined;
let fixtureAddress = '';
let fixtureCA = '';
const observedAdminRequestIds = new Set<string>();

class LocalWebhookFixture {
  private server?: Server;
  private readonly plans = new Map<string, FixtureAction[]>();
  readonly requests: CapturedRequest[] = [];

  async start(certificatePath: string, keyPath: string): Promise<string> {
    const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
    this.server = createServer({ cert, key }, (request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      throw new Error('Webhook test fixture must bind to IPv4 loopback only.');
    }
    return `127.0.0.1:${address.port}`;
  }

  respond(pathname: string, ...statuses: number[]) {
    const queue = this.plans.get(pathname) ?? [];
    for (const status of statuses) queue.push({ status });
    this.plans.set(pathname, queue);
  }

  blockNext(pathname: string): { received: Promise<CapturedRequest>; release: () => void } {
    let openGate!: () => void;
    let receive!: (request: CapturedRequest) => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const received = new Promise<CapturedRequest>((resolve) => { receive = resolve; });
    const queue = this.plans.get(pathname) ?? [];
    queue.push({ status: 204, gate, received: receive });
    this.plans.set(pathname, queue);
    return { received, release: openGate };
  }

  count(pathname: string): number {
    return this.requests.filter((request) => request.path === pathname).length;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.server = undefined;
  }

  private async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const pathname = new URL(request.url ?? '/', 'https://hooks.modelry.test').pathname;
    const body = Buffer.concat(chunks).toString('utf8');
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] ?? '' : value ?? '';
    };
    const captured: CapturedRequest = {
      path: pathname,
      body,
      idempotencyKey: header('idempotency-key'),
      deliveryId: header('x-modelry-delivery-id'),
      ...(header('x-modelry-event-id') ? { eventId: header('x-modelry-event-id') } : {}),
      signature: header('x-modelry-signature'),
    };
    this.requests.push(captured);
    const action = this.plans.get(pathname)?.shift() ?? { status: 204 };
    action.received?.(captured);
    if (action.gate) {
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => { disconnected = resolve; });
      response.once('close', disconnected);
      await Promise.race([action.gate, closed]);
      response.off('close', disconnected);
      if (response.destroyed) return;
    }
    response.writeHead(action.status, { 'Content-Type': 'text/plain' });
    response.end(responseBodyMarker);
  }
}

function runChecked(command: string, args: string[], cwd: string, env = process.env) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env });
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
  const command = `$member = '${members}'\nAdd-Type -Namespace Modelry -Name ConsoleControl -MemberDefinition $member\n[void][Modelry.ConsoleControl]::FreeConsole()\nif (-not [Modelry.ConsoleControl]::AttachConsole([uint32]${processId})) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not attach to the Runtime console (Win32 error $errorCode)." }\nif (-not [Modelry.ConsoleControl]::GenerateConsoleCtrlEvent(1, [uint32]${processId})) { $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Could not send a graceful Runtime interrupt (Win32 error $errorCode)." }\n[void][Modelry.ConsoleControl]::FreeConsole()`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: repositoryRoot, stdio: 'inherit' });
}

async function startRuntime(root: string): Promise<ReadyRecord> {
  runtimeProcessId = undefined;
  const isWindows = process.platform === 'win32';
  const command = isWindows ? runtimeLauncher : runtimeBinary;
  const args = isWindows ? [runtimeBinary, 'start', '--project-root', root, '--listen', '127.0.0.1:0'] : ['start', '--project-root', root, '--listen', '127.0.0.1:0'];
  const runtimeEnv = { ...process.env, MODELRY_E2E_WEBHOOK_FIXTURE_ADDR: fixtureAddress, MODELRY_E2E_WEBHOOK_CA: fixtureCA, MODELRY_E2E_RETRY_DELAY_MS: process.env.MODELRY_E2E_RETRY_DELAY_MS ?? '1100' };
  const child = spawn(command, args, { cwd: repositoryRoot, env: runtimeEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
        if (line.startsWith('RUNTIME_PID ')) { runtimeProcessId = Number(line.slice('RUNTIME_PID '.length)); finishWhenReady(); continue; }
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
    const timeout = setTimeout(() => reject(new Error('Runtime did not stop after graceful cancellation.')), 30_000);
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
      credentials: 'include',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    let responseBody: unknown;
    try { responseBody = await response.json(); } catch { responseBody = await response.text(); }
    return { status: response.status, requestId: response.headers.get('X-Request-Id'), body: responseBody };
  }, { method, path: requestPath, body });
}

function data<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Expected an API response with a data field.');
  return (value as { data: T }).data;
}

function assertWebhookSignature(request: CapturedRequest, secret: string): string {
  const match = request.signature.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  expect(match, 'Webhook signature must include a Unix timestamp and SHA-256 digest').not.toBeNull();
  const timestamp = match![1]!;
  const expectedDigest = createHmac('sha256', secret).update(`${timestamp}.${request.body}`, 'utf8').digest('hex');
  expect(match![2]).toBe(expectedDigest);
  return timestamp;
}

async function getDelivery(page: Page, id: string): Promise<Delivery> {
  const response = await requestJSON(page, 'GET', `/admin/api/v1/deliveries/${encodeURIComponent(id)}`);
  expect(response.status).toBe(200);
  return data<Delivery>(response.body);
}

async function listDeliveries(page: Page): Promise<Delivery[]> {
  const response = await requestJSON(page, 'GET', '/admin/api/v1/deliveries?limit=100');
  expect(response.status).toBe(200);
  const value = response.body as { data?: Delivery[] };
  return Array.isArray(value.data) ? value.data : [];
}

async function waitForDelivery(page: Page, predicate: (delivery: Delivery) => boolean, status?: string): Promise<Delivery> {
  let matched: Delivery | undefined;
  await expect.poll(async () => {
    const items = await listDeliveries(page);
    matched = items.find((delivery) => predicate(delivery));
    if (!matched || (status && matched.status !== status)) return matched ? `${matched.status}:${matched.errorCode}` : 'missing';
    return matched.status;
  }, { timeout: 30_000, intervals: [100, 200, 400, 800] }).toBe(status ?? 'succeeded');
  if (!matched) throw new Error('Delivery did not appear in durable history.');
  return matched;
}

async function waitForDeliveryStatus(page: Page, id: string, expected: string): Promise<Delivery> {
  let delivery: Delivery | undefined;
  await expect.poll(async () => {
    delivery = await getDelivery(page, id);
    return delivery.status;
  }, { timeout: 30_000, intervals: [100, 200, 400, 800] }).toBe(expected);
  if (!delivery) throw new Error('Delivery status was not available.');
  return delivery;
}

async function createSecret(page: Page, name: string, value: string): Promise<string> {
  await page.goto(`${runtimeURL}/secrets`);
  await expect(page.getByRole('heading', { name: 'Secrets', exact: true })).toBeVisible();
  await page.locator('#secret-name').fill(name);
  await page.locator('#secret-value').fill(value);
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/v1/secrets');
  await page.locator('.extension-secret-create form button[type="submit"]').click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const responseBody = await response.text();
  expect(responseBody).not.toContain(value);
  const raw = JSON.parse(responseBody) as { data?: { id?: string }; id?: string };
  const secretId = raw.data?.id ?? raw.id;
  expect(secretId).toMatch(/^sec_/);
  await expect(page.locator('body')).not.toContainText(value);
  return secretId!;
}

async function createWebhook(page: Page, name: string, pathname: string, secretId: string) {
  await page.goto(`${runtimeURL}/automations?tab=webhooks`);
  await page.getByRole('button', { name: 'Create Webhook' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByLabel('HTTPS destination').fill(`https://hooks.modelry.test${pathname}`);
  await page.getByLabel('Signing Secret').selectOption(secretId);
  await page.getByRole('button', { name: 'Save Webhook' }).click();
  const card = page.locator('.automation-card').filter({ hasText: name });
  await expect(card).toBeVisible();
  const result = await requestJSON(page, 'GET', '/admin/api/v1/webhooks');
  expect(result.status).toBe(200);
  const webhooks = data<Array<{ id: string; name: string; enabled: boolean; targetUrl: string; signingSecretId: string }>>(result.body);
  const webhook = webhooks.find((item) => item.name === name);
  expect(webhook).toBeTruthy();
  expect(webhook?.enabled).toBe(false);
  expect(webhook?.targetUrl).toBe(`https://hooks.modelry.test${pathname}`);
  expect(webhook?.signingSecretId).toBe(secretId);
  await card.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(card.getByText('Enabled', { exact: true })).toBeVisible();
  return webhook!;
}

async function createEventHook(page: Page, name: string, collectionId: string, webhookId: string) {
  await page.goto(`${runtimeURL}/automations?tab=eventHooks`);
  await page.getByRole('button', { name: 'Create Event Hook' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByLabel('Collection').selectOption(collectionId);
  await page.getByLabel('Record Event').selectOption('record.created');
  await page.getByLabel('Webhook').selectOption(webhookId);
  await page.getByRole('button', { name: 'Save Event Hook' }).click();
  const card = page.locator('.automation-card').filter({ hasText: name });
  await expect(card).toBeVisible();
  const response = await requestJSON(page, 'GET', '/admin/api/v1/event-hooks');
  expect(response.status).toBe(200);
  const hook = data<Array<{ id: string; name: string; enabled: boolean }>>(response.body).find((item) => item.name === name);
  expect(hook).toBeTruthy();
  expect(hook?.enabled).toBe(false);
  await card.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(card.getByText('Enabled', { exact: true })).toBeVisible();
  return hook!;
}

async function createRecord(page: Page, collectionId: string, title: string) {
  await page.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}`);
  if (await page.getByRole('button', { name: 'Create first record', exact: true }).count()) {
    await page.getByRole('button', { name: 'Create first record', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Create record', exact: true }).first().click();
  }
  await page.getByLabel('title · Required').fill(title);
  await page.locator('.record-editor').getByRole('button', { name: 'Create record', exact: true }).click();
  await expect(page.getByText('Record saved. The durable result is shown here.')).toBeVisible();
  const recordId = await page.locator('.record-detail-identity code').textContent();
  expect(recordId).toMatch(/^rec_/);
  return recordId!;
}

async function deliveryForEvent(page: Page, hookId: string, eventId: string, status?: string) {
  const summary = await waitForDelivery(page, (delivery) => delivery.sourceId === hookId && delivery.eventId === eventId, status);
  return getDelivery(page, summary.id);
}

async function deliveryPage(page: Page, id: string) {
  await page.goto(`${runtimeURL}/automations?tab=deliveries&deliveryId=${encodeURIComponent(id)}`);
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByText(id, { exact: true })).toBeVisible();
}

function findSensitiveField(value: unknown, path = '$'): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findSensitiveField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const forbidden = new Set(['payload', 'targeturl', 'target_url', 'signature', 'signaturevalue', 'secret', 'secretvalue', 'signingsecret', 'requestbody', 'responsebody', 'requestheaders', 'responseheaders', 'rawerror']);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) return `${path}.${key}`;
    const found = findSensitiveField(child, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

async function expectNoSensitiveDiagnostics(page: Page, markers: string[]) {
  const deliveries = await listDeliveries(page);
  const allDeliveries = await Promise.all(deliveries.map((item) => getDelivery(page, item.id)));
  const deliveryText = JSON.stringify(allDeliveries);
  expect(findSensitiveField(allDeliveries), 'Delivery API must exclude payload, target, signature, Secret, and raw body fields').toBeUndefined();
  for (const marker of markers) expect(deliveryText).not.toContain(marker);
  const audit = await requestJSON(page, 'GET', '/admin/api/v1/audit?limit=100');
  expect(audit.status).toBe(200);
  const auditText = JSON.stringify(audit.body);
  expect(findSensitiveField(audit.body), 'Audit API must exclude payload, target, signature, Secret, and raw body fields').toBeUndefined();
  for (const marker of markers) expect(auditText).not.toContain(marker);
  for (const id of [...observedAdminRequestIds]) {
    const request = await requestJSON(page, 'GET', `/admin/api/v1/requests/${encodeURIComponent(id)}`);
    if (request.status !== 200) continue;
    const requestText = JSON.stringify(request.body);
    expect(findSensitiveField(request.body), 'Request detail API must exclude payload, target, signature, Secret, and raw body fields').toBeUndefined();
    for (const marker of markers) expect(requestText).not.toContain(marker);
  }
  for (const marker of markers) await expect(page.locator('body')).not.toContainText(marker);
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-wp24-webhooks-'));
  projectRoot = path.join(runtimeDirectory, 'project');
  await mkdir(projectRoot);
  buildAdmin();
  const certDirectory = path.join(runtimeDirectory, 'certificates');
  runChecked(goCommand, ['run', './admin/e2e/webhook-cert', certDirectory], repositoryRoot);
  fixtureCA = path.join(certDirectory, 'ca.pem');
  fixture = new LocalWebhookFixture();
  fixtureAddress = await fixture.start(path.join(certDirectory, 'server-cert.pem'), path.join(certDirectory, 'server-key.pem'));
  runtimeBinary = path.join(runtimeDirectory, process.platform === 'win32' ? 'modelry.exe' : 'modelry');
  runChecked(goCommand, ['build', '-tags', 'modelry_e2e', '-o', runtimeBinary, './cmd/modelry'], repositoryRoot);
  if (process.platform === 'win32') {
    runtimeLauncher = path.join(runtimeDirectory, 'modelry-e2e-launcher.exe');
    runChecked(goCommand, ['build', '-o', runtimeLauncher, './admin/e2e/windows-runtime-launcher'], repositoryRoot);
  }
});

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
  await fixture?.close();
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
});

test('WP24 Webhooks and Jobs use real Chromium, pinned HTTPS fixture, durable SQLite and same-root recovery', async ({ page }) => {
  test.setTimeout(300_000);
  const firstRootEntries = await readdir(projectRoot);
  expect(firstRootEntries).toEqual([]);
  const firstRuntime = await startRuntime(projectRoot);

  const bootstrap = await page.goto(runtimeURL);
  expect(bootstrap?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);
  await page.getByLabel('Collection name').fill('webhook-events');
  await page.getByLabel('Field name 1').fill('title');
  await page.getByLabel('Required', { exact: true }).check();
  await page.getByRole('button', { name: 'Create Collection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'webhook-events' })).toBeVisible();
  const collectionId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  expect(collectionId).toMatch(/^col_/);
  const collectionResult = await requestJSON(page, 'GET', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}`);
  expect(collectionResult.status).toBe(200);
  const collection = data<{ schemaVersion: number }>(collectionResult.body);
  expect(collection.schemaVersion).toBeGreaterThan(0);

  page.on('response', (response) => {
    const requestId = response.headers()['x-request-id'];
    if (requestId && new URL(response.url()).pathname.startsWith('/admin/api/v1/')) observedAdminRequestIds.add(requestId);
  });

  const primarySecret = 'WP24_WEBHOOK_SIGNING_SECRET_ALPHA_ONLY_IN_TEST';
  const revokeSecret = 'WP24_WEBHOOK_SIGNING_SECRET_REVOKE_ONLY_IN_TEST';
  const primarySecretId = await createSecret(page, 'Primary webhook signing key', primarySecret);
  const primaryWebhook = await createWebhook(page, 'Primary receiver', '/record-hook', primarySecretId);
  const primaryHook = await createEventHook(page, 'Record event receiver', collectionId, primaryWebhook.id);

  await page.goto(`${runtimeURL}/automations?tab=jobs`);
  await page.getByRole('button', { name: 'Create Job' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('UTC maturity check');
  await page.getByLabel('Webhook').selectOption(primaryWebhook.id);
  const cronInput = page.getByRole('textbox', { name: /Cron schedule/ });
  await cronInput.fill('0 9 * * *');
  const preview = page.getByText(/Next run preview \(UTC\)/);
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('UTC');
  await page.getByRole('button', { name: 'Save Job' }).click();
  const createdJobCard = page.locator('.automation-card').filter({ hasText: 'UTC maturity check' });
  await expect(createdJobCard).toBeVisible();
  await expect(createdJobCard).toContainText('UTC');
  await expect(createdJobCard).toContainText('Next run');
  const jobList = await requestJSON(page, 'GET', '/admin/api/v1/jobs');
  expect(jobList.status).toBe(200);
  const job = data<Array<{ id: string; name: string; enabled: boolean; nextRunAt: string }>>(jobList.body).find((item) => item.name === 'UTC maturity check');
  expect(job).toBeTruthy();
  expect(job?.enabled).toBe(false);
  expect(Date.parse(job!.nextRunAt)).not.toBeNaN();

  fixture!.respond('/record-hook', 503, 204);
  const createdRecordId = await createRecord(page, collectionId, privateRecordMarker);
  expect(createdRecordId).toMatch(/^rec_/);
  await expect.poll(() => fixture!.count('/record-hook'), { timeout: 15_000, intervals: [50, 100, 200] }).toBe(2);
  const receivedFirst = fixture!.requests.filter((request) => request.path === '/record-hook');
  expect(receivedFirst).toHaveLength(2);
  expect(receivedFirst[0]!.idempotencyKey).toMatch(/^dlv_[a-f0-9]{36}$/);
  expect(receivedFirst[0]!.deliveryId).toBe(receivedFirst[0]!.idempotencyKey);
  expect(receivedFirst[1]!.deliveryId).toBe(receivedFirst[0]!.deliveryId);
  expect(receivedFirst[1]!.idempotencyKey).toBe(receivedFirst[0]!.idempotencyKey);
  expect(receivedFirst[1]!.body).toBe(receivedFirst[0]!.body);
  const firstTimestamp = assertWebhookSignature(receivedFirst[0]!, primarySecret);
  const retryTimestamp = assertWebhookSignature(receivedFirst[1]!, primarySecret);
  expect(retryTimestamp).not.toBe(firstTimestamp);
  expect(receivedFirst[1]!.signature).not.toBe(receivedFirst[0]!.signature);
  const envelope = JSON.parse(receivedFirst[0]!.body) as {
    event?: {
      id?: string;
      type?: string;
      collectionId?: string;
      recordId?: string;
      schemaVersion?: number;
      after?: { title?: string };
    };
  };
  const eventId = envelope.event?.id;
  expect(eventId).toMatch(/^evt_/);
  expect(envelope.event?.type).toBe('record.created');
  expect(envelope.event?.collectionId).toBe(collectionId);
  expect(envelope.event?.recordId).toBe(createdRecordId);
  expect(envelope.event?.schemaVersion).toBe(collection.schemaVersion);
  expect(envelope.event?.after?.title).toBe(privateRecordMarker);
  expect(receivedFirst[0]!.eventId).toBe(eventId);
  expect(receivedFirst[1]!.eventId).toBe(eventId);
  const successDelivery = await deliveryForEvent(page, primaryHook.id, eventId!, 'succeeded');
  expect(successDelivery.id).toBe(receivedFirst[0]!.deliveryId);
  expect(successDelivery.attemptCount).toBe(2);
  expect(successDelivery.attempts.map((attempt) => attempt.httpStatus)).toEqual([503, 204]);
  expect(successDelivery.attempts.map((attempt) => attempt.status)).toEqual(['retryScheduled', 'succeeded']);
  const deliveryRaw = await requestJSON(page, 'GET', `/admin/api/v1/deliveries/${successDelivery.id}`);
  expect(JSON.stringify(deliveryRaw.body)).not.toContain(primarySecret);
  expect(JSON.stringify(deliveryRaw.body)).not.toContain(privateRecordMarker);
  expect(JSON.stringify(deliveryRaw.body)).not.toContain('https://hooks.modelry.test/record-hook');
  expect(JSON.stringify(deliveryRaw.body)).not.toContain(receivedFirst[0]!.signature);
  await deliveryPage(page, successDelivery.id);
  await expectNoSensitiveDiagnostics(page, [primarySecret, privateRecordMarker, responseBodyMarker, 'https://hooks.modelry.test/record-hook', receivedFirst[0]!.signature]);

  const revokeSecretId = await createSecret(page, 'Revocation test key', revokeSecret);
  const cancelWebhook = await createWebhook(page, 'Cancellable receiver', '/cancel-hook', revokeSecretId);
  const cancelHook = await createEventHook(page, 'Cancellation record event', collectionId, cancelWebhook.id);

  const disableGate = fixture!.blockNext('/cancel-hook');
  const disableRecord = await createRecord(page, collectionId, 'disable while receiving');
  const disableRequest = await disableGate.received;
  const disableEventId = (JSON.parse(disableRequest.body) as { event?: { id?: string } }).event?.id;
  expect(disableEventId).toMatch(/^evt_/);
  const disableDelivery = await deliveryForEvent(page, cancelHook.id, disableEventId!, 'running');
  await page.goto(`${runtimeURL}/automations?tab=webhooks`);
  const cancelCard = page.locator('.automation-card').filter({ hasText: 'Cancellable receiver' });
  await cancelCard.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Disable Webhook?' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Disable Webhook?' }).getByRole('button', { name: 'Disable Webhook' }).click();
  const disabledDelivery = await waitForDeliveryStatus(page, disableDelivery.id, 'cancelled');
  expect(disabledDelivery.errorCode).toBe('webhookDisabled');
  expect(disabledDelivery.attempts.at(-1)?.status).toBe('cancelled');
  disableGate.release();
  await expect.poll(() => fixture!.count('/cancel-hook')).toBe(1);
  expect(disableRecord).toMatch(/^rec_/);

  await page.goto(`${runtimeURL}/automations?tab=webhooks`);
  await page.locator('.automation-card').filter({ hasText: 'Cancellable receiver' }).getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.locator('.automation-card').filter({ hasText: 'Cancellable receiver' }).getByText('Enabled', { exact: true })).toBeVisible();
  const revokeGate = fixture!.blockNext('/cancel-hook');
  await createRecord(page, collectionId, 'revoke while receiving');
  const revokeRequest = await revokeGate.received;
  const revokeEventId = (JSON.parse(revokeRequest.body) as { event?: { id?: string } }).event?.id;
  expect(revokeEventId).toMatch(/^evt_/);
  const revokeDelivery = await deliveryForEvent(page, cancelHook.id, revokeEventId!, 'running');
  await page.goto(`${runtimeURL}/secrets`);
  const secretRow = page.getByRole('listitem').filter({ hasText: 'Revocation test key' });
  await secretRow.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('dialog', { name: 'Revoke “Revocation test key”?' }).getByRole('button', { name: 'Revoke Secret' }).click();
  const revokedDelivery = await waitForDeliveryStatus(page, revokeDelivery.id, 'cancelled');
  expect(revokedDelivery.errorCode).toBe('secretRevoked');
  expect(revokedDelivery.attempts.at(-1)?.status).toBe('cancelled');
  revokeGate.release();
  const disabledSecretWebhook = await requestJSON(page, 'GET', `/admin/api/v1/webhooks/${encodeURIComponent(cancelWebhook.id)}`);
  expect(disabledSecretWebhook.status).toBe(200);
  expect(JSON.stringify(disabledSecretWebhook.body)).toContain('"enabled":false');
  expect(JSON.stringify(disabledSecretWebhook.body)).toContain('"signingConfigured":false');

  const manualRetryMarker = 'WP24_MANUAL_REDRIVE_CONTENT_MUST_STAY_PRIVATE';
  const beforeManualRetry = fixture!.count('/record-hook');
  fixture!.respond('/record-hook', ...Array.from({ length: 8 }, () => 503));
  await createRecord(page, collectionId, manualRetryMarker);
  await expect.poll(() => fixture!.count('/record-hook'), { timeout: 15_000, intervals: [50, 100, 200] }).toBe(beforeManualRetry + 8);
  const failedRoundRequests = fixture!.requests.filter((request) => request.path === '/record-hook').slice(beforeManualRetry);
  expect(failedRoundRequests).toHaveLength(8);
  const failedEventId = (JSON.parse(failedRoundRequests[0]!.body) as { event?: { id?: string } }).event?.id;
  expect(failedEventId).toMatch(/^evt_/);
  const failedDelivery = await deliveryForEvent(page, primaryHook.id, failedEventId!, 'failed');
  expect(failedDelivery.attemptCount).toBe(8);
  expect(failedDelivery.attempts.map((attempt) => attempt.httpStatus)).toEqual(Array.from({ length: 8 }, () => 503));
  expect(failedRoundRequests.every((request) => request.deliveryId === failedDelivery.id && request.idempotencyKey === failedDelivery.id && request.body === failedRoundRequests[0]!.body)).toBe(true);
  await deliveryPage(page, failedDelivery.id);
  await expect(page.getByRole('button', { name: 'Retry Delivery', exact: true })).toBeVisible();
  fixture!.respond('/record-hook', 204);
  await page.getByRole('button', { name: 'Retry Delivery', exact: true }).click();
  const redrivenDelivery = await waitForDeliveryStatus(page, failedDelivery.id, 'succeeded');
  expect(redrivenDelivery.manualRedriveCount).toBe(1);
  expect(redrivenDelivery.attemptCount).toBe(9);
  expect(redrivenDelivery.attempts.at(-1)?.status).toBe('succeeded');
  const redriveRequests = fixture!.requests.filter((request) => request.deliveryId === failedDelivery.id);
  expect(redriveRequests).toHaveLength(9);
  expect(redriveRequests.every((request) => request.idempotencyKey === failedDelivery.id && request.body === failedRoundRequests[0]!.body)).toBe(true);

  const restartGate = fixture!.blockNext('/record-hook');
  await createRecord(page, collectionId, 'same-root restart recovery');
  const interruptedRequest = await restartGate.received;
  const interruptedEventId = (JSON.parse(interruptedRequest.body) as { event?: { id?: string } }).event?.id;
  expect(interruptedEventId).toMatch(/^evt_/);
  const interruptedDelivery = await deliveryForEvent(page, primaryHook.id, interruptedEventId!, 'running');
  expect(interruptedDelivery.attemptCount).toBe(1);
  await stopRuntime();
  restartGate.release();
  fixture!.respond('/record-hook', 204);
  const restarted = await startRuntime(projectRoot);
  expect(restarted.projectId).toBe(firstRuntime.projectId);
  const recovered = await waitForDeliveryStatus(page, interruptedDelivery.id, 'succeeded');
  expect(recovered.attemptCount).toBe(2);
  expect(recovered.attempts.map((attempt) => attempt.status)).toEqual(['interrupted', 'succeeded']);
  const replay = fixture!.requests.filter((request) => request.deliveryId === interruptedDelivery.id);
  expect(replay).toHaveLength(2);
  expect(replay[0]!.body).toBe(replay[1]!.body);
  expect(replay[0]!.idempotencyKey).toBe(interruptedDelivery.id);
  expect(replay[1]!.idempotencyKey).toBe(interruptedDelivery.id);

  await page.goto(`${runtimeURL}/automations?tab=deliveries&deliveryId=${encodeURIComponent(interruptedDelivery.id)}`);
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByText(interruptedDelivery.id, { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(privateRecordMarker);
  await page.locator('.locale-switcher select').selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '自动化', exact: true })).toBeVisible();
  const themeBefore = await page.locator('html').getAttribute('data-theme');
  await page.locator('.theme-button').click();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).not.toBe(themeBefore);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoSensitiveDiagnostics(page, [primarySecret, revokeSecret, privateRecordMarker, manualRetryMarker, responseBodyMarker, 'https://hooks.modelry.test/record-hook', 'https://hooks.modelry.test/cancel-hook', ...fixture!.requests.map((request) => request.signature)]);
  const durableJob = await requestJSON(page, 'GET', `/admin/api/v1/jobs/${encodeURIComponent(job!.id)}`);
  expect(durableJob.status).toBe(200);
  expect(JSON.stringify(durableJob.body)).toContain(job!.nextRunAt);
  expect(readyRecord?.projectId).toBe(firstRuntime.projectId);
});
