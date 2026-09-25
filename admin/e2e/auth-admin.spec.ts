import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createTCPServer } from 'node:net';
import type { Server as TCPServer, Socket } from 'node:net';
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
const administratorEmail = 'colleague@example.test';
const administratorPassword = 'Administrator-Password-42!';
const replacementAdministratorPassword = 'Administrator-Password-43!';
const appUserEmail = 'member@example.test';
const appUserPassword = 'Member-Password-42!';
const rotatedAppUserPassword = 'Member-Password-43!';
const smtpUsernameMarker = 'MODELRY_E2E_SMTP_USER';
const smtpPasswordMarker = 'MODELRY_E2E_SMTP_PASSWORD_MARKER';

let runtimeDirectory = '';
let projectRoot = '';
let runtimeBinary = '';
let runtimeLauncher = '';
let runtimeProcess: RuntimeProcess | undefined;
let runtimeProcessId: number | undefined;
let runtimeURL = '';
let fakeSMTP: { port: number; server: TCPServer; messages: string[]; close: () => Promise<void> } | undefined;

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

// startFakeSMTP 启动一个只讲明文 SMTP 的本机投递端点；Runtime 只在 loopback 上接受这种传输方式。
async function startFakeSMTP(): Promise<{ port: number; server: TCPServer; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = createTCPServer((socket: Socket) => {
    let buffer = '';
    let collecting = false;
    let payload = '';
    socket.setEncoding('utf8');
    socket.write('220 modelry-e2e ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (collecting) {
          if (line === '.') {
            collecting = false;
            messages.push(payload);
            payload = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            payload += line + '\r\n';
          }
        } else {
          const verb = (line.split(' ')[0] ?? '').toUpperCase();
          if (verb === 'EHLO') socket.write('250-modelry-e2e\r\n250 SIZE 10485760\r\n');
          else if (verb === 'HELO') socket.write('250 modelry-e2e\r\n');
          else if (verb === 'DATA') { collecting = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
          else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
          else if (verb === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
          else socket.write('250 2.0.0 Ok\r\n');
        }
        index = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake SMTP did not bind a TCP port');
  return {
    port: address.port,
    server,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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

const consumedMessages = new Set<number>();

// waitForDeliveryMessage 按主题与收件人取回一封尚未消费的投递消息。
async function waitForDeliveryMessage(subject: string, recipient: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const messages = fakeSMTP?.messages ?? [];
    for (let index = 0; index < messages.length; index += 1) {
      if (consumedMessages.has(index)) continue;
      const message = messages[index]!;
      if (!message.includes('Subject: ' + subject) || !message.includes('To: ' + recipient)) continue;
      consumedMessages.add(index);
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('fake SMTP did not receive the expected message: ' + subject);
}

function singleUseCode(message: string): string {
  const match = /code[^\r\n]*:\r?\n\r?\n([^\r\n]+)/i.exec(message);
  if (!match || !match[1]) throw new Error('the delivery message contained no single-use code: ' + message);
  return match[1].trim();
}

async function projectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? projectFiles(entryPath) : Promise.resolve([entryPath]);
  }));
  return nested.flat();
}

async function expectMarkerAbsentFromProject(marker: string) {
  for (const file of await projectFiles(projectRoot)) {
    let contents: Buffer;
    try {
      contents = await readFile(file);
    } catch (error) {
      throw new Error('could not read ' + file + ' for the marker scan: ' + String(error));
    }
    expect(contents.includes(Buffer.from(marker)), 'marker persisted in ' + file).toBe(false);
  }
}

test.beforeAll(async () => {
  runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'modelry-wp26-'));
  projectRoot = path.join(runtimeDirectory, 'project');
  await mkdir(projectRoot);
  buildAdmin();
  runtimeBinary = path.join(runtimeDirectory, process.platform === 'win32' ? 'modelry.exe' : 'modelry');
  runChecked(goCommand, ['build', '-o', runtimeBinary, './cmd/modelry'], repositoryRoot);
  if (process.platform === 'win32') {
    runtimeLauncher = path.join(runtimeDirectory, 'modelry-e2e-launcher.exe');
    runChecked(goCommand, ['build', '-o', runtimeLauncher, './admin/e2e/windows-runtime-launcher'], repositoryRoot);
  }
  fakeSMTP = await startFakeSMTP();
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
  if (fakeSMTP) await fakeSMTP.close();
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
});

async function signOut(page: Page) {
  await page.locator('.owner-menu summary').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.topbar')).toBeVisible();
}

test('WP26 Administrators, mail delivery, and account recovery stay product-complete', async ({ page }) => {
  test.setTimeout(600_000);
  const issues: string[] = [];
  const expectedHTTPFailures: ExpectedFailures = new Map();
  (page as Page & { expectedHTTPFailures?: ExpectedFailures }).expectedHTTPFailures = expectedHTTPFailures;
  const expectFailure = (status: number, requestPath: string, times = 1) => expectFailureCount(expectedHTTPFailures, status, requestPath, times);
  // 受限 Administrator 的 Shell 只能读取自身会话；Owner-only 的状态与列表路由按设计返回 403。
  const expectRestrictedAdministratorDenials = () => {
    expectFailure(403, '/admin/api/v1/runtime/status');
    expectFailure(403, '/admin/api/v1/storage/status');
    expectFailure(403, '/admin/api/v1/administrators');
  };
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

  expect(await readdir(projectRoot)).toEqual([]);
  await startRuntime(projectRoot);
  expectFailure(401, '/admin/api/v1/auth/session');
  await page.goto(runtimeURL);
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);

  // Mail stays fail closed while the Provider is unconfigured.
  await page.goto(runtimeURL + '/settings/mail');
  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();
  const unconfiguredTest = await requestJSON(page, 'POST', '/admin/api/v1/mail/test', { recipient: ownerEmail }, [409]);
  expect(unconfiguredTest.status).toBe(409);
  expect((unconfiguredTest.body as { error: { code: string } }).error.code).toBe('MAIL_NOT_CONFIGURED');

  const usernameSecret = await requestJSON(page, 'POST', '/admin/api/v1/secrets', { name: 'SMTP username', value: smtpUsernameMarker }, [201]);
  const passwordSecret = await requestJSON(page, 'POST', '/admin/api/v1/secrets', { name: 'SMTP password', value: smtpPasswordMarker }, [201]);
  expect(usernameSecret.status).toBe(201);
  expect(passwordSecret.status).toBe(201);
  const usernameSecretId = (usernameSecret.body as { data: { id: string } }).data.id;
  const passwordSecretId = (passwordSecret.body as { data: { id: string } }).data.id;

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mail', level: 1 })).toBeVisible();
  await page.getByLabel('Enabled').selectOption('enabled');
  await page.getByLabel('Host').fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(fakeSMTP!.port));
  await page.getByLabel('Transport security').selectOption('plaintext');
  await page.getByLabel('From address').fill('modelry@example.test');
  await page.getByLabel('From name').fill('Modelry');
  await page.getByLabel('Username Secret').selectOption(usernameSecretId);
  await page.getByLabel('Password Secret').selectOption(passwordSecretId);
  await page.getByRole('button', { name: 'Save Mail provider' }).click();
  await expect(page.getByText('Mail provider saved.')).toBeVisible();

  await page.getByLabel('Test recipient').fill(ownerEmail);
  await page.getByRole('button', { name: 'Send test message' }).click();
  await expect(page.getByText(/The provider accepted the test message/)).toBeVisible();
  await waitForDeliveryMessage('Modelry test message', ownerEmail);
  await expect(page.getByText('Delivered').first()).toBeVisible();

  // Plaintext SMTP is refused for any host that is not loopback.
  const remotePlaintext = await requestJSON(page, 'PUT', '/admin/api/v1/mail', {
    expectedRevision: 2, enabled: true, host: 'smtp.example.test', port: 587, security: 'plaintext',
    fromAddress: 'modelry@example.test', fromName: 'Modelry',
    usernameSecretId, passwordSecretId,
  }, [400]);
  expect(remotePlaintext.status).toBe(400);

  // Create an Administrator that only holds collections.read.
  await page.goto(runtimeURL + '/administrators');
  await expect(page.getByRole('heading', { name: 'Administrators', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Create Administrator' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Email').fill(administratorEmail);
  await createDialog.getByLabel('Initial password').fill(administratorPassword);
  await createDialog.getByLabel('Permission preset').selectOption('custom');
  await createDialog.getByLabel('collections.read').check();
  await createDialog.getByRole('button', { name: 'Create Administrator' }).click();
  await expect(page.getByRole('cell', { name: administratorEmail, exact: true })).toBeVisible();
  await expect(page.getByText('1 custom Permissions')).toBeVisible();

  // The Permission, not the navigation, decides what the Control Plane answers.
  await signOut(page);
  expectRestrictedAdministratorDenials();
  await signIn(page, administratorEmail, administratorPassword);
  await expect(page.locator('.owner-menu summary')).toHaveAttribute('aria-label', 'Owner menu for ' + administratorEmail);


  const navigation = page.getByRole('navigation', { name: 'Project navigation' });
  await expect(navigation.getByRole('link', { name: 'Collections' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Automations' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Extensions' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Secrets' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Administrators' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Mail' })).toHaveCount(0);

  const deniedAdministrators = await requestJSON(page, 'GET', '/admin/api/v1/administrators', undefined, [403]);
  expect(deniedAdministrators.status).toBe(403);
  expect((deniedAdministrators.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  const deniedMail = await requestJSON(page, 'GET', '/admin/api/v1/mail', undefined, [403]);
  expect(deniedMail.status).toBe(403);
  const allowedCollections = await requestJSON(page, 'GET', '/admin/api/v1/collections?limit=5');
  expect(allowedCollections.status).toBe(200);

  await signOut(page);
  await signIn(page, ownerEmail, ownerPassword);
  await page.goto(runtimeURL + '/administrators');
  await page.getByRole('button', { name: 'Disable ' + administratorEmail }).click();
  await expect(page.getByText('Administrator disabled and all sessions revoked.')).toBeVisible();
  const listed = await requestJSON(page, 'GET', '/admin/api/v1/administrators');
  const administratorId = (listed.body as { data: { id: string; email: string }[] }).data.find((item) => item.email === administratorEmail)!.id;
  const setPassword = await requestJSON(page, 'POST', '/admin/api/v1/administrators/' + administratorId + '/password', { password: replacementAdministratorPassword }, [204]);
  expect(setPassword.status).toBe(204);

  await signOut(page);
  const disabledLogin = await requestJSON(page, 'POST', '/admin/api/v1/auth/login', { email: administratorEmail, password: replacementAdministratorPassword }, [401]);
  expect(disabledLogin.status).toBe(401);

  // Same-root restart keeps the Administrator record and its Permission durable.
  await stopRuntime();
  await startRuntime(projectRoot);
  expectFailure(401, '/admin/api/v1/auth/session');
  await page.goto(runtimeURL);
  await signIn(page, ownerEmail, ownerPassword);
  const enable = await requestJSON(page, 'POST', '/admin/api/v1/administrators/' + administratorId + '/enable');
  expect(enable.status).toBe(200);

  await signOut(page);
  expectRestrictedAdministratorDenials();
  await signIn(page, administratorEmail, replacementAdministratorPassword);
  expect((await requestJSON(page, 'GET', '/admin/api/v1/collections?limit=5')).status).toBe(200);
  const stillDenied = await requestJSON(page, 'GET', '/admin/api/v1/administrators', undefined, [403]);
  expect(stillDenied.status).toBe(403);

  await signOut(page);
  await signIn(page, ownerEmail, ownerPassword);
  const collection = await requestJSON(page, 'POST', '/admin/api/v1/collections', {
    name: 'members', type: 'Auth',
    fields: [{ name: 'name', type: 'text' }],
    authentication: { emailPasswordEnabled: true, selfRegistration: true, sessionDurationDays: 7, emailVerification: 'required' },
  }, [201]);
  expect(collection.status).toBe(201);

  const register = await requestJSON(page, 'POST', '/api/v1/auth/members/register', {
    profile: { email: appUserEmail, name: 'Member' }, password: appUserPassword,
  }, [201]);
  expect(register.status).toBe(201);

  const blocked = await requestJSON(page, 'POST', '/api/v1/auth/members/login', { email: appUserEmail, password: appUserPassword }, [403]);
  expect(blocked.status).toBe(403);
  expect((blocked.body as { error: { code: string } }).error.code).toBe('EMAIL_NOT_VERIFIED');

  const verificationCode = singleUseCode(await waitForDeliveryMessage('Verify your Modelry email address', appUserEmail));
  const verificationConfirm = await requestJSON(page, 'POST', '/api/v1/auth/members/email-verification/confirm', { token: verificationCode }, [204]);
  expect(verificationConfirm.status).toBe(204);
  expect((await requestJSON(page, 'POST', '/api/v1/auth/members/login', { email: appUserEmail, password: appUserPassword })).status).toBe(200);

  const resetRequest = await requestJSON(page, 'POST', '/api/v1/auth/members/password-reset/request', { email: appUserEmail }, [202]);
  expect(resetRequest.status).toBe(202);
  const resetCode = singleUseCode(await waitForDeliveryMessage('Reset your Modelry password', appUserEmail));
  const resetConfirm = await requestJSON(page, 'POST', '/api/v1/auth/members/password-reset/confirm', { token: resetCode, password: rotatedAppUserPassword }, [204]);
  expect(resetConfirm.status).toBe(204);
  expect((await requestJSON(page, 'POST', '/api/v1/auth/members/login', { email: appUserEmail, password: rotatedAppUserPassword })).status).toBe(200);
  expect((await requestJSON(page, 'POST', '/api/v1/auth/members/login', { email: appUserEmail, password: appUserPassword }, [401])).status).toBe(401);

  const reuse = await requestJSON(page, 'POST', '/api/v1/auth/members/email-verification/confirm', { token: verificationCode }, [400]);
  expect(reuse.status).toBe(400);
  const enumeration = await requestJSON(page, 'POST', '/api/v1/auth/members/password-reset/request', { email: 'missing@example.test' }, [202]);
  expect(enumeration.status).toBe(202);

  // 停止 Runtime 后扫描项目目录：凭据、token 与单次使用代码都不得落盘。
  await stopRuntime();
  await expectMarkerAbsentFromProject(smtpPasswordMarker);
  await expectMarkerAbsentFromProject(smtpUsernameMarker);
  await expectMarkerAbsentFromProject(verificationCode);
  await expectMarkerAbsentFromProject(resetCode);
  await expectMarkerAbsentFromProject(appUserPassword);
  await expectMarkerAbsentFromProject(rotatedAppUserPassword);

  expect(issues).toEqual([]);
});