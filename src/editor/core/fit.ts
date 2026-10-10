// src/editor/core/fit.ts — fly-to-author: a recorded flight becomes the line.
// DEV-491 (docs/plan/EDITOR-WAVE-3.md; EDITOR.md §5.3 step 2, "Fly it").
//
// *"This is 2016's Recording mode handed to players."* 2016 made its ghosts by
// flying the course with the Motion Recorder running (`Level.GameModeEnum.
// Recording`); here a player flies free over the island, the pose recorder
// (DEV-370, `sim/ghost-record.ts`) keeps the flight, and this file turns the
// flight into a course:
//
//   recordingLevel(course, donor)   the flight: FREE FLIGHT over the donor's
//                                   island (no clock, no tank, nothing to end
//                                   it), no rings, the donor's boundary, from
//                                   the draft's own start pad
//   flightOfClip(clip, offset)      a recording as world points: a player's lap
//                                   doc or one of 2016's ghosts, the same way
//   fitFlight(points)               Douglas–Peucker, then the format's own
//                                   Catmull-Rom refined until the line lies
//                                   within FIT_POLICY.toleranceMetres of the
//                                   flight, both ways, in at most 64 points
//   applyFit(draft, fit, …)         the draft with that line, its pad at the
//                                   flight's start aimed along it, and the
//                                   finish one gate's radius before the end:
//                                   ONE command, so ONE undo step
//
// ── The fit, and why it is not Douglas–Peucker alone ──────────────────────
//
// Douglas–Peucker keeps the recorded points a POLYLINE needs to stay within ε
// of the flight. The course is not a polyline: it is the uniform Catmull-Rom
// through its points (`content/course-spline.ts`, tension 0.5), which bulges
// past a corner the polyline cuts and cuts a bend the polyline follows. A
// polyline also needs far more points: on 2016's `int_01` flights DP alone is
// past the format's 64 at any tolerance under a trigger radius. So DP only
// SEEDS the points, coarsely, and the curve itself is then measured against
// the flight, span by span: the worst span is halved (at its arc midpoint)
// until every span is inside the tolerance, and then every point the curve can
// do without is dropped. The measure is TWO-SIDED — every recorded point near
// the line, and every point of the line near the flight — because a
// Catmull-Rom overshoot is a stretch of line nobody flew, and a one-sided test
// (flight → line) cannot see it.
//
// And the spans are kept BALANCED (`spanRatio`), because the curve is UNIFORM
// Catmull-Rom: a short span beside a long one loops, and no point added inside
// the short one mends it (policy below).
//
// Spans are measured against their own stretch of flight: the flight between
// control points k and k+1 against the curve's segment k. A flight that
// crosses itself (a figure of eight) is then never matched to the wrong pass,
// which a nearest-point search over the whole line would do.
//
// THREE-FREE AND DOM-FREE, as the rest of the core: the recording arrives as a
// `GhostClip` (the sim's), the ground as the core's injected `Ground`.

import { buildCourseSpline, splineTangentAt } from '@/content/course-spline'
import type { Level, Vec3Tuple } from '@/content/level-schema'
import {
  anchored,
  normaliseYaw,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  type PlayerCourse,
  playerCourseSpawn,
  playerCourseSpline,
  startStandUp,
} from '@/content/player-course'
import { withCourseWater } from '@/game/terrain/course-water'
import { customGroundOf, withCustomGround } from '@/game/terrain/custom-ground'
import { FIXED_DT } from '@/sim/constants'
import { GHOST_STRIDE, type GhostClip } from '@/sim/ghost'
import type { EditorDraft } from './draft'
import { type Ground, padSizeOf, seatPadAt } from './warnings'

/**
 * Every number the fit decides. Pinned by value in `tests/unit/editor-fit.test.ts`
 * (the `EDITOR_POLICY` pattern): moving one is an edit made there on purpose.
 */
