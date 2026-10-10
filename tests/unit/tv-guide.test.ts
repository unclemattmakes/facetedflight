// tests/unit/tv-guide.test.ts — Faceted Flight TV's guide, pure. DEV-479.
//
// `src/net/tv-guide.ts` over a fake clock, storage and alarm (storage CLONES,
// as `helpers/fake-room.ts`'s does, so "resumes from storage" cannot pass with
// the state only in memory), and its internal API joined to its callers with
// real Requests and Responses. plan/FF-TV.md §3.2: announce, withdraw,
// expire, resolve, list, off-air — and the two shapes the privacy rule rests
// on: no room id on the list, and a TV id that can never be a room's id.

import { describe, expect, it } from 'vitest'
import { ROOM_CODE_SHAPE, ROOM_ID_SHAPE } from '@/net/room-protocol'
import { answerTvGuide, TvGuide, type TvGuideHost, tvGuideOverFetch } from '@/net/tv-guide'
import {
  mintTvId,
  TV_GUIDE_NAME,
  TV_ID_SHAPE,
  TV_MAX_ROOMS,
  TV_OFF_AIR_MAX_MS,
  type TvAnnounce,
} from '@/net/tv-protocol'

const ROOM = 'abcdefghij234567'
const NOW = 5_000_000

/** The fake platform under a guide: `now` is a field the test moves; `open` adapts it. */
class FakeGuideHost {
  now = NOW
  alarm: number | null = null
  readonly stored = new Map<string, unknown>()
  readonly storage = {
    get: async <T>(key: string) => {
      const v = this.stored.get(key)
      return v === undefined ? undefined : (structuredClone(v) as T)
    },
    put: async <T>(key: string, value: T) => {
      this.stored.set(key, structuredClone(value))
    },
    delete: async (key: string) => this.stored.delete(key),
  }
  setAlarm = async (at: number | null) => {
    this.alarm = at
  }
}

const open = async () => {
  const host = new FakeGuideHost()
  const h: TvGuideHost = { now: () => host.now, storage: host.storage, setAlarm: host.setAlarm }
  return { host, guide: await TvGuide.load(h), reload: () => TvGuide.load(h) }
}

/** Distinct ids, through the real `mintTvId`: the counter's base-32 digits, then noise. */
let counter = 1
const tvId = () =>
  mintTvId((b) => {
    let n = counter++
    for (let i = 0; i < b.length; i++) {
      b[i] = i < 4 ? n & 31 : (i * 151 + counter) & 0xff
      if (i < 4) n >>= 5
    }
  })

const entry = (over: Partial<TvAnnounce> = {}): TvAnnounce => ({
  tv: tvId(),
  room: ROOM,
  mission: 'int_01_hoverJet',
  phase: 'racing',
  racers: 6,
  goAt: NOW - 1000,
  until: NOW + 200_000,
  at: NOW,
  ...over,
})

describe('the TV id (§2.2)', () => {
  it('is tv_ and sixteen of the room alphabet, and never a room id or a short code', () => {
    // RED against an id without the underscore: `tv` + 16 base32 is a room id's shape.
    for (let i = 0; i < 500; i++) {
      const id = tvId()
      expect(id).toMatch(TV_ID_SHAPE)
      expect(ROOM_ID_SHAPE.test(id), id).toBe(false)
      expect(ROOM_CODE_SHAPE.test(id), id).toBe(false)
    }
    // And the guide's own name is no room's either.
    expect(ROOM_ID_SHAPE.test(TV_GUIDE_NAME)).toBe(false)
  })
})

describe('announce, list, resolve (§3.2)', () => {
  it('lists a racing room under its TV id, with no room id anywhere in the list', async () => {
    const { guide } = await open()
    const a = entry()
    expect(await guide.announce(a)).toBe(true)
    const list = guide.list()
    expect(list.races).toEqual([
      { tv: a.tv, mission: 'int_01_hoverJet', phase: 'racing', racers: 6, since: a.goAt },
    ])
    // RED against a list that spreads the entry: the room's id rides along.
    expect(JSON.stringify(list)).not.toContain(ROOM)
    expect(guide.resolve(a.tv)).toBe(ROOM)
    expect(guide.resolve(tvId())).toBeNull()
    expect(guide.resolve('not a tv id')).toBeNull()
  })

  it('reads a countdown whose GO has passed as racing: nothing announces the GO', async () => {
    const { host, guide } = await open()
    const a = entry({ phase: 'countdown', goAt: NOW + 3000 })
    await guide.announce(a)
    expect(guide.list().races[0]?.phase).toBe('countdown')
    host.now = NOW + 3000
    expect(guide.list().races[0]).toMatchObject({ phase: 'racing', since: NOW + 3000 })
  })

  it('keeps a lobby resolvable and OFF the list, and counts it', async () => {
    const { guide } = await open()
    const a = entry()
    await guide.announce(a)
    expect(guide.list().races).toHaveLength(1)
    // RED against a guide that lists every phase.
    await guide.announce({ ...a, phase: 'lobby', goAt: null, at: NOW + 1 })
    expect(guide.list()).toEqual({ races: [], lobbies: 1 })
    expect(guide.resolve(a.tv)).toBe(ROOM)
  })

  it('ignores an announce older than the one it holds', async () => {
    const { guide } = await open()
    const a = entry({ phase: 'results', at: NOW + 10 })
    await guide.announce(a)
    await guide.announce({ ...a, phase: 'racing', at: NOW + 5 })
    expect(guide.list().races[0]?.phase).toBe('results')
  })

  it('holds at most TV_MAX_ROOMS rooms, and still takes news of one it holds', async () => {
    const { guide } = await open()
    const held: TvAnnounce[] = []
    for (let i = 0; i < TV_MAX_ROOMS; i++) {
      const a = entry()
      held.push(a)
      expect(await guide.announce(a)).toBe(true)
    }
    expect(await guide.announce(entry())).toBe(false)
    const first = held[0] as TvAnnounce
    expect(await guide.announce({ ...first, phase: 'results', at: NOW + 1 })).toBe(true)
    expect(guide.list().races).toHaveLength(TV_MAX_ROOMS)
  })
})

