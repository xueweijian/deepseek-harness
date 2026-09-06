import { describe, expect, it } from 'vitest'
import { errorPageUrl, escapeHtml, findDeepLink, isAllowedPermission } from '../helpers.ts'
import type { SidecarFailure } from '../sidecar.ts'

const failure = (overrides: Partial<SidecarFailure> = {}): SidecarFailure => ({
  exitCode: 3,
  signal: null,
  timedOut: false,
  logTail: '',
  ...overrides,
})

describe('findDeepLink', () => {
  it('picks the first dsh:// link out of a mixed argv', () => {
    expect(findDeepLink(['app.exe', '--flag', 'dsh://session/abc', 'dsh://other'])).toBe('dsh://session/abc')
  })

  it('matches the scheme case-insensitively', () => {
    expect(findDeepLink(['DSH://Session/x'])).toBe('DSH://Session/x')
  })

  it('returns undefined without a link', () => {
    expect(findDeepLink(['app.exe', '--port', '80'])).toBeUndefined()
    expect(findDeepLink([])).toBeUndefined()
  })

  it('does not mistake look-alike arguments for links', () => {
    expect(findDeepLink(['--pretend=dsh://x', 'xdsh://y'])).toBeUndefined()
  })
})

describe('errorPageUrl', () => {
  it('renders a data URL whose decoded body carries the countdown and reason', () => {
    const url = errorPageUrl(failure())
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('服务进程退出（code 3）')
    expect(html).toContain('id="seconds"')
  })

  it('states a timeout rather than an exit code when the attempt timed out', () => {
    const html = decodeURIComponent(errorPageUrl(failure({ timedOut: true, exitCode: null })).slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('服务启动超时')
    expect(html).not.toContain('服务进程退出')
  })

  it('escapes a hostile log tail before embedding it', () => {
    const html = decodeURIComponent(errorPageUrl(failure({ logTail: '<script>alert("x"&\'y\')</script>' })).slice('data:text/html;charset=utf-8,'.length))
    expect(html).not.toContain('alert("x"')
    expect(html).toContain('&lt;script&gt;alert')
    expect(html).toContain('&quot;')
    expect(html).toContain('&#39;')
    expect(html).toContain('&amp;')
  })

  it('shows a placeholder for an empty log tail', () => {
    const html = decodeURIComponent(errorPageUrl(failure()).slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('（无输出）')
  })
})

describe('escapeHtml', () => {
  it('escapes every sensitive character and leaves plain text alone', () => {
    expect(escapeHtml(`<a href="x" class='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    expect(escapeHtml('plain 纯文本')).toBe('plain 纯文本')
  })
})

describe('isAllowedPermission', () => {
  const allowedOrigin = 'http://127.0.0.1:3080'

  it('grants clipboard write and read permissions when origin matches allowedOrigin', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', allowedOrigin, allowedOrigin)).toBe(true)
    expect(isAllowedPermission('clipboard-read', allowedOrigin, allowedOrigin)).toBe(true)
    expect(isAllowedPermission('clipboard-write', allowedOrigin, allowedOrigin)).toBe(true)
  })

  it('denies non-clipboard permissions even when origin matches allowedOrigin', () => {
    expect(isAllowedPermission('media', allowedOrigin, allowedOrigin)).toBe(false)
    expect(isAllowedPermission('camera', allowedOrigin, allowedOrigin)).toBe(false)
    expect(isAllowedPermission('microphone', allowedOrigin, allowedOrigin)).toBe(false)
    expect(isAllowedPermission('geolocation', allowedOrigin, allowedOrigin)).toBe(false)
    expect(isAllowedPermission('notifications', allowedOrigin, allowedOrigin)).toBe(false)
    expect(isAllowedPermission('midi', allowedOrigin, allowedOrigin)).toBe(false)
  })

  it('denies clipboard permissions when origin does not match allowedOrigin', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', 'http://malicious.example.com', allowedOrigin)).toBe(false)
    expect(isAllowedPermission('clipboard-read', 'http://127.0.0.1:9999', allowedOrigin)).toBe(false)
  })

  it('denies when allowedOrigin is undefined', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', allowedOrigin, undefined)).toBe(false)
  })

  it('denies when requesting origin is undefined', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', undefined, allowedOrigin)).toBe(false)
  })
})

