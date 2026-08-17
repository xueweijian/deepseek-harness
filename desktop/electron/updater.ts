/**
 * Auto-update wiring: packaged builds check the GitHub publish target on
 * startup and every four hours; failures are logged, never surfaced as UI.
 * macOS builds skip updating entirely because Squirrel.Mac cannot self-update
 * an unsigned (ad-hoc) app; users there install new dmgs manually.
 * @module dsh-desktop/updater
 */

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/** Spacing between background update checks. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Shell reactions to update progress beyond logging. */
export interface UpdaterCallbacks {
  /** A new version finished downloading; the shell offers a restart. */
  onDownloaded(version: string): void
}

/**
 * Start checking for updates; a no-op in development and on macOS.
 * @param log - sink for update-check outcomes, one line per event.
 * @param callbacks - shell reactions to update progress.
 */
export function startUpdater(log: (message: string) => void, callbacks: UpdaterCallbacks): void {
  if (!app.isPackaged) {
    log('updater: skipped in development')
    return
  }
  if (process.platform === 'darwin') {
    log('updater: disabled on macOS (unsigned builds cannot self-update)')
    return
  }
  autoUpdater.on('error', (error: Error) => { log(`updater: ${String(error)}`) })
  autoUpdater.on('update-downloaded', (info: { version?: string }) => {
    log(`updater: version ${info.version ?? 'unknown'} downloaded, pending restart`)
    callbacks.onDownloaded(info.version ?? '')
  })
  const check = (): void => {
    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      log(`updater: check failed: ${String(error)}`)
    })
  }
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}

/** Quit and run the downloaded installer; safe only after onDownloaded. */
export function installDownloadedUpdate(): void {
  autoUpdater.quitAndInstall()
}
