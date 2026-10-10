// src/editor/core/run-in.ts — the fix beside a too-sharp run-in. DEV-486.
//
// `warnings.ts` judges the run-in (the straight from the ship on its pad to
// the line's first point) and says when it turns tighter than the HoverJet
// holds at cruise (`run-in-turn`). This is the button beside that warning.
//
// ── The choice, named ─────────────────────────────────────────────────────
//
// The brief offered two fixes, "aim the pad along the straight, or aim it at
// the first point". Those are ONE heading — the straight runs from the pad to
// the first point — and a heading fixes only the corner AT THE PAD. The corner
// racer 2 stalled at in DEV-478 is the other one, at the first point, where a
// pad placed past the line makes the run-in double back onto it. No aim of the
// pad changes that angle: the straight's direction is the pad's POSITION. So
// the fix does the least that clears the warning, and says which:
//
//   'aim'   AIM THE PAD AT POINT 1: the heading along the straight, so the
//           pad's corner is gone and the whole straight is left for the
//           turn onto the line. Chosen when that alone clears the warning
//           and turns no racer's pad into the ground.
//   'move'  MOVE THE PAD BEHIND POINT 1: onto the line's own run-up, back
//           along its first tangent, aimed along it — so the run-in is the
//           line continued backwards and neither corner turns in plan. The
//           nearest place, walking back `runInMoveStepMetres` at a time
//           until the play area ends, where every candidate is judged by the
//           rules the warnings use (a placement that cannot be wrong beats
//           a guess that is usually right: CLAUDE.md, DEV-041), in two
//           passes. FIRST, a place that raises nothing: the pad dry and flat
//           (the tests `padSpot` holds a new draft's pad to), every racer's
//           pad out of the ground and off the water. Failing that — Simonet's
//           islands are steep, and a census of int_01's found 46 flat
//           pad-sized places in 3,871 samples of land — the nearest place
//           that raises no ERROR: the pad still on land (a pad on the sea is
//           drowned by the waves, DEV-475 call 5), no racer's pad in the
//           ground; a slope or a racer over the water is a warning the
//           author can see. Either way the straight is not in the ground and
//           the run-in's turn passes.
//
// ONE undo step either way; the input itself when there is nothing to fix or
// nowhere to put the pad.

import { splineTangentAt } from '@/content/course-spline'
import type { Level, Vec3Tuple } from '@/content/level-schema'
import {
  anchored,
  insideArea,
  normaliseYaw,
  PLAYER_COURSE_SHAPE,
  type PlayerCourse,
  type PlayerCourseStart,
  playerCourseArea,
  playerCourseSpline,
} from '@/content/player-course'
import { v3 } from '@/sim/math/vec3'
import { aimPad, movePad } from './commands'
import type { EditorDraft } from './draft'
import { EDITOR_POLICY, groundClearance, tightestTurnRadius } from './policy'
import {
  anchoredRingIntrusion,
  type Ground,
  padFootprint,
  padSizeOf,
  runInOf,
  runInSamples,
  runInShortOfClear,
  runInTurn,
  type SlotPad,
} from './warnings'

export type RunInFix = 'aim' | 'move'

// ── DEV-501: a heading whose anchored ring 1 stands clear ────────────────

/**
 * How far short of clear an anchored ring 1 is when its pad faces `yaw`: the
 * most the ground (plus the hover height) reaches into its opening
 * (`anchoredRingIntrusion`: the buried-ring warning's own measure, of the ring
 * the expansion itself places), or the most the straight from the ship on its
 * pad to it falls short of clear by the run-in warning's own rule
 * (`runInShortOfClear`: under the ground anywhere, near it past the takeoff) —
 * the two things Lift cannot mend on an anchored course. Zero or less is
 * clear. Infinity where ring 1 would leave the play area.
 */
const anchorShortfall = (
  course: PlayerCourse,
  donor: Level,
  ground: Ground,
  yaw: number,
): number => {
  if (!course.path.anchor) return 0
  // The course as the pad would leave it: turned, its first point following.
  const turned = anchored({ ...course, start: { ...course.start, yaw } })
  const p = turned.path.points[0] as Vec3Tuple
  const area = donor.environment === course.island ? playerCourseArea(donor) : null
  if (area && !insideArea(area, v3(p[0], p[1], p[2]))) return Number.POSITIVE_INFINITY
  const hit = anchoredRingIntrusion(turned, donor, ground, groundClearance())
  let worst = hit ? hit.metres : 0
  const r = runInOf(turned, donor)
  if (r)
    for (const short of runInShortOfClear(r, ground, groundClearance()))
      worst = Math.max(worst, short.depth)
  return worst
}

