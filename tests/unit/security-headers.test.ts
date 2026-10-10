/**
 * S-05 (docs/SECURITY-AUDIT.md): the site's `_headers`, emitted by every build.
 * Pages sent only its defaults before this; a framing policy, HSTS and a
 * Permissions-Policy were missing. And S-11: /privacy answers HEAD.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestHead } from '../../functions/privacy'
import type { PagesContext } from '../../src/net/pages-function'
import {
  HEADERS_FILE,
  headersFile,
  SECURITY_HEADERS,
  securityHeaders,
} from '../../tools/dev/security-headers.mjs'

describe('the security headers (S-05)', () => {
  it('are emitted as `_headers` by every build, for every path', () => {
    expect(HEADERS_FILE).toBe('_headers')
    const plugin = securityHeaders()
    expect(plugin.apply).toBe('build')
    const emitted: { fileName?: string; source?: unknown }[] = []
    const hook = plugin.generateBundle as unknown as (this: unknown) => void
    hook.call({ emitFile: (f: { fileName?: string; source?: unknown }) => emitted.push(f) })
    expect(emitted).toEqual([{ type: 'asset', fileName: '_headers', source: headersFile() }])
    const lines = headersFile().split('\n')
    expect(lines[0]).toBe('/*')
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(lines).toContain(`  ${name}: ${value}`)
    }
  })

  it('refuse framing by other sites but keep the making-of page (same origin) working', () => {
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('SAMEORIGIN')
    expect(SECURITY_HEADERS['Content-Security-Policy']).toBe("frame-ancestors 'self'")
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toMatch(/^max-age=\d{8,}$/)
  })

  it('deny no feature the game uses, and carry no COOP/COEP (hard rule 8)', () => {
    const policy = SECURITY_HEADERS['Permissions-Policy'] ?? ''
    for (const used of [
      'xr-spatial-tracking',
      'gamepad',
      'fullscreen',
      'accelerometer',
      'gyroscope',
      'clipboard',
    ]) {
      expect(policy).not.toContain(used)
    }
    const names = Object.keys(SECURITY_HEADERS).map((n) => n.toLowerCase())
    expect(names).not.toContain('cross-origin-opener-policy')
    expect(names).not.toContain('cross-origin-embedder-policy')
  })

  it('is wired into vite.config.ts', () => {
    const config = fs.readFileSync('vite.config.ts', 'utf8')
    expect(config).toMatch(/^\s+securityHeaders\(\),$/m)
  })
})

describe('/privacy answers HEAD (S-11)', () => {
  const ctx = {} as PagesContext<unknown>
  it('with 200 and the GET headers, no body', async () => {
    const head = await onRequestHead(ctx)
    const get = await onRequestGet(ctx)
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
  })
})
