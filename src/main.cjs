const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray } = require('electron')
const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { compareVersions, parseDshReleaseCommit, portableDataPaths } = require('./portable-paths.cjs')
const {
  MANIFEST_NAME,
  applyRestorePlan,
  availableCategoryIds,
  buildManifest,
  categoryById,
  legacyCategoriesFromEntries,
  parseManifest,
  restoreSources,
  stageBackup,
} = require('./backup-categories.cjs')
const { createTaskTracker } = require('./task-tracker.cjs')
const { frameNotification, frameResolution } = require('./interaction-frames.cjs')

const APP_NAME = 'DshPort'
const DEFAULT_PORT = 3080
const UPDATE_REPOSITORY = process.env.DSH_UPDATE_REPOSITORY || 'KevinZjYang/DshPort'
const SOURCE_REPOSITORY = process.env.DSH_SOURCE_REPOSITORY || 'deepseek-ai/deepseek-harness'
// GitHub 下载代理：直连失败时自动把下载地址拼在代理域名后面重试（默认 gh.yiun.cyou）。
function resolveUpdateProxy() {
  const raw = process.env.DSH_UPDATE_PROXY
  if (raw === '0' || raw === 'off' || raw === 'false') return ''
  return raw || 'https://gh.yiun.cyou/'
}
const UPDATE_PROXY = resolveUpdateProxy()

