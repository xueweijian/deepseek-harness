import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarFailure, SidecarPaths } from '../sidecar.ts'

const electronApp = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => '',
    getPath: (_name: string): string => '',
    resourcesPath: '',
  },
}))

vi.mock('electron', () => electronApp)

type SidecarModule = typeof import('../sidecar.ts')

/** Import the sidecar fresh, with env overrides active for the module-load
 * constant reads; restores env afterwards. */
async function importSidecar(env: Record<string, string>): Promise<SidecarModule> {
  vi.resetModules()
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
  try {
    return await import('../sidecar.ts')
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const testsDir = dirname(fileURLToPath(import.meta.url))
const fixture = join(testsDir, 'fixtures', 'fake-dsh-web.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'dsh-supervision-spec-'))

/** Fast-supervision overrides: tight readiness window, minimal backoff. */
const FAST = {
  DSH_SIDECAR_READY_TIMEOUT_MS: '1200',
  DSH_SIDECAR_MAX_RESTARTS: '2',
  DSH_SIDECAR_BACKOFF_BASE_MS: '20',
}

/** Supervisor paths running the fixture under the test runner's own node. */
function fixturePaths(): SidecarPaths {
  return { nodeExe: process.execPath, dshBin: fixture }
}

/** One supervised fixture session: whoever awaits `ready` or `fatal` first
 * observes the outcome; `stop` tears down and `done` settles when the
 * supervision loop unwinds. */
interface Session {
  readonly ready: Promise<string>
  readonly fatal: Promise<SidecarFailure>
  stop(): Promise<void>
  readonly done: Promise<void>
}

/** Start a supervised fixture child with the given fixture-behavior env;
 * `paths` overrides the executable under test (default: the fixture). */
async function startSession(fixtureEnv: Record<string, string> = {}, paths: SidecarPaths = fixturePaths()): Promise<Session> {
  const mod = await importSidecar(FAST)
  for (const [name, value] of Object.entries(fixtureEnv)) vi.stubEnv(name, value)
  let onReadyResolve!: (url: string) => void
  const ready = new Promise<string>((resolve) => { onReadyResolve = resolve })
  let onFatalResolve!: (failure: SidecarFailure) => void
  const fatal = new Promise<SidecarFailure>((resolve) => { onFatalResolve = resolve })
  const supervisor = new mod.Supervisor({
    onReady: (url) => { onReadyResolve(url) },
    onFatal: (failure) => { onFatalResolve(failure) },
  }, paths)
  const done = supervisor.run()
  return { ready, fatal, stop: () => supervisor.stop(), done }
}

beforeEach(() => {
  electronApp.app.getAppPath = (): string => workDir
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Supervisor with a real fixture child', () => {
  it('reports readiness at the URL we assigned, serves traffic, and tears down on stop', async () => {
    const session = await startSession()
    const url = await session.ready
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    await response.text()
    await session.stop()
    await session.done
    await expect(fetch(url)).rejects.toThrow()
  })

  it('reaches readiness across a startup delay longer than one poll interval', async () => {
    const session = await startSession({ FAKE_DELAY_MS: '700' })
    const url = await session.ready
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    await response.text()
    await session.stop()
    await session.done
  })

  it('spends the restart budget on instant crashes and reports the last exit code', async () => {
    const session = await startSession({ FAKE_EXIT_CODE: '7' })
    const report = await session.fatal
    expect(report.exitCode).toBe(7)
    expect(report.timedOut).toBe(false)
    await session.done
  })

  it('treats a never-serving child as a readiness timeout, not a crash', async () => {
    const session = await startSession({ FAKE_NEVER_READY: '1' })
    const report = await session.fatal
    expect(report.timedOut).toBe(true)
    await session.done
  })

  it('caps the retained log tail at the ring size', async () => {
    const session = await startSession({ FAKE_SPAM_LINES: '250', FAKE_EXIT_CODE: '7' })
    const report = await session.fatal
    const lines = report.logTail.split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(200)
    await session.done
  })

  it('routes spawn failures through the restart budget like crashes', async () => {
    const session = await startSession({}, { nodeExe: join(workDir, 'missing-node.exe'), dshBin: fixture })
    const report = await session.fatal
    expect(report.exitCode).toBeNull()
    expect(report.timedOut).toBe(false)
    await session.done
  })

  it('stop() resolves promptly when the child already exited on its own', async () => {
    const session = await startSession({ FAKE_EXIT_AFTER_MS: '200' })
    const report = await session.fatal
    expect(report.exitCode).toBe(0)
    const stoppedAt = Date.now()
    await session.stop()
    expect(Date.now() - stoppedAt).toBeLessThan(5_000)
    await session.done
  })
})

describe('startSidecar session lifecycle', () => {
  /** Start through the module-level API against a dev app path with no dsh
   * package: setup must fail through onFatal, never as a rejection. */
  async function startBrokenSession(): Promise<{ failure: Promise<SidecarFailure>; stop(): Promise<void> }> {
    const { startSidecar, stopSidecar } = await importSidecar(FAST)
    electronApp.app.getAppPath = (): string => join(workDir, 'no-runtime-here')
    const failure = new Promise<SidecarFailure>((resolve) => {
      startSidecar({ onReady: () => {}, onFatal: resolve })
    })
    return { failure, stop: () => stopSidecar() }
  }

  it('rejects a second concurrent session and reports setup failure through onFatal', async () => {
    const { startSidecar, stopSidecar } = await importSidecar(FAST)
    electronApp.app.getAppPath = (): string => join(workDir, 'no-runtime-here')
    let reported: SidecarFailure | undefined
    const firstFailure = new Promise<SidecarFailure>((resolve) => {
      startSidecar({ onReady: () => {}, onFatal: (f) => { reported = f; resolve(f) } })
    })
    expect(() => startSidecar({ onReady: () => {}, onFatal: () => {} })).toThrow('sidecar already started')
    const failure = await firstFailure
    expect(failure.logTail).toMatch(/manifest unreadable/)
    await stopSidecar()
    expect(reported).toBeDefined()
  })

  it('clears the session after a fatal setup failure and allows a new one', async () => {
    const first = await startBrokenSession()
    expect((await first.failure).logTail).toMatch(/manifest unreadable/)
    await first.stop()
    const second = await startBrokenSession()
    expect((await second.failure).logTail).toMatch(/manifest unreadable/)
    await second.stop()
  })
})
