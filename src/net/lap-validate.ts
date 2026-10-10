// src/net/lap-validate.ts — is this lap one somebody could have flown?
//
// DEV-372, `docs/plan/PLAYER-GHOSTS.md` §5. The pure half of the lap server:
// bytes in, a verdict out. No D1, no request, no clock, no DOM, no three —
// `functions/api/laps.ts` is a thin shell over `src/net/lap-server.ts`, which
// is a thin shell over this, and all of it runs in node under vitest.
//
// ── The pipeline, in §5's order ───────────────────────────────────────────
//
//   1. SIZE        ≤ 64 KB deflated; inflated through a cap, so a zip bomb
//                  stops at `LAP_INFLATED_MAX` whatever its ratio
//   2. DECODE      `lapFromBytes`: magic, varints, ascending ticks, int16,
//                  a `keyCount` its bytes could hold (DEV-370)
//   3. COURSE      the mission has a board, the mode is Ring Attack, the
//                  edition is known, the aircraft VARIANT is one that edition
//                  flies (DEV-380; Classic: standard only), and the lap's
//                  `rules` is that variant's current one; `keyCount` and the
//                  last tick fit the time limit. The variant's own ceiling is
//                  the one stages 6 and 7 judge by
//   4. SCORE       `scoreGhost` — the game's own scorer — times the lap from
//                  its poses. A claimed time is never used, only compared
//   5. RINGS       every ring, in order, or the lap is not a BOARD lap (call 3:
//                  it can still be raced from its link)
//   6. CONTINUITY  a jump only at a tick marked `reset`, one tick long, and
//                  only onto the respawn marker or BACK down the course line
//   7. SPEED       no window faster than the chain-aware terminal (§3.4)
//   8. START       tick 0 at the release point (or the respawn marker, which
//                  is where a boundary death restarts the run); a room's
//                  judge names the seat's own start instead of the release
//                  (DEV-477)
//
// Continuity runs before speed, where §5 lists them the other way round. The
// verdict is the same either way — both must pass — but a teleport is also a
// speed of kilometres a second, and checked in §5's order it would be reported
// as a speeding lap. The chain-free test first makes the reason name the cause.
//
// ── What it cannot know (§3.5) ────────────────────────────────────────────
//
// That a human flew it; that it did not go through terrain; Anniversary's
// proximity bonus. The board ranks by what is recomputed here: rings, then time.

import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { type CourseLine, crashLimitS, resetLineFor } from '@/sim/crash'
import {
  decodeGhostClip,
  GHOST_STRIDE,
  type GhostClip,
  type GhostCourse,
  type GhostResult,
  type LapDoc,
  scoreGhost,
} from '@/sim/ghost'
import { lapFromBytes } from '@/sim/ghost-record'
import { routeArcLengthNearWithin, routeAt, routeTangentAt } from '@/sim/route'
import { terminalSpeed } from '@/sim/speed-chain'
import { drainCapped } from './http'
import {
  LAP_COURSES,
  LAP_MODE,
  type LapCeiling,
  type LapCourse,
  type LapCourses,
  type LapEditionRules,
  type LapVariantRules,
  parseLapVehicle,
  type Vec3Tuple,
} from './lap-courses'
import {
  LAP_CLAIM_TOLERANCE_TICKS,
  LAP_COMPRESSED_MAX,
  LAP_INFLATED_MAX,
  LAP_JUMP_SLACK_M,
  LAP_RESET_ARC_SLACK_M,
  LAP_RESET_LATERAL_SLACK_M,
  LAP_SPEED_MARGIN,
  LAP_SPEED_WINDOW_S,
  LAP_START_TOLERANCE_M,
  lapKeyCap,
} from './lap-policy'

export type LapStage =
  | 'size'
  | 'decode'
  | 'course'
  | 'rules'
  | 'score'
  | 'claimed'
  | 'continuity'
  | 'speed'
  | 'start'

/** What the server recomputed. Every field comes from the poses, none from the client. */
export interface LapScore {
  /** The finish tick, `seconds / FIXED_DT`. */
  readonly ticks: number
  /** MISSION seconds at the finish: `scoreGhost`'s, which is the live `finishAt`. */
  readonly seconds: number
  readonly rings: number
  readonly ringsTotal: number
  readonly distance: number
  readonly meanSpeed: number
  /** 2016's leaderboard number: ring points plus the time bonus. For display. */
  readonly score2016: number
}

