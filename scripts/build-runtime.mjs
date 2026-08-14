import { createWriteStream } from 'node:fs'
import { access, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = join(projectRoot, 'runtime')
const harnessRoot = join(runtimeRoot, 'harness')
const nodeRoot = join(runtimeRoot, 'node')
const updaterRoot = join(runtimeRoot, 'updater')
const cacheRoot = join(projectRoot, '.cache')
const sourceRoot = process.env.DSH_SOURCE_DIR === undefined
  ? join(cacheRoot, 'deepseek-harness')
  : resolve(process.env.DSH_SOURCE_DIR)
const sourceRepository = process.env.DSH_SOURCE_REPOSITORY_URL || 'https://github.com/deepseek-ai/deepseek-harness.git'
const sourceRef = process.env.DSH_SOURCE_REF || 'master'
const nodeVersion = process.env.DSH_NODE_VERSION || 'v24.14.0'
const nodeZip = `node-${nodeVersion}-win-x64.zip`
const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeZip}`

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

async function tryRun(command, args, cwd = projectRoot) {
  try {
    await run(command, args, cwd)
    return true
  } catch {
    return false
  }
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function prepareSource() {
  if (process.env.DSH_SOURCE_DIR !== undefined) return
  if (await exists(join(sourceRoot, '.git'))) {
    if (await tryRun('git', ['fetch', '--depth', '1', 'origin', sourceRef], sourceRoot)) {
      await run('git', ['checkout', 'FETCH_HEAD'], sourceRoot)
      return
    }
    await run('git', ['fetch', '--depth', '1', '--tags', 'origin'], sourceRoot)
    await run('git', ['checkout', sourceRef], sourceRoot)
    return
  }
  await mkdir(cacheRoot, { recursive: true })
  await run('git', ['clone', '--depth', '1', sourceRepository, sourceRoot])
  if (await tryRun('git', ['fetch', '--depth', '1', 'origin', sourceRef], sourceRoot)) {
    await run('git', ['checkout', 'FETCH_HEAD'], sourceRoot)
    return
  }
  await run('git', ['fetch', '--depth', '1', '--tags', 'origin'], sourceRoot)
  await run('git', ['checkout', sourceRef], sourceRoot)
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Could not download ${url}: HTTP ${response.status}`)
  await mkdir(dirname(target), { recursive: true })
  await pipeline(response.body, createWriteStream(target))
}

async function generateIcon() {
  const source = join(sourceRoot, 'apps', 'web', 'public', 'favicon.svg')
  const png = join(projectRoot, 'resources', 'icon.png')
  const ico = join(projectRoot, 'resources', 'icon.ico')
  await mkdir(dirname(png), { recursive: true })
  await sharp(await readFile(source)).resize(256, 256).png().toFile(png)
  await writeFile(ico, await pngToIco([png]))
}

async function prepareNode() {
  const nodeExe = join(nodeRoot, 'node.exe')
  if (await exists(nodeExe)) return
  const cacheZip = join(projectRoot, 'dist-exe', nodeZip)
  if (!(await exists(cacheZip))) await download(nodeUrl, cacheZip)
  await rm(nodeRoot, { recursive: true, force: true })
  await mkdir(nodeRoot, { recursive: true })
  await run('tar', ['-xf', cacheZip, '--strip-components=1', '-C', nodeRoot])
}

async function prepareHarness() {
  await rm(harnessRoot, { recursive: true, force: true })
  await mkdir(harnessRoot, { recursive: true })
  await installDshPackage(await resolveDshPackageSpec())
  await exposeInstalledDshPackage()
  await pruneHarnessRuntime()
  await verifyMaterializedWorkspacePackages(join(harnessRoot, 'node_modules', '@deepseek-ai'))
}

