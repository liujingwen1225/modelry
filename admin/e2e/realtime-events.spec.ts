import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

type ReadyRecord = { state: string; url: string; projectId: string };
type RuntimeProcess = ChildProcessWithoutNullStreams;
type BrowserFrame = { id: string; event: string; data: Record<string, unknown>; raw: string };
type BrowserStreamState = {
  controller: AbortController;
  frames: BrowserFrame[];
  rawFrames: string[];
  status?: number;
  requestId?: string;
  persisted?: string;
  error?: unknown;
  done: boolean;
};
type BrowserUnreadStreamState = {
  controller: AbortController;
  status?: number;
  requestId?: string;
  persisted?: string;
  error?: string;
  response?: Response;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  ended?: boolean;
};
type RealtimeWindow = Window & { __modelryRealtimeStream?: BrowserStreamState; __modelryUnreadStream?: BrowserUnreadStreamState };

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminDirectory = path.join(repositoryRoot, 'admin');
const goCommand = process.env.MODELRY_GO ?? 'go';
const ownerEmail = 'owner@example.test';
const ownerPassword = 'Very-Strong-Owner-Password-42!';

let runtimeDirectory = '';
let projectRoot = '';
let runtimeBinary = '';
let runtimeLauncher = '';
let retentionFixture = '';
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
  readyRecord = record;
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
  const result = await exited;
  expect(result).toEqual({ code: 0, signal: null });
  runtimeProcess = undefined;
}

async function requestJSON(page: Page, method: string, requestPath: string, body?: unknown, expectedStatuses: number[] = []) {
  const responseURL = new URL(requestPath, runtimeURL).toString();
  const expected = ((page as Page & { expectedHTTPFailures?: Set<string> }).expectedHTTPFailures);
  for (const status of expectedStatuses) expected?.add(`${status} ${responseURL}`);
  const result = await page.evaluate(async (input) => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: input.path.startsWith('/admin/') ? 'include' : 'omit',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { status: response.status, requestId: response.headers.get('X-Request-Id'), body: await response.json() };
  }, { method, path: requestPath, body });
  if (expected) {
    for (const status of expectedStatuses) {
      if (status !== result.status) expected.delete(`${status} ${responseURL}`);
    }
  }
  return result;
}

