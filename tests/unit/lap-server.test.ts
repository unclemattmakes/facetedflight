// tests/unit/lap-server.test.ts — the lap server's endpoints, against a real SQLite.
// DEV-372, `docs/plan/PLAYER-GHOSTS.md` §5.
//
// `src/net/lap-server.ts` is what `functions/api/**` run. Here it runs against
// `node:sqlite` with `migrations/0001_laps.sql` applied — the same SQL D1 runs,
// behind the four D1 methods the server uses — so every statement in it is
// executed, not mocked. `wrangler pages dev` with a local D1 is the same round
// trip through the real runtime (docs/lap-server.md); this is the one CI runs.
//
// It checks the promises `/privacy` makes by reading the tables, not the code:
// no address in `laps`, no lap in `rate`, the owner key only as a hash.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { type AutopilotLap, flyAutopilotLap } from '@/game/autopilot-lap'
import { fromBase64url, toBase64url } from '@/net/base64url'
import { sha256HexAsync } from '@/net/digest'
import { isHandle, randomHandle } from '@/net/handles'
import {
  LAP_COURSES,
  type LapCourse,
  type LapCourses,
  lapCourse,
  lapRules,
  lapVehicle,
} from '@/net/lap-courses'
import {
  LAP_BOARD_SIZE,
  LAP_DAILY_CAP,
  LAP_SHARE_TTL_DAYS,
  LAP_SUBMITS_PER_HOUR,
} from '@/net/lap-policy'
import {
  type D1Database,
  type D1PreparedStatement,
  deleteLap,
  getBoard,
  getLap,
  type LapEnv,
  rateKey,
  submitLap,
} from '@/net/lap-server'
import { PRIVACY_CONTACT_EMAIL, PRIVACY_CONTACT_URL, privacyPage } from '@/net/privacy-page'
import type { LapDoc } from '@/sim/ghost'
import { lapToBytes, recordedLap } from '@/sim/ghost-record'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { FIXTURE_VARIANT, variantCourses } from './helpers/lap-variant-courses'
import { REPO as ROOT } from './helpers/repo-root'

const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations', '0001_laps.sql'), 'utf8')
const MISSION = 'int_01_hoverJet'
const COURSE = lapCourse(MISSION) as LapCourse
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const ADDRESS = '203.0.113.7'
const SALT = 'test-salt'
const OWNER = 'owner-key-aaaaaaaaaaaaaaaaaaaaaaaa'

/** D1's four methods over `node:sqlite`: the SQL is real, the transport is not. */
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
  db.exec(MIGRATION)
  env = { LAPS_DB: d1(db), IP_SALT: SALT }
})

let flown: AutopilotLap | null = null
const lap = (): AutopilotLap => {
  flown ??= flyAutopilotLap(int01 as unknown as Level, COURSE.worldOffset)
  return flown
}
const honestDoc = (variant = 'standard', courses: LapCourses = LAP_COURSES): LapDoc =>
  recordedLap(lap().rec, {
    mission: MISSION,
    mode: 'ringAttack',
    edition: 'anniversary',
    rules: lapRules(MISSION, 'anniversary', variant, courses) as string,
    vehicle: lapVehicle('hoverjet', variant),
    build: 'unit-test',
  })

const lapText = (doc: LapDoc = honestDoc()): string =>
  toBase64url(new Uint8Array(deflateRawSync(lapToBytes(doc))))

const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    lap: lapText(),
    seconds: lap().finishAt,
    handle: 'Swift Kestrel 42',
    owner: OWNER,
    ...over,
  })

const post = (text: string, address = ADDRESS, now = NOW, courses: LapCourses = LAP_COURSES) =>
  submitLap(
    new Request('https://ff-10yr.test/api/laps', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': address },
      body: text,
    }),
    env,
    now,
    courses,
  )

const get = (id: string, now = NOW) =>
  getLap(new Request(`https://ff-10yr.test/api/laps?id=${id}`), env, now)

const board = async (
  edition = 'anniversary',
  variant = 'standard',
  courses: LapCourses = LAP_COURSES,
) => {
  const r = await getBoard(
    { mission: MISSION, mode: 'ringAttack', edition, variant },
    new Request(`https://ff-10yr.test/api/board/${MISSION}/ringAttack/${edition}/${variant}`),
    env,
    courses,
  )
  return {
    status: r.status,
    ...((await r.json()) as {
      rules: string
      variant: string
      entries: { rank: number; id: string; seconds: number }[]
    }),
  }
}

