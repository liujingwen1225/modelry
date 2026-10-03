import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { currentSensitiveValues, redactEvidenceText } from './evidence-redaction.mjs';

type RuntimeLog = { stdout: string[]; stderr: string[] };

const logs = new Map<string, RuntimeLog>();

export function captureRuntimeLogs(child: ChildProcessWithoutNullStreams, label: string) {
  const current = logs.get(label) ?? { stdout: [], stderr: [] };
  logs.set(label, current);
  child.stdout.on('data', (chunk: string | Buffer) => current.stdout.push(String(chunk)));
  child.stderr.on('data', (chunk: string | Buffer) => current.stderr.push(String(chunk)));
}

export function redactRuntimeText(value: string) {
  return redactEvidenceText(value, currentSensitiveValues());
}

export async function persistRuntimeLogs(label: string) {
  const current = logs.get(label) ?? { stdout: [], stderr: [] };
  const contents = [
    '=== Runtime stdout ===',
    ...current.stdout,
    '=== Runtime stderr ===',
    ...current.stderr,
  ].join('');
  const adminDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configuredDirectory = process.env.MODELRY_EVIDENCE_TEST_RESULTS_DIR ?? 'test-results';
  const outputDirectory = path.resolve(adminDirectory, configuredDirectory, 'runtime-logs');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, `${label}.log`), redactRuntimeText(contents), 'utf8');
}
