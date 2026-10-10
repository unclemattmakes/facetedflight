// src/render/lift-seal.ts — the world stays outside the shaft (DEV-460).
//
// Matt, 2026-09-27: *"something i'd like you to take a stab at is the geo-switch
// when going up elevators - right now player eyes visibly collde through geo
// (like the ocean)"*.
//
// ── What 2016 did at the crossing ─────────────────────────────────────────
//
// Nothing that runs. `LaunchElevator.cs` parents the ship to the lift and turns
// its Animator on; `elevator_up.anim` is three position curves with
// `m_Events: []`; the only switch on the ride is `Trigger_EnableTerrain`
// (`render/elevator.ts`'s `REVEAL_RISE`), and its `disabledUntilTriggered` is
// null in the prefab and in every shipped scene (DEV-094). So in the shipped
// game the island and the sea were drawn for the whole ride, back-face culled,
// and the eye came up THROUGH them: invisible from below, there around you the
// moment you broke the surface. The "geo-switch" was designed and had rotted.
//
// ── What the port had, and why it still collided ──────────────────────────
//
// The port finished 2016's switch: the land near the shaft waits until the lift
// is above it (`revealRiseFor`, DEV-106/249) and the sea is cut out of the bore
// per fragment (`render/water.ts` `setShaftBore`). Both were sized off the
// GENERATED tube — a round bore 6.78 m about the SHIP — and both went on being
// sized that way when DEV-438 stood 2016's shaft in its place. 2016's shaft is
// not round and not on the ship: its axis is the lift's, 1.3 m behind the ship,
// and it is a square with its corners let out — its inside runs from 5.6 m to
// 9.4 m about that axis. So the sea's surface was drawn INSIDE the shaft in
// every corner the old hole did not reach, and it met the eye there as a flat
// plane at eye level through the Simonet crossing; and on land the ground in the
// shaft came on at the reveal and stayed there, seen down the gap between the
// lift's dish and the walls.
//
// And 2016's own geometry collided with itself: every 12 m the shaft has a
// catwalk ring whose inner edge comes to 3.8 m of the axis, and the lift's dish
// is 4.7 m across its half. The dish (and the ship's wing roots) went THROUGH a
// catwalk eight times a ride, as 2016's went through segment 08's once.
//
// ── What this does ────────────────────────────────────────────────────────
//
//   the column  2016's shaft is cleared inside the lift's own column — the
//               dish's footprint, extruded — so nothing of the shaft stands in
//               the lift's way (`trimColumn`). The ship stands inside its dish.
//   the hole    the sea's hole is centred on the LIFT and has the shaft's own
//               OUTLINE, read off the art per degree (`sectionAt`,
//               `interiorReach`) and handed to `render/water.ts` as a table
//               per world azimuth (`holeTableFor`). A circle wide enough for
//               the corners would open the sea 3.7 m past the thin walls.
//   the hatch   a floor across the shaft at the height of the world it keeps
//               out — the highest ground in the shaft plus its jitter, or the
//               sea's ceiling, never above the rim (`worldTopIn`,
//               `hatchHeightOf`) — with the column as its opening. The lift
//               rises through it and plugs it; everything below the hatch is
//               then behind the dish or the hatch from any eye above them, both
//               eyes and any lean (`hatchGeometry`). At the rim it is also the
//               cap over the walls DEV-443 cut open; below it, a ring caps them
//               (`ringGeometry`).
//   the lid     the column closed at the hatch, drawn once the deck has gone
//               at the release (`lidGeometry`, `render/elevator.ts`).
//   the switch  the sea's hole closes when the dish's foot reaches the hatch
//               (`LiftSeal.sealRise`), and the land in the shaft comes on no
//               earlier than that — so the switch happens under a closed floor.
//
// The hatch and the cap are appended to the shaft's own geometry: the same
// unlit baked material, no new draw, no new program; the lid is one draw of
// that program. Everything here is in `launch-anchor`'s frame (the ship at rest
// at the origin), the frame 2016's art arrives in.