describe('the round trip', () => {
  it('submits a lap, reads it back byte for byte, and lists it on its board', async () => {
    const sent = JSON.parse(body())
    const r = await post(body())
    expect(r.status).toBe(201)
    const made = (await r.json()) as { id: string; seconds: number; board: boolean; rank: number }
    expect(made).toMatchObject({ seconds: lap().finishAt, board: true, rank: 1 })

    const back = await get(made.id)
    expect(back.status).toBe(200)
    const lapRow = (await back.json()) as { lap: string; handle: string; seconds: number }
    expect(lapRow.lap).toBe(sent.lap)
    expect(lapRow.handle).toBe('Swift Kestrel 42')

    const b = await board()
    expect(b.rules).toBe(lapRules(MISSION, 'anniversary', 'standard'))
    expect(b.entries.map((e) => e.id)).toEqual([made.id])
    // Classic's board is its own.
    expect((await board('classic')).entries).toEqual([])
  })

  it('refuses a lap the validator refuses, with its stage', async () => {
    const r = await post(body({ seconds: lap().finishAt - 0.5 }))
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'claimed' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM laps').get()).toEqual({ n: 0 })
  })

  it('refuses a free-text handle, a malformed owner key, non-JSON and an oversize body', async () => {
    expect((await post(body({ handle: 'Anything I Like' }))).status).toBe(400)
    expect((await post(body({ owner: 'short' }))).status).toBe(400)
    expect((await post('{not json')).status).toBe(400)
    expect((await post('x'.repeat(200_000))).status).toBe(413)
  })

  it('refuses to count raw addresses: no salt, no submits', async () => {
    env = { LAPS_DB: d1(db) }
    expect((await post(body())).status).toBe(503)
  })
})

describe('a board per aircraft variant', () => {
  it('files a lap on its own variant’s board, and a board for a variant the edition lacks is a 404', async () => {
    // The committed aircraft file holds `standard` alone; this server is handed
    // the same courses built with one fixture variant beside it.
    const courses = variantCourses()
    const std = (await (
      await post(body({ lap: lapText(honestDoc('standard', courses)) }), ADDRESS, NOW, courses)
    ).json()) as { id: string; variant: string; rank: number }
    const fix = (await (
      await post(
        body({ lap: lapText(honestDoc(FIXTURE_VARIANT, courses)), owner: `${OWNER}f` }),
        ADDRESS,
        NOW,
        courses,
      )
    ).json()) as { id: string; variant: string; rank: number }
    expect([std.variant, fix.variant]).toEqual(['standard', FIXTURE_VARIANT])
    // Each first on its own board: the same time, never ranked against the other.
    expect([std.rank, fix.rank]).toEqual([1, 1])
    const standardBoard = await board('anniversary', 'standard', courses)
    const fixtureBoard = await board('anniversary', FIXTURE_VARIANT, courses)
    expect(standardBoard.entries.map((e) => e.id)).toEqual([std.id])
    expect(fixtureBoard.entries.map((e) => e.id)).toEqual([fix.id])
    expect(fixtureBoard.variant).toBe(FIXTURE_VARIANT)
    expect((await board('classic', FIXTURE_VARIANT, courses)).status).toBe(404)
    expect((await board('anniversary', 'warp', courses)).status).toBe(404)
    // And the lap row says which aircraft it was flown in.
    expect(((await (await get(fix.id)).json()) as { variant: string }).variant).toBe(
      FIXTURE_VARIANT,
    )
  })
})

