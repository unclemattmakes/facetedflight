// src/game/tv/tv-vantage.ts: where a headset stands to watch a race. DEV-481.
//
// Faceted Flight TV (plan/FF-TV.md §5.3). In a headset the camera never moves
// the wearer between cuts: Director and Follow are shown from TRACKSIDE
// VANTAGE POINTS, fixed eyes beside the course, with a cut through black from
// one to the next. This module is the list of those eyes for one course, and
// the route arithmetic the camera reads progress off.
//
// ── Pure ──────────────────────────────────────────────────────────────────
//
// No three, no DOM, no clock. Everything the world knows comes in as a
// function: `heightAt(x, z)` (the higher of the RENDERED surface and the
// collision surface, land or sea, THREE world, −∞ off the map) and an
// optional `obstructed(x, y, z, r)` for the props a sphere would touch. So
// `tests/unit/tv-vantage.test.ts` sweeps every HoverJet Ring Attack course in
// node against the real height maps and the real forest.
//
// ── The placement, and why it prefers what cannot be wrong ────────────────
//
// Per ring, in course order: an eye a little DOWNSTREAM of the ring, off to
// one side of the racing line and a little above the ring's height, facing UP
// the course (back along the route towards the craft that are coming) so a
// racer flies at the wearer, through the ring, and past. Candidates are tried
// in a fixed order (side, distance, height), and the first that passes every
// test is the vantage:
//
//   * clear of the ground by `clearance` over a DISK around the eye, not at
//     one point: the eye stands beside a slope, and a single sample at its
//     foot misses the hillside a metre away (CLAUDE.md's heightField trap:
//     the gap between what you hit and what you see is FACETISATION, up to
//     21.8 m on steep desert, which is why `heightAt` must carry the render
//     surface and why the disk is sampled at all);
//   * not inside a prop (`obstructed`), the spires included;
//   * inside the course's bounds;
//   * able to SEE the ring: a sightline sampled above the ground all the way.
//
// If no candidate passes, the eye goes ABOVE EVERYTHING: straight over the
// ring, higher than the highest ground for 150 m round it by a wide margin,
// and raised again while a prop is in the way. The title camera's lesson
// (CLAUDE.md, DEV-041): four attempts to place an eye by walking sightlines
// all put it somewhere the render disagreed with, and the fix was a placement
// where occlusion is impossible rather than unlikely. Such a vantage is
// `lifted: true`, and the sweep reports how many there are.
//
// ── Frames ────────────────────────────────────────────────────────────────
//
// Everything here is THREE world, the frame the level JSON is written in
// (`level.route`, ring positions) and the rig lives in. A YAW is three's: 0
// looks down −Z, positive turns LEFT (towards −X), as `Euler(0, yaw, 0)` does:
// the same convention as `editor/desk/fly.ts`.

import { type Level, liveRings } from '@/content/level-schema'
import { eyeInGateFrame, finishFrameScale, type GateFrame } from './tv-framing'

/** A point, THREE world. */
export type Vec3T = readonly [number, number, number]

/** The higher of the rendered and collision surfaces at (x, z), THREE world; −∞ off the map. */
export type HeightAt = (x: number, z: number) => number

/** Does a sphere of radius `r` at (x, y, z), THREE world, touch a prop? */
export type Obstructed = (x: number, y: number, z: number, r: number) => boolean

/** The volume the camera stays inside: the course's play area, THREE world. */
export interface TvBounds {
  readonly centre: Vec3T
  readonly radius: number
}

/** What a vantage list is built from. All THREE world. */
export interface TvCourse {
  /** The racing line, in course order (`level.route`). Runs past the finish on 2016's courses. */
  readonly route: readonly Vec3T[]
  /** The rings' centres, in course order (`liveRings(level)`, their trigger centres). */
  readonly gates: readonly Vec3T[]
  /** Where the race starts (the spawn, or the grid's centre), or null. */
  readonly start: Vec3T | null
  /** The finish's centre, or null for a course with none. */
  readonly finish: Vec3T | null
  /**
   * DEV-652: every gate frame's SOLID (the rings', then the finish's), so no eye
   * is put inside one (`tv-framing.ts`). Absent: no gate is avoided.
   */
  readonly gateFrames?: readonly GateFrame[]
}

