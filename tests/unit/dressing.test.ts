// tests/unit/dressing.test.ts — the placement RULES, on ground whose answers
// are arithmetic.
//
// V9, DEV-089.
//
// ── Why the terrain here is synthetic, and why that is the stronger test ──
//
// The real height maps live in `public/assets`, which is gitignored and pulled
// from R2, so CI has none. But that is not the main reason. The main reason is
// trap 24: **a test that re-derives its expectation the way the code does has
// not tested the code.** Asserting "every placement's slope is inside the band"
// by calling `slopeAt` again is a restatement of the implementation, and it
// stays green if `slopeAt` is wrong.
//
// So every surface below has an ANALYTIC answer and every assertion is
// positional:
//
//   - a HALF-FLAT, HALF-RAMP map: a steep band must place only where x is past
//     the hinge, which is a fact about coordinates and not about `slopeAt`
//   - a LINEAR-IN-Z map: an altitude band must place only inside a z range that
//     is one division to work out by hand
//   - a STRAIGHT route: the distance from a point to a straight line is a cross
//     product, so route clearance is checked against geometry rather than
//     against `routeDistance`
//   - a gate on its own: Euclidean distance, and nothing else
//
// The last section runs the SHIPPED preset over a synthetic archipelago built to
// Simonet's dimensions and prints what it produced. That number is what the
// ledger row quotes, and it is labelled for what it is: a synthetic island, not
// Simonet.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Edition, editionFeatures, validateEdition } from '@/content/edition-schema'
import { dressingSpecFor, spawnClearingsOf } from '@/game/props/load-dressing'
import {
  bandApplies,
  type DressingBand,
  type DressingInput,
  type DressingPlacements,
  flockIsClear,
  meshToSim,
  type PropTerrain,
  placeBand,
  placeDressing,
  placeFlocks,
} from '@/sim/props/dressing'
import { birdAt, birdPose, flockPeriod } from '@/sim/props/generate-bird'
import { createRoute, type Route } from '@/sim/route'
import type { HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'

// ── Terrain, as arithmetic ────────────────────────────────────────────────

/** Simonet's own dimensions, so the counts below are at a real island's scale. */
const TERRAIN: PropTerrain = {
  terrainSize: 4096,
  terrainHeight: 1024,
  step: 8,
  originX: 0,
  originY: 0,
  originZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
}

/**
 * A sampler from a normalised-height function of (u, v).
 *
 * `grayscale(v, v, v) === v` for any v, so writing the normalised height into
 * all three channels makes the ground exactly the function — no colour weights
 * to reason about.
 */
const samplerOf = (f: (u: number, v: number) => number): MapSampler => ({
  width: 1024,
  height: 1024,
  sample(u: number, v: number, out: Rgb): void {
    const h = Math.min(1, Math.max(0, f(u, v)))
    out.r = h
    out.g = h
    out.b = h
  },
})

/** A flat water plane at a known world y. The shape `terrainHeightAt` reads. */
const waterAt = (y: number): HeightField => ({
  vertPerSide: 2,
  heights: Float32Array.from([0, 0, 0, 0]),
  step: TERRAIN.terrainSize,
  terrainSize: TERRAIN.terrainSize,
  terrainHeight: 1,
  originX: 0,
  originY: y,
  originZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
})

const PALETTE = [[0.3, 0.3, 0.3]] as const

const band = (over: Partial<DressingBand>): DressingBand => ({
  kind: 'rock',
  density: 4000,
  scaleMin: 0.5,
  scaleMax: 1.5,
  slopeMin: 0,
  slopeMax: 1,
  altitudeMin: -1e6,
  altitudeMax: 1e6,
  nearWater: false,
  tint: 0,
  palette: PALETTE,
  ...over,
})

const inputOf = (over: Partial<DressingInput>): DressingInput => ({
  environmentId: 'simonet',
  terrain: TERRAIN,
  heightMap: samplerOf(() => 0),
  colorMap: null,
  water: null,
  route: null,
  gates: [],
  spawnClearings: [],
  noPropVolumes: [],
  spec: { seed: 7, clearance: 0, variants: 4, bands: [] },
  ...over,
})

// ── The rules ─────────────────────────────────────────────────────────────

describe('the slope band', () => {
  // Flat for u < 0.5, then a ramp. The hinge is at mesh x = 2048, and "is this
  // placement past the hinge" is a question about a coordinate.
  const HINGE_U = 0.5
  const half = samplerOf((u) => (u < HINGE_U ? 0.1 : 0.1 + (u - HINGE_U) * 0.8))

  it('places only on the steep half when it asks for steep ground', () => {
    // `dh/du` on the ramp is 0.8, so `dy/dx` is `0.8 * terrainHeight /
    // terrainSize` = 0.8 * 1024 / 4096 = **0.2** exactly, and the slope this
    // module reports is `sin(atan(0.2))` = 0.196. A band from 0.15 to 1 takes
    // the ramp and refuses the plain; a band from 0 to 0.1 does the opposite.
    // Both numbers are arithmetic on the sampler, not a reading off `slopeAt`.
    const steep = placeBand(inputOf({ heightMap: half }), band({ slopeMin: 0.15, slopeMax: 1 }))
    const flat = placeBand(inputOf({ heightMap: half }), band({ slopeMin: 0, slopeMax: 0.1 }))
    expect(steep.count, 'the steep band found the ramp').toBeGreaterThan(100)
    expect(flat.count, 'the flat band found the plain').toBeGreaterThan(100)
    for (let i = 0; i < steep.count; i++) {
      expect(
        steep.positions[i * 3] as number,
        'a steep placement is past the hinge',
      ).toBeGreaterThan(HINGE_U * TERRAIN.terrainSize - TERRAIN.step * 2)
    }
    for (let i = 0; i < flat.count; i++) {
      expect(flat.positions[i * 3] as number, 'a flat placement is before the hinge').toBeLessThan(
        HINGE_U * TERRAIN.terrainSize + TERRAIN.step * 2,
      )
    }
    // And the two halves are about the same area, so neither rule is quietly
    // matching the whole map.
    expect(steep.count / flat.count).toBeGreaterThan(0.5)
    expect(steep.count / flat.count).toBeLessThan(2)
  })
})

describe('the altitude band', () => {
  // Height rises linearly with v: world y = v * 0.5 * 1024 = 512 * v, and
  // v = mz / 4096. So y = mz / 8, and a band of [100, 200] m is mz in
  // [800, 1600]. One division, done by hand, outside the implementation.
  const ramp = samplerOf((_u, v) => v * 0.5)

  it('places only inside the band, in world metres', () => {
    const placed = placeBand(
      inputOf({ heightMap: ramp }),
      band({ altitudeMin: 100, altitudeMax: 200 }),
    )
    expect(placed.count).toBeGreaterThan(100)
    for (let i = 0; i < placed.count; i++) {
      const mz = placed.positions[i * 3 + 2] as number
      expect(mz, 'above the band floor').toBeGreaterThanOrEqual(800 - 1)
      expect(mz, 'below the band ceiling').toBeLessThanOrEqual(1600 + 1)
      // And the y it stored is the ground it stands on.
      expect(placed.positions[i * 3 + 1] as number).toBeCloseTo(mz / 8, 3)
    }
  })

  it('measures from the WATER when `nearWater` is set', () => {
    // Same ramp, water at 140 m. A band of [10, 30] above the water is world y
    // in [150, 170], which is mz in [1200, 1360] — and it is a DIFFERENT answer
    // from the same numbers read absolutely, which is the point of the flag.
    const placed = placeBand(
      inputOf({ heightMap: ramp, water: waterAt(140) }),
      band({ nearWater: true, altitudeMin: 10, altitudeMax: 30 }),
    )
    expect(placed.count).toBeGreaterThan(20)
    for (let i = 0; i < placed.count; i++) {
      const mz = placed.positions[i * 3 + 2] as number
      expect(mz).toBeGreaterThanOrEqual(1200 - 1)
      expect(mz).toBeLessThanOrEqual(1360 + 1)
    }
  })

  it('places NOTHING from a `nearWater` band where there is no ocean', () => {
    // The desert. Not an error — there is no shore in a canyon, so the rule
    // simply has no ground to stand on.
    const placed = placeBand(
      inputOf({ heightMap: ramp, water: null }),
      band({ nearWater: true, altitudeMin: 10, altitudeMax: 30 }),
    )
    expect(placed.count).toBe(0)
  })
})

describe('route clearance', () => {
  /**
   * A dead-straight line along x at a fixed z and y, in THREE space.
   *
   * `createRoute` mirrors z on the way in, so the SIM-space line is at -z. The
   * distance from a point to it is then `hypot(dy, dz)` — arithmetic, and
   * nothing to do with `routeDistance`, which is what makes this a test of the
   * rule rather than a restatement of it.
   */
  const LINE_Z = 2000
  const LINE_Y = 40
  // **Authored at THREE z of `-LINE_Z`, on purpose.** `createRoute` mirrors z on
  // the way in, so a line written at +2000 lands at SIM -2000 — off the far side
  // of a terrain whose mesh runs 0..4096 in SIM z here, and every placement
  // would then be two kilometres clear of it and the rule would look like it
  // worked. The real loader has the same flip with the terrain's own origin on
  // the other side of it; getting it wrong HERE is what proved the pair agree.
  const straight: Route = createRoute(
    Array.from({ length: 41 }, (_, i) => [i * 100, LINE_Y, -LINE_Z]),
  )
  /** Distance from a SIM-space point to that line, measured directly. */
  const toLine = (x: number, y: number, z: number): number => {
    // The segment runs x in [0, 4000] at (y = LINE_Y, z = +LINE_Z).
    const dx = x < 0 ? -x : x > 4000 ? x - 4000 : 0
    return Math.hypot(dx, y - LINE_Y, z - LINE_Z)
  }

  const flat = samplerOf(() => 0.04) // world y = 40.96 m: level with the line

  it('keeps every placement the stated distance from the LINE', () => {
    const clearance = 120
    const placed = placeBand(
      inputOf({
        heightMap: flat,
        route: straight,
        spec: { seed: 3, clearance, variants: 4, bands: [] },
      }),
      band({ density: 2000 }),
    )
    expect(placed.count, 'the rule did not empty the map').toBeGreaterThan(1000)
    let worst = Number.POSITIVE_INFINITY
    for (let i = 0; i < placed.count; i++) {
      const p = meshToSim(
        TERRAIN,
        placed.positions[i * 3] as number,
        placed.positions[i * 3 + 1] as number,
        placed.positions[i * 3 + 2] as number,
      )
      worst = Math.min(worst, toLine(p.x, p.y, p.z))
    }
    expect(worst, 'nearest placement to the racing line').toBeGreaterThanOrEqual(clearance)
  })

  it('and without the rule, plenty of them would be on it', () => {
    // The counterpart. A guard that has never refused anything is a guard
    // nobody has tested — this is the same placement pass with the clearance at
    // zero, and it lands props right on the line.
    const placed = placeBand(
      inputOf({
        heightMap: flat,
        route: straight,
        spec: { seed: 3, clearance: 0, variants: 4, bands: [] },
      }),
      band({ density: 2000 }),
    )
    let worst = Number.POSITIVE_INFINITY
    for (let i = 0; i < placed.count; i++) {
      const p = meshToSim(
        TERRAIN,
        placed.positions[i * 3] as number,
        placed.positions[i * 3 + 1] as number,
        placed.positions[i * 3 + 2] as number,
      )
      worst = Math.min(worst, toLine(p.x, p.y, p.z))
    }
    expect(worst, 'without the rule the line is covered').toBeLessThan(10)
  })

  it('keeps clear of a GATE that is nowhere near the line', () => {
    const gate = { x: 500, y: 41, z: 500 }
    const clearance = 200
    const placed = placeBand(
      inputOf({
        heightMap: flat,
        gates: [gate],
        spec: { seed: 3, clearance, variants: 4, bands: [] },
      }),
      band({ density: 2000 }),
    )
    for (let i = 0; i < placed.count; i++) {
      const p = meshToSim(
        TERRAIN,
        placed.positions[i * 3] as number,
        placed.positions[i * 3 + 1] as number,
        placed.positions[i * 3 + 2] as number,
      )
      expect(Math.hypot(p.x - gate.x, p.y - gate.y, p.z - gate.z)).toBeGreaterThanOrEqual(clearance)
    }
  })

  it('leaves a boulder UNDER a high route alone', () => {
    // Three dimensions, not two: the line here is 600 m up, so nothing on the
    // ground is within 120 m of it and the rule must refuse nothing. A
    // horizontal-only clearance would carve a bald corridor down the whole
    // course, which is the version of this rule that looks right and is not.
    const high: Route = createRoute(Array.from({ length: 41 }, (_, i) => [i * 100, 640, -LINE_Z]))
    const clearance = 120
    const withRule = placeBand(
      inputOf({
        heightMap: flat,
        route: high,
        spec: { seed: 3, clearance, variants: 4, bands: [] },
      }),
      band({ density: 2000 }),
    )
    const without = placeBand(
      inputOf({
        heightMap: flat,
        route: null,
        spec: { seed: 3, clearance, variants: 4, bands: [] },
      }),
      band({ density: 2000 }),
    )
    expect(withRule.count).toBe(without.count)
  })
})

describe('density, determinism and the bands as a whole', () => {
  const flat = samplerOf(() => 0.1)

  it('scales with `density`, per square kilometre', () => {
    // 4096 m square is 16.777 km2. At 300 per km2 that is 5,033 expected, and
    // the roll is one Bernoulli per 8 m cell, so the spread is tiny.
    const at = (density: number): number =>
      placeBand(inputOf({ heightMap: flat }), band({ density })).count
    const one = at(300)
    const two = at(600)
    const area = (TERRAIN.terrainSize / 1000) ** 2
    expect(one / (300 * area)).toBeGreaterThan(0.93)
    expect(one / (300 * area)).toBeLessThan(1.07)
    expect(two / one).toBeGreaterThan(1.9)
    expect(two / one).toBeLessThan(2.1)
  })

  it('is deterministic in its seed', () => {
    const run = (seed: number): DressingPlacements =>
      placeBand(
        inputOf({ heightMap: flat, spec: { seed, clearance: 0, variants: 4, bands: [] } }),
        band({ density: 200 }),
      )
    const a = run(11)
    const b = run(11)
    const c = run(12)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.yaw)).toEqual(Array.from(b.yaw))
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions))
  })

  it('keeps every instance inside the scale band it was given', () => {
    const placed = placeBand(
      inputOf({ heightMap: flat }),
      band({ density: 200, scaleMin: 1.2, scaleMax: 3.2 }),
    )
    expect(placed.count).toBeGreaterThan(100)
    for (let i = 0; i < placed.count; i++) {
      expect(placed.scale[i] as number).toBeGreaterThanOrEqual(1.2)
      expect(placed.scale[i] as number).toBeLessThanOrEqual(3.2)
      expect(placed.variant[i] as number).toBeLessThan(4)
    }
  })

  it('honours a band`s `environments` list, and treats an absent one as all', () => {
    const desertOnly = band({ density: 200, environments: ['desert'] })
    expect(bandApplies(desertOnly, 'desert')).toBe(true)
    expect(bandApplies(desertOnly, 'simonet')).toBe(false)
    expect(bandApplies(band({}), 'simonet')).toBe(true)
    expect(placeBand(inputOf({ heightMap: flat }), desertOnly).count).toBe(0)
    expect(
      placeBand(inputOf({ heightMap: flat, environmentId: 'desert' }), desertOnly).count,
    ).toBeGreaterThan(100)
  })

  it('merges two bands of one KIND into one set of placements — one draw call', () => {
    // The draw-call budget is per KIND, so a steep band and a shoreline band
    // that are both boulders must not cost two.
    const spec = {
      seed: 5,
      clearance: 0,
      variants: 4,
      bands: [
        band({ kind: 'boulder', density: 100, slopeMin: 0, slopeMax: 1 }),
        band({ kind: 'boulder', density: 100, slopeMin: 0, slopeMax: 1 }),
        band({ kind: 'shrub', density: 100 }),
      ],
    }
    const out = placeDressing(inputOf({ heightMap: flat, spec }))
    expect(out.map((p) => p.kind)).toEqual(['boulder', 'shrub'])
    const boulders = out[0] as DressingPlacements
    expect(boulders.count).toBeGreaterThan(2000)
    expect(boulders.positions.length).toBe(boulders.count * 3)
    expect(boulders.color.length).toBe(boulders.count * 3)
  })

  it('tints toward the ground it stands on', () => {
    // A colour map that is pure red everywhere and a palette that is pure grey.
    // At tint 0 the instance is the palette; at 1 it is the ground; at 0.5 it is
    // halfway — three points on a line nobody has to trust the implementation for.
    const red = samplerOf(() => 0) as MapSampler
    const redMap: MapSampler = {
      width: red.width,
      height: red.height,
      sample(_u, _v, out) {
        out.r = 1
        out.g = 0
        out.b = 0
      },
    }
    const at = (tint: number): readonly [number, number, number] => {
      const p = placeBand(
        inputOf({ heightMap: flat, colorMap: redMap }),
        band({ density: 50, tint, palette: [[0.5, 0.5, 0.5]] }),
      )
      expect(p.count).toBeGreaterThan(10)
      return [p.color[0] as number, p.color[1] as number, p.color[2] as number]
    }
    expect(at(0)).toEqual([0.5, 0.5, 0.5])
    expect(at(1)[0]).toBeCloseTo(1, 6)
    expect(at(1)[1]).toBeCloseTo(0, 6)
    const half = at(0.5)
    expect(half[0]).toBeCloseTo(0.75, 6)
    expect(half[1]).toBeCloseTo(0.25, 6)
  })
})

