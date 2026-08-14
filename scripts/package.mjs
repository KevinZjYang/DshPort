import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(projectRoot, 'dist-exe', 'desktop')
const unpackedRoot = join(outputRoot, 'win-unpacked')
const appRoot = join(unpackedRoot, 'resources', 'app')
const electronDist = resolve(projectRoot, 'node_modules', 'electron', 'dist')
const harnessRuntimeRoot = process.env.DSH_HARNESS_RUNTIME_DIR === undefined
  ? join(projectRoot, 'runtime', 'harness')
  : resolve(process.env.DSH_HARNESS_RUNTIME_DIR)
const wantsZip = process.argv.includes('--zip')

async function run(command, args, cwd = projectRoot) {
  await new Promise((resolveRun, reject) => {
    const usesCmdShim = process.platform === 'win32' && ['npm', 'npx', 'pnpm'].includes(command)
    const executable = usesCmdShim ? process.env.ComSpec || 'cmd.exe' : command
    const executableArgs = usesCmdShim ? ['/d', '/c', command, ...args] : args
    const child = spawn(executable, executableArgs, { cwd, stdio: 'inherit', windowsHide: true })
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
    child.once('error', reject)
  })
}

async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolveHash, reject) => {
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', resolveHash)
  })
  return hash.digest('hex')
}

async function findRcedit(root) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === 'rcedit.exe') return path
    if (entry.isDirectory()) {
      const found = await findRcedit(path).catch(() => undefined)
      if (found) return found
    }
  }
  return undefined
}

async function verifyPackagedHarness(root) {
  const nodeModules = join(root, 'resources', 'harness', 'node_modules')
  for (const dependency of [
    join(nodeModules, '@deepseek-ai', 'dsh-app-boot'),
    join(nodeModules, '@earendil-works', 'pi-ai'),
    join(nodeModules, '@img', 'sharp-win32-x64'),
    join(nodeModules, 'sharp'),
    join(nodeModules, 'typebox'),
  ]) {
    const stat = await lstat(dependency)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Packaged Harness dependency is not a real directory: ${dependency}`)
    }
  }
}

async function pruneElectronRuntime(root) {
  const locales = join(root, 'locales')
  const keepLocales = new Set(['en-US.pak', 'zh-CN.pak'])
  for (const entry of await readdir(locales, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && !keepLocales.has(entry.name)) await rm(join(locales, entry.name), { force: true })
  }
  for (const file of ['LICENSE', 'LICENSES.chromium.html', 'version']) {
    await rm(join(root, file), { force: true })
  }
}

async function main() {
  await rm(unpackedRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await cp(electronDist, unpackedRoot, { recursive: true })
  await pruneElectronRuntime(unpackedRoot)
  const exe = join(unpackedRoot, 'electron.exe')
  const appExe = join(unpackedRoot, 'DshPort.exe')
  if (process.platform === 'win32') {
    await rename(exe, appExe)
    const rcedit = await findRcedit(join(projectRoot, 'node_modules', '.pnpm'))
    if (rcedit) await run(rcedit, [appExe, '--set-icon', join(projectRoot, 'resources', 'icon.ico')], projectRoot)
  }

  await mkdir(appRoot, { recursive: true })
  await cp(join(projectRoot, 'src'), join(appRoot, 'src'), { recursive: true })
  await cp(join(projectRoot, 'resources'), join(appRoot, 'resources'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  manifest.version = (process.env.DSHPORT_VERSION || manifest.version).replace(/^v/u, '')
  delete manifest.devDependencies
  delete manifest.build
  manifest.main = 'src/main.cjs'
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  await cp(join(projectRoot, 'runtime', 'node'), join(unpackedRoot, 'resources', 'node'), { recursive: true })
  await cp(harnessRuntimeRoot, join(unpackedRoot, 'resources', 'harness'), { recursive: true })
  await cp(join(projectRoot, 'runtime', 'updater'), join(unpackedRoot, 'resources', 'updater'), { recursive: true })
  await verifyPackagedHarness(unpackedRoot)

  if (wantsZip) {
    const archive = join(outputRoot, 'DshPort-win-x64.zip')
    const harnessArchive = join(outputRoot, 'harness-runtime.zip')
    await rm(archive, { force: true })
    await rm(harnessArchive, { force: true })
    await run('tar', ['-a', '-cf', archive, '-C', unpackedRoot, '.'])
    await run('tar', ['-a', '-cf', harnessArchive, '-C', join(unpackedRoot, 'resources', 'harness'), '.'])
    await writeFile(join(outputRoot, 'SHA256SUMS.txt'), [
      `${await sha256(archive)}  DshPort-win-x64.zip`,
      `${await sha256(harnessArchive)}  harness-runtime.zip`,
      '',
    ].join('\n'), 'ascii')
  }
  console.log(`Portable desktop directory prepared at ${unpackedRoot}`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
