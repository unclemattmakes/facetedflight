// src/game/room-results.ts — a room's race on the results panel, and in the air. DEV-390.
//
// plan/MULTIPLAYER.md §6.5: a room's result is each player's JUDGED lap — its
// ticks from their own GO, rescored by the Pages Function that served the
// build — never an order anybody's screen saw. This turns the room's verdicts
// into the panel's own currency (`OpponentStanding`), so `withStandings` places
// a room exactly as it places racers: a dead heat (one tick, 12.2 ms) shares a
// place (§11 call 5), a DNF takes none, somebody still flying is behind you.
//
// What each row carries beyond a time goes into its NAME, so the panel draws
// it with no change of its own: the aircraft variant beside the name when it is
// not the standard jet (§11 call 7), `assisted` for a tainted run (§11 call 6:
// placed, marked, never boarded), and a refused lap's stage.
//
// ── The live place (`race-place.ts`, DEV-361) across people ──────────────
//
// In the air, a remote player is measured as a racer is: the furthest gate
// reached, then metres along the racing line, searched on the leg being flown.
// Its gates come from the room's relayed ring events and its position from the
// DRAWN ship, and the two are read at the SAME tick: a ring event arrives the
// moment its sender takes the ring, while the ship is drawn a render delay
// behind (26–154 m, DEV-387), so counting every ring heard would put a gate
// ahead of the hull that has not yet flown it. `roomPassedAt` counts the rings
// taken at or before the drawn tick. That, and `raceProgress`'s one-leg search
// window, is the teleport guard: a crash reset cuts the track (`reset`) and
// the ship jumps back to the line, but the window is bounded by the gates it
// had reached, so a jump cannot land it on another leg.
//
// Pure: plain values in, plain values out.

import { type RaceLine, type RacerPlaceReading, raceProgress } from '@/game/race-place'
import { drawnHandle } from '@/game/room-names'
import type { RoomBotFinish, RoomPlayerView, RoomRace, RoomVerdict } from '@/net/room-protocol'
import type { OpponentStanding, RunSummary } from '@/render/results'
import type { Vec3 } from '@/sim/math/vec3'
import { advanceRoute, createRouteCursor, type RouteCursor } from '@/sim/route'

/** The verdicts that are not a validator's refusal: no time, no fault. */
export const ROOM_DNF = { time: 'dnf', left: 'left' } as const

export interface RoomStandingInput {
  readonly slot: number | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  readonly race: RoomRace | null
  readonly results: readonly RoomVerdict[]
}

/** A player's label: the handle, the variant if not standard, and a taint mark. */
export const roomLabel = (handle: string, variant: string, tainted: boolean): string =>
  [handle, variant !== 'standard' ? variant : null, tainted ? 'assisted' : null]
    .filter((s): s is string => s !== null)
    .join(' · ')

/** The slots racing in this room's race, this client's included, in seat order. */
export const roomRaceSlots = (room: RoomStandingInput): number[] =>
  room.race ? Object.keys(room.race.starts).map(Number) : []

/** One other player's standing, as the panel places it: their verdict, or still flying. */
export const roomStandingOf = (room: RoomStandingInput, slot: number): OpponentStanding => {
  const p = room.players[slot]
  const r = room.results.find((x) => x.slot === slot)
  // DEV-485: the list's handle, or Racer N, never a hand-made client's free text.
  const handle = drawnHandle(p?.handle, slot)
  const variant = r?.variant ?? p?.variant ?? 'standard'
  const name = roomLabel(handle, variant, r?.tainted ?? false)
  if (!r) return { name, seconds: null, status: 'flying' }
  if (r.verdict === 'ok' && r.seconds !== null) {
    return { name, seconds: r.seconds, status: 'finished' }
  }
  if (r.verdict === ROOM_DNF.time || r.verdict === ROOM_DNF.left) {
    return { name, seconds: null, status: 'dnf' }
  }
  return { name: `${name} · refused (${r.verdict})`, seconds: null, status: 'dnf' }
}

/** Everybody in the race but this client, as the panel places them. */
export const roomOpponents = (room: RoomStandingInput): OpponentStanding[] =>
  roomRaceSlots(room)
    .filter((slot) => slot !== room.slot)
    .map((slot) => roomStandingOf(room, slot))

/**
 * DEV-391: the room's bots on the panel (§6.6). Named by the tuning each
 * flies (`names`, the host's `assignTunings`) and tagged AI (DEV-854); timed by
 * their HOST's ticks from its own GO, which every client placed against its
 * judged humans. Not judged — a private room of friends gains nothing by its
 * host lying about its own bots — so a bot with no `finish` yet is flying,
 * and one the host never reports stays so.
 */
export const roomBotStandings = (
  race: RoomRace | null,
  finishes: readonly RoomBotFinish[],
  names: readonly string[],
  dt: number,
): OpponentStanding[] =>
  (race?.bots ?? []).map((b) => {
    // DEV-854: a bot is an AI, and the board's tag says so; the name carries no suffix.
    const name = names[b.index] ?? `bot ${b.index + 1}`
    const f = finishes.find((x) => x.bot === b.index)
    return f
      ? { name, seconds: f.tick * dt, status: 'finished', ai: true }
      : { name, seconds: null, status: 'flying', ai: true }
  })

