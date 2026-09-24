import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const installedChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const executablePath = process.env.CHROME_PATH ?? (existsSync(installedChrome) ? installedChrome : undefined);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.MODELRY_BASE_URL ?? 'http://127.0.0.1:8080',
    headless: true,
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
});
