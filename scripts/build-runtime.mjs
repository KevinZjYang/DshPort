import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    const executable = process.platform === 'win32' && ['npm', 'npx', 'pnpm'].includes(command)
      ? `${command}.cmd`
      : command
    const child = spawn(executable, args, { cwd, stdio: 'inherit', windowsHide: true })
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
