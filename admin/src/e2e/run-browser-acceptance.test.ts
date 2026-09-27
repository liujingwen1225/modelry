import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const adminDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerPath = path.join(adminDirectory, 'e2e', 'run-browser-acceptance.mjs');
const secret = 'runner-sentinel-secret-value';
const temporaryDirectories: string[] = [];
const artifactDirectories: string[] = [];

afterEach(async () => {
  const directories = [...temporaryDirectories.splice(0), ...artifactDirectories.splice(0)];
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('browser acceptance evidence lifecycle', () => {
  it('removes unpublished artifacts when evidence sanitization fails', async () => {
    const run = await createRunnerFixture({ failSanitization: true });

    const result = await runBrowserAcceptance(run.environment);

    expect(result.exitCode).toBe(1);
    await expect(access(run.resultsDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(run.reportDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains report and test evidence after sanitization succeeds', async () => {
    const run = await createRunnerFixture({ failSanitization: false });

    const result = await runBrowserAcceptance(run.environment);

    expect(result.exitCode).toBe(0);
    const testEvidence = await readFile(path.join(run.resultsDirectory, 'error-context.md'), 'utf8');
    const report = await readFile(path.join(run.reportDirectory, 'index.html'), 'utf8');
    expect(testEvidence).toContain('[REDACTED]');
    expect(report).toContain('[REDACTED]');
    expect(testEvidence).not.toContain(secret);
    expect(report).not.toContain(secret);
  });

  it('rejects non-dedicated artifact roots before starting Playwright or deleting existing files', async () => {
    const run = await createRunnerFixture({ failSanitization: true });
    const unrelatedDirectory = path.join(run.directory, 'important-data');
    const markerPath = path.join(unrelatedDirectory, 'keep.txt');
    await mkdir(unrelatedDirectory);
    await writeFile(markerPath, 'user data');

    const result = await runBrowserAcceptance({
      ...run.environment,
      MODELRY_EVIDENCE_TEST_RESULTS_DIR: unrelatedDirectory,
    });

    expect(result.exitCode).toBe(1);
    expect(await readFile(markerPath, 'utf8')).toBe('user data');
    await expect(access(run.launchMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createRunnerFixture(options: { failSanitization: boolean }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'modelry-runner-test-'));
  temporaryDirectories.push(directory);

  const playwrightPackageRoot = path.join(directory, 'playwright-package-root');
  const playwrightPackage = path.join(playwrightPackageRoot, 'node_modules', '@playwright', 'test');
  const launchMarker = path.join(directory, 'playwright-started');
  await mkdir(playwrightPackage, { recursive: true });
  await writeFile(path.join(playwrightPackageRoot, 'package.json'), '{}');
  await writeFile(path.join(playwrightPackage, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '0.0.0' }));
  await writeFile(path.join(playwrightPackage, 'cli.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const results = process.env.MODELRY_EVIDENCE_TEST_RESULTS_DIR;
    const report = process.env.MODELRY_EVIDENCE_REPORT_DIR;
    fs.writeFileSync(${JSON.stringify(launchMarker)}, 'started');
    fs.mkdirSync(results, { recursive: true });
    fs.mkdirSync(report, { recursive: true });
    fs.writeFileSync(path.join(results, 'error-context.md'), 'password=${secret}\\n');
    fs.writeFileSync(path.join(report, 'index.html'), '<main>${secret}</main>');
    fs.writeFileSync(process.env.MODELRY_EVIDENCE_REDACTION_FILE, JSON.stringify(['${secret}']) + '\\n');
    ${options.failSanitization ? "fs.writeFileSync(path.join(results, 'trace.zip'), Buffer.from('PK\\u0003\\u0004invalid'));" : ''}
    process.stdout.write('browser acceptance finished\\n');
  `);

  const evidenceId = path.basename(directory).replace(/^modelry-runner-test-/, '');
  const resultsDirectory = path.join(adminDirectory, `test-results-evidence-redaction-${evidenceId}`);
  const reportDirectory = path.join(adminDirectory, `playwright-report-evidence-redaction-${evidenceId}`);
  artifactDirectories.push(resultsDirectory, reportDirectory);
  return {
    environment: {
      ...process.env,
      MODELRY_PLAYWRIGHT_PACKAGE_ROOT: playwrightPackageRoot,
      MODELRY_EVIDENCE_TEST_RESULTS_DIR: resultsDirectory,
      MODELRY_EVIDENCE_REPORT_DIR: reportDirectory,
    },
    resultsDirectory,
    reportDirectory,
    directory,
    launchMarker,
  };
}

function runBrowserAcceptance(environment: NodeJS.ProcessEnv) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: adminDirectory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}