export type LapVerdict =
  | { readonly ok: false; readonly stage: LapStage; readonly reason: string }
  | {
      readonly ok: true
      readonly doc: LapDoc
      /** The aircraft variant the lap was flown and judged in: its board's key. */
      readonly variant: string
      readonly score: LapScore
      /** May it hold a place on its board? False for a lap missing a ring, or out of order. */
      readonly board: boolean
      /** Why not, when `board` is false. */
      readonly boardReason: string | null
    }

/** A refusal, thrown inside the pipeline and caught once at its edge. */
class Refusal extends Error {
  constructor(
    readonly stage: LapStage,
    reason: string,
  ) {
    super(reason)
  }
}

// ── 1. Size ───────────────────────────────────────────────────────────────

/**
 * Inflate raw deflate, refusing past `cap` bytes of output.
 *
 * Streams, and stops at the cap: a 64 KB zip bomb is ~66 MB of zeros, and
 * reading it whole to measure it is the attack. `DecompressionStream` is the
 * web platform's, which a Worker and node 24 both have; `node:zlib` is not the
 * server's to import.
 */
export const inflateRawCapped = async (bytes: Uint8Array, cap: number): Promise<Uint8Array> => {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  // The write side settles on its own; its failure is the read side's failure,
  // reported there. Swallowed here so it is never an unhandled rejection.
  writer
    .write(new Uint8Array(bytes))
    .then(() => writer.close())
    .catch(() => {})
  let out: Uint8Array | null
  try {
    out = await drainCapped(stream.readable, cap)
  } catch {
    throw new Refusal('decode', 'the lap is not raw deflate')
  }
  if (out === null) throw new Refusal('size', `the lap inflates past ${cap} bytes`)
  return out
}

// ── 6 and 7: the track the plausibility checks read ───────────────────────

/**
 * A clip as the plausibility checks see it: key times (CLIP seconds), SIM-space
 * positions, and which keys were PLACED rather than flown to.
 */
export interface LapTrack {
  readonly count: number
  readonly times: Float64Array
  /** x, y, z per key, SIM space, absolute. */
  readonly pos: Float64Array
  /** 1 where key i is a `reset` placement, so segment (i-1, i) is a teleport. */
  readonly placed: Uint8Array
}

/**
 * The track of a clip. Positions go through the same flip `scoreGhost`'s
 * `place()` does — add the offset, then mirror z — so a distance here is a
 * distance there. A `reset` event whose tick holds no key is refused: the
 * recorder always keeps the key at an event (DEV-370), so a lap without one
 * was not recorded, it was written.
 */
export const trackOf = (
  clip: GhostClip,
  worldOffset: readonly [number, number, number],
): LapTrack => {
  const n = clip.keyCount
  const times = new Float64Array(n)
  const pos = new Float64Array(n * 3)
  const placed = new Uint8Array(n)
  const [ox, oy, oz] = worldOffset
  const d = clip.data
  const byTick = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const o = i * GHOST_STRIDE
    const t = d[o] as number
    times[i] = t
    pos[i * 3] = ox + (d[o + 1] as number)
    pos[i * 3 + 1] = oy + (d[o + 2] as number)
    pos[i * 3 + 2] = -(oz + (d[o + 3] as number))
    byTick.set(Math.round(t / FIXED_DT), i)
  }
  for (const e of clip.events) {
    if (e.kind !== 'reset') continue
    const i = byTick.get(e.tick)
    if (i === undefined || i === 0) {
      throw new Refusal('continuity', `a reset at tick ${e.tick} has no pose to be placed at`)
    }
    placed[i] = 1
  }
  return { count: n, times, pos, placed }
}

const dist = (p: Float64Array, i: number, j: number): number =>
  Math.hypot(
    (p[i * 3] as number) - (p[j * 3] as number),
    (p[i * 3 + 1] as number) - (p[j * 3 + 1] as number),
    (p[i * 3 + 2] as number) - (p[j * 3 + 2] as number),
  )

/**
 * The chain-aware ceiling, m/s, with `rings` banked (§3.4). Every ring adds
 * `increment` to `maxSpeed`; `terminalSpeed` is the sim's own equilibrium.
 * The chain's cooldown is IGNORED — a lap that dropped its chain is under a
 * ceiling that assumes it kept it — which makes this an upper bound.
 */
export const speedCeiling = (
  ceiling: LapCeiling,
  rings: number,
  margin = LAP_SPEED_MARGIN,
): number =>
  terminalSpeed(
    ceiling.maxSpeed + ceiling.increment * rings,
    ceiling.boostMultiplier,
    ceiling.mass,
    ceiling.drag,
  ) *
  (1 + margin)

