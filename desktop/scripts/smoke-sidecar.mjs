#!/usr/bin/env node
/**
 * GUI-free smoke test: boot the runtime's dsh web server the same way the
 * Electron sidecar does (dev paths, OS-picked port), fetch the served page,
 * and assert it is the dsh web UI. Non-zero exit means failure.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Upper bound from spawn to the readiness URL line. */
const READY_TIMEOUT_MS = 60_000
/** Readiness marker `dsh web` prints once the server accepts requests. */
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:(\d+))/
/** Output lines kept for the failure tail. */
const TAIL_LINES = 40

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The node executable: override, fetched runtime, then the running node. */
function resolveNode() {
  if (process.env.SMOKE_NODE !== undefined && process.env.SMOKE_NODE !== '') return process.env.SMOKE_NODE
  const fetched = join(desktopRoot, 'build', 'node-runtime', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
  return existsSync(fetched) ? fetched : process.execPath
}

/** The dsh CLI entry: override, then the dev runtime closure. */
function resolveDshBin() {
  if (process.env.SMOKE_DSH_BIN !== undefined && process.env.SMOKE_DSH_BIN !== '') return process.env.SMOKE_DSH_BIN
  return join(desktopRoot, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

const nodeExe = resolveNode()
const dshBin = resolveDshBin()
if (!existsSync(dshBin)) {
  console.error(`dsh entry missing: ${dshBin}`)
  console.error('run: pnpm run runtime:install')
  process.exit(1)
}

const startedAt = Date.now()
const lines = []
const child = spawn(nodeExe, [dshBin, 'web', '--port', '0', '--host', '127.0.0.1'], {
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

const watchdog = setTimeout(() => {
  finish(false, `timed out after ${String(READY_TIMEOUT_MS)} ms waiting for the dsh web URL line`)
}, READY_TIMEOUT_MS)
watchdog.unref()

let readyResolve
const ready = new Promise((resolve) => { readyResolve = resolve })
const dead = new Promise((resolve) => {
  child.once('exit', (code, signal) => { lines.push(`[exit] code=${String(code)} signal=${String(signal)}`); resolve(null) })
  child.once('error', (error) => { lines.push(`[error] ${String(error)}`); resolve(null) })
})

createInterface({ input: child.stdout }).on('line', (line) => {
  lines.push(`[out] ${line}`)
  const match = READY_LINE.exec(line)
  if (match !== null) readyResolve(match[1])
})
createInterface({ input: child.stderr }).on('line', (line) => { lines.push(`[err] ${line}`) })

const url = await Promise.race([ready, dead])
if (url === null) {
  finish(false, `dsh web exited before printing its URL line (node: ${nodeExe}, bin: ${dshBin})`)
}

const port = new URL(url).port
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
finish(true, `smoke ok: ${url} (port ${port}, ${String(elapsed)} ms, status 200, ${String(body.length)} bytes)`)
