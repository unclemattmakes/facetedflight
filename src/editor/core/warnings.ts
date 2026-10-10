// src/editor/core/warnings.ts — what is wrong with the draft, live and pure.
// DEV-468, E2 (docs/plan/EDITOR-DISPATCH.md "Warnings"; EDITOR.md §5.3 step 3:
// *"Warnings appear in the world, not in a list"* — so every warning carries a
// place to be drawn).
//
// `evaluateDraft(draft, donor, ground)` is the one call a front-end makes per
// change. It validates, expands when it can, and reports:
//
//   invalid           the validator's refusal, one per issue (DEV-466). A course
//                     with any of these cannot be flown or shared.
//   point-outside     a control point outside the play area (the donor's
//                     boundary, or the island's box where it has none).
//   curve-outside     a stretch of curve outside it, between points inside.
//   ring-in-ground    the ground reaches into a ring's opening, plus clearance.
//                     An ERROR since DEV-478: the ring is buried.
//   line-under-ground a stretch of the flown line under the ground you see.
//   line-near-ground  a stretch of the flown line lower over the ground than
//                     the clearance, but over it. Both line kinds are
//                     WARNINGS (DEV-478): a player can fly round a dip.
//   tight-turn        a bend tighter than the HoverJet holds at cruise.
//   finish-no-runoff  the line ends inside the finish gate.
//   pad-outside       the start pad outside the play area (DEV-475).
//   pad-in-ground     the ground over the pad's rim.
//   pad-in-water      the pad on the sea.
//   pad-slope         air under the pad: it stands on a slope, or floats.
//   slot-in-ground    a racer's pad beside it with the ground over its rim.
//   slot-in-water     a racer's pad over the sea.
//   run-in-turn       the run-in (the straight from the pad to the line's
//                     first point) turns tighter than the jet holds at cruise
//                     (DEV-486). The run-in's ground is judged as the line's
//                     is, under `line-under-ground` / `line-near-ground`.
//   line-through-prop a stretch of the flown line (run-in included) within
//                     reach of a prop that COLLIDES: the ship's collision
//                     radius plus the clearance (DEV-503). A warning.
//   ring-in-prop      a colliding prop within the clearance of a ring's
//                     opening. An ERROR, as `ring-in-ground` is (DEV-503).
//
// ── The props are injected too (DEV-503) ─────────────────────────────────
//
// `props.near(a, b, reach)` answers which colliding props a segment of the
// level frame comes within `reach` of, as `ground.surfaceAt` answers the
// terrain: the desk builds it from the world's LIVE collider set, after the
// course's clearing (DEV-502), so it covers the landmarks, a level's own
// props and any scatter a clearing left standing, and whatever joins that set
// later. Null, or absent, and no prop is judged.
//
// ── The ground is injected, and it is the RENDER surface ─────────────────
//
// `ground.surfaceAt(x, z)` is the height, metres, of the terrain you can SEE
// at level-frame (THREE-space) x, z: the frame `Ring.pos` and the course's
// points are written in. DEV-469 builds it from `renderSurfaceHeightAt` /
// `snapToRenderSurface` (`sim/terrain/surface.ts`), converting from the
// terrain's mesh frame — never from `heightField`, which is the surface you
// HIT and misses what you see by up to 21.8 m on steep desert (CLAUDE.md,
// DEV-288). A warning about rock in a ring is about the rock you can see.
//
// ── Thresholds ───────────────────────────────────────────────────────────
//
// None is typed here. The clearance is the HoverJet's `hoverHeight`, the turn
// limit is its cruise speed and DEV-027's measured lateral acceleration, the
// ring's opening is the donor ring's trigger radius and the finish's reach is
// the donor's finish radius (`policy.ts` says why each).

import { type CourseSpline, splinePointAt, splineTangentAt } from '@/content/course-spline'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import {
  anchoredRing,
  expandPlayerCourse,
  insideArea,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  type PlayerCourse,
  type PlayerCourseArea,
  type PlayerCourseIssue,
  playerCourseArea,
  playerCourseSpawn,
  playerCourseSpline,
  ringFacing,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import { DEG_PER_RAD } from '@/sim/math/scalar'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { type EditorDraft, safeCourseId } from './draft'
import { EDITOR_POLICY, groundClearance, propReach, tightestTurnRadius } from './policy'

/** The RENDER surface's height at level-frame (x, z), metres. */
export interface Ground {
  surfaceAt(x: number, z: number): number
  /**
   * DEV-475: is what you see at (x, z) the SEA rather than land? Absent means
   * never (a ground with no sea, or a test's).
   */
  waterAt?(x: number, z: number): boolean
}

/** No ground yet (the world is still building): nothing is in the ground, nothing is under it. */
export const NO_GROUND: Ground = { surfaceAt: () => Number.NEGATIVE_INFINITY }

/** DEV-503: one colliding prop a segment comes within reach of, as `Props` reports it. */
export interface PropContact {
  /** Its id in the world's collider set: one prop, one id, while the world stands. */
  readonly id: number
  /** What it is (`spire`, `tree`, ...), for the message. */
  readonly kind: string
  /** Where to mark it, level frame: its axis at the height the segment passes. */
  readonly at: Vec3Tuple
  /** How far inside `reach` of its collision shape the segment comes, metres (> 0). */
  readonly depth: number
}

/** DEV-503: the world's colliding props, as the warnings judge against them. */
export interface Props {
  /** Every colliding prop within `reach` metres of segment a to b (level frame), once each. */
  near(a: Vec3Tuple, b: Vec3Tuple, reach: number): readonly PropContact[]
}

export type WarningKind =
  | 'invalid'
  | 'point-outside'
  | 'curve-outside'
  | 'ring-in-ground'
  | 'line-under-ground'
  | 'line-near-ground'
  | 'tight-turn'
  | 'finish-no-runoff'
  | 'pad-outside'
  | 'pad-in-ground'
  | 'pad-in-water'
  | 'pad-slope'
  | 'slot-in-ground'
  | 'slot-in-water'
  | 'run-in-turn' // DEV-486
  | 'line-through-prop' // DEV-503
  | 'ring-in-prop' // DEV-503
  | 'ring-off-line' // DEV-540: a shipped mission's ring the racing line misses (`shipped.ts`)

/**
 * DEV-478: the warnings "Lift clear of the ground" answers. Typed by the
 * union, so a renamed kind fails typecheck rather than silently never matching.
 */
export const GROUND_WARNING_KINDS: ReadonlySet<WarningKind> = new Set<WarningKind>([
  'ring-in-ground',
  'line-under-ground',
  'line-near-ground',
])

/**
 * `error`: the course cannot be flown or shared as it stands. `warning`: it
 * can, and something about it is probably not what the author meant. `note`:
 * worth knowing, harmless to ignore.
 */
export type WarningSeverity = 'error' | 'warning' | 'note'

export interface EditorWarning {
  readonly kind: WarningKind
  readonly severity: WarningSeverity
  readonly message: string
  /** Where to draw it, level frame; null when it has no one place. */
  readonly at: Vec3Tuple | null
  /** The control point it is about. */
  readonly point?: number
  /** The ring it is about: an index into the expanded level's live rings. */
  readonly ring?: number
  /** The stretch of path it is about, as path parameters `[from, to]`. */
  readonly span?: readonly [number, number]
  /** The validator's path, for `invalid`. */
  readonly path?: string
  /** The size of the problem, metres: an intrusion, a shortfall or a radius. */
  readonly metres?: number
  /** DEV-475: the racer's start it is about, an index into `racerStarts`' list. */
  readonly slot?: number
  /**
   * DEV-486: the stretch of the RUN-IN it is about, as fractions `[from, to]`
   * of the straight from the ship on its pad (0) to the line's first point (1).
   * A line warning carries `span` or this, never both.
   */
  readonly runIn?: readonly [number, number]
  /**
   * DEV-501: the ground here is the ANCHORED stretch's — ring 1 on the pad's
   * point, or the run-in to it — which Lift cannot move; its fix is the pad.
   */
  readonly anchored?: true
  /** DEV-503: where each prop it is about stands, level frame: a marker on each. */
  readonly props?: readonly Vec3Tuple[]
  /** DEV-504: the placed prop it is about, an index into `course.props`. */
  readonly prop?: number
}

export interface DraftEvaluation {
  /** `pc_…` of the course as it stands, valid or not. */
  readonly courseId: string | null
  /** The quantised course when it validates against the donor, else null. */
  readonly course: PlayerCourse | null
  /** The expanded level when the course validates, else null. */
  readonly level: Level | null
  /** Errors first, then warnings, then notes; each group in path order. */
  readonly warnings: readonly EditorWarning[]
}

const tuple = (p: Vec3): Vec3Tuple => [p.x, p.y, p.z]
const vec = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, p[2] as number)
const round1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1)

