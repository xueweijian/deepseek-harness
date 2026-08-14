/**
 * DSH Desktop main process: single-instance shell window over the dsh web
 * sidecar, with loopback-only navigation, external links in the system
 * browser, blanket permission denial, and sidecar teardown before quit.
 * @module dsh-desktop/main
 */

import { app, BrowserWindow, session, shell } from 'electron'
import { startSidecar, stopSidecar, type SidecarFailure } from './sidecar'
import { startUpdater } from './updater'

/** Delay on the error page before the sidecar is started again. */
const RETRY_DELAY_MS = 10_000
/** Longest quit waits for sidecar teardown before exiting anyway. */
const SHUTDOWN_GRACE_MS = 5_000

let mainWindow: BrowserWindow | undefined
let allowedOrigin: string | undefined
let retryTimer: NodeJS.Timeout | undefined
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow
    if (win === undefined) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  void app.whenReady().then(boot)
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    void Promise.race([stopSidecar(), delay(SHUTDOWN_GRACE_MS)]).finally(() => { app.quit() })
  })
}

/** Create the window, then start updates and the sidecar. */
function boot(): void {
  createWindow()
  startUpdater((message) => { console.log(message) })
  launchSidecar()
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

/** The data-URL error page: inline styles, a retry countdown, and the log tail. */
function errorPageUrl(failure: SidecarFailure): string {
  const tail = escapeHtml(failure.logTail.trimEnd())
  const reason = failure.timedOut
    ? '服务启动超时'
    : `服务进程退出（code ${String(failure.exitCode)}）`
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Desktop</title>
<style>
body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #101418; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
main { max-width: 860px; padding: 32px; }
h1 { font-size: 20px; color: #ff6b6b; }
p { color: #b8c0c8; }
.count { font-variant-numeric: tabular-nums; color: #7ab8ff; font-weight: 600; }
pre { background: #05070a; border: 1px solid #2a3138; border-radius: 8px; padding: 12px; overflow: auto; max-height: 320px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<main>
<h1>dsh 服务启动失败</h1>
<p>${reason}，将在 <span class="count" id="seconds">10</span> 秒后自动重试；也可以关闭窗口稍后再试。</p>
<pre>${tail === '' ? '（无输出）' : tail}</pre>
<script>
var seconds = 10
var el = document.getElementById('seconds')
setInterval(function () {
  seconds = Math.max(0, seconds - 1)
  el.textContent = String(seconds)
}, 1000)
</script>
</main>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Escape text for embedding into the error page. */
function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return text.replace(/[&<>"']/g, (ch) => entities[ch] ?? ch)
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
