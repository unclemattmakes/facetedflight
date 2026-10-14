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
  HASHED_ASSET,
  HEADERS_FILE,
  headersFile,
  IMMUTABLE_CACHE,
  SECURITY_HEADERS,
  securityHeaders,
  unhashedUnderAssets,
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
    expect(config).toMatch(/^\s+securityHeaders\(\{ immutableAssets: !assetsAreLocal \}\),$/m)
  })
})

describe('the long cache for hashed output (DEV-945)', () => {
  const blocks = (text: string) => text.split(/\n(?=\S)/).map((b) => b.split('\n').filter(Boolean))

  it('is off by default, so a local build (public/assets copied in, un-hashed) never gets it', () => {
    expect(headersFile()).not.toContain('Cache-Control')
    expect(headersFile()).toBe(headersFile({ immutableAssets: false }))
  })

  it('marks ONLY the hashed prefix immutable, never /* or /index.html', () => {
    const rules = blocks(headersFile({ immutableAssets: true }))
    const cached = rules.filter((r) => r.some((l) => l.includes('Cache-Control')))
    expect(cached).toEqual([['/assets/*', `  Cache-Control: ${IMMUTABLE_CACHE}`]])
    expect(IMMUTABLE_CACHE).toBe('public, max-age=31536000, immutable')
    // The security rule still covers every path, with no cache line in it.
    const all = rules.find((r) => r[0] === '/*') ?? []
    expect(all.some((l) => /cache-control/i.test(l))).toBe(false)
    expect(headersFile({ immutableAssets: true })).not.toMatch(/index\.html|\/sw|manifest/)
  })

  it('names a file hashed by Rollup and refuses one that is not', () => {
    expect(HASHED_ASSET.test('assets/index-Cx3_a-9Z.js')).toBe(true)
    expect(HASHED_ASSET.test('assets/ui-plate-D1fR0Kq2.css')).toBe(true)
    expect(HASHED_ASSET.test('assets/models/hoverjet.glb')).toBe(false)
    expect(HASHED_ASSET.test('assets/audio/theme.ogg')).toBe(false)
    expect(
      unhashedUnderAssets(['index.html', '404.html', 'assets/a-AbCdEf12.js', 'assets/ships/x.glb']),
    ).toEqual(['assets/ships/x.glb'])
  })

  it('fails the build when an un-hashed file would sit under /assets/*, and emits nothing then', () => {
    const plugin = securityHeaders({ immutableAssets: true })
    const hook = plugin.generateBundle as unknown as (
      this: unknown,
      o: unknown,
      b: Record<string, unknown>,
    ) => void
    const emitted: unknown[] = []
    const ctx = {
      emitFile: (f: unknown) => emitted.push(f),
      error: (m: string) => {
        throw new Error(m)
      },
    }
    expect(() => hook.call(ctx, {}, { 'assets/models/x.glb': {} })).toThrow(/no content hash/)
    expect(emitted).toEqual([])
    hook.call(ctx, {}, { 'assets/main-AbCdEf12.js': {}, 'index.html': {} })
    expect(emitted).toHaveLength(1)
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
