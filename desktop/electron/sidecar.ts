/**
 * dsh web sidecar supervisor: spawns the bundled `dsh web` server under the
 * packaged Node runtime, confirms readiness from its URL line, keeps it alive
 * with a bounded exponential-backoff restart budget, collects a log tail for
 * the error page and the log file, and tears the process tree down on exit.
 * @module dsh-desktop/sidecar
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'

/** Loopback host shared by the server bind and the loaded URL. */
const HOST = '127.0.0.1'
/** Upper bound from spawn to the readiness URL line, per attempt. */
const READY_TIMEOUT_MS = 60_000
/** Crash restarts allowed per startSidecar call before reporting fatal. */
const MAX_RESTARTS = 3
/** Base delay for the exponential restart backoff; doubles per restart. */
const BACKOFF_BASE_MS = 1_000
/** Longest stop() waits for process-tree teardown before resolving. */
const STOP_GRACE_MS = 5_000
/** Delay after SIGTERM before the posix kill escalates to SIGKILL. */
const KILL_GRACE_MS = 1_000
/** Retained output lines for the error page and diagnostics. */
const LOG_RING_LINES = 200
/** Readiness marker `dsh web` prints once the server accepts requests. */
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** Absolute paths of the sidecar's Node executable and dsh entry. */
export interface SidecarPaths {
  /** Node 24 executable: packaged under resourcesPath, `node` on PATH in dev. */
  readonly nodeExe: string
  /** The published dsh CLI entry, `lib/bin.js` inside its package. */
  readonly dshBin: string
}

/** Why the supervisor gave up keeping the server alive. */
export interface SidecarFailure {
  /** Exit code of the last child, null when killed without an observed code. */
  readonly exitCode: number | null
  /** Termination signal of the last child, when one was observed. */
  readonly signal: NodeJS.Signals | null
  /** True when the last attempt never printed the readiness URL line. */
  readonly timedOut: boolean
  /** Last LOG_RING_LINES output lines, stdout and stderr interleaved. */
  readonly logTail: string
}

/** Events the shell window reacts to across restarts. */
export interface SidecarCallbacks {
  /** The server reached readiness; `url` is the loopback origin to load. */
  onReady(url: string): void
  /** The restart budget is spent; the shell shows the error page. */
  onFatal(failure: SidecarFailure): void
}

/** Resolve the sidecar's Node executable and dsh entry for this run mode. */
export function resolveSidecarPaths(): SidecarPaths {
  if (app.isPackaged) {
    const exeSegments = process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']
    return {
      nodeExe: join(process.resourcesPath, 'node', ...exeSegments),
      dshBin: join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    }
  }
  return {
    nodeExe: 'node',
    dshBin: join(app.getAppPath(), 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  }
}

/** Log file sink for this run mode: user logs dir packaged, project dir in dev. */
function logFilePath(): string {
  if (app.isPackaged) return join(app.getPath('logs'), 'sidecar.log')
  return join(app.getAppPath(), '.dev', 'sidecar.log')
}

/** Ask the OS for one currently free loopback port and release it again. */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', (error: NodeJS.ErrnoException) => { reject(error) })
    server.listen(0, HOST, () => {
      const address = server.address() as AddressInfo
      const port = address.port
      server.close(() => { resolve(port) })
    })
  })
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Kill the whole process tree of `child`: taskkill on Windows, the process
 * group (child spawns detached as its leader) on posix with SIGKILL follow-up. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  const killer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  }, KILL_GRACE_MS)
  killer.unref()
}

/** Observed end state of one child process attempt. */
interface AttemptOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
}

/** One supervision session, from startSidecar to fatal or stopSidecar. */
class Supervisor {
  private child: ChildProcess | undefined
  private readonly ring: string[] = []
  private restartsUsed = 0
  private stopping = false

  constructor(private readonly callbacks: SidecarCallbacks) {}

  /** Supervision loop: spawn until stopped or the restart budget is spent. */
  async run(): Promise<void> {
    for (;;) {
      const outcome = await this.spawnOnce()
      if (this.stopping) return
      this.log(`sidecar: exited (code=${String(outcome.exitCode)} signal=${String(outcome.signal)} timedOut=${String(outcome.timedOut)})`)
      if (this.restartsUsed >= MAX_RESTARTS) {
        this.callbacks.onFatal({
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          logTail: this.tail(),
        })
        return
      }
      const backoff = BACKOFF_BASE_MS * 2 ** this.restartsUsed
      this.restartsUsed += 1
      this.log(`sidecar: restarting in ${String(backoff)} ms (restart ${String(this.restartsUsed)}/${String(MAX_RESTARTS)})`)
      await delay(backoff)
      if (this.stopping) return
    }
  }