/** Rings taken at or before `t`, from ring times sorted ascending. */
const ringsBy = (sorted: readonly number[], t: number): number => {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((sorted[mid] as number) <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The course line exactly as `boot/app.ts`'s `makeCrashLine` builds it: the
 * authored route when there is one, else the polyline through the gates from
 * the release point. It is `resetLineFor`, the one builder the client's guide
 * and crash line share, so the two cannot drift (code-reuse SG-1). The line
 * is `CourseLine`: the route and each gate's arc along it, for `crashLimitS`.
 *
 * `lap-courses.json` carries `route: null` unless the level's route has two
 * points or more, so `resetLineFor`'s own `> 1` test and the old truthiness
 * test pick the same branch on every course the server holds.
 */
export const resetLineOf = (course: LapCourse, gates: readonly Gate[]): CourseLine => {
  const [x, y, z] = course.release
  return resetLineFor(course.route, { x, y, z }, gates)
}

const _on = { x: 0, y: 0, z: 0 }
const _tan = { x: 0, y: 0, z: 0 }

/**
 * Is a placement from `from` to `to` a legal CRASH reset?
 *
 * The live rule (`sim/crash.ts`): project the crash onto the line, searching
 * only up to the gate being flown to (`crashLimitS` — `int_01` doubles back on
 * itself, twice), back off `resetBackMetres`, lift clear of the ground. So the
 * landing must project no further along than the crash did, and sit no further
 * off the line than the lift can put it. Before arc 0 the live reset carries on
 * down the line's own direction (DEV-289), so there the distance is to that ray.
 */
export const legalCrashReset = (
  line: CourseLine,
  rules: LapEditionRules,
  passed: readonly boolean[],
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): { ok: boolean; forward: number; lateral: number } => {
  const limit = crashLimitS(line.gateArc, passed, line.route.length)
  const hitS = routeArcLengthNearWithin(line.route, from, limit)
  const toS = routeArcLengthNearWithin(line.route, to, limit)
  let lateral: number
  if (toS > 1e-6) {
    routeAt(line.route, toS, _on)
    lateral = Math.hypot(to.x - _on.x, to.y - _on.y, to.z - _on.z)
  } else {
    routeAt(line.route, 0, _on)
    routeTangentAt(line.route, 0, _tan)
    const vx = to.x - _on.x
    const vy = to.y - _on.y
    const vz = to.z - _on.z
    const along = Math.min(0, vx * _tan.x + vy * _tan.y + vz * _tan.z)
    lateral = Math.hypot(vx - along * _tan.x, vy - along * _tan.y, vz - along * _tan.z)
  }
  const forward = toS - hitS
  return {
    ok:
      rules.crash.enabled &&
      forward <= LAP_RESET_ARC_SLACK_M &&
      lateral <= rules.crash.clearanceMetres + LAP_RESET_LATERAL_SLACK_M,
    forward,
    lateral,
  }
}

/**
 * Continuity: the ship is only ever somewhere it could have FLOWN to, or
 * somewhere the game PUT it.
 *
 * A flown segment may not cover more ground than the fastest the ship can go
 * at all (every ring banked, plus the margin) could in its duration, plus
 * `LAP_JUMP_SLACK_M` of rounding. A placed one must be one tick long and land
 * on the respawn marker, or be a legal crash reset (`legalCrashReset`).
 *
 * `ringTimes` are CLIP seconds, indexed by gate, null for a miss: which rings
 * were banked when a crash happened decides how far the reset may search.
 */
export const checkContinuity = (
  track: LapTrack,
  course: LapCourse,
  ceiling: LapCeiling,
  rules: LapEditionRules | null,
  gates: readonly Gate[],
  ringTimes: readonly (number | null)[],
): string | null => {
  const top = speedCeiling(ceiling, gates.length)
  let line: CourseLine | null = null
  const p = track.pos
  for (let i = 1; i < track.count; i++) {
    const span = (track.times[i] as number) - (track.times[i - 1] as number)
    const d = dist(p, i, i - 1)
    const tick = Math.round((track.times[i] as number) / FIXED_DT)
    if (track.placed[i] !== 1) {
      if (d > top * span + LAP_JUMP_SLACK_M) {
        return `a jump of ${d.toFixed(1)} m in ${(span * 1000).toFixed(1)} ms at tick ${tick}, which is not marked as a reset`
      }
      continue
    }
    if (Math.round(span / FIXED_DT) !== 1) {
      return `the reset at tick ${tick} does not follow the pose it replaced by one tick`
    }
    const to = { x: p[i * 3] as number, y: p[i * 3 + 1] as number, z: p[i * 3 + 2] as number }
    if (course.respawn) {
      const [rx, ry, rz] = course.respawn
      if (Math.hypot(to.x - rx, to.y - ry, to.z - rz) <= LAP_START_TOLERANCE_M) continue
    }
    if (!rules) return `the reset at tick ${tick} is not onto the respawn marker`
    const from = {
      x: p[(i - 1) * 3] as number,
      y: p[(i - 1) * 3 + 1] as number,
      z: p[(i - 1) * 3 + 2] as number,
    }
    const tFrom = track.times[i - 1] as number
    const passed = ringTimes.map((t) => t !== null && t <= tFrom)
    line ??= resetLineOf(course, gates)
    const reset = legalCrashReset(line, rules, passed, from, to)
    if (!reset.ok) {
      return rules.crash.enabled
        ? `the reset at tick ${tick} lands ${reset.forward.toFixed(1)} m along the course from the crash and ${reset.lateral.toFixed(1)} m off its line; a crash reset only goes back`
        : `the reset at tick ${tick} is not onto the respawn marker, and this edition has no crash reset`
    }
  }
  return null
}

/**
 * Speed: no stretch of the lap at least `LAP_SPEED_WINDOW_S` long averages
 * more than the chain-aware ceiling with the rings banked by its end.
 *
 * Path length over the window, not the chord, because the ship flies the path.
 * A window never spans a placement: the jump is not flight, and continuity
 * has already judged it.
 */
export const checkSpeed = (
  track: LapTrack,
  ceiling: LapCeiling,
  ringTimes: readonly (number | null)[],
  margin = LAP_SPEED_MARGIN,
): { reason: string | null; worstRatio: number } => {
  const sorted = ringTimes.filter((t): t is number => t !== null).sort((a, b) => a - b)
  const cum = new Float64Array(track.count)
  for (let i = 1; i < track.count; i++) {
    cum[i] = (cum[i - 1] as number) + (track.placed[i] === 1 ? 0 : dist(track.pos, i, i - 1))
  }
  let worstRatio = 0
  let reason: string | null = null
  let from = 0
  let j = 0
  for (let i = 1; i < track.count; i++) {
    if (track.placed[i] === 1) {
      from = i
      j = i
      continue
    }
    const ti = track.times[i] as number
    if (j < from) j = from
    while (j + 1 < i && ti - (track.times[j + 1] as number) >= LAP_SPEED_WINDOW_S) j++
    const span = ti - (track.times[j] as number)
    if (span < LAP_SPEED_WINDOW_S) continue
    const speed = ((cum[i] as number) - (cum[j] as number)) / span
    const rings = ringsBy(sorted, ti)
    const limit = speedCeiling(ceiling, rings, 0)
    const ratio = speed / limit
    if (ratio > worstRatio) worstRatio = ratio
    if (!reason && ratio > 1 + margin) {
      reason = `${speed.toFixed(1)} m/s over ${span.toFixed(2)} s ending at ${ti.toFixed(2)} s, with ${rings} ring(s) banked: the ceiling is ${(limit * (1 + margin)).toFixed(1)}`
    }
  }
  return { reason, worstRatio }
}

// ── The pipeline ──────────────────────────────────────────────────────────

/** The `GhostCourse` `scoreGhost` needs, from an artefact course. SIM-space gates. */
export const ghostCourseOf = (course: LapCourse): { gates: Gate[]; ghost: GhostCourse } => {
  const gates: Gate[] = course.gates.map((g) => ({
    centre: { x: g.centre[0], y: g.centre[1], z: g.centre[2] },
    radius: g.radius,
    points: g.points,
    triggerOnce: g.triggerOnce,
  }))
  return {
    gates,
    // A player's lap: tick 0 is the release, so no pad hold to skip and no
    // 2016 stagger — `startTime: 0`, exactly as `ghost-record.test.ts` scores one.
    ghost: { gates, finish: course.finish, worldOffset: course.worldOffset, startTime: 0 },
  }
}

export interface LapClaim {
  /** What the client's clock said. Compared, never used. */
  readonly seconds: number
}

/**
 * DEV-389: what a caller may change about the judging. The lap server passes
 * nothing: a solo lap starts at the release or the respawn marker.
 */
export interface LapJudging {
  /**
   * DEV-477: the legal first poses IN PLACE OF the release point, SIM space.
   * A room's judge passes the seat's own start (`room-lap.ts`) — the pad only
   * when the pad is that seat's — so a person cannot start from another's
   * start, the pad included. The respawn marker stays legal either way: a
   * boundary death restarts the run there.
   */
  readonly starts?: readonly Vec3Tuple[]
}

/**
 * Judge an INFLATED lap: steps 2 to 8.
 *
 * `claim` null skips the claim comparison (a caller with nothing to compare,
 * such as a test of the other stages); the server always passes one.
 */
export const validateLap = (
  raw: Uint8Array,
  claim: LapClaim | null,
  courses: LapCourses = LAP_COURSES,
  judging: LapJudging = {},
): LapVerdict => {
  try {
    // 2. DECODE
    let doc: LapDoc
    try {
      doc = lapFromBytes(raw)
    } catch (e) {
      throw new Refusal('decode', (e as Error).message)
    }

    // 3. COURSE, and the caps that need one
    if (!Object.hasOwn(courses.courses, doc.mission)) {
      throw new Refusal('course', `no board for mission ${JSON.stringify(doc.mission)}`)
    }
    const course = courses.courses[doc.mission] as LapCourse
    if (doc.mode !== LAP_MODE || course.mode !== LAP_MODE) {
      throw new Refusal(
        'course',
        `mode ${JSON.stringify(doc.mode)} has no board; only ${LAP_MODE} does`,
      )
    }
    // The aircraft variant is CHECKED, not trusted: it has to be one this
    // edition flies on this course, or there is no board and no ceiling to
    // judge it by. Classic's only variant is `standard`.
    const flown = parseLapVehicle(doc.vehicle)
    if (!flown) {
      throw new Refusal(
        'course',
        `vehicle ${JSON.stringify(doc.vehicle)} is not <vehicle>:<variant> (lapVehicle)`,
      )
    }
    if (flown.vehicle.toLowerCase() !== course.vehicle.toLowerCase()) {
      throw new Refusal(
        'course',
        `${doc.mission} is flown in the ${course.vehicle}, not the ${flown.vehicle}`,
      )
    }
    if (!Object.hasOwn(course.editions, doc.edition)) {
      throw new Refusal('course', `no edition ${JSON.stringify(doc.edition)}`)
    }
    const rules = course.editions[doc.edition] as LapEditionRules
    if (!Object.hasOwn(rules.variants, flown.variant)) {
      throw new Refusal(
        'course',
        `the ${course.vehicle} has no "${flown.variant}" variant on ${doc.edition}; it flies ${Object.keys(rules.variants).join(', ')}`,
      )
    }
    const variant = rules.variants[flown.variant] as LapVariantRules
    if (doc.rules !== variant.rules) {
      throw new Refusal(
        'rules',
        `rules ${JSON.stringify(doc.rules)} are not the current ${JSON.stringify(variant.rules)} for ${doc.mission} on ${doc.edition} in the ${flown.variant} ${course.vehicle}`,
      )
    }
    const cap = lapKeyCap(course.timeLimit)
    if (doc.keyCount > cap)
      throw new Refusal(
        'size',
        `${doc.keyCount} keys; a ${course.timeLimit} s lap holds at most ${cap}`,
      )
    const lastTick = doc.tick[doc.keyCount - 1] as number
    if (lastTick > cap - 1)
      throw new Refusal('size', `tick ${lastTick} is past the ${course.timeLimit} s time limit`)

    // 4. SCORE: the game's own scorer, from the poses alone.
    const clip = decodeGhostClip(doc)
    const { gates, ghost } = ghostCourseOf(course)
    const result: GhostResult = scoreGhost(clip, ghost, FIXED_DT, { ringTimes: true })
    if (result.seconds === null) throw new Refusal('score', 'the lap never crosses the finish')
    const ticks = Math.round(result.seconds / FIXED_DT)
    if (claim) {
      if (!Number.isFinite(claim.seconds))
        throw new Refusal('claimed', 'the claimed time is not a number')
      // In whole ticks: a claim of `finishAt + FIXED_DT` is one tick off, and
      // dividing the difference by `FIXED_DT` reads it as 1.0000000002.
      if (Math.abs(Math.round(claim.seconds / FIXED_DT) - ticks) > LAP_CLAIM_TOLERANCE_TICKS) {
        throw new Refusal(
          'claimed',
          `the lap claims ${claim.seconds.toFixed(3)} s and its poses finish at ${result.seconds.toFixed(3)} s`,
        )
      }
    }

    // 5. RINGS: every one, in order, or no board.
    const ringTimes = result.ringTimes ?? []
    let boardReason: string | null = null
    if (result.gates !== result.gatesTotal) {
      // DEV-571: short enough for the panel's row (`game/lap-ask.ts`), in its words.
      boardReason = `${result.gates} of ${result.gatesTotal} rings; ranked laps take all`
    } else {
      for (let g = 1; g < ringTimes.length; g++) {
        if ((ringTimes[g] as number) <= (ringTimes[g - 1] as number)) {
          boardReason = `ring ${g + 1} came before ring ${g}; out of order`
          break
        }
      }
    }

    // 6. CONTINUITY, then 7. SPEED. Ring times are mission seconds; for a
    // player's lap (no pad hold, no stagger) they are also clip seconds.
    let track: LapTrack
    try {
      track = trackOf(clip, course.worldOffset)
    } catch (e) {
      if (e instanceof Refusal) throw e
      throw new Refusal('continuity', (e as Error).message)
    }
    const jump = checkContinuity(track, course, variant.ceiling, rules, gates, ringTimes)
    if (jump) throw new Refusal('continuity', jump)
    const speed = checkSpeed(track, variant.ceiling, ringTimes)
    if (speed.reason) throw new Refusal('speed', speed.reason)

    // 8. START: tick 0, at the release point (a room seat: its own start) or
    // the respawn marker.
    if (doc.tick[0] !== 0)
      throw new Refusal(
        'start',
        `the lap starts at tick ${doc.tick[0]}, not at the release (tick 0)`,
      )
    const from = ([x, y, z]: readonly [number, number, number]): number =>
      Math.hypot(
        (track.pos[0] as number) - x,
        (track.pos[1] as number) - y,
        (track.pos[2] as number) - z,
      )
    const respawn = course.respawn ? from(course.respawn) : Number.POSITIVE_INFINITY
    // DEV-477: a room seat's own start, when its judge names one, IN PLACE OF
    // the release point: a person may not start from the pad unless it is
    // theirs. A solo lap (no `starts`) keeps the release.
    const seatStarts = judging.starts
    const release = seatStarts ? Number.POSITIVE_INFINITY : from(course.release)
    const own = (seatStarts ?? []).reduce((m, s) => Math.min(m, from(s)), Number.POSITIVE_INFINITY)
    if (Math.min(release, respawn, own) > LAP_START_TOLERANCE_M) {
      throw new Refusal(
        'start',
        (seatStarts
          ? Number.isFinite(own)
            ? `the first pose is ${own.toFixed(1)} m from the seat's start`
            : 'the seat has no start on this course'
          : `the first pose is ${release.toFixed(1)} m from the release point`) +
          (course.respawn ? ` and ${respawn.toFixed(1)} m from the respawn marker` : ''),
      )
    }

    const points = course.gates.reduce(
      (sum, g, i) => sum + (ringTimes[i] != null ? g.points : 0),
      0,
    )
    const spare = course.scoring.bonusParTime - result.seconds
    return {
      ok: true,
      doc,
      variant: flown.variant,
      score: {
        ticks,
        seconds: result.seconds,
        rings: result.gates,
        ringsTotal: result.gatesTotal,
        distance: result.distance,
        meanSpeed: result.meanSpeed,
        score2016:
          points + (spare > 0 ? Math.round(course.scoring.timeBonusMultiplier * spare) : 0),
      },
      board: boardReason === null,
      boardReason,
    }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, stage: e.stage, reason: e.message }
    throw e
  }
}

/**
 * Judge a DEFLATED lap: step 1, then `validateLap`. What the server calls.
 */
export const validateCompressedLap = async (
  compressed: Uint8Array,
  claim: LapClaim | null,
  courses: LapCourses = LAP_COURSES,
  judging: LapJudging = {},
): Promise<LapVerdict> => {
  if (compressed.byteLength > LAP_COMPRESSED_MAX) {
    return {
      ok: false,
      stage: 'size',
      reason: `${compressed.byteLength} deflated bytes; the cap is ${LAP_COMPRESSED_MAX}`,
    }
  }
  let raw: Uint8Array
  try {
    raw = await inflateRawCapped(compressed, LAP_INFLATED_MAX)
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, stage: e.stage, reason: e.message }
    throw e
  }
  return validateLap(raw, claim, courses, judging)
}
