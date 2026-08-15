const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const { basename, dirname, join } = require('node:path')
const { compareVersions, parseDshReleaseCommit, portableDataPaths } = require('./portable-paths.cjs')

const APP_NAME = 'DshPort'
const DEFAULT_PORT = 3080
const UPDATE_REPOSITORY = process.env.DSH_UPDATE_REPOSITORY || 'KevinZjYang/DshPort'
const SOURCE_REPOSITORY = process.env.DSH_SOURCE_REPOSITORY || 'deepseek-ai/deepseek-harness'
const isPackaged = app.isPackaged
const runtimeRoot = isPackaged ? process.resourcesPath : join(__dirname, '..', 'runtime')
const portableRoot = isPackaged ? dirname(process.execPath) : join(__dirname, '..', '..')
const { dataRoot, dshHome, workspace, logsRoot } = portableDataPaths(portableRoot)
const iconPath = join(__dirname, '..', 'resources', 'icon.ico')
const updatesDir = join(dataRoot, 'updates')

let mainWindow
let harnessProcess
let shuttingDown = false
let suppressHarnessExitError = false
let activeUrl
let pendingUrl
let windowLoaded = false
let backgroundDownload = null
let installPromptOpen = false

function ensureDirectories() {
  for (const path of [dataRoot, dshHome, workspace, logsRoot, updatesDir]) mkdirSync(path, { recursive: true })
  // Clean up stale partial downloads from an interrupted run.
  try {
    for (const file of readdirSync(updatesDir)) {
      if (file.endsWith('.part')) rmSync(join(updatesDir, file), { force: true })
    }
  } catch {}
}

function getVersion() {
  return app.getVersion()
}

function getHarnessVersion() {
  const manifestPath = join(runtimeRoot, 'harness', 'package.json')
  if (!existsSync(manifestPath)) return app.getVersion()
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version || app.getVersion()
  } catch {
    return app.getVersion()
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('node:net')
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function waitForUrl(url, timeoutMs = 60000) {
  const started = Date.now()
  const transport = url.startsWith('https:') ? https : http
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error(`Harness did not become ready within ${timeoutMs}ms`))
      setTimeout(poll, 250)
    }
    const poll = () => {
      const requestRef = transport.request(url, { timeout: 1500 }, response => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) return resolve(url)
        retry()
      })
      requestRef.on('error', retry)
      requestRef.on('timeout', () => requestRef.destroy())
      requestRef.end()
    }
    poll()
  })
}

async function startHarness() {
  const port = Number(process.env.DSH_PORT || await findFreePort() || DEFAULT_PORT)
  spawnHarness(port)
  activeUrl = await waitForUrl(`http://127.0.0.1:${port}`)
  return activeUrl
}

