// tests/unit/lap-client.test.ts — the game's side of the lap server. DEV-373.
//
// `src/net/lap-client.ts` against the SERVER ITSELF, not against a copy of what
// the server is believed to want: the fake `fetch` here hands every request to
// `src/net/lap-server.ts`'s handlers over `node:sqlite` with the real
// migration applied, the way `lap-server.test.ts` runs them. So "Share posts a
// lap the server accepts" is a round trip through the validator, and a client
// that deflated the wrong way, spelled a field wrong or sent the claim instead
// of the poses is refused by the thing that would refuse it in production.
//
// The lap is a real one: `src/game/autopilot-lap.ts` flies `int_01` with the
// autopilot and the speed chain, as `boot/app.ts` does.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { type AutopilotLap, flyAutopilotLap } from '@/game/autopilot-lap'
import { toBase64url } from '@/net/base64url'
import {
  deflateRaw,
  deleteLap,
  fetchBoard,
  fetchLap,
  inflateRaw,
  isLapId,
  lapFromWire,
  lapToWire,
  shareLink,
  submitLap,
} from '@/net/lap-client'
import { type LapCourse, lapCourse, lapRules, lapVehicle } from '@/net/lap-courses'
import { LAP_ID_LENGTH } from '@/net/lap-policy'
import {
  type D1Database,
  type D1PreparedStatement,
  getBoard,
  getLap,
  type LapEnv,
  deleteLap as serverDelete,
  submitLap as serverSubmit,
} from '@/net/lap-server'
import type { LapDoc } from '@/sim/ghost'
import { lapToBytes, recordedLap } from '@/sim/ghost-record'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { REPO as ROOT } from './helpers/repo-root'

const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations', '0001_laps.sql'), 'utf8')
const MISSION = 'int_01_hoverJet'
const COURSE = lapCourse(MISSION) as LapCourse
const OWNER = 'AAECAwQFBgcICQoLDA0ODw'
const HANDLE = 'Swift Kestrel 42'

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

let env: LapEnv
/** Every request the client made, as the server received it. */
let seen: { method: string; url: string; body: string | null }[]
/** DEV-374: the `X-FF-Owner` header of every DELETE, as the server received it. */
let ownersSent: (string | null)[]

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  db.exec(MIGRATION)
  env = { LAPS_DB: d1(db), IP_SALT: 'test-salt' }
  seen = []
  ownersSent = []
})

/** A `fetch` that is the lap server: the real handlers, routed as the Functions route them. */
const server = async (input: string, init?: RequestInit): Promise<Response> => {
  const url = new URL(input, 'https://ff-10yr.test')
  const request = new Request(url, {
    ...init,
    headers: { 'cf-connecting-ip': '203.0.113.7', ...(init?.headers ?? {}) },
  })
  seen.push({
    method: request.method,
    url: url.pathname + url.search,
    body: typeof init?.body === 'string' ? init.body : null,
  })
  if (url.pathname === '/api/laps' && request.method === 'POST') {
    return serverSubmit(request, env, Date.UTC(2026, 9, 6))
  }
  // DEV-374: as `functions/api/laps.ts` routes it.
  if (url.pathname === '/api/laps' && request.method === 'DELETE') {
    ownersSent.push(request.headers.get('x-ff-owner'))
    return serverDelete(request, env)
  }
  if (url.pathname === '/api/laps') return getLap(request, env, Date.UTC(2026, 9, 6))
  const board = /^\/api\/board\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (board) {
    const [, mission, mode, edition, variant] = board as unknown as string[]
    return getBoard(
      {
        mission: mission as string,
        mode: mode as string,
        edition: edition as string,
        variant: variant as string,
      },
      request,
      env,
    )
  }
  return new Response('not found', { status: 404 })
}

let flown: AutopilotLap | null = null
const lap = (): AutopilotLap => {
  flown ??= flyAutopilotLap(int01 as unknown as Level, COURSE.worldOffset)
  return flown
}
const honestDoc = (): LapDoc =>
  recordedLap(lap().rec, {
    mission: MISSION,
    mode: 'ringAttack',
    edition: 'anniversary',
    rules: lapRules(MISSION, 'anniversary', 'standard') as string,
    vehicle: lapVehicle('hoverjet', 'standard'),
    build: 'unit-test',
  })

describe('the wire (DEV-372 §7: raw deflate, unpadded base64url)', () => {
  it('is the server codec: node inflates it RAW back to the `ff2-ghost-2` bytes', async () => {
    const doc = honestDoc()
    const text = await lapToWire(doc)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    const bytes = Buffer.from(text, 'base64url')
    expect(new Uint8Array(inflateRawSync(bytes))).toEqual(lapToBytes(doc))
  })

  it('round-trips a lap, and reads node’s own raw deflate', async () => {
    const doc = honestDoc()
    expect(await lapFromWire(await lapToWire(doc))).toEqual(doc)
    const nodeText = toBase64url(new Uint8Array(deflateRawSync(lapToBytes(doc))))
    expect(await lapFromWire(nodeText)).toEqual(doc)
  })

  it('reads text that is not a lap as absent, and stops a zip bomb at the cap', async () => {
    expect(await lapFromWire('not base64url!')).toBeNull()
    expect(await lapFromWire(toBase64url(new Uint8Array([1, 2, 3, 4])))).toBeNull()
    const bomb = await deflateRaw(new Uint8Array(2_000_000))
    expect(bomb.byteLength).toBeLessThan(10_000)
    expect(await inflateRaw(bomb, 1_000_000)).toBeNull()
  })
})

