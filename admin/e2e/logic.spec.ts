import { expect, test, type Page } from '@playwright/test'

/** #46 验收：可视化规则编辑 → dry-run 测试 → 真实执行 → 执行记录 → 失败重试。 */
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

/** antd Select 虚拟列表不稳定，用键盘选择确定项。 */
async function chooseFirstOption(page: Page, comboboxIndex: number) {
  const select = page.getByRole('combobox').nth(comboboxIndex)
  await select.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}

test('可视化业务逻辑：编辑、测试、真实执行、执行记录与失败重试', async ({ page }) => {
  await signIn(page)
  const origin = new URL(page.url()).origin

  const created = await page.request.post('/admin/api/v1/collections', {
    data: {
      name: 'logic_notes',
      type: 'Normal',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'text' },
      ],
    },
    headers: { Origin: origin },
  })
  expect(created.status()).toBe(201)
  const collectionId = ((await created.json()) as { data: { id: string } }).data.id

  // 画板 25 / 17：从空列表进入可视化编辑器。
  await page.goto('/logic/rules')
  await expect(page.getByRole('button', { name: '新建业务逻辑' }).first()).toBeVisible()
  await page.getByRole('button', { name: '新建业务逻辑' }).first().click()
  await expect(page).toHaveURL(/new=1/)

  await page.getByPlaceholder('给这条业务逻辑起个名字').fill('注册后创建欢迎笔记')
  await chooseFirstOption(page, 0) // 触发集合（项目里只有一个真实集合）
  await chooseFirstOption(page, 2) // 目标集合
  await page.getByPlaceholder(/留空则不写入/).nth(0).fill('欢迎 {{user.displayName}}')
  await page.getByPlaceholder(/留空则不写入/).nth(1).fill('把想法留下来…')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page).toHaveURL(/rule=vlr_/)

  const rules = await page.request.get('/admin/api/v1/visual-rules')
  const ruleList = (await rules.json()) as { data: Array<{ id: string; name: string; values: Record<string, string> }> }
  const rule = ruleList.data.find((item) => item.name === '注册后创建欢迎笔记')
  expect(rule?.values.title).toBe('欢迎 {{user.displayName}}')

  // 画板 17：测试是 dry-run，绝不写业务数据。
  const testCard = page.locator('.mr-logic__test-card')
  await testCard.getByLabel('显示名 displayName').fill('林晓')
  await page.getByRole('button', { name: '重新测试' }).click()
  await expect(page.getByText('测试通过 · 模拟执行')).toBeVisible()
  const recordsAfterTest = await page.request.get(`/admin/api/v1/collections/${collectionId}/records`)
  expect(((await recordsAfterTest.json()) as { data: unknown[] }).data).toHaveLength(0)

  // 真实执行一次，写入一条真实 Record。
  const runPanel = page.locator('.mr-logic__run-panel')
  await runPanel.getByLabel('显示名 displayName').fill('林晓')
  await page.getByRole('button', { name: '执行一次' }).click()
  await expect(page.getByText(/执行成功 · 已在目标集合创建记录/)).toBeVisible()
  const recordsAfterRun = await page.request.get(`/admin/api/v1/collections/${collectionId}/records`)
  const rows = ((await recordsAfterRun.json()) as { data: Array<{ title: string }> }).data
  expect(rows).toHaveLength(1)
  expect(rows[0]?.title).toBe('欢迎 林晓')

  // 画板 18：执行记录持久化，含测试记录与真实执行记录。
  await page.goto(`/logic/runs?rule=${encodeURIComponent(rule!.id)}`)
  await expect(page.getByText('执行记录').first()).toBeVisible()
  const runsResponse = await page.request.get(`/admin/api/v1/visual-rules/${rule!.id}/runs`)
  const runs = ((await runsResponse.json()) as { data: Array<{ kind: string; status: string; recordId: string }> }).data
  expect(runs.some((run) => run.kind === 'test')).toBe(true)
  expect(runs.some((run) => run.kind === 'live' && run.status === 'succeeded' && run.recordId)).toBe(true)

  // 制造一次真实失败（模板占位符不受支持），再从界面重试并验证 attemptOf 关联。
  const broken = await page.request.put(`/admin/api/v1/visual-rules/${rule!.id}`, {
    data: {
      name: rule!.name,
      triggerCollectionId: collectionId,
      triggerEvent: 'record.created',
      targetCollectionId: collectionId,
      values: { title: '{{user.unknown}}', content: '把想法留下来…' },
    },
    headers: { Origin: origin },
  })
  expect(broken.status()).toBe(200)
  const failedRun = await page.request.post(`/admin/api/v1/visual-rules/${rule!.id}/run`, {
    data: { user: { displayName: '林晓' } },
    headers: { Origin: origin },
  })
  expect(failedRun.status()).toBe(202)
  const failed = ((await failedRun.json()) as { data: { status: string; errorCode: string } }).data
  expect(failed.status).toBe('failed')

  await page.reload()
  await expect(page.getByRole('button', { name: '重试' }).first()).toBeVisible()
  await page.getByRole('button', { name: '重试' }).first().click()
  await page.getByRole('button', { name: '确认重试本次' }).click()
  await expect(page.getByText(/已新增一条重试执行记录/)).toBeVisible()
  const finalRuns = await page.request.get(`/admin/api/v1/visual-rules/${rule!.id}/runs`)
  const finalList = ((await finalRuns.json()) as { data: Array<{ attemptOf: string }> }).data
  expect(finalList.some((run) => run.attemptOf)).toBe(true)
})