/** A spline worth measuring: two points or more, and some length. */
const splineOf = (course: PlayerCourse): CourseSpline | null => {
  if (course.path.points.length < 2) return null
  try {
    const s = playerCourseSpline(course)
    return s.length > 0 && Number.isFinite(s.length) ? s : null
  } catch {
    return null
  }
}

/** Contiguous runs of sample indices for which `bad(i)` holds, within `[from, to]`. */
const runs = (from: number, to: number, bad: (i: number) => boolean): [number, number][] => {
  const out: [number, number][] = []
  let open = -1
  for (let i = from; i <= to; i++) {
    if (bad(i)) {
      if (open < 0) open = i
    } else if (open >= 0) {
      out.push([open, i - 1])
      open = -1
    }
  }
  if (open >= 0) out.push([open, to])
  return out
}

/** The sample index range covering arc `[s0, s1]`. */
const sampleRange = (spline: CourseSpline, s0: number, s1: number): [number, number] => {
  const arc = spline.arc
  let a = 0
  while (a + 1 < arc.length && (arc[a + 1] as number) <= s0) a++
  let b = a
  while (b + 1 < arc.length && (arc[b] as number) < s1) b++
  return [a, b]
}

// ── The play area ─────────────────────────────────────────────────────────

const outsideWarnings = (
  course: PlayerCourse,
  area: PlayerCourseArea,
  spline: CourseSpline | null,
): EditorWarning[] => {
  const out: EditorWarning[] = []
  const where = area.kind === 'sphere' ? "the base's boundary" : "the island's play area"
  const pointsOutside = new Set<number>()
  course.path.points.forEach((p, i) => {
    if (!insideArea(area, vec(p))) {
      pointsOutside.add(i)
      out.push({
        kind: 'point-outside',
        severity: 'error',
        message: `Point ${i + 1} is outside ${where}.`,
        at: [p[0], p[1], p[2]],
        point: i,
      })
    }
  })
  // DEV-475: the start pad.
  const pad = course.start.pos
  if (!insideArea(area, vec(pad))) {
    out.push({
      kind: 'pad-outside',
      severity: 'error',
      message: `The start pad is outside ${where}.`,
      at: [pad[0], pad[1], pad[2]],
    })
  }
  if (!spline) return out
  // Stretches of curve outside, reported only where the points either side
  // are inside: a point outside already says the curve near it is.
  const n = spline.samples.length
  for (const [a, b] of runs(0, n - 1, (i) => !insideArea(area, spline.samples[i] as Vec3))) {
    const segA = Math.floor(spline.param[a] as number)
    const segB = Math.ceil(spline.param[b] as number)
    if (pointsOutside.has(segA) || pointsOutside.has(segB)) continue
    const mid = spline.samples[(a + b) >> 1] as Vec3
    out.push({
      kind: 'curve-outside',
      severity: 'error',
      message: `The line swings outside ${where} between points ${segA + 1} and ${segB + 1}.`,
      at: tuple(mid),
      span: [(spline.arc[a] as number) / spline.length, (spline.arc[b] as number) / spline.length],
    })
  }
  return out
}

// ── The ground ────────────────────────────────────────────────────────────

/**
 * Ground reaching into each ring's opening.
 *
 * The opening is the donor ring's TRIGGER sphere — the volume that counts the
 * ring, 22.6 m on every shipped HoverJet ring — seen as the disc across the
 * path. It sits inside the frame you see: `tools/assets/convert-fbx.py` has the
 * frame at ±12.1 × ±17.6 m at prefab scale and the sphere at 11.31 m, both
 * doubled at ring scale 2. The disc's rim is sampled (`ringOpeningSamples`);
 * for a disc standing across the line its lowest point at each lateral offset
 * is on the rim, so the rim is where the ground arrives first.
 *
 * DEV-478: a ring the ground reaches into is BURIED, and that is an ERROR —
 * the course cannot be flown or shared until it is lifted clear (Matt,
 * 2026-09-27: *"block save and link"*). The AI racers fly the author's line
 * exactly, so a buried ring is a ring every one of them flies into the hill
 * for; nobody can take it, and the course's medals are out of reach.
 */