import * as THREE from 'three'
import { lerp } from '@/sim/math/scalar'
import { grayscale } from '@/sim/terrain/faceted'
import { type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'

/** A point in the horizontal plane, `launch-anchor`'s frame. */
export interface Xz {
  readonly x: number
  readonly z: number
}

/** Metres the column is grown past the dish's footprint, so a trim never grazes it. */
export const COLUMN_MARGIN = 0.1
/** Metres the sea's hole reaches past the inside of 2016's wall, at every azimuth. */
export const BORE_MARGIN = 0.25
/** Metres the hatch's edge is tucked into the wall, so no gap shows at its rim. */
export const HATCH_TUCK = 0.15
/**
 * Azimuths a section is read at: one a degree. The shaft's inside is a square
 * with its corners let out to 9.4 m, and a corner is a peak of the reach; at
 * one degree a chord across one misses the tip by under 0.2 m, inside
 * `BORE_MARGIN` and `HATCH_TUCK`.
 */
export const SECTION_STEPS = 360
/** The hatch's colour if the shaft has none near it: 2016's painted shaft, baked, roughly. */
const UNLIT_SHAFT: readonly [number, number, number] = [0.02, 0.02, 0.03]

const cross = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx

/**
 * The convex hull of `points`, counter-clockwise in (x, z) — positive shoelace
 * area — by Andrew's monotone chain. Collinear points are dropped.
 */
export const hullXZ = (points: readonly Xz[]): Xz[] => {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  if (sorted.length < 3) return sorted
  const turn = (o: Xz, a: Xz, b: Xz) => cross(a.x - o.x, a.z - o.z, b.x - o.x, b.z - o.z)
  const lower: Xz[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && turn(lower.at(-2) as Xz, lower.at(-1) as Xz, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Xz[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as Xz
    while (upper.length >= 2 && turn(upper.at(-2) as Xz, upper.at(-1) as Xz, p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** The horizontal footprint of a geometry: the hull of every vertex's (x, z). */
export const footprintOf = (geometry: THREE.BufferGeometry): Xz[] => {
  const p = geometry.getAttribute('position')
  const points: Xz[] = []
  for (let i = 0; i < p.count; i++) points.push({ x: p.getX(i), z: p.getZ(i) })
  return hullXZ(points)
}

/**
 * `hull` grown outward by `margin`: the hull of a ring of points round each
 * corner. Convex, and never inside the Minkowski sum by more than the ring's
 * chord sag (0.8 % of `margin` at sixteen points).
 */
export const grownHull = (hull: readonly Xz[], margin: number): Xz[] => {
  const ring: Xz[] = []
  for (const c of hull) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      ring.push({ x: c.x + Math.cos(a) * margin, z: c.z + Math.sin(a) * margin })
    }
  }
  return hullXZ(ring)
}

/** The area centroid of a simple polygon. */
export const centroidOf = (polygon: readonly Xz[]): Xz => {
  let area = 0
  let cx = 0
  let cz = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Xz
    const b = polygon[(i + 1) % polygon.length] as Xz
    const w = cross(a.x, a.z, b.x, b.z)
    area += w
    cx += (a.x + b.x) * w
    cz += (a.z + b.z) * w
  }
  return area === 0 ? { x: 0, z: 0 } : { x: cx / (3 * area), z: cz / (3 * area) }
}

/**
 * Distance from `centre` to the boundary of the convex polygon along azimuth
 * `theta` (x = cos, z = sin). `centre` must be inside it.
 */
export const reachAlong = (polygon: readonly Xz[], centre: Xz, theta: number): number => {
  const dx = Math.cos(theta)
  const dz = Math.sin(theta)
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Xz
    const b = polygon[(i + 1) % polygon.length] as Xz
    const ex = b.x - a.x
    const ez = b.z - a.z
    const denom = cross(dx, dz, ex, ez)
    if (Math.abs(denom) < 1e-12) continue
    const wx = a.x - centre.x
    const wz = a.z - centre.z
    const t = cross(wx, wz, ex, ez) / denom
    const s = cross(wx, wz, dx, dz) / denom
    if (t >= 0 && s >= -1e-9 && s <= 1 + 1e-9 && t < best) best = t
  }
  return best
}

// ── the column ─────────────────────────────────────────────────────────────

type Corner = number[][]

/**
 * `source` with everything inside the vertical prism over `column` (convex,
 * counter-clockwise) removed: a triangle wholly outside is kept as it is, one
 * wholly inside is dropped, and one crossing the prism's walls is cut against
 * them and kept outside — split into the pieces outside each wall in turn, every
 * attribute interpolated along the cut and the winding kept. DEV-443's
 * `trimAbove` against a vertical prism instead of a plane.
 *
 * Returns `source` itself when nothing of it is inside.
 */
export const trimColumn = (
  source: THREE.BufferGeometry,
  column: readonly Xz[],
): THREE.BufferGeometry => {
  if (column.length < 3) return source
  const flat = source.index ? source.toNonIndexed() : source
  const names = Object.keys(flat.attributes)
  const attributes = names.map((name) => flat.getAttribute(name))
  const at = names.indexOf('position')
  const position = flat.getAttribute('position')
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const c of column) {
    minX = Math.min(minX, c.x)
    maxX = Math.max(maxX, c.x)
    minZ = Math.min(minZ, c.z)
    maxZ = Math.max(maxZ, c.z)
  }
  // The signed distance of a corner from wall `i`: positive inside the column.
  const side = (i: number, v: Corner): number => {
    const a = column[i] as Xz
    const b = column[(i + 1) % column.length] as Xz
    const p = v[at] as number[]
    return cross(b.x - a.x, b.z - a.z, (p[0] as number) - a.x, (p[2] as number) - a.z)
  }
  const corner = (i: number): Corner =>
    attributes.map((a) => {
      const v: number[] = []
      for (let k = 0; k < a.itemSize; k++) v.push(a.getComponent(i, k))
      return v
    })
  const between = (a: Corner, b: Corner, s: number): Corner =>
    a.map((va, n) => va.map((x, k) => x + (((b[n] as number[])[k] as number) - x) * s))
  /** Sutherland-Hodgman against wall `i`, keeping `keep(d)` of its signed distance. */
  const clip = (poly: Corner[], i: number, inside: boolean): Corner[] => {
    const out: Corner[] = []
    const d = poly.map((v) => (inside ? side(i, v) : -side(i, v)))
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k] as Corner
      const b = poly[(k + 1) % poly.length] as Corner
      const da = d[k] as number
      const db = d[(k + 1) % poly.length] as number
      if (da >= 0) out.push(a)
      if (da >= 0 !== db >= 0) out.push(between(a, b, da / (da - db)))
    }
    return out
  }
  const out = names.map(() => [] as number[])
  const emit = (poly: Corner[]): void => {
    for (let k = 1; k + 1 < poly.length; k++) {
      for (const v of [poly[0], poly[k], poly[k + 1]] as Corner[]) {
        v.forEach((values, n) => {
          ;(out[n] as number[]).push(...values)
        })
      }
    }
  }
  /** Copy a triangle through untouched, attribute by attribute: the common case. */
  const keep = (t: number): void => {
    attributes.forEach((a, n) => {
      const o = out[n] as number[]
      for (let i = t; i < t + 3; i++)
        for (let k = 0; k < a.itemSize; k++) o.push(a.getComponent(i, k))
    })
  }
  const outsideWall = (i: number, t: number): boolean => {
    const a = column[i] as Xz
    const b = column[(i + 1) % column.length] as Xz
    for (let k = t; k < t + 3; k++) {
      if (cross(b.x - a.x, b.z - a.z, position.getX(k) - a.x, position.getZ(k) - a.z) > 0)
        return false
    }
    return true
  }
  let touched = false
  for (let t = 0; t + 2 < position.count; t += 3) {
    const x0 = position.getX(t)
    const x1 = position.getX(t + 1)
    const x2 = position.getX(t + 2)
    const z0 = position.getZ(t)
    const z1 = position.getZ(t + 1)
    const z2 = position.getZ(t + 2)
    const clear =
      Math.max(x0, x1, x2) <= minX ||
      Math.min(x0, x1, x2) >= maxX ||
      Math.max(z0, z1, z2) <= minZ ||
      Math.min(z0, z1, z2) >= maxZ ||
      column.some((_, i) => outsideWall(i, t))
    if (clear) {
      keep(t)
      continue
    }
    const tri = [corner(t), corner(t + 1), corner(t + 2)]
    touched = true
    let remaining: Corner[] = tri
    for (let i = 0; i < column.length && remaining.length >= 3; i++) {
      const outside = clip(remaining, i, false)
      if (outside.length >= 3) emit(outside)
      remaining = clip(remaining, i, true)
    }
  }
  if (!touched) return source
  const trimmed = new THREE.BufferGeometry()
  names.forEach((name, n) => {
    const a = attributes[n] as THREE.BufferAttribute
    trimmed.setAttribute(
      name,
      new THREE.Float32BufferAttribute(out[n] as number[], a.itemSize, a.normalized),
    )
  })
  trimmed.computeBoundingBox()
  trimmed.computeBoundingSphere()
  if (flat !== source) flat.dispose()
  return trimmed
}

