import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.MODELRY_BASE_URL ?? 'http://127.0.0.1:8080'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // 验收输出落在临时项目目录，避免每轮清理工作区里累积的大量截图/追踪文件。
  outputDir: process.env.MODELRY_TEST_OUTPUT ?? './test-results',
  use: {
    baseURL,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
})