/** One trackside eye. */
export interface Vantage {
  /** The eye, THREE world. */
  readonly eye: Vec3T
  /** The rig's yaw at this vantage: level, facing up the course (three's convention, see the header). */
  readonly yaw: number
  /** Arc length along the route of the thing it watches (its ring, the start, the finish), metres. */
  readonly arc: number
  /** Which anchor: a ring's index, or `'start'` / `'finish'`. */
  readonly anchor: number | 'start' | 'finish'
  /** True when no trackside candidate passed and the eye went above everything. */
  readonly lifted: boolean
}

export interface VantageWorld {
  readonly heightAt: HeightAt
  readonly obstructed?: Obstructed | undefined
  readonly bounds?: TvBounds | null | undefined
  /** DEV-652: the gate frames an eye must keep out of; absent: none. */
  readonly gates?: readonly GateFrame[] | undefined
}

/**
 * The policy, by name, so a test pins it and the report quotes it. Metres and
 * seconds. These are a camera operator's choices, not 2016 data: nothing here
 * is a game constant (hard rule 3 governs the sim's numbers, not a framing).
 */
export const VANTAGE_POLICY = {
  /** The least air between the eye and the highest ground in its disk. */
  clearance: 8,
  /** The disk the clearance is measured over: its radius, and how many samples on its rim. */
  diskRadius: 14,
  diskSamples: 12,
  /** The sphere `obstructed` is asked about: a head with room round it. */
  eyeRadius: 4,
  /** Sideways off the racing line, tried in this order (positive is the route's right). */
  lateral: [45, -45, 70, -70, 100, -100] as const,
  /** Downstream of the ring along the route, tried in this order. */
  downstream: [30, 0, 70] as const,
  /** Above the ring's centre, tried in this order. */
  above: [8, 22, 45] as const,
  /** How far UP the route (back towards the coming craft) the eye faces. */
  lookBack: 160,
  /** The sightline to the ring: samples, and the air each must keep above the ground. */
  sightSamples: 20,
  sightClearance: 2,
  /** Above everything: the ground searched round the anchor, and the margin over it. */
  liftSearch: 150,
  liftMargin: 60,
  /** Raised by this much at a time while a prop is still in the way, up to `liftTries` times. */
  liftStep: 40,
  liftTries: 12,
  /** Two vantages closer along the route than this keep only the first. */
  minSpacing: 60,
} as const

// ── the route ──────────────────────────────────────────────────────────────

/** A polyline with its arc lengths. */
export interface Route {
  readonly points: readonly Vec3T[]
  /** `arcs[i]` is the arc length at `points[i]`. */
  readonly arcs: Float64Array
  readonly length: number
}

