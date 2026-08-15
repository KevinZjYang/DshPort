const { createHash } = require('node:crypto')
const { createWriteStream } = require('node:fs')
const { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { pipeline } = require('node:stream/promises')
const { request } = require('node:https')
const { spawn } = require('node:child_process')
const { releaseTagUrl } = require('./portable-paths.cjs')

const [, , executablePath, version, repository, component = 'auto', parentPid] = process.argv
if (!executablePath || !version || !repository) process.exit(2)

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

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
  await pipeline(response.body, createWriteStream(path))
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

async function replaceDirectory(target, source) {
  const backup = `${target}.backup-${Date.now()}`
  if (await exists(target)) await rename(target, backup)
  try {
    await cp(source, target, { recursive: true })
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    if (await exists(backup)) await rename(backup, target)
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
  await reportProgress(`正在下载更新包${describeAsset(asset)}…`)
  await download(asset.browser_download_url, archive)
  await reportProgress('正在校验文件…')
  await verifyChecksum(release, asset, archive, temp)
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
  await reportProgress(`正在下载更新包${describeAsset(asset)}…`)
  await download(asset.browser_download_url, archive)
  await reportProgress('正在校验文件…')
  await verifyChecksum(release, asset, archive, temp)
  const extractRoot = join(temp, 'portable')
  await extractZip(archive, extractRoot)
  const appRoot = dirname(executablePath)
  const sourceRoot = await singleExtractedRoot(extractRoot)
  const dataPath = join(appRoot, 'data')
  const dataHold = join(temp, 'data')
  await reportProgress('正在替换文件…')
  if (await exists(dataPath)) await rename(dataPath, dataHold)
  await replaceDirectory(appRoot, sourceRoot)
  if (await exists(dataHold)) await rename(dataHold, dataPath)
}

async function main() {
  const release = await getJson(releaseTagUrl(repository, version))
  const temp = await mkdtemp(join(tmpdir(), 'dsh-update-'))
  progressFile = join(temp, 'progress.txt')
  await reportProgress('准备更新…')
  startProgressWindow(progressFile)
  await waitForProcessExit(parentPid)
  const updatedHarness = component !== 'portable' && await updateHarnessRuntime(release, temp)
  if (!updatedHarness) await updateWholePortable(release, temp)
  await reportProgress('COMPLETE')
  spawn(executablePath, [], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
}

main().catch(async error => {
  console.error(error.stack || error.message)
  if (progressFile) {
    try { await writeFile(progressFile, `FAILED ${error.message}`) } catch {}
  }
  process.exitCode = 1
})
