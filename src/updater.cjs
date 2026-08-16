const { createHash } = require('node:crypto')
const { createWriteStream, mkdirSync } = require('node:fs')
const { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { request } = require('node:https')
const { spawn } = require('node:child_process')

// Self-contained on purpose: the updater is packaged alone under resources/updater
// and must not depend on sibling files that are not copied there.
function releaseTagUrl(repository, tagName) {
  return `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`
}

const [, , executablePath, version, repository, component = 'auto', parentPid, localArchive] = process.argv
if (!executablePath || !version || !repository) process.exit(2)

// 更新器自己的工作目录绝不能落在应用根目录里：replaceDirectory 要 rename 整个
// 应用目录，若进程 cwd 在该目录内会报 EBUSY（“正在使用中”）。切到盘符根目录。
try { process.chdir(dirname(dirname(executablePath))) } catch {}

// 应用退出后原管道（app 侧的 updater.log 流）即失效；更新器自己把 stdout/stderr
// 重定向到临时目录的 updater.log。注意日志绝不能放在 appRoot/data 里：
// 安装时需要 rename data/ 目录，任何打开的文件句柄都会导致 EPERM。
function setupLogging(logPath) {
  try {
    const logStream = createWriteStream(logPath, { flags: 'a' })
    const relay = chunk => logStream.write(chunk)
    process.stdout.write = relay
    process.stderr.write = relay
    return logStream
  } catch {
    return null
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const requestRef = request(url, { headers: { 'User-Agent': 'DeepSeekHarnessUpdater' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return getJson(response.headers.location).then(resolve, reject)
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    requestRef.on('error', reject)
    requestRef.end()
  })
}

// 直连失败时自动改用代理重试一次（与主程序的 DSH_UPDATE_PROXY 逻辑一致）。
function updaterProxiedUrl(url) {
  const raw = process.env.DSH_UPDATE_PROXY
  const proxy = raw === '0' || raw === 'off' || raw === 'false' ? '' : (raw || 'https://gh.yiun.cyou/')
  if (!proxy || url.startsWith(proxy) || !/^https?:\/\//u.test(url)) return url
  return `${proxy}${url}`
}

function progressLabel(received, total) {
  const pct = total > 0 ? Math.floor((received / total) * 100) : -1
  return pct >= 0 ? `${pct}%` : `${Math.round(received / 1048576)} MB`
}

async function downloadOnce(url, path, onProgress) {
  const response = await Promise.race([
    fetch(url, { redirect: 'follow' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时')), 20000)),
  ])
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const reader = response.body.getReader()
  const stream = createWriteStream(path)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!stream.write(value)) await new Promise(resolve => stream.once('drain', resolve))
      if (typeof onProgress === 'function') onProgress(received, total)
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()))
}

async function download(url, path, onProgress) {
  const attempts = [url]
  const fallback = updaterProxiedUrl(url)
  if (fallback !== url) attempts.push(fallback)
  let lastError
  for (const attempt of attempts) {
    try {
      await downloadOnce(attempt, path, onProgress)
      return
    } catch (error) {
      lastError = error
      console.warn(`Download failed via ${attempt}: ${error.message}`)
    }
  }
  throw lastError
}
async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function verifyChecksum(release, asset, archive, temp) {
  const checksumAsset = release.assets?.find(item => item.name === 'SHA256SUMS.txt')
  if (!checksumAsset) return
  const checksumFile = join(temp, 'SHA256SUMS.txt')
  await download(checksumAsset.browser_download_url, checksumFile)
  const expected = (await readFile(checksumFile, 'utf8')).split(/\r?\n/u)
    .find(line => line.includes(asset.name))?.split(/\s+/u)[0]
  if (expected && expected.toLowerCase() !== (await sha256(archive)).toLowerCase()) {
    throw new Error('SHA-256 verification failed')
  }
}

// 临时目录必须与应用同盘：更新时 data/ 需要 rename 到临时目录做保留，
// 跨盘 rename（如 E:\ -> C:\Temp）会报 EXDEV。放在便携根目录所在盘符的根下。
async function makeTemp() {
  const appRoot = dirname(executablePath)
  try {
    return await mkdtemp(join(dirname(appRoot), 'dsh-update-'))
  } catch {
    return await mkdtemp(join(tmpdir(), 'dsh-update-'))
  }
}

async function extractZip(archive, target) {
  await mkdir(target, { recursive: true })
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
  await new Promise((resolveRun, reject) => {
    const child = spawn(tar, ['-xf', archive, '-C', target], { windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`archive extraction failed: ${code}`)))
  })
}

async function singleExtractedRoot(extractRoot) {
  const entries = await (await import('node:fs/promises')).readdir(extractRoot, { withFileTypes: true })
  return entries.length === 1 && entries[0].isDirectory() ? join(extractRoot, entries[0].name) : extractRoot
}

// rename 可能因瞬时占用（杀软扫描、残留子进程）失败，重试几次再放弃。
async function retryRename(from, to, attempts = 10, delayMs = 1000) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'EACCES') throw error
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

async function replaceDirectory(target, source) {
  const backup = `${target}.backup-${Date.now()}`
  if (await exists(target)) await retryRename(target, backup)
  try {
    await cp(source, target, { recursive: true })
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    if (await exists(backup)) await retryRename(backup, target)
    throw error
  }
}

async function waitForProcessExit(pid, timeoutMs = 30000) {
  if (!pid || !/^\d+$/u.test(pid)) return
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(Number(pid), 0)
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch {
      return
    }
  }
}