// ── Spawn clearance ───────────────────────────────────────────────────────

describe('spawn clearance (DEV-103)', () => {
  // A flat map, so the only thing that can empty a circle is the rule; and the
  // synthetic spawn sits off-centre, off-diagonal and away from the edges — the
  // origin is where a frame bug hides ("a spot-check is a smoke test").
  const flat = samplerOf(() => 0.1)
  const SPAWN = { x: 1234.5, z: 2987.25, radius: 51.973 }
  const dense = band({ density: 2000 })
  const insideOf = (c: { x: number; z: number; radius: number }) => {
    return (p: DressingPlacements, i: number): boolean => {
      const dx = (p.positions[i * 3] as number) - c.x
      const dz = (p.positions[i * 3 + 2] as number) - c.z
      return dx * dx + dz * dz < c.radius * c.radius
    }
  }
  const countInside = (p: DressingPlacements, c: { x: number; z: number; radius: number }) => {
    const inside = insideOf(c)
    let n = 0
    for (let i = 0; i < p.count; i++) if (inside(p, i)) n++
    return n
  }

  it('places nothing inside the cylinder — and without the rule, plenty would be', () => {
    const uncleared = placeBand(inputOf({ heightMap: flat }), dense)
    const cleared = placeBand(inputOf({ heightMap: flat, spawnClearings: [SPAWN] }), dense)
    const refused = countInside(uncleared, SPAWN)
    // The counterpart first: a guard that has never been seen to refuse
    // something is not known to be a guard.
    expect(refused, 'the synthetic spawn must have placements to refuse').toBeGreaterThan(5)
    expect(countInside(cleared, SPAWN)).toBe(0)
    expect(uncleared.count - cleared.count, 'it drops those and nothing else').toBe(refused)
  })

  it('subtracts and moves nothing: every kept placement is bit-identical to the uncleared draw', () => {
    // The seven appearance draws are spent BEFORE the gate, so clearing one pad
    // cannot re-roll the yaw, scale, variant or colour of anything else. Stated
    // as a subsequence check over every field — the same shape
    // `spawn-clearing.test.ts` holds the 2016 scatter to.
    const uncleared = placeBand(inputOf({ heightMap: flat }), dense)
    const cleared = placeBand(inputOf({ heightMap: flat, spawnClearings: [SPAWN] }), dense)
    expect(cleared.count).toBeLessThan(uncleared.count)
    let ai = 0
    for (let k = 0; k < cleared.count; k++) {
      let matched = false
      while (ai < uncleared.count) {
        const i = ai++
        const same =
          uncleared.positions[i * 3] === cleared.positions[k * 3] &&
          uncleared.positions[i * 3 + 1] === cleared.positions[k * 3 + 1] &&
          uncleared.positions[i * 3 + 2] === cleared.positions[k * 3 + 2] &&
          uncleared.yaw[i] === cleared.yaw[k] &&
          uncleared.tilt[i] === cleared.tilt[k] &&
          uncleared.tiltDir[i] === cleared.tiltDir[k] &&
          uncleared.scale[i] === cleared.scale[k] &&
          uncleared.squash[i] === cleared.squash[k] &&
          uncleared.variant[i] === cleared.variant[k] &&
          uncleared.color[i * 3] === cleared.color[k * 3] &&
          uncleared.color[i * 3 + 1] === cleared.color[k * 3 + 1] &&
          uncleared.color[i * 3 + 2] === cleared.color[k * 3 + 2]
        if (same) {
          matched = true
          break
        }
      }
      expect(matched, `kept placement ${k} is not the one the uncleared draw made`).toBe(true)
    }
  })

  it('is a vertical cylinder: the height of the ground under a spawn is no excuse', () => {
    // The LINEAR-IN-Z ramp again (y = mz / 8): a cylinder at mz 3200 stands on
    // ground 400 m up, one at mz 320 on ground 40 m up, and both must empty
    // their circles. The ROUTE rule, by contrast, leaves a boulder under a high
    // line alone (see 'route clearance'): two rules, two shapes, both right,
    // and this is the assertion that keeps them from being confused.
    const ramp = samplerOf((_u, v) => v * 0.5)
    for (const mz of [3200, 320]) {
      const c = { x: 2000.5, z: mz, radius: 80 }
      const uncleared = placeBand(inputOf({ heightMap: ramp }), dense)
      const cleared = placeBand(inputOf({ heightMap: ramp, spawnClearings: [c] }), dense)
      const refused = countInside(uncleared, c)
      expect(refused, `something to refuse at mz ${mz}`).toBeGreaterThan(5)
      expect(countInside(cleared, c)).toBe(0)
      expect(uncleared.count - cleared.count).toBe(refused)
    }
  })

  it('an empty list, or a zero radius, changes nothing at all', () => {
    const a = placeBand(inputOf({ heightMap: flat }), dense)
    const b = placeBand(inputOf({ heightMap: flat, spawnClearings: [] }), dense)
    const c = placeBand(
      inputOf({ heightMap: flat, spawnClearings: [{ x: SPAWN.x, z: SPAWN.z, radius: 0 }] }),
      dense,
    )
    expect(b.count).toBe(a.count)
    expect(c.count).toBe(a.count)
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions))
    expect(Array.from(c.positions)).toEqual(Array.from(a.positions))
    expect(Array.from(b.yaw)).toEqual(Array.from(a.yaw))
  })

  it('reads the environment receipt as-is: one cylinder per mission, the recorded radius on each', () => {
    // The seam the runtime crosses. The receipt is DEV-100's, in the terrain's
    // mesh space already; the mapping must add nothing, convert nothing and
    // drop nothing.
    const env = {
      spawnClearing: {
        radius: 51.973,
        source: 's',
        note: 'n',
        missions: [
          { id: 'a', x: 607.5, z: 261.6 },
          { id: 'b', x: 2752.8, z: 1580.1 },
        ],
      },
    }
    expect(spawnClearingsOf(env)).toEqual([
      { x: 607.5, z: 261.6, radius: 51.973 },
      { x: 2752.8, z: 1580.1, radius: 51.973 },
    ])
    // No JSON, or a JSON baked before DEV-100: nothing to clear against, and
    // that is the caller's to report rather than this function's to invent.
    expect(spawnClearingsOf(null)).toEqual([])
    expect(spawnClearingsOf({})).toEqual([])
  })
})

