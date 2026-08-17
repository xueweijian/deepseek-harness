/**
 * Pure main-process helpers with no Electron dependency: deep-link argv
 * scanning and the data-URL error page. Kept separate so the shell's pure
 * decisions are testable without an Electron runtime.
 * @module dsh-desktop/helpers
 */

import type { SidecarFailure } from './sidecar'

/** First `dsh://` link in an argv-style list, case-insensitive on the scheme,
 * or undefined when none is present. */
export function findDeepLink(argv: readonly string[]): string | undefined {
  return argv.find((arg) => /^dsh:\/\//i.test(arg))
}

/** The data-URL error page: inline styles, a retry countdown, and the log tail. */
export function errorPageUrl(failure: SidecarFailure): string {
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
export function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return text.replace(/[&<>"']/g, (ch) => entities[ch])
}
