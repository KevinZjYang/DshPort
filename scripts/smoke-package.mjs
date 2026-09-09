import { spawn } from 'node:child_process'
import { rm, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const zip = join(root, 'dist-exe', 'desktop', 'DshPort-win-x64.zip')
const probe = join(root, 'dist-exe', 'zip-smoke')
const port = Number(process.env.DSHPORT_SMOKE_PORT || 32000 + Math.floor(Math.random() * 10000))

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options })
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
    child.once('error', reject)
  })
}

function parseTokenUrl(text) {
  return /https?:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_\-.%]+/u.exec(String(text))?.[0] || null
}

async function readLaunchUrlFromLog(logPath) {
  if (!existsSync(logPath)) return null
  const text = await readFile(logPath, 'utf8')
  // 从后往前找最后一次 dsh web 启动行，避免历史 token 干扰。
  const lines = text.trim().split(/\r?\n/u).reverse()
  for (const line of lines) {
    const url = parseTokenUrl(line)
    if (url) return url
  }
  return parseTokenUrl(text)
}

async function fetchUi(launchUrl) {
  // Node fetch 无 Cookie jar：token → 303 Set-Cookie 后需手动带上 Cookie 再请求首页。
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

async function waitForUi(logPath) {
  let lastError = ''
  for (let i = 0; i < 120; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (appProcess?.exitCode !== null) throw new Error(`DshPort exited early with code ${appProcess.exitCode}`)
    try {
      const launchUrl = await readLaunchUrlFromLog(logPath)
      if (!launchUrl) {
        lastError = 'harness token URL not ready'
        continue
      }
      const ui = await fetchUi(launchUrl)
      // 只认 200 + 可挂载的页面；401 空白不算通过。
      if (ui.status === 200 && ui.hadCookie && ui.body.includes('id="root"')) {
        return { status: ui.status, launchUrl, finalUrl: ui.finalUrl }
      }
      lastError = `UI HTTP ${ui.status} hadCookie=${ui.hadCookie} root=${ui.body.includes('id="root"')}`
    } catch (error) {
      lastError = error.message
    }
  }
  throw new Error(lastError || 'not ready')
}

let appProcess

function killTree(child) {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill()
}

async function main() {
  await rm(probe, { recursive: true, force: true })
  await mkdir(probe, { recursive: true })
  await run('tar', ['-xf', zip, '-C', probe])

  const exe = join(probe, 'DshPort.exe')
  if (!existsSync(exe)) throw new Error(`Missing ${exe}`)

  appProcess = spawn(exe, {
    cwd: probe,
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DSH_DISABLE_UPDATE_CHECK: '1',
      DSH_PORT: String(port),
    },
  })

  try {
    const logPath = join(probe, 'data', 'logs', 'harness.log')
    const ui = await waitForUi(logPath)
    console.log(`ZIP_SMOKE_READY=true STATUS=${ui.status} PID=${appProcess.pid} PORT=${port}`)
    console.log(`LAUNCH_URL_HOST=${new URL(ui.launchUrl).origin}`)
  } finally {
    killTree(appProcess)
  }

  const logPath = join(probe, 'data', 'logs', 'harness.log')
  if (existsSync(logPath)) {
    const lines = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/u)
    console.log('LOG_TAIL=')
    console.log(lines.slice(-20).join('\n'))
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
