// src/editor/core/lift.ts — "Lift clear of the ground": one command that
// raises a line until nothing of it is in the ground. DEV-478.
//
// Matt, 2026-09-27, watching DEV-475's e2e: the AI racers all dove into a
// hill. Four sparse points 150 m over the ground make a Catmull-Rom that sags
// through the hill between two of them, a ring stands inside it, and the
// racers fly the author's line exactly. The editor said so in a list; this is
// the button that fixes it.
//
// ── What "clear" means ────────────────────────────────────────────────────
//
// Exactly what `evaluateDraft` judges, against the same injected RENDER
// surface (`Ground`, never `heightField`: CLAUDE.md, DEV-288):
//
//   · every ring's OPENING — the rim `ringIntrusion` samples — over the ground
//     by the clearance (so no `ring-in-ground`, the error);
//   · every sample of the line over the ground by the clearance (so no
//     `line-under-ground` or `line-near-ground`). The WHOLE line, first point
//     to last, not only to the finish: the racers fly on through the gate
//     (`Level.route` runs to the curve's end), and a run-off in a hill is a
//     hill they fly into.
//   · DEV-486: the RUN-IN, the straight from the ship on its pad to point 1,
//     judged as `evaluateDraft` judges it (past its takeoff). The pad stays
//     where the author put it, so the fix is the straight's FAR END: point 1
//     rises until the straight clears.
//
// ── How ───────────────────────────────────────────────────────────────────
//
// Rounds of: measure every shortfall (a sample, or a ring, short of clear by
// `metres` at curve parameter `g`), then fix them.
//
//   1. RAISE THE NEAREST CONTROL POINTS FIRST. A shortfall at `g` in segment
//      k is shared between the two points that bracket it, k and k+1, in
//      proportion to how near it is to each: `(1 - u)` and `u`. Divided by
//      the curve's own response `D` — the Catmull-Rom weights those two points
//      carry at `u` (`pointWeights`, the basis `course-spline.ts` samples
//      with, clamped ends and all) — so the curve at `g` rises by exactly the
//      shortfall. A shortfall at a point lifts that point alone; one midway
//      lifts both by 1/(2 × 0.5625) of it. Each point takes the most any
//      shortfall asks of it.
//   2. INSERT A POINT OVER A PEAK ONLY WHEN RAISING CANNOT CLEAR IT: when
//      raising either bracketing point would carry it out of the play area
//      (the donor's boundary, or the island's box: `insideArea`, the check
//      the validator refuses on). One point per round, over the worst such
//      shortfall, at the height that clears it; the next round measures the
//      line through it. A point too near a neighbour to stand (the format's
//      `pointSpacingMetres`), or past `points.max`, is not inserted, and that
//      shortfall is left for the warnings to say.
//
// Points only ever go UP, so a round cannot undo another's work except
// through the Catmull-Rom's negative outer weights (raising a point dips the
// curve a little two segments away), which the next round measures and
// raises. It stops when a round finds nothing, changes nothing, or after
// `EDITOR_POLICY.liftRounds`. Heights are rounded UP to the format's point
// quantum, and every target carries one quantum more, so the quantised
// course the validator keeps is as clear as the draft.
//
// PURE and ONE UNDO STEP: a new draft, or the input itself when nothing
// needed lifting (`history.record` then pushes no entry).

import { type CourseSpline, nearestArc, splinePointAt } from '@/content/course-spline'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import {
  expandPlayerCourse,
  insideArea,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  type PlayerCourse,
  playerCourseArea,
  playerCourseSpline,
  validatePlayerCourse,
} from '@/content/player-course'
import { type Vec3, v3 } from '@/sim/math/vec3'
import type { EditorDraft } from './draft'
import { EDITOR_POLICY, groundClearance } from './policy'
import { type Ground, ringIntrusion, runInOf, runInShortOfClear } from './warnings'

/** Something short of clear: `metres` short, at curve parameter `param`, where the curve is `at`. */
export interface Shortfall {
  readonly param: number
  readonly metres: number
  readonly at: Vec3
  /** The live ring it is about, or undefined for the line. */
  readonly ring?: number
}

/** The curve parameter at arc distance `s` (segment index plus local u). */
const paramAt = (spline: CourseSpline, s: number): number => {
  const arc = spline.arc
  const n = arc.length
  if (n < 2) return 0
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((arc[mid] as number) <= s) lo = mid
    else hi = mid
  }
  const a = arc[lo] as number
  const len = (arc[lo + 1] as number) - a
  const f = len > 0 ? Math.min(1, Math.max(0, (s - a) / len)) : 0
  const p0 = spline.param[lo] as number
  return p0 + ((spline.param[lo + 1] as number) - p0) * f
}

