// 数据备份类别：类别元数据、备份清单（manifest）与 备份/恢复 的文件布局。
// 纯逻辑模块（除文件复制外无 Electron 依赖），便于单元测试。
//
// 备份 zip 布局（v2，清单文件 dshport-backup.json 位于 zip 根目录）：
//   dshport-backup.json        备份清单（格式、时间、版本、包含的类别）
//   workspace-records/         工作区记录：sessions/、storages/（来自 dsh-home）、workspace/
//   harness-settings/          Harness 设置：dsh-home 中除 sessions/storages 外的内容
//   app-settings/              软件设置：settings.json
//
// 旧版备份（无清单，顶层为 dsh-home/ 与 workspace/）仍可恢复：
//   dsh-home/ 可拆分为 工作区记录（sessions、storages）与 Harness 设置（其余）。

const { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } = require('node:fs')
const { dirname, join, relative, sep } = require('node:path')

const MANIFEST_NAME = 'dshport-backup.json'
const MANIFEST_FORMAT = 'dshport-backup'
const MANIFEST_VERSION = 2

const CATEGORIES = {
  'workspace-records': {
    id: 'workspace-records',
    label: '工作区记录',
    description: '会话历史、工作区索引与工作区文件（sessions、storages、workspace）',
  },
  'harness-settings': {
    id: 'harness-settings',
    label: 'Harness 设置',
    description: 'Harness 用户设置、凭据与插件配置（settings.yaml、.credentials.yaml、profiles 等，不含会话记录）',
  },
  'app-settings': {
    id: 'app-settings',
    label: '软件设置',
    description: 'DshPort 应用设置（通知开关、忽略的更新版本、快捷方式提示等 settings.json）',
  },
}

function categoryList() {
  return Object.values(CATEGORIES)
}

function categoryById(id) {
  return CATEGORIES[id] || null
}

// 备份收集计划：dataRoot 下每个源 → staging/<target> 的相对路径。
// exclude 为复制源目录时排除的首层条目名（对 harness-settings 排除 sessions/storages）。
function collectSources(dataRoot, categories) {
  const plan = []
  const add = (category, source, target, exclude = []) => {
    plan.push({ category, source: join(dataRoot, source), target, exclude })
  }
  if (categories.includes('workspace-records')) {
    add('workspace-records', join('dsh-home', 'sessions'), join('workspace-records', 'sessions'))
    add('workspace-records', join('dsh-home', 'storages'), join('workspace-records', 'storages'))
    add('workspace-records', 'workspace', join('workspace-records', 'workspace'))
  }
  if (categories.includes('harness-settings')) {
    add('harness-settings', 'dsh-home', 'harness-settings', ['sessions', 'storages'])
  }
  if (categories.includes('app-settings')) {
    add('app-settings', 'settings.json', join('app-settings', 'settings.json'))
  }
  return plan
}

// 当前 dataRoot 下实际有内容、可被备份的类别 id。
function availableCategoryIds(dataRoot) {
  return categoryList()
    .filter(category => collectSources(dataRoot, [category.id]).some(item => existsSync(item.source)))
    .map(category => category.id)
}

// 复制 source 到 target，排除：路径中任何名为 node_modules 的组件，
// 以及 exclude 指定的首层条目名。
function copyBackupSource(source, target, { exclude = [] } = {}) {
  cpSync(source, target, {
    recursive: true,
    filter: src => {
      if (src === source) return true
      const parts = relative(source, src).split(sep)
      if (exclude.includes(parts[0])) return false
      return !parts.includes('node_modules')
    },
  })
}

// 把选中类别的数据收集到 stagingRoot 下（供 tar 打包）。缺失的源自动跳过。
function stageBackup(dataRoot, stagingRoot, categories) {
  for (const item of collectSources(dataRoot, categories)) {
    if (!existsSync(item.source)) continue
    const target = join(stagingRoot, item.target)
    mkdirSync(dirname(target), { recursive: true })
    copyBackupSource(item.source, target, { exclude: item.exclude })
  }
}

function buildManifest({ appVersion, harnessVersion, categories, createdAt = new Date().toISOString() }) {
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    createdAt,
    appVersion: String(appVersion || ''),
    harnessVersion: String(harnessVersion || ''),
    categories: categories.map(id => {
      const def = categoryById(id)
      return def ? { id: def.id, label: def.label, description: def.description } : null
    }).filter(Boolean),
  }
}

