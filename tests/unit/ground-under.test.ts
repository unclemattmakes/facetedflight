// tests/unit/ground-under.test.ts: one "highest ground under (x, z)" (SG-4).
//
// `highestGroundUnder` replaced eight hand-written loops, and a consolidation
// changes no behaviour, so this file keeps the loops it replaced, verbatim,
// as ORACLES and fuzzes the helper against each to the BIT (`Object.is`):
//
//   * the `min(y - h)` copies (autopilot `pathClearance`, instructor)
//   * the `max(h)` copy (the crash reset's lift)
//   * the `belowField` copies (JumpSeat legs and autopilot, head depth)
//   * hull sphere to world (SG-9): the copy-to-scratch-and-rotate spelling
//
// The oracles are NOT re-derived from the helper (trap 24): each is the old
// source text. The fields are a rolling grid plus a floating pad with an
// underside, so the `belowField` branch is taken, not just the grid branch.

import { describe, expect, it } from 'vitest'
import { pathClearance } from '@/sim/autopilot'
import { headBox, headDepth } from '@/sim/jumpseat-head'
import { type Quat, rotateVec3 } from '@/sim/math/quat'
import { mulberry32 } from '@/sim/math/rng'
import { v3 } from '@/sim/math/vec3'
import { buildPadField } from '@/sim/pad-surface'
import { createRigidBody } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import {
  belowField,
  buildHeightField,
  type HeightField,
  highestGroundUnder,
  outsideField,
  PADS_SOLID,
  terrainHeightAt,
} from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import type { TerrainCollisionSpec } from '@/sim/terrain-collision'
import { type HullSphere, hullClearance, hullSphereWorld } from '@/sim/terrain-collision'