/**
 * What `anchorHeading` found: a heading, and whether ring 1 and the straight to
 * it stand clear there. `clears` false means NO heading it tried clears them —
 * only moving the pad can — and `yaw` is then the one that came closest.
 * (DEV-501 follow-up: the search returned a bare heading, so the desk could not
 * tell "turned until clear" from "turned to the least buried", and said "so
 * ring 1 clears the ground" for both.)
 */
export interface AnchorAim {
  readonly yaw: number
  readonly clears: boolean
}

/**
 * DEV-501: the heading for an anchored course's pad whose ring 1 stands clear
 * of the ground — the pad's own heading if it does (for a new draft, the
 * base's own start direction), else the nearest that does, trying
 * `anchorHeadingStepDegrees` either side in turn; where none does, the one
 * that comes closest, with `clears` false, and the buried-ring error stands
 * for the author. A free course keeps its heading (and `clears`: there is no
 * anchored ring to judge). Pure: the desk hands in the ground it sees.
 */
export const anchorHeading = (course: PlayerCourse, donor: Level, ground: Ground): AnchorAim => {
  const yaw0 = course.start.yaw
  if (!course.path.anchor) return { yaw: yaw0, clears: true }
  let best = yaw0
  let bestShort = anchorShortfall(course, donor, ground, yaw0)
  if (bestShort <= 0) return { yaw: yaw0, clears: true }
  const step = EDITOR_POLICY.anchorHeadingStepDegrees
  for (let k = 1; k * step <= 180; k++) {
    for (const sign of [1, -1]) {
      const yaw = normaliseYaw(yaw0 + sign * k * step)
      const short = anchorShortfall(course, donor, ground, yaw)
      if (short <= 0) return { yaw, clears: true }
      if (short < bestShort) {
        best = yaw
        bestShort = short
      }
    }
  }
  return { yaw: best, clears: false }
}

/**
 * What the panel says after the desk aimed a pad with `anchorHeading` (from
 * `fromYaw` to `aim.yaw`): that it turned so ring 1 clears, or that NO heading
 * clears it from here and the pad must move; empty when it cleared without a
 * turn. "Clears" is said only when `aim.clears` — the search's own verdict,
 * which measures what the warnings measure — never inferred from the turn.
 */
export const anchorAimNote = (fromYaw: number, aim: AnchorAim): string => {
  const turn = Math.abs(((((aim.yaw - fromYaw) % 360) + 540) % 360) - 180)
  const turned = turn > PLAYER_COURSE_SHAPE.yawQuantumDegrees
  if (!aim.clears) {
    return turned
      ? `The pad turned ${Math.round(turn)}° to the closest heading, but ring 1 does not clear the ground from here: move the pad.`
      : 'Ring 1 does not clear the ground at any heading from here: move the pad.'
  }
  return turned ? `The pad turned ${Math.round(turn)}° so ring 1 clears the ground.` : ''
}

/** The heading, degrees, that points the nose along (dx, dz): `yawForward`'s inverse. */
export const yawToward = (dx: number, dz: number): number => (Math.atan2(-dx, -dz) * 180) / Math.PI

/** Does the run-in of `course` turn tighter than the jet holds at cruise? */
const tooSharp = (course: PlayerCourse, donor: Level): boolean => {
  const turn = runInTurn(course, donor)
  return turn !== null && turn.radius < tightestTurnRadius()
}

/**
 * The course with its pad aimed at point 1 — along the straight, in plan — or,
 * where the line starts over the pad (`runInTurn`'s `overPad`), along the
 * line's first tangent. Null with neither to aim along.
 */
const aimedAtPoint = (draft: EditorDraft, donor: Level): EditorDraft | null => {
  const turn = runInTurn(draft.course, donor)
  if (!turn) return null
  if (turn.overPad) {
    const t = splineTangentAt(playerCourseSpline(draft.course), 0)
    return aimPad(draft, yawToward(t.x, t.z))
  }
  const r = runInOf(draft.course, donor)
  if (!r) return null
  return aimPad(draft, yawToward(r.to.x - r.from.x, r.to.z - r.from.z))
}