function proxiedUrl(url) {
  if (!UPDATE_PROXY) return url
  if (url.startsWith(UPDATE_PROXY)) return url
  if (!/^https?:\/\//u.test(url)) return url
  return `${UPDATE_PROXY}${url}`
}
const isPackaged = app.isPackaged
const runtimeRoot = isPackaged ? process.resourcesPath : join(__dirname, '..', 'runtime')
const portableRoot = isPackaged ? dirname(process.execPath) : join(__dirname, '..', '..')
const { dataRoot, dshHome, workspace, logsRoot } = portableDataPaths(portableRoot)
const iconPath = join(__dirname, '..', 'resources', 'icon.ico')
const trayIconPath = join(__dirname, '..', 'resources', 'icon.png')
const updatesDir = join(dataRoot, 'updates')
const settingsFile = join(dataRoot, 'settings.json')

let mainWindow
let harnessProcess
let tray = null
let shuttingDown = false
let quitting = false
let suppressHarnessExitError = false
let restoreInProgress = false
let activeUrl
let pendingUrl
let windowLoaded = false
let backgroundDownload = null
let installPromptOpen = false
let lastProgressLabel = ''
let taskNotifier = null
const TASK_POLL_INTERVAL_MS = 2000
let interactionSocket = null
let interactionReconnectTimer = null
const MUX_RECONNECT_DELAY_MS = 3000
// 活跃的"等待用户响应"通知：key（approval:<id> / question:<rpcId>）→ Notification。
const interactionNotifications = new Map()

function ensureDirectories() {
  for (const path of [dataRoot, dshHome, workspace, logsRoot, updatesDir]) mkdirSync(path, { recursive: true })
  // Clean up stale partial downloads from an interrupted run.
  try {
    for (const file of readdirSync(updatesDir)) {
      if (file.endsWith('.part')) rmSync(join(updatesDir, file), { force: true })
    }
  } catch {}
  cleanupStaleUpdateArtifacts()
}

// 清理上次更新遗留的旧应用备份目录与陈旧临时目录。
// 整包更新成功后，旧目录由独立的清理进程删除；这里兜底处理清理进程未能
// 删除（残留进程锁）或更新中断（改名后未完成）的情况。
function cleanupStaleUpdateArtifacts() {
  const parent = dirname(portableRoot)
  const stem = basename(portableRoot).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const backupPattern = new RegExp(`^${stem}\\.backup-\\d+(\\.failed-\\d+)?$`)
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(parent, entry.name)
      if (backupPattern.test(entry.name)) {
        rmSync(full, { recursive: true, force: true })
      } else if (/^dsh-update-[A-Za-z0-9]{6}$/u.test(entry.name)) {
        // 更新器临时目录与应用同盘（盘符根下）；超过 7 天的视为陈旧现场。
        try {
          if (statSync(full).mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000) {
            rmSync(full, { recursive: true, force: true })
          }
        } catch {}
      }
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
      if (Date.now() - started > timeoutMs) return reject(new Error(`Harness 未在 ${timeoutMs}ms 内启动完成`))
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
  child.once('error', error => {
    logStream.end()
    if (harnessProcess === child) harnessProcess = undefined
    if (!shuttingDown && !suppressHarnessExitError && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(APP_NAME, `无法启动 Harness：${error.message}\n日志：${logPath}`)
      app.quit()
    }
  })
  child.once('exit', (code, signal) => {
    logStream.end()
    if (harnessProcess === child) harnessProcess = undefined
    if (!shuttingDown && !suppressHarnessExitError && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(APP_NAME, `Harness 进程已退出（code=${code ?? 'null'}，signal=${signal ?? 'none'}）。\n日志：${logPath}`)
      app.quit()
    }
  })
  return { logPath }
}

function stopHarness() {
  return new Promise(resolve => {
    const child = harnessProcess
    harnessProcess = undefined
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
    stopTaskNotifier()
    await stopHarness()
    const url = await startHarness()
    startTaskNotifier(url)
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

function sendStatus(text, kind = 'info', percent = undefined) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('app-status', { text, kind, percent })
}

// 任务完成通知：轮询 Harness 的 session.list RPC，跟踪顶层会话 running 翻转，
// 任务结束时弹出 Windows 通知（窗口在前台时静默，避免打扰）。
async function pollSessionList(url) {
  try {
    const response = await fetch(`${url}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.list', payload: {} }),
    })
    if (!response.ok) return []
    const envelope = await response.json()
    if (envelope?.type !== 'server-response' || envelope?.result?.ok !== true) return []
    const items = envelope.result.value?.items
    return Array.isArray(items) ? items : []
  } catch (error) {
    console.warn('Task completion poll failed:', error.message)
    return []
  }
}

function notifyTaskCompleted({ sessionId, title }) {
  const settings = readSettings()
  if (settings.taskNotifications === false) return
  if (!tray) return
  // 用户正盯着界面时不打扰。
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return
  const body = `任务已结束：${title || sessionId}`
  if (Notification.isSupported()) {
    try {
      const notification = new Notification({
        title: APP_NAME,
        body,
        icon: iconPath,
      })
      notification.on('click', () => showMainWindow())
      notification.show()
      return
    } catch (error) {
      console.warn('Windows notification failed, falling back to tray balloon:', error.message)
    }
  }
  try {
    tray.displayBalloon({ iconType: 'info', title: APP_NAME, content: body })
  } catch {}
}

function startTaskNotifier(url) {
  stopTaskNotifier()
  const tracker = createTaskTracker()
  let polling = false
  const timer = setInterval(async () => {
    if (polling) return
    polling = true
    try {
      const items = await pollSessionList(url)
      for (const completed of tracker.ingest(items)) notifyTaskCompleted(completed)
    } finally {
      polling = false
    }
  }, TASK_POLL_INTERVAL_MS)
  timer.unref?.()
  taskNotifier = { tracker, timer, url }
  startInteractionNotifier(url)
}

function stopTaskNotifier() {
  if (!taskNotifier) return
  clearInterval(taskNotifier.timer)
  taskNotifier = null
  stopInteractionNotifier()
}

// 等待用户响应通知：订阅 Harness 的 mux 事件流，AI 请求工具权限或调用
// ask_user_question 时（窗口在后台）弹通知，用户作答后自动关闭通知。
function wsUrlOf(httpUrl, path) {
  return `${httpUrl.replace(/^http:/u, 'ws:')}${path}`
}

function notifyInteraction({ key, title, body }) {
  const settings = readSettings()
  if (settings.interactionNotifications === false) return
  if (!tray) return
  // 用户正盯着界面时不打扰。
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return
  const close = () => {
    interactionNotifications.delete(key)
  }
  if (Notification.isSupported()) {
    try {
      const notification = new Notification({ title: APP_NAME, body, icon: iconPath })
      notification.on('click', () => showMainWindow())
      notification.on('close', close)
      notification.show()
      interactionNotifications.set(key, notification)
      return
    } catch (error) {
      console.warn('Windows notification failed, falling back to tray balloon:', error.message)
    }
  }
  try {
    tray.displayBalloon({ iconType: 'info', title: APP_NAME, content: body })
  } catch {}
}

function connectInteractionSocket(url) {
  if (interactionSocket) return
  let socket
  try {
    socket = new WebSocket(wsUrlOf(url, '/api/events.mux'))
  } catch (error) {
    console.warn('Interaction WebSocket connect failed:', error.message)
    scheduleInteractionReconnect(url)
    return
  }
  socket.onmessage = event => {
    let envelope
    try {
      envelope = JSON.parse(String(event.data))
    } catch {
      return
    }
    const notification = frameNotification(envelope)
    if (notification) {
      notifyInteraction(notification)
      return
    }
    const resolution = frameResolution(envelope)
    if (resolution) {
      const active = interactionNotifications.get(resolution.key)
      if (active) {
        interactionNotifications.delete(resolution.key)
        try { active.close() } catch {}
      }
    }
  }
  socket.onclose = () => {
    if (interactionSocket === socket) interactionSocket = null
    if (!shuttingDown) scheduleInteractionReconnect(url)
  }
  socket.onerror = () => {
    try { socket.close() } catch {}
  }
  interactionSocket = socket
}

function scheduleInteractionReconnect(url) {
  if (interactionReconnectTimer || shuttingDown) return
  interactionReconnectTimer = setTimeout(() => {
    interactionReconnectTimer = null
    connectInteractionSocket(url)
  }, MUX_RECONNECT_DELAY_MS)
  interactionReconnectTimer.unref?.()
}

function startInteractionNotifier(url) {
  stopInteractionNotifier()
  connectInteractionSocket(url)
}

function stopInteractionNotifier() {
  if (interactionReconnectTimer) {
    clearTimeout(interactionReconnectTimer)
    interactionReconnectTimer = null
  }
  if (interactionSocket) {
    try { interactionSocket.close() } catch {}
    interactionSocket = null
  }
  for (const notification of interactionNotifications.values()) {
    try { notification.close() } catch {}
  }
  interactionNotifications.clear()
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
  // 保底显示：ready-to-show 依赖渲染进程完成首次绘制；更新后首次启动时杀软扫描等
  // 因素可能让首次绘制迟迟不来，窗口会一直 hidden（只剩托盘图标）。超时后强制显示，
  // 让用户至少能看到窗口（可能是加载页）。
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }, 8000)
  // shell.html 加载失败不应让窗口永远不可见。
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.warn(`shell load failed: ${code} ${description}`)
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
  // 关闭窗口时最小化到托盘，应用与 Harness 继续在后台运行。
  mainWindow.on('close', event => {
    if (!quitting && tray) {
      event.preventDefault()
      mainWindow.hide()
      if (process.platform === 'win32') {
        try {
          tray.displayBalloon({
            iconType: 'info',
            title: APP_NAME,
            content: 'DshPort 仍在后台运行。点击托盘图标恢复窗口，右键图标可退出。',
          })
        } catch {}
      }
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
          const error = new Error(`更新服务器返回 HTTP ${response.statusCode}`)
          error.statusCode = response.statusCode
          return reject(error)
        }
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    requestRef.on('error', error => {
      cleanup()
      if (error.name === 'AbortError') {
        const timeoutError = new Error(`请求超时：${url}`)
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

function readSettings() {
  try {
    if (!existsSync(settingsFile)) return {}
    return JSON.parse(readFileSync(settingsFile, 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
}

function normalizeTag(tag) {
  return String(tag || '').replace(/^v/u, '')
}

function isIgnoredVersion(tag) {
  const normalized = normalizeTag(tag)
  if (normalized === '') return false
  return (readSettings().ignoredUpdateVersions || []).includes(normalized)
}

function addIgnoredVersion(tag) {
  const normalized = normalizeTag(tag)
  if (normalized === '') return
  const settings = readSettings()
  const ignored = new Set(settings.ignoredUpdateVersions || [])
  ignored.add(normalized)
  settings.ignoredUpdateVersions = [...ignored].sort()
  writeSettings(settings)
}

async function downloadFileOnce(url, target, onProgress, connectTimeoutMs = 20000, idleTimeoutMs = 30000) {
  const controller = new AbortController()
  const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs)
  let response
  try {
    response = await fetch(url, { redirect: 'follow', signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`连接超时：${url}`)
    throw error
  } finally {
    clearTimeout(connectTimer)
  }
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const reader = response.body.getReader()
  const stream = createWriteStream(target)
  let idleTimer
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs)
  }
  try {
    armIdle()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      armIdle()
      if (!stream.write(value)) await new Promise(resolve => stream.once('drain', resolve))
      if (typeof onProgress === 'function') onProgress(received, total)
    }
  } catch (error) {
    stream.destroy()
    if (controller.signal.aborted) throw new Error(`下载超时（${Math.round(idleTimeoutMs / 1000)} 秒无数据）：${url}`)
    throw error
  } finally {
    clearTimeout(idleTimer)
  }
  await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()))
}

// 直连失败时自动改用代理重试一次（如 https://gh.yiun.cyou/<原始下载地址>）。
async function downloadFile(url, target, onProgress) {
  const attempts = [url]
  const fallback = proxiedUrl(url)
  if (fallback !== url) attempts.push(fallback)
  let lastError
  for (const attempt of attempts) {
    try {
      await downloadFileOnce(attempt, target, onProgress)
      return
    } catch (error) {
      lastError = error
      console.warn('Download failed, trying next source:', attempt, '->', error.message)
    }
  }
  throw lastError
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

async function verifyDownloadedChecksum(release, archive, expectedName = basename(archive)) {
  const checksumAsset = release.assets?.find(item => item.name === 'SHA256SUMS.txt')
  if (!checksumAsset) return true
  try {
    const target = join(updatesDir, 'SHA256SUMS.txt')
    await downloadFile(checksumAsset.browser_download_url, target)
    const text = readFileSync(target, 'utf8')
    const expected = text.split(/\r?\n/u).find(line => line.includes(expectedName))?.split(/\s+/u)[0]
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
  const versionLabel = normalizeTag(release.tag_name)
  // 已存在的安装包可能来自旧版本（版本号已变）或已损坏：与当前发布版的校验和不符
  // 时必须删掉重新下载，否则会把旧版本包当成新版本装上（表现为“更新后版本没变”）。
  if (existsSync(archive)) {
    const previousTag = readPendingUpdate()?.tag
    const tagChanged = previousTag !== undefined && normalizeTag(previousTag) !== normalizeTag(release.tag_name)
    const matches = await verifyDownloadedChecksum(release, archive, asset.name)
    if (tagChanged || !matches) {
      rmSync(archive, { force: true })
      try { rmSync(`${archive}.part`, { force: true }) } catch {}
    }
  }
  if (!existsSync(archive)) {
    if (backgroundDownload) return
    backgroundDownload = (async () => {
      const partial = `${archive}.part`
      rmSync(partial, { force: true })
      lastProgressLabel = ''
      await downloadFile(asset.browser_download_url, partial, (received, total) => {
        const pct = total > 0 ? Math.floor((received / total) * 100) : -1
        const label = pct >= 0 ? `${pct}%` : `${Math.round(received / 1048576)} MB`
        if (label !== lastProgressLabel) {
          lastProgressLabel = label
          sendStatus(`正在下载更新 v${versionLabel}… ${label}`, 'info', pct)
        }
      })
      const ok = await verifyDownloadedChecksum(release, partial, asset.name)
      if (!ok) {
        rmSync(partial, { force: true })
        throw new Error('校验和验证失败')
      }
      rmSync(archive, { force: true })
      renameSync(partial, archive)
    })().finally(() => { backgroundDownload = null })
  }
  try {
    await backgroundDownload
  } catch (error) {
    console.warn('Background update download failed:', error.message)
    sendStatus(`更新下载失败：${error.message}`, 'warn')
    return
  }
  if (!existsSync(archive)) return
  writePendingUpdate(pending)
  sendStatus(`更新 v${versionLabel} 已下载完成`, 'ok', 100)
  promptInstallUpdate(pending)
}

async function promptInstallUpdate(pending) {
  if (installPromptOpen) return
  installPromptOpen = true
  try {
    const size = existsSync(pending.archive) ? Math.round(statSync(pending.archive).size / 1048576) : 0
    const versionLabel = normalizeTag(pending.tag)
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: pending.component === 'harness'
        ? `Harness 更新已下载完成（约 ${size} MB）`
        : `DshPort v${versionLabel} 更新已下载完成（约 ${size} MB）`,
      detail: [
        '更新包已在后台下载完成，可以随时安装。',
        '安装时应用会短暂关闭，完成后自动重新启动。',
        'data/ 下的数据会保留。',
        '',
        '“稍后”将在 24 小时后再次提醒；“忽略此版本”将不再提示该版本。',
      ].join('\n'),
      buttons: ['立即安装', '稍后（24 小时后提醒）', '忽略此版本'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) {
      sendStatus('正在安装更新…', 'info')
      await launchUpdater(pending.tag, pending.component, pending.archive)
    } else if (answer.response === 1) {
      pending.remindAfter = Date.now() + 24 * 60 * 60 * 1000
      writePendingUpdate(pending)
      sendStatus(`更新 v${versionLabel} 已推迟，24 小时后再次提醒`, 'info')
    } else if (answer.response === 2) {
      addIgnoredVersion(pending.tag)
      discardPendingUpdate()
      sendStatus(`已忽略版本 v${versionLabel}`, 'info')
    }
  } finally {
    installPromptOpen = false
  }
}

async function confirmDownload(release, component) {
  const asset = release.assets?.find(item =>
    component === 'harness' ? item.name === 'harness-runtime.zip' : /DshPort-win-x64\.zip$/u.test(item.name))
  const size = asset?.size ? `（约 ${Math.round(asset.size / 1048576)} MB）` : ''
  const versionLabel = normalizeTag(release.tag_name)
  const answer = await dialog.showMessageBox({
    type: 'info',
    title: APP_NAME,
    message: component === 'harness'
      ? `发现新的 Harness 版本${size}，是否下载？`
      : `发现新版本 DshPort v${versionLabel}${size}，是否下载？`,
    detail: [
      '更新包将在后台下载，下载完成后会提示安装。',
      '安装时应用会短暂关闭，完成后自动重新启动。',
      'data/ 下的数据会保留。',
    ].join('\n'),
    buttons: ['下载', '忽略此版本', '取消'],
    defaultId: 0,
    cancelId: 2,
  })
  if (answer.response === 1) {
    addIgnoredVersion(release.tag_name)
    sendStatus(`已忽略版本 v${versionLabel}`, 'info')
    return 'ignore'
  }
  return answer.response === 0 ? 'download' : 'cancel'
}

async function checkForUpdates({ manual = false } = {}) {
  if (UPDATE_REPOSITORY === '') {
    if (manual) await checkSourceVersion()
    return
  }
  if (process.env.DSH_DISABLE_UPDATE_CHECK === '1') {
    if (manual) await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '更新检查已被禁用（设置了 DSH_DISABLE_UPDATE_CHECK=1）。' })
    return
  }
  if (!isPackaged) {
    if (manual) await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '更新检查仅在打包版（便携版）应用中可用。' })
    return
  }
  const localVersion = normalizeTag(getVersion())
  try {
    sendStatus('正在检查更新…', 'info')
    const release = await downloadJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`)
    const latest = normalizeTag(release.tag_name)
    const harnessLatest = parseReleaseHarnessVersion(release)
    const harnessLocal = getHarnessVersion()
    const shellOutdated = latest !== '' && latest !== localVersion && compareVersionsSafe(latest, localVersion)
    const harnessOutdated = harnessLatest !== undefined && harnessLatest !== harnessLocal && compareVersionsSafe(harnessLatest, harnessLocal)

    // A previously downloaded update may still be waiting to be installed.
    const pending = readPendingUpdate()
    if (pending) {
      const pendingTag = normalizeTag(pending.tag)
      if (pendingTag !== '' && pendingTag === latest && pendingTag !== localVersion) {
        if (isIgnoredVersion(pendingTag)) {
          discardPendingUpdate()
          sendStatus(`已忽略版本 v${pendingTag}`, 'info')
          return
        }
        // “稍后”提醒：非手动检查且未到提醒时间时不再打扰。
        if (!manual && pending.remindAfter && Date.now() < pending.remindAfter) {
          sendStatus(`更新 v${pendingTag} 已下载，稍后将再次提醒安装`, 'info')
          return
        }
        promptInstallUpdate(pending)
        return
      }
      discardPendingUpdate()
    }

    if (!shellOutdated && !harnessOutdated) {
      sendStatus(`已是最新版本（v${localVersion}）`, 'ok')
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: '当前已是最新版本。',
          detail: `当前版本：v${localVersion}`,
        })
      }
      return
    }

    const outdatedTag = shellOutdated ? latest : harnessLatest
    if (isIgnoredVersion(outdatedTag)) {
      sendStatus(`已忽略版本 v${normalizeTag(outdatedTag)}`, 'info')
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: `版本 v${normalizeTag(outdatedTag)} 已被忽略，不再提示下载。`,
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
      } else {
        sendStatus('更新正在后台下载中…', 'info')
      }
      return
    }

    // 下载前先确认：大更新包不应在用户不知情时静默下载。
    const decision = await confirmDownload(release, shellOutdated ? 'portable' : 'harness')
    if (decision !== 'download') return
    await startBackgroundDownload(release, shellOutdated ? 'portable' : 'harness')
  } catch (error) {
    console.warn('Update check failed:', error.message)
    const pending = readPendingUpdate()
    if (pending && (!pending.remindAfter || Date.now() >= pending.remindAfter)) {
      promptInstallUpdate(pending)
      return
    }
    if (error.statusCode === 404) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: '当前暂无可用更新。',
          detail: `更新源尚无已发布版本：${UPDATE_REPOSITORY}`,
        })
      }
      return
    }
    sendStatus('检查更新失败', 'warn')
    if (manual) {
      await dialog.showMessageBox({
        type: 'warning',
        title: APP_NAME,
        message: '检查更新失败。',
        detail: [
          error.message,
          '',
          '提示：更新包下载时若直连 GitHub 失败，会自动改用代理 https://gh.yiun.cyou/；可用环境变量 DSH_UPDATE_PROXY 自定义（设为 0 或 off 可禁用）。',
        ].join('\n'),
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
        detail: `已检查 ${SOURCE_REPOSITORY} 的提交记录。`,
      })
      return
    }
    if (compareVersions(latest, localVersion) <= 0) {
      await dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: '\u5f53\u524d\u5df2\u662f\u6700\u65b0\u6e90\u7801\u7248\u672c\u3002',
        detail: `当前版本：${localVersion}\n上游最新源码版本：${latest}`,
      })
      return
    }
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: `\u53d1\u73b0\u4e0a\u6e38\u65b0\u7248\u672c\uff1a${latest}`,
      detail: [
        `当前版本：${localVersion}`,
        `上游最新源码版本：${latest}`,
        '',
        '上游仓库本身不提供 Windows 便携包。如需自动更新，请将 DSH_UPDATE_REPOSITORY 配置为 DshPort 的发布仓库。',
      ].join('\n'),
      buttons: ['确定', '打开提交'],
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

