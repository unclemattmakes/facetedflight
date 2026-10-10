// tests/unit/admin-shared.test.ts: what the lap and TV admin doors share
// (code-reuse audit BE-9): the reason's trim and cap, the "unmigrated" answer,
// and the one `admin_log` insert. The TV door ran its own copy of the insert;
// this pins that the shared one binds the same six values it did.

import { describe, expect, it } from 'vitest'
import { reasonOf, unmigratedRefusal } from '@/net/lap-admin'
import { ADMIN_REASON_MAX, ADMIN_TOKEN_MIN_LENGTH } from '@/net/lap-policy'
import type { D1Database } from '@/net/lap-server'
import { adminTvOffAir } from '@/net/tv-admin'

describe('reasonOf', () => {
  it('trims, caps at ADMIN_REASON_MAX, and is empty for anything but a string', () => {
    expect(reasonOf('  spam  ')).toBe('spam')
    expect(reasonOf('x'.repeat(ADMIN_REASON_MAX + 10))).toHaveLength(ADMIN_REASON_MAX)
    for (const v of [undefined, null, 5, {}]) expect(reasonOf(v)).toBe('')
  })
})

describe('unmigratedRefusal', () => {
  it('is the 503 for a missing table and null for any other failure', async () => {
    const r = unmigratedRefusal(new Error('D1_ERROR: no such table: blocks'))
    if (r === null) throw new Error('expected a refusal')
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: string }).error).toBe('unmigrated')
    expect(unmigratedRefusal(new Error('disk full'))).toBeNull()
    expect(unmigratedRefusal('no such table')).toBeNull()
  })
})

describe('the TV door logs through the shared insert', () => {
  const TOKEN = 't'.repeat(ADMIN_TOKEN_MIN_LENGTH)
  const guideEnv = { get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) }

  const run = (db: unknown, body: unknown) =>
    adminTvOffAir(
      new Request('https://site/api/admin/tv', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      }),
      {
        ADMIN_TOKEN: TOKEN,
        LAPS_DB: db as D1Database,
        ROOMS: { idFromName: () => 'guide', ...guideEnv },
      } as never,
      1234,
    )

  it('binds (at, action, target, 0, reason, detail JSON) and runs it', async () => {
    const seen: { sql: string; args: unknown[] }[] = []
    const db = {
      prepare: (sql: string) => ({
        all: async () => ({}),
        bind: (...args: unknown[]) => ({
          run: async () => {
            seen.push({ sql, args })
            return {}
          },
        }),
      }),
    }
    const r = await run(db, { until: 99, reason: '  quiet please ' })
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sql).toContain(
      'INSERT INTO admin_log (at, action, target, count, reason, detail)',
    )
    expect(seen[0]?.args).toEqual([1234, 'off-air', 'tv:all', 0, 'quiet please', '{"until":99}'])
  })

  it('answers unmigrated when admin_log is missing, before the guide is touched', async () => {
    const db = {
      prepare: () => ({
        all: async () => {
          throw new Error('D1_ERROR: no such table: admin_log')
        },
      }),
    }
    const r = await run(db, { until: 99 })
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: string }).error).toBe('unmigrated')
  })
})
