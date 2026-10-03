import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
export default {
  testDir: './evidence-probe',
  testMatch: '**/*.spec.ts',
  outputDir: process.env.MODELRY_EVIDENCE_TEST_RESULTS_DIR ?? path.join(configDirectory, 'test-results-evidence-probe'),
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', {
    outputFolder: process.env.MODELRY_EVIDENCE_REPORT_DIR ?? path.join(configDirectory, 'playwright-report-evidence-probe'),
    open: 'never',
  }]],
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
};
