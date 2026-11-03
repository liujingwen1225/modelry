import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

/**
 * 视觉对照截图工具：对真实 Go 运行时截图，用于和 Figma 画板逐页比对。
 *
 * 用法：
 *   MODELRY_BASE_URL=http://127.0.0.1:8090 MODELRY_OWNER_EMAIL=... MODELRY_OWNER_PASSWORD=... \
 *   node e2e/capture.mjs <输出目录> [路由...]
 *
 * 它不是验收测试，不产生通过/失败结论；验收见 foundation.spec.ts 与后续各 Issue 的 spec。
 */
const baseURL = process.env.MODELRY_BASE_URL ?? 'http://127.0.0.1:8090'
const email = process.env.MODELRY_OWNER_EMAIL ?? 'owner@modelry.test'
const password = process.env.MODELRY_OWNER_PASSWORD ?? 'local-admin-password-42'
const outputDir = process.argv[2] ?? 'screenshots'
const routes = process.argv.slice(3)

if (routes.length === 0) {
  routes.push('/', '/data', '/access', '/developer', '/logic', '/changes', '/settings')
}

await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1512, height: 1000 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
})
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

await page.goto(`${baseURL}/`, { waitUntil: 'networkidle' })

// 等待守护层判定完首次设置/登录状态，否则标题还没渲染就会误判。
await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 })

// 首次运行先建立管理员；已建立时直接登录。
if (await page.getByRole('heading', { name: '创建管理员账号' }).count()) {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码').fill(password)
  await page.getByRole('button', { name: '创建并进入' }).click()
} else if (await page.getByRole('heading', { name: '登录本地管理面' }).count()) {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码').fill(password)
  await page.locator('button[type="submit"]').click()
}

await page.waitForTimeout(800)

// 视觉对照按 Figma 画板尺寸（1512×1000）截视口；需要整页时传 MODELRY_CAPTURE_FULL=1。
const fullPage = process.env.MODELRY_CAPTURE_FULL === '1'

for (const route of routes) {
  await page.goto(`${baseURL}${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const name = route === '/' ? 'overview' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage })
  console.log(`captured ${route} -> ${outputDir}/${name}.png`)
}

if (consoleErrors.length > 0) {
  console.log(`console errors:\n${consoleErrors.join('\n')}`)
}

await browser.close()
