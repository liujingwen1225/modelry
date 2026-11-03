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
