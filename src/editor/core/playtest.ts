// src/editor/core/playtest.ts — the playtest contract. DEV-468, E2.
//
// An INTERFACE, not an implementation (docs/plan/EDITOR-DISPATCH.md). DEV-469
// implements `PlaytestHost` with `switchMission` in `boot/app.ts`; this file
// owns what goes in and what comes back, and the pure rules on both sides:
//
//   playtestLevel(course, donor, fromT)  the level to fly: the course expanded,
//                                        from its pad (`fromT` null, DEV-475),
//                                        or started at `fromT` along the line
//                                        ("fly from here")
//   PlaytestHost.playtest(request)       the front-end's side: fly it, then
//   onReturn(draft, result)              …hand back the lap, which records the
//                                        AUTHOR LAP when it qualifies
//   authorParTime(lap, timeLimit)        the PROPOSED par rule (a Matt call)
//
// ── The author lap ───────────────────────────────────────────────────────
//
// EDITOR.md §5.3 step 5: *"A clean finished test lap from the start is the
// author lap: it proves the course."* So a lap qualifies when it was flown from
// the course's own start (its pad, DEV-475), crossed the finish, and took every ring, on the
// course as it stands (the id it was flown on is the draft's id now). The best
// such lap is kept. It proves the course flyable; medals do NOT come from it —
// FF2's medals are ring-score thresholds (EDITOR-DISPATCH, Corrections).
//
// ── The par (Matt call) ──────────────────────────────────────────────────
//
// On all seven shipped HoverJet missions `bonusParTime` equals `timeLimit`
// (180, and 120 on rookie_01), whatever the route's length: 8.8 to 14.6 km of
// route under one par. So 2016's par is NOT a function of length, and a rule
// from length would be invented. The only 2016 flight that takes every ring and
// finishes is the slow `int_01` ghost, 102.44 s against a par of 180: par is
// 1.757 of a clean lap there. The proposal keeps that relation —
// `min(timeLimit, ceil(lap × parPerAuthorSecond))` — so on `int_01` a
// 102.44 s author lap gives back 2016's own 180.
//
// **The v1 format has no field for it.** `expandPlayerCourse` sets
// `bonusParTime = timeLimit`, and the course's id is the hash of its canonical
// bytes, which the lap server re-expands to judge a lap. A par that a shared
// course carries needs a format field (DEV-466's file, and a version question),
// so this rule is offered and recorded, not applied.

import { type CourseSpline, splinePointAt, splineTangentAt } from '@/content/course-spline'
import type { Level, Ring, Vec3Tuple } from '@/content/level-schema'
import {
  expandPlayerCourse,
  type PlayerCourse,
  playerCourseId,
  playerCourseSpline,
} from '@/content/player-course'
import { withCourseWater } from '@/game/terrain/course-water'
import { customGroundOf, withCustomGround } from '@/game/terrain/custom-ground'

import type { Vec3 } from '@/sim/math/vec3'
import type { AuthorLap, EditorDraft } from './draft'
import { EDITOR_POLICY } from './policy'

/** What a front-end is asked to fly. */
export interface PlaytestRequest {
  /**
   * The course as flown: the draft's, which must validate. DEV-540: null for a
   * SHIPPED mission opened by the dev door (`shipped.ts`), which is a `Level`
   * and an override, never a player course.
   */
  readonly course: PlayerCourse | null
  /** Its id, which the result must carry back. */
  readonly courseId: string
  /**
   * Where along the path the flight starts ("fly from here"), or null for a
   * full lap from the course's start pad. DEV-475: v1 said `course.start.t`,
   * which v2 has not got; the pad is not on the line.
   */
  readonly fromT: number | null
  /** The level to hand `switchMission`: `playtestLevel(course, donor, fromT)`. */
  readonly level: Level
}

/** What comes back when the flight ends, by finishing or by the pause plate. */
export interface PlaytestResult {
  /** The id in the request. A result for another course records nothing. */
  readonly courseId: string
  readonly fromT: number | null
  /** True when the run crossed the finish (not quit, not timed out). */
  readonly finished: boolean
  /** Race-clock seconds at the finish, or null when it did not finish. */
  readonly seconds: number | null
  readonly ringsTaken: number
  readonly ringsTotal: number
}

/** The front-end's half. DEV-469 implements it over `switchMission`. */
export interface PlaytestHost {
  /** Fly `request.level`. Returns when the flight has started, not when it ends. */
  playtest(request: PlaytestRequest): void
  /** Called by the host with the flown lap, on finish or on Back to editor. */
  onReturn?: (result: PlaytestResult) => void
}

const moveSpawn = (level: Level, pos: Vec3Tuple, tangent: { x: number; z: number }): Level => {
  // 2016's spawn convention, as `expandPlayerCourse` writes it: the nose is
  // local −z turned by yaw about +y.
  const yaw = (Math.atan2(-tangent.x, -tangent.z) * 180) / Math.PI
  const half = (yaw * Math.PI) / 360
  const pose = {
    pos,
    quat: [0, Math.sin(half), 0, Math.cos(half)] as [number, number, number, number],
    yaw,
  }
  return { ...level, spawn: { ...pose, launchKind: 'direct' }, respawn: pose }
}

