// tests/unit/lap-admin.test.ts — the lap server's moderation routes. DEV-374.
//
// `src/net/lap-admin.ts` against a real SQLite with BOTH migrations applied,
// the way `lap-server.test.ts` runs the public routes. First and above all:
// every route under `functions/api/admin/` refuses a request without the
// secret — found by walking that directory and calling every `onRequest*` it
// exports, so an admin route added later without the guard is red here the
// day it is written, not the day somebody finds it.
//
// Then what each route does, the block on the submit path, a database 0002
// has not reached, and what `/privacy` now says.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { type AutopilotLap, flyAutopilotLap } from '@/game/autopilot-lap'
import { HANDLE_STORE, OWNER_KEY_STORE } from '@/game/lap-identity'
import { toBase64url } from '@/net/base64url'
import { sha256HexAsync } from '@/net/digest'
import {
  adminAudit,
  adminBlock,
  adminDeleteLap,
  adminUnblock,
  adminWipeHandle,
} from '@/net/lap-admin'
import { type LapCourse, lapCourse, lapRules, lapVehicle } from '@/net/lap-courses'
import { ADMIN_LOG_DAYS, ADMIN_TOKEN_MIN_LENGTH } from '@/net/lap-policy'
import {
  type D1Database,
  type D1PreparedStatement,
  getLap,
  type LapEnv,
  submitLap,
} from '@/net/lap-server'
import type { PagesFunction } from '@/net/pages-function'
import { PRIVACY_DEVICE_STORES, privacyPage } from '@/net/privacy-page'
import { lapToBytes, recordedLap } from '@/sim/ghost-record'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { REPO as ROOT } from './helpers/repo-root'

const migration = (name: string): string =>
  fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8')
const M1 = migration('0001_laps.sql')
const M2 = migration('0002_moderation.sql')

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
/** A test token, at the minimum length and no longer: the length rule's own edge. */
const TOKEN = 't'.repeat(ADMIN_TOKEN_MIN_LENGTH)
const OWNER = 'owner-key-aaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'owner-key-bbbbbbbbbbbbbbbbbbbbbbbb'
const HANDLE = 'Swift Kestrel 42'
const MISSION = 'int_01_hoverJet'

/** D1's four methods over `node:sqlite`, as `lap-server.test.ts` binds them. */
const d1 = (db: DatabaseSync): D1Database => {
  const statement = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
    all: async <T>() => ({
      results: db.prepare(sql).all(...(params as never[])) as T[],
      success: true,
    }),
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]))
      return { results: [], success: true, meta: { changes: Number(r.changes) } }
    },
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const out = []
      for (const s of statements) out.push(await s.run())
      return out
    },
  }
}

let db: DatabaseSync
let env: LapEnv
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(M1)
  db.exec(M2)
  env = { LAPS_DB: d1(db), IP_SALT: 'test-salt', ADMIN_TOKEN: TOKEN }
})

/** A lap row, written straight into the table: these tests are about removing laps. */
const insertLap = async (id: string, over: { handle?: string; owner?: string; at?: number } = {}) =>
  db
    .prepare(
      'INSERT INTO laps (id, mission, mode, edition, variant, rules, vehicle, build, handle, owner_hash, ' +
        'ticks, seconds, rings, rings_total, distance, score2016, board, created_at, expires_at, lap) ' +
        "VALUES (?, ?, 'ringAttack', 'anniversary', 'standard', 'r', 'hoverjet', 'b', ?, ?, 5000, 61, 21, 21, 10000, 3000, 1, ?, NULL, 'AAAA')",
    )
    .run(
      id,
      MISSION,
      over.handle ?? HANDLE,
      await sha256HexAsync(over.owner ?? OWNER),
      over.at ?? NOW,
    )

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
const lapIds = (): string[] =>
  (db.prepare('SELECT id FROM laps ORDER BY id').all() as { id: string }[]).map((r) => r.id)

