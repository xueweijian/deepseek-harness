import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, type Server as TcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const realPlatform = process.platform
const realResourcesPath = (process as { resourcesPath?: string }).resourcesPath

const electronApp = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => '',
    getPath: (_name: string): string => '',
    resourcesPath: '',
  },
}))

vi.mock('electron', () => electronApp)

import { pollReady, resolveDshEntry, resolveSidecarPaths } from '../sidecar.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-sidecar-spec-'))

/** Write one package.json variant into a fresh directory. */
function manifestDir(name: string, content: unknown): string {
  const dir = join(workDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), typeof content === 'string' ? content : JSON.stringify(content))
  return dir
}

/** Ask the OS for one currently free loopback port and release it again. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.on('error', (error) => { reject(error) })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => { resolve(port) })
    })
  })
}

afterEach(() => {
  electronApp.app.isPackaged = false
  electronApp.app.resourcesPath = ''
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  Object.defineProperty(process, 'resourcesPath', { value: realResourcesPath, configurable: true })
})

describe('resolveDshEntry', () => {
  it('accepts a string bin', () => {
    const dir = manifestDir('string-bin', { bin: 'cli/main.js' })
    expect(resolveDshEntry(dir)).toBe(join(dir, 'cli', 'main.js'))
  })

  it('prefers the dsh-named entry in a bin map', () => {
    const dir = manifestDir('named-bin', { bin: { other: 'lib/b.js', dsh: 'lib/a.js' } })
    expect(resolveDshEntry(dir)).toBe(join(dir, 'lib', 'a.js'))
  })

  it('uses the only entry of a single-entry bin map', () => {
    const dir = manifestDir('single-bin', { bin: { anything: 'x.js' } })
    expect(resolveDshEntry(dir)).toBe(join(dir, 'x.js'))
  })

  it('rejects a multi-entry bin map without a dsh entry, naming the manifest', () => {
    const dir = manifestDir('multi-bin', { bin: { a: '1.js', b: '2.js' } })
    expect(() => resolveDshEntry(dir)).toThrow(join(dir, 'package.json'))
  })

  it('rejects an empty or non-string bin', () => {
    expect(() => resolveDshEntry(manifestDir('empty-string', { bin: '' }))).toThrow(/no usable bin/)
    expect(() => resolveDshEntry(manifestDir('empty-map', { bin: {} }))).toThrow(/no usable bin/)
    expect(() => resolveDshEntry(manifestDir('null-bin', { bin: null }))).toThrow(/no usable bin/)
  })

  it('fails loud on an unreadable manifest, naming the path', () => {
    expect(() => resolveDshEntry(join(workDir, 'missing-dir'))).toThrow(/manifest unreadable/)
    expect(() => resolveDshEntry(manifestDir('bad-json', '{not json'))).toThrow(/manifest unreadable/)
  })
})

describe('resolveSidecarPaths', () => {
  it('uses resourcesPath and the Windows node.exe layout when packaged', () => {
    electronApp.app.isPackaged = true
    const resources = join(workDir, 'res')
    electronApp.app.resourcesPath = resources
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const dshDir = join(resources, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ bin: 'lib/bin.js' }))
    const paths = resolveSidecarPaths()
    expect(paths.nodeExe).toBe(join(resources, 'node', 'node.exe'))
    expect(paths.dshBin).toBe(join(dshDir, 'lib', 'bin.js'))
  })

  it('uses the bin/node layout on posix when packaged', () => {
    electronApp.app.isPackaged = true
    const resources = join(workDir, 'res')
    electronApp.app.resourcesPath = resources
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const dshDir = join(resources, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ bin: { dsh: 'lib/bin.js' } }))
    const paths = resolveSidecarPaths()
    expect(paths.nodeExe).toBe(join(resources, 'node', 'bin', 'node'))
  })

  it('dev mode runs node from PATH and the runtime closure from the app path', () => {
    electronApp.app.isPackaged = false
    electronApp.app.getAppPath = (): string => workDir
    const dshDir = join(workDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ bin: 'lib/bin.js' }))
    const paths = resolveSidecarPaths()
    expect(paths.nodeExe).toBe('node')
    expect(paths.dshBin).toBe(join(dshDir, 'lib', 'bin.js'))
  })
})

describe('pollReady', () => {
  let servers: Array<Server | TcpServer> = []

  afterEach(async () => {
    for (const server of servers) {
      ;(server as Server).closeIdleConnections?.()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
    servers = []
  })

  function okServer(port: number): Promise<Server> {
    return new Promise((resolve) => {
      const server = createHttpServer((_req, res) => { res.end('ok') })
      servers.push(server)
      server.listen(port, '127.0.0.1', () => { resolve(server) })
    })
  }

  it('resolves once the URL answers with any HTTP response', async () => {
    const port = await freePort()
    await okServer(port)
    await expect(pollReady(`http://127.0.0.1:${String(port)}/`)).resolves.toBeUndefined()
  })

  it('treats a body-less response (204) as ready', async () => {
    const port = await freePort()
    const server = createHttpServer((_req, res) => { res.statusCode = 204; res.end() })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => { resolve() }) })
    await expect(pollReady(`http://127.0.0.1:${String(port)}/`)).resolves.toBeUndefined()
  })

  it('keeps retrying through connection-refused until the server appears', async () => {
    const port = await freePort()
    let settled = false
    const polling = pollReady(`http://127.0.0.1:${String(port)}/`).then(() => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    expect(settled).toBe(false)
    await okServer(port)
    await polling
    expect(settled).toBe(true)
  })

  it('does not mistake a TCP-accepting-but-silent socket for readiness', async () => {
    const port = await freePort()
    const sockets = new Set<Socket>()
    const blackHole = createNetServer()
    blackHole.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    servers.push(blackHole)
    await new Promise<void>((resolve) => { blackHole.listen(port, '127.0.0.1', () => { resolve() }) })
    let settled = false
    const polling = pollReady(`http://127.0.0.1:${String(port)}/`).then(() => { settled = true })
    // Longer than the per-poll timeout: the black hole must not settle it.
    await new Promise((resolve) => { setTimeout(resolve, 2_600) })
    expect(settled).toBe(false)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { blackHole.close(() => { resolve() }) })
    await okServer(port)
    await polling
    expect(settled).toBe(true)
  })
})

describe('environment overrides', () => {
  it('fails loud at import when an override is set but unparsable', async () => {
    vi.resetModules()
    process.env.DSH_SIDECAR_MAX_RESTARTS = 'not-a-number'
    try {
      await expect(import('../sidecar.ts')).rejects.toThrow('DSH_SIDECAR_MAX_RESTARTS')
    } finally {
      delete process.env.DSH_SIDECAR_MAX_RESTARTS
    }
  })

  it('stopSidecar resolves without an active session', async () => {
    vi.resetModules()
    const { stopSidecar } = await import('../sidecar.ts')
    await expect(stopSidecar()).resolves.toBeUndefined()
  })
})
