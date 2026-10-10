// src/editor/core/commands.ts — every edit, as a pure `(draft, …) → draft`.
// DEV-468, E2 (docs/plan/EDITOR-DISPATCH.md, "Commands").
//
// Rules every command keeps, and the tests hold:
//
//  · PURE. The input draft is never mutated; the result shares what did not
//    change. No clock, no randomness (the reroll takes its source), no DOM.
//  · A command that changes nothing returns its INPUT, the same object, so
//    `history.record` can tell a no-op from an edit by identity and push no
//    entry for it (a click on the selected point, a gap slider at its end).
//  · The numbers a control sets are clamped to the format's own limits
//    (`PLAYER_COURSE_LIMITS`), so no command writes a value no course could
//    hold. Geometry is NOT clamped: a point may sit outside the boundary while
//    it is being dragged there, and the warnings say so.
//  · The point count stays within `0 .. points.max`. A draft starts with none.
//  · DEV-501: on an ANCHORED course point 0 is the pad's. Every edit re-derives
//    it (`withCourse`, `withPoints`: so moving or aiming the pad, or the gap
//    slider, moves it), and no command moves, deletes or inserts before it.

import { splinePointAt } from '@/content/course-spline'
import type { Level, Vec3Tuple } from '@/content/level-schema'
import {
  anchored,
  normaliseYaw,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  PLAYER_COURSE_WATER,
  type PlayerCourse,
  type PlayerCourseProp,
  type PlayerCourseRingOverride,
  playerCourseSpline,
  quantiseProp,
  randomCourseName,
  waterCeiling,
} from '@/content/player-course'
import { clampLight, type PlayerCourseLight } from '@/content/player-course-light'
import { propEntry } from '@/content/prop-library'
import type { EditorDraft } from './draft'

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

const finite3 = (p: readonly number[]): boolean =>
  p.length === 3 && p.every((c) => Number.isFinite(c))

const withCourse = (draft: EditorDraft, course: PlayerCourse): EditorDraft => ({
  ...draft,
  course: anchored(course),
})

const withPoints = (
  draft: EditorDraft,
  points: readonly Vec3Tuple[],
  selection: number | null,
): EditorDraft => ({
  ...draft,
  course: anchored({ ...draft.course, path: { ...draft.course.path, points } }),
  selection,
})

/** DEV-501: point `index` is the pad's, and no edit moves it. */
export const isAnchoredPoint = (course: PlayerCourse, index: number): boolean =>
  index === 0 && course.path.anchor !== undefined

const same3 = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

// ── Points ────────────────────────────────────────────────────────────────

/** Append a point at the end of the line, and select it. */
export const addPoint = (draft: EditorDraft, p: Vec3Tuple): EditorDraft => {
  const points = draft.course.path.points
  if (!finite3(p) || points.length >= PLAYER_COURSE_LIMITS.points.max) return draft
  return withPoints(draft, [...points, [p[0], p[1], p[2]]], points.length)
}

/**
 * Insert a point BEFORE `index` (so `index === points.length` appends), and
 * select it. The line gains a bend there; every later point keeps its place.
 */
export const insertPoint = (draft: EditorDraft, index: number, p: Vec3Tuple): EditorDraft => {
  const points = draft.course.path.points
  if (!finite3(p) || points.length >= PLAYER_COURSE_LIMITS.points.max) return draft
  if (!Number.isInteger(index) || index < 0 || index > points.length) return draft
  if (isAnchoredPoint(draft.course, index)) return draft // DEV-501: nothing goes before the pad's
  const next = [...points.slice(0, index), [p[0], p[1], p[2]] as Vec3Tuple, ...points.slice(index)]
  return withPoints(draft, next, index)
}

/**
 * Insert a point ON the line at path parameter `t` (arc-length fraction), in
 * the segment that holds it — the bench's "a point on the line inserts a
 * point". The new point lies ON the old curve, so the line only settles a
 * little either side of it until the point is moved. Selects it.
 */
export const insertPointOnPath = (draft: EditorDraft, t: number): EditorDraft => {
  const points = draft.course.path.points
  if (points.length < 2 || !Number.isFinite(t)) return draft
  const spline = playerCourseSpline(draft.course)
  if (!(spline.length > 0)) return draft
  const s = clamp(t, 0, 1) * spline.length
  // The curve parameter at `s` is segment index + local u: bisect the arc table.
  const arc = spline.arc
  let lo = 0
  let hi = arc.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((arc[mid] as number) <= s) lo = mid
    else hi = mid
  }
  const segment = Math.min(points.length - 2, Math.floor(spline.param[lo] as number))
  const at = splinePointAt(spline, s)
  return insertPoint(draft, segment + 1, [at.x, at.y, at.z])
}

