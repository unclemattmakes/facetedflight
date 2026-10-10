// tests/unit/terrain-collision.test.ts — the ground stops you.
//
// Until this landed you could fly through Simonet.
//
// The height field is built from a SYNTHETIC map rather than the shipped PNG:
// the maps are gitignored assets (licence, not size — CLAUDE.md rule 7) and a
// unit test that needs `pnpm assets:pull` is a unit test that fails in CI. What
// the real map would add is coverage of the sampler, which
// `terrain-vertex-colour.test.ts` already has; what matters here is the contact
// maths, and a ramp tests that better than a coastline does.

import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { createRigidBody } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import {
  buildHeightField,
  outsideField,
  terrainHeightAt,
  terrainNormalAt,
} from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  collisionAngularDrag,
  createTerrainCollision,
  HOVERJET_GROUND,
  hullFromColliders,
  hullSpan,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'

/** A map whose grey level is a function of u — i.e. a ramp along world X. */
const rampMap = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = f(u, v)
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS = {
  terrainSize: 1024,
  terrainHeight: 100,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

const FLAT = buildHeightField(
  rampMap(() => 0.5),
  PARAMS,
  {
    position: [0, 0, 0],
    scale: [1, 1, 1],
  },
)

describe('the collision surface', () => {
  it('is the ORIGINAL grid, not the LOD being drawn', () => {
    // `heightmapResolution = terrainSize / baseResolution`, so the array is
    // quadPerSide + 1 on a side. Collision therefore does not change as chunks
    // swap LOD — which is half the reason it is a separate surface at all.
    expect(FLAT.vertPerSide).toBe(1024 / 8 + 1)
    expect(FLAT.step).toBe(8)
  })

  it('puts the heightmap on the axes the mesh does', () => {
    // `originalHeights[y, x]` with u on world X and v on world Z. The two
    // indices are named the other way round in the source from how they are
    // used, which is exactly how a transpose gets written — so a ramp along u
    // must come out as a ramp along X and be flat along Z.
    const ramp = buildHeightField(
      rampMap((u) => u),
      PARAMS,
      {
        position: [0, 0, 0],
        scale: [1, 1, 1],
      },
    )
    expect(terrainHeightAt(ramp, 0, 0)).toBeCloseTo(0, 4)
    expect(terrainHeightAt(ramp, 1024, 0)).toBeCloseTo(100, 4)
    expect(terrainHeightAt(ramp, 512, 0)).toBeCloseTo(50, 1)
    // Flat along Z.
    expect(terrainHeightAt(ramp, 512, 0)).toBeCloseTo(terrainHeightAt(ramp, 512, 900), 4)
  })

  it('applies the terrain transform, including a non-unit scale', () => {
    // The Simonet ocean plate is at (-14949, -46.08, -13692) with scale (8,1,8).
    // Reading mesh space as world space would put the sea 15 km away.
    const moved = buildHeightField(
      rampMap(() => 0.25),
      PARAMS,
      {
        position: [100, -50, 200],
        scale: [8, 1, 8],
      },
    )
    // 0.25 * 100 = 25, plus the origin's -50.
    expect(terrainHeightAt(moved, 100, 200)).toBeCloseTo(-25, 4)
    // Still inside at 8x the footprint, outside past it.
    expect(outsideField(moved, 100 + 1024 * 8 - 1, 200 + 10)).toBe(false)
    expect(outsideField(moved, 100 + 1024 * 8 + 1, 200 + 10)).toBe(true)
  })

  it('gives an up normal on the flat and a tilted one on a slope', () => {
    const out = { x: 0, y: 0, z: 0 }
    terrainNormalAt(FLAT, 500, 500, out)
    expect(out.y).toBeCloseTo(1, 6)
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(0, 6)

    const ramp = buildHeightField(
      rampMap((u) => u),
      PARAMS,
      {
        position: [0, 0, 0],
        scale: [1, 1, 1],
      },
    )
    terrainNormalAt(ramp, 500, 500, out)
    // Rising toward +X, so the normal leans toward -X. Still unit, still up.
    expect(out.x).toBeLessThan(0)
    expect(out.y).toBeGreaterThan(0)
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6)
  })
})

