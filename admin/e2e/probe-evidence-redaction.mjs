import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceSentinels, replacementSentinels } from '../evidence-probe/sentinels.mjs';
import { redactEvidenceText } from './evidence-redaction.mjs';
import { verifyEvidenceRoots } from './sanitize-evidence.mjs';

const adminDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.MODELRY_PLAYWRIGHT_PACKAGE_ROOT) throw new Error('Set MODELRY_PLAYWRIGHT_PACKAGE_ROOT to the existing project dependency root.');
const runId = `${process.pid}-${Date.now()}`;
const resultRoot = `test-results-evidence-redaction-${runId}`;
const reportRoot = `playwright-report-evidence-redaction-${runId}`;
const knownSentinels = [...Object.values(evidenceSentinels), ...Object.values(replacementSentinels)];
const cli = spawn(process.execPath, [
  path.join(adminDirectory, 'e2e', 'run-browser-acceptance.mjs'),
  '--config',
  path.join(adminDirectory, 'evidence-probe.config.mjs'),
], {
  cwd: adminDirectory,
  env: {
    ...process.env,
    MODELRY_EVIDENCE_TEST_RESULTS_DIR: resultRoot,
    MODELRY_EVIDENCE_REPORT_DIR: reportRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const stdout = [];
const stderr = [];
cli.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
cli.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
const exitCode = await new Promise((resolve, reject) => {
  cli.once('error', reject);
  cli.once('close', (code) => resolve(code ?? 1));
});

if (exitCode !== 1) throw new Error('The evidence probe did not produce its expected failure result.');
const capturedOutput = Buffer.concat([...stdout, ...stderr]).toString('utf8');
if (redactEvidenceText(capturedOutput, knownSentinels) !== capturedOutput) {
  throw new Error('A sensitive sentinel reached browser acceptance stdout or stderr.');
}

const resultDirectory = path.join(adminDirectory, resultRoot);
const reportDirectory = path.join(adminDirectory, reportRoot);
const scan = await verifyEvidenceRoots([resultDirectory, reportDirectory], knownSentinels);
const files = await listFiles(resultDirectory);
const checkPath = files.find((file) => path.basename(file) === 'evidence-redaction-probe.json');
if (!checkPath) throw new Error('The Playwright browser probe did not reach its evidence assertions.');
const checks = JSON.parse(await readFile(checkPath, 'utf8'));
if (!checks.textIsMasked || !checks.otpFieldSensitive || !checks.sessionIdFieldSensitive || !checks.oneTimeCodeFieldSensitive || !checks.appSessionFieldSensitive || !checks.emailVerificationCodeFieldSensitive || !checks.resetCodeFieldSensitive || !checks.verificationCodeFieldSensitive || !checks.appSessionCookieFieldSensitive || !checks.authSessionCookieFieldSensitive || !checks.otpFieldMasked || !checks.sessionIdFieldMasked || !checks.oneTimeCodeFieldMasked || !checks.appSessionFieldMasked || !checks.emailVerificationCodeFieldMasked || !checks.resetCodeFieldMasked || !checks.verificationCodeFieldMasked || !checks.appSessionCookieFieldMasked || !checks.authSessionCookieFieldMasked || !checks.maskedPixelsStable || !checks.networkRoundTrip || !checks.runtimeLogRedacted) {
  throw new Error('A browser, runtime log, or network redaction assertion failed.');
}
if (scan.archives < 1 || scan.visualFiles < 3 || scan.textFiles < 1 || !files.some((file) => path.basename(file) === 'video.webm') || !files.some((file) => path.basename(file).startsWith('test-failed-'))) {
  throw new Error('The expected trace, report, screenshot, or video evidence was not retained.');
}
if (!await containsReportIndex(reportDirectory)) throw new Error('The HTML report was not retained.');

process.stdout.write(`${JSON.stringify({ result: 'PASS', artifacts: scan, checks, expectedPlaywrightFailure: exitCode === 1 })}\n`);

async function listFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function containsReportIndex(directory) {
  return (await listFiles(directory)).some((file) => path.basename(file) === 'index.html');
}