describe('Share: POST /api/laps', () => {
  it('posts the lap the server accepts — rescored, on the board, the handle and owner as sent', async () => {
    const doc = honestDoc()
    const result = await submitLap(
      { doc, seconds: lap().finishAt, handle: HANDLE, owner: OWNER },
      server,
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(isLapId(result.id)).toBe(true)
    expect(result.board).toBe(true)
    expect(result.rank).toBe(1)
    expect(result.rings).toBe(21)
    expect(result.variant).toBe('standard')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('POST')
    const sent = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['handle', 'lap', 'owner', 'seconds'])
    expect(sent.handle).toBe(HANDLE)
    expect(sent.owner).toBe(OWNER)
    // And the lap comes back byte for byte, by the id the panel prints.
    const back = await fetchLap(result.id, server)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.lap.doc).toEqual(doc)
      expect(back.lap.handle).toBe(HANDLE)
      expect(back.lap.mission).toBe(MISSION)
      expect(back.lap.variant).toBe('standard')
    }
  })

  it('says why, in the server’s words, when the server refuses', async () => {
    const result = await submitLap(
      { doc: honestDoc(), seconds: lap().finishAt - 0.5, handle: HANDLE, owner: OWNER },
      server,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.error).toBe('claimed')
    expect(result.reason.length).toBeGreaterThan(8)
  })

  it('never throws: an unreachable server is a reason, not an exception', async () => {
    const result = await submitLap(
      { doc: honestDoc(), seconds: lap().finishAt, handle: HANDLE, owner: OWNER },
      async () => {
        throw new TypeError('Failed to fetch')
      },
    )
    expect(result).toMatchObject({ ok: false, status: 0, error: 'network' })
  })
})

describe('a link: GET /api/laps?id=', () => {
  it('refuses what is not an id without asking the network', async () => {
    expect(isLapId('A'.repeat(LAP_ID_LENGTH))).toBe(true)
    expect(isLapId('A'.repeat(LAP_ID_LENGTH - 1))).toBe(false)
    expect(isLapId('AAAAAAAAA-')).toBe(false)
    const r = await fetchLap('../../etc', server)
    expect(r.ok).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('an expired or unknown lap is a reason', async () => {
    const r = await fetchLap('A'.repeat(LAP_ID_LENGTH), server)
    expect(r).toMatchObject({ ok: false, status: 404 })
  })
})

describe('a board: GET /api/board/<mission>/<mode>/<edition>/<variant>', () => {
  it('lists the posted lap, fastest first; a board the server has not got is empty', async () => {
    const posted = await submitLap(
      { doc: honestDoc(), seconds: lap().finishAt, handle: HANDLE, owner: OWNER },
      server,
    )
    expect(posted.ok).toBe(true)
    const key = {
      mission: MISSION,
      mode: 'ringAttack',
      edition: 'anniversary',
      variant: 'standard',
    }
    const board = await fetchBoard(key, server)
    expect(board.ok).toBe(true)
    if (board.ok && posted.ok) {
      expect(board.entries.map((e) => [e.rank, e.id, e.handle])).toEqual([[1, posted.id, HANDLE]])
    }
    // Classic flies `standard` only: the server has no speed board there (404).
    const none = await fetchBoard({ ...key, edition: 'classic', variant: 'speed' }, server)
    expect(none).toEqual({ ok: true, entries: [] })
  })
})

describe('the link a player reads', () => {
  it('is the host and `?ghost=<id>`, no scheme', () => {
    expect(shareLink('ff-10yr.pages.dev', 'AbCdEf1234')).toBe('ff-10yr.pages.dev/?ghost=AbCdEf1234')
  })
})

// ── DEV-374: taking a lap back ────────────────────────────────────────────
//
// The results panel's delete is `deleteLap` with the device's owner key. What
// makes it the OWNER's button is the server refusing every other key — so this
// runs against the server's own handler, and the wrong key is the case.

describe('delete your lap: DELETE /api/laps?id= (DEV-374)', () => {
  const OTHER = 'BwYFBAMCAQAPDg0MCwoJCA'

  it('refuses a wrong owner key and keeps the lap; the right one deletes it', async () => {
    const posted = await submitLap(
      { doc: honestDoc(), seconds: lap().finishAt, handle: HANDLE, owner: OWNER },
      server,
    )
    expect(posted.ok).toBe(true)
    if (!posted.ok) return

    const wrong = await deleteLap(posted.id, OTHER, server)
    expect(wrong).toMatchObject({ ok: false, status: 404, error: 'gone' })
    expect((await fetchLap(posted.id, server)).ok, 'a wrong key deletes nothing').toBe(true)

    expect(await deleteLap(posted.id, OWNER, server)).toEqual({ ok: true })
    expect(await fetchLap(posted.id, server)).toMatchObject({ ok: false, status: 404 })

    // The key travels in a header and never in the URL, which logs keep.
    expect(ownersSent).toEqual([OTHER, OWNER])
    const deletes = seen.filter((s) => s.method === 'DELETE')
    expect(deletes.map((s) => s.url)).toEqual([
      `/api/laps?id=${posted.id}`,
      `/api/laps?id=${posted.id}`,
    ])
  })

  it('refuses what is not an id without asking the network, and never throws', async () => {
    expect(await deleteLap('../../etc', OWNER, server)).toMatchObject({ ok: false, error: 'id' })
    expect(seen).toHaveLength(0)
    const down = await deleteLap('A'.repeat(LAP_ID_LENGTH), OWNER, async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(down).toMatchObject({ ok: false, status: 0, error: 'network' })
  })
})
