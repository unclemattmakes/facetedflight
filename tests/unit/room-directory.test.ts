// DEV-633: the directory of PUBLIC rooms (`src/net/room-directory.ts`), and
// what a room tells it (`RoomServer`'s `list` hook).
import { describe, expect, it } from 'vitest'
import {
  answerRoomDirectory,
  parseRoomList,
  parseRoomListingPost,
  ROOM_DIRECTORY_MAX,
  ROOM_LIST_HOLD_MS,
  ROOM_LIST_MAX,
  RoomDirectory,
  type RoomListingPost,
  roomDirectoryOverFetch,
} from '@/net/room-directory'

const memory = () => {
  const store = new Map<string, unknown>()
  let alarm: number | null = null
  let now = 1_000_000
  return {
    host: {
      now: () => now,
      storage: {
        get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
        put: async <T>(k: string, v: T) => {
          store.set(k, structuredClone(v))
        },
        delete: async (k: string) => store.delete(k),
      },
      setAlarm: async (at: number | null) => {
        alarm = at
      },
    },
    store,
    alarm: () => alarm,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

const post = (room: string, at: number, over: Partial<RoomListingPost> = {}): RoomListingPost => ({
  room,
  mission: 'int_01_hoverJet',
  phase: 'lobby',
  players: 1,
  seats: 6,
  at,
  until: at + ROOM_LIST_HOLD_MS,
  ...over,
})

/** Seven characters of the code alphabet, distinct per `n`. */
const code = (n: number): string => {
  const a = '23456789BCDFGHJKMNPQRSTVWXYZ'
  let s = ''
  for (let i = 0, k = n; i < 7; i++, k = Math.floor(k / a.length)) s += a[k % a.length]
  return s
}

describe('the room directory (DEV-633)', () => {
  it('lists a posted room with nothing in it but its code, course, phase and seats', async () => {
    const m = memory()
    const dir = await RoomDirectory.load(m.host)
    expect(await dir.post(post('K7QX4MN', m.now()))).toBe(true)
    expect(dir.list()).toEqual({
      rooms: [
        { room: 'K7QX4MN', mission: 'int_01_hoverJet', phase: 'lobby', players: 1, seats: 6 },
      ],
    })
    // Nothing about people, and nothing anybody typed: the keys are exactly these.
    expect(Object.keys(dir.list().rooms[0] ?? {}).sort()).toEqual(
      ['mission', 'phase', 'players', 'room', 'seats'].sort(),
    )
  })

  it('drops a room that is unlisted, and forgets one that never says goodbye', async () => {
    const m = memory()
    const dir = await RoomDirectory.load(m.host)
    await dir.post(post('K7QX4MN', m.now()))
    await dir.post(post('BCDFGHJ', m.now()))
    await dir.drop('K7QX4MN')
    expect(dir.list().rooms.map((r) => r.room)).toEqual(['BCDFGHJ'])
    expect(m.alarm(), 'an alarm while anything is held').toBe(m.now() + ROOM_LIST_HOLD_MS)
    m.advance(ROOM_LIST_HOLD_MS)
    await dir.onAlarm()
    expect(dir.list().rooms).toEqual([])
    expect(m.store.size, 'and storage is empty again').toBe(0)
    expect(m.alarm()).toBeNull()
  })

  it('ignores an older post than the one it holds, and survives a reload', async () => {
    const m = memory()
    const dir = await RoomDirectory.load(m.host)
    await dir.post(post('K7QX4MN', m.now(), { players: 3 }))
    await dir.post(post('K7QX4MN', m.now() - 10, { players: 1 }))
    const again = await RoomDirectory.load(m.host)
    expect(again.list().rooms[0]?.players).toBe(3)
  })

  it('lists lobbies before races, at most ROOM_LIST_MAX, and holds at most ROOM_DIRECTORY_MAX', async () => {
    const m = memory()
    const dir = await RoomDirectory.load(m.host)
    await dir.post(post(code(0), m.now(), { phase: 'racing' }))
    m.advance(1)
    await dir.post(post(code(1), m.now()))
    expect(dir.list().rooms.map((r) => r.phase)).toEqual(['lobby', 'racing'])
    for (let i = 2; i < ROOM_DIRECTORY_MAX; i++) await dir.post(post(code(i), m.now()))
    expect(await dir.post(post(code(ROOM_DIRECTORY_MAX), m.now())), 'full').toBe(false)
    expect(dir.list().rooms).toHaveLength(ROOM_LIST_MAX)
  })

  it('never lists an empty room', async () => {
    const m = memory()
    const dir = await RoomDirectory.load(m.host)
    await dir.post(post('K7QX4MN', m.now(), { players: 0 }))
    expect(dir.list().rooms).toEqual([])
  })

  it('refuses a post that is not a short code, or carries anything malformed', () => {
    const ok = post('K7QX4MN', 5)
    expect(parseRoomListingPost(ok)).toEqual(ok)
    expect(parseRoomListingPost({ ...ok, room: 'abcdefghijklmnop' }), 'a long id').toBeNull()
    expect(parseRoomListingPost({ ...ok, room: 'rooms.directory' })).toBeNull()
    expect(parseRoomListingPost({ ...ok, mission: '<b>hi</b>' })).toBeNull()
    expect(parseRoomListingPost({ ...ok, players: 9, seats: 8 })).toBeNull()
    expect(parseRoomListingPost({ ...ok, phase: 'party' })).toBeNull()
    // The page's reader leaves out what it cannot read, and anything past the cap.
    expect(parseRoomList({ rooms: [ok, { room: 'x' }] })).toHaveLength(1)
    expect(parseRoomList('nope')).toEqual([])
  })

  it('answers its internal API through the same link a room and the Function use', async () => {
    const m = memory()
    const dir = await RoomDirectory.load(m.host)
    const link = roomDirectoryOverFetch((r) => answerRoomDirectory(dir, r))
    expect(await link.post(post('K7QX4MN', m.now()))).toBe(true)
    expect((await link.list()).rooms.map((r) => r.room)).toEqual(['K7QX4MN'])
    await link.drop('K7QX4MN')
    expect((await link.list()).rooms).toEqual([])
  })
})
