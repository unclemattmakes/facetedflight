// tests/unit/stats-server.test.ts: what /api/stats writes, and what it never
// writes. DEV-589; docs/plan/ANALYTICS.md §1 and §4.4.
//
// The privacy line is a property of this code, so it is tested as one: a row
// carries only the fields its kind lists, a field outside a list drops the row,
// nothing about the connection but its country reaches a row, and that only on
// a visit. Positive first everywhere: a valid row IS written, or every "was not
// written" below would pass on a server that writes nothing.

import { describe, expect, it } from 'vitest'
import type { XrBlocker } from '@/boot/xr-support'
import type { GameMode } from '@/content/level-schema'
import {
  ALTITUDE_BUCKETS,
  ATTEMPT_BUCKETS,
  bucketOf,
  CRASH_FIELDS,
  cleanErrorMessage,
  crashCell,
  DURATION_BUCKETS,
  FRAME_BUCKETS,
  MODES,
  numberFields,
  STATS_BUG_ID_ALPHABET,
  STATS_BUG_ID_LENGTH,
  STATS_KINDS,
  STATS_MAX_ROWS,
  STATS_SCHEMA,
  type StatsRow,
  TO_TITLE_BUCKETS,
  textFields,
  VISIT_FIELDS,
  XR_BLOCKERS,
} from '@/net/stats-schema'
import { type AnalyticsEngineDataset, acceptStats, postStats, toPoint } from '@/net/stats-server'
import { ADAPTIVE_STEPS } from '@/render/quality'

const SITE = 'https://facetedflight.net'

const visit = (over: Record<string, string | number> = {}): StatsRow => ({
  k: 'visit',
  build: 'v0.18.0',
  channel: 'release',
  device: 'desktop',
  gate: 'ok',
  stage: 'mission',
  xr: 'offered',
  xrBlocker: 'none',
  quality: 'high',
  scale: '1',
  look: 'anniversary',
  vignette: 'light',
  speedFx: 'full',
  toTitle: '5-10',
  visitTime: '3-10m',
  vrTime: '0',
  frameP50: '60',
  frameP95: '45',
  stageBefore: 0,
  xrBefore: 0,
  keyboard: 1,
  gamepad: 0,
  touch: 0,
  xrControllers: 0,
  horizon: 0,
  qualityAuto: 1,
  attempts: 4,
  finishes: 2,
  roomsJoined: 0,
  tvWatched: 1,
  editorOpened: 0,
  posts: 1,
  ghostSaves: 2,
  hitches: 12,
  tierDrops: 0,
  contextLosses: 0,
  shaderFailures: 0,
  errors: 0,
  ...over,
})

const attempt = (over: Record<string, string | number> = {}): StatsRow => ({
  k: 'attempt',
  build: 'v0.18.0',
  channel: 'release',
  device: 'headset',
  mission: 'int_01_hoverJet',
  mode: 'ringAttack',
  look: 'anniversary',
  opponents: 'ai',
  variant: 'standard',
  ending: 'quit',
  medal: 'none',
  attemptNo: '2-3',
  quitTime: '1-3m',
  ringsTaken: 9,
  ringsTotal: 21,
  lastRing: 9,
  seconds: 0,
  crashes: 3,
  resets: 1,
  ...over,
})

const crash = (over: Record<string, string | number> = {}): StatsRow => ({
  k: 'crash',
  build: 'v0.18.0',
  channel: 'release',
  mission: 'int_01_hoverJet',
  look: 'classic',
  cause: 'crash',
  cell: crashCell(-1234.5, 880),
  altitude: '25-100',
  ...over,
})

const error = (over: Record<string, string | number> = {}): StatsRow => ({
  k: 'error',
  build: 'v0.18.0',
  channel: 'preview',
  device: 'phone',
  source: 'error',
  message: "Cannot read properties of undefined (reading 'x')",
  frame: 'assets/index-abc123.js:4211',
  ...over,
})

/** A dataset that remembers what it was given. */
const recorder = () => {
  const points: Parameters<AnalyticsEngineDataset['writeDataPoint']>[0][] = []
  return { points, STATS: { writeDataPoint: (p) => points.push(p) } as AnalyticsEngineDataset }
}

