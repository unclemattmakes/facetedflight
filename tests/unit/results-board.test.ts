// tests/unit/results-board.test.ts — the course's board on the results panel. DEV-431.
//
// Against the SERVER'S OWN ANSWERS, not a hand-written idea of them: every
// board here is seeded into a real SQLite with the lap server's migration, and
// asked for through the actual Pages Function
// (`functions/api/board/[mission]/[mode]/[edition]/[variant].ts`) by the
// game's own client (`net/lap-client.ts`'s `fetchBoard`). What reaches
// `resultsBoardView` is exactly what the panel would get.
//
// The e2e spec serves a stub board from `page.route`; the last describe here
// holds that stub's answer to the Function's, field for field, so the spec
// cannot drift into testing a server that does not exist.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  boardRows,
  boardTime,
  isMine,
  RESULTS_BOARD_TOP,
  type ResultsBoardFacts,
  type ResultsBoardFetch,
  resultsBoardView,
  wouldPlace,
} from '@/game/results-board'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS, isHandle } from '@/net/handles'
import { type BoardEntry, type BoardKey, fetchBoard } from '@/net/lap-client'
import { lapRules } from '@/net/lap-courses'
import { LAP_BOARD_SIZE } from '@/net/lap-policy'
import type { D1Database, D1PreparedStatement, LapEnv } from '@/net/lap-server'
import { FIXED_DT } from '@/sim/constants'
import { onRequestGet } from '../../functions/api/board/[mission]/[mode]/[edition]/[variant]'
import { boardAnswer, type StubBoardLap } from '../e2e/fixtures/board-stub'
import { REPO as ROOT } from './helpers/repo-root'

const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations', '0001_laps.sql'), 'utf8')
const KEY: BoardKey = {
  mission: 'int_01_hoverJet',
  mode: 'ringAttack',
  edition: 'anniversary',
  variant: 'standard',
}
const RULES = lapRules(KEY.mission, KEY.edition, KEY.variant) as string

/** D1's four methods over `node:sqlite`, as `lap-client.test.ts` binds them. */
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

interface Seed {
  readonly id: string
  readonly handle: string
  readonly seconds: number
  /** Another board's lap: what must NOT show on this one. */
  readonly edition?: string
  readonly variant?: string
  readonly onBoard?: boolean
}

/** A lap server holding these laps, the way `submitLap` stores them. */
const serverWith = (seeds: readonly Seed[]): LapEnv => {
  const db = new DatabaseSync(':memory:')
  db.exec(MIGRATION)
  const insert = db.prepare(
    'INSERT INTO laps (id, mission, mode, edition, variant, rules, vehicle, build, handle, owner_hash, ' +
      'ticks, seconds, rings, rings_total, distance, score2016, board, created_at, expires_at, lap) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  seeds.forEach((s, i) => {
    const edition = s.edition ?? KEY.edition
    const variant = s.variant ?? KEY.variant
    insert.run(
      s.id,
      KEY.mission,
      KEY.mode,
      edition,
      variant,
      lapRules(KEY.mission, edition, variant) ?? 'none',
      `hoverjet:${variant}`,
      'unit',
      s.handle,
      `owner-hash-${i}`,
      Math.round(s.seconds / FIXED_DT),
      s.seconds,
      21,
      21,
      9000,
      2100,
      s.onBoard === false ? 0 : 1,
      Date.UTC(2026, 8, 25, 12, i),
      s.onBoard === false ? Date.UTC(2026, 9, 25) : null,
      'AA',
    )
  })
  return { LAPS_DB: d1(db), IP_SALT: 'unit-salt' }
}

/** A `fetch` that is the board Function, routed as Pages routes it. */
const functionFetch =
  (env: LapEnv, seen: { url: string; init: RequestInit | undefined }[] = []) =>
  async (input: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url: input, init })
    const url = new URL(input, 'https://ff-10yr.test')
    const m = /^\/api\/board\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (!m) return new Response('not a board route', { status: 404 })
    const [, mission, mode, edition, variant] = m as unknown as string[]
    return onRequestGet({
      request: new Request(url, init),
      env,
      params: {
        mission: decodeURIComponent(mission as string),
        mode: decodeURIComponent(mode as string),
        edition: decodeURIComponent(edition as string),
        variant: decodeURIComponent(variant as string),
      },
      waitUntil: () => {},
      next: async () => new Response(null, { status: 404 }),
    })
  }

/** The board the panel would get: through the Function and the game's client. */
const fetched = async (env: LapEnv, key: BoardKey = KEY): Promise<ResultsBoardFetch> => {
  const r = await fetchBoard(key, functionFetch(env))
  return r.ok
    ? { status: 'ready', entries: r.entries }
    : { status: 'failed', offline: r.status === 0, reason: r.reason }
}

