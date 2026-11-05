import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

/**
 * 真实浏览器验收启动器：编译 Go 运行时、在临时空项目里启动、跑完 Playwright 再清理。
 * 不使用 dev server 或 mock —— 验收对象就是交付的单二进制。
 */
const repoRoot = resolve(import.meta.dirname, '..', '..')
const workspaceRoot = resolve(repoRoot, 'admin')

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

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'modelry-acceptance-'))
  const projectDir = join(workDir, 'project')
  const binaryPath = join(workDir, 'modelry')
  let runtime

  const cleanup = async () => {
    if (runtime && runtime.exitCode === null) {
      runtime.kill('SIGTERM')
      await once(runtime, 'exit').catch(() => {})
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    await buildRuntime(binaryPath)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    log('starting runtime')
    runtime = spawn(binaryPath, ['start', '--project-root', projectDir], { stdio: ['ignore', 'pipe', 'inherit'] })
    const ready = await waitForReady(runtime)
    log(`runtime ready at ${ready.url}`)

    const playwright = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        MODELRY_BASE_URL: ready.url,
        MODELRY_PROJECT_DIR: projectDir,
        MODELRY_TEST_OUTPUT: join(workDir, 'test-results'),
      },
    })
    const [code] = await once(playwright, 'exit')
    process.exitCode = code ?? 1
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