const ringWarnings = (
  level: Level,
  ground: Ground,
  clearance: number,
  anchor: readonly number[] | null = null,
): EditorWarning[] => {
  const out: EditorWarning[] = []
  liveRings(level).forEach((ring, index) => {
    const hit = ringIntrusion(ring, ground, clearance)
    if (hit) {
      // DEV-501: the ring on an anchored first point is the pad's; Lift cannot
      // move it, so the fix it names is the pad's.
      const p = ring.pos
      const onAnchor =
        anchor !== null &&
        Math.hypot(
          (p[0] as number) - (anchor[0] as number),
          (p[1] as number) - (anchor[1] as number),
          (p[2] as number) - (anchor[2] as number),
        ) < PLAYER_COURSE_LIMITS.pointSpacingMetres.min
      out.push({
        kind: 'ring-in-ground',
        severity: 'error',
        message:
          `Ring ${index + 1}: the ground reaches ${round1(hit.metres)} m into its opening.` +
          (onAnchor ? ' It is anchored to the pad: turn or move the pad.' : ''),
        at: hit.at,
        ring: index,
        metres: hit.metres,
        ...(onAnchor ? { anchored: true as const } : {}),
      })
    }
  })
  return out
}

/** A ring as the expansion places it: its trigger sphere and its facing. */
export interface RingOpening {
  readonly trigger: { readonly pos: readonly number[]; readonly radius: number }
  readonly quat: readonly number[]
}

/**
 * The rim of a ring's opening: `ringOpeningSamples` points round the disc of
 * its trigger sphere standing across its facing, level frame. The desk draws
 * a buried ring with these (DEV-478), and `ringIntrusion` samples them, so
 * the circle drawn red is the circle judged.
 */
export const ringOpeningRim = (ring: RingOpening): Vec3Tuple[] => {
  const N = EDITOR_POLICY.ringOpeningSamples
  const c = vec(ring.trigger.pos)
  const r = ring.trigger.radius
  const f = ringFacing(ring.quat)
  // Across: horizontal and perpendicular to the facing. Up-in-disc: f × across.
  let ax = -f.z
  let az = f.x
  const al = Math.hypot(ax, az)
  if (al > 1e-9) {
    ax /= al
    az /= al
  } else {
    ax = 1
    az = 0
  }
  const ux = f.y * az
  const uy = f.z * ax - f.x * az
  const uz = -f.y * ax
  const ul = Math.hypot(ux, uy, uz) || 1
  const out: Vec3Tuple[] = []
  for (let k = 0; k < N; k++) {
    const th = (2 * Math.PI * k) / N
    const cos = Math.cos(th)
    const sin = Math.sin(th)
    out.push([
      c.x + r * (cos * ax + (sin * ux) / ul),
      c.y + r * ((sin * uy) / ul),
      c.z + r * (cos * az + (sin * uz) / ul),
    ])
  }
  return out
}

/**
 * How far the ground, plus `clearance`, reaches into a ring's opening, and
 * where it reaches furthest; null where it does not reach it at all.
 */
export const ringIntrusion = (
  ring: RingOpening,
  ground: Ground,
  clearance: number,
): { readonly metres: number; readonly at: Vec3Tuple } | null => {
  let worst = 0
  let worstAt: Vec3Tuple | null = null
  for (const p of ringOpeningRim(ring)) {
    const intrusion = ground.surfaceAt(p[0], p[2]) + clearance - p[1]
    if (intrusion > worst) {
      worst = intrusion
      worstAt = p
    }
  }
  return worstAt ? { metres: worst, at: worstAt } : null
}

/**
 * DEV-501 follow-up: ring 1 of an anchored course against the ground — the
 * ring the expansion places on the pad's point (`anchoredRing`; the expansion
 * calls it for that ring), judged by the buried-ring rule (`ringIntrusion`).
 * So the heading search, which calls this before the line has a second point,
 * and the `ring-in-ground` error on the expanded level measure ONE ring with
 * ONE rule. (They were two copies: the search's disc sat on the point itself,
 * not on the template's trigger, which stands 1.9 m off it on rookie_01.)
 * Null where it is clear, or the course is free.
 */
export const anchoredRingIntrusion = (
  course: PlayerCourse,
  donor: Level,
  ground: Ground,
  clearance: number,
): { readonly metres: number; readonly at: Vec3Tuple } | null => {
  const ring = anchoredRing(course, donor)
  return ring ? ringIntrusion(ring, ground, clearance) : null
}

/**
 * Stretches of the flown line, first point to finish, lower over the ground
 * than `clearance`. DEV-478 says which kind: a stretch that goes UNDER the
 * ground you see is `line-under-ground`, reported over just the samples below
 * the surface (the stretch the desk draws red); one that stays over it but
 * inside the hover height is `line-near-ground`. Both are warnings.
 */
const lineWarnings = (
  course: PlayerCourse,
  spline: CourseSpline,
  ground: Ground,
  clearance: number,
): EditorWarning[] => {
  const L = spline.length
  // DEV-475: the flown line runs from the first point (the pad is off it).
  const [a, b] = sampleRange(spline, 0, course.finish.t * L)
  const depth = (i: number): number => {
    const p = spline.samples[i] as Vec3
    return ground.surfaceAt(p.x, p.z) + clearance - p.y
  }
  const worstOf = (i0: number, i1: number): number => {
    let worst = i0
    for (let i = i0; i <= i1; i++) if (depth(i) > depth(worst)) worst = i
    return worst
  }
  const span = (i0: number, i1: number): [number, number] => [
    (spline.arc[i0] as number) / L,
    (spline.arc[i1] as number) / L,
  ]
  const out: EditorWarning[] = []
  for (const [n0, n1] of runs(a, b, (i) => depth(i) > 0)) {
    const under = runs(n0, n1, (i) => depth(i) > clearance)
    if (under.length === 0) {
      const worst = worstOf(n0, n1)
      out.push({
        kind: 'line-near-ground',
        severity: 'warning',
        message: `The line runs within ${round1(clearance)} m of the ground here; the jet hovers above it.`,
        at: tuple(spline.samples[worst] as Vec3),
        span: span(n0, n1),
        metres: depth(worst),
      })
      continue
    }
    for (const [i0, i1] of under) {
      const worst = worstOf(i0, i1)
      const d = depth(worst)
      out.push({
        kind: 'line-under-ground',
        severity: 'warning',
        message: `The line runs ${round1(d - clearance)} m under the ground here.`,
        at: tuple(spline.samples[worst] as Vec3),
        span: span(i0, i1),
        metres: d,
      })
    }
  }
  return out
}