// ── the column's walls, where the cut opened a solid (DEV-551) ─────────────

/**
 * The faces `trimColumn` opened, closed: on each wall of the convex `column`,
 * the cross-section of whatever the cut went through, filled.
 *
 * Matt, 2026-09-30, on DEV-460's call that *"the catwalks lose the part of
 * their ring inside the lift's column"*: *"fix as you'd recommend"*. The cut is
 * right — the dish went through a catwalk eight times a ride — and what it left
 * was not: a catwalk is a solid, and a solid cut down a wall is an OPEN SHELL,
 * its inside showing through the cut (DEV-460 drew the rig double-sided so that
 * at least the inside was drawn, rather than the wall behind it). A boolean cut
 * closes the solid with the cutter's own surface, and that is what this is: each
 * catwalk ends in a flat face on the column's wall, so it reads as a ring BUILT
 * round the car's path — which is what a shaft's catwalk is.
 *
 * How, exactly rather than by sampling: every edge of `trimmed` lying on a wall
 * (both ends within `ON_WALL` of its plane) is a cut edge, and together they
 * outline the cross-section. Along the wall, between consecutive cut-edge ends,
 * the set of edges a vertical line crosses does not change, so the
 * cross-section there is a stack of trapezoids: crossings sorted by height and
 * paired, inside between the first and second, the third and fourth (even-odd).
 * A stretch where the count is odd — an edge with no partner, a single-sided
 * panel cut — is left open rather than guessed at. Each trapezoid faces INTO
 * the column, the cut's outward side, and takes its colour from the cut edges
 * above and below it, which carry the cut faces' own interpolated colour.
 *
 * Returns null when nothing was cut. `trimmed` must be the non-indexed output
 * of `trimColumn` with position and colour.
 */
export const capColumn = (
  trimmed: THREE.BufferGeometry,
  column: readonly Xz[],
): Triangles | null => {
  const p = trimmed.getAttribute('position')
  const c = trimmed.getAttribute('color')
  if (!p || column.length < 3) return null
  interface Cut {
    s0: number
    y0: number
    s1: number
    y1: number
    c0: [number, number, number]
    c1: [number, number, number]
  }
  const walls: Cut[][] = column.map(() => [])
  const colour = (i: number): [number, number, number] =>
    c ? [c.getX(i), c.getY(i), c.getZ(i)] : [UNLIT_SHAFT[0], UNLIT_SHAFT[1], UNLIT_SHAFT[2]]
  const lengths = column.map((a, w) => {
    const b = column[(w + 1) % column.length] as Xz
    return Math.hypot(b.x - a.x, b.z - a.z)
  })
  // Distance off wall `w`'s plane (positive inside), and the place along it, 0..1.
  const off = (w: number, i: number) => {
    const a = column[w] as Xz
    const b = column[(w + 1) % column.length] as Xz
    return cross(b.x - a.x, b.z - a.z, p.getX(i) - a.x, p.getZ(i) - a.z) / (lengths[w] as number)
  }
  const along = (w: number, i: number) => {
    const a = column[w] as Xz
    const b = column[(w + 1) % column.length] as Xz
    const L = lengths[w] as number
    return ((p.getX(i) - a.x) * (b.x - a.x) + (p.getZ(i) - a.z) * (b.z - a.z)) / (L * L)
  }
  for (let t = 0; t + 2 < p.count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i0 = t + k
      const i1 = t + ((k + 1) % 3)
      for (let w = 0; w < column.length; w++) {
        if (Math.abs(off(w, i0)) > ON_WALL || Math.abs(off(w, i1)) > ON_WALL) continue
        const s0 = along(w, i0)
        const s1 = along(w, i1)
        if (Math.abs(s1 - s0) < 1e-9) continue // vertical: a crossing, not a span
        const [a, b] = s0 < s1 ? [i0, i1] : [i1, i0]
        const lo = Math.min(s0, s1)
        const hi = Math.max(s0, s1)
        // Only the wall itself: past its ends the plane is outside the column,
        // and what lies there is the seam between two pieces of one cut
        // triangle (cut against this wall, then the next), not a cut face.
        if (hi <= 1e-9 || lo >= 1 - 1e-9) continue
        const yAt = (s: number) => p.getY(a) + ((p.getY(b) - p.getY(a)) * (s - lo)) / (hi - lo)
        const cAt = (s: number): [number, number, number] => {
          const f = (s - lo) / (hi - lo)
          const ca = colour(a)
          const cb = colour(b)
          return [
            ca[0] + (cb[0] - ca[0]) * f,
            ca[1] + (cb[1] - ca[1]) * f,
            ca[2] + (cb[2] - ca[2]) * f,
          ]
        }
        const from = Math.max(0, lo)
        const to = Math.min(1, hi)
        ;(walls[w] as Cut[]).push({
          s0: from,
          y0: yAt(from),
          s1: to,
          y1: yAt(to),
          c0: cAt(from),
          c1: cAt(to),
        })
      }
    }
  }
  const positions: number[] = []
  const colors: number[] = []
  const at = (w: number, s: number, y: number): [number, number, number] => {
    const a = column[w] as Xz
    const b = column[(w + 1) % column.length] as Xz
    return [a.x + (b.x - a.x) * s, y, a.z + (b.z - a.z) * s]
  }
  for (let w = 0; w < column.length; w++) {
    const cuts = walls[w] as Cut[]
    if (cuts.length < 2) continue
    const breaks = [...new Set(cuts.flatMap((e) => [e.s0, e.s1]))].sort((x, y) => x - y)
    for (let k = 0; k + 1 < breaks.length; k++) {
      const sa = breaks[k] as number
      const sb = breaks[k + 1] as number
      if (sb - sa < 1e-7) continue
      const mid = (sa + sb) / 2
      const crossing = cuts
        .filter((e) => e.s0 <= mid && e.s1 >= mid)
        .map((e) => {
          const f = (s: number) => (s - e.s0) / (e.s1 - e.s0)
          const colourAt = (s: number): [number, number, number] => [
            lerp(e.c0[0], e.c1[0], f(s)),
            lerp(e.c0[1], e.c1[1], f(s)),
            lerp(e.c0[2], e.c1[2], f(s)),
          ]
          return {
            ya: lerp(e.y0, e.y1, f(sa)),
            yb: lerp(e.y0, e.y1, f(sb)),
            ym: lerp(e.y0, e.y1, f(mid)),
            ca: colourAt(sa),
            cb: colourAt(sb),
          }
        })
        .sort((x, y) => x.ym - y.ym)
      if (crossing.length % 2 !== 0) continue
      for (let n = 0; n + 1 < crossing.length; n += 2) {
        const lo = crossing[n] as (typeof crossing)[number]
        const hi = crossing[n + 1] as (typeof crossing)[number]
        if (hi.ym - lo.ym < 1e-6) continue
        // Corners: along the wall (sa -> sb), up it (lo -> hi). (+s) x (+y)
        // is the wall's inward normal, so this winding faces into the column.
        const p00 = at(w, sa, lo.ya)
        const p10 = at(w, sb, lo.yb)
        const p11 = at(w, sb, hi.yb)
        const p01 = at(w, sa, hi.ya)
        for (const [v, col] of [
          [p00, lo.ca],
          [p10, lo.cb],
          [p11, hi.cb],
          [p00, lo.ca],
          [p11, hi.cb],
          [p01, hi.ca],
        ] as const) {
          positions.push(...v)
          colors.push(...col)
        }
      }
    }
  }
  return positions.length > 0 ? { positions, colors } : null
}

