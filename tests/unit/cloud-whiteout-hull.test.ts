// tests/unit/cloud-whiteout-hull.test.ts — DEV-414, the whiteout is the hull
// you can see.
//
// Matt, 2026-09-25, on `adv_02_hoverJet`: *"i ended up w/ cloud fx drawing
// (fade to white) but didn't interpenetrate a cloud when it happened. i got
// lost, and couldn't finish the course"*. DEV-277 tested the eye against each
// blob's BOUNDING SPHERE, in a frame that ignored the cloud's rotation. A
// lobed blob's surface lies at 0.26-0.84 of that sphere's radius, so between
// lobes the screen went white far outside anything drawn.
//
// What is worth asserting, and against what:
//  1. Per SHAPE, at the blob's nearest vertex (a trough) and its farthest (a
//     lobe tip): just inside is inside, just outside is outside. The premise
//     is asserted too: the sphere would call "just outside the trough" inside,
//     so this sample SEPARATES the two rules (the agreement lesson).
//  2. On `adv_02`'s real sky, rotated and scaled: the same two points, taken
//     to world space by three's OWN `matrixWorld`, which is an independent
//     path from `insideCloud`'s hand-composed inverse. At least one cloud
//     must be one where the old rule disagrees, or this proves nothing.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { loadClouds } from '@/game/clouds'
import { CLOUD_SHAPES, generateCloud, insideCloudHull } from '@/sim/clouds'
import adv02 from '../../content/levels/adv_02_hoverJet.json'

/** Three's bounding-sphere centre (the box's centre), and the nearest and farthest vertex from it. */
const extremes = (p: ArrayLike<number>) => {
  const box = new THREE.Box3()
  const v = new THREE.Vector3()
  for (let i = 0; i < p.length; i += 3)
    box.expandByPoint(v.set(p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0))
  const centre = box.getCenter(new THREE.Vector3())
  let lo = new THREE.Vector3()
  let hi = new THREE.Vector3()
  let loR = Number.POSITIVE_INFINITY
  let hiR = 0
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0).sub(centre)
    const r = v.length()
    if (r < loR) {
      loR = r
      lo = v.clone()
    }
    if (r > hiR) {
      hiR = r
      hi = v.clone()
    }
  }
  return { centre, lo, hi }
}

describe('DEV-414 — the whiteout is the hull you can see', () => {
  for (const [name, shape] of Object.entries(CLOUD_SHAPES)) {
    it(`shape ${name}: in just under the surface, out just past it, at a trough and a lobe`, () => {
      const { positions } = generateCloud(shape, 0x1d0c)
      const { centre, lo, hi } = extremes(positions)
      const at = (d: THREE.Vector3, k: number): boolean =>
        insideCloudHull(positions, centre.x + d.x * k, centre.y + d.y * k, centre.z + d.z * k)
      expect(at(lo, 0), 'the centre').toBe(true)
      expect(at(lo, 0.9), 'just inside the trough').toBe(true)
      expect(at(lo, 1.1), 'just outside the trough').toBe(false)
      expect(at(hi, 0.95), 'just inside a lobe tip').toBe(true)
      expect(at(hi, 1.05), 'just outside a lobe tip').toBe(false)
      // The premise: the old rule, the bounding sphere, calls the trough's
      // "just outside" INSIDE. So these two points separate the rules.
      expect(lo.length() * 1.1).toBeLessThan(hi.length())
    })
  }

  // DEV-785: the clouds are instanced now, so "three's matrixWorld" is the
  // placement's instance matrix, read back out of its member's buffer. It is still
  // an independent path from `insideCloud`'s hand-composed inverse: three composes
  // it, the field inverts the three fields by hand. Both pools are held to it, the
  // unshared sky and the shared one.
  for (const [label, pool] of [
    ['one blob per cloud', undefined],
    ['the shared pool', { poolSize: 12, tintSpread: 0 }],
  ] as const) {
    it(`adv_02, ${label}: every cloud in its own rotated, scaled frame, by three's matrix`, () => {
      const placements = adv02.clouds as unknown as Parameters<typeof loadClouds>[0]
      const clouds = loadClouds(placements, pool ? { pool } : {})
      let separated = 0
      const matrix = new THREE.Matrix4()
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      for (let i = 0; i < placements.length; i++) {
        const draw = clouds.pool.find((d) => d.users.includes(i)) as (typeof clouds.pool)[number]
        const sphere = draw.mesh.geometry.boundingSphere as THREE.Sphere
        const { centre, lo, hi } = extremes(draw.mesh.geometry.getAttribute('position').array)
        clouds.matrixOf(i, matrix).decompose(position, quaternion, scale)
        const world = (d: THREE.Vector3, k: number): THREE.Vector3 =>
          new THREE.Vector3(
            centre.x + d.x * k,
            centre.y + d.y * k,
            centre.z + d.z * k,
          ).applyMatrix4(matrix)
        const name = `placement ${i}`
        expect(clouds.insideCloud(world(lo, 0.9)), `${name}: inside its trough`).toBe(true)
        expect(clouds.insideCloud(world(hi, 0.95)), `${name}: inside a lobe`).toBe(true)
        const outside = world(lo, 1.1)
        expect(clouds.insideCloud(outside), `${name}: past its trough`).toBe(false)
        // What DEV-277's rule said about the same point: no rotation, and the sphere.
        const dx = (outside.x - position.x) / scale.x - sphere.center.x
        const dy = (outside.y - position.y) / scale.y - sphere.center.y
        const dz = (outside.z - position.z) / scale.z - sphere.center.z
        if (dx * dx + dy * dy + dz * dz < sphere.radius * sphere.radius) separated++
      }
      // The sample has to be one where the old rule was wrong, or it tests nothing.
      expect(separated).toBeGreaterThan(0)
      clouds.dispose()
    })
  }
})