// ── The line's shape ──────────────────────────────────────────────────────

/** The radius of the circle through three points, metres; Infinity when they are in line. */
const circumradius = (p: Vec3, q: Vec3, r: Vec3): number => {
  const a = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)
  const b = Math.hypot(r.x - q.x, r.y - q.y, r.z - q.z)
  const c = Math.hypot(r.x - p.x, r.y - p.y, r.z - p.z)
  const ux = q.x - p.x
  const uy = q.y - p.y
  const uz = q.z - p.z
  const vx = r.x - p.x
  const vy = r.y - p.y
  const vz = r.z - p.z
  const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  return cross > 1e-12 ? (a * b * c) / (2 * cross) : Number.POSITIVE_INFINITY
}

/** Bends before the finish tighter than the HoverJet holds at cruise. */
const turnWarnings = (course: PlayerCourse, spline: CourseSpline): EditorWarning[] => {
  const L = spline.length
  const limit = tightestTurnRadius()
  const [a, b] = sampleRange(spline, 0, course.finish.t * L)
  const n = spline.samples.length
  const radius = (i: number): number =>
    i <= 0 || i >= n - 1
      ? Number.POSITIVE_INFINITY
      : circumradius(
          spline.samples[i - 1] as Vec3,
          spline.samples[i] as Vec3,
          spline.samples[i + 1] as Vec3,
        )
  const out: EditorWarning[] = []
  for (const [i0, i1] of runs(a, b, (i) => radius(i) < limit)) {
    let tightest = i0
    for (let i = i0; i <= i1; i++) if (radius(i) < radius(tightest)) tightest = i
    const R = radius(tightest)
    out.push({
      kind: 'tight-turn',
      severity: 'warning',
      message: `A ${Math.round(R)} m bend: the jet turns no tighter than ${Math.round(limit)} m at cruise, so it must brake here.`,
      at: tuple(spline.samples[tightest] as Vec3),
      span: [(spline.arc[i0] as number) / L, (spline.arc[i1] as number) / L],
      metres: R,
    })
  }
  return out
}

/**
 * Less line beyond the finish than the finish gate's own radius. The racing
 * line the AI racers fly (`Level.route`) runs from the start to the curve's
 * END, so a finish at the end stops them at the gate's centre rather than
 * carrying them through it, as 2016's routes do (DEV-466). The gate is the
 * donor's: its radius, not a number here.
 */
const runoffWarnings = (
  course: PlayerCourse,
  spline: CourseSpline,
  level: Level,
): EditorWarning[] => {
  const finish = level.finish
  if (!finish) return []
  const L = spline.length
  const beyond = (1 - course.finish.t) * L
  if (beyond >= finish.radius) return []
  return [
    {
      kind: 'finish-no-runoff',
      severity: 'note',
      message: `The line ends ${Math.round(beyond)} m past the finish; the racers need ${Math.round(finish.radius)} m to fly through the gate. Add a point beyond it.`,
      at: tuple(splinePointAt(spline, course.finish.t * L)),
      span: [course.finish.t, 1],
      metres: finish.radius - beyond,
    },
  ]
}

// ── The start pad and the racers beside it (DEV-475) ─────────────────────
//
// The pad is the one part of a course the ground decides, and the expansion
// never sees the ground: so these are the editor's to say. Every threshold is
// a pad's own or the core's. A pad's dish is `size[1]` tall (the sky's lift,
// 1.75 m); ground over that rim is ground in the dish, where the hull sits
// (`render/start-grid.ts`: the ship rides IN its dish). Air under the pad past
// the hover height is air the hover motor does not reach (`groundClearance`).
//
// The racers' starts are the game's own list (`game/racer-grid.ts`'s
// `racerStarts`, the one `game/racers.ts` spawns from), laid out over the
// expanded spawn by the desk (`desk/slots.ts`): 2016's two `ai` pads carried
// beside the player's, then the preset's slots. A start the ground buries is an ERROR: the expansion cannot
// see the ground, so the game would start a racer inside the hill, and a
// course that cannot be flown as drawn is refused rather than flown (a Matt
// call, DEVIATIONS DEV-475). One over the sea is a WARNING: its hover pad
// stands over the water at the grid's height, as `int_01`'s deck does, and
// flies.

/** A pad's footprint: the ground's lowest and highest under it, or null with no ground there. */
export const padFootprint = (
  ground: Ground,
  centre: readonly number[],
  size: readonly number[],
): { low: number; high: number } | null => {
  const r = Math.max(size[0] as number, size[2] as number) / 2
  const N = EDITOR_POLICY.padFootprintSamples
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  const take = (x: number, z: number): void => {
    const h = ground.surfaceAt(x, z)
    if (!Number.isFinite(h)) return
    if (h < low) low = h
    if (h > high) high = h
  }
  take(centre[0] as number, centre[2] as number)
  for (let k = 0; k < N; k++) {
    const a = (2 * Math.PI * k) / N
    take((centre[0] as number) + r * Math.cos(a), (centre[2] as number) + r * Math.sin(a))
  }
  return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : null
}

/**
 * The height the pad's foot should stand at over (x, z): the HIGHEST ground
 * under its footprint, so neither the dish nor the ship over it is ever in the
 * hill. A placement that cannot be wrong, where the centre's height would be
 * right on flat ground only (CLAUDE.md, DEV-041). Null with no ground there.
 * The desk seats the pad with this on every move.
 */
export const seatPadAt = (
  ground: Ground,
  x: number,
  z: number,
  size: readonly number[],
): number | null => padFootprint(ground, [x, 0, z], size)?.high ?? null

/** The size of the pad a course's ship stands on: the sky's lift. Null with no lift. */
export const padSizeOf = (donor: Level): readonly number[] | null =>
  (donor.spawn.launch?.platform?.size as readonly number[] | undefined) ?? null

