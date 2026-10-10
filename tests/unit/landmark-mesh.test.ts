// tests/unit/landmark-mesh.test.ts — a landmark collides on its rock. DEV-345.
//
// The synthetic half: closed meshes whose inside, outside and distances are
// known by construction, so every assertion here compares `landmark-mesh.ts`
// against geometry and not against another device of the port's own. It runs
// everywhere, CI included — the real rocks are gitignored and their half lives
// in `jumpseat-pad-clearance.test.ts` (the pads) and `spire-line-attribution`
// (the lines), both against `helpers/prop-mesh.ts`'s ray-parity oracle.
//
// The shapes are chosen for the cases that break a winding count:
//
//   the L-prism   CONCAVE. Its convex hull covers the notch, so a point in the
//                 notch is the whole reason this module exists: the hull says
//                 inside, the rock says 3 m clear.
//   the fan       points exactly on the projection of an edge two cap triangles
//                 share — counted by both or by neither, a column of air turns
//                 solid or a column of rock turns hollow.
//   the hub       a point exactly under a vertex four cap triangles share.
//   the mirror    the same solid through the THREE → SIM z flip, which reverses
//                 every triangle: the builder has to discover the winding.

import { describe, expect, it } from 'vitest'
import {
  buildPropColliders,
  createPropCollision,
  type PropCollisionSpec,
  propPenetrationAt,
  stepPropCollision,
} from '@/sim/props/collision'
import {
  buildLandmarkMesh,
  insideLandmarkMesh,
  meshPenetration,
  meshSignedDistance,
} from '@/sim/props/landmark-mesh'
import { createRigidBody } from '@/sim/rigidbody'
import type { HullSphere } from '@/sim/terrain-collision'

type XZ = readonly [number, number]

/**
 * A closed prism: `polygon` (counter-clockwise in x/z) from y 0 to `height`,
 * outward winding. The caps are fanned from `hub` when given — an extra vertex
 * every cap triangle shares — and otherwise the top from `polygon[top]` and the
 * bottom from `polygon[bottom]`. Two different fans put a seam over one sheet
 * that is not a seam in the other, which is the case a double count cannot
 * cancel itself out of.
 */
const prism = (
  polygon: readonly XZ[],
  height: number,
  { top = 0, bottom = top, hub }: { top?: number; bottom?: number; hub?: XZ } = {},
): Float32Array => {
  const out: number[] = []
  const tri = (a: number[], b: number[], c: number[]): void => {
    out.push(...a, ...b, ...c)
  }
  const n = polygon.length
  const at = (i: number, y: number): number[] => {
    const p = polygon[((i % n) + n) % n] as XZ
    return [p[0], y, p[1]]
  }
  // In x/z, `(b - a) x (c - a)` has y = uz*vx - ux*vz, so a triangle CLOCKWISE
  // in (x, z) faces +y. The top cap is wound clockwise, the bottom counter.
  if (hub) {
    for (let i = 0; i < n; i++) {
      const top = [hub[0], height, hub[1]]
      const bot = [hub[0], 0, hub[1]]
      tri(top, at(i + 1, height), at(i, height))
      tri(bot, at(i, 0), at(i + 1, 0))
    }
  } else {
    for (let k = 1; k + 1 < n; k++) {
      tri(at(top, height), at(top + k + 1, height), at(top + k, height))
      tri(at(bottom, 0), at(bottom + k, 0), at(bottom + k + 1, 0))
    }
  }
  // Walls: edge i -> i+1 runs counter-clockwise, outward is (dz, -dx).
  for (let i = 0; i < n; i++) {
    tri(at(i, 0), at(i + 1, height), at(i + 1, 0))
    tri(at(i, 0), at(i, height), at(i + 1, height))
  }
  return new Float32Array(out)
}

/** The z mirror THREE -> SIM applies, which reverses every triangle's winding. */
const mirrorZ = (tris: Float32Array): Float32Array => {
  const out = Float32Array.from(tris)
  for (let i = 2; i < out.length; i += 3) out[i] = -(out[i] as number)
  return out
}

/** An L, the square [0,20]^2 with [8,20]^2 cut out. Reflex vertex (8, 8) is index 3. */
const L: readonly XZ[] = [
  [0, 0],
  [20, 0],
  [20, 8],
  [8, 8],
  [8, 20],
  [0, 20],
]
const inL = (x: number, z: number): boolean =>
  x > 0 && x < 20 && z > 0 && z < 20 && !(x > 8 && z > 8)

const SQUARE: readonly XZ[] = [
  [0, 0],
  [20, 0],
  [20, 20],
  [0, 20],
]