/** Move point `index` to `p`. The selection follows it. */
export const movePoint = (draft: EditorDraft, index: number, p: Vec3Tuple): EditorDraft => {
  const points = draft.course.path.points
  const old = points[index]
  if (!old || !finite3(p) || isAnchoredPoint(draft.course, index)) return draft
  if (same3(old, p)) return draft.selection === index ? draft : { ...draft, selection: index }
  const next = points.slice()
  next[index] = [p[0], p[1], p[2]]
  return withPoints(draft, next, index)
}

/**
 * Delete point `index`. The selection moves to the point that took its place
 * (or the new last one), so Delete pressed twice deletes two neighbours.
 */
export const deletePoint = (draft: EditorDraft, index: number): EditorDraft => {
  const points = draft.course.path.points
  if (!points[index] || isAnchoredPoint(draft.course, index)) return draft
  const next = [...points.slice(0, index), ...points.slice(index + 1)]
  const selection = next.length === 0 ? null : Math.min(index, next.length - 1)
  return withPoints(draft, next, selection)
}

/** Select point `index`, or nothing. Not an edit: `history` records it as none. */
export const select = (draft: EditorDraft, index: number | null): EditorDraft => {
  const valid =
    index === null ||
    (Number.isInteger(index) && index >= 0 && index < draft.course.path.points.length)
  const next = valid ? index : null
  return next === draft.selection ? draft : { ...draft, selection: next }
}

// ── The line's numbers ────────────────────────────────────────────────────

/** Metres between rings, inside the format's limits. */
export const setGap = (draft: EditorDraft, gap: number): EditorDraft => {
  if (!Number.isFinite(gap)) return draft
  const L = PLAYER_COURSE_LIMITS.gapMetres
  const g = clamp(gap, L.min, L.max)
  if (g === draft.course.path.gap) return draft
  return withCourse(draft, { ...draft.course, path: { ...draft.course.path, gap: g } })
}

/** One `t` quantum: the least the finish may sit past the line's first point. */
const T_STEP = PLAYER_COURSE_SHAPE.tQuantum

/** The finish's path parameter, kept past the line's first point. */
export const setFinish = (draft: EditorDraft, t: number): EditorDraft => {
  if (!Number.isFinite(t)) return draft
  const next = clamp(t, T_STEP, 1)
  if (next === draft.course.finish.t) return draft
  return withCourse(draft, { ...draft.course, finish: { t: next } })
}

// ── The start pad (DEV-475) ───────────────────────────────────────────────

/**
 * Stand the pad at `pos`: its FOOT, level frame. The desk seats it on the
 * ground before it asks (the core never sees a terrain); this only stores it.
 * The heading is kept.
 */
export const movePad = (draft: EditorDraft, pos: Vec3Tuple): EditorDraft => {
  if (!finite3(pos)) return draft
  const old = draft.course.start
  if (same3(old.pos, pos)) return draft
  return withCourse(draft, { ...draft.course, start: { ...old, pos: [pos[0], pos[1], pos[2]] } })
}

/** Aim the pad: the ship's heading on it, degrees, wrapped to the format's range and grid. */
export const aimPad = (draft: EditorDraft, yaw: number): EditorDraft => {
  if (!Number.isFinite(yaw)) return draft
  const next = normaliseYaw(yaw)
  const old = draft.course.start
  if (next === old.yaw) return draft
  return withCourse(draft, { ...draft.course, start: { ...old, yaw: next } })
}

/**
 * DEV-501: "Anchor to pad" — the line's first point becomes the pad's, `h`
 * metres over its foot and one gap ahead along its heading, and the line
 * leaves it along that heading. **A real change of geometry**, one undo step:
 * the author's first point is REPLACED (not kept behind it: a point behind the
 * pad's would double the line back), the curve's first stretch bends to leave
 * square to the pad, and the rings start ON the new first point rather than a
 * gap past it. The course's id changes with its bytes. A course with no points
 * gains the pad's as its first. Returns the draft itself if already anchored.
 */
export const anchorToPad = (draft: EditorDraft, h: number): EditorDraft => {
  const c = draft.course
  if (c.path.anchor || !Number.isFinite(h)) return draft
  const H = PLAYER_COURSE_LIMITS.anchorHeightMetres
  const anchor = { h: clamp(h, H.min, H.max) }
  const points: Vec3Tuple[] = c.path.points.length > 0 ? [...c.path.points] : [[0, 0, 0]]
  const selection = draft.selection === 0 ? null : draft.selection
  return {
    ...draft,
    course: anchored({ ...c, path: { ...c.path, points, anchor } }),
    selection,
  }
}