/**
 * The judged laps' seats in finishing order: by TICKS, then seat on a dead
 * heat — never by the order the verdicts reached the room, which is the order
 * the links delivered them (§5.2: a result is a time, not an arrival).
 */
export const roomFinishOrder = (results: readonly RoomVerdict[]): number[] =>
  results
    .filter((r) => r.verdict === 'ok' && r.ticks !== null)
    .sort((a, b) => (a.ticks as number) - (b.ticks as number) || a.slot - b.slot)
    .map((r) => r.slot)

/**
 * This client's own run as the ROOM judged it. Once its verdict lands, the
 * panel's time is the JUDGE's (so every browser in the room prints one number
 * for it), and a lap the judge refused is no time at all, whatever the live
 * clock said. Until then the live time stands, which is what the judge will
 * say for an honest lap (`scoreGhost`'s seconds are the live `finishAt`,
 * DEV-370).
 */
export const roomRun = (run: RunSummary, room: RoomStandingInput): RunSummary => {
  const mine = room.results.find((r) => r.slot === room.slot)
  if (!mine) return run
  return { ...run, finishedAt: mine.verdict === 'ok' ? mine.seconds : null }
}

// ── In the air ──────────────────────────────────────────────────────────────

/** One remote ship as drawn this frame (`game/remote-ships.ts` writes these). */
export interface RoomDrawnRacer {
  readonly slot: number
  /** Its palette index (§6.4), for the race map's dot. */
  readonly colour: number
  /** The shared tick it is drawn at, or null before its GO. */
  tick: number | null
  /** SIM space, like the player's body. Meaningful only while `drawn`. */
  readonly position: { x: number; y: number; z: number }
  drawn: boolean
}

/**
 * Which gates a remote racer had taken at tick `at`, into `out`, sized to the
 * course: a ring counts only once the drawn ship has flown it (see the header).
 */
export const roomPassedAt = (
  ringTicks: readonly number[] | undefined,
  at: number | null,
  gates: number,
  out: boolean[],
): boolean[] => {
  out.length = gates
  for (let g = 0; g < gates; g++) {
    const t = ringTicks?.[g]
    out[g] = at !== null && t !== undefined && t <= at
  }
  return out
}

/** How many route segments a bot's cursor may advance in one frame: a crash reset jumps a bot back, and a wide window would find the line's other leg. */
const BOT_CURSOR_WINDOW = 8
/** A bot's forward-only cursor along the line, per race (DEV-885). */
const botCursors = new WeakMap<RoomRace, Map<number, RouteCursor>>()
const botCursor = (race: RoomRace, slot: number): RouteCursor => {
  const byBot = botCursors.get(race) ?? new Map<number, RouteCursor>()
  botCursors.set(race, byBot)
  const c = byBot.get(slot) ?? createRouteCursor()
  byBot.set(slot, c)
  return c
}

/** Volatile: one scratch `passed` per call of `roomPlaceReadings`. */
const _passed: boolean[] = []

/**
 * Every other racer in the room as the live place reads one: its standing (the
 * panel's, so the HUD and the panel agree at the line) and its progress along
 * `line`. A ship not drawn yet is at the start: before the release there is no
 * place anyway (DEV-361).
 */
export const roomPlaceReadings = (
  room: RoomStandingInput & { readonly ringTicks: Readonly<Record<number, readonly number[]>> },
  drawn: readonly RoomDrawnRacer[],
  line: RaceLine,
  bots: readonly OpponentStanding[] = [],
): RacerPlaceReading[] => {
  const out: RacerPlaceReading[] = []
  const gates = line.gateArc.length
  // DEV-885: the bots a page DRAWS (every page but the owner's, which flies them
  // and reads them from its own racers), so a guest places itself in the same
  // field the owner does. A bot sends no ring events, so its gates are read off
  // its position: a cursor that only moves forward along the line, and a gate
  // is taken once the cursor is past its arc (the AI turns back for a miss).
  for (const d of drawn) {
    if (d.slot >= 0) continue
    const standing = bots[-1 - d.slot]
    if (!standing) continue
    if (!d.drawn || !room.race) {
      out.push({ standing, progress: { reached: 0, arc: 0 } })
      continue
    }
    const cursor = botCursor(room.race, d.slot)
    advanceRoute(line.route, cursor, d.position as Vec3, BOT_CURSOR_WINDOW)
    let reached = 0
    while (reached < gates && (line.gateArc[reached] as number) <= cursor.s) reached += 1
    out.push({ standing, progress: { reached, arc: cursor.s } })
  }
  for (const slot of roomRaceSlots(room)) {
    if (slot === room.slot) continue
    const ship = drawn.find((d) => d.slot === slot)
    const standing = roomStandingOf(room, slot)
    if (!ship?.drawn) {
      out.push({ standing, progress: { reached: 0, arc: 0 } })
      continue
    }
    const passed = roomPassedAt(room.ringTicks[slot], ship.tick, gates, _passed)
    out.push({ standing, progress: raceProgress(line, passed, ship.position as Vec3) })
  }
  return out
}