describe('the winding count answers inside exactly', () => {
  it('matches the L everywhere on a grid, notch included', () => {
    const m = buildLandmarkMesh(prism(L, 10, { top: 3, bottom: 0 }))
    let inside = 0
    let checked = 0
    // Half-integer offsets keep every sample off every face, so the answer is
    // the polygon's and not a tie.
    for (let x = -3.5; x <= 23.5; x += 1) {
      for (let z = -3.5; z <= 23.5; z += 1) {
        for (const y of [-2.5, 0.5, 5.5, 9.5, 12.5]) {
          const want = inL(x, z) && y > 0 && y < 10
          expect(insideLandmarkMesh(m, x, y, z), `(${x}, ${y}, ${z})`).toBe(want)
          if (want) inside++
          checked++
        }
      }
    }
    // Loud counterpart: a grid that never landed inside would pass vacuously.
    expect(inside).toBeGreaterThan(checked / 10)
  })

  it('counts a point on a SHARED cap edge once, not twice or never', () => {
    // The top is fanned from (8, 8): seams along (8,8)-(0,20) and (8,8)-(20,0).
    // The bottom from (0, 0): seams along (0,0)-(20,8) and (0,0)-(8,20). Both
    // share (0,0)-(8,8). Each point below sits exactly on one sheet's seam and
    // in the middle of the other sheet's triangle, so counting the seam twice
    // makes a point BELOW the solid read inside, and counting it never makes a
    // point IN the solid read outside — neither can cancel against the other
    // sheet, whose crossing is a single triangle.
    const m = buildLandmarkMesh(prism(L, 10, { top: 3, bottom: 0 }))
    const topSeams = [
      [4, 14],
      [14, 4],
      [11, 6],
    ] as const
    const bottomSeams = [
      [10, 4],
      [5, 2],
      [4, 10],
    ] as const
    for (const [x, z] of [...topSeams, ...bottomSeams, [4, 4] as const]) {
      for (const y of [0.5, 5, 9.5]) {
        expect(insideLandmarkMesh(m, x, y, z), `(${x}, ${y}, ${z}) on a seam`).toBe(true)
      }
      expect(insideLandmarkMesh(m, x, 12, z), `(${x}, 12, ${z}) above the seam`).toBe(false)
      expect(insideLandmarkMesh(m, x, -2, z), `(${x}, -2, ${z}) below the seam`).toBe(false)
    }
  })

  it('counts a point under a vertex four cap triangles share once', () => {
    const m = buildLandmarkMesh(prism(SQUARE, 10, { hub: [10, 10] }))
    expect(insideLandmarkMesh(m, 10, 5, 10)).toBe(true)
    expect(insideLandmarkMesh(m, 10, 10.5, 10)).toBe(false)
    expect(insideLandmarkMesh(m, 10, -0.5, 10)).toBe(false)
    // And on the hub's spokes, which are shared edges of the fan.
    expect(insideLandmarkMesh(m, 5, 5, 5)).toBe(true)
    expect(insideLandmarkMesh(m, 15, 5, 5)).toBe(true)
  })

  it('discovers the winding: the mirrored solid answers the mirrored question', () => {
    const tris = prism(L, 10, { top: 3, bottom: 0 })
    const a = buildLandmarkMesh(tris)
    const b = buildLandmarkMesh(mirrorZ(tris))
    for (let x = -1.5; x <= 21.5; x += 2) {
      for (let z = -1.5; z <= 21.5; z += 2) {
        expect(insideLandmarkMesh(b, x, 5, -z), `(${x}, 5, ${z})`).toBe(
          insideLandmarkMesh(a, x, 5, z),
        )
      }
    }
  })
})

