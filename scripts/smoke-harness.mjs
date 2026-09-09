#!/usr/bin/env node
/**
 * Harness 插件树 + Web UI 冒烟（不依赖完整 Electron 包）。
 *
 * 覆盖这次踩过的坑：
 * 1. 内置插件与 harness API 不匹配 → dump-config / boot 失败
 * 2. 无 token 打开 UI → 401（以前 zip 冒烟把 <500 都当成功）
 *
 * 用法：
 *   node scripts/smoke-harness.mjs
 *   node scripts/smoke-harness.mjs --harness <dir> --preset <web-profile-dir>
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const harnessRoot = resolve(argValue('--harness', join(projectRoot, 'runtime', 'harness')))
const presetRoot = resolve(argValue('--preset', join(projectRoot, 'resources', 'presets', 'web-profile')))
const nodeExe = process.platform === 'win32'
  ? join(harnessRoot, '..', 'node', 'node.exe')
  : process.execPath
const binJs = join(harnessRoot, 'lib', 'bin.js')
const port = Number(argValue('--port', String(33000 + Math.floor(Math.random() * 20000))))

function fail(message) {
  console.error(`[smoke-harness] FAIL: ${message}`)
  process.exitCode = 1
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun({ stdout, stderr })
      else reject(new Error(`${command} exited ${code}\n${stderr || stdout}`))
    })
  })
}

function parseTokenUrl(text) {
  return /https?:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_\-.%]+/u.exec(String(text))?.[0] || null
}

async function waitForTokenUrl(child, timeoutMs = 20000) {
  const started = Date.now()
  let buf = ''
  return new Promise((resolveWait, reject) => {
    const onData = chunk => {
      buf += chunk.toString('utf8')
      const url = parseTokenUrl(buf)
      if (url) {
        cleanup()
        resolveWait(url)
      }
    }
    const onExit = code => {
      cleanup()
      reject(new Error(`harness exited before printing token URL (code=${code})\n${buf}`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for token URL\n${buf}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

async function fetchUi(launchUrl) {
  // Node fetch 没有 Cookie jar：token 响应 303 + Set-Cookie 后，重定向不会自动带上 Cookie。
  const first = await fetch(launchUrl, { redirect: 'manual' })
  const setCookies = typeof first.headers.getSetCookie === 'function'
    ? first.headers.getSetCookie()
    : []
  const cookieHeader = setCookies
    .map(entry => String(entry).split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
  const origin = new URL(launchUrl).origin
  const response = await fetch(`${origin}/`, {
    redirect: 'follow',
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  })
  const body = await response.text()
  return { status: response.status, body, finalUrl: response.url, hadCookie: Boolean(cookieHeader) }
}

async function seedHome(home) {
  if (!existsSync(presetRoot)) {
    throw new Error(`preset profile not found: ${presetRoot}（先跑 node scripts/build-runtime.mjs）`)
  }
  await cp(presetRoot, join(home, 'profiles', 'web'), { recursive: true })
}

async function main() {
  if (!existsSync(binJs)) throw new Error(`harness bin missing: ${binJs}`)
  if (!existsSync(nodeExe)) throw new Error(`node missing: ${nodeExe}`)

  const home = await mkdtemp(join(tmpdir(), 'dshport-smoke-home-'))
  let child
  try {
    await seedHome(home)
    const env = { ...process.env, DSH_HOME: home }

    // 1) 插件树能组合（内置插件与 harness 导出对齐）
    await run(nodeExe, [binJs, '--profile', 'web', '--dump-config'], { env, cwd: home })
    console.log('[smoke-harness] dump-config OK')

    // 2) 带 token 的 UI 可打开（不是 401 空白）
    child = spawn(nodeExe, [binJs, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
      env,
      cwd: home,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderrBuf = ''
    child.stderr.on('data', chunk => { stderrBuf += chunk.toString('utf8') })

    const launchUrl = await waitForTokenUrl(child)
    const ui = await fetchUi(launchUrl)
    if (ui.status !== 200 || !ui.hadCookie) {
      fail(`UI HTTP ${ui.status} hadCookie=${ui.hadCookie} for ${launchUrl} → ${ui.finalUrl}`)
    } else if (!ui.body.includes('id="root"')) {
      fail('UI HTML missing #root mount point')
    } else {
      console.log(`[smoke-harness] UI OK status=${ui.status} url=${launchUrl.slice(0, 48)}…`)
    }

    // 3) 快照：内置插件版本，便于升级 harness 时对照
    try {
      const market = JSON.parse(await readFile(join(home, 'profiles', 'web', 'node_modules', 'dshmarket', 'package.json'), 'utf8'))
      const harness = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8'))
      console.log(`[smoke-harness] harness=${harness.version} dshmarket=${market.version}`)
    } catch {}
  } finally {
    if (child && !child.killed) {
      if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        child.kill()
      }
      // 等子进程真正退出，避免 Windows 上 rmdir EBUSY。
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }

  if (process.exitCode) {
    console.error('[smoke-harness] completed with failures')
  } else {
    console.log('[smoke-harness] PASS')
  }
}

main().catch(error => {
  console.error('[smoke-harness] FAIL:', error.stack || error.message)
  process.exitCode = 1
})