describe('the hull', () => {
  it("is the ship's five SOLID colliders, one sphere each", () => {
    const hull = hullFromColliders(
      HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
    )
    expect(hull).toHaveLength(5)
    for (const s of hull) expect(s.radius).toBeGreaterThan(0)
    // Two capsules keep their own radius; the biggest is just over a metre.
    expect(Math.max(...hull.map((s) => s.radius))).toBeCloseTo(1.020876, 5)
  })

  it('takes the INSCRIBED radius of a box, not the circumscribed one', () => {
    // A box becomes the sphere that fits inside it. The circumscribed sphere
    // would grow the ship at its corners and stop you short of ground you
    // should have cleared.
    const hull = hullFromColliders([
      {
        centerInShipRootSpace: { x: 0, y: 0, z: 0 },
        effective: { halfExtents: { x: 2, y: 0.25, z: 1 } },
        enabled: true,
        isTrigger: false,
      },
    ])
    expect(hull[0]?.radius).toBeCloseTo(0.25, 9)
  })

  it('drops disabled and trigger colliders', () => {
    const hull = hullFromColliders([
      {
        centerInShipRootSpace: { x: 0, y: 0, z: 0 },
        effective: { radius: 1 },
        enabled: false,
        isTrigger: false,
      },
      {
        centerInShipRootSpace: { x: 0, y: 0, z: 0 },
        effective: { radius: 1 },
        enabled: true,
        isTrigger: true,
      },
    ])
    expect(hull).toHaveLength(0)
  })
})

describe('the contact', () => {
  const SPEC: TerrainCollisionSpec = {
    hull: [{ x: 0, y: 0, z: 0, radius: 1 }],
    restitution: 0,
    friction: 0.6,
    flashSeconds: 0.3,
    flashAngularDrag: 3,
  }
  const GROUND = 50 // FLAT is 0.5 * 100

  const bodyAt = (y: number, vy: number, vx = 0) => {
    const b = createRigidBody({ mass: 4, drag: 1.2, angularDrag: 1.95, useGravity: false })
    b.position.y = y
    b.position.x = 500
    b.position.z = 500
    b.velocity.y = vy
    b.velocity.x = vx
    return b
  }

  it('does nothing at all in clear air', () => {
    const state = createTerrainCollision()
    const b = bodyAt(GROUND + 100, -50)
    expect(stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)).toBe(false)
    expect(b.position.y).toBe(GROUND + 100)
    expect(b.velocity.y).toBe(-50)
  })

  it('pushes the ship out and reports the strike ONCE', () => {
    const state = createTerrainCollision()
    const b = bodyAt(GROUND + 0.5, -40) // radius 1, so 0.5 m into the ground
    expect(stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)).toBe(true)
    expect(b.position.y).toBeCloseTo(GROUND + 1, 4)
    // Sustained contact is not a fresh impact every tick — otherwise a belly
    // slide fires a hundred collision sounds a second.
    expect(stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)).toBe(false)
  })

  it("does NOT bounce, because Unity's default material has bounciness 0", () => {
    // The shipped `m_DefaultMaterial` is `{fileID: 0}`. A hull that bounced
    // would turn every mistake into a pinball, and 2016 deliberately did not
    // have that.
    const state = createTerrainCollision()
    const b = bodyAt(GROUND + 0.5, -200)
    stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)
    expect(b.velocity.y).toBeCloseTo(0, 6)
    expect(b.velocity.y).not.toBeGreaterThan(0)
  })

  it('scrubs speed in proportion to how hard you hit — Coulomb, not damping', () => {
    // A graze should cost almost nothing and a head-on hit should cost
    // everything. A per-tick damping factor scrubs the same FRACTION off both,
    // which stops the ship dead on a hillside it should have skimmed.
    const graze = bodyAt(GROUND + 0.5, -1, 200)
    const slam = bodyAt(GROUND + 0.5, -200, 200)
    stepTerrainCollision(createTerrainCollision(), graze, [FLAT], SPEC, 0.0122)
    stepTerrainCollision(createTerrainCollision(), slam, [FLAT], SPEC, 0.0122)
    expect(graze.velocity.x).toBeGreaterThan(199)
    expect(slam.velocity.x).toBeLessThan(100)
  })

  it('triples angular drag for 0.3 s after a hit, then gives it back', () => {
    // `Ship_HoverShip.Flash()`. The handling penalty the physics alone would not
    // give you: a scrape costs you the ability to turn out of it.
    const state = createTerrainCollision()
    const b = bodyAt(GROUND + 0.5, -40)
    stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)
    expect(collisionAngularDrag(state, SPEC, 1.95)).toBeCloseTo(1.95 * 3, 6)
    // Fly clear and let it run out.
    b.position.y = GROUND + 100
    for (let i = 0; i < 30; i++) stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)
    expect(collisionAngularDrag(state, SPEC, 1.95)).toBeCloseTo(1.95, 6)
  })

  it('ignores terrain the ship is not over', () => {
    // Two terrains are live — the islands and the ocean plate — and a point
    // outside a field's footprint must not clamp to its edge height and shove
    // the ship at the far side of the map.
    const state = createTerrainCollision()
    const b = bodyAt(GROUND + 0.5, -40)
    b.position.x = -5000
    b.position.z = -5000
    expect(stepTerrainCollision(state, b, [FLAT], SPEC, 0.0122)).toBe(false)
    expect(b.position.y).toBe(GROUND + 0.5)
  })

  it('takes the DEEPEST contact when several hull spheres are under', () => {
    const multi: TerrainCollisionSpec = {
      ...SPEC,
      hull: [
        { x: 0, y: 0, z: 0, radius: 1 },
        { x: 0, y: -2, z: 0, radius: 1 },
      ],
    }
    const state = createTerrainCollision()
    const b = bodyAt(GROUND + 0.5, -40)
    stepTerrainCollision(state, b, [FLAT], multi, 0.0122)
    // The lower sphere is 2 m further down, so it is 2.5 m in and sets the push.
    expect(b.position.y).toBeCloseTo(GROUND + 3, 4)
  })
})