async function launchUpdater(tagName, component, localArchive) {
  const updater = join(runtimeRoot, 'updater', 'updater.cjs')
  const nodePath = join(runtimeRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(updater)) {
    dialog.showErrorBox(APP_NAME, `未找到更新程序：${updater}`)
    return
  }
  // 更新会整体替换应用目录：先停掉并等 Harness 退出，释放 resources\node\node.exe
  // 与 resources\harness 里原生插件上的文件锁（before-quit 的 kill 保留为兜底）。
  // 主动停止时先抑制“Harness 意外退出”弹窗，否则用户会看到一个错误的报错框。
  suppressHarnessExitError = true
  if (harnessProcess) {
    try { await stopHarness() } catch {}
  }
  const args = [updater, process.execPath, tagName, UPDATE_REPOSITORY, component, String(process.pid)]
  if (localArchive) args.push(localArchive)
  // Keep the updater's output in data/logs/updater.log so install failures are diagnosable.
  const logStream = createWriteStream(join(logsRoot, 'updater.log'), { flags: 'a' })
  // cwd 必须位于应用根目录之外：更新器要 rename 整个应用目录，
  // 若其工作目录在应用根目录内会报 EBUSY。
  const child = spawn(nodePath, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: dirname(portableRoot),
  })
  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)
  child.once('error', error => {
    try { logStream.write(`\n[updater spawn error] ${error.stack || error.message}\n`) } catch {}
  })
  child.unref()
  app.quit()
}

