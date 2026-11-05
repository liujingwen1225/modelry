import { expect, test, type Page } from '@playwright/test'

/** #48 验收：需求理解 → 真实待审阅方案 → 应用 → 验证 → 公开分享与失效边界。 */
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

test('AI 协作：真实方案、变更生命周期、验证与公开分享边界', async ({ page, browser }) => {
  await signIn(page)
  const origin = new URL(page.url()).origin

  const created = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'ai_notes', type: 'Normal', fields: [{ name: 'title', type: 'text', required: true }] },
    headers: { Origin: origin },
  })
  expect(created.status()).toBe(201)
  const collectionId = ((await created.json()) as { data: { id: string } }).data.id

  // 需求输入：页面明确标注「规则化理解，非大模型生成」，不伪造 AI 输出。
  await page.goto('/ai')
  await page.getByRole('button', { name: '新建需求' }).first().click()
  await page.getByPlaceholder('例如：给笔记增加公开分享能力').fill('给笔记增加公开分享能力，只放开公开笔记的读取')
  const collectionSelect = page.getByRole('combobox').first()
  await collectionSelect.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '提交需求' }).click()
  await expect(page.getByText('规则化理解，非大模型生成').first()).toBeVisible()
  await expect(page.getByText('ai_notes').first()).toBeVisible()

  const proposals = await page.request.get('/admin/api/v1/ai/proposals')
  const proposalList = ((await proposals.json()) as { data: Array<{ id: string; status: string; changeSetId: string }> }).data
  const proposalId = proposalList[0]?.id
  expect(proposalId).toBeTruthy()
  expect(proposalList[0]?.status).toBe('draft')

  // 生成方案必须创建一条真实待应用变更，不直接写结构。
  await page.getByText('方案与影响').first().click()
  await expect(page.getByRole('button', { name: '生成方案' })).toBeVisible()
  await page.getByRole('button', { name: '生成方案' }).click()
  await expect(page.getByText(/待审阅变更已生成，尚未写入结构/)).toBeVisible()
  const pending = await page.request.get(`/admin/api/v1/collections/${collectionId}/schema/pending-change`)
  const pendingBody = (await pending.json()) as { data: { changeSetId: string } | null }
  expect(pendingBody.data?.changeSetId).toBeTruthy()
  const beforeApply = await page.request.get(`/admin/api/v1/collections/${collectionId}`)
  expect(JSON.stringify(await beforeApply.json())).not.toContain('is_public')

  // 应用走真实 schema apply；review 风险需要显式确认。
  await page.getByRole('button', { name: '应用到结构' }).click()
  const confirm = page.getByRole('button', { name: '确认应用' })
  if (await confirm.count()) await confirm.click()
  await expect(page.getByText(/已沿真实 schema apply 写入结构/)).toBeVisible()

  const afterApply = await page.request.get(`/admin/api/v1/collections/${collectionId}`)
  const appliedFields = ((await afterApply.json()) as { data: { fields: Array<{ name: string }> } }).data.fields
  expect(appliedFields.some((field) => field.name === 'is_public')).toBe(true)

  // 验证读取真实 Applied Model，结论来自后端 checks。
  await page.locator('.mr-ai__view button').filter({ hasText: /^验证$/ }).click()
  await expect(page.getByText('验证结论').first()).toBeVisible()

  // 公开分享：UI 创建真实链接，匿名上下文只读可见；撤销后统一失效。
  await page.getByText('公开分享').first().click()
  await expect(page.getByRole('button', { name: '创建分享链接' })).toBeVisible()
  await page.getByRole('button', { name: '创建分享链接' }).click()
  await expect(page.getByText('新创建的链接')).toBeVisible()
  const createdBlock = await page.locator('.mr-ai__created').innerText()
  const sharePath = createdBlock.match(/\/ai\/share\/[A-Za-z0-9_-]+/)?.[0]
  expect(sharePath).toBeTruthy()

  const anonymous = await browser.newContext({ baseURL: origin, locale: 'zh-CN' })
  const publicPage = await anonymous.newPage()
  await publicPage.goto(sharePath!)
  await expect(publicPage.getByText('只读').first()).toBeVisible()
  await expect(publicPage.getByText('ai_notes').first()).toBeVisible()
  await expect(publicPage.getByRole('navigation', { name: '主导航' })).toHaveCount(0)
  await anonymous.close()

  // 撤销后公开页统一显示「链接不可用或已失效」，不泄漏原因差异。
  const shares = await page.request.get(`/admin/api/v1/ai/proposals/${proposalId}/shares`)
  const shareList = ((await shares.json()) as { data: Array<{ id: string }> }).data
  expect(shareList.length).toBeGreaterThan(0)
  const revoked = await page.request.delete(`/admin/api/v1/ai/shares/${encodeURIComponent(shareList[0]!.id)}`, {
    headers: { Origin: origin },
  })
  expect(revoked.status()).toBe(204)

  const anonymousAfter = await browser.newContext({ baseURL: origin, locale: 'zh-CN' })
  const expiredPage = await anonymousAfter.newPage()
  await expiredPage.goto(sharePath!)
  await expect(expiredPage.getByText('链接不可用或已失效')).toBeVisible()
  await anonymousAfter.close()
})
