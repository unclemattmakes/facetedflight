// tests/unit/tv-client.test.ts, what TV shows, and when it changes. DEV-480.
//
// docs/plan/FF-TV.md §2.6, §3.3, §3.4. The client is driven here with a list it
// is handed, a watch whose state the test sets, and a clock the test moves, so
// every claim is about the decision and none about a socket:
//
//   1. It chooses AT RANDOM among the races furthest along, prefers one it has
//      not shown, and never chooses a race that has ended.
//   2. It never spins: no list, no rooms (503), a full race, a gone room (404)
//     each lands on the next race or the exhibition, saying why.
//   3. It never cuts away from a live race on its own clock; it re-reads at the
//      finish (after the results hold) and every 60 s, and a race found while
//      the exhibition runs waits for the exhibition's finish.

import { describe, expect, it } from 'vitest'
import { ROOM_OFF, ROOM_UNREACHABLE } from '@/game/room-client'
import {
  chooseRace,
  parseTvListing,
  TV_FINISH_HOLD_MS,
  TV_NOTE,
  TV_REREAD_MS,
  TvClient,
  type TvListing,
  type TvRace,
  type TvShow,
  type TvWatchState,
  tvWatchUrl,
} from '@/game/tv/tv-client'
import { CLOSE } from '@/net/room-protocol'

const id = (c: string) => `tv_${c.repeat(16)}`
const race = (c: string, phase: TvRace['phase'], mission = 'int_01_hoverJet'): TvRace => ({
  tv: id(c),
  mission,
  phase,
  racers: 2,
  since: 0,
})
const listing = (...races: TvRace[]): TvListing => ({ races, lobbies: 0 })

describe('choosing a race', () => {
  it('takes only the races furthest along: racing over countdown over loading', () => {
    const l = listing(race('a', 'loading'), race('b', 'countdown'), race('c', 'racing'))
    for (const r of [0, 0.5, 0.99]) {
      expect(chooseRace(l, { random: () => r })?.tv).toBe(id('c'))
    }
    expect(
      chooseRace(listing(race('a', 'loading'), race('b', 'countdown')), { random: () => 0 })?.tv,
    ).toBe(id('b'))
  })

  it('picks AT RANDOM within that tier', () => {
    const l = listing(race('a', 'racing'), race('b', 'racing'), race('c', 'racing'))
    expect(chooseRace(l, { random: () => 0 })?.tv).toBe(id('a'))
    expect(chooseRace(l, { random: () => 0.5 })?.tv).toBe(id('b'))
    expect(chooseRace(l, { random: () => 0.999 })?.tv).toBe(id('c'))
  })

  it('prefers a race not shown yet, and never the one excluded', () => {
    const l = listing(race('a', 'racing'), race('b', 'racing'))
    expect(chooseRace(l, { shown: new Set([id('a')]), random: () => 0 })?.tv).toBe(id('b'))
    // Every race shown: the whole tier again, so Next Race wraps.
    expect(chooseRace(l, { shown: new Set([id('a'), id('b')]), random: () => 0 })?.tv).toBe(id('a'))
    expect(chooseRace(l, { exclude: id('a'), random: () => 0 })?.tv).toBe(id('b'))
    expect(
      chooseRace(listing(race('a', 'racing')), { exclude: id('a'), random: () => 0 }),
    ).toBeNull()
  })

  it('never chooses a race that has ended', () => {
    expect(chooseRace(listing(race('a', 'results')), { random: () => 0 })).toBeNull()
    expect(chooseRace(listing(), { random: () => 0 })).toBeNull()
  })
})

describe('the list as read', () => {
  it('keeps the §3.3 shape and drops a race that is not it, a room code included', () => {
    const l = parseTvListing({
      races: [
        race('a', 'racing'),
        { tv: 'K7QX4M2', mission: 'm', phase: 'racing', racers: 2, since: 0 },
        { tv: id('b'), mission: 'm', phase: 'lobby', racers: 2, since: 0 },
        { tv: id('c'), mission: 'm', phase: 'racing' },
      ],
      lobbies: 3,
    })
    expect(l?.races.map((r) => r.tv)).toEqual([id('a')])
    expect(l?.lobbies).toBe(3)
    expect(parseTvListing({ lobbies: 1 })).toBeNull()
    expect(parseTvListing(null)).toBeNull()
  })

  it('watches on the page’s own origin, /api/tv/<id>', () => {
    expect(tvWatchUrl(id('a'), { protocol: 'https:', host: 'ff-10yr.pages.dev' })).toBe(
      `wss://ff-10yr.pages.dev/api/tv/${id('a')}`,
    )
    expect(tvWatchUrl(id('a'), { protocol: 'http:', host: 'localhost:5480' })).toBe(
      `ws://localhost:5480/api/tv/${id('a')}`,
    )
  })
})