async function showAbout() {
  const answer = await dialog.showMessageBox({
    type: 'info',
    title: `关于 ${APP_NAME}`,
    message: APP_NAME,
    detail: [
      `桌面版本：v${normalizeTag(getVersion())}`,
      `Harness 版本：${getHarnessVersion()}`,
      `数据目录：${dataRoot}`,
      `日志目录：${logsRoot}`,
    ].join('\n'),
    buttons: ['打开数据目录', '打开日志目录', '确定'],
    defaultId: 2,
    cancelId: 2,
  })
  if (answer.response === 0) shell.openPath(dataRoot)
  else if (answer.response === 1) shell.openPath(logsRoot)
}

function installAppMenu() {
  Menu.setApplicationMenu(null)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  if (quitting) return
  dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: '确定退出 DshPort？',
    detail: '退出后 Harness 将停止运行；会话与数据会保存在 data/ 目录中。',
    buttons: ['取消', '退出'],
    defaultId: 0,
    cancelId: 0,
  }).then(answer => {
    if (answer.response !== 1) return
    quitting = true
    app.quit()
  })
}

// 重启应用：先登记 relaunch 再退出；退出流程（before-quit）会顺带停止 Harness。
function restartApp() {
  if (quitting) return
  app.relaunch()
  app.quit()
}