/** Metres off a wall's plane within which a trimmed edge is a cut edge on it. */
const ON_WALL = 1e-4

// ── the shaft's section ────────────────────────────────────────────────────

/**
 * The triangles of `geometry` that reach into heights `lo` to `hi`, as nine
 * floats each (three corners, x y z) — so a run of slices through one band
 * walks the band and not the whole shaft.
 */
export const bandOf = (geometry: THREE.BufferGeometry, lo: number, hi: number): Float32Array => {
  const p = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : p.count
  const vi = (k: number) => (index ? index.getX(k) : k)
  const out: number[] = []
  for (let t = 0; t + 2 < count; t += 3) {
    const a = vi(t)
    const b = vi(t + 1)
    const c = vi(t + 2)
    const ya = p.getY(a)
    const yb = p.getY(b)
    const yc = p.getY(c)
    if (Math.max(ya, yb, yc) < lo || Math.min(ya, yb, yc) > hi) continue
    out.push(p.getX(a), ya, p.getZ(a), p.getX(b), yb, p.getZ(b), p.getX(c), yc, p.getZ(c))
  }
  return new Float32Array(out)
}

/** A horizontal slice of the shaft, per azimuth. See `sectionAt`. */
export interface Section {
  /** The wall's inside: the outermost face turned back toward the centre. */
  readonly inner: Float64Array
  /** The wall's outside: the outermost face turned away from the centre. */
  readonly outer: Float64Array
}

/**
 * How far 2016's shaft reaches from `centre` at height `y`, per azimuth: along
 * each of `steps` horizontal rays (azimuth `k / steps` of a turn, x = cos,
 * z = sin), the distance to the OUTERMOST face that faces back toward the
 * centre (`inner`: the inside of the wall, even behind a pipe standing in front
 * of it) and to the outermost face that faces away (`outer`: the outside of
 * the wall). Infinity where there is none.
 *
 * Read off the triangles' own slices of the plane, so it costs a pass over the
 * geometry and a few hundred segments per ray, not a raycast per triangle.
 */
export const sectionAt = (
  geometry: THREE.BufferGeometry | Float32Array,
  centre: Xz,
  y: number,
  steps: number = SECTION_STEPS,
): Section => {
  const tris = geometry instanceof Float32Array ? geometry : bandOf(geometry, y, y)
  const inner = new Float64Array(steps).fill(Number.NEGATIVE_INFINITY)
  const outer = new Float64Array(steps).fill(Number.NEGATIVE_INFINITY)
  const dirs = Array.from({ length: steps }, (_, k) => {
    const a = (k / steps) * Math.PI * 2
    return [Math.cos(a), Math.sin(a)] as const
  })
  const vx = [0, 0, 0]
  const vy = [0, 0, 0]
  const vz = [0, 0, 0]
  for (let t = 0; t + 8 < tris.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      vx[k] = tris[t + k * 3] as number
      vy[k] = tris[t + k * 3 + 1] as number
      vz[k] = tris[t + k * 3 + 2] as number
    }
    const lo = Math.min(vy[0] as number, vy[1] as number, vy[2] as number)
    const hi = Math.max(vy[0] as number, vy[1] as number, vy[2] as number)
    if (hi <= y || lo >= y) continue
    // The two points where the triangle's edges cross the plane.
    const cut: number[] = []
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3
      const dk = (vy[k] as number) - y
      const dj = (vy[j] as number) - y
      if ((dk < 0 && dj > 0) || (dk > 0 && dj < 0)) {
        const s = dk / (dk - dj)
        cut.push(
          (vx[k] as number) + ((vx[j] as number) - (vx[k] as number)) * s,
          (vz[k] as number) + ((vz[j] as number) - (vz[k] as number)) * s,
        )
      } else if (dk === 0) {
        cut.push(vx[k] as number, vz[k] as number)
      }
    }
    if (cut.length < 4) continue
    // The face's horizontal normal, three's winding (counter-clockwise front).
    const ex1 = (vx[1] as number) - (vx[0] as number)
    const ey1 = (vy[1] as number) - (vy[0] as number)
    const ez1 = (vz[1] as number) - (vz[0] as number)
    const ex2 = (vx[2] as number) - (vx[0] as number)
    const ey2 = (vy[2] as number) - (vy[0] as number)
    const ez2 = (vz[2] as number) - (vz[0] as number)
    const nx = ey1 * ez2 - ez1 * ey2
    const nz = ex1 * ey2 - ey1 * ex2
    const px = (cut[0] as number) - centre.x
    const pz = (cut[1] as number) - centre.z
    const qx = (cut[2] as number) - (cut[0] as number)
    const qz = (cut[3] as number) - (cut[1] as number)
    // Only the azimuths the segment subtends, and one either side: a wall's
    // segment covers a degree or two of the 360, so this is most of the cost.
    const a0 = Math.atan2(pz, px)
    let span = Math.atan2(pz + qz, px + qx) - a0
    if (span > Math.PI) span -= Math.PI * 2
    if (span < -Math.PI) span += Math.PI * 2
    const perStep = (Math.PI * 2) / steps
    const from = Math.floor(Math.min(a0, a0 + span) / perStep) - 1
    const to = Math.ceil(Math.max(a0, a0 + span) / perStep) + 1
    for (let kk = from; kk <= to; kk++) {
      const k = ((kk % steps) + steps) % steps
      const [dx, dz] = dirs[k] as readonly [number, number]
      const denom = cross(dx, dz, qx, qz)
      if (Math.abs(denom) < 1e-12) continue
      const t0 = cross(px, pz, qx, qz) / denom
      const s0 = cross(px, pz, dx, dz) / denom
      if (t0 <= 0 || s0 < 0 || s0 > 1) continue
      // Facing back toward the centre: its front is against the ray.
      const facing = dx * nx + dz * nz
      if (facing < 0 && t0 > (inner[k] as number)) inner[k] = t0
      else if (facing > 0 && t0 > (outer[k] as number)) outer[k] = t0
    }
  }
  for (const a of [inner, outer]) {
    for (let k = 0; k < steps; k++) {
      if (!((a[k] as number) > Number.NEGATIVE_INFINITY)) a[k] = Number.POSITIVE_INFINITY
    }
  }
  return { inner, outer }
}

