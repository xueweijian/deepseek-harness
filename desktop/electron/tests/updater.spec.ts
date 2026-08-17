import { afterEach, describe, expect, it, vi } from 'vitest'

const electronApp = vi.hoisted(() => ({
  app: { isPackaged: true },
}))

const autoUpdater = vi.hoisted(() => ({
  on: vi.fn(),
  checkForUpdatesAndNotify: vi.fn((): Promise<void> => Promise.resolve()),
  quitAndInstall: vi.fn(),
}))

vi.mock('electron', () => electronApp)
vi.mock('electron-updater', () => ({ autoUpdater }))

import { installDownloadedUpdate, startUpdater } from '../updater.ts'

const realPlatform = process.platform

/** The handler registered for `name`, typed by what the test invokes it with. */
function listener<T>(name: string): (payload: T) => void {
  const call = autoUpdater.on.mock.calls.find(([event]) => event === name)
  if (call === undefined) throw new Error(`no ${name} listener registered`)
  return call[1] as (payload: T) => void
}

afterEach(() => {
  electronApp.app.isPackaged = true
  autoUpdater.on.mockClear()
  autoUpdater.checkForUpdatesAndNotify.mockClear()
  autoUpdater.checkForUpdatesAndNotify.mockImplementation(() => Promise.resolve())
  autoUpdater.quitAndInstall.mockClear()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('startUpdater', () => {
  it('skips entirely in development', () => {
    electronApp.app.isPackaged = false
    const logs: string[] = []
    const downloaded: string[] = []
    startUpdater((line) => { logs.push(line) }, { onDownloaded: (v) => { downloaded.push(v) } })
    expect(logs).toEqual(['updater: skipped in development'])
    expect(autoUpdater.on).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    expect(downloaded).toEqual([])
  })

  it('disables updating on macOS because unsigned builds cannot self-update', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const logs: string[] = []
    startUpdater((line) => { logs.push(line) }, { onDownloaded: () => {} })
    expect(logs[0]).toMatch(/disabled on macOS/)
    expect(autoUpdater.on).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
  })

  it('registers listeners, checks immediately, and re-checks on the interval', () => {
    vi.useFakeTimers()
    const logs: string[] = []
    startUpdater((line) => { logs.push(line) }, { onDownloaded: () => {} })
    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(autoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function))
    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2)
    expect(logs).toEqual([])
  })

  it('reports a failed check through the log sink', async () => {
    autoUpdater.checkForUpdatesAndNotify.mockImplementationOnce(() => Promise.reject(new Error('network down')))
    const logs: string[] = []
    startUpdater((line) => { logs.push(line) }, { onDownloaded: () => {} })
    await vi.waitFor(() => { expect(logs.some((line) => line.includes('check failed'))).toBe(true) })
  })

  it('forwards update-downloaded with the version, tolerating a missing one', () => {
    const logs: string[] = []
    const downloaded: string[] = []
    startUpdater((line) => { logs.push(line) }, { onDownloaded: (v) => { downloaded.push(v) } })
    listener<{ version?: string }>('update-downloaded')({ version: '0.2.1' })
    expect(downloaded).toEqual(['0.2.1'])
    expect(logs.some((line) => line.includes('0.2.1'))).toBe(true)
    listener<{ version?: string }>('update-downloaded')({})
    expect(downloaded).toEqual(['0.2.1', ''])
  })

  it('logs updater errors without surfacing them', () => {
    const logs: string[] = []
    startUpdater((line) => { logs.push(line) }, { onDownloaded: () => {} })
    listener<Error>('error')(new Error('boom'))
    expect(logs.some((line) => line.includes('boom'))).toBe(true)
  })
})

describe('installDownloadedUpdate', () => {
  it('quits and installs through electron-updater', () => {
    installDownloadedUpdate()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
