import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../e2e/evidence-fixtures';
import { collectSensitiveValues, redactEvidenceText, redactStructuredEvidence } from '../e2e/evidence-redaction.mjs';
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
      <input id="probe-client-secret" name="clientSecretValue" value="${evidenceSentinels.clientSecretValue}">
      <input id="probe-otp" name="otp" value="${evidenceSentinels.otp}">
      <input id="probe-session-id" name="sessionId" value="${evidenceSentinels.sessionId}">
      <input id="probe-code" name="code" autocomplete="one-time-code" value="${evidenceSentinels.oneTimeCode}">
      <input id="probe-reset" name="resetToken" value="${evidenceSentinels.resetToken}">
      <input id="probe-verification" name="verificationToken" value="${evidenceSentinels.verificationToken}">
      <input id="probe-app-session" name="appSession" value="${evidenceSentinels.appSession}">
      <input id="probe-email-verification-code" name="emailVerificationCode" value="${evidenceSentinels.emailVerificationCode}">
      <input id="probe-reset-code" name="resetCode" value="${evidenceSentinels.resetCode}">
      <input id="probe-verification-code" name="verificationCode" value="${evidenceSentinels.verificationCode}">
      <input id="probe-app-session-cookie" name="appSessionCookie" value="${evidenceSentinels.appSessionCookie}">
      <input id="probe-auth-session-cookie" name="authSessionCookie" value="${evidenceSentinels.authSessionCookie}">
      <textarea id="probe-json-payload" name="payload">{&quot;clientSecrets&quot;:[&quot;${evidenceSentinels.apiKey}&quot;],&quot;refreshTokens&quot;:[{&quot;nestedValues&quot;:[&quot;${evidenceSentinels.sessionToken}&quot;]}],&quot;verificationCodes&quot;:[&quot;${evidenceSentinels.verificationCode}&quot;]}</textarea>
      <textarea id="probe-text-payload" name="payload">clientSecrets=${evidenceSentinels.clientSecretValue}</textarea>
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
        appSession: evidenceSentinels.appSession,
        emailVerificationCode: evidenceSentinels.emailVerificationCode,
        resetCode: evidenceSentinels.resetCode,
        verificationCode: evidenceSentinels.verificationCode,
        appSessionCookie: evidenceSentinels.appSessionCookie,
        authSessionCookie: evidenceSentinels.authSessionCookie,
      }),
    });
  });
  await page.goto('https://evidence.invalid/');

  const encodeNumericEntities = (value: string) => [...value]
    .map((character) => `&#${character.codePointAt(0)};`)
    .join('');
  const collectedArrayValues = {
    credentials: ['probe-array-secret-value-2026', { nestedValues: ['probe-nested-array-secret-value-2026'] }],
    clientSecrets: ['probe-array-client-secret-value-2026'],
    refreshTokens: ['probe-array-refresh-token-value-2026'],
    verificationCodes: ['probe-array-verification-code-value-2026'],
  };
  collectSensitiveValues(collectedArrayValues);
  const collectedArrayOutput = redactEvidenceText(JSON.stringify(collectedArrayValues));
  const collectedArrayValuesRedacted = !collectedArrayOutput.includes(collectedArrayValues.credentials[0])
    && !collectedArrayOutput.includes(collectedArrayValues.credentials[1].nestedValues[0])
    && !collectedArrayOutput.includes(collectedArrayValues.clientSecrets[0])
    && !collectedArrayOutput.includes(collectedArrayValues.refreshTokens[0])
    && !collectedArrayOutput.includes(collectedArrayValues.verificationCodes[0]);

  const structuredArrayValues = {
    secret: ['probe-structured-secret-value-2026', { nestedValues: ['probe-structured-nested-secret-2026'] }],
    clientSecretValue: ['probe-structured-client-secret-2026'],
    clientSecrets: ['probe-structured-client-secrets-2026'],
    refreshTokens: ['probe-structured-refresh-tokens-2026'],
    verificationCodes: ['probe-structured-verification-codes-2026'],
  };
  const structuredArrayOutput = JSON.stringify(redactStructuredEvidence(structuredArrayValues));
  const structuredArrayValuesRedacted = !structuredArrayOutput.includes(structuredArrayValues.secret[0])
    && !structuredArrayOutput.includes(structuredArrayValues.secret[1].nestedValues[0])
    && !structuredArrayOutput.includes(structuredArrayValues.clientSecretValue[0])
    && !structuredArrayOutput.includes(structuredArrayValues.clientSecrets[0])
    && !structuredArrayOutput.includes(structuredArrayValues.refreshTokens[0])
    && !structuredArrayOutput.includes(structuredArrayValues.verificationCodes[0]);

  const textareaSecret = 'probe-entity-textarea-secret-2026';
  const encodedTextareaJson = encodeNumericEntities(JSON.stringify({ secret: [textareaSecret] }));
  const redactedTextareaMarkup = redactEvidenceText(`<textarea name="payload">${encodedTextareaJson}</textarea>`);
  const entityEncodedTextareaRedacted = !redactedTextareaMarkup.includes(textareaSecret)
    && !redactedTextareaMarkup.includes(encodeNumericEntities(textareaSecret));
  const compoundKeySecret = 'probe-compound-key-secret-2026';
  const compoundKeyText = redactEvidenceText(`clientSecretValue=${compoundKeySecret} passwordHash=${compoundKeySecret}`);
  const compoundKeyValuesRedacted = !compoundKeyText.includes(compoundKeySecret);

  const protectedFields = page.locator('#sensitive-preview input');
  await expect(protectedFields).toHaveCount(15);
  await expect(page.locator('#probe-api-key')).toHaveAttribute('data-evidence-sensitive', 'true');
  await expect(page.locator('#probe-session')).toHaveAttribute('data-evidence-sensitive', 'true');
  await expect(page.locator('#probe-reset')).toHaveAttribute('data-evidence-sensitive', 'true');
  await expect(page.locator('#probe-verification')).toHaveAttribute('data-evidence-sensitive', 'true');

  const otpFieldSensitive = await page.locator('#probe-otp').getAttribute('data-evidence-sensitive') === 'true';
  const sessionIdFieldSensitive = await page.locator('#probe-session-id').getAttribute('data-evidence-sensitive') === 'true';
  const oneTimeCodeFieldSensitive = await page.locator('#probe-code').getAttribute('data-evidence-sensitive') === 'true';
  const appSessionFieldSensitive = await page.locator('#probe-app-session').getAttribute('data-evidence-sensitive') === 'true';
  const emailVerificationCodeFieldSensitive = await page.locator('#probe-email-verification-code').getAttribute('data-evidence-sensitive') === 'true';
  const resetCodeFieldSensitive = await page.locator('#probe-reset-code').getAttribute('data-evidence-sensitive') === 'true';
  const verificationCodeFieldSensitive = await page.locator('#probe-verification-code').getAttribute('data-evidence-sensitive') === 'true';
  const appSessionCookieFieldSensitive = await page.locator('#probe-app-session-cookie').getAttribute('data-evidence-sensitive') === 'true';
  const authSessionCookieFieldSensitive = await page.locator('#probe-auth-session-cookie').getAttribute('data-evidence-sensitive') === 'true';
  const payloadFieldSensitive = await page.locator('#probe-json-payload').getAttribute('data-evidence-sensitive') === 'true';
  const payloadFieldMasked = await page.locator('#probe-json-payload').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const textPayloadFieldSensitive = await page.locator('#probe-text-payload').getAttribute('data-evidence-sensitive') === 'true';
  const textPayloadFieldMasked = await page.locator('#probe-text-payload').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const pageStyles = await page.locator('#sensitive-preview input, #probe-json-payload, #probe-text-payload, .access-reveal__secret').evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).color));
  const textIsMasked = pageStyles.every((color) => color === 'rgba(0, 0, 0, 0)')
    && payloadFieldSensitive
    && payloadFieldMasked
    && textPayloadFieldSensitive
    && textPayloadFieldMasked
    && collectedArrayValuesRedacted
    && structuredArrayValuesRedacted
    && entityEncodedTextareaRedacted
    && compoundKeyValuesRedacted;
  const otpFieldMasked = await page.locator('#probe-otp').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const sessionIdFieldMasked = await page.locator('#probe-session-id').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const oneTimeCodeFieldMasked = await page.locator('#probe-code').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const appSessionFieldMasked = await page.locator('#probe-app-session').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const emailVerificationCodeFieldMasked = await page.locator('#probe-email-verification-code').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const resetCodeFieldMasked = await page.locator('#probe-reset-code').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const verificationCodeFieldMasked = await page.locator('#probe-verification-code').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const appSessionCookieFieldMasked = await page.locator('#probe-app-session-cookie').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
  const authSessionCookieFieldMasked = await page.locator('#probe-auth-session-cookie').evaluate((element) => getComputedStyle(element).color === 'rgba(0, 0, 0, 0)');
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
        appSession: values.appSession,
        emailVerificationCode: values.emailVerificationCode,
        resetCode: values.resetCode,
        verificationCode: values.verificationCode,
        appSessionCookie: values.appSessionCookie,
        authSessionCookie: values.authSessionCookie,
      }),
    });
    return response.json();
  }, evidenceSentinels);
  const networkRoundTrip = roundTrip.password === evidenceSentinels.password
    && roundTrip.apiKey === evidenceSentinels.apiKey
    && roundTrip.sessionToken === evidenceSentinels.sessionToken
    && roundTrip.resetToken === evidenceSentinels.resetToken
    && roundTrip.verificationToken === evidenceSentinels.verificationToken
    && roundTrip.appSession === evidenceSentinels.appSession
    && roundTrip.emailVerificationCode === evidenceSentinels.emailVerificationCode
    && roundTrip.resetCode === evidenceSentinels.resetCode
    && roundTrip.verificationCode === evidenceSentinels.verificationCode
    && roundTrip.appSessionCookie === evidenceSentinels.appSessionCookie
    && roundTrip.authSessionCookie === evidenceSentinels.authSessionCookie;

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
    otpFieldSensitive,
    sessionIdFieldSensitive,
    oneTimeCodeFieldSensitive,
    appSessionFieldSensitive,
    emailVerificationCodeFieldSensitive,
    resetCodeFieldSensitive,
    verificationCodeFieldSensitive,
    appSessionCookieFieldSensitive,
    authSessionCookieFieldSensitive,
    payloadFieldSensitive,
    payloadFieldMasked,
    textPayloadFieldSensitive,
    textPayloadFieldMasked,
    collectedArrayValuesRedacted,
    structuredArrayValuesRedacted,
    entityEncodedTextareaRedacted,
    compoundKeyValuesRedacted,
    otpFieldMasked,
    sessionIdFieldMasked,
    oneTimeCodeFieldMasked,
    appSessionFieldMasked,
    emailVerificationCodeFieldMasked,
    resetCodeFieldMasked,
    verificationCodeFieldMasked,
    appSessionCookieFieldMasked,
    authSessionCookieFieldMasked,
    maskedPixelsStable,
    networkRoundTrip,
    runtimeLogRedacted,
  }), 'utf8');

  throw new Error(`intentional evidence probe failure ${JSON.stringify(evidenceSentinels)}`);
});
