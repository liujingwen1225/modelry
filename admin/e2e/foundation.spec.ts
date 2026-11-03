import { expect, test, type Page } from '@playwright/test'

/**
 * #42 真实浏览器验收：新建管理员 → 空项目 → 概览 → 全局工作区。
 *
 * 验收对象是真实 Go 运行时 + 真实 SQLite（由 e2e/run-acceptance.mjs 启动），
 * 不使用 dev server、不 mock 任何接口。
 */
const OWNER = { email: 'owner@modelry.test', password: 'local-admin-password-42' }

test.describe.configure({ mode: 'serial' })

/** 每个用例使用独立浏览器上下文，因此除首次运行外都先真实登录。 */
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.locator('h1').first().waitFor({ timeout: 20_000 })
  if (await page.getByRole('heading', { name: '登录本地管理面' }).count()) {
    await page.getByLabel('邮箱').fill(OWNER.email)
    await page.getByLabel('密码').fill(OWNER.password)
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  }
})

async function completeFirstRun(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '创建管理员账号' })).toBeVisible()
  await page.getByLabel('邮箱').fill(OWNER.email)
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
  await page.getByLabel('确认密码').fill(OWNER.password)
  await page.getByRole('button', { name: '创建并进入' }).click()
  await expect(page.getByRole('heading', { name: '从第一份数据开始' })).toBeVisible()
}

/** 通过真实 Admin API 建一个集合，验证概览在有数据时切换到「继续工作」。 */
async function createNotesCollection(page: Page): Promise<string> {
  const response = await page.request.post('/admin/api/v1/collections', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      name: 'notes',
      description: '随手记下的想法',
      type: 'Normal',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'text' },
      ],
    },
  })
  expect(response.status()).toBe(201)
  const body = (await response.json()) as { data: { id: string } }
  return body.data.id
}

test('首次进入：创建管理员后进入空项目引导', async ({ page }) => {
  await completeFirstRun(page)

  await expect(page.getByText('先定义数据，再把它接到你的应用。')).toBeVisible()
  await expect(page.getByText('建集合', { exact: true })).toBeVisible()
  await expect(page.getByText('加数据', { exact: true })).toBeVisible()
  await expect(page.getByText('接前端', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /创建集合/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '让 AI 帮我设计' })).toBeVisible()

  // 空项目事实来自真实 API：0 个集合、0 条记录。
  await expect(page.getByText('0 个集合')).toBeVisible()
  await expect(page.getByText('0 条记录')).toBeVisible()
})

test('全局工作区：导航与页眉严格按 Figma 分组', async ({ page }) => {
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: '主导航' })

  for (const label of ['概览', '数据', '用户与访问', '业务逻辑', '开发与连接']) {
    await expect(nav.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(nav.getByText('待审阅变更', { exact: false })).toBeVisible()
  await expect(nav.getByText('API · 请求日志 · Secrets')).toBeVisible()
  await expect(nav.getByText('SQLite · 单实例 / 单项目')).toBeVisible()
  await expect(nav.getByText('设置', { exact: true })).toBeVisible()

  // 页眉：项目名 / 当前分区 / 全局工具
  const topbar = page.getByRole('navigation', { name: '当前位置' })
  await expect(topbar.getByText('概览')).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI 助手' })).toBeVisible()
})

test('概览：有集合后切换为继续工作，并读取真实计数', async ({ page }) => {
  await page.goto('/')
  const collectionId = await createNotesCollection(page)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '继续工作' })).toBeVisible()
  await expect(page.getByText('上次工作')).toBeVisible()
  await expect(page.locator('.mr-resume__name')).toHaveText('notes')
  await expect(page.getByText(/字段 5/)).toBeVisible()

  // 「继续配置」进入该集合的工作区（#43 交付前仍是同一入口）。
  await expect(page.getByRole('button', { name: /继续配置/ })).toBeVisible()

  // 刷新后数据仍来自真实 SQLite。
  await page.reload()
  await expect(page.locator('.mr-resume__name')).toHaveText('notes')

  expect(collectionId).toMatch(/^col_/)
})

test('视觉基线：Figma 设计变量生效，未引入第二套 UI 库', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '继续工作' })).toBeVisible()

  const navWidth = await page.locator('.mr-nav').evaluate((node) => getComputedStyle(node).width)
  expect(navWidth).toBe('216px')

  const navBackground = await page.locator('.mr-nav').evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(navBackground).toBe('rgb(247, 248, 246)')

  const primary = await page
    .locator('.mr-resume__card button.ant-btn-primary')
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(primary).toBe('rgb(56, 90, 75)')

  // 统一 UI 出口之外不允许挂载其它组件库的样式表。
  const styleSources = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
      .map((node) => node.getAttribute('href') ?? node.textContent?.slice(0, 80) ?? '')
      .join(' '),
  )
  expect(styleSources).not.toMatch(/shadcn|mantine|ant-design\/x/i)
})

test('未知路径给出可恢复的 404，而不是空白页', async ({ page }) => {
  await page.goto('/this-page-does-not-exist')
  await expect(page.getByText('页面不存在')).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
})
