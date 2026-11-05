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

test('文件字段配置：约束保存到待应用变更，应用后由真实结构读取', async ({ page }) => {
  await page.goto('/data')
  await page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists').click()
  const collectionId = (page.url().split('/data/')[1] ?? '').split('/')[0]

  // 通过真实 API 建一个多文件字段并应用，作为画板 11 的起点。
  const added = await page.request.post(`/admin/api/v1/collections/${collectionId}/schema/pending-operations`, {
    data: { kind: 'field', action: 'add', definition: { name: 'attachments', type: 'files' } },
    headers: { Origin: new URL(page.url()).origin },
  })
  expect(added.status()).toBe(201)
  await page.goto(`/data/${collectionId}/schema`)
  await expect(page.getByText(/1 项结构变更待应用/)).toBeVisible()
  await page.getByRole('button', { name: '应用到结构' }).click()
  await expect(page.getByText('已应用，结构已更新')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'attachments' })).toBeVisible()

  await page.getByRole('button', { name: '配置文件' }).click()
  await expect(page).toHaveURL(/field=/)
  await expect(page.getByRole('heading', { name: '数据 · 文件字段配置' })).toBeVisible()
  await expect(page.getByText('数量限制')).toBeVisible()

  await page.getByLabel('数量限制').fill('3')
  await page.getByLabel('单文件大小（MB）').fill('5')
  await page.getByLabel('字段说明').fill('附于笔记的文件')
  await page.getByRole('button', { name: '保存配置' }).click()

  // 保存进入待应用变更，应用后才进入 Applied Model。
  await expect(page.getByText(/1 项结构变更待应用/)).toBeVisible()
  await expect(page.getByRole('button', { name: '应用到结构' })).toBeEnabled()
  await page.getByRole('button', { name: '应用到结构' }).click()
  await expect(page.getByText('已应用，结构已更新')).toBeVisible()
  // 等待待应用变更在真实后端消失，避免读到应用完成前的旧结构。
  await expect
    .poll(async () => {
      const response = await page.request.get(`/admin/api/v1/collections/${collectionId}/schema/pending-change`)
      const body = (await response.json()) as { data: unknown }
      return body.data === null
    }, { timeout: 15_000 })
    .toBe(true)

  const detail = await page.request.get(`/admin/api/v1/collections/${collectionId}`)
  expect(detail.status()).toBe(200)
  const payload = (await detail.json()) as { data: { fields: Array<{ name: string; validation?: Record<string, unknown> }> } }
  const attachments = payload.data.fields.find((field) => field.name === 'attachments')
  expect(attachments?.validation).toMatchObject({ maxBytes: 5 * 1024 * 1024, maxFiles: 3 })
  expect(attachments?.validation?.allowedMimeTypes).toContain('application/pdf')

  await page.reload()
  await expect(page.getByRole('cell', { name: 'attachments' })).toBeVisible()
})

test('删除集合确认：名称校验、真实级联删除与刷新后不可恢复', async ({ page }) => {
  await page.goto('/data')
  await page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists').click()
  await expect(page).toHaveURL(/\/data\/col_/)
  const collectionId = (page.url().split('/data/')[1] ?? '').split('/')[0]

  await page.getByRole('button', { name: '集合操作' }).click()
  await page.getByRole('menuitem', { name: '删除集合' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '永久删除 reading_lists？' })).toBeVisible()
  await expect(dialog.getByText(/影响资源/)).toBeVisible()
  await expect(dialog.getByText('一并删除')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '永久删除集合' })).toBeDisabled()

  const confirm = dialog.getByLabel('确认集合名称')
  await confirm.fill('wrong-name')
  await expect(dialog.getByRole('button', { name: '永久删除集合' })).toBeDisabled()
  await expect(dialog.getByText(/名称不匹配/)).toBeVisible()

  await confirm.fill('reading_lists')
  await expect(dialog.getByText(/名称匹配/)).toBeVisible()
  await dialog.getByRole('button', { name: '永久删除集合' }).click()

  await expect(page).toHaveURL(/\/data$/)
  await expect(page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists')).toHaveCount(0)

  // 真实 API：集合、记录和访问规则都返回 404，审计留下不可逆事实。
  const detail = await page.request.get(`/admin/api/v1/collections/${collectionId}`)
  expect(detail.status()).toBe(404)
  const records = await page.request.get(`/admin/api/v1/collections/${collectionId}/records`)
  expect(records.status()).toBe(404)
  const auditPage = await page.request.get('/admin/api/v1/audit?action=collection.deleted')
  expect(auditPage.status()).toBe(200)
  expect(await auditPage.text()).toContain(collectionId)

  await page.reload()
  await expect(page.getByRole('navigation', { name: '集合', exact: true }).getByText('reading_lists')).toHaveCount(0)
})
