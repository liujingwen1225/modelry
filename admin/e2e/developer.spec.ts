import { expect, test, type Page } from '@playwright/test'

/** #45 验收：API 文档、请求日志、真实请求排错与 Secrets 生命周期。 */
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

test('开发与连接：真实契约、请求日志、失败排错与 Secrets', async ({ page }) => {
  await signIn(page)
  const origin = new URL(page.url()).origin

  // 真实集合 + 一次真实应用请求（默认拒绝匿名访问，会留下 403 RequestRecord）。
  const created = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'dev_notes', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] },
    headers: { Origin: origin },
  })
  expect(created.status()).toBe(201)
  const denied = await page.request.get('/api/v1/dev_notes')
  expect(denied.status()).toBe(403)

  // 画板 13：API 文档来自真实 /developer/contract。
  await page.goto('/developer/api')
  await expect(page.getByRole('heading', { name: '开发与连接' })).toBeVisible()
  await expect(page.getByText('dev_notes').first()).toBeVisible()
  await expect(page.getByText('/api/v1/dev_notes').first()).toBeVisible()
  await expect(page.getByText(/cURL/).first()).toBeVisible()

  // 画板 14：请求日志必须读到刚才那次真实请求。
  await page.goto('/developer/logs')
  await expect(page.getByRole('table')).toBeVisible()
  // 后端把应用端点脱敏记成路由模板，日志必须如实展示这个真实值。
  await expect(page.getByText('/api/v1/{collectionName}').first()).toBeVisible()
  const list = await page.request.get('/admin/api/v1/requests?limit=20')
  expect(list.status()).toBe(200)
  const records = (await list.json()) as { data: Array<{ requestId: string; endpoint: string; status: number }> }
  const failed = records.data.find((record) => record.status === 403 && record.endpoint.includes('collectionName'))
  expect(failed).toBeTruthy()

  // 画板 15：从日志进入排错，重新发起的请求必须是真实 HTTP 请求。
  await page.getByRole('button', { name: '排错验证' }).first().click()
  await expect(page).toHaveURL(/requestId=/)
  await expect(page.getByRole('heading', { name: '给请求补上正确的身份' })).toBeVisible()
  await expect(page.getByText(failed!.requestId).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '重新发起请求' })).toBeEnabled()
  await page.getByRole('button', { name: '重新发起请求' }).click()
  await expect(page.locator('.mr-dev-result')).toBeVisible()
  await expect(page.locator('.mr-dev-result')).toContainText('结论：')
  const resultText = await page.locator('.mr-dev-result').innerText()
  expect(resultText).toMatch(/req_/)
  expect(resultText).toMatch(/HTTP 状态/)

  // 画板 16：Secrets 只写不回显，改名 / 改值 / 删除都走真实 API。
  await page.goto('/developer/secrets')
  await expect(page.getByRole('button', { name: '新增 Secret' }).first()).toBeVisible()
  await page.getByRole('button', { name: '新增 Secret' }).first().click()
  let drawer = page.getByRole('dialog')
  await drawer.getByPlaceholder('输入 Secret 名称').fill('MAIL_TOKEN')
  await drawer.locator('input[type="password"]').fill('local-secret-value-42')
  await drawer.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('MAIL_TOKEN').first()).toBeVisible()

  const secretList = await page.request.get('/admin/api/v1/secrets')
  const secretBody = (await secretList.json()) as { data: Array<{ id: string; name: string; configured: boolean }> }
  const secret = secretBody.data.find((item) => item.name === 'MAIL_TOKEN')
  expect(secret?.configured).toBe(true)
  expect(JSON.stringify(secretBody)).not.toContain('local-secret-value-42')

  await page.getByRole('button', { name: '改名' }).click()
  drawer = page.getByRole('dialog')
  await drawer.getByPlaceholder('输入 Secret 名称').fill('MAIL_TOKEN_V2')
  await drawer.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('MAIL_TOKEN_V2').first()).toBeVisible()

  await page.getByRole('button', { name: '改值' }).click()
  drawer = page.getByRole('dialog')
  await drawer.locator('input[type="password"]').fill('rotated-secret-value-42')
  await drawer.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: '删除' }).click()
  await page.getByRole('button', { name: '删除', exact: true }).last().click()
  await expect(page.getByText('MAIL_TOKEN_V2')).toHaveCount(0)
  const afterDelete = await page.request.get('/admin/api/v1/secrets')
  expect(JSON.stringify(await afterDelete.json())).not.toContain(secret!.id)
})
