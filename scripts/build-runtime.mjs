import { createWriteStream, existsSync } from 'node:fs'
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
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
  await run('pnpm', ['install'], sourceRoot)
  await run('pnpm', ['run', 'build'], sourceRoot)
  await run('pnpm', ['deploy', '--legacy', '--filter', '@deepseek-ai/dsh', '--prod', harnessRoot], sourceRoot)
  await materializeWorkspaceClosure()
  await verifyMaterializedWorkspacePackages(join(harnessRoot, 'node_modules', '@deepseek-ai'))
}

async function materializeWorkspaceClosure() {
  const workspacePackages = new Map()
  await collectWorkspacePackages(sourceRoot, workspacePackages)
  const pendingWorkspace = Array.from(workspacePackages.keys())
  const pendingExternal = []
  const visitedWorkspace = new Set()
  const visitedExternal = new Set()
  while (pendingWorkspace.length > 0 || pendingExternal.length > 0) {
    const name = pendingWorkspace.pop()
    if (name !== undefined) {
      if (visitedWorkspace.has(name)) continue
      visitedWorkspace.add(name)
      const packageRoot = workspacePackages.get(name)
      if (!packageRoot) continue
      await materializeWorkspacePackage(name, packageRoot)
      await queueDependencies(packageRoot, workspacePackages, pendingWorkspace, pendingExternal)
      continue
    }
    const external = pendingExternal.pop()
    if (external === undefined) continue
    if (visitedExternal.has(external.name)) continue
    const packageRoot = resolveDependencyPackage(external.name, external.from)
    if (packageRoot === undefined) continue
    visitedExternal.add(external.name)
    await rm(packageTargetPath(external.name), { recursive: true, force: true })
    await copyPackageWithoutNestedNodeModules(packageRoot, packageTargetPath(external.name))
    await queueDependencies(packageRoot, workspacePackages, pendingWorkspace, pendingExternal)
  }
}

async function queueDependencies(packageRoot, workspacePackages, pendingWorkspace, pendingExternal) {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  for (const deps of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
    for (const [dependency, version] of Object.entries(deps || {})) {
      if (dependency.startsWith('@deepseek-ai/') && String(version).startsWith('workspace:')) {
        pendingWorkspace.push(dependency)
      } else {
        pendingExternal.push({ name: dependency, from: packageRoot })
      }
    }
  }
}

function resolveDependencyPackage(name, from) {
  try {
    const requireFromPackage = createRequire(join(from, 'package.json'))
    return dirname(requireFromPackage.resolve(`${name}/package.json`))
  } catch {
    return resolveDependencyPackageFromEntry(name, from)
      || resolveDependencyPackageFromNodeModules(name, from)
      || resolveDependencyPackageFromSharedPnpm(name)
  }
}

function resolveDependencyPackageFromEntry(name, from) {
  try {
    const requireFromPackage = createRequire(join(from, 'package.json'))
    return findPackageRoot(requireFromPackage.resolve(name))
  } catch {
    return undefined
  }
}

function findPackageRoot(path) {
  let current = dirname(path)
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}

function resolveDependencyPackageFromNodeModules(name, from) {
  let current = from
  while (current !== dirname(current)) {
    const candidate = packagePathUnder(join(current, 'node_modules'), name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    current = dirname(current)
  }
  return undefined
}

function packagePathUnder(root, name) {
  if (!name.startsWith('@')) return join(root, name)
  const [scope, packageName] = name.split('/')
  return join(root, scope, packageName)
}

function resolveDependencyPackageFromSharedPnpm(name) {
  const candidate = packagePathUnder(join(sourceRoot, 'node_modules', '.pnpm', 'node_modules'), name)
  if (existsSync(join(candidate, 'package.json'))) return candidate
  return undefined
}

function packageTargetPath(name) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.split('/')
    return join(harnessRoot, 'node_modules', scope, packageName)
  }
  return join(harnessRoot, 'node_modules', name)
}

async function materializeWorkspacePackage(name, source) {
  const packagePath = packageTargetPath(name)
  if (await exists(packagePath)) {
    const stat = await lstat(packagePath)
    if (!stat.isSymbolicLink() && stat.isDirectory()) return
  }
  await rm(packagePath, { recursive: true, force: true })
  await copyPackageWithoutNestedNodeModules(source, packagePath)
}

async function collectWorkspacePackages(root, packages) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist-exe') continue
    const path = join(root, entry.name)
    if (!entry.isDirectory()) continue
    const manifestPath = join(path, 'package.json')
    if (await exists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) packages.set(manifest.name, path)
    }
    await collectWorkspacePackages(path, packages)
  }
}

async function copyPackageWithoutNestedNodeModules(source, target, seen = new Set()) {
  const stat = await lstat(source)
  const resolved = stat.isSymbolicLink() ? await realpath(source) : source
  const resolvedStat = stat.isSymbolicLink() ? await lstat(resolved) : stat
  if (resolvedStat.isDirectory()) {
    const real = await realpath(resolved)
    if (seen.has(real)) return
    seen.add(real)
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(resolved)) {
      if (entry === '.git' || entry === 'node_modules') continue
      await copyPackageWithoutNestedNodeModules(join(resolved, entry), join(target, entry), seen)
    }
    seen.delete(real)
    return
  }
  if (resolvedStat.isFile()) {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(resolved, target)
    return
  }
  if (basename(resolved) !== 'node_modules') await cp(resolved, target, { recursive: true, dereference: true })
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