/**
 * How far the shaft reaches from `centre`, per azimuth (`SECTION_STEPS` of
 * them), over heights `lo` to `hi`, at every `step` metres: out to the wall's
 * OUTSIDE — the farther of `sectionAt`'s two faces. What the sea's hole has to
 * cover: its inside, and the wall itself, because 2016's wall panels meet at
 * hairline seams, and through one the sea just behind the inside face showed
 * as a dotted line of pixels (45 px, measured, looking up on `int_01`). An
 * azimuth that never met a wall takes the widest of all, so a gap is covered
 * rather than left open.
 */
export const interiorReach = (
  geometry: THREE.BufferGeometry,
  centre: Xz,
  lo: number,
  hi: number,
  step = 0.25,
): Float64Array => {
  const reach = new Float64Array(SECTION_STEPS)
  const band = bandOf(geometry, lo, hi)
  // A hair off the grid, so no slice lies exactly on a row of vertices.
  for (let y = lo + 1e-3; y <= hi; y += step) {
    const s = sectionAt(band, centre, y)
    for (let k = 0; k < SECTION_STEPS; k++) {
      const i = s.inner[k] as number
      const o = s.outer[k] as number
      const r = Math.max(Number.isFinite(i) ? i : 0, Number.isFinite(o) ? o : 0)
      if (r > (reach[k] as number)) reach[k] = r
    }
  }
  let widest = 0
  for (const r of reach) widest = Math.max(widest, r)
  for (let k = 0; k < SECTION_STEPS; k++) if (!((reach[k] as number) > 0)) reach[k] = widest
  return reach
}

/**
 * The sea's hole as `render/water.ts` takes it: `steps` reaches, one per WORLD
 * azimuth (`k / steps` of a turn, x = cos, z = sin), from `reach` (one per
 * azimuth of `launch-anchor`'s frame, as `interiorReach` reads it) turned by the
 * anchor's `quaternion`. Each entry is the widest fine reach within one entry
 * either side of it, so the shader's straight line between two entries never
 * falls inside a wall's corner the fine reach went round.
 */
export const holeTableFor = (
  reach: ArrayLike<number>,
  quaternion: THREE.Quaternion,
  steps: number,
): Float32Array => {
  const toLocal = quaternion.clone().invert()
  const n = reach.length
  const table = new Float32Array(steps)
  const half = (Math.PI * 2) / steps
  const dir = new THREE.Vector3()
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2
    dir.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(toLocal)
    const local = Math.atan2(dir.z, dir.x)
    let widest = 0
    for (let j = 0; j < n; j++) {
      const b = (j / n) * Math.PI * 2
      const d = Math.abs(Math.atan2(Math.sin(b - local), Math.cos(b - local)))
      if (d <= half + 1e-9) widest = Math.max(widest, reach[j] as number)
    }
    table[k] = widest
  }
  return table
}

// ── the hatch ──────────────────────────────────────────────────────────────

/** The mean vertex colour of `geometry` within `band` metres of `y`, or null. */
export const meanColourNear = (
  geometry: THREE.BufferGeometry,
  y: number,
  band: number,
): [number, number, number] | null => {
  const p = geometry.getAttribute('position')
  const c = geometry.getAttribute('color')
  if (!c) return null
  let n = 0
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getY(i) - y) > band) continue
    r += c.getX(i)
    g += c.getY(i)
    b += c.getZ(i)
    n++
  }
  return n === 0 ? null : [r / n, g / n, b / n]
}

/** Triangles as non-indexed position and colour, the layout of 2016's baked shaft. */
export interface Triangles {
  readonly positions: number[]
  readonly colors: number[]
}

/**
 * A floor across the shaft at height `y`: out to `reach` metres round `centre`
 * at each of its azimuths (a `sectionAt`'s, plus whatever tuck the caller
 * wants), with `column` as its opening. Both faces, one colour. Null when the
 * reach has a gap or does not clear the column all the way round.
 */