// ── Flocks ────────────────────────────────────────────────────────────────

describe('the flocks', () => {
  const LINE_Z = 2000
  // THREE z negative so the SIM line lands ON the terrain — see the note in the
  // route-clearance block above.
  const straight: Route = createRoute(Array.from({ length: 41 }, (_, i) => [i * 100, 300, -LINE_Z]))
  const toLine = (x: number, y: number, z: number): number => {
    const dx = x < 0 ? -x : x > 4000 ? x - 4000 : 0
    return Math.hypot(dx, y - 300, z - LINE_Z)
  }
  const ground = samplerOf(() => 0.1) // world y = 102.4 m
  const SPEC = {
    flocks: 5,
    birdsPerFlock: 12,
    altitude: 55,
    radius: 60,
    speed: 11,
    size: 1,
    palette: [[0.05, 0.05, 0.06]] as readonly (readonly number[])[],
  }

  const input = (clearance: number): DressingInput =>
    inputOf({
      heightMap: ground,
      route: straight,
      spec: { seed: 9, clearance, variants: 4, bands: [] },
    })

  it('places them along the course, off the line, at the altitude asked for', () => {
    const flocks = placeFlocks(input(45), SPEC, 31)
    expect(flocks.length).toBe(SPEC.flocks)
    const arcs: number[] = []
    for (const f of flocks) {
      // Above the GROUND under its own centre, exactly — not above the sea and
      // not above the route.
      expect(f.centre[1]).toBeCloseTo(0.1 * TERRAIN.terrainHeight + SPEC.altitude, 4)
      expect(f.birds.length).toBe(SPEC.birdsPerFlock)
      arcs.push(f.centre[0])
    }
    // Spread along the line rather than piled at one end.
    arcs.sort((a, b) => a - b)
    expect((arcs[arcs.length - 1] as number) - (arcs[0] as number)).toBeGreaterThan(2000)
  })

  it('keeps every bird clear of the line, ALL THE WAY ROUND', () => {
    // Not "the centre is far enough" — the line bends, and a loop 60 m across
    // sweeps 120 m of it. Every bird, sixteen samples of a lap, measured against
    // the straight line directly.
    const clearance = 45
    const flocks = placeFlocks(input(clearance), SPEC, 31)
    expect(flocks.length).toBeGreaterThan(0)
    const pose = birdPose()
    let worst = Number.POSITIVE_INFINITY
    for (const f of flocks) {
      const period = flockPeriod(f)
      for (const b of f.birds) {
        for (let i = 0; i < 32; i++) {
          birdAt(f, b, (i / 32) * period, pose)
          const p = meshToSim(TERRAIN, pose.x, pose.y, pose.z)
          worst = Math.min(worst, toLine(p.x, p.y, p.z))
        }
      }
      expect(flockIsClear(input(clearance), f)).toBe(true)
    }
    expect(worst, 'nearest bird to the racing line over a whole lap').toBeGreaterThanOrEqual(
      clearance,
    )
  })

  it('gives every bird its own wing phase — a flock in unison is a mobile', () => {
    const flocks = placeFlocks(input(45), SPEC, 31)
    const phases = new Set<number>()
    let birds = 0
    for (const f of flocks) {
      for (const b of f.birds) {
        phases.add(b.wingPhase)
        birds++
        expect(b.wingPhase).toBeGreaterThanOrEqual(0)
        expect(b.wingPhase).toBeLessThan(Math.PI * 2)
      }
    }
    expect(birds).toBe(SPEC.flocks * SPEC.birdsPerFlock)
    expect(phases.size, 'every phase distinct').toBe(birds)
  })

  it('places none at all on a course with no racing line', () => {
    // A Target Practice mission has no route, and therefore no "beside the
    // line" to be beside. Five of the thirteen are in that state.
    expect(placeFlocks(inputOf({ heightMap: ground, route: null }), SPEC, 31)).toHaveLength(0)
  })

  it('is deterministic in its seed', () => {
    const a = placeFlocks(input(45), SPEC, 31)
    const b = placeFlocks(input(45), SPEC, 31)
    const c = placeFlocks(input(45), SPEC, 32)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c))
  })
})

