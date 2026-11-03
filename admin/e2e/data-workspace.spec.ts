import { expect, test } from '@playwright/test'

/**
 * #43 真实浏览器验收：集合 → 记录 → 结构变更 → API。
 *
 * 全部操作走真实 UI 与真实 API/SQLite，不使用 mock 数据。
 */
const OWNER = { email: 'owner@modelry.test', password: 'local-admin-password-42' }

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.locator('h1').first().waitFor({ timeout: 20_000 })

  if (await page.getByRole('heading', { name: '创建管理员账号' }).count()) {
    await page.getByLabel('邮箱').fill(OWNER.email)
    await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
    await page.getByLabel('确认密码').fill(OWNER.password)
    await page.getByRole('button', { name: '创建并进入' }).click()
    await expect(page.getByRole('heading', { name: '从第一份数据开始' })).toBeVisible()
    return
  }

  if (await page.getByRole('heading', { name: '登录本地管理面' }).count()) {
    await page.getByLabel('邮箱').fill(OWNER.email)
    await page.getByLabel('密码').fill(OWNER.password)
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  }
})

test('创建集合：抽屉校验名称并写入真实结构', async ({ page }) => {
  await page.goto('/data')
  await expect(page.getByText('还没有集合')).toBeVisible()

  await page.getByRole('button', { name: '创建集合' }).first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.locator('.mr-drawer__heading')).toHaveText('创建集合')

  await drawer.getByLabel('集合名称').fill('reading_lists')
  await expect(drawer.getByText('✓ 名称可用')).toBeVisible()
  await drawer.getByLabel('说明').fill('想读、在读和读过的书单')

  await drawer.getByRole('button', { name: '创建集合' }).click()

  // 创建后自动进入该集合的记录工作面
  await expect(page.getByRole('heading', { name: 'reading_lists' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '集合', exact: true })).toContainText('reading_lists')
})

test('记录闭环：新增、选中、编辑、删除都读写真实 SQLite', async ({ page }) => {
  await page.goto('/data')
  await page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists').click()
  await expect(page.getByRole('heading', { name: 'reading_lists' })).toBeVisible()

  // 新增
  await page.getByRole('button', { name: '新增记录' }).click()
  const drawer = page.getByRole('dialog')
  await drawer.getByLabel('title').fill('周末徒步路线')
  await drawer.getByRole('button', { name: '创建记录' }).click()
  await expect(page.getByText('周末徒步路线').first()).toBeVisible()

  // 创建后在右侧直接打开这条记录的真实详情
  const detail = page.getByRole('complementary', { name: '记录详情' })
  await expect(detail).toContainText('周末徒步路线')
  await expect(detail).toContainText('id · ')

  // 编辑
  await page.getByRole('button', { name: '编辑记录' }).click()
  await page.getByRole('dialog').getByLabel('title').fill('周末徒步路线（改）')
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('周末徒步路线（改）').first()).toBeVisible()

  // 刷新后仍在
  await page.reload()
  await expect(page.getByText('周末徒步路线（改）').first()).toBeVisible()

  // 删除
  await page.getByRole('cell', { name: /周末徒步路线（改）/ }).click()
  await expect(page.getByRole('complementary', { name: '记录详情' })).toBeVisible()
  await page.getByRole('button', { name: '删除记录' }).click()
  await page.getByRole('button', { name: '永久删除' }).click()
  await expect(page.getByText('周末徒步路线（改）')).toHaveCount(0)
})

test('结构变更：新增字段进入待应用变更，应用后结构生效', async ({ page }) => {
  await page.goto('/data')
  await page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists').click()

  await page.getByRole('button', { name: '结构' }).click()
  await expect(page.locator('.mr-schema__head')).toContainText('字段 ·')

  await page.getByRole('button', { name: '添加字段' }).click()
  const drawer = page.getByRole('dialog')
  await drawer.getByLabel('字段名称').fill('rating')
  await drawer.getByLabel('说明').fill('想读到什么程度')
  await drawer.getByRole('button', { name: '保存到待应用变更' }).click()

  // 待应用变更提示条出现，必须先应用才会写入结构
  await expect(page.getByText(/1 项结构变更待应用/)).toBeVisible()
  await page.getByRole('button', { name: '应用到结构' }).click()
  await expect(page.getByText('已应用，结构已更新')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'rating' })).toBeVisible()

  // 刷新后结构仍然存在
  await page.reload()
  await expect(page.getByRole('cell', { name: 'rating' })).toBeVisible()
})

test('API 标签展示真实端点与调用地址', async ({ page }) => {
  await page.goto('/data')
  await page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists').click()
  await page.getByRole('button', { name: 'API' }).click()

  await expect(page.getByText('/api/v1/reading_lists').first()).toBeVisible()
  await expect(page.getByText('列出记录')).toBeVisible()
  await expect(page.getByText('创建记录')).toBeVisible()
})