const facts = (
  fetch: ResultsBoardFetch,
  over: Partial<ResultsBoardFacts> = {},
): ResultsBoardFacts => ({
  fetch,
  refreshing: false,
  edition: 'Anniversary',
  variant: 'Standard',
  posted: new Set<string>(),
  handle: null,
  eligible: null,
  ...over,
})

/** Nine laps on this board, fastest first by construction, and two elsewhere. */
const NINE: readonly Seed[] = [
  { id: 'AAAAAAAAA1', handle: 'Swift Kestrel 42', seconds: 54.213 },
  { id: 'AAAAAAAAA2', handle: 'Brave Petrel 55', seconds: 55.9 },
  { id: 'AAAAAAAAA3', handle: 'Emerald Albatross 42', seconds: 57.03 },
  { id: 'AAAAAAAAA4', handle: 'Keen Heron 17', seconds: 58.02 },
  { id: 'AAAAAAAAA5', handle: 'Calm Tern 33', seconds: 58.4 },
  { id: 'AAAAAAAAA6', handle: 'Bold Heron 77', seconds: 59.1 },
  { id: 'AAAAAAAAA7', handle: 'Keen Swallow 21', seconds: 60.5 },
  { id: 'AAAAAAAAA8', handle: 'Lucky Pelican 64', seconds: 61.23 },
  { id: 'AAAAAAAAA9', handle: 'Steady Wren 12', seconds: 63 },
  // Not on this board: Classic's, the speed jet's, and a lap off the board.
  { id: 'BBBBBBBBB1', handle: 'Fleet Kite 11', seconds: 40, edition: 'classic' },
  { id: 'BBBBBBBBB2', handle: 'Fleet Kite 12', seconds: 41, variant: 'speed' },
  { id: 'BBBBBBBBB3', handle: 'Fleet Kite 13', seconds: 42, onBoard: false },
]

describe('the board the Function answers, as the panel draws it', () => {
  it('lists the top five of THIS board, rank, time and handle, and no other board’s laps', async () => {
    const view = resultsBoardView(facts(await fetched(serverWith(NINE))))
    expect(view.heading).toBe('LEADERBOARD')
    expect(view.sub).toBe('ANNIVERSARY · STANDARD')
    expect(view.rows).toEqual([
      { rank: 1, gap: false, time: '54.21s', name: 'SWIFT KESTREL 42', mine: false },
      { rank: 2, gap: false, time: '55.90s', name: 'BRAVE PETREL 55', mine: false },
      { rank: 3, gap: false, time: '57.03s', name: 'EMERALD ALBATROSS 42', mine: false },
      { rank: 4, gap: false, time: '58.02s', name: 'KEEN HERON 17', mine: false },
      { rank: 5, gap: false, time: '58.40s', name: 'CALM TERN 33', mine: false },
    ])
    expect(RESULTS_BOARD_TOP, "2016's Top 5 (Leaderboard_Steam.cs:219)").toBe(5)
    // Nothing of yours, nothing to place: the lines are the whole plate.
    expect(view.say).toBeNull()
  })

  it('a board per edition: Classic’s lists only its own lap, and names Classic', async () => {
    const env = serverWith(NINE)
    const view = resultsBoardView(
      facts(await fetched(env, { ...KEY, edition: 'classic' }), {
        edition: 'Classic',
        variant: null,
      }),
    )
    expect(view.sub).toBe('CLASSIC')
    expect(view.rows.map((r) => r.name)).toEqual(['FLEET KITE 11'])
  })

  it('your line in the top five is marked there, and says your place', async () => {
    const view = resultsBoardView(
      facts(await fetched(serverWith(NINE)), { handle: 'Emerald Albatross 42' }),
    )
    expect(view.rows.map((r) => r.mine)).toEqual([false, false, true, false, false])
    expect(view.rows).toHaveLength(RESULTS_BOARD_TOP)
    expect(view.say).toEqual({
      caption: 'YOUR PLACE',
      line: '#3',
      detail: '57.03s',
      tone: 'accent',
    })
  })

  it('your line below the top five is drawn after them, marked as a gap unless it is sixth', async () => {
    const entries = await fetched(serverWith(NINE))
    const eighth = resultsBoardView(facts(entries, { posted: new Set(['AAAAAAAAA8']) }))
    expect(eighth.rows).toHaveLength(RESULTS_BOARD_TOP + 1)
    expect(eighth.rows.at(-1)).toEqual({
      rank: 8,
      gap: true,
      time: '61.23s',
      name: 'LUCKY PELICAN 64',
      mine: true,
    })
    expect(eighth.say?.line).toBe('#8')
    const sixth = resultsBoardView(facts(entries, { handle: 'Bold Heron 77' }))
    expect(sixth.rows.at(-1)).toMatchObject({ rank: 6, gap: false, mine: true })
  })

  it('a lap id this page posted is yours whatever handle it went under', async () => {
    const entries = (await fetched(serverWith(NINE))) as { entries: readonly BoardEntry[] }
    const e = entries.entries[1] as BoardEntry
    expect(isMine(e, { posted: new Set([e.id]), handle: 'Noble Raven 10' })).toBe(true)
    expect(isMine(e, { posted: new Set(), handle: e.handle })).toBe(true)
    expect(isMine(e, { posted: new Set(), handle: null })).toBe(false)
  })

  it('the lap on the panel is placed where the server would put it: below a tie', async () => {
    const entries = await fetched(serverWith(NINE))
    // 58.02 ties fourth: the server orders a tie by arrival, so a new lap is fifth.
    expect(resultsBoardView(facts(entries, { eligible: 58.02 })).say).toEqual({
      caption: 'THIS LAP WOULD BE',
      line: '#5',
      detail: 'IF YOU POST IT',
      tone: 'accent',
    })
    expect(resultsBoardView(facts(entries, { eligible: 50 })).say?.line).toBe('#1')
    expect(resultsBoardView(facts(entries, { eligible: 99 })).say?.line).toBe('#10')
  })

  it('one place per device: your slower line is replaced, your faster one stands', async () => {
    const ready = (await fetched(serverWith(NINE))) as {
      status: 'ready'
      entries: readonly BoardEntry[]
    }
    const mine = { posted: new Set<string>(), handle: 'Lucky Pelican 64' }
    // Yours is eighth at 61.23; a 60.0 would move it to seventh, not add a line.
    expect(wouldPlace(ready.entries, 60, mine)).toBe(7)
    // A 62.0 would not board at all: the 61.23 that stands is the answer.
    expect(wouldPlace(ready.entries, 62, mine)).toBeNull()
    const view = resultsBoardView(facts(ready, { ...mine, eligible: 62 }))
    expect(view.say).toMatchObject({ caption: 'YOUR PLACE', line: '#8' })
  })

  it('a full board a lap would miss says so, rather than claim #101', () => {
    const full: BoardEntry[] = Array.from({ length: LAP_BOARD_SIZE }, (_, i) => ({
      rank: i + 1,
      id: `C${String(i).padStart(9, '0')}`,
      handle: 'Calm Tern 33',
      seconds: 50 + i,
      rings: 21,
    }))
    const view = resultsBoardView(facts({ status: 'ready', entries: full }, { eligible: 500 }))
    expect(view.say).toMatchObject({ line: 'NOT RANKED', detail: 'ONLY THE TOP 100 ARE' })
  })
})