describe('limits', () => {
  it(`takes ${LAP_SUBMITS_PER_HOUR} submits an hour from one address, then 429`, async () => {
    // Garbage counts too: the limit is read before the body is.
    for (let i = 0; i < LAP_SUBMITS_PER_HOUR; i++) expect((await post('{}')).status).toBe(400)
    const over = await post(body())
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another address is its own count, and the next hour is a new one.
    expect((await post(body(), '198.51.100.1')).status).toBe(201)
    expect((await post(body({ owner: `${OWNER}b` }), ADDRESS, NOW + 60 * 60 * 1000)).status).toBe(
      201,
    )
  })

  it('gives one device one place on a board, its best', async () => {
    const first = (await (await post(body())).json()) as { id: string }
    const again = (await (await post(body())).json()) as { board: boolean; boardReason: string }
    expect(again.board).toBe(false)
    expect(again.boardReason).toMatch(/is already ranked/) // DEV-571's words
    // An equal time from another device, a millisecond later: behind, by the tiebreak.
    const other = (await (await post(body({ owner: `${OWNER}c` }), ADDRESS, NOW + 1)).json()) as {
      rank: number
    }
    expect(other.rank).toBe(2)
    expect((await board()).entries.map((e) => e.id)[0]).toBe(first.id)
  })

  it(`keeps the top ${LAP_BOARD_SIZE}, and what falls off expires in ${LAP_SHARE_TTL_DAYS} days`, async () => {
    const rules = lapRules(MISSION, 'anniversary', 'standard')
    const insert = db.prepare(
      'INSERT INTO laps (id, mission, mode, edition, variant, rules, vehicle, build, handle, owner_hash, ticks, ' +
        "seconds, rings, rings_total, distance, score2016, board, created_at, expires_at, lap) VALUES (?, ?, 'ringAttack', " +
        "'anniversary', 'standard', ?, 'hoverjet', 'x', 'Calm Heron 10', ?, 1, ?, 21, 21, 1, 1, 1, ?, NULL, 'AA')",
    )
    // A full board, half of it faster than the autopilot's lap.
    const half = LAP_BOARD_SIZE / 2
    for (let i = 0; i < LAP_BOARD_SIZE; i++) {
      const seconds = i < half ? 30 + i * 0.01 : 90 + i
      insert.run(`seed${String(i).padStart(6, '0')}`, MISSION, rules, `o${i}`, seconds, NOW - 1000)
    }
    const made = (await (await post(body())).json()) as { board: boolean; rank: number }
    expect(made).toMatchObject({ board: true, rank: half + 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM laps WHERE board = 1').get()).toEqual({
      n: LAP_BOARD_SIZE,
    })
    const dropped = db
      .prepare('SELECT board, expires_at FROM laps ORDER BY seconds DESC LIMIT 1')
      .get()
    expect(dropped).toEqual({ board: 0, expires_at: NOW + LAP_SHARE_TTL_DAYS * DAY })
    // And a lap slower than the whole board is kept as a shared lap, not placed.
    db.exec('UPDATE laps SET seconds = 1 WHERE board = 1')
    const late = (await (await post(body({ owner: `${OWNER}d` }))).json()) as {
      board: boolean
      boardReason: string
    }
    expect(late).toMatchObject({ board: false, boardReason: `not in the top ${LAP_BOARD_SIZE}` })
  })

  it('expires a shared lap on schedule, and never a board lap', async () => {
    const onBoard = (await (await post(body())).json()) as { id: string }
    const shared = (await (await post(body())).json()) as { id: string; expiresAt: number }
    expect(shared.expiresAt).toBe(NOW + LAP_SHARE_TTL_DAYS * DAY)
    const later = NOW + (LAP_SHARE_TTL_DAYS + 1) * DAY
    expect((await get(shared.id, later)).status).toBe(404)
    expect((await get(onBoard.id, later)).status).toBe(200)
  })
})

describe('the limits hold against a scripted sender (docs/SECURITY-AUDIT.md)', () => {
  const dayBucket = `*:${Math.floor(NOW / DAY)}`
  const daily = () =>
    (
      db.prepare('SELECT count FROM rate WHERE bucket = ?').get(dayBucket) as
        | { count: number }
        | undefined
    )?.count ?? 0

  it('S-02: junk from many addresses does not spend the daily cap; stored laps do', async () => {
    // One lap short of the cap, then a burst of garbage from fresh addresses.
    db.prepare('INSERT INTO rate (bucket, win, count) VALUES (?, ?, ?)').run(
      dayBucket,
      Math.floor(NOW / DAY) * 24,
      LAP_DAILY_CAP - 1,
    )
    for (let i = 0; i < 5; i++) expect((await post('{}', `198.51.100.${10 + i}`)).status).toBe(400)
    expect(daily()).toBe(LAP_DAILY_CAP - 1)
    // A real lap still gets the last place of the day, and the next one is refused.
    expect((await post(body())).status).toBe(201)
    expect(daily()).toBe(LAP_DAILY_CAP)
    const full = await post(body({ owner: `${OWNER}e` }), '198.51.100.99')
    expect(full.status).toBe(503)
    expect(((await full.json()) as { error: string }).error).toBe('full')
  })

  it('S-03: an IPv6 /64 is one sender, however many addresses it rotates through', async () => {
    for (let i = 1; i <= LAP_SUBMITS_PER_HOUR; i++) {
      expect((await post('{}', `2001:db8:aa:bb::${i.toString(16)}`)).status).toBe(400)
    }
    expect((await post(body(), '2001:0DB8:00aa:00bb:1234:5678:9abc:def0')).status).toBe(429)
    // The next /64 over is somebody else.
    expect((await post(body(), '2001:db8:aa:bc::1')).status).toBe(201)
  })

  it('rateKey: IPv4 whole, IPv6 by its /64 in one spelling, anything else untouched', () => {
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7')
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateKey('2001:0DB8:0000:0000:ffff::2')).toBe('2001:db8:0:0::/64')
    expect(rateKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(rateKey('::1')).toBe('0:0:0:0::/64')
    expect(rateKey('::ffff:192.0.2.1')).toBe('0:0:0:0::/64')
    expect(rateKey('unknown')).toBe('unknown')
    expect(rateKey('1::2::3')).toBe('1::2::3')
    expect(rateKey('zz:yy::1')).toBe('zz:yy::1')
  })
})

