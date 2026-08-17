/**
 * dsh web sidecar supervisor: spawns the bundled `dsh web` server under the
 * packaged Node runtime, confirms readiness by polling the loopback URL we
 * told the server to serve (independent of the child's log format), keeps it
 * alive with a bounded exponential-backoff restart budget, collects a log
 * tail for the error page and the log file, and tears the process tree down
 * on exit.
 * @module dsh-desktop/sidecar
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'

/** Loopback host shared by the server bind and the loaded URL. */
const HOST = '127.0.0.1'
/** Upper bound from spawn to the first successful HTTP response, per attempt.
 * Overridable for machines whose first boot runs slowly (AV scans, cold
 * disks): DSH_SIDECAR_READY_TIMEOUT_MS. */
const READY_TIMEOUT_MS = readPositiveIntEnv('DSH_SIDECAR_READY_TIMEOUT_MS', 60_000)
/** Spacing between readiness polls while the server is starting. */
const POLL_INTERVAL_MS = 250
/** Per-poll HTTP timeout; a server slower than this is retried, not failed. */
const POLL_TIMEOUT_MS = 2_000
/** Crash restarts allowed per startSidecar call before reporting fatal.
 * Overridable: DSH_SIDECAR_MAX_RESTARTS. */
const MAX_RESTARTS = readPositiveIntEnv('DSH_SIDECAR_MAX_RESTARTS', 3)
/** Base delay for the exponential restart backoff; doubles per restart.
 * Overridable: DSH_SIDECAR_BACKOFF_BASE_MS. */
const BACKOFF_BASE_MS = readPositiveIntEnv('DSH_SIDECAR_BACKOFF_BASE_MS', 1_000)
/** Longest stop() waits for process-tree teardown before resolving. */
const STOP_GRACE_MS = 5_000
/** Delay after SIGTERM before the posix kill escalates to SIGKILL. */
const KILL_GRACE_MS = 1_000
/** Retained output lines for the error page and diagnostics. */
const LOG_RING_LINES = 200

/** Read a positive-integer environment override, failing loud at load when the
 * value is set but unparsable: a typo silently ignored is worse than a boot
 * error naming the variable. */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return value
}

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

/** Resolve the sidecar's Node executable and dsh entry for this run mode.
 * Throws with an actionable message when the dsh package or its bin entry is
 * unreadable, so a broken runtime closure fails loud instead of looping. */
export function resolveSidecarPaths(): SidecarPaths {
  if (app.isPackaged) {
    const exeSegments = process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']
    return {
      nodeExe: join(process.resourcesPath, 'node', ...exeSegments),
      dshBin: resolveDshEntry(join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')),
    }
  }
  return {
    nodeExe: 'node',
    dshBin: resolveDshEntry(join(app.getAppPath(), 'runtime', 'node_modules', '@deepseek-ai', 'dsh')),
  }
}

/** Resolve the CLI entry from the installed dsh package manifest's `bin`
 * field, so an upstream repackaging that moves `lib/bin.js` needs no change
 * here as long as the manifest stays truthful. */
export function resolveDshEntry(packageDir: string): string {
  const manifestPath = join(packageDir, 'package.json')
  let bin: unknown
  try {
    bin = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown }).bin
  } catch (error) {
    throw new Error(`dsh package manifest unreadable at ${manifestPath}: ${String(error)}`)
  }
  if (typeof bin === 'string' && bin !== '') return join(packageDir, bin)
  if (typeof bin === 'object' && bin !== null) {
    const entries = Object.entries(bin as Record<string, unknown>)
    const named = entries.find(([name]) => name === 'dsh')
    const single = entries.length === 1 ? entries[0] : undefined
    const chosen = named ?? single
    if (chosen !== undefined && typeof chosen[1] === 'string' && chosen[1] !== '') {
      return join(packageDir, chosen[1])
    }
  }
  throw new Error(`dsh package manifest has no usable bin entry: ${manifestPath}`)
}

/** Log file sink for this run mode: user logs dir packaged, project dir in dev.
 * The packaged arm runs for real in the packaged CI smoke, which asserts on
 * the written sidecar.log; unit tests only reach the dev arm. */
function logFilePath(): string {
  /* v8 ignore next -- packaged arm; see jsdoc */
  if (app.isPackaged) return join(app.getPath('logs'), 'sidecar.log')
  return join(app.getAppPath(), '.dev', 'sidecar.log')
}

/** Ask the OS for one currently free loopback port and release it again. */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    /* v8 ignore next -- listen(0) failure is not reproducible from a healthy host */
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

/** Poll `url` until it answers with any HTTP response. Connection refused and
 * per-attempt timeouts are the normal pre-ready state and simply retry; the
 * caller bounds the total wait through the child's readiness timer. */