/**
 * One racer's pad beside the start pad: its foot, level frame, and its size.
 * The desk lays these out with the game's own `racerStarts` (`desk/slots.ts`)
 * and hands them in: `game/racer-grid.ts` reaches the edition schema, which
 * reaches a render module, and the core reaches neither.
 */
export interface SlotPad {
  readonly foot: readonly number[]
  readonly size: readonly number[]
}

const padWarnings = (
  course: PlayerCourse,
  donor: Level,
  ground: Ground,
  slots: readonly SlotPad[],
): EditorWarning[] => {
  const out: EditorWarning[] = []
  const size = padSizeOf(donor)
  if (!size) return out
  const foot = course.start.pos
  const rim = size[1] as number
  const at: Vec3Tuple = [foot[0], foot[1], foot[2]]
  const under = padFootprint(ground, foot, size)
  if (under) {
    if (under.high > foot[1] + rim) {
      out.push({
        kind: 'pad-in-ground',
        severity: 'error',
        message: `The start pad is in the ground: it rises ${round1(under.high - foot[1])} m over the pad's foot.`,
        at,
        metres: under.high - foot[1],
      })
    } else if (foot[1] - under.low > groundClearance()) {
      const floats = foot[1] - under.high > groundClearance()
      out.push({
        kind: 'pad-slope',
        severity: 'warning',
        message: floats
          ? `The start pad floats ${round1(foot[1] - under.high)} m over the ground. Drag it to seat it.`
          : `The start pad stands on a slope: ${round1(foot[1] - under.low)} m of air under its low side.`,
        at,
        metres: foot[1] - under.low,
      })
    }
  }
  if (ground.waterAt?.(foot[0], foot[2])) {
    out.push({
      kind: 'pad-in-water',
      severity: 'warning',
      message: 'The start pad stands on the water.',
      at,
    })
  }
  slots.forEach((r, i) => {
    const place: Vec3Tuple = [r.foot[0] as number, r.foot[1] as number, r.foot[2] as number]
    const below = padFootprint(ground, r.foot, r.size)
    const padRim = r.size[1] as number
    if (below && below.high > place[1] + padRim) {
      out.push({
        kind: 'slot-in-ground',
        severity: 'error',
        message: `Racer ${i + 1}'s pad is in the ground (${round1(below.high - place[1] - padRim)} m over its rim). Move or turn the start pad.`,
        at: place,
        slot: i,
        metres: below.high - place[1] - padRim,
      })
    } else if (ground.waterAt?.(place[0], place[2])) {
      out.push({
        kind: 'slot-in-water',
        severity: 'warning',
        message: `Racer ${i + 1}'s pad stands over the water.`,
        at: place,
        slot: i,
      })
    }
  })
  return out
}

// ── DEV-486: the run-in, the straight from the pad to the line ────────────
//
// Matt, 2026-09-28, of DEV-478's "worth a look" note 2 (*"follow-up plz"*):
// the course starts on the pad (DEV-475) and flies to the line's first point
// along a straight nothing checked, and an AI racer stalled at the hairpin
// there. The straight is the expansion's own: `Level.route` begins at the
// ship on its pad (`playerCourseSpawn`'s release) and goes straight to the
// first point, when the two are more than a point quantum apart
// (`expandPlayerCourse`). So it is judged as part of the line:
//
//   · ITS GROUND, as the line's (`line-under-ground`, `line-near-ground`,
//     carrying `runIn` where the line's carry `span`), with one exception,
//     the TAKEOFF: the ship stands on its pad inside the hover height (2.2 m
//     over the dish, the hover height is 4) and the hover motor lifts it; so
//     the samples from the pad until the straight first stands clear of the
//     ground by the clearance are not "near" it. They can still be UNDER it.
//   · ITS TURNS (`run-in-turn`): the pad's heading onto the straight, and the
//     straight onto the line's first tangent, judged at cruise against
//     DEV-468's radius (`tightestTurnRadius`, no new number). A corner turned
//     through θ at radius R needs R·tan(θ/2) of straight on each side of it
//     (the fillet's tangent length). Both corners share the straight; the
//     corner at the first point also has the line up to the first ring (one
//     gap on, `placements`), where the jet must be on the line. So the
//     tightest radius the run-in lets the jet fly is
//
//        min( straight / (tan(θpad/2) + tan(θpoint/2)),  room / tan(θpoint/2) )
//
//     and a warning when that is under the cruise radius. Both corners are
//     judged in PLAN. The radius is DEV-027's lateral limit, measured in a
//     banked turn, and a HoverJet reverses by turning, not by looping: a
//     run-in that climbs off a hilltop pad and doubles back onto the line is
//     a 180° turn to fly, however steep its straight (in 3D it would read as
//     an easy half-loop, and it is the case racer 2 stalled at). A climb off
//     the pad is the lift-off. When the straight runs less than the hover
//     height across (a pad under its first point) it has no direction in
//     plan, and the one corner is the pad's heading onto the line, with the
//     line's room: `room / tan(θ/2)`.

/** The run-in: from the ship on its pad (`from`) to the line's first point (`to`), level frame. */
export interface RunIn {
  readonly from: Vec3
  readonly to: Vec3
  readonly length: number
}

/**
 * The course's run-in over `donor`, or null when it has none: no point yet, a
 * sky with no lift to stand a pad on, a donor of another island, or the ship
 * already within a point quantum of the first point (the expansion then adds
 * no straight to the route).
 */
export const runInOf = (course: PlayerCourse, donor: Level): RunIn | null => {
  const first = course.path.points[0]
  if (!first || donor.environment !== course.island) return null
  const spawn = playerCourseSpawn(course.start, donor)
  if (!spawn) return null
  const from = vec(spawn.pos)
  const to = vec(first)
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  return length > PLAYER_COURSE_SHAPE.pointQuantumMetres ? { from, to, length } : null
}

/** A sample of the run-in: its fraction along the straight and where it is. */
export interface RunInSample {
  readonly f: number
  readonly at: Vec3
}

