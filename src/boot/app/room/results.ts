// src/boot/app/room/results.ts: a room race's result and the live place, out of
// `bootApp`. APP-SPLIT phase 4, slice 3 (room; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-390's block, whole: the judged lap posted at the finish (§6.5), the
// panel's room standings, the live place, and the race map's room field. Every
// line below was moved verbatim from the closure; the plumbing is `ctx.x` where
// the code reads a binding the closure still owns (a getter, and a setter where
// this code writes one: the §6 rule 3 bag), and the returned object.

import type { RacingGuide } from '@/game/course-specs'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { LapRun } from '@/game/lap-run'
import type { MissionState } from '@/game/mission'
import type { RaceLine, RacerPlaceReading } from '@/game/race-place'
import type { RacerStart } from '@/game/racer-grid'
import { type RemoteShips, roomColourCss } from '@/game/remote-ships'
import type { RoomClient, RoomProbe } from '@/game/room-client'
import {
  roomBotStandings,
  roomOpponents,
  roomPlaceReadings,
  roomRaceSlots,
  roomRun,
} from '@/game/room-results'
import { taintedInRoom } from '@/game/run-taint'
import { submitRoomLap } from '@/net/lap-client'
import type { RoomRace } from '@/net/room-protocol'
import type { OpponentStanding, RunSummary } from '@/render/results'
import { FIXED_DT } from '@/sim/constants'

/** What `createRoomResults` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface RoomResultsCtx {
  readonly editionState: EditionState
  readonly flight: Flight | null
  readonly guide: RacingGuide | null
  readonly lastResult: RunSummary | null
  readonly mission: MissionState
  readonly room: RoomClient | null
  readonly roomBots: () => { starts: RacerStart[]; names: string[] }
  readonly roomId: string | null
  readonly roomShips: RemoteShips | null
}

export const createRoomResults = (ctx: RoomResultsCtx) => {
  // ── DEV-390: the race's result, and the live place ─────────────────────
  //
  // The result is the JUDGED lap (§6.5): at the finish this client posts its
  // recorded lap to `/api/room/<id>/lap`, the Function that served this build
  // rescores it and hands the verdict to the room, and the room's `results`
  // are what every panel in it reads (`game/room-results.ts`). The live place
  // measures the others as the racers are measured (`race-place.ts`), and the
  // race map draws them in their colours. A room lap is tainted `room` on
  // purpose (`run-taint.ts`, §11 call 10): off the solo boards, still placed.
  const roomRingsSent: boolean[] = []
  let roomFinishSent = false
  let roomPostDue = false
  let roomPosted: RoomProbe['posted'] = null

  const roomPostLap = async (lap: NonNullable<LapRun['last']>): Promise<void> => {
    const s = ctx.room?.session
    if (!s || !ctx.roomId || s.seat === null || lap.seconds === null) return
    roomPosted = { verdict: null, status: 0, error: null }
    const answer = await submitRoomLap({
      room: ctx.roomId,
      doc: lap.doc,
      seconds: lap.seconds,
      seat: s.seat,
      tainted: taintedInRoom(lap.reasons),
    })
    roomPosted = answer.ok
      ? { verdict: answer.verdict, status: 200, error: null }
      : { verdict: null, status: answer.status, error: `${answer.error}: ${answer.reason}` }
    console.info(
      answer.ok
        ? `room: lap judged — ${answer.verdict}`
        : `room: lap not judged (${answer.status} ${answer.error}): ${answer.reason}`,
    )
  }

  /** The panel's run as the room judged it. Outside a room, unchanged. */
  const roomPanelRun = (run: RunSummary): RunSummary =>
    ctx.room ? roomRun(run, ctx.room.session) : run
  /** The other players on the panel, or nobody outside a room. */
  const roomPanelOpponents = (): OpponentStanding[] =>
    ctx.room
      ? [
          ...roomOpponents(ctx.room.session),
          // DEV-391: the bots, as the room lists them — on the host's panel too,
          // so every panel in the room reads one list.
          ...roomBotStandings(
            ctx.room.session.race,
            ctx.room.session.bots,
            ctx.roomBots().names,
            FIXED_DT,
          ),
        ]
      : []
  /** The live place's other entrants: the room's players along `line`. */
  const roomPlaceOthers = (line: RaceLine): RacerPlaceReading[] =>
    ctx.room && ctx.roomShips
      ? roomPlaceReadings(
          ctx.room.session,
          ctx.roomShips.drawn(),
          line,
          // DEV-885: the bots this page draws, so a guest counts the field the owner does.
          roomBotStandings(
            ctx.room.session.race,
            ctx.room.session.bots,
            ctx.roomBots().names,
            FIXED_DT,
          ),
        )
      : []
  /** The rows the results panel last DREW, for the probe; null while it is down. */
  const roomStandingsNow = (): RoomProbe['standings'] => {
    const drawn = ctx.lastResult ? ctx.flight?.results.drawn : null
    return drawn
      ? drawn.standings.map((r) => ({
          name: r.name,
          you: r.you,
          ai: r.ai === true,
          status: r.status,
          seconds: r.seconds,
          place: r.place,
        }))
      : null
  }

  /**
   * The race map's field in a room: the other players, on the app's guide, in
   * their colours. The same object for the whole race, so the map is built once.
   */
  let roomMap: {
    readonly race: RoomRace
    readonly line: RaceLine
    readonly finish: { x: number; y: number; z: number } | null
    readonly colours: string[]
    readonly slots: number[]
  } | null = null
  const roomMapField = (): typeof roomMap => {
    const s = ctx.room?.session
    const race = s?.race
    if (!s || !race || !ctx.guide) return null
    if (roomMap?.race === race && roomMap.line === ctx.guide) return roomMap
    const slots = roomRaceSlots(s).filter((slot) => slot !== s.slot)
    const livery = ctx.editionState.current.render.racerLivery
    roomMap = {
      race,
      line: ctx.guide,
      finish: ctx.mission.finishGate,
      colours: slots.map((slot) => roomColourCss(livery, race.colours[slot] ?? 0)),
      slots,
    }
    return roomMap
  }
  const roomDots: { x: number; z: number }[] = []
  /** The map's dots, the field's order: a ship not drawn yet sits on the player's own dot. */
  const roomMapDots = (player: { x: number; z: number }): readonly { x: number; z: number }[] => {
    roomDots.length = 0
    if (!roomMap || !ctx.roomShips) return roomDots
    const drawn = ctx.roomShips.drawn()
    for (const slot of roomMap.slots) {
      const d = drawn.find((x) => x.slot === slot)
      roomDots.push(d?.drawn ? d.position : player)
    }
    return roomDots
  }
  return {
    roomRingsSent,
    roomPostLap,
    roomStandingsNow,
    roomMapField,
    roomPanelRun,
    roomPanelOpponents,
    roomMapDots,
    roomPlaceOthers,
    get roomFinishSent() {
      return roomFinishSent
    },
    set roomFinishSent(v: boolean) {
      roomFinishSent = v
    },
    get roomPostDue() {
      return roomPostDue
    },
    set roomPostDue(v: boolean) {
      roomPostDue = v
    },
    get roomPosted() {
      return roomPosted
    },
    set roomPosted(v: RoomProbe['posted']) {
      roomPosted = v
    },
    get roomMap() {
      return roomMap
    },
    set roomMap(v: {
      readonly race: RoomRace
      readonly line: RaceLine
      readonly finish: { x: number; y: number; z: number } | null
      readonly colours: string[]
      readonly slots: number[]
    } | null) {
      roomMap = v
    },
  }
}