export const FIT_POLICY = {
  /**
   * The most the fitted line may stray from the flight, metres, either way.
   *
   * A ring stands ON the line, so a flight within this of the line passed
   * within this of every ring's centre. It is under HALF the trigger radius
   * of every shipped HoverJet ring (22.62 m, asserted in the test), so the
   * flight that made the course would have taken every ring on it with more
   * than a trigger radius's half to spare — and the test re-scores 2016's own
   * `int_01` ghost on the course fitted from it to show that it does. Tighter
   * costs points: both of 2016's `int_01` flights (12 and 15 km) fit inside the
   * format's 64 at this, and the test holds them there.
   */
  toleranceMetres: 8,
  /**
   * The flight is resampled to this arc spacing before the fit, metres: TWICE
   * the format's least point spacing (`pointSpacingMetres.min`, 5), so no two
   * control points it picks can quantise closer than the validator allows.
   * A recorded corner between two samples sits at most s²/8R off their chord:
   * 0.25 m at 10 m on the HoverJet's tightest cruise radius (~50 m).
   */
  sampleSpacingFactor: 2,
  /**
   * Douglas–Peucker seeds the fit at this many tolerances: coarse, so it finds
   * the flight's corners without keeping the points a POLYLINE would need
   * (which on 2016's `int_01` flights is past the format's 64 at any
   * tolerance under a trigger radius). The curve's own refinement adds the
   * rest. Chosen by measuring 1, 2, 4 and 8 on both `int_01` flights: 4 met
   * the tolerance on both inside 64 points, the others did not on one of them.
   */
  seedFactor: 4,
  /**
   * The most one span may be longer than the span beside it, in flight arc.
   * The format's curve is UNIFORM Catmull-Rom, whose tangent at a point is
   * half the chord between its neighbours: a 10 m span beside a 500 m one
   * leaves with a 250 m tangent and loops. On 2016's `int_01` flights an
   * unbalanced fit stalled with spans 43–115 m off the flight that no added
   * point could mend; balanced, every span converges.
   */
  spanRatio: 3,
  /**
   * A flight whose line needs more than the format's 64 points at the
   * tolerance is fitted again this much wider, until it fits.
   */
  widenBy: 1.25,
} as const

/** Metres between the flight's resampled points: the format's own least spacing, doubled. */
export const fitSampleMetres = (): number =>
  PLAYER_COURSE_LIMITS.pointSpacingMetres.min * FIT_POLICY.sampleSpacingFactor

// ── The flight ─────────────────────────────────────────────────────────────

/** The level id a recording flight is flown under: the sky's, marked. Never listed, never kept. */
export const recordingLevelId = (donor: Level): string => `rec_${donor.id}`

/**
 * The level a recording is flown in: Free Flight over the donor's island, from
 * `course.start` (the draft's pad, the lift already at the top, as a playtest
 * leaves it: `playerCourseSpawn`), inside the donor's boundary, with no rings,
 * no finish and no racing line. Free Flight's own rules (`game/modes.ts`): no
 * clock, no tank, nothing ends it, no opponents — and no autopilot, which has
 * nothing to fly there (DEV-435). Null where the sky has no lift to copy.
 *
 * The donor's orbs are left out too: Free Flight scores them, and a recording
 * is not a run.
 */
export const recordingLevel = (course: PlayerCourse, donor: Level): Level | null => {
  const spawn = playerCourseSpawn(course.start, donor)
  if (!spawn) return null
  const clone = <T>(v: T): T => structuredClone(v)
  const pose = { pos: [...spawn.pos], quat: [...spawn.quat], yaw: spawn.yaw }
  // No racing line and no listing: the flight has no course yet.
  const { route: _route, listed: _listed, ...rest } = clone(donor)
  const level = {
    ...rest,
    id: recordingLevelId(donor),
    title: 'Recording',
    chainIndex: null,
    mode: 'freeFlight',
    forcedMode: 'freeFlight',
    forcedModeFf2: null,
    spawn,
    respawn: clone(pose) as Level['respawn'],
    routes: [{ id: 'recording', rings: [] }],
    finish: null,
    orbs: [],
    pads: [],
    turnIndicators: [],
    props: [],
    ghosts: [],
    ambientTraffic: null,
  } as Level
  // DEV-490: a clone drops a custom ground (custom-ground.ts), so it is handed
  // on, as playtestLevel does: the recording flies over the island being edited.
  const ground = customGroundOf(donor)
  const grounded = ground ? withCustomGround(level, ground) : level
  // DEV-500: and over the course's water.
  return course.water ? withCourseWater(grounded, course.water) : grounded
}