/** The run-in sampled every `EDITOR_POLICY.runInSampleMetres` or finer, both ends included. */
export const runInSamples = (r: RunIn): RunInSample[] => {
  const n = Math.max(1, Math.ceil(r.length / EDITOR_POLICY.runInSampleMetres))
  const out: RunInSample[] = []
  for (let k = 0; k <= n; k++) {
    const f = k / n
    out.push({
      f,
      at: v3(
        r.from.x + (r.to.x - r.from.x) * f,
        r.from.y + (r.to.y - r.from.y) * f,
        r.from.z + (r.to.z - r.from.z) * f,
      ),
    })
  }
  return out
}

/**
 * Each run-in sample short of clear of `ground`, and by how much: under the
 * ground anywhere, or inside the clearance past the takeoff (above). `depth`
 * is `surface + clearance − y`, as the line's; `under` is `depth > clearance`.
 */
export const runInShortOfClear = (
  r: RunIn,
  ground: Ground,
  clearance: number,
): { readonly sample: RunInSample; readonly depth: number; readonly under: boolean }[] => {
  const samples = runInSamples(r)
  const depths = samples.map((s) => ground.surfaceAt(s.at.x, s.at.z) + clearance - s.at.y)
  let takeoff = depths.findIndex((d) => !(d > 0))
  if (takeoff < 0) takeoff = samples.length
  const out: { sample: RunInSample; depth: number; under: boolean }[] = []
  samples.forEach((sample, k) => {
    const depth = depths[k] as number
    const under = depth > clearance
    if (under || (k >= takeoff && depth > 0)) out.push({ sample, depth, under })
  })
  return out
}

const runInGroundWarnings = (
  r: RunIn,
  ground: Ground,
  clearance: number,
  anchored = false,
): EditorWarning[] => {
  // DEV-501: an anchored run-in is the pad's straight; Lift cannot raise its end.
  const pad = anchored ? ' It is anchored to the pad: turn or move the pad.' : ''
  const flag = anchored ? { anchored: true as const } : {}
  type Short = ReturnType<typeof runInShortOfClear>[number]
  const short = runInShortOfClear(r, ground, clearance)
  const step = 1 / Math.max(1, Math.ceil(r.length / EDITOR_POLICY.runInSampleMetres))
  // Consecutive samples, grouped as the line's are (`lineWarnings`): a stretch
  // that goes under reports just its samples under the ground, one that stays
  // over it reports as near.
  const group = (list: readonly Short[]): Short[][] => {
    const out: Short[][] = []
    for (const s of list) {
      const last = out[out.length - 1]
      const prev = last?.[last.length - 1]
      if (last && prev && s.sample.f - prev.sample.f < step * 1.5) last.push(s)
      else out.push([s])
    }
    return out
  }
  const worstOf = (run: readonly Short[]): Short =>
    run.reduce((w, s) => (s.depth > w.depth ? s : w), run[0] as Short)
  const spanOf = (run: readonly Short[]): [number, number] => [
    (run[0] as Short).sample.f,
    (run[run.length - 1] as Short).sample.f,
  ]
  const out: EditorWarning[] = []
  for (const run of group(short)) {
    const under = run.filter((s) => s.under)
    if (under.length === 0) {
      const worst = worstOf(run)
      out.push({
        kind: 'line-near-ground',
        severity: 'warning',
        message: `The run-in from the pad runs within ${round1(clearance)} m of the ground here; the jet hovers above it.${pad}`,
        at: tuple(worst.sample.at),
        runIn: spanOf(run),
        metres: worst.depth,
        ...flag,
      })
      continue
    }
    for (const stretch of group(under)) {
      const worst = worstOf(stretch)
      out.push({
        kind: 'line-under-ground',
        severity: 'warning',
        message: `The run-in from the pad runs ${round1(worst.depth - clearance)} m under the ground here.${pad}`,
        at: tuple(worst.sample.at),
        runIn: spanOf(stretch),
        metres: worst.depth,
        ...flag,
      })
    }
  }
  return out
}

/** The run-in's two corners and the tightest radius it lets the jet fly (see the block's header). */
export interface RunInTurn {
  /** Degrees between the pad's heading and the straight, in plan. */
  readonly padTurn: number
  /** Degrees between the straight and the line's first tangent. */
  readonly pointTurn: number
  /** The tightest radius, metres, the run-in lets the jet fly; Infinity when it turns nowhere. */
  readonly radius: number
  /** Which corner asks the most of it. */
  readonly corner: 'pad' | 'point'
  /** The line starts over the pad: the straight runs less than the hover height across. */
  readonly overPad: boolean
}

const angleBetween = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
  const la = Math.hypot(ax, ay, az)
  const lb = Math.hypot(bx, by, bz)
  if (!(la > 1e-9) || !(lb > 1e-9)) return 0
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb))))
}

/**
 * The run-in's turns for `course` over `donor` (the block's header), or null
 * where there is none to judge: no pad (a sky with no lift), a donor of
 * another island, or no line (fewer than two points) to turn onto.
 */
export const runInTurn = (
  course: PlayerCourse,
  donor: Level,
  spline: CourseSpline | null = splineOf(course),
): RunInTurn | null => {
  const first = course.path.points[0]
  if (!first || !spline || donor.environment !== course.island) return null
  const spawn = playerCourseSpawn(course.start, donor)
  if (!spawn) return null
  const t = splineTangentAt(spline, 0)
  if (!(Math.hypot(t.x, t.z) > 1e-9)) return null
  const h = yawForward(course.start.yaw)
  const dx = first[0] - (spawn.pos[0] as number)
  const dz = first[2] - (spawn.pos[2] as number)
  const across = Math.hypot(dx, dz)
  const room = Math.min(course.path.gap, spline.length)
  const cot = (theta: number): number => {
    const tan = Math.tan(theta / 2)
    return tan > 1e-12 ? 1 / tan : Infinity
  }
  if (across < groundClearance()) {
    // The line starts over the pad: the heading straight onto the line.
    const pad = angleBetween(h.x, 0, h.z, t.x, 0, t.z)
    return {
      padTurn: pad * DEG_PER_RAD,
      pointTurn: 0,
      radius: room * cot(pad),
      corner: 'pad',
      overPad: true,
    }
  }
  const pad = angleBetween(h.x, 0, h.z, dx, 0, dz)
  const point = angleBetween(dx, 0, dz, t.x, 0, t.z)
  const tanPad = Math.tan(pad / 2)
  const tanPoint = Math.tan(point / 2)
  const onStraight = tanPad + tanPoint > 1e-12 ? across / (tanPad + tanPoint) : Infinity
  const onLine = room * cot(point)
  return {
    padTurn: pad * DEG_PER_RAD,
    pointTurn: point * DEG_PER_RAD,
    radius: Math.min(onStraight, onLine),
    corner: onLine < onStraight || tanPoint > tanPad ? 'point' : 'pad',
    overPad: false,
  }
}