export const hatchGeometry = (
  reach: ArrayLike<number>,
  centre: Xz,
  y: number,
  column: readonly Xz[],
  colour: readonly [number, number, number],
): Triangles | null => {
  const steps = reach.length
  const outline: THREE.Vector2[] = []
  for (let k = 0; k < steps; k++) {
    const r = reach[k] as number
    const a = (k / steps) * Math.PI * 2
    if (!Number.isFinite(r) || r <= reachAlong(column, centre, a) + 0.05) return null
    outline.push(new THREE.Vector2(centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r))
  }
  const hole = column.map((c) => new THREE.Vector2(c.x, c.z))
  const faces = THREE.ShapeUtils.triangulateShape(outline, [hole])
  const all = [...outline, ...hole]
  const positions: number[] = []
  const colors: number[] = []
  const put = (i: number) => {
    const v = all[i] as THREE.Vector2
    positions.push(v.x, y, v.y)
    colors.push(colour[0], colour[1], colour[2])
  }
  for (const [a, b, c] of faces as [number, number, number][]) {
    // Both windings: it is a ceiling on the way up and a floor at the top.
    put(a)
    put(b)
    put(c)
    put(a)
    put(c)
    put(b)
  }
  return positions.length > 0 ? { positions, colors } : null
}

/**
 * A ring at height `y` between two reaches round `centre` — a cap over the tops
 * of walls DEV-443 cut open at the rim, so the inside of a wall is not a slot
 * the world shows through. Azimuths where either reach is missing, or where the
 * outer does not clear the inner, are left out. Both faces, one colour.
 */
export const ringGeometry = (
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  centre: Xz,
  y: number,
  colour: readonly [number, number, number],
): Triangles | null => {
  const steps = from.length
  const positions: number[] = []
  const colors: number[] = []
  const at = (k: number, r: number): [number, number, number] => {
    const a = ((k % steps) / steps) * Math.PI * 2
    return [centre.x + Math.cos(a) * r, y, centre.z + Math.sin(a) * r]
  }
  const ok = (k: number) => {
    const i = from[k % steps] as number
    const o = to[k % steps] as number
    return Number.isFinite(i) && Number.isFinite(o) && o > i
  }
  for (let k = 0; k < steps; k++) {
    if (!ok(k) || !ok(k + 1)) continue
    const a = at(k, from[k] as number)
    const b = at(k + 1, from[(k + 1) % steps] as number)
    const c = at(k + 1, to[(k + 1) % steps] as number)
    const d = at(k, to[k] as number)
    for (const tri of [
      [a, b, c],
      [a, c, d],
      [a, c, b],
      [a, d, c],
    ]) {
      for (const v of tri) {
        positions.push(...(v as [number, number, number]))
        colors.push(colour[0], colour[1], colour[2])
      }
    }
  }
  return positions.length > 0 ? { positions, colors } : null
}

/**
 * The lift's column closed at height `y`: the convex `column` fanned from its
 * first corner, both faces, one colour. What stands in the hatch's opening once
 * the lift's deck has gone (DEV-460).
 */
export const lidGeometry = (
  column: readonly Xz[],
  y: number,
  colour: readonly [number, number, number],
): Triangles => {
  const positions: number[] = []
  const colors: number[] = []
  const put = (c: Xz) => {
    positions.push(c.x, y, c.z)
    colors.push(colour[0], colour[1], colour[2])
  }
  const o = column[0] as Xz
  for (let k = 1; k + 1 < column.length; k++) {
    const a = column[k] as Xz
    const b = column[k + 1] as Xz
    put(o)
    put(a)
    put(b)
    put(o)
    put(b)
    put(a)
  }
  return { positions, colors }
}

/** Non-indexed triangles as a geometry of their own. */
export const geometryOfTriangles = (t: Triangles): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(t.positions, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(t.colors, 3))
  g.computeBoundingSphere()
  return g
}

/** Append non-indexed triangles to a non-indexed position + colour geometry. */
export const appendTriangles = (
  geometry: THREE.BufferGeometry,
  extra: Triangles,
): THREE.BufferGeometry => {
  const names = Object.keys(geometry.attributes).sort()
  if (geometry.index || names.join(',') !== 'color,position')
    throw new Error(`lift-seal: expected non-indexed position + color, got ${names.join(', ')}`)
  const p = geometry.getAttribute('position')
  const c = geometry.getAttribute('color')
  const positions = Array.from(p.array as ArrayLike<number>).concat(extra.positions)
  const colors = Array.from(c.array as ArrayLike<number>).concat(extra.colors)
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3, c.normalized))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

// ── the world, in the shaft ────────────────────────────────────────────────

/** Metres the sea's ceiling is held over its computed bound. */
export const SEA_MARGIN = 0.25

/**
 * The most a `LowPoly_Displace` wave can lift one vertex: `amplitude * (n + 1)`
 * with `n = waterNoise * noise` and `waterNoise` in [0, 1) (`render/water.ts`'s
 * `waterDisplacement`). The whole-plate bob is the same expression at the
 * plate's origin, so it has the same bound.
 */
export const waveReach = (d: { readonly amplitude: number; readonly noise: number }): number =>
  Math.abs(d.amplitude) *
  Math.max(Math.abs(1 + Math.min(0, d.noise)), Math.abs(1 + Math.max(0, d.noise)))

/** A height field and the render's jitter over it. */
export interface WorldSurface {
  readonly field: HeightField
  /** `FacetedTerrain.RandomOffset`: how far a drawn vertex stands off the field. */
  readonly jitter: number
  /**
   * The height MAP the field was built from, read at its own texel pitch too.
   * The collision field is the map sampled on the 8 m grid; Anniversary's
   * detail ring (DEV-085) draws the land at 4 m off the map itself, and there
   * the surface rises to the map's own crests between the field's samples —
   * a metre and more over the field inside `rookie_01`'s shaft, photographed.
   */
  readonly map?: MapSampler | null
  /**
   * The detail ring, when it is drawn (Anniversary): its own jitter. Its grid
   * is rebuilt from a reconstruction that stands up to HALF A GREY LEVEL over
   * the stored map (DEV-131's invariant: 2.0 m on the 1024 m worlds, 3.0 on
   * Simonet), so where it draws the land it can stand that much over the map.
   * Measured inside `rookie_01`'s shaft: the ring's highest vertex 2.33 m over
   * the map's highest point, against a bound of 2.41 (half a level, 2.01, and
   * the ring's jitter, 0.40).
   */
  readonly ring?: { readonly jitter: number } | null
}

/**
 * The highest the world reaches inside the disc of `radius` about `axis`, in
 * `launch-anchor`'s frame (`anchor` is its world matrix):
 *
 *   `land`  the collision surface's highest point — every grid vertex inside
 *           the disc (where a bilinear surface's maximum is) and its rim —
 *           WITHOUT the jitter, which `revealRiseFor` adds itself;
 *   `sea`   the sea's ceiling: the same, plus the jitter, the bob and the wave
 *           at their largest (`waveReach` each) and `SEA_MARGIN`.
 *
 * Null for a surface that is not there. The fields are SIM space, which mirrors
 * z, as every caller of `terrainHeightAt` knows.
 */
