const { join } = require('node:path')

function portableDataPaths(portableRoot) {
  const dataRoot = join(portableRoot, 'data')
  return {
    dataRoot,
    dshHome: join(dataRoot, 'dsh-home'),
    workspace: join(dataRoot, 'workspace'),
    logsRoot: join(dataRoot, 'logs'),
  }
}

function releaseTagUrl(repository, tagName) {
  return `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`
}

function parseDshReleaseCommit(message) {
  return /^release\(dsh\):\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/u.exec(message)?.[1]
}

function releaseNumbers(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version)
  if (match === null) throw new Error(`cannot read version ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function prereleaseOf(version) {
  const index = version.indexOf('-')
  return index === -1 ? undefined : version.slice(index + 1)
}

function compareVersions(left, right) {
  const leftNumbers = releaseNumbers(left)
  const rightNumbers = releaseNumbers(right)
  for (let index = 0; index < 3; index += 1) {
    const order = leftNumbers[index] - rightNumbers[index]
    if (order !== 0) return order
  }
  const leftPre = prereleaseOf(left)
  const rightPre = prereleaseOf(right)
  if (leftPre === undefined || rightPre === undefined) {
    if (leftPre === rightPre) return 0
    return leftPre === undefined ? 1 : -1
  }
  const leftFields = leftPre.split('.')
  const rightFields = rightPre.split('.')
  for (let index = 0; index < Math.max(leftFields.length, rightFields.length); index += 1) {
    const leftField = leftFields[index]
    const rightField = rightFields[index]
    if (leftField === undefined) return -1
    if (rightField === undefined) return 1
    if (leftField === rightField) continue
    const leftNumeric = /^\d+$/u.test(leftField)
    const rightNumeric = /^\d+$/u.test(rightField)
    if (leftNumeric && rightNumeric) return Number(leftField) - Number(rightField)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftField < rightField ? -1 : 1
  }
  return 0
}

module.exports = { compareVersions, parseDshReleaseCommit, portableDataPaths, releaseTagUrl }
