// src/net/room-lap.ts — a room lap, judged. DEV-390.
//
// plan/MULTIPLAYER.md §6.5. At the finish a client POSTs its recorded lap to
// `/api/room/<id>/lap`, the SAME body `/api/laps` takes plus its seat token.
// A Pages Function — deployed with the build that served the client, so the
// judge cannot drift from the game — runs `validateCompressedLap` against the
// room's course and rules and hands the verdict to the room over the `ROOMS`
// binding. The room trusts a verdict only from there: no socket message can
// carry one. A refused lap is listed with its refusal's stage and no time.
//
// `functions/api/room/[id]/lap.ts` is a shell over `judgeRoomLap`; the link to
// the room is `room-link.ts` (a `stub.fetch` to the object's binding-only
// internal API), and a test hands in a link straight to a `RoomServer`.
//
// SERVER-SAFE: web platform only, no DOM, no three, no clock.

import { fromBase64url } from './base64url'
import { roomDonor } from './course-donors'
import { json, readCapped } from './http'
import { LAP_COURSES, type LapCourses } from './lap-courses'
import { LAP_BODY_MAX } from './lap-policy'
import { validateCompressedLap } from './lap-validate'
import { asLapCourses, roomCourseFromToken } from './room-course'
import type { RoomJudgeLink } from './room-link'
import { type RoomSeat, type RoomVerdict, SEAT_SHAPE } from './room-protocol'

export type { RoomJudgeLink, RoomSeat }

/** The stage a lap flown in another race is refused at: the room's own check. */
export const ROOM_LAP_STAGE = 'room'

/** Player courses built this isolate, by token: every lap of a race needs the same one. */
const built = new Map<string, LapCourses>()
/** The most kept at once; a room races one course, an isolate serves a few rooms. */
const BUILT_MAX = 16

/** DEV-851: a race's player course as a one-entry `LapCourses`, or an empty one when it does not build. */
const playerCourses = async (token: string, mission: string): Promise<LapCourses> => {
  const key = `${mission} ${token}`
  const hit = built.get(key)
  if (hit) return hit
  const result = await roomCourseFromToken(token, mission, roomDonor)
  const courses: LapCourses = result.ok
    ? asLapCourses(result.course)
    : { ...LAP_COURSES, courses: {} }
  if (built.size >= BUILT_MAX) built.delete(built.keys().next().value as string)
  built.set(key, courses)
  return courses
}

interface Body {
  readonly lap: string
  readonly seconds: number
  readonly seat: string
  readonly tainted: boolean
}

const parse = (text: string): Body | string => {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return 'not JSON'
  }
  if (typeof v !== 'object' || v === null) return 'not an object'
  const { lap, seconds, seat, tainted } = v as Record<string, unknown>
  if (typeof lap !== 'string' || lap.length === 0) return '`lap` is missing'
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '`seconds` is not a time'
  }
  if (typeof seat !== 'string' || !SEAT_SHAPE.test(seat)) return '`seat` is not a seat token'
  if (tainted !== undefined && typeof tainted !== 'boolean') return '`tainted` is not a flag'
  return { lap, seconds, seat, tainted: tainted === true }
}

/**
 * `POST /api/room/<id>/lap` with `{ lap, seconds, seat, tainted }`.
 *
 * 200 `{ verdict }` when the room took it; 409 if the seat already had one;
 * 403 for a token the room does not know (or a race not yet released); 400,
 * 413 and 503 as the lap server answers them. A lap the validator REFUSES is
 * still a 200: the refusal is the verdict, and the room lists it (§6.5).
 */
