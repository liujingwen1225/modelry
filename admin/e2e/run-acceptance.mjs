import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

/**
 * 真实浏览器验收启动器：编译一次单二进制，然后为**每个 spec 文件**启动一个
 * 全新的临时空项目与 Runtime，跑完 Playwright 再关闭清理。
 *
 * 每个 spec 自带空项目假设（首次创建管理员、还没有集合等），共享一个 Runtime
 * 会让文件之间的状态互相污染；独立 Runtime 才是可重复的真实验收。
 * 不使用 dev server 或 mock —— 验收对象就是交付的单二进制。
 */
const repoRoot = resolve(import.meta.dirname, '..', '..')
const workspaceRoot = resolve(repoRoot, 'admin')
const e2eRoot = resolve(workspaceRoot, 'e2e')

function log(message) {
  process.stdout.write(`[acceptance] ${message}\n`)
}

function waitForReady(child) {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = ''
    const timer = setTimeout(() => {
      rejectReady(new Error('Modelry runtime did not report ready within 60s'))
    }, 60_000)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((entry) => entry.startsWith('READY '))
      if (!line) {
        return
      }
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
      rejectReady(new Error(`Modelry runtime exited before ready (code ${code})`))
    })
  })
}

async function buildRuntime(binaryPath) {
  // 先构建前端，再构建 Go：验收必须覆盖本次改动的前端产物，而不是上一次的 dist。
  log('building Admin bundle')
  const bundle = spawn('npm', ['run', 'build'], { cwd: workspaceRoot, stdio: 'inherit' })
  const [bundleCode] = await once(bundle, 'exit')
  if (bundleCode !== 0) {
    throw new Error(`Admin bundle build failed with code ${bundleCode}`)
  }

  log('building Go runtime')
  const build = spawn('go', ['build', '-o', binaryPath, './cmd/modelry'], { cwd: repoRoot, stdio: 'inherit' })
  const [code] = await once(build, 'exit')
  if (code !== 0) {
    throw new Error(`go build failed with code ${code}`)
  }
}

async function stopRuntime(runtime) {
  if (!runtime || runtime.exitCode !== null) return
  runtime.kill('SIGTERM')
  await once(runtime, 'exit').catch(() => {})
}

async function specFiles() {
  const entries = await readdir(e2eRoot)
  return entries
    .filter((name) => name.endsWith('.spec.ts') || name.endsWith('.spec.js'))
    .sort()
    .map((name) => `e2e/${name}`)
}

async function runSpec(binaryPath, workDir, spec, index, extraArgs) {
  const specDir = join(workDir, `spec-${index}`)
  const projectDir = join(specDir, 'project')
  await mkdir(projectDir, { recursive: true })

  log(`starting isolated runtime for ${spec}`)
  const runtime = spawn(binaryPath, ['start', '--project-root', projectDir], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const ready = await waitForReady(runtime)
    log(`runtime ready at ${ready.url} (${spec})`)
    const playwright = spawn('npx', ['playwright', 'test', spec, ...extraArgs], {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        MODELRY_BASE_URL: ready.url,
        MODELRY_PROJECT_DIR: projectDir,
        MODELRY_TEST_OUTPUT: join(specDir, 'test-results'),
      },
    })
    const [code] = await once(playwright, 'exit')
    return code ?? 1
  } finally {
    await stopRuntime(runtime)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const requested = args.filter((arg) => arg.endsWith('.spec.ts') || arg.endsWith('.spec.js'))
  const extraArgs = args.filter((arg) => !requested.includes(arg))
  const targets = requested.length > 0 ? requested : await specFiles()
  if (targets.length === 0) {
    throw new Error('No Playwright spec files found')
  }

  const workDir = await mkdtemp(join(tmpdir(), 'modelry-acceptance-'))
  const binaryPath = join(workDir, 'modelry')
  try {
    await buildRuntime(binaryPath)
    let failed = 0
    for (const [index, spec] of targets.entries()) {
      const code = await runSpec(binaryPath, workDir, spec, index, extraArgs)
      if (code !== 0) {
        failed++
        log(`${spec} FAILED with code ${code}`)
      }
    }
    if (failed > 0) {
      throw new Error(`${failed}/${targets.length} spec files failed`)
    }
    log(`all ${targets.length} spec files passed`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
