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

async function poll() {
  let lastError = ''
  for (let i = 0; i < 120; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (appProcess?.exitCode !== null) throw new Error(`DshPort exited early with code ${appProcess.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}`)
      if (response.status < 500) return response.status
      lastError = `HTTP ${response.status}`
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
    const status = await poll()
    console.log(`ZIP_SMOKE_READY=true STATUS=${status} PID=${appProcess.pid} PORT=${port}`)
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
