#!/usr/bin/env node
/**
 * Download the official Node.js runtime the dsh sidecar runs under into
 * build/node-runtime, sha256-verified against the same directory's
 * SHASUMS256.txt on nodejs.org, and extract it into a directly usable
 * layout (node.exe at the root on Windows; bin/ + lib/ elsewhere).
 *
 * Usage: fetch-node.mjs [--arch arm64|x64]
 * The arch defaults to the running host's; a mismatched stamp forces a
 * refetch so sequential cross-builds cannot reuse each other's runtime.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import AdmZip from 'adm-zip'

/** Pinned Node.js release shipped with the app. */
export const NODE_VERSION = '24.19.0'
/** Only https downloads from this exact host are accepted. */
const DIST_ORIGIN = 'https://nodejs.org/dist'
/** Stamp recording the extracted version, consulted for idempotent reruns. */
const STAMP_NAME = '.fetched.json'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(desktopRoot, 'build', 'node-runtime')

/** Arch value from `--arch <a>` or `--arch=<a>`, when given. */
export function archFromArgv(argv = process.argv) {
  const equals = argv.find((arg) => arg.startsWith('--arch='))
  if (equals !== undefined) return equals.slice('--arch='.length)
  const index = argv.indexOf('--arch')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

/** Reject platform/arch combinations no installer ships. */
export function validateTarget(platform, arch) {
  if (!['arm64', 'x64'].includes(arch)) {
    throw new Error(`unsupported arch: ${String(arch)} (expected arm64 or x64)`)
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(`unsupported combination: win32/${arch} (Windows ships x64 only)`)
  }
  if (platform === 'linux' && arch !== 'x64') {
    throw new Error(`unsupported combination: linux/${arch} (Linux ships x64 only)`)
  }
}

/** Archive file name for the current platform and arch. */
export function archiveName(platform, targetArch) {
  if (platform === 'win32') return `node-v${NODE_VERSION}-win-${targetArch}.zip`
  if (platform === 'linux') return `node-v${NODE_VERSION}-linux-${targetArch}.tar.xz`
  if (platform === 'darwin') return `node-v${NODE_VERSION}-darwin-${targetArch}.tar.gz`
  throw new Error(`unsupported platform: ${platform}`)
}

/** Node executable path inside build/node-runtime for the current platform. */
function nodeRelPath(platform) {
  return platform === 'win32' ? 'node.exe' : join('bin', 'node')
}

/** Reject any URL that is not https on nodejs.org. */
function assertTrustedUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.host !== 'nodejs.org') {
    throw new Error(`refusing non-https or off-host download: ${url}`)
  }
}

/** Fetch one file from the Node.js dist directory. */
async function fetchFromDist(pathname) {
  const url = `${DIST_ORIGIN}${pathname}`
  assertTrustedUrl(url)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch failed: ${String(response.status)} ${url}`)
  return response
}

/** The published sha256 for `archive` from the version's SHASUMS256.txt. */
async function expectedSha256(archive) {
  const response = await fetchFromDist(`/v${NODE_VERSION}/SHASUMS256.txt`)
  const text = await response.text()
  const line = text.split('\n').find((entry) => entry.endsWith(`  ${archive}`))
  if (line === undefined) throw new Error(`${archive} missing from SHASUMS256.txt`)
  return line.trim().split(/\s+/)[0]
}

/** sha256 hex digest of a buffer. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Ensure the verified archive exists on disk; download it when absent or stale. */
async function ensureArchive(archive, expected) {
  const archivePath = join(runtimeDir, archive)
  if (existsSync(archivePath) && sha256(readFileSync(archivePath)) === expected) return archivePath
  console.log(`downloading ${DIST_ORIGIN}/v${NODE_VERSION}/${archive}`)
  const response = await fetchFromDist(`/v${NODE_VERSION}/${archive}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const actual = sha256(buffer)
  if (actual !== expected) throw new Error(`sha256 mismatch for ${archive}: expected ${expected}, got ${actual}`)
  const partPath = `${archivePath}.part`
  writeFileSync(partPath, buffer)
  renameSync(partPath, archivePath)
  return archivePath
}

