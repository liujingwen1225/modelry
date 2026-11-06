import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from '@playwright/test'

/**
 * #50 最终视觉验收证据采集。
 *
 * 在独立临时空项目里编译并启动真实单二进制，用真实 Admin API 播种业务数据，
 * 然后用 1512×1000 视口按 Figma 画板逐页截图到 docs/evidence/frontend/final/。
 * 它只记录证据，不产生通过/失败结论；业务验收由各 spec 负责。
 */
const repoRoot = resolve(import.meta.dirname, '..', '..')
const workspaceRoot = resolve(repoRoot, 'admin')
const evidenceDir = resolve(repoRoot, 'docs', 'evidence', 'frontend', 'final')

const REQUEST_HEADERS = (origin) => ({ 'Content-Type': 'application/json', Origin: origin })

function log(message) {
  process.stdout.write(`[capture] ${message}\n`)
}

function waitForReady(child) {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = ''
    const timer = setTimeout(() => rejectReady(new Error('Runtime did not report READY in 60s')), 60_000)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((entry) => entry.startsWith('READY '))
      if (!line) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      try {
        resolveReady(JSON.parse(line.slice('READY '.length)))
      } catch (error) {
        rejectReady(error)
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`Runtime exited before READY (${code})`))
    })
  })
}

async function runCommand(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${code}`)
}

async function main() {
  await mkdir(evidenceDir, { recursive: true })
  const workDir = await mkdtemp(join(tmpdir(), 'modelry-capture-'))
  const projectDir = join(workDir, 'project')
  const binaryPath = join(workDir, 'modelry')
  await mkdir(projectDir, { recursive: true })

  let runtime
  let browser
  const captured = []
  const failures = []
  const consoleErrors = []
  const httpErrors = []

  try {
    log('building Admin bundle + Go single binary')
    await runCommand('npm', ['run', 'build'], workspaceRoot)
    await runCommand('go', ['build', '-o', binaryPath, './cmd/modelry'], repoRoot)

    log('starting isolated runtime')
    runtime = spawn(binaryPath, ['start', '--project-root', projectDir], { stdio: ['ignore', 'pipe', 'inherit'] })
    const ready = await waitForReady(runtime)
    const origin = new URL(ready.url).origin
    log(`runtime ready at ${origin}`)

    browser = await chromium.launch()
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1512, height: 1000 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    page.on('response', (response) => {
      if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() })
    })

    // 首次运行：真实建立 Owner。
    await page.goto('/')
    await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByLabel('邮箱').fill('owner@modelry.test')
    await page.getByLabel('密码', { exact: true }).fill('local-admin-password-42')
    await page.getByLabel('确认密码').fill('local-admin-password-42')
    await page.getByRole('button', { name: '创建并进入' }).click()
    await page.getByRole('navigation', { name: '主导航' }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(300)
    // 显式带上真实会话 Cookie，避免 APIRequestContext 与浏览器上下文之间的时序差异。
    const sessionCookies = (await context.storageState()).cookies
    const cookieHeader = sessionCookies.map((item) => `${item.name}=${item.value}`).join('; ')
    log(`owner session established (${sessionCookies.length} cookies)`)

    const capture = async (route, filename, anonymous = false) => {
      try {
        let target = page
        if (anonymous) {
          const anonymousContext = await browser.newContext({
            baseURL: origin, viewport: { width: 1512, height: 1000 }, locale: 'zh-CN',
          })
          target = await anonymousContext.newPage()
        }
        await target.goto(`${origin}${route}`, { waitUntil: 'networkidle' })
        await target.waitForTimeout(450)
        await target.screenshot({ path: join(evidenceDir, filename), fullPage: false })
        if (anonymous) await target.context().close()
        captured.push({ route, filename })
        log(`captured ${filename} <- ${route}`)
      } catch (error) {
        failures.push({ route, filename, reason: String(error) })
        log(`FAILED ${filename}: ${String(error).slice(0, 160)}`)
      }
    }

    // 画板 1：首次进入 · 空项目（播种之前）。
    await capture('/', '01-empty-project.png')

    const api = async (method, path, body) => {
      const response = await page.request.fetch(`${origin}${path}`, {
        method,
        headers: { ...REQUEST_HEADERS(origin), ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
        data: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = text
      }
      if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()} ${text.slice(0, 200)}`)
      return payload
    }

    // 真实播种：认证集合、笔记集合、标签集合、记录、应用用户。
    const users = (await api('POST', '/admin/api/v1/collections', {
      name: 'users',
      type: 'Auth',
      fields: [{ name: 'displayName', type: 'text' }],
    })).data
    const notes = (await api('POST', '/admin/api/v1/collections', {
      name: 'notes',
      type: 'Normal',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'text' },
        { name: 'owner', type: 'relation', relation: { targetCollectionId: users.id, cardinality: 'many-to-one' } },
      ],
    })).data
    const tags = (await api('POST', '/admin/api/v1/collections', {
      name: 'tags', type: 'Normal', fields: [{ name: 'name', type: 'text', required: true }],
    })).data

    // 文件字段（画板 11/12）：经待应用变更真实应用。
    const attachmentsOp = await api('POST', `/admin/api/v1/collections/${notes.id}/schema/pending-operations`, {
      kind: 'field', action: 'add', definition: { name: 'attachments', type: 'files' },
    })
    const preview = (await api('POST', `/admin/api/v1/collections/${notes.id}/schema/preview`, {
      expectedVersion: attachmentsOp.data.version,
    })).data
    await api('POST', `/admin/api/v1/collections/${notes.id}/schema/apply`, {
      expectedVersion: attachmentsOp.data.version, confirmRisk: preview.risk === 'review',
    })
    const notesDetail = (await api('GET', `/admin/api/v1/collections/${notes.id}`)).data
    const attachmentsField = notesDetail.fields.find((field) => field.name === 'attachments')
    const ownerField = notesDetail.fields.find((field) => field.name === 'owner')

    const userRecords = []
    for (const [email, displayName] of [
      ['lin@modelry.test', '林晓'],
      ['chen@modelry.test', '陈舟'],
    ]) {
      const created = (await api('POST', `/admin/api/v1/collections/${users.id}/users`, {
        profile: { email, displayName }, password: 'app-user-password-42',
      })).data
      userRecords.push(created)
    }
    const linId = userRecords[0]?.id ?? userRecords[0]?.recordId ?? ''
    for (const [title, content] of [
      ['周末徒步路线', '沿山脊走到湖边，再原路返回。'],
      ['读书笔记', '把想法留下来。'],
      ['公开分享的笔记', '这条笔记之后会支持公开。'],
    ]) {
      await api('POST', `/admin/api/v1/collections/${notes.id}/records`, {
        values: { title, content, ...(linId ? { owner: linId } : {}) },
      })
    }
    for (const name of ['徒步', '读书', '拾光', '随笔', '周末']) {
      await api('POST', `/admin/api/v1/collections/${tags.id}/records`, { values: { name } })
    }

    // 访问规则：真实保存并应用，让画板 26 有当前生效规则。
    const rulesState = (await api('GET', `/admin/api/v1/collections/${notes.id}/access-rules`)).data
    try {
      const savedRules = await api('PUT', `/admin/api/v1/collections/${notes.id}/access-rules`, {
        expectedVersion: rulesState.version,
        rules: [
          { operation: 'list', mode: 'recordOwner', ownerFieldId: ownerField?.id },
          { operation: 'view', mode: 'recordOwner', ownerFieldId: ownerField?.id },
          { operation: 'create', mode: 'signedInUsers' },
          { operation: 'update', mode: 'signedInUsers' },
          { operation: 'delete', mode: 'noAccess' },
        ],
      })
      await api('POST', `/admin/api/v1/collections/${notes.id}/access-rules/apply`, {
        expectedVersion: savedRules.data.version,
      })
    } catch (error) {
      log(`access rules seed skipped: ${String(error).slice(0, 180)}`)
    }

    // 开发与连接：Secret、一次真实应用请求、一条可视化规则与执行记录。
    await api('POST', '/admin/api/v1/secrets', { name: 'MAIL_TOKEN', value: 'capture-only-secret' })
    // 用不带会话的匿名上下文发起真实应用请求，留下一条真实的 403 RequestRecord。
    const anonymousRequestContext = await browser.newContext({ baseURL: origin })
    const denied = await anonymousRequestContext.request.get(`${origin}/api/v1/tags`)
    // 再发一条必然失败的单记录读取，保证日志里一定有可排错的 4xx 事实。
    await anonymousRequestContext.request.get(`${origin}/api/v1/tags/rec_does_not_exist`)
    await anonymousRequestContext.close()
    const requestPage = (await api('GET', '/admin/api/v1/requests?limit=20')).data
    const failedRequest = (Array.isArray(requestPage) ? requestPage : requestPage?.data ?? []).find(
      (item) => item.status >= 400,
    )
    const visualRule = (await api('POST', '/admin/api/v1/visual-rules', {
      name: '注册后创建欢迎笔记',
      triggerCollectionId: users.id,
      triggerEvent: 'record.created',
      targetCollectionId: notes.id,
      values: { title: '欢迎 {{user.displayName}}', content: '把想法留下来…' },
    })).data
    await api('POST', `/admin/api/v1/visual-rules/${visualRule.id}/test`, { user: { displayName: '林晓' } })
    await api('POST', `/admin/api/v1/visual-rules/${visualRule.id}/run`, { user: { displayName: '林晓' } })

    // 变更中心：一条真实待审阅变更（放在 tags 上，不与 AI 方案冲突）。
    await api('POST', `/admin/api/v1/collections/${tags.id}/schema/pending-operations`, {
      kind: 'field', action: 'add', definition: { name: 'color', type: 'text' },
    })

    // AI 协作：需求 → 方案 → 应用 → 验证 → 公开分享。
    const proposal = (await api('POST', '/admin/api/v1/ai/proposals', {
      requirement: '给笔记增加公开分享能力，只放开公开笔记的读取',
      collectionId: notes.id,
      fieldName: 'is_public',
    })).data
    await api('POST', `/admin/api/v1/ai/proposals/${proposal.id}/plan`, {})
    try {
      await api('POST', `/admin/api/v1/ai/proposals/${proposal.id}/apply`, { confirmRisk: true })
      await api('POST', `/admin/api/v1/ai/proposals/${proposal.id}/verify`, {})
    } catch (error) {
      log(`AI apply/verify seed skipped: ${String(error).slice(0, 180)}`)
    }
    const share = (await api('POST', `/admin/api/v1/ai/proposals/${proposal.id}/shares`, { expiresInHours: 24 })).data

    // 项目基本设置：真实项目名称。
    const prefs = (await api('GET', '/admin/api/v1/project-preferences')).data
    await api('PUT', '/admin/api/v1/project-preferences', {
      expectedRevision: prefs.revision,
      projectName: '拾光笔记',
      projectDescription: '一个本地优先的笔记后端',
      locale: prefs.locale,
      appearance: prefs.appearance,
      saveFeedback: prefs.saveFeedback,
    })

    const notesPath = `/data/${notes.id}`
    const routes = [
      ['/', '28-overview-continue-work.png'],
      ['/data', '27-notes-workspace.png'],
      [`${notesPath}/schema`, '03-notes-schema.png'],
      [`${notesPath}/schema?field=${encodeURIComponent(attachmentsField?.id ?? '')}`, '11-file-field-config.png'],
      [`${notesPath}/api`, '07-notes-api.png'],
      [`${notesPath}/access`, '26-access-rules.png'],
      ['/access', '08-users-list.png'],
      ['/access/auth', '10-auth-config.png'],
      ['/access/rules', '26-access-rules-page.png'],
      ['/developer/api', '13-api-docs.png'],
      ['/developer/logs', '14-request-logs.png'],
      [`/developer/diagnose?requestId=${encodeURIComponent(failedRequest?.requestId ?? '')}`, '15-request-diagnose.png'],
      ['/developer/secrets', '16-secrets.png'],
      ['/logic/rules', '25-logic-welcome-note.png'],
      [`/logic/edit?rule=${encodeURIComponent(visualRule.id)}`, '17-logic-edit-test.png'],
      [`/logic/runs?rule=${encodeURIComponent(visualRule.id)}`, '18-logic-runs-retry.png'],
      ['/changes/pending', '19-change-center.png'],
      ['/changes/history', '19-change-center-history.png'],
      ['/ai', '21-ai-applied-verification.png'],
      ['/settings', '22-local-project-settings.png'],
    ]
    for (const [route, filename] of routes) await capture(route, filename)
    await capture(share.url ?? `/ai/share/${share.token}`, '24-ai-public-share.png', true)

    // 需要交互才能出现的画板状态：抽屉 / 确认框。
    const captureAction = async (filename, route, action) => {
      try {
        await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' })
        await action()
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(evidenceDir, filename), fullPage: false })
        captured.push({ route: `${route} (interaction)`, filename })
        log(`captured ${filename} <- ${route} interaction`)
      } catch (error) {
        failures.push({ route: `${route} (interaction)`, filename, reason: String(error) })
        log(`FAILED ${filename}: ${String(error).slice(0, 160)}`)
      }
    }

    await captureAction('02-create-collection.png', '/data', async () => {
      await page.getByRole('button', { name: '创建集合' }).first().click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('05-edit-note-record.png', notesPath, async () => {
      await page.getByRole('button', { name: '新增记录' }).click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('12-record-file-upload.png', notesPath, async () => {
      await page.getByRole('cell', { name: /周末徒步路线/ }).first().click()
      await page.getByRole('button', { name: '编辑记录' }).click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('06-delete-collection-confirm.png', notesPath, async () => {
      await page.getByRole('button', { name: '集合操作' }).click()
      await page.getByRole('menuitem', { name: '删除集合' }).click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('09-user-and-sessions.png', '/access', async () => {
      await page.getByRole('button', { name: '查看详情' }).first().click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('16-secrets-edit.png', '/developer/secrets', async () => {
      await page.getByRole('button', { name: '新增 Secret' }).first().click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('04-edit-author-relation.png', `${notesPath}/schema`, async () => {
      await page.getByRole('button', { name: '编辑' }).first().click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
    })
    await captureAction('20-ai-requirement-understanding.png', '/ai', async () => {
      await page.getByText('需求理解').first().click()
    })

    const summary = {
      captured: captured.length,
      failures,
      consoleErrors,
      httpErrors,
      failedRequestId: failedRequest?.requestId ?? null,
      anonymousRequestStatus: denied.status(),
      evidenceDir: 'docs/evidence/frontend/final',
      viewport: { width: 1512, height: 1000 },
    }
    await writeFile(join(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2))
    log(`done: ${captured.length} screenshots, ${failures.length} failures, ${consoleErrors.length} console errors`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (runtime && runtime.exitCode === null) {
      runtime.kill('SIGTERM')
      await once(runtime, 'exit').catch(() => {})
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