describe('the depth is the distance to the rock, either side of it', () => {
  // A 20 x 10 x 20 box, the hub caps so the top is four triangles.
  const box = buildLandmarkMesh(prism(SQUARE, 10, { hub: [10, 10] }))

  it('outside and within reach: radius minus the gap', () => {
    expect(meshPenetration(box, 10, 10.4, 10, 1)).toBeCloseTo(0.6, 5)
    expect(meshPenetration(box, 20.25, 5, 10, 1)).toBeCloseTo(0.75, 5)
  })

  it('outside and out of reach: nothing', () => {
    expect(meshPenetration(box, 10, 11.5, 10, 1)).toBe(0)
    expect(meshPenetration(box, 40, 5, 10, 1)).toBe(0)
  })

  it('inside near a face: radius plus the depth', () => {
    expect(meshPenetration(box, 10, 9.5, 10, 1)).toBeCloseTo(1.5, 5)
  })

  it('deep inside, past any reach a sphere has: still the TRUE depth', () => {
    // 5 m from the top and the bottom, 10 from every wall. The tunnelled case:
    // a centre this deep in stone must be told how far it is from getting out.
    expect(meshPenetration(box, 10, 5, 10, 1)).toBeCloseTo(6, 5)
    expect(meshPenetration(box, 3, 5, 10, 1)).toBeCloseTo(4, 5)
  })

  it('the signed distance is unbounded and signed', () => {
    expect(meshSignedDistance(box, 10, 15, 10)).toBeCloseTo(5, 5)
    expect(meshSignedDistance(box, 50, 5, 10)).toBeCloseTo(30, 5)
    expect(meshSignedDistance(box, 10, 5, 10)).toBeCloseTo(-5, 5)
  })

  it('the notch of the L is clear by its own depth', () => {
    const m = buildLandmarkMesh(prism(L, 10, { top: 3, bottom: 0 }))
    // (11, 5, 11) is 3 m from both inner walls.
    expect(meshSignedDistance(m, 11, 5, 11)).toBeCloseTo(3, 5)
    expect(meshPenetration(m, 11, 5, 11, 1)).toBe(0)
    expect(meshPenetration(m, 8.5, 5, 11, 1)).toBeCloseTo(0.5, 5)
  })
})

describe('behind the hull, in the collider', () => {
  const SPEC: PropCollisionSpec = {
    breakSpeed: 40,
    breakSlowdown: 0.05,
    bounceRestitution: 0.2,
    radiusFraction: 0.3,
    cellMetres: 64,
    racerStuckSeconds: 0,
  }
  const SPHERE: readonly HullSphere[] = [{ x: 0, y: 0, z: 0, radius: 1 }]
  const LEVEL = { x: 0, y: 0, z: 0, w: 1 }
  // The L's convex hull: the square with the corner cut along x + z = 28.
  // `n·p <= d`, outward normals, in the PLACEMENT frame.
  const s = Math.SQRT1_2
  const HULL_PLANES = Float32Array.from([
    -1,
    0,
    0,
    0,
    1,
    0,
    0,
    20,
    0,
    0,
    -1,
    0,
    0,
    0,
    1,
    20,
    0,
    -1,
    0,
    0,
    0,
    1,
    0,
    10,
    s,
    0,
    s,
    28 * s,
  ])
  const ORIGIN = { x: 100, y: 0, z: 50 }
  const build = (withMesh: boolean) =>
    buildPropColliders(
      [
        {
          x: 10,
          y: 0,
          z: 10,
          scale: 1,
          dims: { height: 10, base: 0, width: 20 },
          kind: 'spire',
          hull: HULL_PLANES,
          mesh: withMesh ? prism(L, 10, { top: 3, bottom: 0 }) : null,
        },
      ],
      ORIGIN,
      SPEC,
    )
  const notch = { x: ORIGIN.x + 11, y: 5, z: ORIGIN.z + 11 }

  it('the hull ALONE buries the notch — the defect, stated', () => {
    expect(propPenetrationAt(notch, LEVEL, SPHERE, build(false))).toBeGreaterThan(0)
  })

  it('with the rock behind it, the notch is clear and the wall is not', () => {
    const props = build(true)
    expect(propPenetrationAt(notch, LEVEL, SPHERE, props)).toBe(0)
    const wall = { x: ORIGIN.x + 8.5, y: 5, z: ORIGIN.z + 11 }
    expect(propPenetrationAt(wall, LEVEL, SPHERE, props)).toBeCloseTo(0.5, 5)
  })

  it('the step and the query agree, contact for contact', () => {
    // One spelling of the shape test serves both; this is what holds it there.
    for (const p of [notch, { x: ORIGIN.x + 8.5, y: 5, z: ORIGIN.z + 11 }]) {
      const props = build(true)
      const body = createRigidBody({ mass: 4 })
      body.position.x = p.x
      body.position.y = p.y
      body.position.z = p.z
      const state = createPropCollision()
      const hits = stepPropCollision(state, body, SPHERE, props, SPEC)
      expect(hits > 0, `(${p.x}, ${p.z})`).toBe(
        propPenetrationAt(p, LEVEL, SPHERE, build(true)) > 0,
      )
    }
  })

  it('the triangles move with the terrain origin, as the planes do', () => {
    const props = build(true)
    // Without the shift this point would be read in the placement frame, 100 m
    // from the rock, and report nothing.
    expect(
      propPenetrationAt({ x: ORIGIN.x + 5, y: 5, z: ORIGIN.z + 5 }, LEVEL, SPHERE, props),
    ).toBeGreaterThan(5)
  })
})
