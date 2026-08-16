const { createHash } = require('node:crypto')
const { createWriteStream, mkdirSync } = require('node:fs')
const { access, appendFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
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
    // 回滚时先把残缺的新目录删掉，再恢复旧目录；恢复失败时保留现场供人工处理。
    try { await rm(target, { recursive: true, force: true }) } catch {}
    if (await exists(backup)) {
      try { await retryRename(backup, target) } catch (restoreError) {
        console.warn(`Rollback failed: ${restoreError.message}`)
      }
    }
    throw error
  }
}

// 整包替换（保留 data/）。关键点：本更新器进程的运行镜像就在 appRoot 内，
// 替换后旧目录（backup）必然包含正在执行的 node.exe，Windows 不允许删除
// 运行中的镜像（EPERM），因此删除必须推迟到本进程退出之后，由运行在
// “新运行时”里的独立清理进程完成。更新成功与否不再依赖任何删除操作。
async function swapPortableApp(sourceRoot) {
  const appRoot = dirname(executablePath)
  const backup = `${appRoot}.backup-${Date.now()}`
  const dataPath = join(appRoot, 'data')
  const dataHold = join(updateTemp, 'data')
  if (await exists(dataPath)) await retryRename(dataPath, dataHold)
  if (await exists(appRoot)) await retryRename(appRoot, backup)
  try {
    await cp(sourceRoot, appRoot, { recursive: true })
  } catch (error) {
    // 回滚：残缺的新目录改名靠边（绝不原地删除，避免应用目录进入残缺态），
    // 再恢复旧应用与 data。
    try { await rename(appRoot, `${backup}.failed-${Date.now()}`) } catch {}
    if (await exists(backup)) {
      try { await retryRename(backup, appRoot) } catch (restoreError) {
        console.warn(`Rollback failed: ${restoreError.message}`)
      }
    }
    if (await exists(dataHold)) {
      try { await retryRename(dataHold, dataPath) } catch (dataError) {
        console.warn(`Data restore failed: ${dataError.message}`)
      }
    }
    throw error
  }
  if (await exists(dataHold)) await retryRename(dataHold, dataPath)
  await spawnBackupCleanup(backup)
  return backup
}

// 延迟清理进程：用新版的 node.exe 运行（其镜像不在 backup 内），等待本更新器
// （镜像在 backup 内）退出后删除 backup，最后清理临时目录。
const CLEANUP_HELPER = [
  '// Deferred cleanup for a replaced DshPort install (spawned detached by the updater).',
  "const { spawn } = require('node:child_process')",
  "const { rm } = require('node:fs/promises')",
  'const [, , backupDir, updaterPid, tempDir] = process.argv',
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))',
  'async function waitForPidExit(pid, timeoutMs) {',
  '  if (!pid || !/^\\d+$/u.test(pid)) return',
  '  const started = Date.now()',
  '  while (Date.now() - started < timeoutMs) {',
  '    try { process.kill(Number(pid), 0) } catch { return }',
  '    await sleep(500)',
  '  }',
  '}',
  'async function killProcessesUnder(root) {',
  '  const pattern = root.replace(/\\\'/g, "\\\'\\\'")',
  '  const command = "Get-Process | Where-Object { $_.Path -and $_.Path -like \\\'" + pattern + "*\\\' } | Stop-Process -Force -ErrorAction SilentlyContinue"',
  '  await new Promise(resolve => {',
  "    const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, stdio: 'ignore' })",
  '    child.once(\'exit\', () => resolve())',
  '    child.once(\'error\', () => resolve())',
  '  })',
  '}',
  'async function removeWithRetry(dir, attempts, delayMs) {',
  '  for (let i = 0; i < attempts; i++) {',
  '    try { await rm(dir, { recursive: true, force: true }); return true } catch {}',
  '    await sleep(delayMs)',
  '  }',
  '  return false',
  '}',
  'async function main() {',
  '  await waitForPidExit(updaterPid, 120000)',
  '  if (!(await removeWithRetry(backupDir, 15, 1500))) {',
  '    await killProcessesUnder(backupDir)',
  '    await sleep(2000)',
  '    await removeWithRetry(backupDir, 5, 1500)',
  '  }',
  '  // 留出时间让进度窗口读完 COMPLETE/FAILED 再清理现场。',
  '  await sleep(5000)',
  '  try { await rm(tempDir, { recursive: true, force: true }) } catch {}',
  '}',
  'main().catch(() => {})',
].join('\n')

