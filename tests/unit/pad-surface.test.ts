// tests/unit/pad-surface.test.ts — the JumpSeat lands on the pad (DEV-120).
//
// Matt, 2026-09-16: "jumpseat - the landing pads / targets have no collision! i
// just fall right through!" Every assertion here is a HEIGHT or a DISTANCE read
// off the running model, never the profile re-derived: a seat dropped on a pad
// comes to rest at the pad's tier, beside it reaches the ground, on a slope it
// rests on the pad and not on the hillside under it. The pad geometry comes out
// of the level JSON — the same `pads[].solid` the game reads — so the numbers
// below are the shipped collider's, at the shipped scale.

import { describe, expect, it } from 'vitest'
import { padFieldsFor } from '@/game/jumpseat-flight'
import { padStreakRules, padZones } from '@/game/targets'
import { JUMPSEAT } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import {
  createJumpSeat,
  noJumpSeatInput,
  stepJumpSeat,
  updateJumpSeatFootProbes,
} from '@/sim/jumpseat'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { buildPadField, ngonRadius, profileHeight } from '@/sim/pad-surface'
import { createTargets, stepTargetsProbes } from '@/sim/targets'
import {
  type HeightField,
  outsideField,
  terrainHeightAt,
  terrainNormalAt,
} from '@/sim/terrain/height-field'
import {
  createTerrainCollision,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { levelJson as level } from './helpers/content'

const rookie = level('rookie_01_jumpSeat')
const pad0 = rookie.pads[0]
if (!pad0?.solid)
  throw new Error('rookie_01_jumpSeat pad 0 carries no solid — run pnpm extract:levels')
const solid = pad0.solid

/** A flat synthetic ground at `y`, wide enough to be under anything here. */
const flatGround = (y: number, x0: number, z0: number, size = 4000): HeightField => ({
  vertPerSide: 2,
  heights: new Float32Array([0, 0, 0, 0]),
  step: size,
  terrainSize: size,
  terrainHeight: 1,
  originX: x0 - size / 2,
  originY: y,
  originZ: z0 - size / 2,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
})

/** A ground sloping up along +x by `rise` over `size`, at `y0` on its low edge. */
const slopedGround = (
  y0: number,
  rise: number,
  x0: number,
  z0: number,
  size = 4000,
): HeightField => ({
  vertPerSide: 2,
  heights: new Float32Array([0, 1, 0, 1]),
  step: size,
  terrainSize: size,
  terrainHeight: rise,
  originX: x0 - size / 2,
  originY: y0,
  originZ: z0 - size / 2,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
})

const COLLISION: TerrainCollisionSpec = {
  hull: hullFromColliders(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ),
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}

/** The pad's collider node in SIM space, the way the seam converts it. */
const padCentreSim = v3(solid.pos[0], solid.pos[1], -solid.pos[2])
const padRootY = pad0.pos[1]

/** Drop a live, unpowered seat from `height` above the pad root at a local offset and let it settle. */
const dropSeat = (fields: readonly HeightField[], x: number, z: number, y: number, seconds = 8) => {
  const seat = createJumpSeat()
  seat.live = true
  seat.body.position.x = x
  seat.body.position.y = y
  seat.body.position.z = z
  const collision = createTerrainCollision()
  const input = noJumpSeatInput()
  const steps = Math.ceil(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    stepJumpSeat(seat, input, fields, FIXED_DT)
    stepTerrainCollision(collision, seat.body, fields, COLLISION, FIXED_DT)
    updateJumpSeatFootProbes(seat)
  }
  return seat
}

describe('the n-gon norm', () => {
  const cosHalf = Math.cos(Math.PI / 8)
  it('equals the Euclidean radius on a vertex ray and exceeds it on an edge ray', () => {
    expect(ngonRadius(5, 0, 8, cosHalf)).toBeCloseTo(5, 9)
    expect(ngonRadius(0, -5, 8, cosHalf)).toBeCloseTo(5, 9)
    // A vertex on the diagonal too — the octagon's vertices are at every 45 degrees.
    expect(ngonRadius(5 / Math.SQRT2, 5 / Math.SQRT2, 8, cosHalf)).toBeCloseTo(5, 9)
    // Edge midpoint direction: the boundary is nearer, so the norm reads larger.
    const a = Math.PI / 8
    expect(ngonRadius(5 * Math.cos(a), 5 * Math.sin(a), 8, cosHalf)).toBeCloseTo(5 / cosHalf, 9)
  })
  it('puts the edge midpoint of a circumradius-R octagon exactly on R', () => {
    const R = 7.058264
    const a = Math.PI / 8
    const e = R * cosHalf
    expect(ngonRadius(e * Math.cos(a), e * Math.sin(a), 8, cosHalf)).toBeCloseTo(R, 6)
  })
})

describe('the shipped pad profile', () => {
  it('is a three-tier bowl with the centre LOWEST — 2016 landed in a dish, not on a plate', () => {
    const at = (r: number) => profileHeight(solid.profile, r) + solid.pos[1] - padRootY
    expect(at(0)).toBeCloseTo(-1.784, 2)
    expect(at(5)).toBeCloseTo(-1.784, 2)
    expect(at(10)).toBeCloseTo(-0.35, 2)
    expect(at(16)).toBeCloseTo(0.97, 2)
    expect(at(19.5)).toBeCloseTo(0.97, 2)
    expect(at(0)).toBeLessThan(at(10))
    expect(at(10)).toBeLessThan(at(16))
  })
  it('extends FLAT past the rim rather than to -Infinity — the NaN that scored every plate', () => {
    expect(Number.isFinite(profileHeight(solid.profile, solid.outer + 5))).toBe(true)
    const field = buildPadField({
      centre: padCentreSim,
      orientation: { x: -solid.quat[0], y: -solid.quat[1], z: solid.quat[2], w: solid.quat[3] },
      symmetry: solid.symmetry,
      profile: solid.profile,
      outer: solid.outer,
    })
    // Every point just inside the rim, all the way round, has a finite normal.
    const n = { x: 0, y: 0, z: 0 }
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * 2 * Math.PI
      const r = solid.outer - 0.02
      const x = padCentreSim.x + r * Math.cos(a)
      const z = padCentreSim.z + r * Math.sin(a)
      if (outsideField(field, x, z)) continue
      terrainNormalAt(field, x, z, n)
      expect(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)).toBe(true)
    }
  })
  it('the scoring plates sit a few centimetres PROUD of their tier floors', () => {
    // The relationship the foot probes depend on: a foot standing on the floor is
    // inside the plate box above it. Bullseye over tier 1, mid over tier 2, outer
    // over tier 3 — every plate's top is above its floor by 1 to 51 cm (the
    // 51 is one mid plate authored 0.66 m thick where its neighbours are 0.16).
    const floorAt = (r: number) => profileHeight(solid.profile, r) + solid.pos[1]
    for (const zone of pad0.zones) {
      const r = Math.hypot(zone.pos[0] - pad0.pos[0], zone.pos[2] - pad0.pos[2])
      const top = zone.pos[1] + zone.half[1]
      const proud = top - floorAt(r)
      expect(proud, zone.path).toBeGreaterThan(0.01)
      expect(proud, zone.path).toBeLessThan(0.6)
    }
  })
})