describe('your own lap', () => {
  const del = (id: string, owner: string) =>
    deleteLap(
      new Request(`https://ff-10yr.test/api/laps?id=${id}`, {
        method: 'DELETE',
        headers: { 'x-ff-owner': owner },
      }),
      env,
    )

  it('is deleted with its owner key, and with nothing else', async () => {
    const { id } = (await (await post(body())).json()) as { id: string }
    expect((await del(id, 'someone-else-key-aaaaaaaaaaaa')).status).toBe(404)
    expect((await get(id)).status).toBe(200)
    expect((await del(id, OWNER)).status).toBe(204)
    expect((await get(id)).status).toBe(404)
    expect((await board()).entries).toEqual([])
  })
})

describe('what /privacy promises, read from the tables', () => {
  it('keeps no address and no raw owner key with a lap, and no lap with an address', async () => {
    await post(body())
    const laps = JSON.stringify(db.prepare('SELECT * FROM laps').all())
    const addressHash = await sha256HexAsync(`${SALT}:${ADDRESS}`)
    expect(laps).not.toContain(ADDRESS)
    expect(laps).not.toContain(addressHash)
    expect(laps).not.toContain(OWNER)
    expect(laps).toContain(await sha256HexAsync(OWNER))

    const rate = db.prepare('SELECT * FROM rate').all() as { bucket: string }[]
    expect(JSON.stringify(rate)).not.toContain(ADDRESS)
    expect(rate.map((r) => r.bucket.split(':')[0])).toContain(addressHash)
    expect(Object.keys(rate[0] ?? {}).sort()).toEqual(['bucket', 'count', 'win'])
  })

  it('forgets an address hash a day on, at the next submit, even a refused one', async () => {
    await post(body())
    // Somebody else's garbage, a day and an hour later: refused, and still the
    // request that sweeps. "The next time anyone sends a lap" is the promise.
    expect((await post('{}', '198.51.100.2', NOW + DAY + 60 * 60 * 1000)).status).toBe(400)
    const hashes = (db.prepare('SELECT bucket FROM rate').all() as { bucket: string }[]).map(
      (r) => r.bucket.split(':')[0],
    )
    expect(hashes).not.toContain(await sha256HexAsync(`${SALT}:${ADDRESS}`))
    expect(hashes).toContain(await sha256HexAsync(`${SALT}:198.51.100.2`))
  })

  it("states the server's own numbers", () => {
    const page = privacyPage()
    expect(page).toContain(`${LAP_SUBMITS_PER_HOUR} an hour`)
    expect(page).toContain(`top ${LAP_BOARD_SIZE}`)
    expect(page).toContain(`${LAP_SHARE_TTL_DAYS} days`)
    // The example handle on the page is one the server would take.
    expect(isHandle(/"([A-Z][a-z]+ [A-Z][a-z]+ \d\d)"/.exec(page)?.[1])).toBe(true)
    // And it names where to ask: the ONE constant, an address on the game's own
    // domain (DEV-535; facetedflight.net since 2026-09-30), linked as mailto and
    // shown as the bare address.
    expect(PRIVACY_CONTACT_URL).toBe(`mailto:${PRIVACY_CONTACT_EMAIL}`)
    expect(PRIVACY_CONTACT_EMAIL).toMatch(/^privacy@facetedflight\.net$/)
    expect(page).toContain(`href="${PRIVACY_CONTACT_URL}">${PRIVACY_CONTACT_EMAIL}</a>`)
    // No private repository, and so no 404, anywhere on the page (DEV-372's link).
    expect(page).not.toMatch(/github\.com/)
  })
})

describe('base64url', () => {
  it("round-trips every tail length, agrees with node's codec, and refuses what is not canonical", () => {
    for (let n = 0; n < 8; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 251) % 256)
      const text = toBase64url(bytes)
      expect(text).toBe(Buffer.from(bytes).toString('base64url'))
      expect(fromBase64url(text)).toEqual(bytes)
    }
    for (const bad of ['A', 'ab=c', 'a+b/', 'AB', 'ABC']) {
      // 'AB' and 'ABC' leave non-zero bits over; the rest are not the alphabet or the length.
      expect(fromBase64url(bad)).toBeNull()
    }
  })
})

describe('handles', () => {
  it('are generated from the lists and nothing else is one', () => {
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 48271) % 2147483647
      return seed % n
    }
    for (let i = 0; i < 200; i++) expect(isHandle(randomHandle(next))).toBe(true)
    for (const bad of [
      'swift kestrel 42',
      'Swift Kestrel 7',
      'Swift  Kestrel 42',
      'Slur Word 42',
      42,
    ]) {
      expect(isHandle(bad)).toBe(false)
    }
  })
})