/** Remove every runtime-dir entry except the named keepers. */
function clearRuntimeDir(keepNames) {
  for (const entry of readdirSync(runtimeDir)) {
    if (keepNames.includes(entry)) continue
    rmSync(join(runtimeDir, entry), { recursive: true, force: true })
  }
}

/** Remove the archive and everything the sidecar never executes, keeping the
 * node binary and its license; the packaged runtime stays small. */
function pruneRuntime(platform) {
  const drop = new Set(['CHANGELOG.md', 'README.md'])
  if (platform === 'win32') {
    for (const name of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd', 'install_tools.bat', 'nodevars.bat', 'node_modules']) drop.add(name)
  } else {
    for (const name of ['include', 'share', 'lib']) drop.add(name)
  }
  for (const name of drop) {
    rmSync(join(runtimeDir, name), { recursive: true, force: true })
  }
}

/** Extract the Windows zip, stripping its top-level version directory. */
function extractWin(archivePath) {
  const zip = new AdmZip(archivePath)
  for (const entry of zip.getEntries()) {
    const rel = entry.entryName.split('/').slice(1).join('/')
    if (rel === '') continue
    const target = join(runtimeDir, rel)
    if (target !== runtimeDir && !target.startsWith(runtimeDir + sep)) {
      throw new Error(`archive entry escapes the runtime dir: ${entry.entryName}`)
    }
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }
}

/** Extract the Linux/macOS tar archive with the system tar, stripping the top
 * directory; `.tar.xz` uses -xJf, `.tar.gz` uses -xzf. */
function extractTar(archivePath, topDirName) {
  const staging = join(runtimeDir, '.extract')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const decompress = archivePath.endsWith('.tar.xz') ? '-xJf' : '-xzf'
  const result = spawnSync('tar', [decompress, archivePath, '-C', staging], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`tar extraction failed: ${String(result.error ?? result.stderr?.toString() ?? `exit ${String(result.status)}`)}`)
  }
  const top = join(staging, topDirName)
  for (const entry of readdirSync(top)) {
    renameSync(join(top, entry), join(runtimeDir, entry))
  }
  rmSync(staging, { recursive: true, force: true })
}

/** True when the stamp at `stampPath` matches this version and arch and the
 * executable still runs this version. */
export function stampOk(exePath, arch, stampPath) {
  if (!existsSync(stampPath) || !existsSync(exePath)) return false
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    if (stamp.version !== NODE_VERSION || stamp.arch !== arch || stamp.sha256 === undefined) return false
  } catch {
    return false
  }
  const probe = spawnSync(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
  return probe.error === undefined && probe.status === 0 && probe.stdout.toString().trim() === `v${NODE_VERSION}`
}

/** Run `node --version` against the extracted executable. */
function verifyExecutable(exePath) {
  const probe = spawnSync(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(`node runtime failed to execute: ${String(probe.error ?? `exit ${String(probe.status)}`)}`)
  }
  console.log(`extracted node reports ${probe.stdout.toString().trim()}`)
}

/** Download and lay out the runtime for this platform and arch. */
async function main() {
  const arch = archFromArgv() ?? process.arch
  validateTarget(process.platform, arch)
  mkdirSync(runtimeDir, { recursive: true })
  const archive = archiveName(process.platform, arch)
  const exePath = join(runtimeDir, nodeRelPath(process.platform))
  const stampPath = join(runtimeDir, STAMP_NAME)
  if (stampOk(exePath, arch, stampPath)) {
    console.log(`node v${NODE_VERSION} (${process.platform}-${arch}) already present: ${exePath}`)
    return
  }
  const expected = await expectedSha256(archive)
  const archivePath = await ensureArchive(archive, expected)
  clearRuntimeDir([archive, `${archive}.part`, STAMP_NAME])
  if (process.platform === 'win32') {
    extractWin(archivePath)
  } else {
    extractTar(archivePath, `node-v${NODE_VERSION}-${process.platform}-${arch}`)
  }
  rmSync(archivePath, { force: true })
  pruneRuntime(process.platform)
  writeFileSync(stampPath, `${JSON.stringify({ version: NODE_VERSION, arch, sha256: expected }, null, 2)}\n`)
  verifyExecutable(exePath)
  console.log(`node v${NODE_VERSION} (${process.platform}-${arch}) ready at ${exePath}`)
}

const invokedAsScript = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (invokedAsScript) {
  await main()
}