describe('the pad as a HeightField', () => {
  const [field] = padFieldsFor(rookie)
  if (!field) throw new Error('no pad field')
  it('turns its octagon with the pad — a vertex ray and an edge ray disagree where a disc would not', () => {
    // The pad's local +x in SIM space, through the same quaternion the seam uses.
    const q = { x: -solid.quat[0], y: -solid.quat[1], z: solid.quat[2], w: solid.quat[3] }
    const vertexRay = rotateVec3(v3(), q, v3(1, 0, 0))
    const a = Math.PI / 8
    const edgeRay = rotateVec3(v3(), q, v3(Math.cos(a), 0, Math.sin(a)))
    // At 7.3 m the vertex ray is still on the tier-1 lip (r_oct 7.3), while the
    // edge ray's n-gon radius is 7.3 / cos(22.5) = 7.9 m: on the ramp up to tier 2.
    const r = 7.3
    const hv = terrainHeightAt(
      field,
      padCentreSim.x + vertexRay.x * r,
      padCentreSim.z + vertexRay.z * r,
    )
    const he = terrainHeightAt(
      field,
      padCentreSim.x + edgeRay.x * r,
      padCentreSim.z + edgeRay.z * r,
    )
    expect(he - hv).toBeGreaterThan(0.3)
    // And the centre is the bullseye floor.
    expect(terrainHeightAt(field, padCentreSim.x, padCentreSim.z) - padRootY).toBeCloseTo(-1.784, 2)
  })
  it('exists only under the octagon', () => {
    expect(outsideField(field, padCentreSim.x, padCentreSim.z)).toBe(false)
    expect(outsideField(field, padCentreSim.x + solid.outer + 1, padCentreSim.z)).toBe(true)
    expect(outsideField(field, padCentreSim.x + 500, padCentreSim.z)).toBe(true)
  })
})