export const worldTopIn = (
  anchor: THREE.Matrix4,
  axis: Xz,
  radius: number,
  land: WorldSurface | null,
  sea: (WorldSurface & { readonly displace: { amplitude: number; noise: number } }) | null,
): { land: number | null; sea: number | null } => {
  const toLocal = anchor.clone().invert()
  const v = new THREE.Vector3()
  // The disc's samples, in world x/z: its rim, and a polar fill.
  const disc: [number, number][] = []
  for (let ring = 0; ring <= 8; ring++) {
    const r = (radius * ring) / 8
    const n = ring === 0 ? 1 : 12 + ring * 6
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      v.set(axis.x + Math.cos(a) * r, 0, axis.z + Math.sin(a) * r).applyMatrix4(anchor)
      disc.push([v.x, v.z])
    }
  }
  v.set(axis.x, 0, axis.z).applyMatrix4(anchor)
  const cx = v.x
  const cz = v.z
  const rgb = { r: 0, g: 0, b: 0 }
  const topOf = (field: HeightField, map: MapSampler | null = null): number => {
    let top = Number.NEGATIVE_INFINITY
    const at = (wx: number, wz: number, h: number) => {
      v.set(wx, h, wz).applyMatrix4(toLocal)
      if (v.y > top) top = v.y
    }
    const probe = (wx: number, wz: number) => at(wx, wz, terrainHeightAt(field, wx, -wz))
    // The map itself, bilinear, at half its texel pitch over the disc's box:
    // the highest a surface drawn off it at any density can reach, jitter aside.
    if (map && !field.analytic) {
      const simZ = -cz
      const pitch = (field.terrainSize * (field.scaleX || 1)) / Math.max(1, map.width) / 2
      for (let sx = cx - radius; sx <= cx + radius; sx += pitch) {
        for (let sz = simZ - radius; sz <= simZ + radius; sz += pitch) {
          if (Math.hypot(sx - cx, sz - simZ) > radius) continue
          const u = (sx - field.originX) / (field.scaleX || 1) / field.terrainSize
          const w = (sz - field.originZ) / (field.scaleZ || 1) / field.terrainSize
          if (u < 0 || u > 1 || w < 0 || w > 1) continue
          map.sample(u, w, rgb)
          const h =
            field.originY +
            grayscale(rgb.r, rgb.g, rgb.b) * field.terrainHeight * (field.scaleY || 1)
          at(sx, -sz, h)
        }
      }
    }
    for (const [wx, wz] of disc) probe(wx, wz)
    // Every grid vertex inside the disc, in the field's own (sim) frame.
    const sx = field.step * (field.scaleX || 1)
    const sz = field.step * (field.scaleZ || 1)
    const simZ = -cz
    const i0 = Math.floor((cx - radius - field.originX) / sx)
    const i1 = Math.ceil((cx + radius - field.originX) / sx)
    const j0 = Math.floor((simZ - radius - field.originZ) / sz)
    const j1 = Math.ceil((simZ + radius - field.originZ) / sz)
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const gx = field.originX + i * sx
        const gz = field.originZ + j * sz
        if (Math.hypot(gx - cx, gz - simZ) <= radius) probe(gx, -gz)
      }
    }
    return top
  }
  // The ring's reach over the map beyond the base grid's own jitter, which the
  // callers add: `land + jitter` is then the higher of the two surfaces' tops.
  const ringLift = (s: WorldSurface): number => {
    if (!s.ring) return 0
    const halfLevel = (s.field.terrainHeight * (s.field.scaleY || 1)) / 255 / 2
    return Math.max(0, halfLevel + s.ring.jitter - s.jitter)
  }
  return {
    land: land ? topOf(land.field, land.map ?? null) + ringLift(land) : null,
    sea: sea ? topOf(sea.field) + sea.jitter + 2 * waveReach(sea.displace) + SEA_MARGIN : null,
  }
}

/**
 * Where the hatch goes for a world that tops out at `top` (`worldTopIn`): over
 * the land and its jitter, and over the sea's ceiling. Null with neither.
 */
export const hatchHeightOf = (
  top: { readonly land: number | null; readonly sea: number | null },
  landJitter: number,
): number | null => {
  const land = top.land === null ? null : top.land + landJitter
  if (land === null) return top.sea
  return top.sea === null ? land : Math.max(land, top.sea)
}

/**
 * Metres of rise the land comes on before the eye clears the rim, at the
 * latest. The eye is `EYE.y` over the rise; a ride frame is ~0.1 m of it near
 * the top.
 */
export const REVEAL_LEAD = 0.1

/**
 * The rise the land comes on at, over 2016's shaft (DEV-460). Each argument is
 * a rise, from `render/elevator.ts`'s `revealRiseFor` or the rim:
 *
 * - `plugged`: the deck clears the highest ground under the whole shaft, which
 *   is the hatch's height where the hatch is the land's — the lift has plugged
 *   the hatch, and nothing is open below it.
 * - `column`: the deck clears the highest ground inside the lift's own column,
 *   the only ground the hatch does not cover. Never earlier than this, or the
 *   ground stands in the dish.
 * - `eyeClears`: the eye clears the rim. The land is on before it, or the bore's
 *   hidden chunks show from the top (DEV-106's order).
 *
 * The plug, unless the eye would clear the rim first: `int_02` on Anniversary
 * plugs at 103.98 and its eye clears the rim at 103.59. Between the lead and
 * the plug the column is open round the dish by `COLUMN_MARGIN`, and the dish's
 * own rim, its widest, stands between that gap and every eye above it.
 */
export const landRevealFor = (rises: {
  readonly plugged: number
  readonly column: number
  readonly eyeClears: number
}): number => Math.max(rises.column, Math.min(rises.plugged, rises.eyeClears - REVEAL_LEAD))

/** The lift's column's reach from its axis: every point of it is within. */
export const columnRadiusOf = (seal: {
  readonly axis: Xz
  readonly column: readonly Xz[]
}): number =>
  seal.column.reduce((r, p) => Math.max(r, Math.hypot(p.x - seal.axis.x, p.z - seal.axis.z)), 0)

