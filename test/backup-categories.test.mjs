import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATEGORIES,
  applyRestorePlan,
  availableCategoryIds,
  buildManifest,
  categoryById,
  categoryList,
  legacyCategoriesFromEntries,
  parseManifest,
  restoreSources,
  stageBackup,
} from '../src/backup-categories.cjs'

// 旧版布局（data 目录）：dsh-home/ + workspace/ + settings.json
function makeDataRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cat-test-'))
  mkdirSync(join(root, 'dsh-home', 'sessions', 'ws1', 'session-1'), { recursive: true })
  mkdirSync(join(root, 'dsh-home', 'storages'), { recursive: true })
  mkdirSync(join(root, 'dsh-home', 'profiles', 'web'), { recursive: true })
  mkdirSync(join(root, 'dsh-home', 'profiles', 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  writeFileSync(join(root, 'dsh-home', 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: t\n')
  writeFileSync(join(root, 'dsh-home', '.credentials.yaml'), 'token: secret\n')
  writeFileSync(join(root, 'dsh-home', 'sessions', 'ws1', 'session-1', 'session.jsonl.zstd'), 'data\n')
  writeFileSync(join(root, 'dsh-home', 'storages', 'workspace.json'), '{}')
  writeFileSync(join(root, 'dsh-home', 'profiles', 'web', 'cordis.yml'), 'web: true\n')
  writeFileSync(join(root, 'dsh-home', 'profiles', 'node_modules', 'pkg', 'index.js'), 'x')
  writeFileSync(join(root, 'workspace', 'notes.txt'), 'hello')
  writeFileSync(join(root, 'settings.json'), '{"shortcutPrompted": true}')
  return root
}

// 新版备份解压后的布局：workspace-records/ + harness-settings/ + app-settings/
function makeExtractedBackup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extracted-'))
  mkdirSync(join(root, 'workspace-records', 'sessions', 'ws1', 'session-1'), { recursive: true })
  mkdirSync(join(root, 'workspace-records', 'storages'), { recursive: true })
  mkdirSync(join(root, 'workspace-records', 'workspace'), { recursive: true })
  mkdirSync(join(root, 'harness-settings', 'profiles', 'web'), { recursive: true })
  mkdirSync(join(root, 'app-settings'), { recursive: true })
  writeFileSync(join(root, 'workspace-records', 'sessions', 'ws1', 'session-1', 'session.jsonl.zstd'), 'data\n')
  writeFileSync(join(root, 'workspace-records', 'storages', 'workspace.json'), '{}')
  writeFileSync(join(root, 'workspace-records', 'workspace', 'notes.txt'), 'hello')
  writeFileSync(join(root, 'harness-settings', 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: t\n')
  writeFileSync(join(root, 'harness-settings', '.credentials.yaml'), 'token: secret\n')
  writeFileSync(join(root, 'harness-settings', 'profiles', 'web', 'cordis.yml'), 'web: true\n')
  writeFileSync(join(root, 'app-settings', 'settings.json'), '{"shortcutPrompted": true}')
  return root
}

function posix(path) {
  return path.replace(/\\/gu, '/')
}

test('category metadata exposes the three expected categories', () => {
  const ids = categoryList().map(category => category.id)
  assert.deepEqual(ids, ['workspace-records', 'harness-settings', 'app-settings'])
  for (const id of ids) {
    assert.ok(categoryById(id), `categoryById(${id})`)
    assert.ok(categoryById(id).label)
    assert.ok(categoryById(id).description)
  }
  assert.equal(categoryById('nope'), null)
  assert.equal(CATEGORIES['workspace-records'].id, 'workspace-records')
})

test('manifest round-trips and rejects garbage', () => {
  const manifest = buildManifest({
    appVersion: '0.1.0',
    harnessVersion: '0.2.0',
    categories: ['workspace-records', 'harness-settings', 'app-settings'],
    createdAt: '2026-08-17T00:00:00.000Z',
  })
  const parsed = parseManifest(JSON.stringify(manifest))
  assert.ok(parsed)
  assert.equal(parsed.appVersion, '0.1.0')
  assert.equal(parsed.harnessVersion, '0.2.0')
  assert.equal(parsed.createdAt, '2026-08-17T00:00:00.000Z')
  assert.deepEqual(parsed.categories, ['workspace-records', 'harness-settings', 'app-settings'])
  assert.equal(parseManifest('not json'), null)
  assert.equal(parseManifest('{"format":"other","version":2,"categories":[]}'), null)
  assert.equal(parseManifest('{"format":"dshport-backup","version":2,"categories":[{"id":"unknown"}]}'), null)
})

test('manifest skips unknown categories but keeps known ones', () => {
  const manifest = buildManifest({ appVersion: '1', harnessVersion: '1', categories: ['workspace-records', 'unknown'] })
  const parsed = parseManifest(JSON.stringify(manifest))
  assert.deepEqual(parsed.categories, ['workspace-records'])
})

test('legacy zips are detected from top-level entries', () => {
  assert.deepEqual(legacyCategoriesFromEntries(['dsh-home/', 'workspace/']), ['workspace-records', 'harness-settings'])
  assert.deepEqual(legacyCategoriesFromEntries(['dsh-home/settings.yaml', 'dsh-home/sessions/']), ['workspace-records', 'harness-settings'])
  assert.deepEqual(legacyCategoriesFromEntries(['workspace/']), ['workspace-records'])
  assert.deepEqual(legacyCategoriesFromEntries([]), [])
})

test('staging collects categories into the expected layout and excludes node_modules', () => {
  const root = makeDataRoot()
  const staging = mkdtempSync(join(tmpdir(), 'dsh-stage-test-'))
  try {
    stageBackup(root, staging, ['workspace-records', 'harness-settings', 'app-settings'])
    assert.ok(existsSync(join(staging, 'workspace-records', 'sessions', 'ws1', 'session-1', 'session.jsonl.zstd')))
    assert.ok(existsSync(join(staging, 'workspace-records', 'storages', 'workspace.json')))
    assert.ok(existsSync(join(staging, 'workspace-records', 'workspace', 'notes.txt')))
    assert.ok(existsSync(join(staging, 'harness-settings', 'settings.yaml')))
    assert.ok(existsSync(join(staging, 'harness-settings', '.credentials.yaml')))
    assert.ok(existsSync(join(staging, 'harness-settings', 'profiles', 'web', 'cordis.yml')))
    assert.ok(existsSync(join(staging, 'app-settings', 'settings.json')))
    // 会话记录不属于 Harness 设置
    assert.equal(existsSync(join(staging, 'harness-settings', 'sessions')), false)
    assert.equal(existsSync(join(staging, 'harness-settings', 'storages')), false)
    // node_modules 一律排除
    assert.equal(existsSync(join(staging, 'harness-settings', 'profiles', 'node_modules')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
  }
})

test('staging only includes selected categories', () => {
  const root = makeDataRoot()
  const staging = mkdtempSync(join(tmpdir(), 'dsh-stage-test-'))
  try {
    stageBackup(root, staging, ['app-settings'])
    assert.ok(existsSync(join(staging, 'app-settings', 'settings.json')))
    assert.equal(existsSync(join(staging, 'workspace-records')), false)
    assert.equal(existsSync(join(staging, 'harness-settings')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
  }
})

test('availableCategoryIds reflects present data', () => {
  const root = makeDataRoot()
  try {
    assert.deepEqual(availableCategoryIds(root).sort(), ['app-settings', 'harness-settings', 'workspace-records'])
    rmSync(join(root, 'dsh-home'), { recursive: true, force: true })
    rmSync(join(root, 'settings.json'), { force: true })
    assert.deepEqual(availableCategoryIds(root), ['workspace-records'])
    rmSync(join(root, 'workspace'), { recursive: true, force: true })
    assert.deepEqual(availableCategoryIds(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restoreSources maps new-format and legacy zips', () => {
  const extracted = makeExtractedBackup()
  const legacy = makeDataRoot()
  try {
    const plan = restoreSources({
      tempRoot: extracted,
      dataRoot: 'DATA',
      categories: ['workspace-records', 'harness-settings', 'app-settings'],
      legacy: false,
    })
    const root = posix(extracted)
    assert.ok(plan.some(item => posix(item.from) === `${root}/workspace-records/sessions` && item.to === join('DATA', 'dsh-home', 'sessions')))
    assert.ok(plan.some(item => posix(item.from) === `${root}/workspace-records/workspace` && item.to === join('DATA', 'workspace')))
    const merge = plan.find(item => item.category === 'harness-settings')
    assert.equal(merge.merge, true)
    assert.equal(merge.to, join('DATA', 'dsh-home'))
    assert.ok(plan.some(item => item.category === 'app-settings' && item.kind === 'file' && item.to === join('DATA', 'settings.json')))

    // 旧格式：harness-settings 从 dsh-home 取，恢复时跳过 sessions/storages
    const legacyPlan = restoreSources({ tempRoot: legacy, dataRoot: 'DATA', categories: ['harness-settings'], legacy: true })
    const legacyMerge = legacyPlan.find(item => item.category === 'harness-settings')
    assert.deepEqual(legacyMerge.exclude, ['sessions', 'storages'])
    // 旧格式 workspace 取自顶层
    const legacyWs = restoreSources({ tempRoot: legacy, dataRoot: 'DATA', categories: ['workspace-records'], legacy: true })
    assert.ok(legacyWs.some(item => posix(item.from) === `${posix(legacy)}/workspace` && item.to === join('DATA', 'workspace')))
  } finally {
    rmSync(extracted, { recursive: true, force: true })
    rmSync(legacy, { recursive: true, force: true })
  }
})

test('applyRestorePlan replaces, merges and cleans up .bak files', () => {
  const backup = makeExtractedBackup()
  const data = mkdtempSync(join(tmpdir(), 'dsh-restore-test-'))
  try {
    // 构造“当前”数据：与备份不同的内容 + 备份中没有的会话（合并时必须保留）
    mkdirSync(join(data, 'dsh-home', 'sessions', 'current-ws'), { recursive: true })
    mkdirSync(join(data, 'dsh-home', 'storages'), { recursive: true })
    mkdirSync(join(data, 'workspace'), { recursive: true })
    writeFileSync(join(data, 'dsh-home', 'settings.yaml'), 'OLD-SETTINGS\n')
    writeFileSync(join(data, 'dsh-home', 'sessions', 'current-ws', 'keep.jsonl.zstd'), 'KEEP\n')
    writeFileSync(join(data, 'dsh-home', 'storages', 'old.json'), 'OLD')
    writeFileSync(join(data, 'workspace', 'old.txt'), 'OLD')
    writeFileSync(join(data, 'settings.json'), '{"old": true}')

    const plan = restoreSources({
      tempRoot: backup,
      dataRoot: data,
      categories: ['workspace-records', 'harness-settings', 'app-settings'],
      legacy: false,
    })
    const restored = applyRestorePlan(plan)
    assert.deepEqual(restored.sort(), ['app-settings', 'harness-settings', 'workspace-records'])

    // 工作区记录被替换（旧内容消失）
    assert.equal(existsSync(join(data, 'workspace', 'old.txt')), false)
    assert.equal(readFileSync(join(data, 'workspace', 'notes.txt'), 'utf8'), 'hello')
    assert.equal(existsSync(join(data, 'dsh-home', 'storages', 'old.json')), false)
    assert.ok(existsSync(join(data, 'dsh-home', 'storages', 'workspace.json')))
    // 会话目录整体属于“工作区记录”：被备份内容替换
    assert.equal(existsSync(join(data, 'dsh-home', 'sessions', 'current-ws')), false)
    assert.ok(existsSync(join(data, 'dsh-home', 'sessions', 'ws1', 'session-1', 'session.jsonl.zstd')))

    // Harness 设置合并：settings.yaml 被覆盖；只恢复 harness-settings 时
    // 未包含在备份里的会话才会被保留（见下方 legacy 用例）
    assert.equal(readFileSync(join(data, 'dsh-home', 'settings.yaml'), 'utf8').includes('OLD'), false)
    assert.ok(existsSync(join(data, 'dsh-home', 'profiles', 'web', 'cordis.yml')))

    // 软件设置文件被替换
    assert.equal(readFileSync(join(data, 'settings.json'), 'utf8'), '{"shortcutPrompted": true}')

    // 恢复后不应残留 .bak
    const leftovers = []
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.name.includes('.bak-')) leftovers.push(full)
        if (entry.isDirectory()) walk(full)
      }
    }
    walk(data)
    assert.deepEqual(leftovers, [])
  } finally {
    rmSync(backup, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
})

test('legacy restore merges dsh-home without dropping sessions', () => {
  const backup = makeDataRoot()
  const data = mkdtempSync(join(tmpdir(), 'dsh-legacy-data-'))
  try {
    mkdirSync(join(data, 'dsh-home', 'sessions', 'current-ws'), { recursive: true })
    writeFileSync(join(data, 'dsh-home', 'settings.yaml'), 'OLD\n')
    writeFileSync(join(data, 'dsh-home', 'sessions', 'current-ws', 'keep.jsonl'), 'KEEP')

    const plan = restoreSources({ tempRoot: backup, dataRoot: data, categories: ['harness-settings'], legacy: true })
    const restored = applyRestorePlan(plan)
    assert.deepEqual(restored, ['harness-settings'])
    assert.equal(readFileSync(join(data, 'dsh-home', 'settings.yaml'), 'utf8').includes('ui-onboarding'), true)
    assert.equal(existsSync(join(data, 'dsh-home', 'sessions', 'current-ws', 'keep.jsonl')), true, 'current sessions kept')
    assert.equal(existsSync(join(data, 'dsh-home', 'sessions', 'ws1')), false, 'legacy sessions not merged into harness-settings')
  } finally {
    rmSync(backup, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
})