function createTray() {
  if (tray) return
  const trayIcon = existsSync(trayIconPath) ? trayIconPath : iconPath
  tray = new Tray(trayIcon)
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    {
      label: '任务完成通知',
      type: 'checkbox',
      checked: readSettings().taskNotifications !== false,
      click: item => writeSettings({ ...readSettings(), taskNotifications: item.checked }),
    },
    {
      label: '等待用户响应通知',
      type: 'checkbox',
      checked: readSettings().interactionNotifications !== false,
      click: item => writeSettings({ ...readSettings(), interactionNotifications: item.checked }),
    },
    { type: 'separator' },
    { label: '重启 Harness', click: () => restartHarness() },
    { label: '检查更新', click: () => checkForUpdates({ manual: true }) },
    { label: '备份数据…', click: () => backupData() },
    { label: '恢复备份…', click: () => restoreData() },
    { label: '创建快捷方式', click: () => createShortcutsDialog() },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(dataRoot) },
    { label: '打开日志目录', click: () => shell.openPath(logsRoot) },
    { type: 'separator' },
    { label: '重启', click: restartApp },
    { label: '退出', click: quitApp },
  ]))
  tray.on('double-click', showMainWindow)
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`${command} ${args.join(' ')} 执行失败（exit ${code}）：${stderr.trim().slice(0, 300)}`))
    })
  })
}