export const judgeRoomLap = async (
  request: Request,
  link: RoomJudgeLink | null,
  shipped: LapCourses = LAP_COURSES,
): Promise<Response> => {
  if (!link) return json(503, { error: 'off', reason: 'rooms are not configured here' })
  const text = await readCapped(request, LAP_BODY_MAX)
  if (text === null) return json(413, { error: 'size', reason: `over ${LAP_BODY_MAX} bytes` })
  const body = parse(text)
  if (typeof body === 'string') return json(400, { error: 'body', reason: body })
  const seat = await link.seat(body.seat)
  if (!seat)
    return json(403, { error: 'seat', reason: 'no seat in a running race holds that token' })
  const compressed = fromBase64url(body.lap)
  if (!compressed) return json(400, { error: 'body', reason: '`lap` is not base64url text' })
  // DEV-851: a player's course is not in the generated file; the race carries
  // it, and the judge builds its entry with the code every client used. A
  // token that does not build leaves the judge no course, so the lap is
  // refused at the validator's own "no board" stage and listed as refused.
  const courses =
    seat.course === undefined ? shipped : await playerCourses(seat.course, seat.mission)

  // DEV-477: a room seat starts on ITS OWN start, and on no other — not even
  // the pad, unless the pad is its start. A seat the room gave no start (none
  // does since protocol 7) is judged as a solo lap: the pad or the respawn.
  const start = roomSeatStart(courses, seat)
  const judged = await validateCompressedLap(
    compressed,
    { seconds: body.seconds },
    courses,
    seat.start === undefined ? {} : { starts: start ? [start] : [] },
  )
  let verdict: RoomVerdict
  if (!judged.ok) {
    verdict = refused(seat, judged.stage, body.tainted)
  } else {
    // The lap must be of THIS race: its course, edition, and the rules its
    // variant flies here. A lap flown elsewhere is a valid lap and not a result.
    const d = judged.doc
    const mine =
      d.mission === seat.mission &&
      d.edition === seat.edition &&
      judged.variant === seat.variant &&
      d.rules === seat.rules
    verdict = mine
      ? {
          slot: seat.slot,
          verdict: 'ok',
          ticks: judged.score.ticks,
          seconds: judged.score.seconds,
          rings: judged.score.rings,
          ringsTotal: judged.score.ringsTotal,
          score2016: judged.score.score2016,
          tainted: body.tainted,
          variant: judged.variant,
        }
      : refused(seat, ROOM_LAP_STAGE, body.tainted)
  }
  const taken = await link.verdict(verdict)
  if (!taken) return json(409, { error: 'judged', reason: 'this seat already has a result' })
  if (verdict.verdict === 'ok') await link.keep(seat.slot, body.lap)
  return json(200, { verdict })
}

/**
 * DEV-477: where this seat's lap begins, SIM space — entry `seat.start` of the
 * course's start list for the room's edition (`LapEditionRules.rooms.starts`,
 * generated from `game/racer-grid.ts`'s `roomStarts`, the list every client
 * placed its ships from). Null when the room sent no start, or the course or
 * edition has no such entry (a forged or mismatched seat: the judge then
 * accepts no start at all but the respawn marker).
 */
export const roomSeatStart = (
  courses: LapCourses,
  seat: RoomSeat,
): readonly [number, number, number] | null => {
  if (seat.start === undefined || !Object.hasOwn(courses.courses, seat.mission)) return null
  const starts = courses.courses[seat.mission]?.editions[seat.edition]?.rooms?.starts
  return starts?.[seat.start] ?? null
}

const refused = (seat: RoomSeat, stage: string, tainted: boolean): RoomVerdict => ({
  slot: seat.slot,
  verdict: stage,
  ticks: null,
  seconds: null,
  rings: 0,
  ringsTotal: 0,
  score2016: null,
  tainted,
  variant: seat.variant,
})

/** `GET /api/room/<id>/lap?slot=<n>`: a judged lap to race, as `/api/laps?id=` hands one out. */
export const fetchRoomLap = async (
  request: Request,
  link: RoomJudgeLink | null,
): Promise<Response> => {
  if (!link) return json(503, { error: 'off', reason: 'rooms are not configured here' })
  const slot = Number(new URL(request.url).searchParams.get('slot'))
  if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
    return json(400, { error: 'slot', reason: '`slot` is not a seat number' })
  }
  const lap = await link.lap(slot)
  return lap === null
    ? json(404, { error: 'none', reason: 'no judged lap for that seat' })
    : json(200, { slot, lap })
}
