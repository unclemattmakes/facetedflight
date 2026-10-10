// src/net/room-link.ts — the judge's line to a room, over the binding. DEV-390.
//
// The Pages Function that judges a lap (`room-lap.ts`) reaches the room's
// Durable Object through the `ROOMS` binding with `stub.fetch`, on a small
// internal API the object answers in `onRequest`. Nothing outside can reach it:
// both public routes (`room-route.ts`, and the Worker's own `fetch`) forward a
// WebSocket upgrade and answer anything else 426 without forwarding, so a
// request that arrives at `onRequest` came from code holding the binding. That
// is what lets the room believe a verdict (§6.5).
//
// `stub.fetch` rather than a DO RPC method: the Function and the Worker are two
// scripts with two compatibility dates, and fetch is the one interface both
// ends certainly share. `roomLinkOverFetch` is the Function's half and
// `answerRoomLink` the object's; `tests/unit/room-lap.test.ts` joins them with
// a real `Request` and `Response`.
//
// SERVER-SAFE and pure.

import { fieldOrNull, noBody, postJson, takenOr409 } from './do-link'
import type { RoomSeat, RoomVerdict } from './room-protocol'

/** The judge's side of the binding. */
export interface RoomJudgeLink {
  /** The seat this token holds in a released race with no verdict yet, or null. */
  seat(token: string): Promise<RoomSeat | null>
  /** Hand the room a verdict. False if the seat already had one. */
  verdict(v: RoomVerdict): Promise<boolean>
  /** Keep the lap's wire text for "race this lap" (§6.5). */
  keep(slot: number, lap: string): Promise<void>
  /** A kept lap's wire text, or null. */
  lap(slot: number): Promise<string | null>
}

/** The object's internal paths. Any host: the URL never leaves the binding. */
export const ROOM_LINK = {
  seat: 'https://room.internal/seat',
  verdict: 'https://room.internal/verdict',
  keep: 'https://room.internal/keep',
  lap: 'https://room.internal/lap',
  /** DEV-479: WATCH ME — the room's TV id, minted at first need (plan/FF-TV.md §2.6). */
  tv: 'https://room.internal/tv',
} as const

/** What the object's internal API is answered by: `RoomServer`'s judge half. */
export interface RoomLinkTarget {
  seatInfo(token: string): RoomSeat | null
  verdict(v: RoomVerdict): Promise<boolean>
  keepLap(slot: number, lap: string): Promise<void>
  keptLap(slot: number): Promise<string | null>
  /** DEV-479: the room's TV id, minted if it has none; null where nobody is in the room. */
  tvId(): Promise<string | null>
}

/** A stub's `fetch`, with the room's name carried for partyserver. */
export type RoomFetch = (request: Request) => Promise<Response>

export const roomLinkOverFetch = (fetchRoom: RoomFetch): RoomJudgeLink => {
  const post = (url: string, body: unknown) => postJson(fetchRoom, url, body)
  return {
    seat: async (token) => {
      const r = await post(ROOM_LINK.seat, { token })
      return r.ok ? ((await r.json()) as RoomSeat) : null
    },
    verdict: async (v) => (await post(ROOM_LINK.verdict, v)).ok,
    keep: async (slot, lap) => {
      await post(ROOM_LINK.keep, { slot, lap })
    },
    lap: async (slot) => {
      const r = await fetchRoom(new Request(`${ROOM_LINK.lap}?slot=${slot}`))
      return fieldOrNull<string>(r, 'lap')
    },
  }
}

/**
 * DEV-479: WATCH ME's side of the binding (plan/FF-TV.md §2.6). A separate
 * link from the judge's: the TV id is asked for by a player who holds the
 * room's code, and the judge's four calls stay exactly what they were.
 */
export interface RoomTvLink {
  /** The room's TV id, minted at first need; null where there is no such room. */
  tv(): Promise<string | null>
}

export const roomTvLinkOverFetch = (fetchRoom: RoomFetch): RoomTvLink => ({
  tv: async () => {
    const r = await fetchRoom(new Request(ROOM_LINK.tv))
    return fieldOrNull<string>(r, 'tv')
  },
})

/** The object's side: answer one internal request, or 404. */
export const answerRoomLink = async (
  target: RoomLinkTarget,
  request: Request,
): Promise<Response> => {
  const url = new URL(request.url)
  const path = `${url.origin}${url.pathname}`
  try {
    if (request.method === 'POST' && path === ROOM_LINK.seat) {
      const { token } = (await request.json()) as { token: string }
      const seat = typeof token === 'string' ? target.seatInfo(token) : null
      return seat ? Response.json(seat) : noBody(404)
    }
    if (request.method === 'POST' && path === ROOM_LINK.verdict) {
      const v = (await request.json()) as RoomVerdict
      return takenOr409(await target.verdict(v))
    }
    if (request.method === 'POST' && path === ROOM_LINK.keep) {
      const { slot, lap } = (await request.json()) as { slot: number; lap: string }
      await target.keepLap(slot, lap)
      return noBody(204)
    }
    if (request.method === 'GET' && path === ROOM_LINK.tv) {
      const tv = await target.tvId()
      return tv === null ? noBody(404) : Response.json({ tv })
    }
    if (request.method === 'GET' && path === ROOM_LINK.lap) {
      const lap = await target.keptLap(Number(url.searchParams.get('slot')))
      return lap === null ? noBody(404) : Response.json({ lap })
    }
  } catch {
    return noBody(400)
  }
  return noBody(404)
}
