import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(projectRoot, 'dist-exe', 'desktop')
const unpackedRoot = join(outputRoot, 'win-unpacked')
const appRoot = join(unpackedRoot, 'resources', 'app')
const electronDist = resolve(projectRoot, 'node_modules', 'electron', 'dist')
const wantsZip = process.argv.includes('--zip')

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

async function main() {
  await rm(unpackedRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await cp(electronDist, unpackedRoot, { recursive: true })
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
  delete manifest.devDependencies
  delete manifest.build
  manifest.main = 'src/main.cjs'
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  await cp(join(projectRoot, 'runtime', 'node'), join(unpackedRoot, 'resources', 'node'), { recursive: true })
  await cp(join(projectRoot, 'runtime', 'harness'), join(unpackedRoot, 'resources', 'harness'), { recursive: true })
  await cp(join(projectRoot, 'runtime', 'updater'), join(unpackedRoot, 'resources', 'updater'), { recursive: true })

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