export async function pollReady(url: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })
      try {
        /* v8 ignore next 3 -- cancel() rejecting on an open body is not reproducible */
        await response.body?.cancel()
      } catch {
        /* body already closed after a complete response */
      }
      return
    } catch {
      await delay(POLL_INTERVAL_MS)
    }
  }
}

/** Stop `child` and its process group where the platform exposes one. POSIX
 * children are detached leaders; Windows uses Node's supported child handle
 * because invoking a shell process-tree command would introduce a command
 * injection boundary. The sidecar's dsh child owns no long-lived descendants
 * outside its own handle in the supported runtime closure. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  /* v8 ignore next 2 -- guards the readyTimer race where the child exits
   * between the timeout firing and the kill; stop() pre-checks instead. */
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      child.kill()
    } catch {
      /* child already exited between the state check and kill */
    }
    return
  }
  /* v8 ignore start: posix process-group teardown; unreachable on Windows
   * hosts, exercised by the posix legs of the CI matrix. */
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
  /* v8 ignore end */
}

/** Observed end state of one child process attempt. */
interface AttemptOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
}

/** One supervision session, from startSidecar to fatal or stopSidecar. */
export class Supervisor {
  private child: ChildProcess | undefined
  private readonly ring: string[] = []
  private restartsUsed = 0
  private stopping = false

  /** `paths` pins the Node executable and dsh entry instead of resolving the
   * run mode's own; production callers omit it. */
  constructor(
    private readonly callbacks: SidecarCallbacks,
    private readonly paths?: SidecarPaths,
  ) {}

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

  /** Stop the active child and let run() unwind; safe to await from the app.
   * A child that already exited needs neither kill nor the grace wait —
   * registering another exit listener on it would never fire. */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    killTree(child)
    await Promise.race([onceExit(child), delay(STOP_GRACE_MS)])
  }

  /** Last LOG_RING_LINES collected lines. */
  tail(): string {
    return this.ring.join('\n')
  }

  /** Spawn one dsh web child and wait for its exit; notifies onReady with the
   * URL we told the server to serve, without waiting for the exit. */
  private async spawnOnce(): Promise<AttemptOutcome> {
    const paths = this.paths ?? resolveSidecarPaths()
    const port = await reservePort()
    const url = `http://${HOST}:${String(port)}`
    const child = spawn(paths.nodeExe, [paths.dshBin, 'web', '--port', String(port), '--host', HOST], {
      cwd: homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    this.log(`sidecar: spawned ${paths.nodeExe} ${paths.dshBin} web --port ${String(port)} --host ${HOST} (pid ${String(child.pid)})`)
    let exitCode: number | null = null
    let signal: NodeJS.Signals | null = null
    let timedOut = false
    const exited = onceExit(child, (code, sig) => {
      exitCode = code
      signal = sig
    })
    const readyTimer = setTimeout(() => {
      timedOut = true
      this.log('sidecar: readiness timeout, killing the child')
      killTree(child)
    }, READY_TIMEOUT_MS)
    this.wireStream(child.stdout, 'out')
    this.wireStream(child.stderr, 'err')
    const winner = await Promise.race([pollReady(url).then(() => 'ready' as const), exited.then(() => 'exit' as const)])
    clearTimeout(readyTimer)
    if (winner === 'ready') this.callbacks.onReady(url)
    await exited
    return { exitCode, signal, timedOut }
  }

  /** Tag every line with its stream, push it to the ring, and append to the
   * log file; diagnostics only — readiness never depends on this output. */
  private wireStream(stream: NodeJS.ReadableStream | null, tag: string): void {
    if (stream === null) return
    const lines = createInterface({ input: stream })
    lines.on('line', (line: string) => {
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
 * `callbacks`. Throws when a session is already running. Setup failures — an
 * unreadable dsh manifest, for example — surface through onFatal with the
 * reason in the log tail instead of an unhandled rejection. */
export function startSidecar(callbacks: SidecarCallbacks): void {
  if (active !== undefined) throw new Error('sidecar already started')
  const supervisor = new Supervisor(callbacks)
  active = supervisor
  void supervisor.run().catch((error: unknown) => {
    callbacks.onFatal({
      exitCode: null,
      signal: null,
      timedOut: false,
      logTail: `sidecar: ${String(error)}`,
    })
  }).finally(() => {
    if (active === supervisor) active = undefined
  })
}

/** Stop the active session and wait (at most STOP_GRACE_MS) for teardown. */
export async function stopSidecar(): Promise<void> {
  const supervisor = active
  active = undefined
  if (supervisor !== undefined) await supervisor.stop()
}
