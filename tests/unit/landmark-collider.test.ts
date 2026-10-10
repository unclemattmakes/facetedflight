// tests/unit/landmark-collider.test.ts — is the spire's capsule ON the spire?
//
// DEV-187, the second half. `landmarks.test.ts` settled which way up a spire is
// and `prop-hash-reach.test.ts` settled whether the hash can reach it; this file
// asks the question in between, which nothing asked for four sessions: does the
// collider stand where the rock is drawn?
//
// It did not. `load-props.ts` put the capsule's axis at the composed instance
// matrix's TRANSLATION — where the glTF's own origin lands — and a spire's
// origin is not inside a spire. `spire-b.glb`'s vertices run z −92.37…0, so the
// pivot sits at one END of a 92 m rod, and the file's mesh node carries another
// (27.19, −35.19, 74.55) on top of that. Composed under the landmark's authored
// rotation and its 3–9× scale, that pivot lands **up to 254.6 m** from the rock.
//
// ── Why nobody saw it ─────────────────────────────────────────────────────
//
// The agreement lesson, exactly. Five of the seventeen live landmarks are
// rotated so the rod stands close to UP, and for those the pivot offset goes
// mostly into y — where the capsule spans it anyway. Their horizontal error was
// 5.7–43.0 m and reads as rounding on a 600 m rock. The twelve that LEAN put
// the same offset into the horizontal plane and are the ones with 109–255 m of
// it. A rule checked on a standing spire cannot tell the two stories apart.
//
// ── What is asserted, and why it is not the fix restated ──────────────────
//
// Trap 24: a test that re-derives its expectation the way the code does has
// tested nothing, and "the axis is the box centre" would be exactly that — the
// fix, spelled twice. So every assertion here is about a RELATIONSHIP between
// the capsule and the mesh's vertices that the builder does not compute: it
// takes an axis-aligned box, and a box's centre is neither a centroid nor a
// point known to be inside a convex hull. The relationships are
//
//   * the axis is closer to the vertex centroid than the capsule's own radius —
//     the collider contains the middle of the thing it stands for;
//   * the axis is INSIDE the mesh's horizontal footprint — from it, vertices
//     lie in every bearing, rather than all of them in one half-plane.
//
// Both are true on any platform, both are false for the bug — eleven of the
// seventeen live landmarks fail the first and six fail the second, and the two
// sets are not the same one, because the footprint of a leaning rod is a long
// thin shadow a pivot can land inside while sitting 165 m from the middle of
// it. Neither is a number this port chose.
//
// The share of each mesh that ends up inside its own capsule is PRINTED and not
// asserted, and it is worth reading: 31–68 %, which is about what it was. That
// is not a regression, it is the shape of the problem — the capsule also got
// SMALLER (desert's widest radius fell 207.9 → 164.3 m once it was measured on
// the vertices rather than on a box round a box), so it recovers about as much
// rock while claiming far less air. **A vertical capsule is a rough fit for a
// leaning 600 m mesa however you place it**, and §4 of the DEV-187 row says so
// rather than dressing a third of a rock up as a success.
//
// ── And 2016's own answer, for the radius ─────────────────────────────────
//
// `Spire_B_w_Collision.prefab` (the legacy project; `$FF2_LEGACY`) carries a
// live MeshCollider on the spire mesh plus two DEACTIVATED CapsuleColliders
// laid along the rod's own axis, at local z 40.3 and 76.3, radius 0.5 × 34.159
// and 0.5 × 16.484 — 17.08 and 8.24 units against a rod whose file cross-section
// is 35.0 × 37.5. So 2016 modelled a spire as a cone of collision radius
// **0.49 of the mesh width at the base narrowing to 0.24 at the tip**, and the
// preset's `radiusFraction` 0.3 sits inside that bracket. The number was never
// the problem; where it was measured from was.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { PropLandmark } from '@/content/load-environment'
import {
  drawnBoxOfVertices,
  drawnLandmarks,
  landmarkColliderInput,
  landmarkMatrixOf,
} from '@/game/props/load-props'
import { environmentTerrains, terrainLocalPosition } from '@/game/terrain/load-terrain'
import type { PropCollisionSpec } from '@/sim/props/collision'
import anniversary from '../../content/editions/anniversary.json'
import { environmentJson as read } from './helpers/content'
import { glbShapeOf, haveForest } from './helpers/prop-forest'

