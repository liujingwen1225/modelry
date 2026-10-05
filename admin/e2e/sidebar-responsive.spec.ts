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

test('768px 导航抽屉与桌面收起导航保留资源上下文', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 768, height: 976 });
  await page.addInitScript(() => { if (!localStorage.getItem('modelry-admin-locale')) localStorage.setItem('modelry-admin-locale', 'en'); });
  await page.goto(runtimeURL, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Create your Modelry owner' })).toBeVisible();
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(ownerPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.locator('[data-shell-topbar]')).toBeVisible();
  await page.goto(runtimeURL + '/api', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'API workspace' })).toBeVisible();

  const openNavigation = page.getByRole('button', { name: 'Expand project navigation' });
  await expect(openNavigation).toBeVisible();
  await expect(page.locator('[data-shell-sidebar]')).not.toBeVisible();
  await openNavigation.click();
  const drawer = page.getByRole('dialog', { name: 'Project navigation' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'Collections', exact: true }).click();
  await expect(page).toHaveURL(/\/collections$/);
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collections', level: 1 })).toBeVisible();
  await openNavigation.click();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(openNavigation).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);

  await page.setViewportSize({ width: 1024, height: 976 });
  const sidebar = page.getByRole('complementary', { name: 'Project navigation' });
  await expect(sidebar).toBeVisible();
  await page.getByRole('button', { name: 'Collapse project navigation' }).click();
  await expect.poll(async () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(72);
  await page.getByRole('button', { name: 'Expand project navigation' }).click();
  await expect.poll(async () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(248);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  const created = await page.evaluate(async (name) => {
    const response = await fetch('/admin/api/v1/collections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] }),
    });
    return { status: response.status, body: await response.json() as { data?: { id?: string } } };
  }, 'orders_for_international_customer_support_and_regional_fulfillment_operations_26');
  expect(created.status).toBe(201);
  const collectionId = created.body.data?.id;
  expect(collectionId).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(runtimeURL + '/collections/' + encodeURIComponent(collectionId!), { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Records', level: 2 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // 在真实 Runtime 上验证紧凑头部、耐久记录和详情入口。
  const compact = await page.evaluate(async () => {
    const response = await fetch('/admin/api/v1/collections', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'notes', description: 'Saved collection description', type: 'Normal', fields: [{ name: 'title', type: 'text' }] }),
    });
    return { status: response.status, body: await response.json() as { data?: { id?: string } } };
  });
  expect(compact.status).toBe(201);
  const compactId = compact.body.data!.id!;
  const recordStatus = await page.evaluate(async (id) => {
    const response = await fetch('/admin/api/v1/collections/' + id + '/records', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { title: 'First note' } }),
    });
    return response.status;
  }, compactId);
  expect(recordStatus).toBe(201);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const locale of ['en', 'zh-CN']) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(({ locale, theme }) => {
          localStorage.setItem('modelry-admin-locale', locale);
          localStorage.setItem('modelry-admin-theme', theme);
        }, { locale, theme });
        await page.goto(runtimeURL + '/collections/' + compactId);
        await expect(page.locator('[data-record-table] tbody')).toContainText('First note');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('button', { name: locale === 'en' ? 'Collection details' : '集合详情', exact: true })).toBeVisible();
        await expect(page.locator('[data-runtime-badge]')).toHaveAttribute('aria-label', locale === 'en' ? 'Runtime ready' : 'Runtime 正常');
        expect(await page.locator('[data-collection-title]').count()).toBe(1);
        expect(await page.locator('[data-record-toolbar] button').last().boundingBox()).not.toBeNull();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const table = await page.locator('[data-record-table]').boundingBox();
        if (width >= 1024) expect(table!.y).toBeLessThan(340);
        await page.screenshot({ path: testInfo.outputPath(`compact-records-${width}-${locale}-${theme}.png`) });
      }
    }
  }
  await page.getByRole('button', { name: '创建记录', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '创建记录', exact: true });
  await editor.getByRole('textbox', { name: 'title', exact: true }).fill('Created from compact toolbar');
  await editor.getByRole('button', { name: '创建记录', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  await expect(page.locator('[data-record-table] tbody')).toContainText('Created from compact toolbar');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '集合详情', exact: true }).click();
  await expect(page.getByText('Saved collection description')).toBeVisible();
  await page.keyboard.press('Escape');
  for (const route of ['/api?tab=logs', '/events?tab=webhooks', '/events?tab=triggers', '/schedules', '/access?tab=tokens', '/settings/runtime', '/settings/storage', '/settings/mail', '/settings/backups', '/settings/data', '/settings/secrets', '/access?tab=administrators', '/collections/' + compactId + '/model', '/collections/' + compactId + '/access', '/collections/' + compactId + '/api', '/mcp']) {
    await page.goto(runtimeURL + route);
    await expect(page.locator('[data-shell-topbar]')).toBeVisible();
    await expect(page.locator('[data-runtime-badge]')).toHaveAttribute('aria-label', 'Runtime 正常');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: testInfo.outputPath(`compact-page-${route.replace(/[^a-z]/gi, '-')}.png`) });
  }

  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate((locale) => localStorage.setItem('modelry-admin-locale', locale), locale);
    await page.goto(runtimeURL + '/collections/new');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const picker = page.locator('[data-field-type-picker]');
    await expect(picker).toBeVisible();
    const choices = picker.getByRole('button');
    await expect(choices).toHaveCount(8);
    const firstChoice = await choices.nth(0).boundingBox();
    const secondChoice = await choices.nth(1).boundingBox();
    expect(Math.abs(firstChoice!.y - secondChoice!.y)).toBeLessThan(1);
    expect(secondChoice!.x).toBeGreaterThan(firstChoice!.x);
    await page.screenshot({ path: testInfo.outputPath(`field-type-picker-${locale}.png`) });
    await picker.getByRole('button', { name: locale === 'en' ? 'Number' : '数字', exact: true }).click();
    await expect(page.getByRole('textbox', { name: locale === 'en' ? 'Field name 1' : '字段名 1', exact: true })).toHaveValue('number_1');
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const row = page.locator('[data-initial-field-row]').first();
      await row.scrollIntoViewIfNeeded();
      const required = await row.getByRole('checkbox', { name: locale === 'en' ? 'Required' : '必填', exact: true }).boundingBox();
      const unique = await row.getByRole('checkbox', { name: locale === 'en' ? 'Unique' : '唯一', exact: true }).boundingBox();
      await page.screenshot({ path: testInfo.outputPath(`compact-field-${width}-${locale}.png`) });
      expect(Math.abs(required!.y - unique!.y)).toBeLessThan(1);
      expect(unique!.x).toBeGreaterThan(required!.x);
      expect((await row.boundingBox())!.height).toBeLessThan(width >= 768 ? 75 : 145);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await expect(picker).toBeVisible();
      const choiceA = await picker.getByRole('button').nth(0).boundingBox();
      const choiceB = await picker.getByRole('button').nth(1).boundingBox();
      expect(Math.abs(choiceA!.y - choiceB!.y)).toBeLessThan(1);
      expect(choiceB!.x).toBeGreaterThan(choiceA!.x);
      expect((await picker.boundingBox())!.width).toBeLessThan(width);
      await page.screenshot({ path: testInfo.outputPath(`field-type-picker-${width}-${locale}.png`) });
      await page.keyboard.press('Escape');
      await expect(picker).not.toBeVisible();
      await row.getByRole('checkbox', { name: locale === 'en' ? 'Required' : '必填', exact: true }).check();
      await expect(row.getByRole('checkbox', { name: locale === 'en' ? 'Required' : '必填', exact: true })).toBeChecked();
    }
  }
  const change = await page.evaluate(async (id) => {
    const call = async (path: string, body?: unknown) => {
      const response = await fetch('/admin/api/v1/collections/' + id + path, { method: body ? 'POST' : 'GET', credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error('变更验收请求失败：' + response.status);
      return response.json();
    };
    const collection = await call('');
    const field = collection.data.fields.find((field: {name:string}) => field.name === 'title');
    const pending = await call('/schema/pending-operations', { kind: 'field', action: 'update', targetId: field.id, definition: { ...field, unique: true } });
    await call('/schema/preview', { expectedVersion: pending.data.version });
    await call('/schema/apply', { expectedVersion: pending.data.version, confirmRisk: true });
    return pending.data.changeSetId as string;
  }, compactId);
  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate((locale) => localStorage.setItem('modelry-admin-locale', locale), locale);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(runtimeURL + '/changes?tab=history&changeSet=' + change);
      const detail = page.getByRole('complementary', { name: locale === 'en' ? 'Change details' : '变更详情' });
      await expect(detail.getByRole('heading', { name: locale === 'en' ? 'Update field title' : '修改字段 title', exact: true })).toBeVisible();
      await expect(detail.getByRole('row', { name: locale === 'en' ? 'Unique No Yes' : '唯一 否 是', exact: true })).toBeVisible();
      await expect(detail.getByRole('heading', { name: locale === 'en' ? 'Pending changes' : '待应用变更' })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`change-comparison-${width}-${locale}.png`) });
      await page.reload();
      await expect(detail.getByRole('row', { name: locale === 'en' ? 'Unique No Yes' : '唯一 否 是', exact: true })).toBeVisible();
    }
  }

});