const PARAMS = {
  terrainSize: 4096,
  terrainHeight: 600,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/** Rolling ground, so every sample is a different bilinear blend. */
const rollingMap = (): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = 0.25 + 0.2 * Math.sin(u * 61) * Math.cos(v * 47)
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const GROUND = buildHeightField(rollingMap(), PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
const PAD_CX = 1000
const PAD_CZ = 1000
const PAD_Y = 400
/** A floating pad: surface at PAD_Y, underside 20 m below it. */
const PAD = buildPadField({
  centre: { x: PAD_CX, y: PAD_Y, z: PAD_CZ },
  orientation: { x: 0, y: Math.sin(0.3), z: 0, w: Math.cos(0.3) },
  symmetry: 8,
  profile: [
    [0, 0],
    [20, 0],
  ],
  outer: 20,
  bottom: -20,
})
const FIELDS: readonly HeightField[] = [GROUND, PAD]

// ── the oracles: the loops as they were, nothing shared with the helper ─────

/** `autopilot.ts` `pathClearance`'s inner loop, and `instructor.ts` `clearanceAt`. */
const oldMinClearance = (fields: readonly HeightField[], x: number, y: number, z: number) => {
  let worst = Number.POSITIVE_INFINITY
  for (const field of fields) {
    if (outsideField(field, x, z)) continue
    const c = y - terrainHeightAt(field, x, z)
    if (c < worst) worst = c
  }
  return worst
}

/** `crash.ts`'s reset lift. */
const oldMaxGround = (fields: readonly HeightField[], x: number, z: number) => {
  let ground = Number.NEGATIVE_INFINITY
  for (const field of fields) {
    if (outsideField(field, x, z)) continue
    ground = Math.max(ground, terrainHeightAt(field, x, z))
  }
  return ground
}

/** `jumpseat-legs.ts` `groundUnder` and `jumpseat-autopilot.ts` `surfaceAt`. */
const oldGroundBelowField = (fields: readonly HeightField[], x: number, y: number, z: number) => {
  let best = Number.NEGATIVE_INFINITY
  for (const field of fields) {
    if (outsideField(field, x, z) || belowField(field, y)) continue
    const h = terrainHeightAt(field, x, z)
    if (h > best) best = h
  }
  return best
}

/** `jumpseat-head.ts` `pointDepth`. */
const oldPointDepth = (
  fields: readonly HeightField[],
  x: number,
  y: number,
  z: number,
  solidBelow: boolean,
) => {
  let deepest = Number.NEGATIVE_INFINITY
  for (const field of fields) {
    if (outsideField(field, x, z)) continue
    if (!solidBelow && belowField(field, y)) continue
    const depth = terrainHeightAt(field, x, z) - y
    if (depth > deepest) deepest = depth
  }
  return deepest
}

/** `terrain-collision.ts` `hullClearance`, before the helper. */
const oldHullClearance = (
  body: ReturnType<typeof createRigidBody>,
  fields: readonly HeightField[],
  hull: readonly HullSphere[],
) => {
  const local = v3()
  const world = v3()
  let lowest = Number.POSITIVE_INFINITY
  for (const sphere of hull) {
    local.x = sphere.x
    local.y = sphere.y
    local.z = sphere.z
    rotateVec3(world, body.orientation, local)
    const px = body.position.x + world.x
    const py = body.position.y + world.y
    const pz = body.position.z + world.z
    for (const field of fields) {
      if (outsideField(field, px, pz)) continue
      const gap = py - sphere.radius - terrainHeightAt(field, px, pz)
      if (gap < lowest) lowest = gap
    }
  }
  return lowest
}

// ── a seeded cloud of probe points ──────────────────────────────────────────

interface Probe {
  x: number
  y: number
  z: number
}

/** Over the pad (so the underside matters), over open ground, and off the plate entirely. */
const probes = (n: number, seed: number): Probe[] => {
  const rnd = mulberry32(seed)
  const out: Probe[] = []
  for (let i = 0; i < n; i++) {
    const nearPad = i % 3 !== 2
    out.push({
      x: nearPad ? PAD_CX + (rnd() - 0.5) * 60 : (rnd() - 0.1) * 4600 - 200,
      // Heights straddle the pad's surface and its underside, and the ground.
      y: rnd() * 700 - 50,
      z: nearPad ? PAD_CZ + (rnd() - 0.5) * 60 : (rnd() - 0.1) * 4600 - 200,
    })
  }
  return out
}

const same = (a: number, b: number): boolean => Object.is(a, b)

describe('highestGroundUnder equals the loops it replaced, to the bit', () => {
  const pts = probes(4000, 7)

  it('the fixture exercises the branches (pad hit, pad skipped, off the plate)', () => {
    let padHit = 0
    let underPad = 0
    let off = 0
    for (const p of pts) {
      if (outsideField(GROUND, p.x, p.z)) off++
      if (outsideField(PAD, p.x, p.z)) continue
      if (belowField(PAD, p.y)) underPad++
      else padHit++
    }
    expect(padHit).toBeGreaterThan(100)
    expect(underPad).toBeGreaterThan(100)
    expect(off).toBeGreaterThan(100)
  })

  it('PADS_SOLID is `y - h` min, and the crash reset max, to the bit', () => {
    for (const p of pts) {
      const ground = highestGroundUnder(FIELDS, p.x, p.z, PADS_SOLID)
      expect(same(ground, oldMaxGround(FIELDS, p.x, p.z))).toBe(true)
      expect(same(p.y - ground, oldMinClearance(FIELDS, p.x, p.y, p.z))).toBe(true)
    }
  })

  it('a point height is the `belowField` rule of the legs and the autopilot, to the bit', () => {
    for (const p of pts) {
      expect(
        same(highestGroundUnder(FIELDS, p.x, p.z, p.y), oldGroundBelowField(FIELDS, p.x, p.y, p.z)),
      ).toBe(true)
    }
  })

  it('and the two rules really differ here (the test is not vacuous)', () => {
    const differing = pts.filter(
      (p) =>
        !same(
          highestGroundUnder(FIELDS, p.x, p.z, p.y),
          highestGroundUnder(FIELDS, p.x, p.z, PADS_SOLID),
        ),
    )
    expect(differing.length).toBeGreaterThan(50)
  })

  it('no fields at all reads -Infinity', () => {
    expect(highestGroundUnder([], 0, 0, 0)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('the exported callers keep their answers', () => {
  const pts = probes(600, 11)

  it('pathClearance is the min of `y - h` over six samples, to the bit', () => {
    const rnd = mulberry32(3)
    for (const p of pts) {
      const body = {
        position: v3(p.x, p.y, p.z),
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        velocity: v3((rnd() - 0.5) * 80, (rnd() - 0.5) * 40, (rnd() - 0.5) * 80),
      }
      const look = 1 + rnd() * 4
      let expected = Number.POSITIVE_INFINITY
      for (let i = 1; i <= 6; i++) {
        const t = (i / 6) * look
        const c = oldMinClearance(
          FIELDS,
          body.position.x + body.velocity.x * t,
          body.position.y + body.velocity.y * t,
          body.position.z + body.velocity.z * t,
        )
        if (c < expected) expected = c
      }
      expect(same(pathClearance(body, FIELDS, look, 6), expected)).toBe(true)
    }
  })

  it('hullSphereWorld is the copy-rotate-add it replaced, to the bit', () => {
    const rnd = mulberry32(5)
    const local = v3()
    const world = v3()
    const out = v3()
    for (let i = 0; i < 2000; i++) {
      const q = { x: rnd() - 0.5, y: rnd() - 0.5, z: rnd() - 0.5, w: rnd() - 0.5 }
      const len = Math.hypot(q.x, q.y, q.z, q.w)
      const orientation: Quat = { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
      const sphere: HullSphere = {
        x: (rnd() - 0.5) * 8,
        y: (rnd() - 0.5) * 8,
        z: (rnd() - 0.5) * 8,
        radius: 1,
      }
      const bx = (rnd() - 0.5) * 8000
      const by = (rnd() - 0.5) * 800
      const bz = (rnd() - 0.5) * 8000
      local.x = sphere.x
      local.y = sphere.y
      local.z = sphere.z
      rotateVec3(world, orientation, local)
      hullSphereWorld(out, bx, by, bz, orientation, sphere)
      expect(same(out.x, bx + world.x)).toBe(true)
      expect(same(out.y, by + world.y)).toBe(true)
      expect(same(out.z, bz + world.z)).toBe(true)
    }
  })

  it('hullClearance over fields with no floating pad is the old loop, to the bit', () => {
    const rnd = mulberry32(9)
    const hull: HullSphere[] = [
      { x: 0, y: 0, z: 1.2, radius: 0.9 },
      { x: 0.8, y: -0.2, z: -0.6, radius: 0.7 },
      { x: -0.8, y: -0.2, z: -0.6, radius: 0.7 },
    ]
    const spec = { hull } as unknown as TerrainCollisionSpec
    for (let i = 0; i < 800; i++) {
      const q = { x: rnd() - 0.5, y: rnd() - 0.5, z: rnd() - 0.5, w: rnd() - 0.5 }
      const len = Math.hypot(q.x, q.y, q.z, q.w)
      const body = createRigidBody({
        position: v3(rnd() * 4300 - 100, rnd() * 600, rnd() * 4300 - 100),
        orientation: { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len },
      })
      expect(
        same(hullClearance(body, [GROUND], spec), oldHullClearance(body, [GROUND], hull)),
      ).toBe(true)
    }
  })

  it('headDepth, both readings of the pads, is the old per-point loop, to the bit', () => {
    const box = headBox({
      centre: { x: 0, y: 0.3, z: 0.2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfExtents: { x: 0.3, y: 0.4, z: 0.5 },
    })
    const rnd = mulberry32(13)
    for (const p of pts) {
      const q = { x: rnd() - 0.5, y: rnd() - 0.5, z: rnd() - 0.5, w: rnd() - 0.5 }
      const len = Math.hypot(q.x, q.y, q.z, q.w)
      const pose = {
        position: { x: p.x, y: p.y, z: p.z },
        orientation: { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len },
      }
      for (const solid of [true, false]) {
        let expected = Number.NEGATIVE_INFINITY
        const w = v3()
        for (const pt of box.points) {
          rotateVec3(w, pose.orientation, pt)
          const d = oldPointDepth(FIELDS, p.x + w.x, p.y + w.y, p.z + w.z, solid)
          if (d > expected) expected = d
        }
        expect(same(headDepth(pose, box, FIELDS, solid), expected)).toBe(true)
      }
    }
  })
})
