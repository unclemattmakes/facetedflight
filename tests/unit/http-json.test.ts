// tests/unit/http-json.test.ts: the one JSON response builder (code-reuse
// audit BE-7). `json` and `refuse` were the lap server's; `room-lap` rewrote
// them byte for byte and `stats-server` inlined them minus `nosniff` (its receipt is pinned in
// `stats-server.test.ts`).

import { describe, expect, it } from 'vitest'
import { json, refuse } from '@/net/http'

describe('json', () => {
  it('is JSON, unsniffed and uncached by default', async () => {
    const r = json(201, { a: 1 })
    expect(r.status).toBe(201)
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ a: 1 })
  })

  it("lets a cacheable answer say so: the caller's headers win", () => {
    const r = json(200, [], { 'cache-control': 'public, max-age=30' })
    expect(r.headers.get('cache-control')).toBe('public, max-age=30')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('refuse', () => {
  it('is { error, reason } at the status, with the extra headers', async () => {
    const r = refuse(429, 'slow-down', 'too many', { 'retry-after': '60' })
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBe('60')
    expect(await r.json()).toEqual({ error: 'slow-down', reason: 'too many' })
  })
})