/** A recorded flight, as the fit takes it: world (level-frame) points in time order. */
export interface Flight {
  readonly points: readonly Vec3Tuple[]
  /** Seconds the points span. */
  readonly seconds: number
}

/**
 * A recording as world points: `clip`'s keys from `from` seconds on, placed at
 * `worldOffset` (a ghost's positions are relative to it, `sim/ghost.ts`), and
 * cut at the first RESET — a crash or a boundary respawn PUTS the ship
 * somewhere, and the jump into it is no path anyone flew. One reader for a
 * player's recording and 2016's ghosts alike (2016's carry no events).
 */
export const flightOfClip = (clip: GhostClip, worldOffset: readonly number[], from = 0): Flight => {
  const d = clip.data
  const firstReset = clip.events.find((e) => e.kind === 'reset')
  const cut = firstReset ? firstReset.tick * FIXED_DT : Number.POSITIVE_INFINITY
  const [ox, oy, oz] = [worldOffset[0] ?? 0, worldOffset[1] ?? 0, worldOffset[2] ?? 0]
  const points: Vec3Tuple[] = []
  let t0 = Number.NaN
  let t1 = Number.NaN
  for (let k = 0; k < clip.keyCount; k++) {
    const o = k * GHOST_STRIDE
    const t = d[o] as number
    if (t < from) continue
    if (t >= cut) break
    if (Number.isNaN(t0)) t0 = t
    t1 = t
    points.push([ox + (d[o + 1] as number), oy + (d[o + 2] as number), oz + (d[o + 3] as number)])
  }
  return { points, seconds: Number.isNaN(t0) ? 0 : t1 - t0 }
}

// ── The fit ────────────────────────────────────────────────────────────────

type P = readonly [number, number, number]

const dist = (a: P, b: P): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)

/** Distance from `p` to the segment `a`–`b`. */
const toSegment = (p: P, a: P, b: P): number => {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const abz = b[2] - a[2]
  const ll = abx * abx + aby * aby + abz * abz
  const t =
    ll > 0
      ? Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / ll),
        )
      : 0
  return Math.sqrt(
    (a[0] + abx * t - p[0]) ** 2 + (a[1] + aby * t - p[1]) ** 2 + (a[2] + abz * t - p[2]) ** 2,
  )
}

/** Distance from `p` to the polyline `line[from..to]`. */
const toPolyline = (p: P, line: readonly P[], from: number, to: number): number => {
  if (to <= from) return dist(p, line[from] as P)
  let best = Number.POSITIVE_INFINITY
  for (let i = from; i < to; i++) {
    const d = toSegment(p, line[i] as P, line[i + 1] as P)
    if (d < best) best = d
  }
  return best
}

/**
 * `points` resampled to `spacing` metres of arc, first and last kept. A ship
 * held still (on the pad, a pause) adds no arc and so no samples.
 */
export const resampleFlight = (points: readonly Vec3Tuple[], spacing: number): Vec3Tuple[] => {
  const first = points[0]
  if (!first) return []
  const out: Vec3Tuple[] = [[first[0], first[1], first[2]]]
  let carried = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P
    const b = points[i] as P
    const len = dist(a, b)
    if (!(len > 0)) continue
    let s = spacing - carried
    while (s <= len) {
      const u = s / len
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u])
      s += spacing
    }
    carried = len - (s - spacing)
  }
  const last = points[points.length - 1] as P
  const tail = out[out.length - 1] as P
  // The flight's own end, unless the last sample already stands on it.
  if (dist(tail, last) > spacing / 2) out.push([last[0], last[1], last[2]])
  else out[out.length - 1] = [last[0], last[1], last[2]]
  return out
}