async function installDshPackage(packageSpec) {
  await writeHarnessInstallManifest(packageSpec)
  if (await tryRun('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], harnessRoot)) return
  if (packageSpec === 'latest') throw new Error('npm could not install @deepseek-ai/dsh@latest')
  console.warn(`Could not install @deepseek-ai/dsh@${packageSpec}; falling back to npm latest.`)
  await rm(join(harnessRoot, 'node_modules'), { recursive: true, force: true })
  await rm(join(harnessRoot, 'package-lock.json'), { force: true })
  await writeHarnessInstallManifest('latest')
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], harnessRoot)
}

async function writeHarnessInstallManifest(packageSpec) {
  await writeFile(join(harnessRoot, 'package.json'), `${JSON.stringify({
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': packageSpec,
    },
  }, null, 2)}\n`)
}

async function resolveDshPackageSpec() {
  if (process.env.DSH_PACKAGE_SPEC !== undefined && process.env.DSH_PACKAGE_SPEC !== '') return process.env.DSH_PACKAGE_SPEC
  if (process.env.DSH_PACKAGE_VERSION !== undefined && process.env.DSH_PACKAGE_VERSION !== '') {
    return process.env.DSH_PACKAGE_VERSION.startsWith('@')
      ? process.env.DSH_PACKAGE_VERSION
      : process.env.DSH_PACKAGE_VERSION
  }
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'apps', 'cli', 'package.json'), 'utf8'))
  return manifest.version
}

async function exposeInstalledDshPackage() {
  const dshPackageRoot = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh')
  await cp(join(dshPackageRoot, 'lib'), join(harnessRoot, 'lib'), { recursive: true })
  await cp(join(dshPackageRoot, 'config'), join(harnessRoot, 'config'), { recursive: true })
  for (const file of ['package.json', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE']) {
    if (await exists(join(dshPackageRoot, file))) await cp(join(dshPackageRoot, file), join(harnessRoot, file))
  }
}

async function pruneHarnessRuntime() {
  await pruneTree(join(harnessRoot, 'node_modules'))
  await removeIfExists(join(harnessRoot, 'node_modules', 'node-pty', 'prebuilds', 'win32-arm64'))
  await removeIfExists(join(harnessRoot, 'node_modules', 'node-pty', 'third_party', 'conpty', '1.23.251008001', 'win10-arm64'))
}

async function pruneTree(root) {
  if (!(await exists(root))) return
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (shouldPruneDirectory(entry.name) || await isCompiledPackageSource(root, entry.name)) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      await pruneTree(path)
      continue
    }
    if (entry.isFile() && shouldPruneFile(entry.name)) await rm(path, { force: true })
  }
}

function shouldPruneDirectory(name) {
  return new Set([
    '.github',
    '.yarn',
    '__tests__',
    'doc',
    'docs',
    'example',
    'examples',
    'test',
    'tests',
  ]).has(name)
}

async function isCompiledPackageSource(parent, name) {
  if (name !== 'src') return false
  if (!(await exists(join(parent, 'package.json')))) return false
  return await exists(join(parent, 'lib')) || await exists(join(parent, 'dist')) || await exists(join(parent, 'build'))
}

function shouldPruneFile(name) {
  const lower = name.toLowerCase()
  return lower.endsWith('.map')
    || lower.endsWith('.pdb')
    || lower.endsWith('.tsbuildinfo')
    || lower === 'readme.md'
    || lower === 'changelog.md'
    || lower === 'changes.md'
}

async function removeIfExists(path) {
  await rm(path, { recursive: true, force: true })
}

async function verifyMaterializedWorkspacePackages(scopeRoot) {
  const appBoot = join(scopeRoot, 'dsh-app-boot')
  const stat = await lstat(appBoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workspace package was not materialized: ${appBoot}`)
  }
}

async function prepareUpdater() {
  await mkdir(updaterRoot, { recursive: true })
  await cp(join(projectRoot, 'src', 'updater.cjs'), join(updaterRoot, 'updater.cjs'))
}

await prepareSource()
await generateIcon()
await prepareNode()
await prepareHarness()
await prepareUpdater()
console.log(`Desktop runtime prepared at ${runtimeRoot}`)