describe('the plate is never blank (Matt: offline or empty must SAY so)', () => {
  it('an empty board says it has no laps, and asks for this one when it could go on it', async () => {
    const empty = await fetched(serverWith([]))
    expect(empty).toEqual({ status: 'ready', entries: [] })
    expect(resultsBoardView(facts(empty)).say).toEqual({
      caption: '',
      line: 'NO LAPS POSTED YET',
      detail: 'TAKE EVERY RING, THEN POST, TO BE THE FIRST',
      tone: 'dim',
    })
    expect(resultsBoardView(facts(empty, { eligible: 61 })).say).toMatchObject({
      detail: 'POST THIS LAP TO BE THE FIRST',
      tone: 'accent',
    })
  })

  it('no answer at all reads OFFLINE; a server that answers and refuses says why', async () => {
    const offline = await fetchBoard(KEY, async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(offline.ok).toBe(false)
    if (offline.ok) return
    const offView = resultsBoardView(
      facts({ status: 'failed', offline: offline.status === 0, reason: offline.reason }),
    )
    expect(offView.rows).toEqual([])
    expect(offView.say).toMatchObject({
      line: 'OFFLINE',
      detail: 'THE LEADERBOARD COULD NOT BE REACHED',
    })
    // The Function with no database bound: its own 503 and its own words.
    const unbound = await fetched({ IP_SALT: 'unit-salt' } as LapEnv)
    expect(unbound).toEqual({
      status: 'failed',
      offline: false,
      reason: 'the lap server has no database bound',
    })
    expect(resultsBoardView(facts(unbound)).say).toMatchObject({
      line: 'LEADERBOARD UNAVAILABLE',
      detail: 'THE LAP SERVER HAS NO DATABASE BOUND',
    })
  })

  it('every state, with and without a lap to place, has lines or a line that says why', async () => {
    const some = await fetched(serverWith(NINE))
    const states: ResultsBoardFetch[] = [
      { status: 'loading' },
      { status: 'failed', offline: true, reason: 'the lap server could not be reached' },
      { status: 'failed', offline: false, reason: 'the server answered 500' },
      { status: 'ready', entries: [] },
      some,
    ]
    let cases = 0
    for (const fetch of states) {
      for (const eligible of [null, 57, 99]) {
        for (const refreshing of [false, true]) {
          for (const handle of [null, 'Calm Tern 33', 'Steady Wren 12']) {
            const view = resultsBoardView(facts(fetch, { eligible, refreshing, handle }))
            const says =
              view.say !== null && (view.say.line.length > 0 || view.say.caption.length > 0)
            expect(view.rows.length > 0 || says, JSON.stringify({ fetch, eligible })).toBe(true)
            if (view.rows.length === 0) expect(view.say?.line.length ?? 0).toBeGreaterThan(0)
            cases += 1
          }
        }
      }
    }
    expect(cases).toBe(90)
  })

  it('loading says so; a refetch keeps the lines and says it is updating', async () => {
    expect(resultsBoardView(facts({ status: 'loading' })).say?.line).toBe('LOADING THE LEADERBOARD')
    const view = resultsBoardView(facts(await fetched(serverWith(NINE)), { refreshing: true }))
    expect(view.rows).toHaveLength(RESULTS_BOARD_TOP)
    expect(view.say).toMatchObject({ caption: 'UPDATING THE LEADERBOARD' })
  })
})

describe('what asking for a board sends', () => {
  it('a GET of the course’s path and nothing else: no handle, no owner key, no body', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    await fetchBoard(KEY, functionFetch(serverWith(NINE), seen))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('/api/board/int_01_hoverJet/ringAttack/anniversary/standard')
    expect(seen[0]?.init?.body ?? null).toBeNull()
    expect(seen[0]?.init?.headers ?? null).toBeNull()
    // The first ask may be the browser's cached copy: the server allows 30 s.
    expect(seen[0]?.init?.cache).toBeUndefined()
  })

  it('asked again after a Share, it goes past the browser’s cache, and still sends nothing else', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const env = serverWith(NINE)
    const r = await fetchBoard(KEY, functionFetch(env, seen), '', true)
    expect(r.ok).toBe(true)
    // `max-age=30` on the answer is what makes this necessary: the Function says so.
    const answer = await functionFetch(env)(seen[0]?.url as string)
    expect(answer.headers.get('cache-control')).toBe('public, max-age=30')
    expect(seen[0]?.init).toEqual({ cache: 'no-cache' })
  })
})