const runInTurnWarnings = (
  course: PlayerCourse,
  donor: Level,
  spline: CourseSpline,
): EditorWarning[] => {
  const turn = runInTurn(course, donor, spline)
  const limit = tightestTurnRadius()
  if (!turn || turn.radius >= limit) return []
  const at = turn.corner === 'pad' ? course.start.pos : course.path.points[0]
  return [
    {
      kind: 'run-in-turn',
      severity: 'warning',
      message:
        (turn.overPad
          ? `The line starts over the pad and turns ${Math.round(turn.padTurn)}° from where the ship faces.`
          : `The run-in turns too tightly: the pad faces ${Math.round(turn.padTurn)}° off it, and the line ` +
            `turns ${Math.round(turn.pointTurn)}° from it at point 1.`) +
        ` At cruise the jet turns no tighter than ${Math.round(limit)} m; this leaves it ${Math.round(turn.radius)} m.`,
      at: at ? [at[0], at[1], at[2]] : null,
      metres: turn.radius,
    },
  ]
}
// ── end DEV-486 ───────────────────────────────────────────────────────────

// ── DEV-503: the props ────────────────────────────────────────────────────

/** The props of `hits`, once each (the deepest meeting), in the order first met. */
const uniqueProps = (hits: readonly PropContact[]): PropContact[] => {
  const seen = new Map<number, PropContact>()
  for (const h of hits) {
    const had = seen.get(h.id)
    if (!had || h.depth > had.depth) seen.set(h.id, h)
  }
  return [...seen.values()]
}

/** "a spire", "2 props (spire, tree)": what a stretch passes. */
const propWords = (props: readonly PropContact[]): string => {
  if (props.length === 1) return `a ${(props[0] as PropContact).kind}`
  const kinds = [...new Set(props.map((p) => p.kind))].join(', ')
  return `${props.length} props (${kinds})`
}

/** One `line-through-prop` warning for a stretch whose segments met `hits`. */
const throughWarning = (
  hits: readonly PropContact[],
  reach: number,
  where: 'line' | 'run-in',
  place: { readonly span: [number, number] } | { readonly runIn: [number, number] },
): EditorWarning => {
  const props = uniqueProps(hits)
  const worst = props.reduce((w, p) => (p.depth > w.depth ? p : w), props[0] as PropContact)
  const gap = reach - worst.depth
  const what = where === 'line' ? 'The line' : 'The run-in from the pad'
  return {
    kind: 'line-through-prop',
    severity: 'warning',
    message:
      gap <= 0
        ? `${what} runs through ${propWords(props)} here.`
        : `${what} passes ${round1(gap)} m from ${propWords(props)} here; the jet needs ${round1(reach)} m.`,
    at: [...worst.at] as Vec3Tuple,
    ...place,
    metres: worst.depth,
    props: props.map((p) => [...p.at] as Vec3Tuple),
  }
}

/** A run of consecutive segments that met props: where it starts and ends, and what it met. */
interface PropRun {
  from: number
  to: number
  readonly hits: PropContact[]
}

/**
 * Stretches of the flown line (the run-in, then the curve from its first
 * point to the finish) within `propReach()` of a colliding prop: one warning
 * per stretch of consecutive segments that meet any, with a marker on each
 * prop it passes. The curve's segments are the spline's own samples (the ones
 * `lineWarnings` judges the ground at); the run-in's, `runInSamples`.
 */
const propLineWarnings = (
  course: PlayerCourse,
  donor: Level,
  spline: CourseSpline,
  props: Props,
): EditorWarning[] => {
  const reach = propReach()
  const out: EditorWarning[] = []
  // The run-in, by its fractions.
  const r = runInOf(course, donor)
  if (r) {
    const samples = runInSamples(r)
    let run: PropRun | null = null
    const close = (open: PropRun): void => {
      out.push(throughWarning(open.hits, reach, 'run-in', { runIn: [open.from, open.to] }))
    }
    for (let k = 0; k + 1 < samples.length; k++) {
      const a = samples[k] as RunInSample
      const b = samples[k + 1] as RunInSample
      const hits = props.near(tuple(a.at), tuple(b.at), reach)
      if (hits.length > 0) {
        if (!run) run = { from: a.f, to: b.f, hits: [] }
        run.to = b.f
        run.hits.push(...hits)
      } else if (run) {
        close(run)
        run = null
      }
    }
    if (run) close(run)
  }
  // The curve, first point to finish, by its path parameter.
  const L = spline.length
  const [i0, i1] = sampleRange(spline, 0, course.finish.t * L)
  let run: PropRun | null = null
  const close = (open: PropRun): void => {
    out.push(
      throughWarning(open.hits, reach, 'line', {
        span: [(spline.arc[open.from] as number) / L, (spline.arc[open.to] as number) / L],
      }),
    )
  }
  for (let i = i0; i < i1; i++) {
    const hits = props.near(
      tuple(spline.samples[i] as Vec3),
      tuple(spline.samples[i + 1] as Vec3),
      reach,
    )
    if (hits.length > 0) {
      if (!run) run = { from: i, to: i + 1, hits: [] }
      run.to = i + 1
      run.hits.push(...hits)
    } else if (run) {
      close(run)
      run = null
    }
  }
  if (run) close(run)
  return out
}

/**
 * A colliding prop within the clearance of a ring's OPENING: the disc of its
 * trigger standing across the line, the one `ringIntrusion` judges the ground
 * against. The disc is asked for as segments, the rim's chords
 * (`ringOpeningRim`, the circle drawn red) and a spoke from the centre to each
 * rim point, so a prop anywhere in the disc is within the clearance of one.
 * An ERROR (the brief's rec, as `ring-in-ground`): the racers fly the ring's
 * centre, and a player aims through it.
 */