// ── A thin ridge at the speed jet's top speed (DEV-382 follow-up) ────────────
//
// DEV-381 §7: the hull's sphere centres span 1.86 m fore and aft, and the
// contact was probed only where the body ENDS a tick, so a tick longer than
// that left an unprobed gap — 5.0 m at the speed jet's chained 564 m/s — and
// a crest thinner than the gap could be flown through. The swept probe closes
// it. Every PHASE is tried, because whether a discrete test catches a sliver
// depends on where the ticks fall relative to it: the old test caught some and
// flew through the rest.

describe('the swept contact', () => {
  const HULL = HOVERJET_GROUND.collision
  /** A 3 m sliver of ridge across the path at z = 500, 40 m tall, on flat ground. */
  const CREST_Z = 500
  const HALF = 1.5
  const TOP = 40
  const SLIVER = {
    ...FLAT,
    analytic: {
      inside: () => true,
      heightAt: (_x: number, z: number) => (Math.abs(z - CREST_Z) <= HALF ? TOP : 0),
      normalStep: 0.25,
    },
  }
  /** The chained top of the speed jet on `int_01`, as DEV-381 computed it. */
  const SPEED = 564
  const FRONT = Math.max(...HULL.hull.map((s) => s.z))

  const flyAt = (phase: number): { crossedClear: boolean; touched: boolean } => {
    const body = createRigidBody({ mass: 4, drag: 0, angularDrag: 0, useGravity: false })
    // Level, nose along +z, the hull's lowest point 10 m below the crest top.
    let lowest = Number.POSITIVE_INFINITY
    for (const s of HULL.hull) lowest = Math.min(lowest, s.y - s.radius)
    body.position.y = TOP - 10 - lowest
    body.position.z = CREST_Z - 200 + phase
    body.velocity.z = SPEED
    const state = createTerrainCollision()
    let touched = false
    for (let t = 0; t < 80; t++) {
      // `integrate`'s last step, with nothing else acting.
      body.position.x += body.velocity.x * FIXED_DT
      body.position.y += body.velocity.y * FIXED_DT
      body.position.z += body.velocity.z * FIXED_DT
      stepTerrainCollision(state, body, [SLIVER], HULL, FIXED_DT)
      if (state.depth > 0) touched = true
      // Every sphere is past the crest and none ever touched it.
      if (!touched && body.position.z - FRONT > CREST_Z + HALF)
        return { crossedClear: true, touched }
    }
    return { crossedClear: false, touched }
  }

  it('the premise: at this speed a tick outruns the hull by more than the sliver', () => {
    expect(SPEED * FIXED_DT - hullSpan(HULL.hull)).toBeGreaterThan(2 * HALF)
  })

  it('stops a 564 m/s ship on a 3 m crest whatever phase its ticks fall in', () => {
    const through: number[] = []
    for (let phase = 0; phase < SPEED * FIXED_DT; phase += 0.25) {
      const run = flyAt(phase)
      if (run.crossedClear || !run.touched) through.push(phase)
    }
    expect(through, `phases that flew through the crest: ${through.join(', ')}`).toEqual([])
  })
})