async function createRecord(page: Page, collectionId: string, title: string, visibility: string) {
  const response = await requestJSON(page, 'POST', `/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, {
    values: { title, visibility },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const body = response.body as { data: { id: string } };
  expect(body.data.id).toMatch(/^rec_/);
  return body.data.id;
}

async function createRecordOutsideBrowser(page: Page, collectionId: string, title: string, visibility: string) {
  const response = await page.context().request.post(new URL(`/admin/api/v1/collections/${encodeURIComponent(collectionId)}/records`, runtimeURL).toString(), {
    data: { values: { title, visibility } },
    headers: { Origin: runtimeURL },
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as { data: { id: string } };
  expect(body.data.id).toMatch(/^rec_/);
  return body.data.id;
}

async function startStream(page: Page, cursor?: string) {
  await page.evaluate((lastEventId) => {
    const state: BrowserStreamState = { controller: new AbortController(), frames: [], rawFrames: [], done: false };
    (window as RealtimeWindow).__modelryRealtimeStream = state;
    void (async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        const response = await fetch('/api/v1/posts/events', { headers, credentials: 'omit', cache: 'no-store', signal: state.controller.signal });
        state.status = response.status;
        state.requestId = response.headers.get('X-Request-Id') ?? undefined;
        state.persisted = response.headers.get('X-Request-Record-Persisted') ?? undefined;
        if (!response.ok || !response.body) {
          state.error = await response.json().catch(() => undefined);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!state.controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary = -1;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let id = '';
            let event = 'message';
            const data: string[] = [];
            for (const line of raw.split('\n')) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('id:')) id = line.slice(3).trimStart();
              else if (line.startsWith('event:')) event = line.slice(6).trimStart();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (!data.length && !id) continue;
            state.rawFrames.push(raw);
            state.frames.push({ id, event, data: JSON.parse(data.join('\n')) as Record<string, unknown>, raw });
          }
        }
      } catch (error) {
        if (!state.controller.signal.aborted) state.error = String(error);
      } finally {
        state.done = true;
      }
    })();
  }, cursor ?? null);
}

async function startUnreadStream(page: Page, cursor: string) {
  const state = await page.evaluate(async (lastEventId) => {
    const unread: BrowserUnreadStreamState = { controller: new AbortController() };
    (window as RealtimeWindow).__modelryUnreadStream = unread;
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    try {
      const response = await fetch('/api/v1/posts/events', { headers, credentials: 'omit', cache: 'no-store', signal: unread.controller.signal });
      unread.status = response.status;
      unread.requestId = response.headers.get('X-Request-Id') ?? undefined;
      unread.persisted = response.headers.get('X-Request-Record-Persisted') ?? undefined;
      unread.response = response;
      if (!response.body) throw new Error('The unread SSE stream has no response body.');
      unread.reader = response.body.getReader();
      void unread.reader.closed.then(() => { unread.ended = true; }, () => { unread.ended = true; });
    } catch (error) {
      unread.error = String(error);
    }
    return { status: unread.status, requestId: unread.requestId, persisted: unread.persisted, error: unread.error };
  }, cursor);
  expect(state.status, state.error).toBe(200);
  expect(state.persisted).toBe('true');
  expect(state.requestId).toMatch(/^req_/);
  return state.requestId as string;
}

async function abortUnreadStream(page: Page) {
  await page.evaluate(() => (window as RealtimeWindow).__modelryUnreadStream?.controller.abort());
}

async function waitForFrame(page: Page, eventName: string, timeout = 10_000) {
  try {
    await page.waitForFunction((name) => (window as RealtimeWindow).__modelryRealtimeStream?.frames.some((frame) => frame.event === name), eventName, { timeout });
  } catch (error) {
    throw new Error(`${String(error)}; stream state: ${JSON.stringify(await streamState(page))}`);
  }
  return page.evaluate((name) => (window as RealtimeWindow).__modelryRealtimeStream?.frames.find((frame) => frame.event === name), eventName);
}

async function stopStream(page: Page) {
  await page.evaluate(() => (window as RealtimeWindow).__modelryRealtimeStream?.controller.abort());
  await page.waitForFunction(() => (window as RealtimeWindow).__modelryRealtimeStream?.done === true);
}

async function streamState(page: Page) {
  return page.evaluate(() => {
    const state = (window as RealtimeWindow).__modelryRealtimeStream;
    return state ? {
      status: state.status,
      requestId: state.requestId,
      persisted: state.persisted,
      error: state.error,
      frames: state.frames,
      rawFrames: state.rawFrames,
    } : undefined;
  });
}

async function expectOwnerSessionAfterRestart(page: Page) {
  const restoredSession = page.waitForResponse((response) => new URL(response.url()).pathname === '/admin/api/v1/auth/session');
  await page.goto(runtimeURL);
  expect((await restoredSession).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.locator('.topbar')).toContainText(ownerEmail);
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-realtime-'));
  projectRoot = path.join(runtimeDirectory, 'project');
  await mkdir(projectRoot);
  buildAdmin();
  runtimeBinary = path.join(runtimeDirectory, process.platform === 'win32' ? 'modelry.exe' : 'modelry');
  retentionFixture = path.join(runtimeDirectory, process.platform === 'win32' ? 'retention-fixture.exe' : 'retention-fixture');
  runChecked(goCommand, ['build', '-o', runtimeBinary, './cmd/modelry'], repositoryRoot);
  runChecked(goCommand, ['build', '-o', retentionFixture, './admin/e2e/retention-fixture'], repositoryRoot);
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

test('WP21 Realtime uses current authorization and recovers across reconnect, restart, and retention expiry', async ({ page }) => {
  test.setTimeout(300_000);
  const issues: string[] = [];
  const expectedHTTPFailures = new Set<string>();
  const expectedRequestFailures = new Set<string>();
  (page as Page & { expectedHTTPFailures?: Set<string> }).expectedHTTPFailures = expectedHTTPFailures;
  (page as Page & { expectedRequestFailures?: Set<string> }).expectedRequestFailures = expectedRequestFailures;
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: the server responded with a status of ')) issues.push(`Console: ${message.text()}`);
  });
  page.on('pageerror', (error) => issues.push(`Page: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !(response.status() < 500 && expectedHTTPFailures.delete(`${response.status()} ${response.url()}`))) {
      issues.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    const expected = (page as Page & { expectedRequestFailures?: Set<string> }).expectedRequestFailures;
    if (!failure.includes('ERR_ABORTED') && !expected?.delete(request.url())) issues.push(`Network: ${request.url()} (${failure})`);
  });

  expect(await readdir(projectRoot)).toEqual([]);
  const firstRuntime = await startRuntime(projectRoot);
  expect(firstRuntime.state).toBe('ready');
  expectedHTTPFailures.add(`401 ${new URL('/admin/api/v1/auth/session', runtimeURL).toString()}`);
  const setup = await page.goto(runtimeURL);
  expect(setup?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);
  await page.getByLabel('Collection name').fill('posts');
  await page.getByLabel('Field name 1').fill('title');
  await page.getByLabel('Required', { exact: true }).check();
  await page.getByRole('button', { name: 'Add initial field' }).click();
  await page.getByLabel('Field name 2').fill('visibility');
  await page.getByRole('button', { name: 'Create Collection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'posts' })).toBeVisible();
  const collectionId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  expect(collectionId).toMatch(/^col_/);

  await page.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}/security`);
  await page.getByRole('button', { name: 'Edit List access' }).click();
  await page.getByLabel('Custom rule').check();
  await page.getByRole('button', { name: 'Add condition', exact: true }).click();
  await page.getByLabel('Condition 1 field').selectOption({ label: 'visibility' });
  await page.getByLabel('Condition value', { exact: true }).fill('public');
  await page.getByRole('button', { name: 'Save pending rule' }).click();
  await page.getByRole('button', { name: /Apply 1 change/ }).click();
  await page.getByRole('button', { name: 'Confirm & apply' }).click();
  await expect(page.getByText('All access rule changes are applied.')).toBeVisible();

  await page.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}/api?tab=realtime`);
  await expect(page.getByRole('heading', { name: 'Committed Record Events' })).toBeVisible();
  await expect(page.locator('.api-realtime__metadata')).toContainText('Custom rule');
  await expect(page.locator('.api-realtime__metadata')).toContainText(`/api/v1/posts/events`);
  await expect(page.locator('.api-realtime__example code')).toContainText("headers['Last-Event-ID']");

  await page.locator('.topbar').getByRole('button', { name: 'Search commands' }).click();
  let palette = page.getByRole('dialog', { name: 'Command palette' });
  let paletteInput = palette.getByRole('combobox', { name: 'Search commands' });
  await paletteInput.fill('Open current Collection Realtime events');
  await expect(palette.getByRole('option', { name: 'Open current Collection Realtime events' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '已提交的记录事件' })).toBeVisible();
  await expect(page.locator('.api-realtime__example code')).toContainText('设置应用会话 token');
  await page.getByRole('button', { name: '搜索命令' }).click();
  palette = page.getByRole('dialog', { name: '命令面板' });
  paletteInput = palette.getByRole('combobox', { name: '搜索命令' });
  await paletteInput.fill('打开当前集合实时事件');
  await expect(palette.getByRole('option', { name: '打开当前集合实时事件' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}/api?tab=realtime`);
  await expect(page.getByRole('heading', { name: '已提交的记录事件' })).toBeVisible();
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Committed Record Events' })).toBeVisible();
  await page.locator('.topbar').getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await startStream(page);
  const baseline = await waitForFrame(page, 'stream.ready');
  expect(baseline?.id).toMatch(/^cur_/);
  const firstStream = await streamState(page);
  expect(firstStream?.status).toBe(200);
  expect(firstStream?.persisted).toBe('true');

  const privateId = await createRecord(page, collectionId, 'PRIVATE_MARKER', 'private');
  const publicId = await createRecord(page, collectionId, 'PUBLIC_MARKER', 'public');
  const createdFrame = await waitForFrame(page, 'record.created');
  expect(createdFrame?.data.recordId).toBe(publicId);
  expect(JSON.stringify(createdFrame?.data)).toContain('PUBLIC_MARKER');
  const firstFrames = await streamState(page);
  const firstRaw = firstFrames?.rawFrames.join('\n') ?? '';
  expect(firstRaw).not.toContain(privateId);
  expect(firstRaw).not.toContain('PRIVATE_MARKER');
  const lastAppliedId = createdFrame?.id;
  expect(lastAppliedId).toMatch(/^evt_/);

  await stopStream(page);
  const firstRequestId = firstStream?.requestId;
  expect(firstRequestId).toMatch(/^req_/);
  const firstRequestRecord = await requestJSON(page, 'GET', `/admin/api/v1/requests/${encodeURIComponent(firstRequestId ?? '')}`);
  expect(firstRequestRecord.status).toBe(200);
  expect(JSON.stringify(firstRequestRecord.body)).not.toContain('PRIVATE_MARKER');
  expect(JSON.stringify(firstRequestRecord.body)).not.toContain('PUBLIC_MARKER');
  expect(JSON.stringify(firstRequestRecord.body)).not.toContain('Last-Event-ID');

  const replayedTitle = 'RECONNECT_REPLAY_MARKER';
  const replayedId = await createRecord(page, collectionId, replayedTitle, 'public');
  await startStream(page, lastAppliedId);
  const replayFrame = await waitForFrame(page, 'record.created');
  expect(replayFrame?.data.recordId).toBe(replayedId);
  expect(JSON.stringify(replayFrame?.data)).toContain(replayedTitle);
  const reconnectId = replayFrame?.id;
  expect(reconnectId).toMatch(/^evt_/);
  await stopStream(page);

  const beforeRestart = readyRecord;
  expect(beforeRestart?.projectId).toBe(firstRuntime.projectId);
  const restartReplayTitle = 'RESTART_REPLAY_MARKER';
  const restartReplayId = await createRecord(page, collectionId, restartReplayTitle, 'public');
  await stopRuntime();
  const restartedRuntime = await startRuntime(projectRoot);
  expect(restartedRuntime.projectId).toBe(firstRuntime.projectId);
  await expectOwnerSessionAfterRestart(page);

  await page.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}/api?tab=realtime`);
  await expect(page.getByRole('heading', { name: 'Committed Record Events' })).toBeVisible();
  await startStream(page, reconnectId);
  const restartFrame = await waitForFrame(page, 'record.created');
  expect(restartFrame?.data.recordId).toBe(restartReplayId);
  expect(JSON.stringify(restartFrame?.data)).toContain(restartReplayTitle);
  const restartStream = await streamState(page);
  expect(restartStream?.persisted).toBe('true');
  const expiredCursor = reconnectId ?? '';
  expect(expiredCursor).toMatch(/^evt_/);
  const expiredSequence = Number(expiredCursor.slice(-20));
  await stopStream(page);

  const unreadStreamURL = new URL('/api/v1/posts/events', runtimeURL).toString();
  expectedRequestFailures.add(unreadStreamURL);
  let unreadRequestId = '';
  try {
    unreadRequestId = await startUnreadStream(page, restartFrame?.id ?? '');
    const slowClientTitle = `SLOW_CLIENT_${'x'.repeat(600 * 1024)}`;
    await createRecordOutsideBrowser(page, collectionId, slowClientTitle, 'public');
    const independentWriteStarted = Date.now();
    await createRecordOutsideBrowser(page, collectionId, 'INDEPENDENT_WRITE_MARKER', 'public');
    expect(Date.now() - independentWriteStarted).toBeLessThan(5000);
  } finally {
    await abortUnreadStream(page);
  }
  await expect.poll(async () => {
    const unreadRequest = await requestJSON(page, 'GET', `/admin/api/v1/requests/${encodeURIComponent(unreadRequestId)}`);
    const data = (unreadRequest.body as { data?: { durationMs?: number; responseSizeBytes?: number } }).data;
    return unreadRequest.status === 200 && (data?.durationMs ?? 0) > 0 && (data?.responseSizeBytes ?? 0) > 64 * 1024;
  }, { timeout: 10_000 }).toBe(true);

  await stopRuntime();

  const databasePath = path.join(projectRoot, '.modelry', 'project.sqlite');
  execFileSync(retentionFixture, [databasePath, collectionId, String(expiredSequence + 1)], { cwd: repositoryRoot, stdio: 'inherit' });
  const recoveredRuntime = await startRuntime(projectRoot);
  expect(recoveredRuntime.projectId).toBe(firstRuntime.projectId);
  await expectOwnerSessionAfterRestart(page);

  await page.goto(`${runtimeURL}/collections/${encodeURIComponent(collectionId)}/api?tab=realtime`);
  await expect(page.getByRole('heading', { name: 'Committed Record Events' })).toBeVisible();
  const streamURL = new URL('/api/v1/posts/events', runtimeURL).toString();
  expectedHTTPFailures.add(`410 ${streamURL}`);
  await startStream(page, expiredCursor);
  await page.waitForFunction(() => (window as RealtimeWindow).__modelryRealtimeStream?.done === true);
  const expiredState = await streamState(page);
  expect(expiredState?.status).toBe(410);
  expect(JSON.stringify(expiredState?.error)).toContain('EVENT_CURSOR_EXPIRED');

  await startStream(page);
  const recoveryBaseline = await waitForFrame(page, 'stream.ready');
  expect(recoveryBaseline?.id).toMatch(/^cur_/);
  const currentRecords = await requestJSON(page, 'GET', '/api/v1/posts');
  expect(currentRecords.status).toBe(200);
  expect(JSON.stringify(currentRecords.body)).not.toContain('PRIVATE_MARKER');
  expect(JSON.stringify(currentRecords.body)).toContain('PUBLIC_MARKER');
  expect(JSON.stringify(currentRecords.body)).toContain(replayedTitle);
  expect(JSON.stringify(currentRecords.body)).toContain(restartReplayTitle);
  await stopStream(page);
  expect(issues).toEqual([]);
});
