// tests/unit/prop-fracture-ground.test.ts — the pieces land. DEV-148.
//
// DEV-136 shipped the fracture and said so in its own §4: *"No pieces collide
// with the terrain; they fall through it and fade first."* From the cockpit
// that is a tree that bursts into shards which sink into the hill, which is
// worse than no fracture at all.
//
// Two claims, and they are deliberately about different things:
//
//  1. **Resting is a GEOMETRY claim, not a position claim.** The assertion is
//     that the piece's own bounding box, under its own rotation, sits ON the
//     surface and never through it — true whatever the piece's origin happens
//     to be, and false for the bug, which is the shape trap 24 asks for. The
//     origin is the PROP's base, so a test that checked `position.y >= ground`
//     would pass for a crown shard buried to its middle.
//  2. **The mesh->group z flip is checked against the RENDERER's own
//     composition.** `groundUnderGroupPoint` is the inverse of
//     `instanceMatrixOf`'s `(x, y, -z)`, and the test derives the expected
//     answer by going THROUGH `instanceMatrixOf` rather than by writing the
//     same slice twice (trap 24 again). Get it wrong and pieces land on the
//     hill mirrored across the map's diagonal, which on a symmetric island
//     would look almost right.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { groundUnderGroupPoint, instanceMatrixOf } from '@/game/props/load-props'
import { createPropFracture } from '@/render/prop-fracture'
import { buildVertexGrid, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { renderSurfaceHeightAt } from '@/sim/terrain/surface'

/** A cone, the same fixture `prop-fracture.test.ts` uses. */
const cone = (): THREE.BufferGeometry => THREE.ConeGeometry && new THREE.ConeGeometry(1, 3, 12)

/**
 * A RAMP, not a plate: the height rises with v, so a wrong z sign lands the
 * piece at a different height and the test can see it. A flat map would agree
 * with every convention at once, which is the agreement lesson.
 */
const rampMap = (): MapSampler => ({
  width: 64,
  height: 64,
  sample(_u: number, v: number, out: Rgb): Rgb {
    out.r = v
    out.g = v
    out.b = v
    return out
  },
})

const PARAMS: FacetedTerrainParams = {
  terrainSize: 512,
  terrainHeight: 100,
  chunkSize: 128,
  baseResolution: 8,
  randomOffset: 0.8,
  seed: 20160101,
} as FacetedTerrainParams

const GRID = buildVertexGrid(rampMap(), PARAMS)
const groundAt = groundUnderGroupPoint(GRID, rampMap(), PARAMS)

/** The lowest point of a mesh's own bounding box under its current transform. */
const lowestCornerOf = (mesh: THREE.Mesh): number => {
  mesh.geometry.computeBoundingBox()
  const bb = mesh.geometry.boundingBox as THREE.Box3
  let lowest = Number.POSITIVE_INFINITY
  const p = new THREE.Vector3()
  for (const x of [bb.min.x, bb.max.x]) {
    for (const y of [bb.min.y, bb.max.y]) {
      for (const z of [bb.min.z, bb.max.z]) {
        p.set(x, y, z).multiply(mesh.scale).applyQuaternion(mesh.quaternion).add(mesh.position)
        lowest = Math.min(lowest, p.y)
      }
    }
  }
  return lowest
}

describe('DEV-148: fracture pieces land on the ground they can see', () => {
  it('the mesh->group flip is the inverse of the one `instanceMatrixOf` draws with', () => {
    // Somewhere asymmetric, so a sign error cannot hide: off the diagonal, in
    // the far quarter of the map, where the ramp is steep in v and flat in u.
    const meshX = 137.5
    const meshZ = 402.25
    const expected = renderSurfaceHeightAt(GRID, rampMap(), PARAMS, meshX, meshZ)

    // Through the RENDERER's own composition: this is where the instance
    // actually ends up in the terrain group's frame.
    const drawn = new THREE.Vector3().setFromMatrixPosition(
      instanceMatrixOf(meshX, 0, meshZ, 0, 1, new THREE.Matrix4(), null, new THREE.Matrix4()),
    )
    // The relationship, not the value: whatever `instanceMatrixOf` did to z,
    // `groundUnderGroupPoint` undoes.
    expect(groundAt(drawn.x, drawn.z)).toBe(expected)
    // And the flip is REAL on this fixture — a test that passed with z
    // unflipped would be testing nothing.
    expect(drawn.z).not.toBe(meshZ)
    expect(groundAt(drawn.x, meshZ)).not.toBeCloseTo(expected, 1)
  })

  it('a piece comes to REST with its own box on the surface, never through it', () => {
    const fx = createPropFracture(4, groundAt)
    const meshX = 300
    const meshZ = 200
    const drawn = new THREE.Vector3().setFromMatrixPosition(
      instanceMatrixOf(meshX, 0, meshZ, 0, 1, new THREE.Matrix4(), null, new THREE.Matrix4()),
    )
    const floor = renderSurfaceHeightAt(GRID, rampMap(), PARAMS, meshX, meshZ)
    // Break a prop standing 40 m above that ground, so every piece has to fall.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(drawn.x, floor + 40, drawn.z),
      new THREE.Quaternion(),
      new THREE.Vector3(3, 3, 3),
    )
    fx.break(cone(), new THREE.MeshStandardMaterial(), matrix, new THREE.Vector3())

    const pieces = fx.group.children as THREE.Mesh[]
    expect(pieces.length).toBeGreaterThan(1)
    // Two seconds of 1/90 s frames: -32 m/s^2 covers 40 m in 1.6 s.
    for (let i = 0; i < 180; i++) fx.update(1 / 90)

    expect(fx.landed).toBe(pieces.length)
    for (const piece of pieces) {
      const lowest = lowestCornerOf(piece)
      const under = groundAt(piece.position.x, piece.position.z)
      // ON the surface: never below it, and not left hanging by more than the
      // box's own slack (the piece is 3 m tall at scale 3, so 9 m bounds it).
      expect(lowest).toBeGreaterThanOrEqual(under - 1e-3)
      expect(lowest).toBeLessThan(under + 9)
    }
    fx.dispose()
  })

  it('a landed piece stays put for the rest of its life and still fades out', () => {
    const fx = createPropFracture(4, groundAt)
    // The ramp at mesh z = 200 is 200/512 * 100 = 39 m; start 40 m over it.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(200, 79, -200),
      new THREE.Quaternion(),
      new THREE.Vector3(2, 2, 2),
    )
    fx.break(cone(), new THREE.MeshStandardMaterial(), matrix, new THREE.Vector3())
    const first = fx.group.children[0] as THREE.Mesh
    // 2 s under -32 is 64 m, comfortably past the 40 m it has to fall.
    for (let i = 0; i < 180; i++) fx.update(1 / 90)
    expect(fx.landed).toBe(fx.live)
    const resting = first.position.clone()
    const restingQuat = first.quaternion.clone()

    for (let i = 0; i < 90; i++) fx.update(1 / 90)
    expect(first.position.distanceTo(resting)).toBe(0)
    // Component-wise, not `angleTo`: `acos` of a dot product that IS 1 comes
    // back as 3e-7, which would make this assertion about float noise rather
    // than about the piece.
    expect(first.quaternion.toArray()).toEqual(restingQuat.toArray())
    // Still on the clock: it fades and goes, it does not become scenery.
    const m = first.material as THREE.Material & { opacity: number }
    expect(m.opacity).toBeLessThan(0.3)
    // Gone by 4 s and a couple of frames; the exact frame the sum of 1/90s
    // crosses `seconds` is float noise and not the claim.
    for (let i = 0; i < 95; i++) fx.update(1 / 90)
    expect(fx.live).toBe(0)
    fx.dispose()
  })

  it('with NO ground handed in, it is DEV-136 exactly: the pieces fall for ever', () => {
    // The loud counterpart. `createPropFracture(seconds)` with one argument is
    // every existing caller and every existing test, and it must not have
    // quietly acquired a floor.
    const fx = createPropFracture(4)
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(200, 10, -200),
      new THREE.Quaternion(),
      new THREE.Vector3(2, 2, 2),
    )
    fx.break(cone(), new THREE.MeshStandardMaterial(), matrix, new THREE.Vector3())
    const first = fx.group.children[0] as THREE.Mesh
    for (let i = 0; i < 180; i++) fx.update(1 / 90)
    expect(fx.landed).toBe(0)
    expect(first.position.y).toBeLessThan(-30)
    fx.dispose()
  })
})