// --- update progress UI ---

let progressFile = ''

function updaterDir() {
  return dirname(process.argv[1] || process.execPath)
}

function startProgressWindow(file) {
  const script = join(updaterDir(), 'update-progress.ps1')
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-StatusFile', file,
      '-UpdaterPid', String(process.pid),
    ], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // The progress window is best-effort; the update still proceeds without it.
  }
}

async function reportProgress(text) {
  if (progressFile) {
    try { await writeFile(progressFile, text) } catch {}
  }
}

function describeAsset(asset) {
  return asset?.size ? `（约 ${Math.round(asset.size / 1048576)} MB）` : ''
}

async function updateHarnessRuntime(release, temp) {
  const asset = release.assets?.find(item => item.name === 'harness-runtime.zip')
  if (!asset) return false
  const archive = join(temp, asset.name)
  await reportProgress(`正在下载更新包${describeAsset(asset)}… 0%`)
  await download(asset.browser_download_url, archive, (received, total) => {
    reportProgress(`正在下载更新包${describeAsset(asset)}… ${progressLabel(received, total)}`)
  })
  await reportProgress('正在校验文件…')
  await verifyChecksum(release, asset, archive, temp)
  await reportProgress('正在解压更新包…')
  const extractRoot = join(temp, 'harness')
  await extractZip(archive, extractRoot)
  const appRoot = dirname(executablePath)
  const harnessRoot = join(appRoot, 'resources', 'harness')
  await reportProgress('正在替换文件…')
  await replaceDirectory(harnessRoot, await singleExtractedRoot(extractRoot))
  return true
}

async function updateWholePortable(release, temp) {
  const asset = release.assets?.find(item => /DshPort-win-x64\.zip$/u.test(item.name) || /DeepSeekHarness-win-x64\.zip$/u.test(item.name) || /win-x64\.zip$/u.test(item.name))
  if (!asset) throw new Error('No Windows x64 portable zip in the release')
  const archive = join(temp, asset.name)
  await reportProgress(`正在下载更新包${describeAsset(asset)}… 0%`)
  await download(asset.browser_download_url, archive, (received, total) => {
    reportProgress(`正在下载更新包${describeAsset(asset)}… ${progressLabel(received, total)}`)
  })
  await reportProgress('正在校验文件…')
  await verifyChecksum(release, asset, archive, temp)
  await reportProgress('正在解压更新包…')
  const extractRoot = join(temp, 'portable')
  await extractZip(archive, extractRoot)
  const appRoot = dirname(executablePath)
  const sourceRoot = await singleExtractedRoot(extractRoot)
  const dataPath = join(appRoot, 'data')
  const dataHold = join(temp, 'data')
  await reportProgress('正在替换文件…')
  if (await exists(dataPath)) await retryRename(dataPath, dataHold)
  await replaceDirectory(appRoot, sourceRoot)
  if (await exists(dataHold)) await retryRename(dataHold, dataPath)
}

async function installFromLocal(archive, temp) {
  const appRoot = dirname(executablePath)
  const extractRoot = join(temp, 'local')
  await reportProgress('正在解压更新包…')
  await extractZip(archive, extractRoot)
  await reportProgress('正在替换文件…')
  if (component === 'harness') {
    const harnessRoot = join(appRoot, 'resources', 'harness')
    await replaceDirectory(harnessRoot, await singleExtractedRoot(extractRoot))
  } else {
    const sourceRoot = await singleExtractedRoot(extractRoot)
    const dataPath = join(appRoot, 'data')
    const dataHold = join(temp, 'data')
    if (await exists(dataPath)) await retryRename(dataPath, dataHold)
    await replaceDirectory(appRoot, sourceRoot)
    if (await exists(dataHold)) await retryRename(dataHold, dataPath)
  }
  // The archive was downloaded by the app in the background; clean it up with its pending marker.
  await rm(archive, { force: true })
  await rm(join(appRoot, 'data', 'updates', 'pending.json'), { force: true })
}

async function main() {
  const temp = await makeTemp()
  progressFile = join(temp, 'progress.txt')
  const logStream = setupLogging(join(temp, 'updater.log'))
  let success = false
  try {
    await reportProgress('准备更新…')
    startProgressWindow(progressFile)
    await waitForProcessExit(parentPid)
    if (localArchive) {
      await installFromLocal(localArchive, temp)
    } else {
      const release = await getJson(releaseTagUrl(repository, version))
      const updatedHarness = component !== 'portable' && await updateHarnessRuntime(release, temp)
      if (!updatedHarness) await updateWholePortable(release, temp)
    }
    await reportProgress('COMPLETE')
    success = true
    const relaunch = spawn(executablePath, [], { detached: true, windowsHide: true, stdio: 'ignore' })
    relaunch.once('error', () => {})
    relaunch.unref()
  } finally {
    if (logStream) { try { logStream.end() } catch {} }
    // 成功才清理临时目录；失败时保留 updater.log 与 progress.txt 便于诊断。
    if (success) { try { await rm(temp, { recursive: true, force: true }) } catch {} }
  }
}

main().catch(async error => {
  // 先把失败原因写进 progress.txt（进度窗口会显示），再尝试记日志；
  // 日志流可能已在 finally 中 end()，console.error 需要防 write-after-end。
  if (progressFile) {
    try { await writeFile(progressFile, `FAILED ${error.message}`) } catch {}
  }
  try { console.error(error.stack || error.message) } catch {}
  process.exitCode = 1
})

