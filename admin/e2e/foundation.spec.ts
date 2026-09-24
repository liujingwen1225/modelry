import { expect, test } from '@playwright/test';

test('real Runtime diagnostics, structured error, navigation, reload and deep link', async ({ page, baseURL }) => {
  const healthIssues: string[] = [];
  const diagnosticResponses = new Map<string, number>();
  const structuredErrorPath = '/admin/api/v1/__foundation-smoke-missing__';

  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url;
      // Chromium 会为这条被显式断言的 HTTP 404 记录资源错误；其它 Console Error 仍由 gate 拦截。
      const expectedStructuredError =
        message.text().includes('404') &&
        location !== '' &&
        new URL(location).pathname === structuredErrorPath;
      if (!expectedStructuredError) healthIssues.push(`console: ${message.text()} (${location || 'unknown source'})`);
    }
  });
  page.on('pageerror', (error) => healthIssues.push(`page: ${error.message}`));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/admin/api/v1/')) {
      diagnosticResponses.set(url.pathname, response.status());
    }
    if (response.status() >= 500) healthIssues.push(`HTTP ${response.status()}: ${url.pathname}`);
  });
  page.on('requestfailed', (request) => {
    healthIssues.push(`network: ${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });

  const homeResponse = await page.goto('/');
  expect(homeResponse?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Runtime ready', { exact: true })).toBeVisible();
  await expect(page.locator('.diagnostic-card').nth(1).getByText('Local', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  const runtimeStatus = await page.evaluate(async () => {
    const response = await fetch('/admin/api/v1/runtime/status', { credentials: 'omit', cache: 'no-store' });
    return { status: response.status, body: await response.json() as { state: string } };
  });
  expect(runtimeStatus.status).toBe(200);
  expect(runtimeStatus.body.state).toBe('ready');

  const storageStatus = await page.evaluate(async () => {
    const response = await fetch('/admin/api/v1/storage/status', { credentials: 'omit', cache: 'no-store' });
    return { status: response.status, body: await response.json() as { localStorage: { state: string; provider: string; path?: string } } };
  });
  expect(storageStatus.status).toBe(200);
  expect(storageStatus.body.localStorage.provider).toBe('Local');
  expect(storageStatus.body.localStorage.state).toBe('ready');
  expect(storageStatus.body.localStorage.path).toBeUndefined();

  const structuredError = await page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'omit' });
    return {
      status: response.status,
      headerRequestId: response.headers.get('X-Request-Id'),
      body: await response.json() as { error: { code: string; message: string; details: unknown; requestId: string } },
    };
  }, structuredErrorPath);
  expect(structuredError.status).toBe(404);
  expect(structuredError.body.error.code).toBe('NOT_FOUND');
  expect(structuredError.body.error.message).toBeTruthy();
  expect(structuredError.body.error.details).toBeTruthy();
  expect(structuredError.body.error.requestId).toMatch(/^req_[A-Za-z0-9_-]{8,}$/);
  expect(structuredError.body.error.requestId).toBe(structuredError.headerRequestId);

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(new RegExp(`${new URL(baseURL ?? 'http://127.0.0.1:8080').origin}/settings$`));
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  const deepLinkResponse = await page.goto('/collections');
  expect(deepLinkResponse?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This workflow is not delivered yet' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible();

  expect(diagnosticResponses.get('/admin/api/v1/runtime/status')).toBe(200);
  expect(diagnosticResponses.get('/admin/api/v1/storage/status')).toBe(200);
  expect(healthIssues, 'Browser Health Gate: console/page errors, HTTP 5xx, and failed requests').toEqual([]);
});