export const buildRoute = (points: readonly Vec3T[]): Route => {
  const arcs = new Float64Array(points.length)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3T
    const b = points[i] as Vec3T
    arcs[i] = (arcs[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return { points, arcs, length: points.length > 0 ? (arcs[points.length - 1] as number) : 0 }
}

/** Where on the route a point is nearest: the arc, the segment, and how far off it is. */
export interface RouteFix {
  arc: number
  segment: number
  distance: number
}

/**
 * The nearest point of the route to (x, y, z). With `hint` (a segment index
 * from the last fix) only `window` segments either side are searched, so a
 * route that passes near itself does not swap a craft onto its other leg; a
 * fix further than `rejoin` metres off the window searches the whole route.
 */
export const projectOnRoute = (
  route: Route,
  x: number,
  y: number,
  z: number,
  hint = -1,
  out: RouteFix = { arc: 0, segment: 0, distance: Number.POSITIVE_INFINITY },
  window = 40,
  rejoin = 120,
): RouteFix => {
  const n = route.points.length
  out.arc = 0
  out.segment = 0
  out.distance = Number.POSITIVE_INFINITY
  if (n === 0) return out
  if (n === 1) {
    const p = route.points[0] as Vec3T
    out.distance = Math.hypot(x - p[0], y - p[1], z - p[2])
    return out
  }
  const search = (lo: number, hi: number): void => {
    for (let i = Math.max(0, lo); i < Math.min(n - 1, hi); i++) {
      const a = route.points[i] as Vec3T
      const b = route.points[i + 1] as Vec3T
      const ex = b[0] - a[0]
      const ey = b[1] - a[1]
      const ez = b[2] - a[2]
      const ll = ex * ex + ey * ey + ez * ez
      let t = ll > 0 ? ((x - a[0]) * ex + (y - a[1]) * ey + (z - a[2]) * ez) / ll : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const d = Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y, a[2] + ez * t - z)
      if (d < out.distance) {
        out.distance = d
        out.segment = i
        out.arc = (route.arcs[i] as number) + t * Math.sqrt(ll)
      }
    }
  }
  if (hint >= 0) {
    search(hint - window, hint + window + 1)
    if (out.distance <= rejoin) return out
    out.distance = Number.POSITIVE_INFINITY
  }
  search(0, n - 1)
  return out
}

/** The route's point at arc `s` (clamped to its ends), into `out`. */
export const routePointAt = (
  route: Route,
  s: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] => {
  const n = route.points.length
  if (n === 0) {
    out[0] = out[1] = out[2] = 0
    return out
  }
  if (s <= 0 || n === 1) {
    const p = route.points[0] as Vec3T
    out[0] = p[0]
    out[1] = p[1]
    out[2] = p[2]
    return out
  }
  if (s >= route.length) {
    const p = route.points[n - 1] as Vec3T
    out[0] = p[0]
    out[1] = p[1]
    out[2] = p[2]
    return out
  }
  // Binary search for the segment holding s.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((route.arcs[mid] as number) <= s) lo = mid
    else hi = mid
  }
  const a = route.points[lo] as Vec3T
  const b = route.points[hi] as Vec3T
  const span = (route.arcs[hi] as number) - (route.arcs[lo] as number)
  const t = span > 0 ? (s - (route.arcs[lo] as number)) / span : 0
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/** The route's LEVEL direction at arc `s`, unit, as (x, z); (0, −1) where it has none. */
export const routeHeadingAt = (route: Route, s: number, span = 20): [number, number] => {
  const a = routePointAt(route, s - span)
  const b = routePointAt(route, s + span)
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const len = Math.hypot(dx, dz)
  return len > 1e-6 ? [dx / len, dz / len] : [0, -1]
}

/** Three's yaw for a level view from (fx, fz) towards (tx, tz): 0 looks down −Z. */
export const yawTowards = (fx: number, fz: number, tx: number, tz: number): number =>
  Math.atan2(-(tx - fx), -(tz - fz))

// ── the tests a candidate passes ──────────────────────────────────────────

/** The highest ground in a disk of `radius` round (x, z): the centre and `samples` on the rim, and half-way in. */
export const groundInDisk = (
  heightAt: HeightAt,
  x: number,
  z: number,
  radius: number,
  samples: number,
): number => {
  let top = heightAt(x, z)
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    const h1 = heightAt(x + c * radius, z + s * radius)
    const h2 = heightAt(x + c * radius * 0.5, z + s * radius * 0.5)
    if (h1 > top) top = h1
    if (h2 > top) top = h2
  }
  return top
}

const insideBounds = (b: TvBounds | null | undefined, x: number, y: number, z: number): boolean =>
  !b || Math.hypot(x - b.centre[0], y - b.centre[1], z - b.centre[2]) <= b.radius