function spawnHarness(port) {
  const nodePath = join(runtimeRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const binPath = join(runtimeRoot, 'harness', 'lib', 'bin.js')
  const logPath = join(logsRoot, 'harness.log')
  const logStream = require('node:fs').createWriteStream(logPath, { flags: 'a' })
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_WEB_WORKSPACE: workspace,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(nodePath, [binPath, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  harnessProcess = child
  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)
  child.once('exit', (code, signal) => {
    logStream.end()
    if (harnessProcess === child) harnessProcess = undefined
    if (!shuttingDown && !suppressHarnessExitError && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(APP_NAME, `Harness exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Logs: ${logPath}`)
      app.quit()
    }
  })
  return { logPath }
}

function stopHarness() {
  return new Promise(resolve => {
    const child = harnessProcess
    if (!child || child.killed) return resolve()
    child.once('exit', resolve)
    child.kill()
    setTimeout(resolve, 5000)
  })
}

async function restartHarness() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  suppressHarnessExitError = true
  try {
    await stopHarness()
    const url = await startHarness()
    sendUrlToWindow(url)
    return url
  } catch (error) {
    dialog.showErrorBox(APP_NAME, error.stack || error.message)
  } finally {
    suppressHarnessExitError = false
  }
}

function sendUrlToWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (windowLoaded) {
    mainWindow.webContents.send('harness-url', url)
  } else {
    pendingUrl = url
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: iconPath,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
  // shell.html shows a loading screen; the harness URL arrives via IPC once ready.
  mainWindow.loadFile(join(__dirname, 'shell.html'))
  mainWindow.webContents.once('did-finish-load', () => {
    windowLoaded = true
    if (pendingUrl) {
      mainWindow.webContents.send('harness-url', pendingUrl)
      pendingUrl = undefined
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

function downloadJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const cleanup = () => clearTimeout(timer)
    const requestRef = https.request(url, {
      headers: { 'User-Agent': 'DeepSeekHarnessDesktop' },
      signal: controller.signal,
    }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        cleanup()
        return downloadJson(response.headers.location, timeoutMs).then(resolve, reject)
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        cleanup()
        if (response.statusCode !== 200) {
          const error = new Error(`Update server returned HTTP ${response.statusCode}`)
          error.statusCode = response.statusCode
          return reject(error)
        }
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    requestRef.on('error', error => {
      cleanup()
      if (error.name === 'AbortError') {
        const timeoutError = new Error(`Request timed out after ${timeoutMs}ms: ${url}`)
        timeoutError.code = 'ETIMEDOUT'
        return reject(timeoutError)
      }
      reject(error)
    })
    requestRef.end()
  })
}

function compareVersionsSafe(left, right) {
  try { return compareVersions(left, right) > 0 } catch { return false }
}

function parseReleaseHarnessVersion(release) {
  const match = /上游版本：([0-9][^\s\r\n]*)/u.exec(release.body || '')
  return match ? match[1].trim() : undefined
}

function readPendingUpdate() {
  try {
    const file = join(updatesDir, 'pending.json')
    if (!existsSync(file)) return null
    const pending = JSON.parse(readFileSync(file, 'utf8'))
    return pending && typeof pending.archive === 'string' && existsSync(pending.archive) ? pending : null
  } catch {
    return null
  }
}

function writePendingUpdate(pending) {
  mkdirSync(updatesDir, { recursive: true })
  writeFileSync(join(updatesDir, 'pending.json'), JSON.stringify(pending, null, 2))
}

function discardPendingUpdate() {
  try { rmSync(join(updatesDir, 'pending.json'), { force: true }) } catch {}
}

async function downloadFile(url, target, onProgress) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const reader = response.body.getReader()
  const stream = createWriteStream(target)
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

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyDownloadedChecksum(release, archive) {
  const checksumAsset = release.assets?.find(item => item.name === 'SHA256SUMS.txt')
  if (!checksumAsset) return true
  try {
    const target = join(updatesDir, 'SHA256SUMS.txt')
    await downloadFile(checksumAsset.browser_download_url, target)
    const text = readFileSync(target, 'utf8')
    const expected = text.split(/\r?\n/u).find(line => line.includes(basename(archive)))?.split(/\s+/u)[0]
    if (!expected) return false
    return expected.toLowerCase() === (await sha256Of(archive)).toLowerCase()
  } catch {
    return false
  }
}

async function startBackgroundDownload(release, component) {
  const asset = release.assets?.find(item =>
    component === 'harness' ? item.name === 'harness-runtime.zip' : /DshPort-win-x64\.zip$/u.test(item.name))
  if (!asset) return
  const archive = join(updatesDir, asset.name)
  const pending = { tag: String(release.tag_name || ''), component, archive }
  if (!existsSync(archive)) {
    if (backgroundDownload) return
    backgroundDownload = (async () => {
      const partial = `${archive}.part`
      rmSync(partial, { force: true })
      await downloadFile(asset.browser_download_url, partial)
      const ok = await verifyDownloadedChecksum(release, partial)
      if (!ok) {
        rmSync(partial, { force: true })
        throw new Error('Checksum verification failed')
      }
      rmSync(archive, { force: true })
      renameSync(partial, archive)
    })().finally(() => { backgroundDownload = null })
  }
  try {
    await backgroundDownload
  } catch (error) {
    console.warn('Background update download failed:', error.message)
    return
  }
  if (!existsSync(archive)) return
  writePendingUpdate(pending)
  promptInstallUpdate(pending)
}

async function promptInstallUpdate(pending) {
  if (installPromptOpen) return
  installPromptOpen = true
  try {
    const size = existsSync(pending.archive) ? Math.round(statSync(pending.archive).size / 1048576) : 0
    const versionLabel = String(pending.tag || '').replace(/^v/u, '')
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: pending.component === 'harness'
        ? `Harness 更新已下载完成（约 ${size} MB）`
        : `DshPort ${versionLabel} 更新已下载完成（约 ${size} MB）`,
      detail: [
        '更新包已在后台下载完成，可以随时安装。',
        '安装时应用会短暂关闭，完成后自动重新启动。',
        'data/ 下的数据会保留。',
      ].join('\n'),
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) launchUpdater(pending.tag, pending.component, pending.archive)
  } finally {
    installPromptOpen = false
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (UPDATE_REPOSITORY === '') {
    if (manual) await checkSourceVersion()
    return
  }
  if (process.env.DSH_DISABLE_UPDATE_CHECK === '1') {
    if (manual) await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: 'Update checks are disabled.' })
    return
  }
  if (!isPackaged) {
    if (manual) await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: 'Update checks are only available in the packaged app.' })
    return
  }
  const localVersion = getVersion().replace(/^v/u, '')
  try {
    const release = await downloadJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`)
    const latest = String(release.tag_name || '').replace(/^v/u, '')
    const harnessLatest = parseReleaseHarnessVersion(release)
    const harnessLocal = getHarnessVersion()
    const shellOutdated = latest !== '' && latest !== localVersion && compareVersionsSafe(latest, localVersion)
    const harnessOutdated = harnessLatest !== undefined && harnessLatest !== harnessLocal && compareVersionsSafe(harnessLatest, harnessLocal)

    // A previously downloaded update may still be waiting to be installed.
    const pending = readPendingUpdate()
    if (pending) {
      const pendingTag = String(pending.tag || '').replace(/^v/u, '')
      if (pendingTag !== '' && pendingTag === latest && pendingTag !== localVersion) {
        promptInstallUpdate(pending)
        return
      }
      discardPendingUpdate()
    }

    if (!shellOutdated && !harnessOutdated) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: 'You are already on the latest version.',
          detail: `Current version: ${localVersion}`,
        })
      }
      return
    }

    if (backgroundDownload) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: '更新正在后台下载中，完成后会提示安装。',
        })
      }
      return
    }

    // Download in the background first; the user installs only after it is ready.
    await startBackgroundDownload(release, shellOutdated ? 'portable' : 'harness')
  } catch (error) {
    console.warn('Update check failed:', error.message)
    const pending = readPendingUpdate()
    if (pending) {
      promptInstallUpdate(pending)
      return
    }
    if (error.statusCode === 404) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: '\u5f53\u524d\u6682\u65e0\u53ef\u7528\u66f4\u65b0\u3002',
        detail: `Update source has no published release yet: ${UPDATE_REPOSITORY}`,
        })
      }
      return
    }
    if (manual) {
      await dialog.showMessageBox({
        type: 'warning',
        title: APP_NAME,
        message: 'Update check failed.',
        detail: error.message,
      })
    }
  }
}

async function checkSourceVersion() {
  const localVersion = getVersion().replace(/^v/u, '')
  try {
    const commits = await downloadJson(`https://api.github.com/repos/${SOURCE_REPOSITORY}/commits?per_page=50`)
    const releaseCommit = commits.find(commit => parseDshReleaseCommit(commit.commit?.message ?? '') !== undefined)
    const latest = releaseCommit === undefined ? undefined : parseDshReleaseCommit(releaseCommit.commit.message)
    if (latest === undefined) {
      await dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: '\u672a\u627e\u5230\u4e0a\u6e38\u7248\u672c\u66f4\u65b0\u63d0\u4ea4\u3002',
        detail: `Checked commits from ${SOURCE_REPOSITORY}.`,
      })
      return
    }
    if (compareVersions(latest, localVersion) <= 0) {
      await dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: '\u5f53\u524d\u5df2\u662f\u6700\u65b0\u6e90\u7801\u7248\u672c\u3002',
        detail: `Current version: ${localVersion}\nLatest source version: ${latest}`,
      })
      return
    }
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: `\u53d1\u73b0\u4e0a\u6e38\u65b0\u7248\u672c\uff1a${latest}`,
      detail: [
        `Current version: ${localVersion}`,
        `Latest source version: ${latest}`,
        '',
        'The upstream repository does not provide a portable Windows package here. Configure DSH_UPDATE_REPOSITORY to a DshPort package release repository to update automatically.',
      ].join('\n'),
      buttons: ['OK', 'Open Commit'],
      defaultId: 0,
      cancelId: 0,
    })
    if (answer.response === 1 && releaseCommit.html_url) await shell.openExternal(releaseCommit.html_url)
  } catch (error) {
    await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '\u68c0\u67e5\u4e0a\u6e38\u7248\u672c\u5931\u8d25\u3002',
      detail: error.message,
    })
  }
}

