#!/usr/bin/env node
/**
 * Fake `dsh web` child for supervision tests. Behavior is configured through
 * inherited environment variables so the supervisor's fixed argv
 * (`web --port N --host H`) stays exactly what production spawns:
 *
 *   FAKE_DELAY_MS      wait before serving (default 0)
 *   FAKE_EXIT_CODE     exit with this code immediately (before serving)
 *   FAKE_EXIT_AFTER_MS serve first, then exit with FAKE_EXIT_CODE (or 0)
 *   FAKE_NEVER_READY   stay alive but never serve (readiness must time out)
 *   FAKE_SPAM_LINES    print this many stdout lines before doing anything
 */

import { createServer } from 'node:http'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex === -1 ? 0 : Number(args[portIndex + 1])

const delay = Number(process.env.FAKE_DELAY_MS ?? '0')
const exitCode = process.env.FAKE_EXIT_CODE ?? null
const exitAfter = Number(process.env.FAKE_EXIT_AFTER_MS ?? '0')
const neverReady = process.env.FAKE_NEVER_READY === '1'
const spam = Number(process.env.FAKE_SPAM_LINES ?? '0')

if (spam > 0) {
  for (let i = 1; i <= spam; i++) console.log(`spam ${String(i)}`)
}

if (exitCode !== null && delay === 0 && exitAfter === 0) {
  process.exit(Number(exitCode))
}

if (neverReady) {
  setInterval(() => {}, 1 << 30)
} else {
  setTimeout(() => {
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }).listen(port, '127.0.0.1')
  }, delay)
}

if (exitAfter > 0) {
  setTimeout(() => process.exit(Number(exitCode ?? 0)), exitAfter)
}
