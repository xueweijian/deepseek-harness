#!/usr/bin/env node
/**
 * GUI-free smoke test: boot the runtime's dsh web server the same way the
 * Electron sidecar does (dev paths, our own loopback port, HTTP-readiness
 * polling), fetch the served page, and assert it is the dsh web UI.
 * Non-zero exit means failure.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Upper bound from spawn to the first successful HTTP response. */
const READY_TIMEOUT_MS = 60_000
/** Spacing between readiness polls while the server is starting. */
const POLL_INTERVAL_MS = 250
/** Per-poll HTTP timeout; a server slower than this is retried, not failed. */
const POLL_TIMEOUT_MS = 2_000
/** Output lines kept for the failure tail. */
const TAIL_LINES = 40

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The node executable: override, fetched runtime, then the running node. */
function resolveNode() {
  if (process.env.SMOKE_NODE !== undefined && process.env.SMOKE_NODE !== '') return process.env.SMOKE_NODE
  const fetched = join(desktopRoot, 'build', 'node-runtime', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
  return existsSync(fetched) ? fetched : process.execPath
}

/** The dsh CLI entry: file override, package-dir override (manifest bin
 * field resolved), then the dev runtime closure's manifest. */
function resolveDshBin() {
  if (process.env.SMOKE_DSH_BIN !== undefined && process.env.SMOKE_DSH_BIN !== '') return process.env.SMOKE_DSH_BIN
  if (process.env.SMOKE_DSH_DIR !== undefined && process.env.SMOKE_DSH_DIR !== '') return resolveDshEntry(process.env.SMOKE_DSH_DIR)
  return resolveDshEntry(join(desktopRoot, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'))
}

/** Resolve the CLI entry from a dsh package directory's manifest `bin` field,
 * mirroring the sidecar's resolution. */
function resolveDshEntry(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const bin = manifest.bin
  if (typeof bin === 'string' && bin !== '') return join(packageDir, bin)
  if (typeof bin === 'object' && bin !== null) {
    const entries = Object.entries(bin)
    const chosen = entries.find(([name]) => name === 'dsh') ?? (entries.length === 1 ? entries[0] : undefined)
    if (chosen !== undefined && typeof chosen[1] === 'string' && chosen[1] !== '') return join(packageDir, chosen[1])
  }
  throw new Error(`dsh package manifest has no usable bin entry: ${join(packageDir, 'package.json')}`)
}

/** Ask the OS for one currently free loopback port and release it again. */
function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', (error) => { reject(error) })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => { resolve(port) })
    })
  })
}

// The child runs with cwd=homedir, and spawn resolves a relative executable
// against options.cwd — both paths must be absolute before spawn.
const nodeExe = resolve(resolveNode())
const dshBin = resolve(resolveDshBin())
if (!existsSync(dshBin)) {
  console.error(`dsh entry missing: ${dshBin}`)
  console.error('run: pnpm run runtime:install')
  process.exit(1)
}

const startedAt = Date.now()
const lines = []
const port = await reservePort()
const url = `http://127.0.0.1:${String(port)}`
const child = spawn(nodeExe, [dshBin, 'web', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: homedir(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true,
})

/** Kill the whole server process tree. */
function killTree() {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  }
}

/** Print the outcome and exit with the matching status code. */
function finish(ok, message) {
  killTree()
  if (ok) {
    console.log(message)
    process.exit(0)
  }
  console.error(message)
  if (lines.length > 0) console.error(`--- output tail ---\n${lines.slice(-TAIL_LINES).join('\n')}`)
  process.exit(1)
}

child.stdout.on('data', (chunk) => { lines.push(`[out] ${String(chunk).trimEnd()}`) })
child.stderr.on('data', (chunk) => { lines.push(`[err] ${String(chunk).trimEnd()}`) })

const dead = new Promise((resolve) => {
  child.once('exit', (code, signal) => { lines.push(`[exit] code=${String(code)} signal=${String(signal)}`); resolve(null) })
  child.once('error', (error) => { lines.push(`[error] ${String(error)}`); resolve(null) })
})

/** Poll the URL until any HTTP response arrives; the watchdog bounds the wait. */
async function pollReady() {
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })
      try {
        await response.body?.cancel()
      } catch {
        /* body already closed after a complete response */
      }
      return
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS) })
    }
  }
}

const watchdog = setTimeout(() => {
  finish(false, `timed out after ${String(READY_TIMEOUT_MS)} ms waiting for ${url} to answer`)
}, READY_TIMEOUT_MS)
watchdog.unref()

const ready = await Promise.race([pollReady(), dead])
if (ready === null) {
  finish(false, `dsh web exited before serving ${url} (node: ${nodeExe}, bin: ${dshBin})`)
}

let response
try {
  response = await fetch(url)
} catch (error) {
  finish(false, `fetch failed for ${url}: ${String(error)}`)
}
const body = await response.text()
if (response.status !== 200) {
  finish(false, `unexpected status ${String(response.status)} for ${url}`)
}
if (!/<html/i.test(body) && !body.includes('__DSH_BOOT__')) {
  finish(false, `page served at ${url} does not look like the dsh web UI`)
}
const elapsed = Date.now() - startedAt
finish(true, `smoke ok: ${url} (${String(elapsed)} ms, status 200, ${String(body.length)} bytes)`)
