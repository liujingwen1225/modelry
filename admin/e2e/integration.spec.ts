import { expect, test, type Page } from '@playwright/test'

/**
 * #50 跨界面联调：结构里的关联字段 → 记录里的关联值 → 访问规则的记录本人条件。
 *
 * 这条用例专门守住一个真实契约缺陷：后端 relation 使用
 * targetCollectionId + cardinality，前端曾误用 collectionId + multiple，
 * 导致从界面保存关联字段与关联记录值都会失败。
 */
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

test('关联字段：界面保存、真实结构、记录关联值与访问规则贯通', async ({ page }) => {
  await signIn(page)
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin }

  // 两个真实集合：认证集合 users 与普通集合 notes。
  const users = await page.request.post('/admin/api/v1/collections', {
    data: { name: 'users', type: 'Auth', fields: [{ name: 'displayName', type: 'text' }] },
    headers,
  })
  expect(users.status()).toBe(201)
  const usersId = ((await users.json()) as { data: { id: string } }).data.id

  const notes = await page.request.post('/admin/api/v1/collections', {
    data: {
      name: 'notes',
      type: 'Normal',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'text' },
      ],
    },
    headers,
  })
  expect(notes.status()).toBe(201)
  const notesId = ((await notes.json()) as { data: { id: string } }).data.id

  const firstUser = await page.request.post(`/admin/api/v1/collections/${usersId}/users`, {
    data: { profile: { email: 'lin@modelry.test', displayName: '林晓' }, password: 'app-user-password-42' },
    headers,
  })
  expect(firstUser.status()).toBe(201)
  const userId = ((await firstUser.json()) as { data: { id: string } }).data.id

  // 画板 4：在结构页用界面新增关联字段，保存为待应用变更再应用。
  await page.goto(`/data/${notesId}/schema`)
  await page.getByRole('button', { name: '添加字段' }).click()
  const drawer = page.getByRole('dialog')
  await drawer.getByLabel('字段名称').fill('author')

  // 类型下拉顺序固定：text/number/boolean/dateTime/json/file/files/relation。
  await drawer.getByRole('combobox').first().click()
  for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(drawer.getByText('关联到')).toBeVisible()

  // 关联到：项目里只有 users 可作为目标。
  await drawer.getByRole('combobox').nth(1).click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await drawer.getByRole('button', { name: '保存到待应用变更' }).click()

  await expect(page.getByText(/1 项结构变更待应用/)).toBeVisible()
  await page.getByRole('button', { name: '应用到结构' }).click()
  await expect(page.getByText('已应用，结构已更新')).toBeVisible()

  const detail = await page.request.get(`/admin/api/v1/collections/${notesId}`)
  const fields = ((await detail.json()) as {
    data: { fields: Array<{ name: string; type: string; relation?: { targetCollectionId: string; cardinality: string } }> }
  }).data.fields
  const author = fields.find((field) => field.name === 'author')
  expect(author?.type).toBe('relation')
  expect(author?.relation?.targetCollectionId).toBe(usersId)
  expect(author?.relation?.cardinality).toBe('many-to-one')

  // 画板 5：记录抽屉里的关联下拉必须列出目标集合的真实记录。
  await page.goto(`/data/${notesId}/records`)
  await page.getByRole('button', { name: '新增记录' }).click()
  const recordDrawer = page.getByRole('dialog')
  await recordDrawer.getByLabel('title').fill('周末徒步路线')
  const authorSelect = recordDrawer.getByLabel('author')
  await expect(authorSelect).toBeVisible()
  await authorSelect.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await recordDrawer.getByRole('button', { name: '创建记录' }).click()
  await expect(page.getByText('周末徒步路线').first()).toBeVisible()

  const records = await page.request.get(`/admin/api/v1/collections/${notesId}/records`)
  const rows = ((await records.json()) as { data: Array<{ title: string; author: string }> }).data
  expect(rows[0]?.title).toBe('周末徒步路线')
  expect(rows[0]?.author).toBe(userId)

  // 画板 26：访问规则页能读取同一集合的真实规则；刷新与深链接保持上下文。
  await page.goto('/access/rules')
  await expect(page.getByRole('heading', { name: '你的笔记，仍然只属于你' })).toBeVisible()
  const rules = await page.request.get(`/admin/api/v1/collections/${notesId}/access-rules`)
  expect(rules.status()).toBe(200)
  const ruleState = (await rules.json()) as { data: { applied: unknown[] } }
  expect(ruleState.data.applied).toHaveLength(5)

  await page.reload()
  await expect(page.getByRole('heading', { name: '你的笔记，仍然只属于你' })).toBeVisible()
})