/** Douglas–Peucker: the indices a polyline within `epsilon` of `line` keeps. First and last always. */
export const douglasPeucker = (line: readonly P[], epsilon: number): number[] => {
  const n = line.length
  if (n <= 2) return n === 0 ? [] : n === 1 ? [0] : [0, 1]
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number]
    let worst = -1
    let worstD = epsilon
    for (let i = a + 1; i < b; i++) {
      const d = toSegment(line[i] as P, line[a] as P, line[b] as P)
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

/** A coordinate on the format's point grid, as `player-course.ts` quantises it. */
const onGrid = (x: number): number => {
  const per = Math.round(1 / PLAYER_COURSE_SHAPE.pointQuantumMetres)
  const q = Math.round(x * per) / per
  return Object.is(q, -0) ? 0 : q
}
const gridPoint = (p: P): Vec3Tuple => [onGrid(p[0]), onGrid(p[1]), onGrid(p[2])]

/**
 * Segment `j` of the course's curve through `controls`, sampled as the format
 * samples it. A uniform Catmull-Rom segment depends on its two ends and their
 * outer neighbours only, so it is built from those (up to four) points alone
 * — the same samples the whole curve has there, at a fraction of the cost.
 */
const segmentOf = (controls: readonly Vec3Tuple[], j: number): P[] => {
  const from = Math.max(0, j - 1)
  const around = controls.slice(from, Math.min(controls.length, j + 3))
  const div = PLAYER_COURSE_SHAPE.divisionsPerSegment
  const k = j - from
  return buildCourseSpline(
    around.map((p) => ({ x: p[0], y: p[1], z: p[2] })),
    { divisionsPerSegment: div, tension: PLAYER_COURSE_SHAPE.tension },
  )
    .samples.slice(k * div, (k + 1) * div + 1)
    .map((q) => [q.x, q.y, q.z] as const)
}

/**
 * How far span `j` (control points `idx[j]` to `idx[j+1]`) strays, metres,
 * measured both ways: every sample of the flight between them against the
 * curve's segment `j`, and every sample of that segment against the flight
 * between them.
 */
const spanError = (flight: readonly P[], idx: readonly number[], j: number): number => {
  const from = Math.max(0, j - 1)
  const to = Math.min(idx.length, j + 3)
  const controls = idx.slice(from, to).map((i) => gridPoint(flight[i] as P))
  const seg = segmentOf(controls, j - from)
  const a = idx[j] as number
  const b = idx[j + 1] as number
  let metres = 0
  for (let i = a; i <= b; i++) {
    metres = Math.max(metres, toPolyline(flight[i] as P, seg, 0, seg.length - 1))
  }
  for (const q of seg) metres = Math.max(metres, toPolyline(q, flight, a, b))
  return metres
}

/** What a fit made of a flight. */
export interface FlightFit {
  /** The control points, on the format's grid, in flight order. */
  readonly points: readonly Vec3Tuple[]
  /** The most the line strays from the flight, either way, metres. */
  readonly error: number
  /** `error` is inside the tolerance asked for. False only when the points ran out first. */
  readonly withinTolerance: boolean
  readonly tolerance: number
  /** The flight as it was fitted (resampled), for drawing and for the spec. */
  readonly flight: readonly Vec3Tuple[]
}

/**
 * The points a curve within `tolerance` of `flight` needs: Douglas–Peucker
 * seeds it, the spans are balanced, then the worst span is halved until every
 * span is inside `tolerance`, and last every point the curve can do without is
 * dropped. Indices into `flight`, first and last always kept.
 */
const fitIndices = (flight: readonly P[], tolerance: number): number[] => {
  const ratio = FIT_POLICY.spanRatio
  // A span's error depends on its two ends and their outer neighbours only,
  // so it is kept by those four indices and measured once.
  const known = new Map<string, number>()
  const errorOf = (ix: readonly number[], j: number): number => {
    const key = [ix[j - 1] ?? -1, ix[j], ix[j + 1], ix[j + 2] ?? -1].join(',')
    let e = known.get(key)
    if (e === undefined) {
      e = spanError(flight, ix, j)
      known.set(key, e)
    }
    return e
  }
  const worstOf = (ix: readonly number[]): { metres: number; j: number } => {
    let worst = { metres: 0, j: -1 }
    for (let j = 0; j + 1 < ix.length; j++) {
      const metres = errorOf(ix, j)
      if (metres > worst.metres) worst = { metres, j }
    }
    return worst
  }
  const span = (ix: readonly number[], j: number): number =>
    (ix[j + 1] as number) - (ix[j] as number)
  /** Halve span `j` at its arc midpoint (the flight is resampled evenly, so index is arc). */
  const halve = (ix: number[], j: number): boolean => {
    const a = ix[j] as number
    const b = ix[j + 1] as number
    if (b - a < 2) return false
    ix.splice(j + 1, 0, (a + b) >> 1)
    return true
  }
  /** Is span `j` more than `ratio` times a neighbour? */
  const lopsided = (ix: readonly number[], j: number): boolean => {
    const s = span(ix, j)
    return (
      (j > 0 && s > ratio * span(ix, j - 1)) || (j + 2 < ix.length && s > ratio * span(ix, j + 1))
    )
  }
  const balance = (ix: number[]): void => {
    for (let changed = true; changed; ) {
      changed = false
      for (let j = 0; j + 1 < ix.length; j++) if (lopsided(ix, j) && halve(ix, j)) changed = true
    }
  }
  const idx = douglasPeucker(flight, tolerance * FIT_POLICY.seedFactor)
  balance(idx)
  // Each round adds a point, and a span of one sample cannot be halved, so
  // this ends by the flight's own length at the latest.
  for (let round = 0; round < flight.length; round++) {
    const worst = worstOf(idx)
    if (worst.metres <= tolerance || !halve(idx, worst.j)) break
    balance(idx)
  }
  // Drop what the curve can do without, keeping the spans balanced.
  for (let k = 1; k + 1 < idx.length; ) {
    const without = [...idx.slice(0, k), ...idx.slice(k + 1)]
    const near = [k - 2, k - 1, k].filter((j) => j >= 0 && j + 1 < without.length)
    if (!near.some((j) => lopsided(without, j)) && worstOf(without).metres <= tolerance) {
      idx.splice(k, 1)
    } else {
      k++
    }
  }
  return idx
}

/**
 * Fit the format's curve to a flight, within `tolerance` both ways. A flight
 * whose line needs more than the format's `points.max` at that tolerance is
 * fitted at a WIDER one instead — the whole flight at the tolerance it fits
 * in, rather than the first 64 points of it — and says so
 * (`withinTolerance: false`, and `tolerance` is the one it met). Null for a
 * flight too short to be a line (under two samples once resampled).
 */
export const fitFlight = (
  points: readonly Vec3Tuple[],
  tolerance: number = FIT_POLICY.toleranceMetres,
): FlightFit | null => {
  const flight = resampleFlight(points, fitSampleMetres())
  if (flight.length < 2) return null
  const max = PLAYER_COURSE_LIMITS.points.max
  for (let tol = tolerance; ; tol *= FIT_POLICY.widenBy) {
    const idx = fitIndices(flight, tol)
    if (idx.length <= max) {
      const controls = idx.map((i) => gridPoint(flight[i] as P))
      let error = 0
      for (let j = 0; j + 1 < idx.length; j++) error = Math.max(error, spanError(flight, idx, j))
      return { points: controls, error, withinTolerance: tol === tolerance, tolerance: tol, flight }
    }
  }
}

// ── Into the draft ─────────────────────────────────────────────────────────

/**
 * DEV-501: for an anchored draft, the pad's heading along the flight — toward
 * the first recorded place a `gap` from its start in plan — and the fitted
 * points past that place, and past the least spacing from it. Null where the
 * flight never gets a gap from its start, or leaves no point past it.
 */
const anchoredFlight = (
  fit: FlightFit,
  first: Vec3Tuple,
  gap: number,
): { yaw: number; rest: Vec3Tuple[] } | null => {
  const f = fit.flight
  const j = f.findIndex((p) => Math.hypot(p[0] - first[0], p[2] - first[2]) >= gap)
  if (j < 0) return null
  const at = f[j] as Vec3Tuple
  const yaw = normaliseYaw(headingOf(at[0] - first[0], at[2] - first[2]))
  const indexOf = (p: Vec3Tuple): number => {
    let best = 0
    let bestD = Infinity
    f.forEach((q, i) => {
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }
  const spacing = PLAYER_COURSE_LIMITS.pointSpacingMetres.min
  const rest = fit.points.filter(
    (p) => indexOf(p) > j && Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) >= spacing,
  )
  return rest.length > 0 ? { yaw, rest } : null
}

/** The heading, degrees in 2016's spawn convention, of travel along `(dx, dz)`. */
const headingOf = (dx: number, dz: number): number => (Math.atan2(-dx, -dz) * 180) / Math.PI

/**
 * The draft with the fitted line: its points, the pad on the ground under the
 * flight's start and aimed along the line's first stretch, the finish one
 * finish-gate radius before the line's end (so the racers fly through it
 * rather than stopping in it: `warnings.ts`'s runoff note), no ring skips (their
 * places were on the old line), and a time limit no shorter than the flight
 * took. The gap, the sky, the name and the light are the draft's own.
 *
 * `ground` seats the pad as the desk seats every pad (`seatPadAt`); with none,
 * the pad's foot is the flight's start less the sky's lift height. Pure: ONE
 * new draft, so the whole fit is one undo step.
 */
export const applyFit = (
  draft: EditorDraft,
  fit: FlightFit,
  donor: Level,
  ground: Ground | null,
  seconds: number,
): EditorDraft => {
  let points = fit.points.slice(0, PLAYER_COURSE_LIMITS.points.max)
  const first = points[0]
  if (!first || points.length < PLAYER_COURSE_LIMITS.points.min) return draft
  const c = draft.course
  const spline0 = playerCourseSpline({ ...c, path: { ...c.path, points } })
  // The heading along the line's own tangent where it starts: the pad stands
  // under point 1, so the run-in is the line starting over the pad, which
  // DEV-486's `runInTurn` judges by exactly this tangent against the heading.
  const t0 = splineTangentAt(spline0, 0)
  let yaw = Math.hypot(t0.x, t0.z) > 1e-9 ? normaliseYaw(headingOf(t0.x, t0.z)) : c.start.yaw
  // ── DEV-501: an anchored draft ───────────────────────────────────────────
  // The pad still stands at the flight's start, aimed ALONG THE FLIGHT: at the
  // first recorded place one gap from the start in plan, so the pad's point
  // (one gap ahead of it) lies over the flight. The fitted points up to that
  // place are the pad's stretch now and are dropped; the rest are the fit's.
  const anchor = c.path.anchor ? anchoredFlight(fit, first, c.path.gap) : null
  if (anchor) {
    yaw = anchor.yaw
    points = [first, ...anchor.rest]
  }
  // ── end DEV-501 ──────────────────────────────────────────────────────────
  const size = padSizeOf(donor)
  const seated = ground && size ? seatPadAt(ground, first[0], first[2], size) : null
  const footY = seated ?? first[1] - (startStandUp(donor) ?? 0)
  const start = { pos: [first[0], footY, first[2]] as Vec3Tuple, yaw }
  if (anchor) points = anchored({ ...c, start, path: { ...c.path, points } }).path.points.slice()
  const spline = anchor ? playerCourseSpline({ ...c, start, path: { ...c.path, points } }) : spline0
  const L = spline.length
  const radius = donor.finish?.radius ?? 0
  const T = PLAYER_COURSE_LIMITS.timeLimitSeconds
  const tFinish = L > 2 * radius && radius > 0 ? 1 - radius / L : 1
  const q = PLAYER_COURSE_SHAPE.tQuantum
  return {
    ...draft,
    course: {
      ...c,
      path: { ...c.path, points },
      rings: [],
      start,
      finish: { t: Math.max(q, Math.floor(tFinish / q) / Math.round(1 / q)) },
      timeLimit: Math.min(T.max, Math.max(c.timeLimit, Math.ceil(seconds))),
    },
    selection: null,
  }
}
