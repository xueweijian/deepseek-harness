/**
 * Auto-update wiring: packaged builds check the GitHub publish target on
 * startup and every four hours; failures are logged, never surfaced as UI.
 * @module dsh-desktop/updater
 */

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/** Spacing between background update checks. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Start checking for updates; a no-op in development.
 * @param log - sink for update-check outcomes, one line per event.
 */
export function startUpdater(log: (message: string) => void): void {
  if (!app.isPackaged) {
    log('updater: skipped in development')
    return
  }
  autoUpdater.on('error', (error: Error) => { log(`updater: ${String(error)}`) })
  const check = (): void => {
    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      log(`updater: check failed: ${String(error)}`)
    })
  }
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}
