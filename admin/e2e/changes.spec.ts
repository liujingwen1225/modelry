import { expect, test, type Page } from '@playwright/test'

/** #47 验收：待审阅变更 → 差异/风险 → 应用 → 历史，全部来自真实后端状态。 */
const OWNER = { email: 'owner@modelry.test', password: 'local-admin-password-42' }

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
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
}

test('变更中心：真实待审阅、差异、应用与历史', async ({ page }) => {
  await signIn(page)
  const origin = new URL(page.url()).origin

  const created = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'change_notes', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] },
    headers: { Origin: origin },
  })
  expect(created.status()).toBe(201)
  const collectionId = ((await created.json()) as { data: { id: string } }).data.id

  // 真实待应用变更：先保存一条结构草案，不直接改结构。
  const draft = await page.request.post(`/admin/api/v1/collections/${collectionId}/schema/pending-operations`, {
    data: { kind: 'field', action: 'add', definition: { name: 'slug', type: 'text' } },
    headers: { Origin: origin },
  })
  expect(draft.status()).toBe(201)
  const changeSetId = ((await draft.json()) as { data: { changeSetId: string } }).data.changeSetId

  await page.goto('/changes')
  await expect(page.getByRole('heading', { name: '变更中心' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /待审阅 · 1/ })).toBeVisible()
  await expect(page.getByText('change_notes').first()).toBeVisible()

  // 深链接直接打开真实变更详情，差异与风险来自后端 preview。
  await page.goto(`/changes/pending?changeSet=${encodeURIComponent(changeSetId)}`)
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('变更集 · ' + changeSetId)).toBeVisible()
  await expect(drawer.getByText('操作清单')).toBeVisible()
  await drawer.getByText('风险与影响').click()
  await expect(drawer.getByText('影响范围')).toBeVisible()
  await expect(drawer.getByRole('button', { name: '应用到结构' })).toBeEnabled()
  await drawer.getByRole('button', { name: '应用到结构' }).click()

  // 应用后待审阅消失，真实结构里出现字段。
  await expect(page.getByRole('tab', { name: /待审阅 · 0/ })).toBeVisible()
  const detail = await page.request.get(`/admin/api/v1/collections/${collectionId}`)
  const fields = ((await detail.json()) as { data: { fields: Array<{ name: string }> } }).data.fields
  expect(fields.some((field) => field.name === 'slug')).toBe(true)

  // 历史标签读取真实的 AppliedMigration。
  await page.getByRole('tab', { name: /历史 ·/ }).click()
  await expect(page.getByText('最近历史')).toBeVisible()
  const history = await page.request.get(`/admin/api/v1/collections/${collectionId}/schema/history`)
  expect(history.status()).toBe(200)
  expect(JSON.stringify(await history.json())).toContain(changeSetId)

  await page.reload()
  await expect(page.getByRole('tab', { name: /历史 ·/ })).toBeVisible()
})