function launchUpdater(tagName, component, localArchive) {
  const updater = join(runtimeRoot, 'updater', 'updater.cjs')
  const nodePath = join(runtimeRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(updater)) {
    dialog.showErrorBox(APP_NAME, `Updater not found: ${updater}`)
    return
  }
  const args = [updater, process.execPath, tagName, UPDATE_REPOSITORY, component, String(process.pid)]
  if (localArchive) args.push(localArchive)
  spawn(nodePath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  }).unref()
  app.quit()
}

async function showAbout() {
  await dialog.showMessageBox({
    type: 'info',
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: [
      `Desktop version: ${getVersion()}`,
      `Harness version: ${getHarnessVersion()}`,
      `Data: ${dataRoot}`,
      `Logs: ${logsRoot}`,
    ].join('\n'),
  })
}

function installAppMenu() {
  Menu.setApplicationMenu(null)
}

async function start() {
  ensureDirectories()
  installAppMenu()
  // Show the window (loading screen) immediately; never block startup on network calls.
  createWindow()
  // Update check runs in the background and must not delay harness startup.
  checkForUpdates().catch(error => console.warn('Update check failed:', error.message))
  const url = await startHarness()
  sendUrlToWindow(url)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox(APP_NAME, error.stack || error.message)
    app.quit()
  })
}

app.on('before-quit', () => {
  shuttingDown = true
  if (harnessProcess && !harnessProcess.killed) {
    harnessProcess.kill()
    harnessProcess = undefined
  }
})

ipcMain.handle('open-log-folder', () => shell.openPath(logsRoot))
ipcMain.handle('restart-harness', () => restartHarness())
ipcMain.handle('check-for-updates', () => checkForUpdates({ manual: true }))
ipcMain.handle('show-about', () => showAbout())