function parseManifest(text) {
  try {
    const data = JSON.parse(text)
    if (!data || data.format !== MANIFEST_FORMAT || data.version !== MANIFEST_VERSION) return null
    const categories = Array.isArray(data.categories)
      ? data.categories.map(item => item && CATEGORIES[item.id] ? item.id : null).filter(Boolean)
      : []
    if (categories.length === 0) return null
    return {
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
      appVersion: typeof data.appVersion === 'string' ? data.appVersion : '',
      harnessVersion: typeof data.harnessVersion === 'string' ? data.harnessVersion : '',
      categories,
    }
  } catch {
    return null
  }
}

// 旧版备份（无清单）按顶层条目推断可用类别。
function legacyCategoriesFromEntries(entries) {
  const list = Array.isArray(entries) ? entries : []
  const has = name => list.some(entry => entry === name || entry === `${name}/` || entry.startsWith(`${name}/`))
  const ids = []
  if (has('dsh-home')) ids.push('workspace-records', 'harness-settings')
  if (has('workspace') && !ids.includes('workspace-records')) ids.push('workspace-records')
  return ids
}

// 恢复计划：解压目录（tempRoot）中的内容 → dataRoot 中的目标位置。
// legacy=true 表示旧版 zip（顶层 dsh-home/、workspace/）。
function restoreSources({ tempRoot, dataRoot, categories, legacy }) {
  const plan = []
  const add = (category, from, to, kind = 'dir', extra = {}) => {
    plan.push({ category, from: join(tempRoot, from), to: join(dataRoot, to), kind, ...extra })
  }
  if (categories.includes('workspace-records')) {
    const base = legacy ? 'dsh-home' : 'workspace-records'
    add('workspace-records', join(base, 'sessions'), join('dsh-home', 'sessions'))
    add('workspace-records', join(base, 'storages'), join('dsh-home', 'storages'))
    add('workspace-records', legacy ? 'workspace' : join('workspace-records', 'workspace'), 'workspace')
  }
  if (categories.includes('harness-settings')) {
    const base = legacy ? 'dsh-home' : 'harness-settings'
    add('harness-settings', base, 'dsh-home', 'dir', {
      merge: true,
      exclude: legacy ? ['sessions', 'storages'] : [],
    })
  }
  if (categories.includes('app-settings')) {
    add('app-settings', join('app-settings', 'settings.json'), 'settings.json', 'file')
  }
  return plan.filter(item => existsSync(item.from))
}

function restoreFile(from, to, timestamp) {
  const backup = `${to}.bak-${timestamp}`
  if (existsSync(to)) renameSync(to, backup)
  try {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  } catch (error) {
    rmSync(to, { force: true })
    if (existsSync(backup)) renameSync(backup, to)
    throw error
  }
  rmSync(backup, { force: true })
}

// 整体替换：目标先改名为 .bak，复制成功后再删除 .bak；失败则回滚。
function restoreReplace(from, to, timestamp) {
  const backup = `${to}.bak-${timestamp}`
  if (existsSync(to)) renameSync(to, backup)
  try {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  } catch (error) {
    rmSync(to, { recursive: true, force: true })
    if (existsSync(backup)) renameSync(backup, to)
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
}

// 合并式恢复：把 from 目录下的条目逐个复制进 to（覆盖同名），
// 不删除 to 中 from 没有的条目。exclude 为跳过 from 内的首层条目名。
function restoreMerged(from, to, exclude, timestamp) {
  if (!existsSync(to)) mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue
    restoreReplace(join(from, entry.name), join(to, entry.name), timestamp)
  }
}

// 按恢复计划执行，返回实际恢复的类别 id 列表。
function applyRestorePlan(plan, { timestamp = Date.now() } = {}) {
  const restored = []
  for (const item of plan) {
    if (item.kind === 'file') restoreFile(item.from, item.to, timestamp)
    else if (item.merge) restoreMerged(item.from, item.to, item.exclude || [], timestamp)
    else restoreReplace(item.from, item.to, timestamp)
    if (!restored.includes(item.category)) restored.push(item.category)
  }
  return restored
}

module.exports = {
  CATEGORIES,
  MANIFEST_FORMAT,
  MANIFEST_NAME,
  MANIFEST_VERSION,
  applyRestorePlan,
  availableCategoryIds,
  buildManifest,
  categoryById,
  categoryList,
  collectSources,
  copyBackupSource,
  legacyCategoriesFromEntries,
  parseManifest,
  restoreSources,
  stageBackup,
}