describe('a seat dropped onto the pad', () => {
  const ground = flatGround(padRootY - 60, padCentreSim.x, padCentreSim.z)
  const fields = [ground, ...padFieldsFor(rookie)]

  it('comes to rest on the bullseye floor, on its gear, and not on the ground 60 m below', () => {
    const seat = dropSeat(fields, padCentreSim.x, padCentreSim.z, padRootY + 6)
    const floor = padRootY - 1.784
    const height = seat.body.position.y - floor
    // Parked on its gear: `jumpseat-legs.test.ts` measures 1.12 m over flat
    // ground; the hover motor carries part of the weight either way.
    expect(height).toBeGreaterThan(0.8)
    expect(height).toBeLessThan(1.6)
    // Parked, not falling: the gear and the hover motor trade a few tenths of a
    // metre per second between them at rest (measured 0.31 at 8 s); a seat
    // still descending through the floor would read the 32 m/s² of free fall.
    expect(Math.abs(seat.body.velocity.y)).toBeLessThan(0.6)
    // Every foot on the floor, within the capsule's own radius.
    for (const probe of seat.footProbes) {
      expect(probe.to.y - floor).toBeGreaterThan(0)
      expect(probe.to.y - floor).toBeLessThan(0.35)
    }
  })

  it('dropped BESIDE the pad reaches the ground instead', () => {
    const seat = dropSeat(fields, padCentreSim.x + solid.outer + 8, padCentreSim.z, padRootY + 6)
    const height = seat.body.position.y - (padRootY - 60)
    expect(height).toBeGreaterThan(0.8)
    expect(height).toBeLessThan(1.6)
  })

  it('dropped on the outer ring rests 2.75 m higher than on the bullseye — the tiers are real', () => {
    const q = { x: -solid.quat[0], y: -solid.quat[1], z: solid.quat[2], w: solid.quat[3] }
    const ray = rotateVec3(v3(), q, v3(1, 0, 0))
    const r = 16.5
    const outer = dropSeat(
      fields,
      padCentreSim.x + ray.x * r,
      padCentreSim.z + ray.z * r,
      padRootY + 6,
    )
    const centre = dropSeat(fields, padCentreSim.x, padCentreSim.z, padRootY + 6)
    expect(outer.body.position.y - centre.body.position.y).toBeCloseTo(0.97 + 1.784, 0)
  })

  it('on a slope rests on the PAD, not on the hillside under it', () => {
    // Ground rising 40 m per 4 km, passing 20 m under the pad centre: the pad is
    // the higher surface everywhere under its footprint and wins.
    const slope = slopedGround(padRootY - 20 - 20, 40, padCentreSim.x, padCentreSim.z)
    const seat = dropSeat(
      [slope, ...padFieldsFor(rookie)],
      padCentreSim.x,
      padCentreSim.z,
      padRootY + 6,
    )
    expect(seat.body.position.y - (padRootY - 1.784)).toBeGreaterThan(0.8)
    expect(seat.body.position.y - (padRootY - 1.784)).toBeLessThan(1.6)
  })

  it('a second seat parked beside the first leaves the first where it was (trap 19)', () => {
    const a = dropSeat(fields, padCentreSim.x, padCentreSim.z, padRootY + 6)
    const ay = a.body.position.y
    const aFoot = a.footProbes[0]?.to.y
    dropSeat(fields, padCentreSim.x + 5, padCentreSim.z, padRootY + 6)
    expect(a.body.position.y).toBe(ay)
    expect(a.footProbes[0]?.to.y).toBe(aFoot)
  })
})

describe('the feet score the plate they stand on', () => {
  const ground = flatGround(padRootY - 60, padCentreSim.x, padCentreSim.z)
  const fields = [ground, ...padFieldsFor(rookie)]
  const zones = padZones(rookie)

  it('a seat landed on the bullseye floor scores the bullseye through its feet, and its body would not', () => {
    const seat = dropSeat(fields, padCentreSim.x, padCentreSim.z, padRootY + 6)
    const targets = createTargets(zones, rookie.pads.filter((p) => p.live).length, padStreakRules())
    const hit = stepTargetsProbes(targets, seat.footProbes)
    expect(hit).toBeGreaterThanOrEqual(0)
    expect(zones[hit]?.points).toBe(100)
    expect(zones[hit]?.pad).toBe(0)
    // The body origin parks 1 m above the floor, above the plate's top — the
    // reason the feet are the probe. Same seat, body-swept: nothing.
    const body = createTargets(zones, rookie.pads.filter((p) => p.live).length, padStreakRules())
    const probes = [{ from: seat.body.position, to: seat.body.position, radius: 0 }]
    expect(stepTargetsProbes(body, probes)).toBe(-1)
  })

  it('landed on the mid ring scores 50, not the bullseye', () => {
    const q = { x: -solid.quat[0], y: -solid.quat[1], z: solid.quat[2], w: solid.quat[3] }
    const ray = rotateVec3(v3(), q, v3(1, 0, 0))
    const r = 10
    const seat = dropSeat(
      fields,
      padCentreSim.x + ray.x * r,
      padCentreSim.z + ray.z * r,
      padRootY + 6,
    )
    const targets = createTargets(zones, rookie.pads.filter((p) => p.live).length, padStreakRules())
    const hit = stepTargetsProbes(targets, seat.footProbes)
    expect(hit).toBeGreaterThanOrEqual(0)
    expect(zones[hit]?.points).toBe(50)
  })
})