/** A client on a list the test owns, a watch the test sets, and a clock the test moves. */
const rig = (answer: () => { status: number; body: unknown } | 'offline') => {
  let now = 0
  let watch: TvWatchState | null = null
  const shows: TvShow[] = []
  let reads = 0
  const client = new TvClient({
    now: () => now,
    random: () => 0,
    list: async () => {
      reads++
      const a = answer()
      if (a === 'offline') throw new Error('offline')
      return a
    },
    watchState: () => watch,
    onShow: (s) => shows.push(s),
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return {
    client,
    shows,
    reads: () => reads,
    flush,
    at: (ms: number) => {
      now = ms
    },
    watch: (w: Partial<TvWatchState> | null) => {
      watch =
        w === null ? null : { status: 'open', closeCode: null, probed: null, phase: null, ...w }
    },
  }
}

describe('never a spin', () => {
  it('shows the exhibition at once when the list does not answer, or the site has no rooms', async () => {
    for (const a of [
      'offline',
      { status: 503, body: null },
      { status: 404, body: null },
    ] as const) {
      const r = rig(() => a)
      r.client.start({ kind: 'random' })
      await r.flush()
      expect(r.client.mode, JSON.stringify(a)).toBe('exhibition')
      expect(r.shows.at(-1)?.kind).toBe('exhibition')
    }
  })

  it('reads a 503 once and never asks again', async () => {
    const r = rig(() => ({ status: 503, body: null }))
    r.client.start({ kind: 'random' })
    await r.flush()
    expect(r.client.roomsOff).toBe(true)
    r.at(TV_REREAD_MS * 3)
    r.client.update()
    r.client.next()
    await r.flush()
    expect(r.reads()).toBe(1)
    expect(r.client.mode).toBe('exhibition')
  })

  it('boards a race off the list, and the next race when that one is full', async () => {
    const r = rig(() => ({ status: 200, body: listing(race('a', 'racing'), race('b', 'racing')) }))
    r.client.start({ kind: 'random' })
    await r.flush()
    expect(r.shows.at(-1)).toEqual({ kind: 'live', tv: id('a'), mission: 'int_01_hoverJet' })
    r.watch({ status: 'closed', closeCode: CLOSE.full })
    r.client.update()
    await r.flush()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('b') })
    expect(r.client.note).toBe(TV_NOTE.full)
  })

  it('a link to a room that has gone (404) says so, and makes the list’s choice', async () => {
    const r = rig(() => ({ status: 200, body: listing(race('b', 'racing')) }))
    r.client.start({ kind: 'race', tv: id('a'), follow: 2 })
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('a') })
    r.watch({ status: 'closed', closeCode: ROOM_UNREACHABLE, probed: 404 })
    r.client.update()
    await r.flush()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('b') })
    expect(r.client.note).toBe(TV_NOTE.closed)
  })

  it('a watch refused for no rooms goes to the exhibition, not round the list', async () => {
    const r = rig(() => ({ status: 200, body: listing(race('b', 'racing')) }))
    r.client.start({ kind: 'race', tv: id('a'), follow: null })
    r.watch({ status: 'closed', closeCode: ROOM_OFF, probed: 503 })
    r.client.update()
    await r.flush()
    expect(r.client.mode).toBe('exhibition')
    expect(r.reads()).toBe(0)
  })
})