// ── The shipped presets ───────────────────────────────────────────────────

const readPreset = (id: string): Edition =>
  validateEdition(JSON.parse(fs.readFileSync(`content/editions/${id}.json`, 'utf8')) as Edition)

describe('the presets', () => {
  it('Classic produces ZERO placements and zero flocks', () => {
    // The invariant the whole split rests on, stated where V9 can break it:
    // Classic's scenery is 2016's 1,241 palms and nothing else. Not "a field
    // with no instances in it" — no field at all.
    const classic = readPreset('classic')
    expect(dressingSpecFor(classic.props)).toBeNull()
    for (const [where, feature] of editionFeatures(classic)) {
      if (where.startsWith('props')) expect(feature.enabled, `classic ${where}`).toBe(false)
    }
    const spec = { seed: 1, clearance: 45, variants: 4, bands: [] }
    expect(placeDressing(inputOf({ heightMap: samplerOf(() => 0.2), spec }))).toHaveLength(0)
  })

  it('Anniversary asks for all three kinds, and for birds', () => {
    const anniversary = readPreset('anniversary')
    const spec = dressingSpecFor(anniversary.props)
    expect(spec).not.toBeNull()
    const kinds = new Set((spec as NonNullable<typeof spec>).bands.map((b) => b.kind))
    expect([...kinds].sort()).toEqual(['boulder', 'rock', 'shrub'])
    expect(anniversary.props.birds.enabled).toBe(true)
    expect(anniversary.props.birds.flocks).toBeGreaterThan(0)
    // A band that applies to NO environment is a band nobody will ever see.
    for (const b of (spec as NonNullable<typeof spec>).bands) {
      const reachable = ['simonet', 'kauai', 'desert', 'alpine'].filter((e) => bandApplies(b, e))
      expect(reachable.length, `${b.kind} band reaches an environment`).toBeGreaterThan(0)
    }
  })

  it('prints what the shipped densities produce on a SYNTHETIC island', () => {
    // **Not Simonet.** The real height and colour maps are gitignored and
    // pulled from R2, so this builds an archipelago at Simonet's dimensions —
    // 4,096 m square, 1,024 m of relief, sea at 116 m — and reports what the
    // shipped numbers do to it. The shape of the island is invented; the
    // DENSITIES, the bands and the arithmetic are the shipped ones, so the
    // order of magnitude is the thing this is evidence for and the exact count
    // is not.
    const SEA = 116
    const islands: readonly (readonly [number, number, number, number])[] = [
      // u, v, radius (in uv), peak (normalised height)
      [0.32, 0.36, 0.2, 0.62],
      [0.66, 0.3, 0.15, 0.45],
      [0.55, 0.7, 0.22, 0.78],
      [0.18, 0.74, 0.11, 0.3],
    ]
    const archipelago = samplerOf((u, v) => {
      let h = SEA / TERRAIN.terrainHeight - 0.04
      for (const [cu, cv, r, peak] of islands) {
        const d = Math.hypot(u - cu, v - cv) / r
        if (d < 1) {
          // A cosine dome with a ridged flank, so the slope band has something
          // to bite on rather than one smooth gradient.
          h += peak * (0.5 + 0.5 * Math.cos(Math.PI * d)) * (0.82 + 0.18 * Math.cos(d * 34))
        }
      }
      return h
    })
    const anniversary = readPreset('anniversary')
    const spec = dressingSpecFor(anniversary.props)
    expect(spec).not.toBeNull()
    const route: Route = createRoute(
      Array.from({ length: 200 }, (_, i) => {
        const t = (i / 199) * Math.PI * 2
        // Negative THREE z, so the mirrored SIM line lies over the island.
        return [2048 + 1300 * Math.cos(t), 260 + 90 * Math.sin(t * 3), -(2048 + 1100 * Math.sin(t))]
      }),
    )
    const input = inputOf({
      heightMap: archipelago,
      colorMap: archipelago,
      water: waterAt(SEA),
      route,
      spec: spec as NonNullable<typeof spec>,
    })
    const out = placeDressing(input)
    const flocks = placeFlocks(
      input,
      {
        flocks: anniversary.props.birds.flocks,
        birdsPerFlock: anniversary.props.birds.birdsPerFlock,
        altitude: anniversary.props.birds.altitude,
        radius: anniversary.props.birds.radius,
        speed: anniversary.props.birds.speed,
        size: anniversary.props.birds.size,
        palette: anniversary.props.birds.palette,
      },
      1,
    )
    let total = 0
    const lines: string[] = []
    for (const p of out) {
      total += p.count
      lines.push(`  ${p.kind.padEnd(8)} ${String(p.count).padStart(6)} instances, 1 draw call`)
    }
    let birds = 0
    for (const f of flocks) birds += f.birds.length
    console.log(
      `dressing on a SYNTHETIC 4096 m archipelago (sea ${SEA} m), Anniversary densities:\n` +
        `${lines.join('\n')}\n` +
        `  birds    ${String(birds).padStart(6)} instances in ${flocks.length} flocks, 1 draw call\n` +
        `  TOTAL    ${String(total + birds).padStart(6)} instances in ${out.length + (flocks.length > 0 ? 1 : 0)} draw calls`,
    )
    // Not a number, a MAGNITUDE: enough to change what the ground looks like,
    // far enough under the palms' own order of magnitude to be affordable. If
    // this ever fails, somebody moved a density and should look at a frame.
    expect(total).toBeGreaterThan(500)
    expect(total).toBeLessThan(40_000)
    expect(out.length).toBeLessThanOrEqual(3)
    expect(flocks.length).toBeGreaterThan(0)
  })
})