/** Is every sample of the segment a→b at least `air` above the ground? */
export const sightClear = (
  heightAt: HeightAt,
  a: Vec3T,
  b: Vec3T,
  samples: number,
  air: number,
): boolean => {
  for (let i = 1; i < samples; i++) {
    const t = i / samples
    const x = a[0] + (b[0] - a[0]) * t
    const y = a[1] + (b[1] - a[1]) * t
    const z = a[2] + (b[2] - a[2]) * t
    if (y < heightAt(x, z) + air) return false
  }
  return true
}

/** Does `eye` pass every test a trackside vantage must? Exported for the sweep's report. */
export const vantageClear = (world: VantageWorld, eye: Vec3T, watches: Vec3T | null): boolean => {
  const p = VANTAGE_POLICY
  const ground = groundInDisk(world.heightAt, eye[0], eye[2], p.diskRadius, p.diskSamples)
  // Off the map the ground is −∞ and any eye clears it; NaN fails.
  if (!(eye[1] - ground >= p.clearance)) return false
  if (!insideBounds(world.bounds, eye[0], eye[1], eye[2])) return false
  if (world.obstructed?.(eye[0], eye[1], eye[2], p.eyeRadius)) return false
  // DEV-652: not in a gate's frame: the tube is 17 m deep and its bars fill a picture.
  if (world.gates && eyeInGateFrame(world.gates, eye) >= 0) return false
  if (watches && !sightClear(world.heightAt, eye, watches, p.sightSamples, p.sightClearance))
    return false
  return true
}

/**
 * Above everything over `anchor`: higher than the highest ground for
 * `liftSearch` metres round it by `liftMargin`, then raised while a prop is
 * in the way. The placement that cannot be wrong (see the header).
 */
const liftedEye = (world: VantageWorld, anchor: Vec3T): [number, number, number] => {
  const p = VANTAGE_POLICY
  let top = Number.NEGATIVE_INFINITY
  for (const r of [0, p.liftSearch / 3, (2 * p.liftSearch) / 3, p.liftSearch]) {
    const g = groundInDisk(world.heightAt, anchor[0], anchor[2], r, r === 0 ? 1 : 16)
    if (g > top) top = g
  }
  const base = Number.isFinite(top) ? Math.max(anchor[1], top) : anchor[1]
  const eye: [number, number, number] = [anchor[0], base + p.liftMargin, anchor[2]]
  for (let i = 0; i < p.liftTries; i++) {
    if (!world.obstructed?.(eye[0], eye[1], eye[2], p.eyeRadius)) break
    eye[1] += p.liftStep
  }
  return eye
}

/**
 * One vantage for the thing at arc `arc` on the route (`watches`, its centre):
 * the first trackside candidate that passes, or above everything.
 */
const vantageFor = (
  world: VantageWorld,
  route: Route,
  arc: number,
  watches: Vec3T,
  anchor: Vantage['anchor'],
  faceTowards: Vec3T | null,
): Vantage => {
  const p = VANTAGE_POLICY
  const back = routePointAt(route, arc - p.lookBack)
  for (const down of p.downstream) {
    const base = routePointAt(route, arc + down)
    const [hx, hz] = routeHeadingAt(route, arc + down)
    // The route's right, level: forward (hx, hz) turned a quarter clockwise seen from above.
    const rx = -hz
    const rz = hx
    for (const above of p.above) {
      for (const side of p.lateral) {
        const eye: Vec3T = [base[0] + rx * side, watches[1] + above, base[2] + rz * side]
        if (!vantageClear(world, eye, watches)) continue
        const face = faceTowards ?? back
        return {
          eye,
          yaw: yawTowards(eye[0], eye[2], face[0], face[2]),
          arc,
          anchor,
          lifted: false,
        }
      }
    }
  }
  const eye = liftedEye(world, watches)
  const face = faceTowards ?? back
  // Straight over the anchor, the face point can be under the eye; face up the route instead.
  const [hx, hz] = routeHeadingAt(route, arc)
  const yaw =
    Math.hypot(face[0] - eye[0], face[2] - eye[2]) > 1
      ? yawTowards(eye[0], eye[2], face[0], face[2])
      : yawTowards(0, 0, -hx, -hz)
  return { eye, yaw, arc, anchor, lifted: true }
}