// Windows 10 1803+ 自带 bsdtar，项目打包流程已依赖 tar 生成 zip。
// 备份按内容类别组织（见 backup-categories.cjs）：工作区记录、Harness 设置、软件设置；
// 不含日志、更新包以及可重新生成的依赖（node_modules）。
async function createDataBackup(targetZip, categories) {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
  try {
    stageBackup(dataRoot, staging, categories)
    const manifest = buildManifest({
      appVersion: getVersion(),
      harnessVersion: getHarnessVersion(),
      categories,
    })
    writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2))
    await runCommand('tar.exe', ['-a', '-cf', targetZip, '-C', staging, '.'])
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

// —— 备份/恢复类别选择窗口与统计 ——

let pickerPending = null

async function openCategoryPicker({ mode, title, detail, categories }) {
  if (pickerPending) return { canceled: true, selected: [] }
  return new Promise(resolve => {
    const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined
    pickerPending = { resolve, options: { mode, title, detail, categories } }
    const win = new BrowserWindow({
      width: 560,
      height: 620,
      resizable: false,
      minimizable: false,
      maximizable: false,
      parent,
      modal: Boolean(parent),
      title,
      show: false,
      backgroundColor: '#f7f8fa',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, 'picker-preload.cjs'),
      },
    })
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      const pending = pickerPending
      pickerPending = null
      if (pending) pending.resolve({ canceled: true, selected: [] })
    })
    win.loadFile(join(__dirname, 'picker.html'))
  })
}

function directorySize(dir, { exclude = [] } = {}) {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || exclude.includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) total += directorySize(full, { exclude })
      else if (entry.isFile()) {
        try { total += statSync(full).size } catch {}
      }
    }
  } catch {}
  return total
}

function fileSize(path) {
  try { return existsSync(path) ? statSync(path).size : 0 } catch { return 0 }
}

function computeBackupCategorySizes() {
  return {
    'workspace-records':
      directorySize(join(dshHome, 'sessions')) +
      directorySize(join(dshHome, 'storages')) +
      directorySize(workspace),
    'harness-settings': directorySize(dshHome, { exclude: ['sessions', 'storages'] }),
    'app-settings': fileSize(settingsFile),
  }
}

function restoreCategorySize(tempRoot, id, legacy) {
  const plan = restoreSources({ tempRoot, dataRoot: tempRoot, categories: [id], legacy })
  let total = 0
  for (const item of plan) {
    if (item.kind === 'file') total += fileSize(item.from)
    else total += directorySize(item.from)
  }
  return total
}

// 软件设置恢复后，托盘菜单里的开关状态需要按新 settings.json 重建。
function refreshTray() {
  try {
    if (tray) {
      tray.destroy()
      tray = null
    }
  } catch {}
  createTray()
}

async function createShortcuts(mode) {
  const script = [
    'param($Mode, $Target, $WorkDir, $Icon)',
    '$ws = New-Object -ComObject WScript.Shell',
    'function New-Lnk($folder) {',
    "  $lnk = Join-Path $folder 'DshPort.lnk'",
    '  $s = $ws.CreateShortcut($lnk)',
    '  $s.TargetPath = $Target',
    '  $s.WorkingDirectory = $WorkDir',
    '  $s.IconLocation = "$Icon,0"',
    "  $s.Description = 'DshPort'",
    '  $s.Save()',
    '  Write-Output ("CREATED " + $lnk)',
    '}',
    "if ($Mode -eq 'desktop' -or $Mode -eq 'both') { New-Lnk ([Environment]::GetFolderPath('Desktop')) }",
    "if ($Mode -eq 'startmenu' -or $Mode -eq 'both') { New-Lnk ([Environment]::GetFolderPath('Programs')) }",
  ].join('\n')
  const scriptFile = join(app.getPath('temp'), 'dshport-create-shortcut.ps1')
  writeFileSync(scriptFile, script)
  try {
    const { stdout } = await runCommand('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
      '-Mode', mode, '-Target', process.execPath, '-WorkDir', portableRoot, '-Icon', iconPath,
    ])
    return (stdout.match(/^CREATED (.+)$/gmu) || []).map(line => line.replace(/^CREATED /u, '').trim())
  } finally {
    rmSync(scriptFile, { force: true })
  }
}

