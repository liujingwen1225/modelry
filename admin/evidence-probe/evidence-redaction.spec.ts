import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../e2e/evidence-fixtures';
import { captureRuntimeLogs, persistRuntimeLogs } from '../e2e/runtime-logs';
import { evidenceSentinels, replacementSentinels } from './sentinels.mjs';

test('evidence artifacts redact sensitive browser and runtime values', async ({ page }, testInfo) => {
  const html = `<!doctype html>
    <html><head><meta charset="utf-8"><style>
      body { font: 16px Arial, sans-serif; padding: 12px; }
      #sensitive-preview { box-sizing: border-box; width: 520px; height: 260px; padding: 8px; }
      input { box-sizing: border-box; width: 480px; height: 30px; margin: 2px; }
      .access-reveal__secret { box-sizing: border-box; width: 480px; height: 34px; overflow: hidden; }
    </style></head><body><main id="sensitive-preview">
      <input autocomplete="new-password" id="probe-password" name="password" type="password" value="${evidenceSentinels.password}">
      <input id="probe-api-key" name="apiKey" value="${evidenceSentinels.apiKey}">
      <input id="probe-session" name="sessionToken" value="${evidenceSentinels.sessionToken}">
      <input id="probe-reset" name="resetToken" value="${evidenceSentinels.resetToken}">
      <input id="probe-verification" name="verificationToken" value="${evidenceSentinels.verificationToken}">
      <div class="access-reveal__secret"><code>${evidenceSentinels.revealSecret}</code><button type="button">Copy</button></div>
    </main></body></html>`;

  await page.route('https://evidence.invalid/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: html });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        password: evidenceSentinels.password,
        apiKey: evidenceSentinels.apiKey,
        secret: evidenceSentinels.revealSecret,
        sessionToken: evidenceSentinels.sessionToken,
        resetToken: evidenceSentinels.resetToken,
        verificationToken: evidenceSentinels.verificationToken,
      }),
    });
  });
  await page.goto('https://evidence.invalid/');

  const protectedFields = page.locator('#sensitive-preview input');
  await expect(protectedFields).toHaveCount(5);
  await expect(page.locator('#probe-api-key')).toHaveAttribute('data-evidence-sensitive', 'true');
  await expect(page.locator('#probe-session')).toHaveAttribute('data-evidence-sensitive', 'true');
  await expect(page.locator('#probe-reset')).toHaveAttribute('data-evidence-sensitive', 'true');
  await expect(page.locator('#probe-verification')).toHaveAttribute('data-evidence-sensitive', 'true');

  const pageStyles = await page.locator('#sensitive-preview input, .access-reveal__secret').evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).color));
  const textIsMasked = pageStyles.every((color) => color === 'rgba(0, 0, 0, 0)');
  const firstPixels = await page.locator('#sensitive-preview').screenshot({ animations: 'disabled' });
  await page.locator('#probe-api-key').fill(replacementSentinels.apiKey);
  await page.locator('.access-reveal__secret code').evaluate((element, value) => { element.textContent = value; }, replacementSentinels.revealSecret);
  await page.locator('#probe-api-key').evaluate((element) => element.blur());
  const secondPixels = await page.locator('#sensitive-preview').screenshot({ animations: 'disabled' });
  const maskedPixelsStable = firstPixels.equals(secondPixels);

  await page.context().addCookies([{
    name: 'session_id',
    value: evidenceSentinels.sessionToken,
    domain: 'evidence.invalid',
    path: '/',
    sameSite: 'Lax',
  }]);
  const roundTrip = await page.evaluate(async (values) => {
    const response = await fetch(`/api/evidence?reset_token=${encodeURIComponent(values.resetToken)}&verification_token=${encodeURIComponent(values.verificationToken)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${values.authorization}`,
        'X-Api-Key': values.apiKey,
      },
      body: JSON.stringify({
        password: values.password,
        apiKey: values.apiKey,
        sessionToken: values.sessionToken,
        resetToken: values.resetToken,
        verificationToken: values.verificationToken,
      }),
    });
    return response.json();
  }, evidenceSentinels);
  const networkRoundTrip = roundTrip.password === evidenceSentinels.password
    && roundTrip.apiKey === evidenceSentinels.apiKey
    && roundTrip.sessionToken === evidenceSentinels.sessionToken
    && roundTrip.resetToken === evidenceSentinels.resetToken
    && roundTrip.verificationToken === evidenceSentinels.verificationToken;

  const splitWriteScript = `process.stderr.write('password='); setTimeout(() => process.stderr.write(${JSON.stringify(evidenceSentinels.password)}), 25);`;
  const child = spawn(process.execPath, ['-e', splitWriteScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  captureRuntimeLogs(child, 'evidence-redaction-probe');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Runtime log probe exited unexpectedly.')));
  });
  await persistRuntimeLogs('evidence-redaction-probe');
  const adminDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resultsDirectory = path.resolve(adminDirectory, process.env.MODELRY_EVIDENCE_TEST_RESULTS_DIR ?? 'test-results-evidence-probe');
  const runtimeLog = await readFile(path.join(resultsDirectory, 'runtime-logs', 'evidence-redaction-probe.log'), 'utf8');
  const runtimeLogRedacted = !runtimeLog.includes(evidenceSentinels.password);

  await writeFile(testInfo.outputPath('evidence-redaction-probe.json'), JSON.stringify({
    textIsMasked,
    maskedPixelsStable,
    networkRoundTrip,
    runtimeLogRedacted,
  }), 'utf8');

  throw new Error(`intentional evidence probe failure ${JSON.stringify(evidenceSentinels)}`);
});
