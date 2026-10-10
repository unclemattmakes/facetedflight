// tests/unit/crash-reset-pads.test.ts: the crash reset and the hull clearance
// count floating pads the way the hull and the JumpSeat legs do. DEV-705.
//
// Matt, 2026-10-05, on SG-4: a point UNDER a floating pad is under it, not in
// it (`belowField`, DEV-383). Before this, `planCrashReset`'s lift and
// `hullClearance` read every pad as solid down to the ground, so
//
//   * a line point that ran BENEATH a pad was lifted up THROUGH it, onto the
//     pad's top plus `clearanceMetres` (the DEV-383 "120 m teleport", by
//     another door), and
//   * the clearance G1 reads under a pad was the (large, negative) height of
//     the pad above the ship rather than the ground below it.
//
// The autopilots and the instructor are deliberately NOT changed (their rule
// is pinned to the bit in `ground-under.test.ts`).
//
// The geometry is synthetic and the numbers are chosen to separate the two
// readings (trap: a rule tested only where both explanations agree has not
// been tested): ground 0 m, a pad whose top is 300 m and whose underside is
// 280 m, a line at three heights, and `clearanceMetres` 40.

import { describe, expect, it } from 'vitest'
import { type CrashSpec, createCrash, planCrashReset } from '@/sim/crash'
import { v3 } from '@/sim/math/vec3'
import { buildPadField } from '@/sim/pad-surface'
import { createRigidBody } from '@/sim/rigidbody'
import { createRoute, routeAt } from '@/sim/route'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { hullClearance, type TerrainCollisionSpec } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'

const SPEC = (anniversary as unknown as { gameplay: { crash: CrashSpec } }).gameplay.crash
// The rule under test is the lift; the prop search is off exactly as in `props: null` runs.
const NO_SEARCH: CrashSpec = { ...SPEC, resetClearStepMetres: 0 }

const PARAMS = {
  terrainSize: 4096,
  terrainHeight: 600,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

const flatMap = (): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = 0
      out.g = 0
      out.b = 0
      return out
    },
  }) as unknown as MapSampler

const GROUND = buildHeightField(flatMap(), PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
const PAD_X = 1000
const PAD_Z = 1000
const PAD_TOP = 300
const UNDERSIDE = 280
const PAD = buildPadField({
  centre: { x: PAD_X, y: PAD_TOP, z: PAD_Z },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
  symmetry: 8,
  profile: [
    [0, 0],
    [60, 0],
  ],
  outer: 60,
  bottom: UNDERSIDE - PAD_TOP,
})

/** A straight line along +x through the pad, at height `y`, 400 m long. */
const lineAt = (y: number) =>
  // Authored points are THREE space; `createRoute` mirrors z into SIM.
  createRoute([
    [800, y, -PAD_Z],
    [1200, y, -PAD_Z],
  ])

/** Crash at arc 320 (x = 1120); the reset is `resetBackMetres` behind, at arc 200 (x = 1000, over the pad). */
const resetFor = (y: number, fields: Parameters<typeof planCrashReset>[4]) => {
  const route = lineAt(y)
  const body = createRigidBody()
  routeAt(route, 320, body.position)
  const state = createCrash()
  planCrashReset(state, NO_SEARCH, body, { route, limitS: route.length }, fields)
  return state.reset.position
}

describe('DEV-705: the crash reset reads a floating pad by its underside', () => {
  it('the fixture is what it says: the reset lands over the pad centre', () => {
    const at = resetFor(150, [GROUND, PAD])
    expect(at.x).toBeCloseTo(PAD_X, 6)
    expect(at.z).toBeCloseTo(PAD_Z, 6)
    expect(SPEC.resetBackMetres).toBe(120)
    expect(SPEC.clearanceMetres).toBe(40)
  })

  it('a line UNDER the pad is not lifted through it (fails before DEV-705)', () => {
    // 150 m is above ground + clearance (40), below the underside (280). Read as
    // solid-to-the-ground, the pad's 300 m lifted the reset to 340 m, above it.
    const at = resetFor(150, [GROUND, PAD])
    expect(at.y).toBe(150)
  })

  it('a line UNDER the pad but near the ground is lifted off the GROUND, not the pad', () => {
    const at = resetFor(10, [GROUND, PAD])
    expect(at.y).toBe(0 + SPEC.clearanceMetres)
  })

  it('a line over the pad lands on the PAD, not the ground below (the case that never changed)', () => {
    // 310 m is above the pad's top but under pad + clearance (340): lifted to 340.
    const at = resetFor(310, [GROUND, PAD])
    expect(at.y).toBe(PAD_TOP + SPEC.clearanceMetres)
  })

  it('a line INSIDE the slab counts the pad too', () => {
    const at = resetFor(290, [GROUND, PAD])
    expect(at.y).toBe(PAD_TOP + SPEC.clearanceMetres)
  })

  it("with no pad in the world the lift is the ground's alone", () => {
    expect(resetFor(10, [GROUND]).y).toBe(SPEC.clearanceMetres)
    expect(resetFor(150, [GROUND]).y).toBe(150)
  })
})

describe('DEV-705: hullClearance reads a floating pad by its underside', () => {
  const HULL = [{ x: 0, y: 0, z: 0, radius: 2 }]
  const hullSpec = { hull: HULL } as unknown as TerrainCollisionSpec
  const at = (y: number) => createRigidBody({ position: v3(PAD_X, y, PAD_Z) })

  it('a ship under the pad is clear of the GROUND below, not "inside" the pad above (fails before DEV-705)', () => {
    // 150 m up: 148 m above the ground (centre minus radius). Read as solid to
    // the ground the pad was 300 m up and the answer was 148 - 300 = -152.
    expect(hullClearance(at(150), [GROUND, PAD], hullSpec)).toBe(148)
  })

  it('a ship on the pad is clear of the pad, as before', () => {
    expect(hullClearance(at(PAD_TOP + 12), [GROUND, PAD], hullSpec)).toBe(10)
  })

  it('and equals what the collision loop would resolve: buried only when the hull reaches the slab', () => {
    // The sphere is wholly under the underside while its TOP is below 280:
    // centre 277 + radius 2 = 279 < 280, so under; centre 279 + 2 = 281 counts it.
    expect(hullClearance(at(277), [GROUND, PAD], hullSpec)).toBe(275)
    expect(hullClearance(at(279), [GROUND, PAD], hullSpec)).toBe(277 - PAD_TOP)
  })
})