async function createShortcutsDialog() {
  if (!isPackaged) {
    await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '创建快捷方式仅在打包版（便携版）应用中可用。' })
    return
  }
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: '创建快捷方式',
    detail: [
      '在桌面和/或开始菜单创建 DshPort 启动快捷方式。',
      `程序位置：${process.execPath}`,
      '提示：移动 DshPort 文件夹后需重新创建。',
    ].join('\n'),
    buttons: ['桌面', '开始菜单', '桌面和开始菜单', '取消'],
    defaultId: 2,
    cancelId: 3,
  })
  const mode = ['desktop', 'startmenu', 'both'][answer.response]
  if (!mode) return
  sendStatus('正在创建快捷方式…', 'info')
  try {
    const created = await createShortcuts(mode)
    sendStatus(`已创建快捷方式：${created.length} 个`, 'ok')
    await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: '快捷方式已创建。',
      detail: created.length ? created.join('\n') : '未创建任何快捷方式。',
      buttons: ['确定'],
    })
  } catch (error) {
    console.warn('Create shortcuts failed:', error.message)
    sendStatus('创建快捷方式失败', 'warn')
    await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '创建快捷方式失败。',
      detail: error.message,
    })
  }
}

// 首次启动只询问一次是否创建桌面快捷方式（记录在 data/settings.json）。
function maybePromptShortcut() {
  if (!isPackaged) return
  const settings = readSettings()
  if (settings.shortcutPrompted === true) return
  writeSettings({ ...settings, shortcutPrompted: true })
  dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: '是否创建桌面快捷方式？',
    detail: '创建后双击桌面图标即可启动 DshPort（仅首次启动询问一次）。',
    buttons: ['创建桌面快捷方式', '暂不创建'],
    defaultId: 0,
    cancelId: 1,
  }).then(async answer => {
    if (answer.response !== 0) return
    sendStatus('正在创建快捷方式…', 'info')
    try {
      const created = await createShortcuts('desktop')
      sendStatus('已创建桌面快捷方式', 'ok')
      if (created.length === 0) {
        await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '未找到桌面目录，未创建快捷方式。' })
      }
    } catch (error) {
      console.warn('Create desktop shortcut failed:', error.message)
      sendStatus('创建快捷方式失败', 'warn')
      await dialog.showMessageBox({ type: 'warning', title: APP_NAME, message: '创建桌面快捷方式失败。', detail: error.message })
    }
  })
}

async function backupData() {
  // 备份按类别选择（默认全选）：工作区记录、Harness 设置、软件设置。
  const ids = availableCategoryIds(dataRoot)
  if (ids.length === 0) {
    await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '没有可备份的数据。',
      detail: `数据目录：${dataRoot}`,
    })
    return
  }
  const sizes = computeBackupCategorySizes()
  const categories = ids.map(id => {
    const def = categoryById(id)
    return { id, label: def.label, description: def.description, size: sizes[id] || 0, checked: true }
  })
  const pick = await openCategoryPicker({
    mode: 'backup',
    title: '备份数据 — 选择内容',
    detail: [
      '选择要备份的内容（可多选，默认全选）。',
      '提示：备份体积主要来自工作区记录（会话历史），可按需取消勾选来控制备份文件大小。',
      '注意：Harness 设置中包含 API 凭据（.credentials.yaml），请妥善保管备份文件。',
    ].join('\n'),
    categories,
  })
  if (pick.canceled || pick.selected.length === 0) return
  const selected = pick.selected
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19).replace('T', '-')
  const result = await dialog.showSaveDialog({
    title: '备份数据',
    defaultPath: join(app.getPath('downloads'), `DshPort-数据备份-${stamp}.zip`),
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  })
  if (result.canceled || !result.filePath) return
  const target = result.filePath
  sendStatus('正在备份数据…', 'info')
  try {
    await createDataBackup(target, selected)
    sendStatus('数据备份完成', 'ok')
    const labels = selected.map(id => categoryById(id).label).join('、')
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: '数据备份完成。',
      detail: [
        `包含内容：${labels}`,
        '注意：备份包含 API 凭据（.credentials.yaml），请妥善保管备份文件。',
        target,
      ].join('\n'),
      buttons: ['打开所在文件夹', '确定'],
      defaultId: 1,
      cancelId: 1,
    })
    if (answer.response === 0) shell.openPath(dirname(target))
  } catch (error) {
    console.warn('Data backup failed:', error.message)
    sendStatus('数据备份失败', 'warn')
    await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '数据备份失败。',
      detail: error.message,
    })
  }
}

