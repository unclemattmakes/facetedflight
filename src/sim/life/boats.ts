// src/sim/life/boats.ts — where the moored boats go. DEV-447.
//
// The first slice of the life pass (Matt, 2026-09-27: *"would like the "life"
// pass to come online sometime soon"*): stationary boats on the sea, near the
// shore and near the start. This file is the WHERE; `sea-facet.ts` is what they
// float on and `render/life-boats.ts` draws them.
//
// ── A rule, not a list, so a new mission gets boats without touching src/ ─
//
// Hard rule 6. Nothing here names a mission or an environment. The inputs are
// the mission's own racing line (or, on a course without one, the line through
// its spawn and its gates), its spawn, and the two terrains the world already
// holds — the island and the sea. An environment with no sea gets no boats
// because there is nowhere for the rule to put one, not because a table says so.
//
// ── Spread by arc length, as the traffic is (DEV-146) ─────────────────────
//
// `game/ambient-traffic.ts`'s header argues it for ships: life seeded in one
// place reads as a cutscene; life spread round the course reads as a place.
// So `alongRoute` boats are aimed at evenly spaced fractions of the line —
// `(i + 0.5) / n`, the traffic's own half-open spacing, so nobody is aimed at
// the start deck twice — and each goes to the first water near its fraction
// that passes every gate below. `atStart` more are aimed at the spawn, because
// the launch breaches the sea there and it is the one place a player is
// guaranteed to be at the water's height, slowly.
//
// ── The gates, in the order that rejects the most for the least ───────────
//
//   1. ON THE SEA — inside the ocean plate's footprint.
//   2. DEPTH — `seaY - landY` inside `depth`: shallow enough to be near a shore
//      (a moored boat), deep enough not to be aground. Off the island's map is
//      open ocean, as deep as it gets (the rule DEV-429's spray uses), so it
//      fails any finite band — no boats in the middle of nowhere. The START
//      boats are the exception when `startOpenWater` says so: they are anchored
//      to watch a race start, and on `int_01_hoverJet` the start deck stands
//      in open sea, 300 m and more off the island's map, where no shore is
//      near enough to moor to (measured offline over the source maps: every
//      point of a 300 m ring round that spawn is off the map or 124-130 m
//      deep). So for them the band keeps its floor and loses its ceiling.
//   3. HULL — the same depth floor at four points a hull's length out, so a
//      boat that fits at its centre is not pushed half up a beach.
//   4. KEEP-OUT — the spawn clearings and the start grid, in plan. A mast in
//      the launch path would be a thing the player flies through (life never
//      collides — DEV-146's rule) and that reads as a bug.
//   5. SPACING — from every boat already placed. Placed in a fixed order, so
//      the answer is the same every load.
//
// ── What a boat is NOT ────────────────────────────────────────────────────
//
// Not an opponent, not an obstacle, not a collider, not a score. No sim reads
// this module's output: it is scenery with a seed. A boat cannot end a run.
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`.

import { searchRings } from '@/sim/life/search'
import { fnv1a32 } from '@/sim/math/hash'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { type Route, routeAt } from '@/sim/route'
import { makeRandom } from '@/sim/terrain/faceted'
import { type HeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'

/** One kind of boat — one mesh, one draw call. */
export interface BoatKindSpec {
  readonly id: string
  /** Relative share. Zero leaves the kind out. */
  readonly weight: number
  /** Uniform scale range on the mesh as converted, `[min, max]`. */
  readonly scale: readonly [number, number]
  /** Half the hull's LENGTH at scale 1, metres of mesh — gate 3's reach. */
  readonly halfLength: number
}

/** The placement half of `life.boats` in the edition preset. See `_schema.json`. */
export interface BoatSpec {
  readonly seed: number
  /** Boats aimed at evenly spaced fractions of the line. */
  readonly alongRoute: number
  /** Boats aimed at the spawn. */
  readonly atStart: number
  /** Metres out from the line's point, `[min, max]`, searched in rings. */
  readonly routeReach: readonly [number, number]
  /** Metres out from the spawn, `[min, max]`. */
  readonly startReach: readonly [number, number]
  /** Metres of water under the hull, `[min, max]`. */
  readonly depth: readonly [number, number]
  /** The start boats keep `depth`'s floor and drop its ceiling: open sea is fine. */
  readonly startOpenWater: boolean
  /** Metres between any two boats, centre to centre. */
  readonly spacing: number
  /** Degrees either side of the fleet's shared heading. */
  readonly swing: number
  /** The search: metres between rings, and angles tried on each. */
  readonly search: { readonly step: number; readonly angles: number }
  readonly kinds: readonly BoatKindSpec[]
}

/** A keep-out disc in SIM plan: centre and radius, metres. */
export interface KeepOut {
  readonly x: number
  readonly z: number
  readonly radius: number
}

export interface BoatInput {
  readonly spec: BoatSpec
  /** Folded into the spec's seed so each course has its own harbour. */
  readonly courseSeed: number
  /** The line the fleet is spread along, SIM space. Null: only the start boats. */
  readonly line: Route | null
  /** The spawn, SIM space. */
  readonly start: { readonly x: number; readonly z: number }
  /** The OCEAN's collision surface: where the sea is and how high its base sits. */
  readonly sea: HeightField
  /** The island's, or null (then the whole plate is open ocean). */
  readonly land: HeightField | null
  readonly keepOut: readonly KeepOut[]
}

export interface BoatPlacement {
  /** Index into `spec.kinds`. */
  readonly kind: number
  /** SIM plan position, metres. */
  readonly x: number
  readonly z: number
  /** Radians about +y, SIM space. */
  readonly yaw: number
  readonly scale: number
  /** Which target this boat answered: a route fraction in 0..1, or -1 for the start. */
  readonly target: number
}

/**
 * A string to a 32-bit seed. FNV-1a: not cryptographic, only stable, which is
 * the one property a harbour needs across loads and machines.
 */
export const seedOf = fnv1a32

/**
 * Water under a SIM plan point: the sea's base minus the island. Open ocean
 * (off the island's map, or no island) is infinitely deep. NaN off the sea.
 */
export const waterDepthAt = (
  sea: HeightField,
  land: HeightField | null,
  x: number,
  z: number,
): number => {
  if (outsideField(sea, x, z)) return Number.NaN
  const seaY = terrainHeightAt(sea, x, z)
  if (!land || outsideField(land, x, z)) return Number.POSITIVE_INFINITY
  return seaY - terrainHeightAt(land, x, z)
}

const inBand = (d: number, band: readonly [number, number]): boolean =>
  d >= (band[0] as number) && d <= (band[1] as number)

/** The widest reach any kind's hull has, at its largest scale. Gate 3's radius. */
const hullReach = (kinds: readonly BoatKindSpec[]): number =>
  kinds.reduce((m, k) => Math.max(m, k.halfLength * (k.scale[1] as number)), 0)

/**
 * Place the fleet. Deterministic: the same input is the same harbour, and one
 * seeded stream is walked in a fixed order — the start boats, then the route's
 * in arc-length order — so a boat that fails to place draws the same numbers
 * as one that succeeds and never shifts the ones after it.
 */
export const placeBoats = (input: BoatInput): BoatPlacement[] => {
  const { spec, sea, land } = input
  const kinds = spec.kinds.filter((k) => k.weight > 0)
  const totalWeight = kinds.reduce((s, k) => s + k.weight, 0)
  if (kinds.length === 0 || !(totalWeight > 0)) return []
  const rnd = makeRandom((spec.seed ^ input.courseSeed) >>> 0)
  // The fleet's shared heading: moored boats swing to one wind, and a bay of
  // boats pointing every way reads as dropped rather than moored.
  const heading = rnd() * Math.PI * 2
  const swing = (spec.swing * Math.PI) / 180
  const reach = hullReach(kinds)
  const minDepth = spec.depth[0] as number
  const placed: BoatPlacement[] = []

  const openWater: readonly [number, number] = [minDepth, Number.POSITIVE_INFINITY]
  const startDepth = spec.startOpenWater ? openWater : spec.depth

  const fits = (x: number, z: number, depth: readonly [number, number]): boolean => {
    if (!inBand(waterDepthAt(sea, land, x, z), depth)) return false
    for (let q = 0; q < 4; q++) {
      const a = (q * Math.PI) / 2
      const d = waterDepthAt(sea, land, x + Math.cos(a) * reach, z + Math.sin(a) * reach)
      if (!(d >= minDepth)) return false
    }
    for (const k of input.keepOut) {
      if ((x - k.x) ** 2 + (z - k.z) ** 2 < k.radius ** 2) return false
    }
    for (const b of placed) {
      if ((x - b.x) ** 2 + (z - b.z) ** 2 < spec.spacing ** 2) return false
    }
    return true
  }

  const place = (
    cx: number,
    cz: number,
    band: readonly [number, number],
    depth: readonly [number, number],
    target: number,
  ): void => {
    // Every draw is made before the search, so a failed search spends exactly
    // what a successful one does (see the doc comment).
    const phase = rnd() * Math.PI * 2
    const pick = rnd() * totalWeight
    const scaleT = rnd()
    const yawT = rnd()
    // `sim/life/search.ts`: rings outward, sampled along their arc (the fix
    // for Kauai's steep shelves, measured — see that file).
    const at = searchRings(cx, cz, band, spec.search, phase, (x, z) => fits(x, z, depth))
    if (!at) return
    let acc = 0
    let kind = 0
    for (let i = 0; i < kinds.length; i++) {
      acc += (kinds[i] as BoatKindSpec).weight
      if (pick < acc) {
        kind = i
        break
      }
    }
    const k = kinds[kind] as BoatKindSpec
    placed.push({
      kind: spec.kinds.indexOf(k),
      x: at.x,
      z: at.z,
      yaw: heading + (yawT * 2 - 1) * swing,
      scale: (k.scale[0] as number) + scaleT * ((k.scale[1] as number) - (k.scale[0] as number)),
      target,
    })
  }

  for (let i = 0; i < spec.atStart; i++) {
    place(input.start.x, input.start.z, spec.startReach, startDepth, -1)
  }
  if (input.line && spec.alongRoute > 0) {
    const at: Vec3 = v3()
    for (let i = 0; i < spec.alongRoute; i++) {
      const f = (i + 0.5) / spec.alongRoute
      routeAt(input.line, f * input.line.length, at)
      place(at.x, at.z, spec.routeReach, spec.depth, f)
    }
  }
  return placed
}