describe('when it changes', () => {
  it('never cuts away from a live race on the clock, and re-reads after the results hold', async () => {
    let l = listing(race('a', 'racing'))
    const r = rig(() => ({ status: 200, body: l }))
    r.client.start({ kind: 'random' })
    await r.flush()
    r.watch({ phase: 'racing' })
    // A second race appears; the clock reads it; nothing changes on screen.
    l = listing(race('a', 'racing'), race('b', 'racing'))
    r.at(TV_REREAD_MS + 1)
    r.client.update()
    await r.flush()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('a') })
    // The race ends: the results hold, then the next race.
    l = listing(race('a', 'results'), race('b', 'racing'))
    r.watch({ phase: 'results' })
    r.at(TV_REREAD_MS + 2)
    r.client.update()
    await r.flush()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('a') })
    r.at(TV_REREAD_MS + 2 + TV_FINISH_HOLD_MS)
    r.client.update()
    await r.flush()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('b') })
  })

  it('takes its race as over when the list says so, though the watch still reads racing', async () => {
    // Seen in tv-live.spec.ts: the guide lists both rooms in `results` while
    // the watched session's phase stays `racing` (a `results` message moves no
    // phase). The clock's read must end the race on the list's word.
    let l = listing(race('a', 'racing'))
    const r = rig(() => ({ status: 200, body: l }))
    r.client.start({ kind: 'random' })
    await r.flush()
    r.watch({ phase: 'racing' })
    l = listing(race('a', 'results'))
    r.at(TV_REREAD_MS)
    r.client.update()
    await r.flush()
    expect(r.client.mode).toBe('live')
    // The next frame starts the results hold; a hold later, TV moves on.
    r.at(TV_REREAD_MS + 1)
    r.client.update()
    r.at(TV_REREAD_MS + 1 + TV_FINISH_HOLD_MS)
    r.client.update()
    await r.flush()
    expect(r.client.mode).toBe('exhibition')
  })

  it('goes to the exhibition when the races end, and back when one is on at its finish', async () => {
    let l = listing(race('a', 'racing'))
    const r = rig(() => ({ status: 200, body: l }))
    r.client.start({ kind: 'random' })
    await r.flush()
    l = listing(race('a', 'results'))
    r.watch({ phase: 'results' })
    r.client.update()
    r.at(TV_FINISH_HOLD_MS)
    r.client.update()
    await r.flush()
    expect(r.client.mode).toBe('exhibition')
    // A race starts; the clock notices it; the exhibition runs on until its finish.
    r.watch(null)
    l = listing(race('c', 'racing'))
    r.at(TV_FINISH_HOLD_MS + TV_REREAD_MS)
    r.client.update()
    await r.flush()
    expect(r.client.mode).toBe('exhibition')
    expect(r.client.note).toBe(TV_NOTE.live)
    r.client.exhibitionFinished()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('c') })
  })

  it('NEXT RACE flips through the list, and moves the exhibition on when nothing is live', async () => {
    let l = listing(race('a', 'racing'), race('b', 'racing'))
    const r = rig(() => ({ status: 200, body: l }))
    r.client.start({ kind: 'random' })
    await r.flush()
    expect(r.client.tv).toBe(id('a'))
    r.client.next()
    await r.flush()
    expect(r.client.tv).toBe(id('b'))
    r.client.next()
    await r.flush()
    expect(r.client.tv).toBe(id('a'))
    l = listing()
    r.client.next()
    await r.flush()
    expect(r.shows.at(-1)).toEqual({ kind: 'exhibition', lapId: null, next: false })
    r.client.next()
    await r.flush()
    expect(r.shows.at(-1)).toEqual({ kind: 'exhibition', lapId: null, next: true })
  })

  it('a link’s room between races shows the exhibition, and is preferred when it races again', async () => {
    let l = listing(race('z', 'racing'))
    const r = rig(() => ({ status: 200, body: l }))
    r.client.start({ kind: 'race', tv: id('a'), follow: 3 })
    r.watch({ phase: 'lobby' })
    r.client.update()
    expect(r.client.mode).toBe('exhibition')
    expect(r.client.note).toBe(TV_NOTE.between)
    r.watch(null)
    l = listing(race('z', 'racing'), race('a', 'countdown'))
    r.at(TV_REREAD_MS)
    r.client.update()
    await r.flush()
    expect(r.client.waiting?.tv).toBe(id('a'))
    r.client.exhibitionFinished()
    expect(r.shows.at(-1)).toMatchObject({ kind: 'live', tv: id('a') })
  })

  it('a lap link is the exhibition with that lap, and reads nothing first', () => {
    const r = rig(() => ({ status: 200, body: listing() }))
    r.client.start({ kind: 'lap', lap: 'Ab3dE6gH9k' })
    expect(r.shows).toEqual([{ kind: 'exhibition', lapId: 'Ab3dE6gH9k', next: false }])
    expect(r.reads()).toBe(0)
  })

  it('drops a list read that lands after LEAVE TV', async () => {
    const r = rig(() => ({ status: 200, body: listing(race('a', 'racing')) }))
    r.client.start({ kind: 'random' })
    r.client.stop()
    await r.flush()
    expect(r.client.mode).toBe('off')
    expect(r.shows).toEqual([])
  })
})