/**
 * Which fix the button beside a `run-in-turn` warning will make, for its
 * label: null when the run-in is not too sharp. Cheap (no search): 'aim' when
 * aiming alone clears the turn, else 'move'. `straightenRunIn` may still move
 * when an aim would put a racer's pad in the ground.
 */
export const runInFixOf = (draft: EditorDraft, donor: Level): RunInFix | null => {
  if (!tooSharp(draft.course, donor)) return null
  const aimed = aimedAtPoint(draft, donor)
  return aimed && !tooSharp(aimed.course, donor) ? 'aim' : 'move'
}

/** A racer's pad in the ground, or over the sea: `evaluateDraft`'s slot tests. */
const slotTrouble = (ground: Ground, slots: readonly SlotPad[]): 'ground' | 'water' | null => {
  for (const s of slots) {
    const under = padFootprint(ground, s.foot, s.size)
    if (under && under.high > (s.foot[1] as number) + (s.size[1] as number)) return 'ground'
  }
  for (const s of slots) {
    if (ground.waterAt?.(s.foot[0] as number, s.foot[2] as number)) return 'water'
  }
  return null
}

/** The run-in's straight goes under the ground you see somewhere. */
const straightInGround = (course: PlayerCourse, donor: Level, ground: Ground): boolean => {
  const r = runInOf(course, donor)
  if (!r) return false
  return runInSamples(r).some((s) => s.at.y < ground.surfaceAt(s.at.x, s.at.z))
}

/**
 * Straighten a too-sharp run-in (see the header). `slotsFor(start)` lays out
 * the racers' pads beside a start pad (the desk's `courseSlots`, the game's
 * own list); the core cannot import it. Returns the fixed draft and which fix
 * it made, or the input and null.
 */
export const straightenRunIn = (
  draft: EditorDraft,
  donor: Level,
  ground: Ground,
  slotsFor: (start: PlayerCourseStart) => readonly SlotPad[],
): { readonly draft: EditorDraft; readonly fix: RunInFix | null } => {
  const course = draft.course
  if (!tooSharp(course, donor)) return { draft, fix: null }

  // 'aim': when that alone clears it, and no racer's pad lands in the ground.
  const aimed = aimedAtPoint(draft, donor)
  if (
    aimed &&
    !tooSharp(aimed.course, donor) &&
    slotTrouble(ground, slotsFor(aimed.course.start)) !== 'ground'
  ) {
    return { draft: aimed, fix: 'aim' }
  }

  // 'move': walk back along the line's first tangent, in plan.
  const size = padSizeOf(donor)
  const first = course.path.points[0]
  if (!size || !first || course.path.points.length < 2) return { draft, fix: null }
  const t = splineTangentAt(playerCourseSpline(course), 0)
  const tl = Math.hypot(t.x, t.z)
  if (!(tl > 1e-6)) return { draft, fix: null }
  const bx = -t.x / tl
  const bz = -t.z / tl
  const yaw = yawToward(-bx, -bz)
  const area = donor.environment === course.island ? playerCourseArea(donor) : null
  const clearance = groundClearance()
  const step = EDITOR_POLICY.runInMoveStepMetres
  const search = (strict: boolean): EditorDraft | null => {
    // Bounded by the play area, which is convex (a sphere or a box): once a
    // step back leaves it, every further one does. The cap is a guard only.
    for (let k = 1; k <= 100_000; k++) {
      const x = first[0] + bx * step * k
      const z = first[2] + bz * step * k
      const under = padFootprint(ground, [x, 0, z], size)
      if (!under) continue
      if (area && !insideArea(area, v3(x, under.high, z))) break
      if (ground.waterAt?.(x, z)) continue
      if (strict && under.high - under.low > clearance) continue
      const pos: Vec3Tuple = [x, under.high, z]
      const trouble = slotTrouble(ground, slotsFor({ pos, yaw }))
      if (trouble === 'ground' || (strict && trouble === 'water')) continue
      const moved = aimPad(movePad(draft, pos), yaw)
      if (tooSharp(moved.course, donor)) continue
      if (straightInGround(moved.course, donor, ground)) continue
      return moved
    }
    return null
  }
  const moved = search(true) ?? search(false)
  return moved ? { draft: moved, fix: 'move' } : { draft, fix: null }
}
