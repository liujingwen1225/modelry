import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactEvidenceText } from './evidence-redaction.mjs';
import { readSensitiveValueFile, sanitizeEvidenceRoots } from './sanitize-evidence.mjs';

const adminDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightRequire = process.env.MODELRY_PLAYWRIGHT_PACKAGE_ROOT
  ? createRequire(path.join(process.env.MODELRY_PLAYWRIGHT_PACKAGE_ROOT, 'package.json'))
  : createRequire(import.meta.url);
const playwrightCLI = playwrightRequire.resolve('@playwright/test/cli');
const redactionDirectory = await mkdtemp(path.join(os.tmpdir(), 'modelry-evidence-'));
const redactionFile = path.join(redactionDirectory, 'values.jsonl');
await writeFile(redactionFile, '', { encoding: 'utf8', mode: 0o600 });

const stdout = [];
const stderr = [];
const child = spawn(process.execPath, [playwrightCLI, 'test', ...process.argv.slice(2)], {
  cwd: adminDirectory,
  env: { ...process.env, MODELRY_EVIDENCE_REDACTION_FILE: redactionFile },
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

let exitCode = 1;
try {
  exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  try {
    const sensitiveValues = await readSensitiveValueFile(redactionFile);
    await sanitizeEvidenceRoots([
      artifactRoot('MODELRY_EVIDENCE_TEST_RESULTS_DIR', 'test-results'),
      artifactRoot('MODELRY_EVIDENCE_REPORT_DIR', 'playwright-report'),
    ], sensitiveValues);
    process.stdout.write(redactEvidenceText(Buffer.concat(stdout).toString('utf8'), sensitiveValues));
    process.stderr.write(redactEvidenceText(Buffer.concat(stderr).toString('utf8'), sensitiveValues));
  } catch {
    process.stderr.write('Acceptance evidence sanitization failed; the result is not safe to share.\n');
    exitCode = 1;
  } finally {
    try { await rm(redactionDirectory, { recursive: true, force: true }); } catch { /* No credential material is printed. */ }
  }
}
process.exitCode = exitCode;

function artifactRoot(variable, fallback) {
  const value = process.env[variable] ?? path.join(adminDirectory, fallback);
  return path.isAbsolute(value) ? value : path.resolve(adminDirectory, value);
}