const RADIUS_FRACTION = (
  anniversary as unknown as { gameplay: { propCollision: PropCollisionSpec } }
).gameplay.propCollision.radiusFraction

/** The collider one landmark gets, and what its own vertices say about it. */
const measure = (
  landmark: PropLandmark,
  terrainLocal: readonly number[],
): {
  radius: number
  bottom: number
  top: number
  centroidOffset: number
  insideFraction: number
  meshHeight: number
  axisInFootprint: boolean
} => {
  const g = glbShapeOf(landmark.meshAsset as string)
  // DEV-196 took the node matrix out of this composition: the GLB node's
  // translation is the FBX node's placement and Unity never applies it. Most of
  // the 254.6 m this file was written about was that, not a pivot convention —
  // the axis fix below is still right, and is now worth metres, not hundreds.
  const out = landmarkMatrixOf(landmark, terrainLocal, new THREE.Matrix4())
  const verts = g.verts()
  const input = landmarkColliderInput(
    landmark,
    drawnBoxOfVertices(new THREE.BufferAttribute(verts, 3), out),
    out,
  )
  // `buildPropColliders`'s arithmetic, at a zero origin: the capsule this
  // landmark contributes, in the matrix's own frame (three space, so the
  // builder's Unity z comes back negated).
  const radius = input.dims.width * input.scale * RADIUS_FRACTION
  const bottom = input.y + input.dims.base * input.scale
  const top = input.y + input.dims.height * input.scale
  const axisX = input.x
  const axisZ = -input.z

  // Is the axis INSIDE the mesh's horizontal footprint? A point is outside the
  // convex hull of a cloud exactly when some half-plane through it holds the
  // whole cloud — so sweep bearings and ask whether every one of them has a
  // vertex on its side. 64 is resolution, not tuning: a point outside the hull
  // by any margin that matters here fails a whole arc of them, and one that is
  // inside passes all of them however many you take.
  const BEARINGS = 64
  const seen = new Array<boolean>(BEARINGS).fill(false)

  const c = new THREE.Vector3()
  let sx = 0
  let sz = 0
  let inside = 0
  let n = 0
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < verts.length; i += 3) {
    c.set(verts[i] as number, verts[i + 1] as number, verts[i + 2] as number).applyMatrix4(out)
    sx += c.x
    sz += c.z
    minY = Math.min(minY, c.y)
    maxY = Math.max(maxY, c.y)
    const dx = c.x - axisX
    const dz = c.z - axisZ
    if (c.y >= bottom && c.y <= top && Math.hypot(dx, dz) <= radius) inside++
    for (let b = 0; b < BEARINGS; b++) {
      if (seen[b]) continue
      const th = (b / BEARINGS) * Math.PI * 2
      if (dx * Math.cos(th) + dz * Math.sin(th) > 0) seen[b] = true
    }
    n++
  }
  return {
    radius,
    bottom,
    top,
    centroidOffset: Math.hypot(sx / n - axisX, sz / n - axisZ),
    insideFraction: inside / n,
    meshHeight: maxY - minY,
    axisInFootprint: seen.every(Boolean),
  }
}