const splineOrNull = (course: PlayerCourse): CourseSpline | null => {
  if (course.path.points.length < 2) return null
  try {
    const s = playerCourseSpline(course)
    return s.length > 0 && Number.isFinite(s.length) ? s : null
  } catch {
    return null
  }
}

/**
 * Every place the course is short of clear of `ground`: each line sample, the
 * whole line, lower than the clearance over it; and each ring whose opening
 * the ground reaches into (measured where the ring stands on the curve).
 * Rings are measured only on a course that validates, as `evaluateDraft`'s are.
 */
export const groundShortfalls = (
  course: PlayerCourse,
  donor: Level,
  ground: Ground,
  clearance: number = groundClearance(),
): Shortfall[] => {
  const spline = splineOrNull(course)
  if (!spline) return []
  const out: Shortfall[] = []
  spline.samples.forEach((p, i) => {
    const d = ground.surfaceAt(p.x, p.z) + clearance - p.y
    if (d > 0) out.push({ param: spline.param[i] as number, metres: d, at: p })
  })
  const checked = validatePlayerCourse(course, donor)
  if (!checked.ok) return out
  let level: Level
  try {
    level = expandPlayerCourse(checked.course, donor)
  } catch {
    return out
  }
  liveRings(level).forEach((ring, index) => {
    const hit = ringIntrusion(ring, ground, clearance)
    if (!hit) return
    const t = ring.trigger.pos
    const s = nearestArc(spline, v3(t[0] as number, t[1] as number, t[2] as number))
    out.push({
      param: paramAt(spline, s),
      metres: hit.metres,
      at: splinePointAt(spline, s),
      ring: index,
    })
  })
  return out
}

// ── DEV-486: the run-in ───────────────────────────────────────────────────

/** A run-in sample short of clear: `metres` short, at fraction `f` of the straight. */
export interface RunInShortfall {
  readonly f: number
  readonly metres: number
  readonly at: Vec3
}

/**
 * Every sample of the run-in (the straight from the pad to point 1) short of
 * clear, exactly as `evaluateDraft` judges it (`runInShortOfClear`: under the
 * ground anywhere, near it past the takeoff). Empty with no run-in.
 */
export const runInShortfalls = (
  course: PlayerCourse,
  donor: Level,
  ground: Ground,
  clearance: number = groundClearance(),
): RunInShortfall[] => {
  const r = runInOf(course, donor)
  if (!r) return []
  return runInShortOfClear(r, ground, clearance).map((s) => ({
    f: s.sample.f,
    metres: s.depth,
    at: s.sample.at,
  }))
}
// ── end DEV-486 ───────────────────────────────────────────────────────────

/**
 * The weights control points `k` and `k + 1` carry in the curve at local `u`
 * of segment `k`, of `n` points: the tension-0.5 Hermite basis
 * `course-spline.ts` samples with, with the open curve's clamped neighbours
 * (the first and last points stand in for the missing ones, so they carry
 * those weights too).
 */
export const pointWeights = (k: number, u: number, n: number): [number, number] => {
  const K = PLAYER_COURSE_SHAPE.tension
  const u2 = u * u
  const u3 = u2 * u
  const h00 = 2 * u3 - 3 * u2 + 1
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  const wrap = (i: number): number => Math.max(0, Math.min(n - 1, i))
  // p0, p1, p2, p3 → indices; their weights.
  const idx = [wrap(k - 1), wrap(k), wrap(k + 1), wrap(k + 2)]
  const w = [-K * h10, h00 - K * h11, h01 + K * h10, K * h11]
  let a = 0
  let b = 0
  idx.forEach((j, m) => {
    if (j === k) a += w[m] as number
    else if (j === k + 1) b += w[m] as number
  })
  return [a, b]
}

const Q = PLAYER_COURSE_SHAPE.pointQuantumMetres
/** Up to the format's point quantum (never down: a lifted point must not settle back). */
const quantumUp = (y: number): number => {
  const k = Math.ceil(y / Q - 1e-6)
  return Number((k * Q).toFixed(6))
}

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )

/**
 * Lift the draft's line clear of `ground` (see the header). Pure; returns
 * `draft` itself when nothing was short of clear, or nothing could be done.
 */