/**
 * Every vantage for `course`, in course order (ascending `arc`): one for the
 * start (facing the grid), one per ring, one for the finish.
 */
export const buildVantages = (course: TvCourse, worldIn: VantageWorld): Vantage[] => {
  // DEV-652: the course's gate frames are avoided unless the caller named its own.
  const world: VantageWorld =
    worldIn.gates !== undefined || !course.gateFrames
      ? worldIn
      : { ...worldIn, gates: course.gateFrames }
  const route = buildRoute(course.route)
  if (route.points.length < 2) return []
  const fix: RouteFix = { arc: 0, segment: 0, distance: 0 }
  const out: Vantage[] = []
  if (course.start) {
    // The start: beside the line's first point, facing the grid.
    const first = route.points[0] as Vec3T
    out.push(vantageFor(world, route, 0, first, 'start', course.start))
  }
  let hint = -1
  course.gates.forEach((g, i) => {
    projectOnRoute(route, g[0], g[1], g[2], hint, fix, 80, 200)
    hint = fix.segment
    out.push(vantageFor(world, route, fix.arc, g, i, null))
  })
  if (course.finish) {
    const f = course.finish
    projectOnRoute(route, f[0], f[1], f[2], -1, fix)
    out.push(vantageFor(world, route, fix.arc, f, 'finish', null))
  }
  out.sort((a, b) => a.arc - b.arc)
  // Too close along the route to be two shots: keep the first.
  const kept: Vantage[] = []
  for (const v of out) {
    const last = kept[kept.length - 1]
    if (last && v.arc - last.arc < VANTAGE_POLICY.minSpacing && v.anchor !== 'finish') continue
    kept.push(v)
  }
  return kept
}

// ── a level, as a TV course ────────────────────────────────────────────────

/**
 * A level's TV course. The level JSON is THREE world, the frame everything
 * here is in. The start is the RESPAWN marker where there is one: the spawn is
 * the bottom of the elevator shaft, ~20 to ~95 m underground by design
 * (CLAUDE.md, trap 23), and an eye facing it would face a hillside.
 */
export const tvCourseOf = (level: Level): TvCourse => ({
  route: (level.route ?? []) as readonly Vec3T[],
  gates: liveRings(level).map((r) => r.trigger.pos as unknown as Vec3T),
  start: (level.respawn?.pos ?? level.spawn?.pos ?? null) as Vec3T | null,
  finish: (level.finish?.pos as Vec3T | undefined) ?? null,
  gateFrames: gateFramesOf(level),
})

/**
 * DEV-652: every gate frame's solid in `level`: each live ring at its own pose
 * and scale (as `game/rings.ts` composes it), then the finish's frame at its
 * art pose (orientation-blind, see `tv-framing.ts`).
 */
export const gateFramesOf = (level: Level): GateFrame[] => {
  const frames: GateFrame[] = liveRings(level).map((r) => ({
    pos: r.pos as unknown as Vec3T,
    quat: r.quat as unknown as GateFrame['quat'],
    scale: r.scale[0] as number,
  }))
  const finish = level.finish
  const art = finish?.shape === 'sphereUnion' ? finish.art?.frame : undefined
  if (art) {
    frames.push({
      pos: art.pos as unknown as Vec3T,
      quat: art.quat as unknown as GateFrame['quat'],
      scale: finishFrameScale(art.scale[0] as number),
      tall: true,
    })
  }
  return frames
}

/**
 * A level's play area as TV's bounds: the boundary's sphere (THREE world, as
 * `boot/app.ts` hands it to the sim through `threeTupleToUnity`), whether or not
 * the mission enforces it: it is where the course was authored to be flown.
 * Null for a mission with no sphere.
 */
export const tvBoundsOf = (level: Level): TvBounds | null => {
  const v = level.boundary?.volume
  if (v?.shape !== 'sphere' || typeof v.radius !== 'number') return null
  return { centre: v.centre as unknown as Vec3T, radius: v.radius }
}