/**
 * Skip the ring at path parameter `t`, or put it back if it is skipped.
 *
 * A skip is matched the way the expansion matches it: within HALF A GAP of
 * path (`player-course.ts`'s `placements`), so the `t` a ring was drawn at and
 * the `t` its override stores need not agree to the last digit. Needs a line
 * to measure; with fewer than two points it changes nothing.
 */
export const toggleRingSkip = (draft: EditorDraft, t: number): EditorDraft => {
  const c = draft.course
  if (c.path.points.length < 2 || !Number.isFinite(t) || t < 0 || t > 1) return draft
  const L = playerCourseSpline(c).length
  if (!(L > 0)) return draft
  const halfGap = c.path.gap / 2
  const hit = c.rings.findIndex((r) => Math.abs(r.t - t) * L <= halfGap)
  let rings: PlayerCourseRingOverride[]
  if (hit >= 0) {
    rings = [...c.rings.slice(0, hit), ...c.rings.slice(hit + 1)]
  } else {
    if (c.rings.length >= PLAYER_COURSE_LIMITS.rings.max) return draft
    rings = [...c.rings, { t, skip: true as const }].sort((a, b) => a.t - b.t)
  }
  return withCourse(draft, { ...c, rings })
}

// ── The course's header ───────────────────────────────────────────────────

/**
 * The sky: a donor mission id. The caller offers the island's HoverJet
 * missions only; the validator refuses any other (DEV-466 call 1), and a sky
 * on another island is a validation error rather than a silent island change.
 */
export const setSky = (draft: EditorDraft, sky: string): EditorDraft =>
  typeof sky !== 'string' || sky === draft.course.sky
    ? draft
    : withCourse(draft, { ...draft.course, sky })

// ── The light (DEV-476) ───────────────────────────────────────────────────

/**
 * The course's sun and tint, or `null` for the sky's own (the block removed,
 * so the course has the bytes and the id it would have had without it). The
 * sun is clamped into `donor`'s sky band (`player-course-light.ts`) and every
 * number put on its grid, so the course stores what is flown.
 */
export const setLight = (
  draft: EditorDraft,
  light: PlayerCourseLight | null,
  donor: Level,
): EditorDraft => {
  const old = draft.course.light
  if (light === null) {
    if (!old) return draft
    const { light: _gone, ...rest } = draft.course
    return withCourse(draft, rest)
  }
  const n = [light.sunAzimuth, light.sunElevation, light.tintAmount, ...light.tint]
  if (!n.every((x) => Number.isFinite(x))) return draft
  const next = clampLight(donor, light)
  if (
    old &&
    old.sunAzimuth === next.sunAzimuth &&
    old.sunElevation === next.sunElevation &&
    old.tintAmount === next.tintAmount &&
    old.tint.every((c, i) => c === next.tint[i])
  ) {
    return draft
  }
  return withCourse(draft, { ...draft.course, light: next })
}

// ── The water (DEV-500) ───────────────────────────────────────────────────

/**
 * The course's water level, metres above its island's floor (the format's
 * frame), or `null` for none (the block removed, so the course keeps the bytes
 * and the id it had without it). Held between 0 and the island's ceiling
 * (`waterCeiling`) and put on its grid.
 */
export const setWater = (draft: EditorDraft, level: number | null): EditorDraft => {
  const old = draft.course.water
  if (level === null) {
    if (!old) return draft
    const { water: _gone, ...rest } = draft.course
    return withCourse(draft, rest)
  }
  if (!Number.isFinite(level)) return draft
  const top = waterCeiling(draft.course.island, draft.course.ground ?? null) ?? 0
  const q = Math.round(Math.min(top, Math.max(0, level)) / PLAYER_COURSE_WATER.levelQuantumMetres)
  const next = q * PLAYER_COURSE_WATER.levelQuantumMetres
  if (old && old.level === next) return draft
  return withCourse(draft, { ...draft.course, water: { level: next } })
}

/** Seconds, inside the format's limits. */
export const setTimeLimit = (draft: EditorDraft, seconds: number): EditorDraft => {
  if (!Number.isFinite(seconds)) return draft
  const T = PLAYER_COURSE_LIMITS.timeLimitSeconds
  const s = clamp(seconds, T.min, T.max)
  if (s === draft.course.timeLimit) return draft
  return withCourse(draft, { ...draft.course, timeLimit: s })
}