  /** Stop the active child and let run() unwind; safe to await from the app. */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (child === undefined) return
    killTree(child)
    await Promise.race([onceExit(child), delay(STOP_GRACE_MS)])
  }

  /** Last LOG_RING_LINES collected lines. */
  tail(): string {
    return this.ring.join('\n')
  }

  /** Spawn one dsh web child and wait for its exit; notifies onReady with the
   * URL the child itself printed, without waiting for the exit. */
  private async spawnOnce(): Promise<AttemptOutcome> {
    const paths = resolveSidecarPaths()
    const port = await reservePort()
    const child = spawn(paths.nodeExe, [paths.dshBin, 'web', '--port', String(port), '--host', HOST], {
      cwd: homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    this.log(`sidecar: spawned ${paths.nodeExe} ${paths.dshBin} web --port ${String(port)} --host ${HOST} (pid ${String(child.pid)})`)
    const outcome: AttemptOutcome = { exitCode: null, signal: null, timedOut: false }
    let readyResolve: ((url: string) => void) | undefined
    const ready = new Promise<string>((resolve) => { readyResolve = resolve })
    const exited = onceExit(child, (code, signal) => {
      outcome.exitCode = code
      outcome.signal = signal
    })
    const readyTimer = setTimeout(() => {
      outcome.timedOut = true
      this.log('sidecar: readiness timeout, killing the child')
      killTree(child)
    }, READY_TIMEOUT_MS)
    this.wireStream(child.stdout, 'out', (line) => {
      const match = READY_LINE.exec(line)
      if (match !== null) readyResolve?.(match[1])
    })
    this.wireStream(child.stderr, 'err', () => {})
    const winner = await Promise.race([ready.then(() => 'ready' as const), exited.then(() => 'exit' as const)])
    clearTimeout(readyTimer)
    if (winner === 'ready') this.callbacks.onReady(await ready)
    await exited
    return outcome
  }

  /** Tag every line with its stream, push it to the ring, and append to the
   * log file; `onLine` sees the raw line first. */
  private wireStream(stream: NodeJS.ReadableStream | null, tag: string, onLine: (line: string) => void): void {
    if (stream === null) return
    const lines = createInterface({ input: stream })
    lines.on('line', (line: string) => {
      onLine(line)
      this.log(`[${tag}] ${line}`)
    })
  }

  /** Record one supervisor or child line in the ring and the log file. */
  private log(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}`
    this.ring.push(stamped)
    if (this.ring.length > LOG_RING_LINES) this.ring.splice(0, this.ring.length - LOG_RING_LINES)
    try {
      const file = logFilePath()
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${stamped}\n`)
    } catch {
      /* log dir unwritable; the ring still backs the error page */
    }
  }
}

/** Promise that resolves when the child exits or fails to spawn, recording the
 * observed code and signal into `record`. */
function onceExit(
  child: ChildProcess,
  record?: (code: number | null, signal: NodeJS.Signals | null) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      record?.(code, signal)
      resolve()
    }
    child.once('exit', (code, signal) => { finish(code, signal) })
    child.once('error', (error: Error) => {
      console.error(`sidecar: spawn error: ${String(error)}`)
      finish(null, null)
    })
  })
}

/** The supervision session started by the most recent startSidecar call. */
let active: Supervisor | undefined

/** Start supervising the dsh web sidecar; readiness and fatality arrive through
 * `callbacks`. Throws when a session is already running. */
export function startSidecar(callbacks: SidecarCallbacks): void {
  if (active !== undefined) throw new Error('sidecar already started')
  const supervisor = new Supervisor(callbacks)
  active = supervisor
  void supervisor.run().finally(() => {
    if (active === supervisor) active = undefined
  })
}

/** Stop the active session and wait (at most STOP_GRACE_MS) for teardown. */
export async function stopSidecar(): Promise<void> {
  const supervisor = active
  active = undefined
  if (supervisor !== undefined) await supervisor.stop()
}
