#!/usr/bin/env node
/**
 * Download the official Node.js runtime the dsh sidecar runs under into
 * build/node-runtime, sha256-verified against the same directory's
 * SHASUMS256.txt on nodejs.org, and extract it into a directly usable
 * layout (node.exe at the root on Windows; bin/ + lib/ on Linux).
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

/** Pinned Node.js release shipped with the app. */
const NODE_VERSION = '24.19.0'
/** Only https downloads from this exact host are accepted. */
const DIST_ORIGIN = 'https://nodejs.org/dist'
/** Stamp recording the extracted version, consulted for idempotent reruns. */
const STAMP_NAME = '.fetched.json'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(desktopRoot, 'build', 'node-runtime')

/** Archive file name for the current platform. */
function archiveName(platform) {
  if (platform === 'win32') return `node-v${NODE_VERSION}-win-x64.zip`
  if (platform === 'linux') return `node-v${NODE_VERSION}-linux-x64.tar.xz`
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

/** Extract the Linux tar.xz with the system tar, stripping the top directory. */
function extractLinux(archivePath) {
  const staging = join(runtimeDir, '.extract')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const result = spawnSync('tar', ['-xJf', archivePath, '-C', staging], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`tar extraction failed: ${String(result.error ?? result.stderr?.toString() ?? `exit ${String(result.status)}`)}`)
  }
  const top = join(staging, `node-v${NODE_VERSION}-linux-x64`)
  for (const entry of readdirSync(top)) {
    renameSync(join(top, entry), join(runtimeDir, entry))
  }
  rmSync(staging, { recursive: true, force: true })
}

/** True when the stamp matches and the executable still runs this version. */
function stampOk(exePath) {
  const stampPath = join(runtimeDir, STAMP_NAME)
  if (!existsSync(stampPath) || !existsSync(exePath)) return false
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    if (stamp.version !== NODE_VERSION || stamp.sha256 === undefined) return false
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

mkdirSync(runtimeDir, { recursive: true })
const archive = archiveName(process.platform)
const exePath = join(runtimeDir, nodeRelPath(process.platform))
if (stampOk(exePath)) {
  console.log(`node v${NODE_VERSION} already present: ${exePath}`)
  process.exit(0)
}
const expected = await expectedSha256(archive)
const archivePath = await ensureArchive(archive, expected)
clearRuntimeDir([archive, `${archive}.part`, STAMP_NAME])
if (process.platform === 'win32') {
  extractWin(archivePath)
} else {
  extractLinux(archivePath)
}
rmSync(archivePath, { force: true })
pruneRuntime(process.platform)
writeFileSync(join(runtimeDir, STAMP_NAME), `${JSON.stringify({ version: NODE_VERSION, sha256: expected }, null, 2)}\n`)
verifyExecutable(exePath)
console.log(`node v${NODE_VERSION} ready at ${exePath}`)