export const liftClear = (draft: EditorDraft, donor: Level, ground: Ground): EditorDraft => {
  const start = draft.course.path.points
  if (start.length < 2) return draft
  const clearance = groundClearance()
  const area = donor.environment === draft.course.island ? playerCourseArea(donor) : null
  const fits = (p: readonly number[]): boolean =>
    !area || insideArea(area, v3(p[0] as number, p[1] as number, p[2] as number))
  // DEV-501: an anchored first point is the pad's, and Lift cannot move it
  // over land. It raises the rest of the line; a buried first ring is the
  // warning's, whose fix is to turn or move the pad.
  // DEV-888: ...except over WATER. Turning the pad does not lift it out of a
  // flood, so there the anchor's height `h` (the point's rise over the pad's
  // foot) is what rises: the first point is lifted clear of the water as every
  // other point is, and the pad stays where the author put it.
  const anchorStart = draft.course.path.anchor
  let points: Vec3Tuple[] = start.map((p) => [p[0], p[1], p[2]])
  const locked = (j: number): boolean => {
    if (j !== 0 || anchorStart === undefined) return false
    const p0 = points[0] as Vec3Tuple
    return !ground.waterAt?.(p0[0], p0[2])
  }
  let selection = draft.selection
  let changed = false
  const courseNow = (): PlayerCourse => {
    const path = { ...draft.course.path, points }
    if (anchorStart) {
      // DEV-888: the anchored point's rise is the anchor's `h`.
      const rise = (points[0] as Vec3Tuple)[1] - (start[0] as Vec3Tuple)[1]
      path.anchor = { ...anchorStart, h: Number((anchorStart.h + rise).toFixed(6)) }
    }
    return { ...draft.course, path }
  }

  for (let round = 0; round < EDITOR_POLICY.liftRounds; round++) {
    const found = groundShortfalls(courseNow(), donor, ground, clearance)
    const runIn = runInShortfalls(courseNow(), donor, ground, clearance) // DEV-486
    if (found.length === 0 && runIn.length === 0) break
    const n = points.length
    const want = new Float64Array(n)
    // ── DEV-486: the run-in's FAR END rises ─────────────────────────────
    // The straight runs from the ship on its pad (which stays where the
    // author put it) to point 1, so a sample at fraction f of it rises by
    // f × what point 1 rises: a shortfall of d there asks point 1 for d / f.
    // Where that would carry point 1 out of the play area, it is left for
    // the warning to say (a pad under a cliff wants moving, not a spire).
    {
      const p0 = points[0] as Vec3Tuple
      for (const s of runIn) {
        if (!(s.f > 1e-6)) continue
        const r = Math.max(want[0] as number, (s.metres + Q) / s.f)
        // DEV-888: an anchored line's run-in is the gap and not a straight to
        // lift; over a flood it is the pad's warning (the pad is on the water).
        if (anchorStart === undefined && fits([p0[0], quantumUp(p0[1] + r), p0[2]])) want[0] = r
      }
    }
    // ── end DEV-486 ─────────────────────────────────────────────────────
    let stuck: Shortfall | null = null
    for (const f of found) {
      const k = Math.max(0, Math.min(n - 2, Math.floor(f.param)))
      const u = Math.max(0, Math.min(1, f.param - k))
      const [wa, wb] = pointWeights(k, u, n)
      const D = (1 - u) * wa + u * wb
      const need = f.metres + Q
      const ra = D > 1e-9 ? (need * (1 - u)) / D : need
      const rb = D > 1e-9 ? (need * u) / D : need
      const a = Math.max(want[k] as number, ra)
      const b = Math.max(want[k + 1] as number, rb)
      const pa = points[k] as Vec3Tuple
      const pb = points[k + 1] as Vec3Tuple
      const aFits = ra <= 0 || (!locked(k) && fits([pa[0], quantumUp(pa[1] + a), pa[2]]))
      const bFits = rb <= 0 || fits([pb[0], quantumUp(pb[1] + b), pb[2]])
      if (aFits && bFits) {
        want[k] = a
        want[k + 1] = b
      } else if (!stuck || f.metres > stuck.metres) {
        stuck = f
      }
    }

    // 2. A shortfall raising cannot clear: a point over it, if one can stand there.
    if (stuck && points.length < PLAYER_COURSE_LIMITS.points.max) {
      const k = Math.max(0, Math.min(n - 2, Math.floor(stuck.param)))
      const p: Vec3Tuple = [stuck.at.x, quantumUp(stuck.at.y + stuck.metres + Q), stuck.at.z]
      const spacing = PLAYER_COURSE_LIMITS.pointSpacingMetres.min
      if (
        fits(p) &&
        dist(p, points[k] as Vec3Tuple) >= spacing &&
        dist(p, points[k + 1] as Vec3Tuple) >= spacing
      ) {
        points = [...points.slice(0, k + 1), p, ...points.slice(k + 1)]
        if (selection !== null && selection > k) selection++
        changed = true
        continue
      }
    }

    // 1. Raise the nearest points.
    let raised = false
    const next = points.map((p, j) => {
      const r = want[j] as number
      if (!(r > 0)) return p
      raised = true
      return [p[0], quantumUp(p[1] + r), p[2]] as Vec3Tuple
    })
    if (!raised) break
    points = next
    changed = true
  }

  if (!changed) return draft
  return { ...draft, course: courseNow(), selection }
}
