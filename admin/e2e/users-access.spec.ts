import { expect, test } from '@playwright/test'

/** #44 验收：应用用户来自认证集合的真实记录，认证配置可保存并应用。 */
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

test('用户与访问：没有认证集合时给出真实创建入口', async ({ page }) => {
  await page.goto('/access')
  await expect(page.getByRole('heading', { name: '用户与访问' })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建认证集合' })).toBeVisible()
})

test('访问规则：真实读取、编辑保存、应用与模拟验证', async ({ page }) => {
  await page.goto('/access/rules')
  await expect(page.getByRole('heading', { name: '用户与访问' })).toBeVisible()

  // 通过真实 API 准备一个带记录的普通集合，验证规则不依赖认证集合。
  const origin = new URL(page.url()).origin
  const created = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'notes_rules', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] },
    headers: { Origin: origin },
  })
  expect(created.status()).toBe(201)
  const collectionId = ((await created.json()) as { data: { id: string } }).data.id
  const record = await page.request.post(`/admin/api/v1/collections/${collectionId}/records`, {
    data: { values: { title: '周末徒步路线' } },
    headers: { Origin: origin },
  })
  expect(record.status()).toBe(201)

  await page.reload()
  await expect(page.getByRole('heading', { name: '你的笔记，仍然只属于你' })).toBeVisible()
  await expect(page.getByText('禁止访问').first()).toBeVisible()
  await expect(page.getByText('已生效', { exact: true })).toBeVisible()

  // 编辑 → 保存为待应用变更 → 应用，全程走真实 access-rules 契约。
  await page.getByRole('button', { name: '编辑规则' }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('编辑访问规则 · notes_rules')).toBeVisible()
  // 规则模式顺序为 noAccess → anyone → …；用键盘选择第二项，避免依赖虚拟列表的浮层定位。
  await drawer.getByRole('combobox').first().click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await drawer.getByRole('button', { name: '保存到待应用变更' }).click()

  await expect(page.getByText(/访问规则方案待审阅/)).toBeVisible()
  await expect(page.getByRole('button', { name: '应用', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.getByText('任何人').first()).toBeVisible()

  // 模拟验证使用真实记录与真实 identity，结果来自后端 simulate。
  const recordSelect = page.locator('.mr-rules__verify').getByRole('combobox').first()
  await recordSelect.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '验证访问' })).toBeEnabled()
  await page.getByRole('button', { name: '验证访问' }).click()
  await expect(page.locator('.mr-rules__result')).toBeVisible()
  await expect(page.locator('.mr-rules__result')).toContainText(/允许访问|拒绝访问/)

  const state = await page.request.get(`/admin/api/v1/collections/${collectionId}/access-rules`)
  expect(state.status()).toBe(200)
  const body = (await state.json()) as { data: { applied: Array<{ operation: string; mode: string }> } }
  expect(body.data.applied.find((rule) => rule.operation === 'list')?.mode).toBe('anyone')

  await page.reload()
  await expect(page.getByText('任何人').first()).toBeVisible()
})
