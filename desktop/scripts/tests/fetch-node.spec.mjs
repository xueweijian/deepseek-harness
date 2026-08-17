import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { archFromArgv, archiveName, NODE_VERSION, stampOk, validateTarget } from '../fetch-node.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const workDir = mkdtempSync(join(tmpdir(), 'dsh-fetch-node-spec-'))

describe('archFromArgv', () => {
  it('reads the value of a bare --arch flag', () => {
    expect(archFromArgv(['node', 'fetch-node.mjs', '--arch', 'x64'])).toBe('x64')
  })

  it('reads the value of an --arch= assignment', () => {
    expect(archFromArgv(['--arch=arm64'])).toBe('arm64')
  })

  it('returns undefined when the flag is absent or dangles', () => {
    expect(archFromArgv(['node', 'script.mjs'])).toBeUndefined()
    expect(archFromArgv(['--arch'])).toBeUndefined()
    expect(archFromArgv(['--arch', '--other'])).toBeUndefined()
  })
})

describe('validateTarget', () => {
  it('accepts every shipped combination', () => {
    expect(() => validateTarget('win32', 'x64')).not.toThrow()
    expect(() => validateTarget('linux', 'x64')).not.toThrow()
    expect(() => validateTarget('darwin', 'arm64')).not.toThrow()
    expect(() => validateTarget('darwin', 'x64')).not.toThrow()
  })

  it('rejects unshipped combinations and bogus arches by name', () => {
    expect(() => validateTarget('win32', 'arm64')).toThrow('win32/arm64')
    expect(() => validateTarget('linux', 'arm64')).toThrow('linux/arm64')
    expect(() => validateTarget('darwin', 'ia64')).toThrow('unsupported arch: ia64')
  })
})

describe('archiveName', () => {
  it('names each platform archive with its pinned version', () => {
    expect(archiveName('win32', 'x64')).toBe(`node-v${NODE_VERSION}-win-x64.zip`)
    expect(archiveName('linux', 'x64')).toBe(`node-v${NODE_VERSION}-linux-x64.tar.xz`)
    expect(archiveName('darwin', 'arm64')).toBe(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`)
  })

  it('fails loud on an unsupported platform', () => {
    expect(() => archiveName('freebsd', 'x64')).toThrow('unsupported platform: freebsd')
  })
})

describe('stampOk', () => {
  const exePath = join(workDir, 'probe.exe')

  function writeStamp(content) {
    const stampPath = join(workDir, `stamp-${String(Math.random()).slice(2)}.json`)
    mkdirSync(dirname(stampPath), { recursive: true })
    writeFileSync(stampPath, typeof content === 'string' ? content : JSON.stringify(content))
    return stampPath
  }

  it('rejects stamps that mismatch version or arch, lack a sha, or fail to parse', () => {
    expect(stampOk(exePath, 'x64', writeStamp({ version: 'v0.0.1', arch: 'x64', sha256: 'a' }))).toBe(false)
    expect(stampOk(exePath, 'x64', writeStamp({ version: NODE_VERSION, arch: 'arm64', sha256: 'a' }))).toBe(false)
    expect(stampOk(exePath, 'x64', writeStamp({ version: NODE_VERSION, arch: 'x64' }))).toBe(false)
    expect(stampOk(exePath, 'x64', writeStamp('{broken'))).toBe(false)
  })

  it('rejects a missing stamp file or missing executable', () => {
    expect(stampOk(exePath, 'x64', join(workDir, 'no-such-stamp.json'))).toBe(false)
    expect(stampOk(join(workDir, 'no-such-exe'), 'x64', writeStamp({ version: NODE_VERSION, arch: 'x64', sha256: 'a' }))).toBe(false)
  })

  it('accepts a matching stamp backed by a runnable runtime of this version', { skip: !runtimeExe() }, () => {
    const stampPath = writeStamp({ version: NODE_VERSION, arch: process.arch, sha256: 'a' })
    expect(stampOk(runtimeExe(), process.arch, stampPath)).toBe(true)
  })
})

/** The fetched desktop runtime's node, when present; the stampOk happy path
 * needs an executable that reports exactly the pinned version. */
function runtimeExe() {
  const rel = process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']
  const candidate = join(scriptsDir, '..', '..', 'build', 'node-runtime', ...rel)
  return existsSync(candidate) ? candidate : undefined
}