/**
 * A new two-word name. `randomInt(n)` is a uniform integer in `[0, n)`; the
 * caller supplies it, so this stays pure and a test can drive it. A roll that
 * lands on the current name returns the draft unchanged.
 */
export const rerollName = (draft: EditorDraft, randomInt: (n: number) => number): EditorDraft => {
  const name = randomCourseName(randomInt)
  const old = draft.course.name
  if (name[0] === old[0] && name[1] === old[1]) return draft
  return withCourse(draft, { ...draft.course, name })
}

// ── Placed props (DEV-504) ────────────────────────────────────────────────
//
// A prop is picked by its INDEX in `course.props`, the author's order, which
// the draft and the validator both keep (only the canonical bytes are sorted).
// The desk holds which prop is picked, as it holds the pad; these only edit.
// Every one is a whole edit, one undo step (a gizmo drag coalesces, as a
// point's does). An emptied list is the absent block, so deleting the last
// prop gives the course back the id it had before the first.

const withProps = (draft: EditorDraft, props: readonly PlayerCourseProp[]): EditorDraft => {
  if (props.length > 0) return withCourse(draft, { ...draft.course, props })
  const { props: _gone, ...rest } = draft.course
  return withCourse(draft, rest)
}

/** The prop at `index`, as it would be stored: kind kept, numbers on their grids. */
const replaceProp = (draft: EditorDraft, index: number, next: PlayerCourseProp): EditorDraft => {
  const props = draft.course.props ?? []
  const old = props[index]
  if (!old) return draft
  const q = quantiseProp(next)
  if (same3(old.pos, q.pos) && old.yaw === q.yaw && old.scale === q.scale) return draft
  const out = props.slice()
  out[index] = q
  return withProps(draft, out)
}

/** A scale for `kind` inside the format's range (`propScaleRatio` of its library default). */
export const clampPropScale = (kind: string, scale: number): number => {
  const d = propEntry(kind)?.scale.default ?? 1
  const R = PLAYER_COURSE_LIMITS.propScaleRatio
  return clamp(scale, d * R.min, d * R.max)
}

/**
 * Place a prop of library `kind` with its pivot at `pos` (the desk has seated
 * it on the ground you see), turned `yaw` degrees, at `scale` (the kind's
 * default when absent). At the format's cap, or for a kind the library does
 * not have, nothing changes.
 */
export const addProp = (
  draft: EditorDraft,
  kind: string,
  pos: Vec3Tuple,
  yaw = 0,
  scale?: number,
): EditorDraft => {
  const entry = propEntry(kind)
  const props = draft.course.props ?? []
  if (!entry || !finite3(pos) || !Number.isFinite(yaw)) return draft
  if (props.length >= PLAYER_COURSE_LIMITS.props.max) return draft
  const s = clampPropScale(
    kind,
    scale !== undefined && Number.isFinite(scale) ? scale : entry.scale.default,
  )
  return withProps(draft, [
    ...props,
    quantiseProp({ kind, pos: [pos[0], pos[1], pos[2]], yaw, scale: s }),
  ])
}

/** Stand prop `index` at `pos` (its pivot, seated by the desk). */
export const moveProp = (draft: EditorDraft, index: number, pos: Vec3Tuple): EditorDraft => {
  const old = draft.course.props?.[index]
  if (!old || !finite3(pos)) return draft
  return replaceProp(draft, index, { ...old, pos: [pos[0], pos[1], pos[2]] })
}

/** Turn prop `index` to `yaw` degrees about +y. */
export const turnProp = (draft: EditorDraft, index: number, yaw: number): EditorDraft => {
  const old = draft.course.props?.[index]
  if (!old || !Number.isFinite(yaw)) return draft
  return replaceProp(draft, index, { ...old, yaw })
}

/** Scale prop `index`, held inside its kind's range. */
export const scaleProp = (draft: EditorDraft, index: number, scale: number): EditorDraft => {
  const old = draft.course.props?.[index]
  if (!old || !Number.isFinite(scale)) return draft
  return replaceProp(draft, index, { ...old, scale: clampPropScale(old.kind, scale) })
}

/** Remove prop `index`. */
export const deleteProp = (draft: EditorDraft, index: number): EditorDraft => {
  const props = draft.course.props ?? []
  if (!props[index]) return draft
  return withProps(draft, [...props.slice(0, index), ...props.slice(index + 1)])
}