// ── the seal ───────────────────────────────────────────────────────────────

/** What sealing 2016's shaft decided, for `boot/app.ts` to act on. */
export interface LiftSeal {
  /** The lift's axis: the centroid of the dish's footprint, anchor frame. */
  readonly axis: Xz
  /** The lift's column: the dish's footprint grown by `COLUMN_MARGIN`. */
  readonly column: readonly Xz[]
  /**
   * The sea's hole, per azimuth of the anchor's frame about `axis`
   * (`SECTION_STEPS` of them): the inside of 2016's wall plus `BORE_MARGIN`.
   * `holeTableFor` turns it into the world's.
   */
  readonly reach: Float64Array
  /** The widest of `reach`: the circle the hole is inside. */
  readonly boreRadius: number
  /** The hatch's height, anchor frame, or null for a shaft nothing crosses. */
  readonly hatchY: number | null
  /** The rise at which the dish's foot reaches the hatch: the switch. Null with no hatch. */
  readonly sealRise: number | null
  /** How far the dish's foot hangs under the ship (negative): the deck's lowest y at rest. */
  readonly deckFoot: number
}

export interface SealOptions {
  /**
   * The height of the world inside the shaft, anchor frame — the highest ground
   * plus its jitter, or the sea's ceiling, whichever is higher — sampled over
   * the disc of `radius` about `axis`; null if neither reaches it. `boot/app.ts`
   * reads its own fields; the unit suite hands in a number.
   */
  hatchFor(axis: Xz, radius: number): number | null
  /** Told once the seal is decided, before the lift dresses. */
  onSeal(seal: LiftSeal): void
}

/**
 * A lift whose 2016 shaft is cleared down its column, hatched at the world's
 * height, and whose seal is reported — and which otherwise dresses exactly as
 * `lift` does. Composes under `start-grid.ts`'s `cutShaftAtRim`, so the shaft it
 * is handed is already held to the rim.
 */
export const sealLift = <
  A extends { readonly shaft: THREE.Object3D; readonly deck: THREE.Object3D },
>(
  lift: { readonly rimY: number; dress(art: A & { readonly lid?: THREE.Object3D | null }): void },
  opts: SealOptions,
): { readonly rimY: number; dress(art: A): void } => ({
  rimY: lift.rimY,
  dress(art) {
    const shaft = art.shaft as THREE.Mesh
    const deck = art.deck as THREE.Mesh
    if (!shaft.isMesh || !deck.isMesh) throw new Error('lift-seal: the shaft and deck are meshes')
    deck.geometry.computeBoundingBox()
    const deckFoot = (deck.geometry.boundingBox as THREE.Box3).min.y
    const footprint = footprintOf(deck.geometry)
    const column = grownHull(footprint, COLUMN_MARGIN)
    const axis = centroidOf(footprint)
    const before = shaft.geometry
    shaft.geometry = trimColumn(before, column)
    if (shaft.geometry !== before) before.dispose()
    // The segments repeat every 12 m, so one of them under the rim is every
    // shape the shaft has.
    const rimY = lift.rimY
    const reach = interiorReach(shaft.geometry, axis, rimY - 12, rimY).map((r) => r + BORE_MARGIN)
    let bore = 0
    for (const r of reach) bore = Math.max(bore, r)
    const rim = sectionAt(shaft.geometry, axis, rimY - 1e-3)
    const tucked = (s: Section) => s.inner.map((r) => r + HATCH_TUCK)
    // Out to the wall's outside — or past its inside where a single-sided panel
    // stands beyond the last outward face.
    const capped = (s: Section) =>
      s.outer.map((r, k) => Math.max(r, (s.inner[k] as number) + HATCH_TUCK))
    const extra: Triangles[] = []
    // DEV-551: and the catwalks the column went through, closed on its walls.
    if (shaft.geometry !== before) {
      const cap = capColumn(shaft.geometry, column)
      if (cap) extra.push(cap)
    }
    const wanted = opts.hatchFor(axis, bore)
    shaft.geometry.computeBoundingBox()
    const bottom = (shaft.geometry.boundingBox as THREE.Box3).min.y
    let hatchY: number | null = null
    /** The column closed at the hatch, for `render/elevator.ts` to draw once the deck has gone. */
    let lid: THREE.Mesh | null = null
    // Under the shaft's foot the world is never inside it: no hatch to hold it out.
    if (wanted !== null && Number.isFinite(wanted) && wanted > bottom) {
      const y = Math.min(wanted, rimY)
      const colour = meanColourNear(shaft.geometry, y, 2) ?? UNLIT_SHAFT
      // At the rim the hatch IS the cap over the cut walls, out to their
      // outsides; below it, it reaches into the wall.
      const hatch =
        y >= rimY - 1e-6
          ? (hatchGeometry(capped(rim), axis, y, column, colour) ??
            hatchGeometry(tucked(rim), axis, y, column, colour))
          : hatchGeometry(
              tucked(sectionAt(shaft.geometry, axis, y - 1e-3)),
              axis,
              y,
              column,
              colour,
            )
      if (hatch) {
        extra.push(hatch)
        hatchY = y
        lid = new THREE.Mesh(
          geometryOfTriangles(lidGeometry(column, y, colour)),
          shaft.material as THREE.Material,
        )
        lid.name = 'elevator-shaft-lid'
      }
    }
    // DEV-443 cut the walls open at the rim: cap them, unless the hatch is the cap.
    if (hatchY === null || hatchY < rimY - 1e-6) {
      const colour = meanColourNear(shaft.geometry, rimY, 1) ?? UNLIT_SHAFT
      const cap = ringGeometry(
        rim.inner.map((r) => r - 0.02),
        capped(rim),
        axis,
        rimY,
        colour,
      )
      if (cap) extra.push(cap)
    }
    if (extra.length > 0) {
      const plain = shaft.geometry
      shaft.geometry = appendTriangles(plain, {
        positions: extra.flatMap((t) => t.positions),
        colors: extra.flatMap((t) => t.colors),
      })
      plain.dispose()
    }
    opts.onSeal({
      axis,
      column,
      reach,
      boreRadius: bore,
      hatchY,
      sealRise: hatchY === null ? null : hatchY - deckFoot,
      deckFoot,
    })
    lift.dress({ ...art, lid })
  },
})