describe('withdraw and expire (§3.2)', () => {
  it('drops a room on withdraw, and its off-air mark only when it cleared', async () => {
    const { guide } = await open()
    const a = entry()
    await guide.announce(a)
    await guide.offAir({ tv: a.tv })
    await guide.withdraw(a.tv, false)
    expect(guide.resolve(a.tv)).toBeNull()
    expect(guide.state().offAir[a.tv]).toBeDefined()
    await guide.withdraw(a.tv, true)
    expect(guide.state().offAir[a.tv]).toBeUndefined()
  })

  it('expires an entry past its `until`, from the list, the resolve and storage', async () => {
    const { host, guide, reload } = await open()
    const a = entry({ until: NOW + 60_000 })
    await guide.announce(a)
    expect(host.alarm).toBe(NOW + 60_000)
    host.now = NOW + 60_000
    // RED against a guide that never reads `until`.
    expect(guide.list().races).toEqual([])
    expect(guide.resolve(a.tv)).toBeNull()
    await guide.onAlarm()
    expect(host.stored.size).toBe(0)
    expect(host.alarm).toBeNull()
    expect((await reload()).list().races).toEqual([])
  })

  it('resumes from storage: a reloaded guide still resolves what it held', async () => {
    const { guide, reload } = await open()
    const a = entry()
    await guide.announce(a)
    expect((await reload()).resolve(a.tv)).toBe(ROOM)
  })
})

describe('off the air (§3.6)', () => {
  it('drops one TV id from the list and refuses to resolve it, for its room’s life (bounded)', async () => {
    const { host, guide } = await open()
    const a = entry({ until: NOW + 10 * TV_OFF_AIR_MAX_MS })
    const b = entry()
    await guide.announce(a)
    await guide.announce(b)
    await guide.offAir({ tv: a.tv })
    // RED against a guide that keeps no off-air set.
    expect(guide.list().races.map((r) => r.tv)).toEqual([b.tv])
    expect(guide.resolve(a.tv)).toBeNull()
    expect(guide.resolve(b.tv)).toBe(ROOM)
    // A fresh announce of the same id does not put it back.
    await guide.announce({ ...a, phase: 'results', at: NOW + 1 })
    expect(guide.resolve(a.tv)).toBeNull()
    await guide.onAir({ tv: a.tv })
    expect(guide.resolve(a.tv)).toBe(ROOM)
    await guide.offAir({ tv: a.tv })
    host.now = NOW + TV_OFF_AIR_MAX_MS
    expect(guide.resolve(a.tv)).toBe(ROOM)
  })

  it('goes dark until a time, and comes back at it', async () => {
    const { host, guide } = await open()
    const a = entry({ until: NOW + 10 * 60_000 })
    await guide.announce(a)
    await guide.offAir({ until: NOW + 60_000 })
    expect(guide.list()).toEqual({ races: [], lobbies: 0 })
    expect(guide.resolve(a.tv)).toBeNull()
    host.now = NOW + 60_000
    expect(guide.list().races).toHaveLength(1)
  })
})

describe('the internal API, over real Requests', () => {
  it('answers announce, resolve, list, withdraw and off-air as the methods do', async () => {
    const { guide } = await open()
    const link = tvGuideOverFetch((r) => answerTvGuide(guide, r))
    const a = entry()
    expect(await link.announce(a)).toBe(true)
    expect(await link.resolve(a.tv)).toBe(ROOM)
    expect((await link.list()).races.map((r) => r.tv)).toEqual([a.tv])
    expect(await link.offAir({ tv: a.tv })).toBe(true)
    expect(await link.resolve(a.tv)).toBeNull()
    expect(await link.onAir({ tv: a.tv })).toBe(true)
    await link.withdraw(a.tv, true)
    expect(await link.resolve(a.tv)).toBeNull()
  })

  it('refuses an announce of the wrong shape, and an unknown path', async () => {
    const { guide } = await open()
    const link = tvGuideOverFetch((r) => answerTvGuide(guide, r))
    expect(await link.announce({ ...entry(), room: 'tv.guide' })).toBe(false)
    expect(await link.announce({ ...entry(), tv: ROOM })).toBe(false)
    const r = await answerTvGuide(guide, new Request('https://tv.internal/nothing'))
    expect(r.status).toBe(404)
  })
})