const req = (
  method: string,
  url: string,
  init: { token?: string | null; body?: unknown } = {},
): Request => {
  const headers: Record<string, string> = {}
  const token = init.token === undefined ? TOKEN : init.token
  if (token !== null) headers.authorization = `Bearer ${token}`
  return new Request(`https://ff-10yr.test${url}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as never })

// ── The secret ────────────────────────────────────────────────────────────

/** Every `onRequest*` under `functions/api/admin/`, as Pages would route it. */
const adminFunctions = async () => {
  const dir = path.join(ROOT, 'functions', 'api', 'admin')
  const out: { name: string; method: string; fn: PagesFunction<LapEnv> }[] = []
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const mod = (await import(`../../functions/api/admin/${file}`)) as Record<string, unknown>
    for (const [key, value] of Object.entries(mod)) {
      const m = /^onRequest([A-Z][a-z]+)?$/.exec(key)
      if (!m || typeof value !== 'function') continue
      const method = (m[1] ?? 'Get').toUpperCase()
      out.push({ name: `${file} ${method}`, method, fn: value as PagesFunction<LapEnv> })
    }
  }
  return out
}

/**
 * A request every admin route would ACT on if it were let in: a real lap id, a
 * real handle, a real block, a block body. So a refusal is the guard's doing,
 * and the red check (the guard removed) changes the database.
 */
const everything = (method: string, token: string | null): Request =>
  req(
    method,
    `/api/admin/x?id=LaPoNe0001&handle=${encodeURIComponent(HANDLE)}&kind=handle&value=${encodeURIComponent('Bold Heron 77')}&reason=test`,
    {
      token,
      body: method === 'POST' ? { kind: 'owner', lap: 'LaPoNe0001', wipe: true } : undefined,
    },
  )

const callAll = async (token: string | null, e: LapEnv = env) => {
  const statuses: Record<string, number> = {}
  for (const { name, method, fn } of await adminFunctions()) {
    const response = await fn({
      request: everything(method, token),
      env: e,
      params: {},
      waitUntil: () => {},
      next: async () => new Response(null, { status: 404 }),
    })
    statuses[name] = response.status
  }
  return statuses
}

describe('the admin routes refuse without the secret', () => {
  const seed = async () => {
    await insertLap('LaPoNe0001')
    db.prepare(
      "INSERT INTO blocks (kind, value, reason, created_at) VALUES ('handle', 'Bold Heron 77', 'x', 0)",
    ).run()
  }
  const untouched = () => {
    expect(lapIds(), 'no lap deleted').toEqual(['LaPoNe0001'])
    expect(count('SELECT COUNT(*) AS n FROM blocks'), 'no block added or lifted').toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM admin_log'), 'nothing logged').toBe(0)
  }

  it('every route under functions/api/admin answers 401 to no token and to a wrong one, and changes nothing', async () => {
    await seed()
    const found = await adminFunctions()
    // The surface, written down: adding a route means adding it here, on purpose.
    expect(found.map((f) => f.name).sort()).toEqual([
      'audit.ts GET',
      'blocks.ts DELETE',
      'blocks.ts GET',
      'blocks.ts POST',
      'handles.ts DELETE',
      'laps.ts DELETE',
      // DEV-479: Faceted Flight TV's off-air switch (`src/net/tv-admin.ts`).
      'tv.ts DELETE',
      'tv.ts GET',
      'tv.ts POST',
    ])
    for (const token of [null, '', 'x'.repeat(ADMIN_TOKEN_MIN_LENGTH), `${TOKEN}x`]) {
      const statuses = await callAll(token)
      for (const [name, status] of Object.entries(statuses)) {
        expect(status, `${name} with ${token === null ? 'no token' : 'a wrong one'}`).toBe(401)
      }
    }
    untouched()
  })

  it('are OFF, not open, when ADMIN_TOKEN is unset or short — even to that short token', async () => {
    await seed()
    const { ADMIN_TOKEN: _unset, ...unset } = env
    const offs: LapEnv[] = [
      unset,
      { ...env, ADMIN_TOKEN: '' },
      { ...env, ADMIN_TOKEN: 's'.repeat(ADMIN_TOKEN_MIN_LENGTH - 1) },
    ]
    for (const e of offs) {
      const statuses = await callAll(e.ADMIN_TOKEN ?? null, e)
      expect(Object.values(statuses).every((s) => s === 503)).toBe(true)
    }
    untouched()
  })

  it('the right token opens them (the control)', async () => {
    await seed()
    const statuses = await callAll(TOKEN)
    expect(statuses['audit.ts GET']).toBe(200)
    expect(statuses['blocks.ts GET']).toBe(200)
  })
})

/** A submit, as the Function passes it. */
const submit = async (over: Record<string, unknown>, now = NOW) =>
  read(
    await submitLap(
      new Request('https://ff-10yr.test/api/laps', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ lap: 'AAAA', seconds: 60, handle: HANDLE, owner: OWNER, ...over }),
      }),
      env,
      now,
    ),
  )

let flown: AutopilotLap | null = null
const realLap = (): { lap: string; seconds: number } => {
  const course = lapCourse(MISSION) as LapCourse
  flown ??= flyAutopilotLap(int01 as unknown as Level, course.worldOffset)
  const doc = recordedLap(flown.rec, {
    mission: MISSION,
    mode: 'ringAttack',
    edition: 'anniversary',
    rules: lapRules(MISSION, 'anniversary', 'standard') as string,
    vehicle: lapVehicle('hoverjet', 'standard'),
    build: 'unit-test',
  })
  return {
    lap: toBase64url(new Uint8Array(deflateRawSync(lapToBytes(doc)))),
    seconds: flown.finishAt,
  }
}

// ── What each route does ──────────────────────────────────────────────────

describe('delete a lap', () => {
  it('deletes anyone’s lap, logs it with its reason, and the link is gone', async () => {
    await insertLap('LaPoNe0001')
    await insertLap('LaPtWo0002', { owner: OTHER })
    const r = await read(
      await adminDeleteLap(req('DELETE', '/api/admin/laps?id=LaPoNe0001&reason=cheat'), env, NOW),
    )
    expect(r.status).toBe(200)
    expect(lapIds()).toEqual(['LaPtWo0002'])
    expect((await getLap(new Request('https://t/api/laps?id=LaPoNe0001'), env, NOW)).status).toBe(
      404,
    )
    const log = db.prepare('SELECT action, target, count, reason, detail FROM admin_log').all() as {
      action: string
      target: string
      count: number
      reason: string
      detail: string
    }[]
    expect(log.map((l) => [l.action, l.target, l.count, l.reason])).toEqual([
      ['delete-lap', 'LaPoNe0001', 1, 'cheat'],
    ])
    expect(JSON.parse(log[0]?.detail ?? '{}').owner).toBe(await sha256HexAsync(OWNER))
    const missing = await adminDeleteLap(req('DELETE', '/api/admin/laps?id=LaPoNe0001'), env, NOW)
    expect(missing.status).toBe(404)
  })
})

describe('wipe a handle', () => {
  it('deletes every lap under it, from every device, and retires it', async () => {
    await insertLap('LaPoNe0001')
    await insertLap('LaPtWo0002', { owner: OTHER })
    await insertLap('LaPtHr0003', { handle: 'Bold Heron 77' })
    const r = await read(
      await adminWipeHandle(
        req('DELETE', `/api/admin/handles?handle=${encodeURIComponent(HANDLE)}`),
        env,
        NOW,
      ),
    )
    expect(r).toMatchObject({ status: 200, body: { deleted: 2, blocked: true } })
    expect(lapIds()).toEqual(['LaPtHr0003'])
    // Retired: the next lap posted under it is refused before it is judged.
    const refused = await submit({ handle: HANDLE, lap: 'AAAA' })
    expect(refused).toMatchObject({ status: 403, body: { error: 'blocked' } })
  })

  it('with block=0 wipes and does not retire; refuses a name the game cannot generate', async () => {
    await insertLap('LaPoNe0001')
    const q = `handle=${encodeURIComponent(HANDLE)}&block=0`
    expect((await adminWipeHandle(req('DELETE', `/api/admin/handles?${q}`), env, NOW)).status).toBe(
      200,
    )
    expect(count('SELECT COUNT(*) AS n FROM blocks')).toBe(0)
    const bad = await adminWipeHandle(req('DELETE', '/api/admin/handles?handle=anything'), env, NOW)
    expect(bad.status).toBe(400)
  })
})

describe('block', () => {
  it('blocks the device behind a lap, wipes its laps, and refuses its next real lap while taking another device’s', async () => {
    const first = await submit(realLap())
    expect(first.status).toBe(201)
    const id = (first.body as { id: string }).id
    const blocked = await read(
      await adminBlock(
        req('POST', '/api/admin/blocks', {
          body: { kind: 'owner', lap: id, reason: 'cheat', wipe: true },
        }),
        env,
        NOW,
      ),
    )
    expect(blocked).toMatchObject({
      status: 201,
      body: { kind: 'owner', value: await sha256HexAsync(OWNER), wiped: 1, laps: [id] },
    })
    expect(lapIds()).toEqual([])
    expect(await submit(realLap())).toMatchObject({
      status: 403,
      body: { error: 'blocked', reason: 'this device may not post laps' },
    })
    expect((await submit({ ...realLap(), owner: OTHER })).status).toBe(201)

    // Lifted, the device posts again.
    const lifted = await adminUnblock(
      req('DELETE', `/api/admin/blocks?kind=owner&value=${await sha256HexAsync(OWNER)}`),
      env,
      NOW,
    )
    expect(lifted.status).toBe(200)
    expect((await submit(realLap())).status).toBe(201)
    const actions = (
      db.prepare('SELECT action FROM admin_log ORDER BY id').all() as { action: string }[]
    ).map((r) => r.action)
    expect(actions).toEqual(['block', 'unblock'])
  })

  it('refuses a block it cannot name: no kind, an unknown lap, a hash that is not one', async () => {
    const post = async (body: unknown) =>
      (await adminBlock(req('POST', '/api/admin/blocks', { body }), env, NOW)).status
    expect(await post({ kind: 'address', value: '203.0.113.7' })).toBe(400)
    expect(await post({ kind: 'owner', lap: 'NoSuChLaP1' })).toBe(404)
    expect(await post({ kind: 'owner', value: OWNER })).toBe(400)
    expect(await post({ kind: 'handle', value: 'free text' })).toBe(400)
    expect(count('SELECT COUNT(*) AS n FROM blocks')).toBe(0)
  })
})

describe('audit', () => {
  it('shows laps newest first with their owner hash, filters them, and shows the blocks and the log', async () => {
    await insertLap('LaPoNe0001', { at: NOW - 2 })
    await insertLap('LaPtWo0002', { owner: OTHER, handle: 'Bold Heron 77', at: NOW - 1 })
    await adminDeleteLap(req('DELETE', '/api/admin/laps?id=LaPoNe0001&reason=r'), env, NOW)
    await insertLap('LaPoNe0001', { at: NOW })
    const all = await read(await adminAudit(req('GET', '/api/admin/audit'), env, NOW))
    const body = all.body as {
      totals: { laps: number; board: number; shared: number; blocks: number }
      laps: { id: string; owner: string }[]
      log: { action: string; target: string }[]
    }
    expect(all.status).toBe(200)
    expect(body.laps.map((l) => l.id)).toEqual(['LaPoNe0001', 'LaPtWo0002'])
    expect(body.laps[1]?.owner).toBe(await sha256HexAsync(OTHER))
    expect(body.totals).toEqual({ laps: 2, board: 2, shared: 0, blocks: 0 })
    expect(body.log.map((l) => [l.action, l.target])).toEqual([['delete-lap', 'LaPoNe0001']])
    const one = await read(
      await adminAudit(
        req('GET', `/api/admin/audit?owner=${await sha256HexAsync(OTHER)}`),
        env,
        NOW,
      ),
    )
    expect((one.body as { laps: { id: string }[] }).laps.map((l) => l.id)).toEqual(['LaPtWo0002'])
    expect((await adminAudit(req('GET', '/api/admin/audit?owner=me'), env, NOW)).status).toBe(400)
  })

  it(`forgets a log row ${ADMIN_LOG_DAYS} days on, at the next submit`, async () => {
    await insertLap('LaPoNe0001')
    await adminDeleteLap(req('DELETE', '/api/admin/laps?id=LaPoNe0001'), env, NOW)
    expect(count('SELECT COUNT(*) AS n FROM admin_log')).toBe(1)
    await submit({}, NOW + ADMIN_LOG_DAYS * DAY - 1)
    expect(count('SELECT COUNT(*) AS n FROM admin_log')).toBe(1)
    await submit({}, NOW + ADMIN_LOG_DAYS * DAY + 1)
    expect(count('SELECT COUNT(*) AS n FROM admin_log')).toBe(0)
  })
})

// ── Deploy order ──────────────────────────────────────────────────────────

describe('a database 0002 has not reached', () => {
  it('still takes laps, and the admin routes say it is unmigrated', async () => {
    db = new DatabaseSync(':memory:')
    db.exec(M1)
    env = { ...env, LAPS_DB: d1(db) }
    expect((await submit(realLap())).status).toBe(201)
    const r = await read(await adminAudit(req('GET', '/api/admin/audit'), env, NOW))
    expect(r).toMatchObject({ status: 503, body: { error: 'unmigrated' } })
  })
})

// ── /privacy ──────────────────────────────────────────────────────────────

describe('what /privacy says about the device and moderation', () => {
  it('names the owner key and the handle by the storage names the game uses', () => {
    expect(PRIVACY_DEVICE_STORES).toEqual({ owner: OWNER_KEY_STORE, handle: HANDLE_STORE })
    const page = privacyPage()
    expect(page).toContain(`<code>${OWNER_KEY_STORE}</code>`)
    expect(page).toContain(`<code>${HANDLE_STORE}</code>`)
  })

  it('says how a lap is deleted, and how long the moderation log keeps a row', () => {
    const page = privacyPage()
    // DEV-571: the panel's words, post and take down.
    expect(page).toContain('the results panel offers to take it down')
    expect(page).toContain(`${ADMIN_LOG_DAYS} days after it was written`)
    // The promise it used to make and the game did not keep.
    expect(page).not.toContain('can delete any lap you shared')
  })
})