describe('the words', () => {
  it('the handles here are ones the game can make, and the longest it can make is 20 characters', () => {
    for (const s of NINE) expect(isHandle(s.handle), s.handle).toBe(true)
    // `render/results.ts` measures the plate's name column for this; the
    // e2e photograph's third line (EMERALD ALBATROSS 42) is one.
    const longest = (words: readonly string[]) => Math.max(...words.map((w) => w.length))
    expect(longest(HANDLE_ADJECTIVES) + 1 + longest(HANDLE_NOUNS) + 3).toBe(20)
    expect('Emerald Albatross 42').toHaveLength(20)
  })

  it('times to the hundredth, because two laps a tick apart are two ranks', () => {
    expect(boardTime(54.2134)).toBe('54.21s')
    expect(boardTime(54.2256)).toBe('54.23s')
    expect(boardTime(54.21)).not.toBe(boardTime(54.2222))
  })

  it('draws no rows beyond the top five and your own', () => {
    const entries: BoardEntry[] = Array.from({ length: 30 }, (_, i) => ({
      rank: i + 1,
      id: `D${String(i).padStart(9, '0')}`,
      handle: 'Keen Swallow 21',
      seconds: 50 + i,
      rings: 21,
    }))
    // Every line is under your handle: only the top five, all yours, no sixth.
    expect(boardRows(entries, { posted: new Set(), handle: 'Keen Swallow 21' })).toHaveLength(5)
  })
})

describe("the e2e spec's stub board is the Function's answer", () => {
  it('same fields, same types, same values for the same laps', async () => {
    const laps: StubBoardLap[] = NINE.slice(0, 3).map(({ id, handle, seconds }) => ({
      id,
      handle,
      seconds,
    }))
    const real = (await (
      await functionFetch(serverWith(laps))(
        '/api/board/int_01_hoverJet/ringAttack/anniversary/standard',
      )
    ).json()) as Record<string, unknown> & { entries: Record<string, unknown>[] }
    const stub = boardAnswer(KEY, RULES, laps, 21) as unknown as Record<string, unknown> & {
      entries: Record<string, unknown>[]
    }
    const shape = (o: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, typeof o[k]]),
      )
    expect(shape(stub)).toEqual(shape(real))
    expect(stub.entries.map(shape)).toEqual(real.entries.map(shape))
    // The fields the game reads, value for value.
    const read = (e: Record<string, unknown>) => [e.rank, e.id, e.handle, e.seconds, e.rings]
    expect(stub.entries.map(read)).toEqual(real.entries.map(read))
    expect(stub.rules).toBe(real.rules)
  })
})