const post = (body: unknown, headers: Record<string, string> = {}, country = 'NZ'): Request => {
  const request = new Request(`${SITE}/api/stats`, {
    method: 'POST',
    headers: { origin: SITE, 'content-type': 'text/plain', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', { value: { country, city: 'Wellington', asn: 9500 } })
  return request
}

describe('DEV-589: the schema fits Analytics Engine, and matches the game it describes', () => {
  it('no kind has more than twenty text columns or twenty numbers', () => {
    for (const [kind, fields] of Object.entries(STATS_KINDS)) {
      // + kind and schema version; + country on a visit.
      const blobs = textFields(fields).length + 2 + (kind === 'visit' ? 1 : 0)
      expect(blobs, kind).toBeLessThanOrEqual(20)
      expect(numberFields(fields).length, kind).toBeLessThanOrEqual(20)
      const names = fields.map((f) => f.name)
      expect(new Set(names).size, kind).toBe(names.length)
    }
  })

  it('holds its lists equal to the game they come from', () => {
    const modes: Record<GameMode, true> = {
      ringAttack: true,
      targetPractice: true,
      freeFlight: true,
      energyRace: true,
      lesson: true,
    }
    expect([...MODES].sort()).toEqual(Object.keys(modes).sort())
    const blockers: Record<XrBlocker, true> = {
      none: true,
      'insecure-context': true,
      'no-webxr-api': true,
      'no-active-runtime': true,
      'query-rejected': true,
    }
    expect(XR_BLOCKERS.filter((b) => b !== 'unprobed').sort()).toEqual(Object.keys(blockers).sort())
    const scale = VISIT_FIELDS.find((f) => f.name === 'scale')
    expect(scale?.kind === 'enum' && scale.values.filter((v) => v !== 'other')).toEqual(
      ADAPTIVE_STEPS.map(String),
    )
  })

  it('buckets on the edges as labelled', () => {
    expect(bucketOf(4.9, TO_TITLE_BUCKETS)).toBe('lt5')
    expect(bucketOf(5, TO_TITLE_BUCKETS)).toBe('lt5')
    expect(bucketOf(5.1, TO_TITLE_BUCKETS)).toBe('5-10')
    expect(bucketOf(400, TO_TITLE_BUCKETS)).toBe('40+')
    expect(bucketOf(0, DURATION_BUCKETS)).toBe('0')
    expect(bucketOf(0.1, DURATION_BUCKETS)).toBe('lt1m')
    expect(bucketOf(7200, DURATION_BUCKETS)).toBe('30m+')
    expect(bucketOf(11.1, FRAME_BUCKETS)).toBe('90')
    expect(bucketOf(11.2, FRAME_BUCKETS)).toBe('72')
    expect(bucketOf(22.2, FRAME_BUCKETS)).toBe('45')
    expect(bucketOf(50, FRAME_BUCKETS)).toBe('lt30')
    expect(bucketOf(1, ATTEMPT_BUCKETS)).toBe('1')
    expect(bucketOf(11, ATTEMPT_BUCKETS)).toBe('11+')
    expect(bucketOf(Number.NaN, ALTITUDE_BUCKETS)).toBe('lt25')
    expect(crashCell(-1234.5, 880)).toBe('-25:17')
  })

  it('a crash row has no field that could order or time it', () => {
    const names = CRASH_FIELDS.map((f) => f.name)
    for (const n of names) expect(n).not.toMatch(/time|seconds|tick|order|attempt|at$/i)
  })
})

describe('DEV-589: what a row becomes', () => {
  it('writes a valid row of each kind, in column order', async () => {
    const v = await toPoint(visit(), 'NZ')
    expect(v?.blobs.slice(0, 4)).toEqual(['visit', STATS_SCHEMA, 'v0.18.0', 'release'])
    expect(v?.blobs.at(-1)).toBe('NZ')
    expect(v?.indexes).toEqual(['visit'])
    expect(v?.doubles.slice(0, 3)).toEqual([0, 0, 1])

    const a = await toPoint(attempt(), 'NZ')
    expect(a?.indexes).toEqual(['int_01_hoverJet'])
    expect(a?.blobs).not.toContain('NZ')

    const c = await toPoint(crash(), 'NZ')
    expect(c?.blobs).toContain('-25:17')
    expect(c?.blobs).not.toContain('NZ')

    const e = await toPoint(error(), 'NZ')
    expect(e?.indexes[0]).toMatch(/^[0-9a-f]{16}$/)
    expect(e?.blobs).not.toContain('NZ')
  })

  it('drops a row with any field its kind does not list', async () => {
    expect(await toPoint(visit(), 'NZ')).not.toBeNull()
    for (const extra of ['userId', 'session', 'handle', 'owner', 'ip', 'gpu', 'k2']) {
      expect(await toPoint(visit({ [extra]: 'x' }), 'NZ'), extra).toBeNull()
    }
  })

  it('drops a row missing a field, with a value off its list, or a number that is not one', async () => {
    const { stageBefore: _omit, ...missing } = visit()
    expect(await toPoint(missing, 'NZ')).toBeNull()
    expect(await toPoint(visit({ device: 'iPhone 15 Pro' }), 'NZ')).toBeNull()
    expect(await toPoint(visit({ build: 'v0.18.0 matt' }), 'NZ')).toBeNull()
    expect(await toPoint(visit({ keyboard: 2 }), 'NZ')).toBeNull()
    expect(await toPoint(visit({ attempts: Number.NaN }), 'NZ')).toBeNull()
    expect(await toPoint(visit({ attempts: '4' }), 'NZ')).toBeNull()
    expect(await toPoint(attempt({ mission: 'a mission with spaces' }), 'NZ')).toBeNull()
    expect(await toPoint({ k: 'session', build: 'v0.18.0' }, 'NZ')).toBeNull()
    expect(await toPoint([visit()], 'NZ')).toBeNull()
  })

  it('clamps counts and rounds them', async () => {
    const p = await toPoint(visit({ attempts: 99_999, finishes: -3, posts: 1.6 }), 'NZ')
    const names = numberFields(VISIT_FIELDS).map((f) => f.name)
    const at = (n: string) => p?.doubles[names.indexOf(n)]
    expect(at('attempts')).toBe(500)
    expect(at('finishes')).toBe(0)
    expect(at('posts')).toBe(2)
  })

  it('cleans an error message of numbers and addresses before it is kept', async () => {
    expect(
      cleanErrorMessage(
        'Failed to fetch https://facetedflight.net/assets/x.glb?v=3 for user noreply@example.com after 1200 ms',
      ),
    ).toBe('Failed to fetch <url> for user <email> after # ms')
    const long = await toPoint(error({ message: 'x'.repeat(300) }), 'NZ')
    expect(long?.blobs.find((b) => b.startsWith('xxx'))?.length).toBe(120)
    // Two errors that differ only by a number are one error, one index.
    const one = await toPoint(error({ message: 'chunk 12 failed' }), 'NZ')
    const two = await toPoint(error({ message: 'chunk 977 failed' }), 'NZ')
    expect(one?.indexes).toEqual(two?.indexes)
  })
})

describe('DEV-589: the endpoint', () => {
  it('writes what is valid, drops what is not, and answers 204 either way', async () => {
    const env = recorder()
    const outcome = await acceptStats(
      post({ rows: [visit(), attempt(), crash(), error(), visit({ device: 'x' })] }),
      env,
    )
    expect(outcome).toEqual({ written: 4, dropped: 1 })
    expect(env.points).toHaveLength(4)
    const response = await postStats(post({ rows: [visit({ device: 'x' })] }), recorder())
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('never writes the address, the city, the network or any header', async () => {
    const env = recorder()
    await acceptStats(
      post({ rows: [visit()] }, { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Secret/1.0' }),
      env,
    )
    const written = JSON.stringify(env.points)
    expect(env.points).toHaveLength(1)
    for (const leak of ['203.0.113.7', 'Wellington', '9500', 'Secret']) {
      expect(written).not.toContain(leak)
    }
  })

  it('refuses another site, an oversize body and a body that is not JSON', async () => {
    const env = recorder()
    expect(
      (await acceptStats(post({ rows: [visit()] }, { origin: 'https://evil.example' }), env))
        .refused,
    ).toBe('foreign-origin')
    expect((await acceptStats(post('x'.repeat(17 * 1024)), env)).refused).toBe('too-big')
    expect((await acceptStats(post('{rows:'), env)).refused).toBe('not-json')
    expect(env.points).toHaveLength(0)
    // No Origin at all is a same-origin beacon in some browsers, and is taken.
    const bare = new Request(`${SITE}/api/stats`, {
      method: 'POST',
      body: JSON.stringify({ rows: [visit()] }),
    })
    expect((await acceptStats(bare, env)).written).toBe(1)
  })

  it('DEV-676: refuses a body past the cap while reading, whatever Content-Length says', async () => {
    // A chunked body has no Content-Length, and a lying one says small. The
    // old handler awaited `request.text()` and measured afterwards, so an
    // endless body was read until memory ended. This source never ends: the
    // test counts pulls, and ends the stream at 2 MiB so a regression is a
    // red assertion rather than a dead worker.
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 2048) controller.close()
        else controller.enqueue(new Uint8Array(1024).fill(120))
      },
    })
    const request = new Request(`${SITE}/api/stats`, {
      method: 'POST',
      headers: { origin: SITE, 'content-length': '10' },
      body: endless,
      duplex: 'half',
    } as RequestInit)
    const outcome = await acceptStats(request, recorder())
    expect(outcome.refused).toBe('too-big')
    // 16 KiB is 16 chunks; a few more are prefetch. Never the thousands.
    expect(pulled).toBeLessThan(64)
  })

  it('DEV-676: the cap is in bytes, not UTF-16 units', async () => {
    // 6000 euro signs: 6000 units, 18000 bytes, past a 16 KiB cap.
    expect((await acceptStats(post('€'.repeat(6000)), recorder())).refused).toBe('too-big')
  })

  it('takes at most STATS_MAX_ROWS rows from one request', async () => {
    const env = recorder()
    const rows = Array.from({ length: STATS_MAX_ROWS + 5 }, () => crash())
    expect(await acceptStats(post({ rows }), env)).toEqual({ written: STATS_MAX_ROWS, dropped: 5 })
  })

  it('writes nothing with no binding, and does not throw', async () => {
    expect(await acceptStats(post({ rows: [visit()] }), {})).toEqual({ written: 0, dropped: 0 })
  })
})

describe('DEV-622: a bug report is answered with its id', () => {
  const bug = {
    k: 'bug',
    build: 'v0.20.0',
    channel: 'release',
    device: 'desktop',
    screen: 'mission',
    mission: 'int_01_hoverJet',
    quality: 'high',
    look: 'anniversary',
    scale: '1',
    error1: 'failed after 1200 ms at https://x.example/',
    error2: 'none',
    error3: 'none',
    tick: 4211,
  }

  it('writes it, answers 200 with a short id of the alphabet, and a fresh id each time', async () => {
    const env = recorder()
    const one = await postStats(post({ rows: [bug] }), env)
    expect(one.status).toBe(200)
    // BE-7: through the shared builder, so it is unsniffed and uncached like the rest.
    expect(one.headers.get('x-content-type-options')).toBe('nosniff')
    expect(one.headers.get('cache-control')).toBe('no-store')
    expect(one.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const { id } = (await one.json()) as { id: string }
    expect(id).toMatch(new RegExp(`^[${STATS_BUG_ID_ALPHABET}]{${STATS_BUG_ID_LENGTH}}$`))
    expect(env.points[0]?.indexes).toEqual([id])
    // The server cleans the errors as well, whatever a client sent.
    expect(env.points[0]?.blobs).toContain('failed after # ms at <url>')
    const two = (await (await postStats(post({ rows: [bug] }), env)).json()) as { id: string }
    expect(two.id).not.toBe(id)
  })

  it('anything else still answers 204 with no body', async () => {
    expect((await postStats(post({ rows: [visit()] }), recorder())).status).toBe(204)
  })
})