const propRingWarnings = (level: Level, props: Props): EditorWarning[] => {
  const clearance = groundClearance()
  const out: EditorWarning[] = []
  liveRings(level).forEach((ring, index) => {
    const rim = ringOpeningRim(ring)
    const c = [...ring.trigger.pos] as Vec3Tuple
    const hits: PropContact[] = []
    rim.forEach((p, k) => {
      hits.push(...props.near(c, p, clearance))
      hits.push(...props.near(p, rim[(k + 1) % rim.length] as Vec3Tuple, clearance))
    })
    if (hits.length === 0) return
    const found = uniqueProps(hits)
    const worst = found.reduce((w, p) => (p.depth > w.depth ? p : w), found[0] as PropContact)
    out.push({
      kind: 'ring-in-prop',
      severity: 'error',
      message: `Ring ${index + 1}: ${propWords(found)} reaches into its opening.`,
      at: [...worst.at] as Vec3Tuple,
      ring: index,
      metres: worst.depth,
      props: found.map((p) => [...p.at] as Vec3Tuple),
    })
  })
  return out
}
// ── end DEV-503 ───────────────────────────────────────────────────────────

// ── The validator's refusal ───────────────────────────────────────────────

const POINT_PATH = /^path\.points\[(\d+)\]$/
/** DEV-504: `props[3]`, `props[3].scale`: the placed prop a refusal is about. */
const PROP_PATH = /^props\[(\d+)\]/

/**
 * DEV-889: the validator's raw `path.points: must hold 2 to 64 points, not 1`
 * said as a sentence a first-time author can act on. Null for every other
 * refusal, which keeps its `path: message` form.
 */
const playerWords = (path: string, _message: string, course: PlayerCourse): string | null => {
  if (path !== 'path.points') return null
  const L = PLAYER_COURSE_LIMITS.points
  const n = course.path.points.length
  if (n < L.min) {
    return n === 0
      ? `Click the ground to place the first of at least ${L.min} points.`
      : `Add a second point to make a course (a course needs at least ${L.min}).`
  }
  return `A course holds at most ${L.max} points: delete some.`
}

const invalidWarnings = (
  course: PlayerCourse,
  issues: readonly PlayerCourseIssue[],
  shown: {
    readonly points: ReadonlySet<number>
    readonly curve: boolean
    readonly pad: boolean
  },
): EditorWarning[] => {
  const out: EditorWarning[] = []
  for (const [path, message] of issues) {
    const m = POINT_PATH.exec(path)
    const point = m ? Number(m[1]) : null
    // Already said, with a place, by the play-area check.
    if (point !== null && shown.points.has(point)) continue
    if (path === 'path' && shown.curve) continue
    if (path === 'start.pos' && shown.pad) continue
    const p = point !== null ? course.path.points[point] : undefined
    // DEV-504: a placed prop's refusal is drawn at the prop.
    const pm = PROP_PATH.exec(path)
    const prop = pm ? Number(pm[1]) : null
    const pp = prop !== null ? course.props?.[prop] : undefined
    const where = p ?? pp?.pos
    out.push({
      kind: 'invalid',
      severity: 'error',
      message: playerWords(path, message, course) ?? `${path || 'course'}: ${message}`,
      at: where ? [where[0], where[1], where[2]] : null,
      path,
      ...(point !== null ? { point } : {}),
      ...(prop !== null && pp ? { prop } : {}),
    })
  }
  return out
}

const SEVERITY_ORDER: Record<WarningSeverity, number> = { error: 0, warning: 1, note: 2 }

/**
 * Everything the editor should show about `draft`, over `donor` (the level its
 * sky names) and `ground` (the render surface), and the racers' pads beside
 * the start pad, `slots` (`desk/slots.ts` lays them out with the game's own
 * `racerStarts`; none, and the pad alone is judged), and the world's colliding
 * `props` (DEV-503; null, and none is judged). Pure; never throws.
 */
export const evaluateDraft = (
  draft: EditorDraft,
  donor: Level,
  ground: Ground,
  slots: readonly SlotPad[] = [],
  props: Props | null = null,
): DraftEvaluation => {
  const course = draft.course
  const checked = validatePlayerCourse(course, donor)
  const spline = splineOf(course)
  const area = donor.environment === course.island ? playerCourseArea(donor) : null
  const warnings: EditorWarning[] = []

  const outside = area ? outsideWarnings(course, area, spline) : []
  warnings.push(...outside)
  const shown = {
    points: new Set(outside.flatMap((w) => (w.point === undefined ? [] : [w.point]))),
    curve: outside.some((w) => w.kind === 'curve-outside'),
    pad: outside.some((w) => w.kind === 'pad-outside'),
  }
  if (!checked.ok) warnings.push(...invalidWarnings(course, checked.errors, shown))

  let level: Level | null = null
  if (checked.ok) {
    try {
      level = expandPlayerCourse(checked.course, donor)
    } catch {
      level = null
    }
  }

  const clearance = groundClearance()
  const safely = <T>(f: () => T[]): T[] => {
    try {
      return f()
    } catch {
      return []
    }
  }
  if (level) {
    const anchor = course.path.anchor ? (course.path.points[0] ?? null) : null
    warnings.push(...safely(() => ringWarnings(level as Level, ground, clearance, anchor)))
  }
  if (donor.environment === course.island) {
    warnings.push(...safely(() => padWarnings(course, donor, ground, slots)))
  }
  if (spline) {
    warnings.push(...safely(() => lineWarnings(course, spline, ground, clearance)))
    warnings.push(...safely(() => turnWarnings(course, spline)))
    if (level) warnings.push(...safely(() => runoffWarnings(course, spline, level as Level)))
  }
  // DEV-486: the run-in, its ground and its turns.
  // Judged with the line it leads onto, as the line's own checks are: a lone
  // point is not a course yet, and Lift (two points or more) could not act.
  const runIn = spline ? runInOf(course, donor) : null
  if (runIn) {
    const pinned = course.path.anchor !== undefined // DEV-501
    warnings.push(...safely(() => runInGroundWarnings(runIn, ground, clearance, pinned)))
  }
  if (spline) warnings.push(...safely(() => runInTurnWarnings(course, donor, spline)))
  // DEV-503: the props the line and the rings come near.
  if (props && spline && donor.environment === course.island) {
    warnings.push(...safely(() => propLineWarnings(course, donor, spline, props)))
  }
  if (props && level) warnings.push(...safely(() => propRingWarnings(level as Level, props)))

  warnings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return {
    courseId: safeCourseId(course),
    course: checked.ok ? checked.course : null,
    level,
    warnings,
  }
}
