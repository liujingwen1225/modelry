import { expect, test } from '@playwright/test'

/**
 * 认证集合作为用户功能主体（0011 第 8 节）与集合级访问规则的真实浏览器验收。
 * 独立「用户与访问」一级页已取消，/access 只作为旧链接重定向壳。
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

test('认证集合是用户功能主体：五标签、旧链接重定向、普通集合四标签', async ({ page }) => {
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin }

  const auth = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'members', type: 'Auth', fields: [{ name: 'displayName', type: 'text' }] },
    headers,
  })
  expect(auth.status()).toBe(201)
  const authId = ((await auth.json()) as { data: { id: string } }).data.id

  const normal = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'notes_ia', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] },
    headers,
  })
  expect(normal.status()).toBe(201)
  const normalId = ((await normal.json()) as { data: { id: string } }).data.id

  const user = await page.request.post(`/admin/api/v1/collections/${authId}/users`, {
    data: { profile: { email: 'lin@modelry.test', displayName: '林晓' }, password: 'app-user-password-42' },
    headers,
  })
  expect(user.status()).toBe(201)

  // 主导航不再有独立一级页。
  await page.goto('/data')
  await expect(page.getByRole('navigation', { name: '主导航' })).not.toContainText('用户与访问')

  // 认证集合默认落在「用户」，五个标签齐备且没有普通集合的「记录」标签。
  await page.goto(`/data/${authId}`)
  const authTabs = page.getByRole('navigation', { name: '集合工作面' })
  await expect(authTabs).toContainText('用户')
  await expect(authTabs).toContainText('认证')
  await expect(authTabs).toContainText('结构')
  await expect(authTabs).toContainText('访问规则')
  await expect(authTabs).toContainText('API')
  await expect(authTabs).not.toContainText('记录')
  await expect(page.getByRole('button', { name: '添加用户' })).toBeVisible()
  await expect(page.getByText('lin@modelry.test').first()).toBeVisible()

  // 用户表单按集合真实字段生成：members 的档案字段是 displayName，不是硬编码的 name。
  await authTabs.getByRole('button', { name: '用户' }).click()
  await page.getByRole('button', { name: '添加用户' }).click()
  const userDialog = page.getByRole('dialog')
  await expect(userDialog.getByLabel('displayName')).toBeVisible()
  await userDialog.getByLabel('邮箱').fill('ui@modelry.test')
  await userDialog.getByLabel('displayName').fill('界面创建')
  await userDialog.getByLabel('初始密码').fill('ui-password-42')
  await userDialog.getByRole('button', { name: '创建用户' }).click()
  await expect(page.getByText('ui@modelry.test').first()).toBeVisible()

  // 认证配置归位到集合页：真实保存 → 应用，配置无变化时不能误调 apply 得到 404。
  await authTabs.getByRole('button', { name: '认证' }).click()
  await expect(page.getByText('邮箱密码登录', { exact: true })).toBeVisible()
  await page.locator('.mr-auth-config__row').filter({ hasText: '允许自助注册' }).getByRole('switch').click()
  await page.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.getByText('已应用到认证配置')).toBeVisible()
  const configState = await page.request.get(`/admin/api/v1/collections/${authId}/authentication`, {
    headers: { Origin: origin },
  })
  expect(((await configState.json()) as { data: { applied: { selfRegistration: boolean } } }).data.applied.selfRegistration).toBe(true)
  await page.getByRole('button', { name: '保存并应用' }).click()
  await expect(page.getByText('配置没有变化，当前已应用版本即为最新')).toBeVisible()

  // 普通集合保持四个标签，不出现用户 / 认证。
  await page.goto(`/data/${normalId}`)
  const normalTabs = page.getByRole('navigation', { name: '集合工作面' })
  await expect(normalTabs).toContainText('记录')
  await expect(normalTabs).not.toContainText('用户')
  await expect(normalTabs).not.toContainText('认证')

  // 旧链接全部重定向到认证集合对应标签，刷新可用。
  await page.goto('/access')
  await expect(page).toHaveURL(new RegExp(`/data/${authId}/users$`))
  await page.goto('/access/users')
  await expect(page).toHaveURL(new RegExp(`/data/${authId}/users$`))
  await page.goto('/access/auth')
  await expect(page).toHaveURL(new RegExp(`/data/${authId}/auth$`))
  await page.goto('/access/rules')
  await expect(page).toHaveURL(new RegExp(`/data/${authId}/access$`))
  await page.goto(`/access/rules?collectionId=${normalId}`)
  await expect(page).toHaveURL(new RegExp(`/data/${normalId}/access$`))

  // 认证集合的旧 /records 深链接回落到用户页。
  await page.goto(`/data/${authId}/records`)
  await expect(page).toHaveURL(new RegExp(`/data/${authId}/users$`))
})

test('集合页访问规则：真实读取、编辑保存、应用与模拟验证', async ({ page }) => {
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

  // 规则入口是集合页的就地标签，固定作用于当前集合，没有集合选择器。
  await page.goto(`/data/${collectionId}/access`)
  await expect(page.getByRole('heading', { name: '你的笔记，仍然只属于你' })).toBeVisible()
  await expect(page.locator('.mr-rules__collection-select')).toHaveCount(0)
  await expect(page.locator('.mr-rules__current-collection')).toContainText('notes_rules')
  await expect(page.getByText('禁止访问').first()).toBeVisible()
  await expect(page.getByText('已生效', { exact: true })).toBeVisible()

  // 编辑 → 保存为待应用变更 → 应用，全程走真实 access-rules 契约。
  await page.getByRole('button', { name: '编辑规则' }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('编辑访问规则 · notes_rules')).toBeVisible()
  await drawer.getByRole('combobox').first().click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await drawer.getByRole('button', { name: '保存到待应用变更' }).click()

  await expect(page.getByText(/访问规则方案待审阅/)).toBeVisible()
  await expect(page.getByRole('button', { name: '应用', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.getByText('任何人').first()).toBeVisible()

  // 模拟验证使用真实记录与真实 identity；集合有记录时默认选中第一条，无需手动选择。
  await expect(page.getByRole('button', { name: '验证访问' })).toBeEnabled({ timeout: 15_000 })
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
