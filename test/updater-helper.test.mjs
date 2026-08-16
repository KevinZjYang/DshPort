import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const updaterSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'updater.cjs'), 'utf8')

// 还原 updater.cjs 内联的 CLEANUP_HELPER 源码（与实际打包产出一致）。
function extractHelperSource() {
  const marker = 'const CLEANUP_HELPER = ['
  const start = updaterSrc.indexOf(marker)
  const end = updaterSrc.indexOf("].join('\\n')", start)
  if (start < 0 || end < 0) throw new Error('CLEANUP_HELPER markers not found in updater.cjs')
  // 从 'const CLEANUP_HELPER = ' 之后开始切片，保留数组字面量的 '['。
  const arrayLiteral = updaterSrc.slice(start + marker.length - 1, end + 1)
  // eslint-disable-next-line no-eval
  const lines = eval(arrayLiteral)
  return lines.join('\n')
}

function makeFixture(root) {
  const helper = join(root, 'cleanup-backup.cjs')
  writeFileSync(helper, extractHelperSource(), 'utf8')
  const backup = join(root, 'app.backup-12345')
  const temp = join(root, 'dsh-update-XXXXXX')
  mkdirSync(join(backup, 'resources', 'node'), { recursive: true })
  writeFileSync(join(backup, 'resources', 'node', 'node.exe'), 'fake-node')
  mkdirSync(join(temp, 'data'), { recursive: true })
  writeFileSync(join(temp, 'progress.txt'), 'COMPLETE')
  return { helper, backup, temp }
}

test('cleanup helper removes backup and temp after a dead updater pid', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-helper-test-'))
  try {
    const { helper, backup, temp } = makeFixture(root)
    // 999999 是不存在的 pid：waitForPidExit 应立刻返回。
    const result = spawnSync(process.execPath, [helper, backup, '999999', temp], { timeout: 30000 })
    assert.equal(result.status, 0, result.stderr ? result.stderr.toString() : 'helper exited non-zero')
    assert.equal(existsSync(backup), false, 'backup dir must be deleted')
    assert.equal(existsSync(temp), false, 'temp dir must be deleted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup helper waits for a live updater pid before deleting', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-helper-test-'))
  try {
    const { helper, backup, temp } = makeFixture(root)
    // 模拟还在运行的更新器：一个睡 2500ms 的 node 进程。
    const fakeUpdater = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'ignore' })
    const result = spawnSync(process.execPath, [helper, backup, String(fakeUpdater.pid), temp], { timeout: 30000 })
    assert.equal(result.status, 0, result.stderr ? result.stderr.toString() : 'helper exited non-zero')
    assert.equal(existsSync(backup), false, 'backup dir must be deleted only after the updater exits')
    assert.equal(existsSync(temp), false, 'temp dir must be deleted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