/**
 * The level a playtest flies: the course expanded against its donor and, for
 * "fly from here" (`fromT` a number), the spawn moved to `fromT` along the
 * line, nosed along it and flying, with no pad, the rings BEHIND it left out
 * and the racing line cut to begin there. Rings are not ordered in FF2
 * (`sim/course.ts` is a sphere per ring), so the rest count as they would on a
 * full lap.
 *
 * `fromT` null is the ordinary level, from the pad, unchanged, and only a lap
 * flown on that can be the author lap. Throws `PlayerCourseError` when the
 * course does not validate, as `expandPlayerCourse` does.
 */
export const playtestLevel = (course: PlayerCourse, donor: Level, fromT: number | null): Level => {
  // DEV-489: a donor over a custom ground hands it on. `expandPlayerCourse`
  // CLONES its donor and a clone drops the ground (`customGroundOf`'s note),
  // so the playtest would otherwise fly the sky's own island. Every step below
  // copies by spread, which keeps it.
  const ground = customGroundOf(donor)
  const expanded = expandPlayerCourse(course, donor)
  const grounded = ground ? withCustomGround(expanded, ground) : expanded
  // DEV-500: the course's water, which the world build reads (`oceanFor`).
  const level = course.water ? withCourseWater(grounded, course.water) : grounded
  if (fromT === null || !Number.isFinite(fromT)) return level
  const t = Math.min(Math.max(0, fromT), course.finish.t)
  const spline = playerCourseSpline(course)
  const s = t * spline.length
  const at = splinePointAt(spline, s)
  const moved = moveSpawn(level, [at.x, at.y, at.z], splineTangentAt(spline, s))
  // Keep what lies AHEAD of the new start, measured along the line itself
  // (searched from the line's first point, where the rings run from, so a
  // line that crosses itself cannot map a ring onto the wrong pass).
  const sStart = 0
  const route0 = level.routes[0]
  const ahead: Ring[] = []
  for (const ring of route0 ? route0.rings : []) {
    if (arcAhead(spline, ring.pos, sStart) > s) {
      ahead.push({ ...ring, i: ahead.length, order: ahead.length })
    }
  }
  const route = (level.route ?? []).filter((p) => arcAhead(spline, p, sStart) > s)
  return {
    ...moved,
    routes: route0 ? [{ ...route0, rings: ahead }] : [],
    route: [[at.x, at.y, at.z], ...route],
  }
}

/** Arc distance of the line's sample nearest `p`, among those at or past `sFrom`. */
const arcAhead = (spline: CourseSpline, p: Vec3Tuple, sFrom: number): number => {
  let best = sFrom
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i < spline.samples.length; i++) {
    const a = spline.arc[i] as number
    if (a < sFrom) continue
    const q = spline.samples[i] as Vec3
    const d = (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2 + (q.z - p[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

/** A playtest request for `draft`, or null when the course does not validate. */
export const playtestRequest = (
  draft: EditorDraft,
  donor: Level,
  fromT: number | null = null,
): PlaytestRequest | null => {
  try {
    const level = playtestLevel(draft.course, donor, fromT)
    return { course: draft.course, courseId: playerCourseId(draft.course), fromT, level }
  } catch {
    return null
  }
}

/** Does `result` prove the course: from the pad, finished, every ring, this course? */
export const isAuthorLap = (draft: EditorDraft, result: PlaytestResult): boolean =>
  result.finished &&
  result.seconds !== null &&
  Number.isFinite(result.seconds) &&
  result.seconds > 0 &&
  result.fromT === null &&
  result.ringsTotal > 0 &&
  result.ringsTaken >= result.ringsTotal &&
  result.courseId === playerCourseId(draft.course)

/**
 * The draft after a flight. Records the author lap when `result` is one and it
 * beats the one already held for this course (or there is none for it). Pure;
 * returns the same draft when nothing changes.
 */
export const onReturn = (draft: EditorDraft, result: PlaytestResult): EditorDraft => {
  if (!isAuthorLap(draft, result)) return draft
  const seconds = result.seconds as number
  const held = draft.authorLap
  if (held && held.courseId === result.courseId && held.seconds <= seconds) return draft
  const lap: AuthorLap = { courseId: result.courseId, seconds }
  return { ...draft, authorLap: lap }
}

/**
 * The PROPOSED time-bonus par for an author lap of `lapSeconds` (Matt call;
 * not applied, see the header): `parPerAuthorSecond` of the lap, to the whole
 * second above, never past the time limit.
 */
export const authorParTime = (lapSeconds: number, timeLimit: number): number =>
  Math.min(timeLimit, Math.ceil(lapSeconds * EDITOR_POLICY.parPerAuthorSecond))