async function spawnBackupCleanup(backupDir) {
  const appRoot = dirname(executablePath)
  const helperScript = join(updateTemp, 'cleanup-backup.cjs')
  await writeFile(helperScript, CLEANUP_HELPER)
  const newNode = join(appRoot, 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!(await exists(newNode))) {
    // 新包缺少 node 运行时（异常包）：更新本身已成功，backup 交给下次启动清理。
    console.warn(`Cleanup helper runtime missing: ${newNode}; backup cleanup deferred to next start`)
    return
  }
  const child = spawn(newNode, [helperScript, backupDir, String(process.pid), updateTemp], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: dirname(appRoot),
  })
  child.once('error', error => console.warn(`Cleanup helper failed to start: ${error.message}`))
  child.unref()
  deferredCleanup = true
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
let updateTemp = ''
// 整包替换后，旧应用目录（含本更新器自己的运行镜像）不能由本进程删除，
// 改由独立的清理进程在退出后处理；在它接管前，本进程不得删除临时目录。
let deferredCleanup = false

function updaterDir() {
  return dirname(process.argv[1] || process.execPath)
}

function startProgressWindow(file) {
  const script = join(updaterDir(), 'update-progress.ps1')
  // 不用 detached：进度窗口只需在更新器存活期间显示（更新器从启动到 COMPLETE 一直
  // 活着）；DETACHED_PROCESS 会让 powershell 的 WinForms 窗口在部分机器上不显示。
  // windowsHide 隐藏 powershell 的控制台窗口，只显示表单。
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-StatusFile', file,
    '-UpdaterPid', String(process.pid),
  ], { stdio: 'ignore', windowsHide: true })
  // 进度窗口是尽力而为，失败不应中断更新；但要把失败原因记进日志。
  child.once('error', error => {
    try { console.warn(`Progress window failed to start: ${error.message}`) } catch {}
  })
  child.unref()
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
  const sourceRoot = await singleExtractedRoot(extractRoot)
  await reportProgress('正在替换文件…')
  await swapPortableApp(sourceRoot)
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
    await swapPortableApp(await singleExtractedRoot(extractRoot))
  }
  // The archive was downloaded by the app in the background; clean it up with its pending marker.
  await rm(archive, { force: true })
  await rm(join(appRoot, 'data', 'updates', 'pending.json'), { force: true })
}

async function main() {
  updateTemp = await makeTemp()
  progressFile = join(updateTemp, 'progress.txt')
  const logStream = setupLogging(join(updateTemp, 'updater.log'))
  let success = false
  try {
    await reportProgress('准备更新…')
    startProgressWindow(progressFile)
    await waitForProcessExit(parentPid)
    if (localArchive) {
      await installFromLocal(localArchive, updateTemp)
    } else {
      const release = await getJson(releaseTagUrl(repository, version))
      const updatedHarness = component !== 'portable' && await updateHarnessRuntime(release, updateTemp)
      if (!updatedHarness) await updateWholePortable(release, updateTemp)
    }
    await reportProgress('COMPLETE')
    success = true
    try {
      const relaunch = spawn(executablePath, [], { detached: true, windowsHide: true, stdio: 'ignore' })
      relaunch.once('error', () => {})
      relaunch.unref()
    } catch {
      // 启动失败不影响已完成的更新；用户手动启动即可。
    }
  } finally {
    if (logStream) { try { logStream.end() } catch {} }
    // 成功才清理临时目录（除非已交给延迟清理进程）；失败时保留现场便于诊断。
    if (success && !deferredCleanup) { try { await rm(updateTemp, { recursive: true, force: true }) } catch {} }
  }
}

main().catch(async error => {
  // 先把失败原因写进 progress.txt（进度窗口会显示），再尝试记日志；
  // 日志流可能已在 finally 中 end()，console.error 需要防 write-after-end。
  if (progressFile) {
    try { await writeFile(progressFile, `FAILED ${error.message}`) } catch {}
  }
  try {
    await appendFile(join(updateTemp, 'updater.log'), `${new Date().toISOString()} FAILED ${error.stack || error.message}\n`).catch(() => {})
  } catch {}
  try { console.error(error.stack || error.message) } catch {}
  process.exitCode = 1
})

