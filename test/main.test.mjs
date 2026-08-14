import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, parseDshReleaseCommit, portableDataPaths, releaseTagUrl } from '../src/portable-paths.cjs'

test('portable data directories are stable and separate from resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-'))
  const data = join(root, 'data')
  const resources = join(root, 'resources')
  await writeFile(join(root, 'layout.txt'), `${data}\n${resources}`)
  const value = await readFile(join(root, 'layout.txt'), 'utf8')
  assert.match(value, /data/u)
  assert.match(value, /resources/u)
})

test('portable data paths keep user data out of resources', () => {
  const paths = portableDataPaths(join('Portable', 'DshPort'))
  assert.equal(paths.dshHome, join('Portable', 'DshPort', 'data', 'dsh-home'))
  assert.equal(paths.workspace, join('Portable', 'DshPort', 'data', 'workspace'))
  assert.equal(paths.logsRoot, join('Portable', 'DshPort', 'data', 'logs'))
})

test('release tag URL preserves non-v tag names', () => {
  assert.equal(
    releaseTagUrl('owner/repo', 'desktop-v0.1.0'),
    'https://api.github.com/repos/owner/repo/releases/tags/desktop-v0.1.0',
  )
})

test('dsh release commits expose versions', () => {
  assert.equal(parseDshReleaseCommit('release(dsh): 0.1.0-rc.5'), '0.1.0-rc.5')
  assert.equal(parseDshReleaseCommit('docs: update readme'), undefined)
})

test('version comparison follows prerelease precedence', () => {
  assert.equal(compareVersions('0.1.0-rc.6', '0.1.0-rc.5') > 0, true)
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.5') > 0, true)
  assert.equal(compareVersions('0.1.0-rc.5', '0.1.0') < 0, true)
})
