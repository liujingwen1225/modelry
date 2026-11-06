import { expect, test, type Page } from '@playwright/test'

/** #49 验收：基本设置持久化、运行时设置保存、状态与错误反馈。 */
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

test('本地项目设置：基本设置与运行时设置都真实持久化', async ({ page }) => {
  await signIn(page)
  const origin = new URL(page.url()).origin

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  await expect(page.getByLabel('项目名称')).toBeVisible()
  await expect(page.getByLabel('项目说明')).toBeVisible()

  // 画板 22「基本设置」：真实写入 /project-preferences。
  await page.getByLabel('项目名称').fill('拾光笔记')
  await page.getByLabel('项目说明').fill('一个本地优先的笔记后端')
  await page.getByLabel('显示操作后的保存反馈').click()
  await page.getByRole('button', { name: '保存设置' }).click()

  // 项目名称必须贯通到全局导航与面包屑，不只是设置页里的一个输入框。
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText('拾光笔记')).toBeVisible()

  const prefs = await page.request.get('/admin/api/v1/project-preferences')
  expect(prefs.status()).toBe(200)
  const prefsBody = (await prefs.json()) as {
    data: { projectName: string; projectDescription: string; saveFeedback: boolean; revision: number }
  }
  expect(prefsBody.data.projectName).toBe('拾光笔记')
  expect(prefsBody.data.projectDescription).toBe('一个本地优先的笔记后端')
  expect(prefsBody.data.saveFeedback).toBe(false)
  expect(prefsBody.data.revision).toBe(2)

  await page.reload()
  await expect(page.getByLabel('项目名称')).toHaveValue('拾光笔记')

  // 版本冲突有真实恢复路径：用旧 revision 提交应得到 409，页面不伪造成功。
  const stale = await page.request.put('/admin/api/v1/project-preferences', {
    data: {
      expectedRevision: 1,
      projectName: '冲突值',
      projectDescription: '',
      locale: 'zh-CN',
      appearance: 'light',
      saveFeedback: true,
    },
    headers: { Origin: origin },
  })
  expect(stale.status()).toBe(409)

  // 画板 22「本地运行与存储」：真实 runtime/storage 状态与 /settings 可编辑项。
  await page.locator('.ant-segmented-item').filter({ hasText: '本地运行与存储' }).click()
  await expect(page.getByLabel('监听地址')).toBeVisible()
  await expect(page.getByLabel('请求保留天数')).toBeVisible()
  await expect(page.getByText('本地运行与存储').first()).toBeVisible()

  await page.getByLabel('请求保留天数').fill('15')
  await page.getByRole('button', { name: '保存设置' }).click()
  const runtimeSettings = await page.request.get('/admin/api/v1/settings')
  const settingsBody = (await runtimeSettings.json()) as { data: { requestRetentionDays: { value: string | number } } }
  expect(String(settingsBody.data.requestRetentionDays.value)).toBe('15')

  await page.reload()
  await page.locator('.ant-segmented-item').filter({ hasText: '本地运行与存储' }).click()
  await expect(page.getByLabel('请求保留天数')).toHaveValue('15')
})