describe.skipIf(!haveForest)('DEV-187: a landmark’s capsule stands where its mesh is drawn', () => {
  it('every live landmark: the axis is inside its own radius of the mesh centroid', () => {
    const rows: string[] = []
    let worstOffset = 0
    let leastInside = 1
    for (const env of ['simonet', 'desert', 'kauai', 'alpine']) {
      const local = terrainLocalPosition(environmentTerrains(env).land)
      for (const l of drawnLandmarks(read(env))) {
        const m = measure(l, local)
        rows.push(
          `${env.padEnd(8)} ${(l.name ?? '?').padEnd(24)} r ${m.radius.toFixed(1).padStart(6)} m  ` +
            `axis→centroid ${m.centroidOffset.toFixed(1).padStart(6)} m  ` +
            `verts inside ${(m.insideFraction * 100).toFixed(0).padStart(3)} %  ` +
            `axis in footprint ${m.axisInFootprint ? 'yes' : 'NO '}  ` +
            `mesh ${m.meshHeight.toFixed(0)} m tall`,
        )
        worstOffset = Math.max(worstOffset, m.centroidOffset / m.radius)
        leastInside = Math.min(leastInside, m.insideFraction)

        // GATE 1, a relationship rather than a value: the capsule contains the
        // middle of the rock it represents. Under the shipped bug eleven of the
        // seventeen failed it — up to 254.6 m of offset against a 190.9 m
        // radius, a ratio of 1.52 at worst. It is 0.27 at worst now.
        expect(
          m.centroidOffset,
          `${env} ${l.name}: the capsule's axis is ${m.centroidOffset.toFixed(0)} m from the mesh it is supposed to be inside, against a radius of ${m.radius.toFixed(0)} m`,
        ).toBeLessThan(m.radius)

        // GATE 2, and it does not consult the radius at all: the axis is inside
        // the rock's own horizontal footprint. A capsule whose axis is outside
        // the thing has a hollow middle whatever its radius, and this is the
        // half of the claim a bigger radius could otherwise paper over. Six of
        // the seventeen failed it — and they are not the same six that failed
        // gate 1, which is why both are here.
        expect(
          m.axisInFootprint,
          `${env} ${l.name}: every vertex of the mesh is on one side of the capsule's axis — the axis is outside the rock`,
        ).toBe(true)
      }
    }
    console.log(`DEV-187 landmark capsules:\n  ${rows.join('\n  ')}`)
    console.log(
      `DEV-187: worst axis→centroid / radius ${worstOffset.toFixed(2)}; ` +
        `share of a mesh inside its own capsule ${(leastInside * 100).toFixed(0)} % at worst ` +
        '(printed, not gated — it is a direction, not a threshold)',
    )
    // THE PREMISE: seventeen live landmarks, or this file is asserting over an
    // empty set and would pass on content that has none.
    expect(rows.length, 'no live landmarks: this file tested nothing').toBe(17)
  })

  it('2016’s own spire colliders bracket the preset’s radiusFraction', () => {
    // `Spire_B_w_Collision.prefab`, read in the row above: two capsules along
    // the rod, radius 0.5 × 34.159 and 0.5 × 16.484 units, against a file
    // cross-section of 35.0 × 37.5. This is the one number in prop collision
    // with a 2016 answer, and it is here so that moving `radiusFraction` has to
    // argue with it. It is NOT read from the Unity project — that path is only
    // on Matt's machine — it is the measurement, written down, with the file
    // and the fileIDs to re-derive it from.
    const base = 0.5 * 34.15942
    const tip = 0.5 * 16.48427
    const meshWidth = 35.0
    expect(base / meshWidth).toBeCloseTo(0.488, 3)
    expect(tip / meshWidth).toBeCloseTo(0.235, 3)
    expect(RADIUS_FRACTION).toBeGreaterThan(tip / meshWidth)
    expect(RADIUS_FRACTION).toBeLessThan(base / meshWidth)
  })
})

describe.skipIf(haveForest)('DEV-187: the landmark capsule measurement is skipped here', () => {
  it('says so, and says why, rather than reporting a pass', () => {
    expect(haveForest).toBe(false)
    console.log(
      'DEV-187: `landmark-collider` skipped — the spire GLBs are gitignored and come ' +
        'from R2 (`pnpm assets:pull`). Nothing in this file has a synthetic half: the ' +
        'bug was in the composition of real authored transforms with a real pivot.',
    )
  })
})