async function restoreData() {
  if (restoreInProgress) return
  const result = await dialog.showOpenDialog({
    title: '恢复数据备份',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const archive = result.filePaths[0]
  const temp = join(app.getPath('temp'), `dsh-restore-${Date.now()}`)
  try {
    mkdirSync(temp, { recursive: true })
    await runCommand('tar.exe', ['-xf', archive, '-C', temp])
    // 识别备份格式：优先读清单；旧版备份（无清单）按顶层条目推断。
    const manifestText = existsSync(join(temp, MANIFEST_NAME))
      ? readFileSync(join(temp, MANIFEST_NAME), 'utf8')
      : null
    const manifest = manifestText ? parseManifest(manifestText) : null
    const legacy = !manifest
    const categories = manifest
      ? manifest.categories
      : legacyCategoriesFromEntries(readdirSync(temp).filter(name => name !== MANIFEST_NAME))
    if (categories.length === 0) {
      throw new Error('备份文件格式不正确：未找到可恢复的内容（工作区记录 / Harness 设置 / 软件设置）')
    }
    const infoLines = []
    if (manifest) {
      if (manifest.createdAt) infoLines.push(`备份时间：${new Date(manifest.createdAt).toLocaleString()}`)
      if (manifest.appVersion) infoLines.push(`DshPort 版本：${manifest.appVersion}`)
      if (manifest.harnessVersion) infoLines.push(`Harness 版本：${manifest.harnessVersion}`)
    } else {
      infoLines.push('旧版备份（无内容清单，自动识别类别）')
    }
    const pick = await openCategoryPicker({
      mode: 'restore',
      title: '恢复数据备份 — 选择内容',
      detail: [
        '选择要恢复的内容（可多选）。恢复将覆盖当前对应数据。',
        ...infoLines,
      ].join('\n'),
      categories: categories.map(id => {
        const def = categoryById(id)
        return { id, label: def.label, description: def.description, size: restoreCategorySize(temp, id, legacy) }
      }),
    })
    if (pick.canceled || pick.selected.length === 0) return
    const selected = pick.selected
    const answer = await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '恢复备份将覆盖所选内容对应的当前数据。',
      detail: [
        `将恢复：${selected.map(id => categoryById(id).label).join('、')}`,
        '日志与更新文件不会被覆盖。',
        '恢复期间 Harness 会短暂停止（如需），完成后自动重启。',
        `备份文件：${archive}`,
      ].join('\n'),
      buttons: ['取消', '继续恢复'],
      defaultId: 0,
      cancelId: 0,
    })
    if (answer.response !== 1) return
    restoreInProgress = true
    suppressHarnessExitError = true
    sendStatus('正在恢复数据备份…', 'info')
    stopTaskNotifier()
    // 工作区记录 / Harness 设置可能正被 Harness 占用，先停掉再恢复。
    const needsRestart = selected.some(id => id === 'workspace-records' || id === 'harness-settings')
    if (needsRestart) {
      await stopHarness()
      // 给杀毒软件/文件系统一点时间释放句柄。
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const plan = restoreSources({ tempRoot: temp, dataRoot, categories: selected, legacy })
    if (plan.length === 0) {
      throw new Error('备份文件中未找到所选内容')
    }
    const restored = applyRestorePlan(plan)
    ensureDirectories()
    if (needsRestart) {
      const url = await startHarness()
      startTaskNotifier(url)
      sendUrlToWindow(url)
    }
    if (restored.includes('app-settings')) refreshTray()
    sendStatus('数据备份恢复完成', 'ok')
    await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: '数据备份恢复完成。',
      detail: `已恢复：${restored.map(id => categoryById(id).label).join('、')}`,
    })
  } catch (error) {
    console.warn('Data restore failed:', error.message)
    sendStatus('数据恢复失败', 'warn')
    await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '数据恢复失败。',
      detail: error.message,
    })
    // 无论恢复结果如何，都尽量把 Harness 拉起来。
    try {
      if (!harnessProcess) {
        const url = await startHarness()
        startTaskNotifier(url)
        sendUrlToWindow(url)
      }
    } catch {}
  } finally {
    restoreInProgress = false
    suppressHarnessExitError = false
    try { rmSync(temp, { recursive: true, force: true }) } catch {}
  }
}

async function start() {
  ensureDirectories()
  installAppMenu()
  // Show the window (loading screen) immediately; never block startup on network calls.
  createWindow()
  createTray()
  // Update check runs in the background and must not delay harness startup.
  checkForUpdates().catch(error => console.warn('Update check failed:', error.message))
  const url = await startHarness()
  startTaskNotifier(url)
  sendUrlToWindow(url)
  // 首次启动延迟询问是否创建桌面快捷方式。
  setTimeout(maybePromptShortcut, 5000)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.kevinzjyang.dshport')
    return start()
  }).catch(error => {
    dialog.showErrorBox(APP_NAME, error.stack || error.message)
    app.quit()
  })
}

app.on('before-quit', () => {
  shuttingDown = true
  quitting = true
  stopTaskNotifier()
  if (harnessProcess && !harnessProcess.killed) {
    harnessProcess.kill()
    harnessProcess = undefined
  }
})

// 窗口关闭只是隐藏到托盘；生命周期由托盘菜单的“退出”控制。
app.on('window-all-closed', () => {})

ipcMain.handle('open-log-folder', () => shell.openPath(logsRoot))
ipcMain.handle('open-data-folder', () => shell.openPath(dataRoot))
ipcMain.handle('restart-harness', () => restartHarness())
ipcMain.handle('check-for-updates', () => checkForUpdates({ manual: true }))
ipcMain.handle('show-about', () => showAbout())
ipcMain.handle('backup-data', () => backupData())
ipcMain.handle('restore-data', () => restoreData())
ipcMain.handle('picker-get-options', () => (pickerPending && pickerPending.options) || null)
ipcMain.handle('picker-submit', (_event, result) => {
  const pending = pickerPending
  if (!pending) return
  pickerPending = null
  pending.resolve({
    canceled: Boolean(result && result.canceled === true),
    selected: Array.isArray(result && result.selected) ? result.selected : [],
  })
})
ipcMain.handle('create-shortcuts', () => createShortcutsDialog())
ipcMain.handle('data-manage', async () => {
  const answer = await dialog.showMessageBox({
    type: 'info',
    title: APP_NAME,
    message: '数据管理',
    detail: [
      `数据目录：${dataRoot}`,
      '备份与恢复均支持按内容类别选择：工作区记录、Harness 设置、软件设置。',
      '日志与更新文件不会备份。',
    ].join('\n'),
    buttons: ['备份数据', '恢复备份', '取消'],
    defaultId: 0,
    cancelId: 2,
  })
  if (answer.response === 0) await backupData()
  else if (answer.response === 1) await restoreData()
})

