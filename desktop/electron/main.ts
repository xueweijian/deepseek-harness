/**
 * DSH Desktop main process: single-instance shell window over the dsh web
 * sidecar, with loopback-only navigation, external links in the system
 * browser, blanket permission denial, close-to-tray, dsh:// deep links,
 * update notifications, and sidecar teardown before quit.
 * @module dsh-desktop/main
 */

import { join } from 'node:path'
import { app, BrowserWindow, Menu, Notification, session, shell, Tray } from 'electron'
import { errorPageUrl, findDeepLink } from './helpers'
import { startSidecar, stopSidecar, type SidecarFailure } from './sidecar'
import { installDownloadedUpdate, startUpdater } from './updater'

/** Delay on the error page before the sidecar is started again. */
const RETRY_DELAY_MS = 10_000
/** Longest quit waits for sidecar teardown before exiting anyway. */
const SHUTDOWN_GRACE_MS = 5_000

let mainWindow: BrowserWindow | undefined
let allowedOrigin: string | undefined
let retryTimer: NodeJS.Timeout | undefined
let quitting = false
let tray: Tray | undefined
let hiddenNotified = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const link = findDeepLink(commandLine)
    if (link !== undefined) handleDeepLink(link)
    focusOrCreateWindow()
  })
  // macOS delivers dsh:// links through open-url, possibly before ready.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })
  app.on('activate', () => { focusOrCreateWindow() })
  void app.whenReady().then(boot)
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    if (tray !== undefined) {
      tray.destroy()
      tray = undefined
    }
    event.preventDefault()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    void Promise.race([stopSidecar(), delay(SHUTDOWN_GRACE_MS)]).finally(() => { app.quit() })
  })
}

/** Create the window and tray, register the protocol, then start updates and
 * the sidecar. */
function boot(): void {
  app.setAsDefaultProtocolClient('dsh')
  const coldLink = findDeepLink(process.argv)
  if (coldLink !== undefined) console.log(`main: cold-start deep link ${coldLink}`)
  createWindow()
  createTray()
  startUpdater((message) => { console.log(message) }, {
    onDownloaded: (version) => { notifyUpdateReady(version) },
  })
  launchSidecar()
}

/** A dsh:// link arrived; the web UI defines no routes for them yet, so the
 * shell records the target and brings the window forward. */
function handleDeepLink(url: string): void {
  console.log(`main: deep link ${url}`)
  focusOrCreateWindow()
}

/** Start (or restart after a fatal failure) the sidecar and load its URL. */
function launchSidecar(): void {
  startSidecar({
    onReady: (url) => {
      allowedOrigin = new URL(url).origin
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url).catch(() => { /* load raced a window teardown */ })
      }
    },
    onFatal: (failure) => { void recover(failure) },
  })
}

/** Show the error page with the log tail, then retry after the countdown. */
async function recover(failure: SidecarFailure): Promise<void> {
  await stopSidecar()
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) return
  await win.loadURL(errorPageUrl(failure)).catch(() => { /* window destroyed while loading the error page */ })
  retryTimer = setTimeout(launchSidecar, RETRY_DELAY_MS)
}

/** Create the locked-down shell window and install its navigation guards. */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'DSH Desktop',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
  // With a tray present, the close button hides the window instead of
  // quitting; tray「退出」 and app.quit() still close for real.
  mainWindow.on('close', (event) => {
    if (quitting || tray === undefined) return
    event.preventDefault()
    mainWindow?.hide()
    notifyHiddenToTray()
  })
  mainWindow.once('ready-to-show', () => { mainWindow?.show() })
  const contents = mainWindow.webContents
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

/** Show, restore, and focus the shell window, recreating it when destroyed. */
function focusOrCreateWindow(): void {
  const win = mainWindow
  if (win === undefined || win.isDestroyed()) {
    createWindow()
    if (allowedOrigin !== undefined && mainWindow !== undefined) {
      mainWindow.loadURL(allowedOrigin).catch(() => { /* load raced a window teardown */ })
    }
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Create the tray icon with its menu; closing the window hides to it. */
function createTray(): void {
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'app-icon.png') : join(app.getAppPath(), 'build', 'icon.png')
  tray = new Tray(iconPath)
  tray.setToolTip('DSH Desktop')
  tray.on('click', () => { focusOrCreateWindow() })
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { focusOrCreateWindow() } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } },
  ]))
}

/** Tell the user once per run where the window went after hiding to tray. */
function notifyHiddenToTray(): void {
  if (hiddenNotified || !Notification.isSupported()) return
  hiddenNotified = true
  new Notification({ title: 'DSH Desktop', body: '窗口已最小化到托盘，点击托盘图标恢复。' }).show()
}

/** Offer the restart that installs the downloaded update. */
function notifyUpdateReady(version: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: 'DSH Desktop 更新已就绪',
    body: version === '' ? '新版本已下载，点击此处重启安装。' : `新版本 ${version} 已下载，点击此处重启安装。`,
  })
  notification.on('click', () => {
    if (quitting) return
    quitting = true
    installDownloadedUpdate()
  })
  notification.show()
}

/** The data-URL error page and deep-link scanning live in helpers.ts. */

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
