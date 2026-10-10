// tests/unit/spire-pivot.test.ts — is the rock where the prefab says the rock is?
//
// DEV-196. Matt, from the headset: *"some of the rock pillar props don't appear
// to be oriented correctly"* and *"in simonet islands, theres a floating rock
// pillar"*. Both are this file's one bug.
//
// ── The wrong belief ──────────────────────────────────────────────────────
//
// That a glTF node's own translation belongs in a landmark's drawn matrix.
// `buildLandmarkGroup` passed `source.matrix` — the mesh node's local transform
// inside the GLB — down to `landmarkMatrixOf`, and for `spire-b/c/d.glb` that
// matrix is a PURE TRANSLATION of (27.19, -35.19, 74.55), (23.20, -32.89,
// 41.26) and (34.94, -17.49, -40.25).
//
// Unity never applies it. A `MeshFilter` draws the **Mesh ASSET** at its
// GameObject's transform, and an imported mesh's vertices are NODE-LOCAL — the
// FBX node's own placement goes on the model prefab Unity generates, which
// `Spire_B_w_Collision.prefab` does not use. It is hand-built: a root carrying
// the MeshFilter, a MeshCollider and the authored transform, and two capsules.
//
// It is in the GLB because `tools/assets/convert-fbx.py`'s `orient_prop()` ends
// `transform_apply(location=False, rotation=True, scale=True)` — it bakes the
// axis conversion into the vertices and leaves the file's location on the
// object. Sweep all 43 props in the bucket and **the three spires are the only
// meshes whose node translation is non-zero**, which is why nothing else moved.
//
// Under the authored 2.9-9.3x scale that is 238-684 m of displacement on every
// one of the seventeen live landmarks: eleven of desert's sixteen ended up
// entirely underground, and Simonet's one — the only landmark on that island —
// ended up with its base 339 m above the sea it stands in.
//
// ── The witness, and why it is not a quaternion ───────────────────────────
//
// The turn-indicator pattern (CLAUDE.md): *when you add an asymmetric mesh,
// find something in its own prefab to measure it against.* A spire is a
// near-axisymmetric rod, so nothing about the mesh can settle where its origin
// is — but `Spire_B_w_Collision.prefab` surrounds it with **Unity-native
// geometry**: two built-in Capsule primitives (mesh fileID 10208, radius 0.5,
// height 2 along local +y), hand-placed and hand-scaled by the artist in
// Unity's own numbers, through no importer at all. All fourteen instances of
// that prefab — thirteen on desert, one on Simonet — carry the same two, byte
// for byte.
//
// They are ground truth for where the rock is, and they fit it the way a
// measurement does and a coincidence does not:
//
//     capsule union   z  6.14 .. 92.78      mesh  z 0 .. 92.372
//     capsule radius  17.08 at z 40.3       mesh  rmax 21.1, rmean 15.6 there
//     capsule radius   8.24 at z 76.3       mesh  rmean  8.45 there
//
// — the same rod, the same girth, the same taper. With the node translation in,
// the rock moves 86.8 units away from them: 74.5 of that ALONG the rod, whose
// own length is 92.4, and 44.5 of it perpendicular, on a rock whose radius never
// exceeds 21. Say which component, because the two are measured by different
// gates below and only one of them is the obvious one (DEV-027).
//
// So the assertions here are DISTANCES between two things that were authored
// independently, not a rotation written down twice (trap 24, the orientation
// lesson). They are true on any platform and false for the bug by more than a
// factor of ten: 0.36 r and 0.13 r against 4.8 r and 2.5 r.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { PropLandmark } from '@/content/load-environment'
import { drawnLandmarks, landmarkMatrixOf } from '@/game/props/load-props'
import { environmentTerrains, terrainLocalPosition } from '@/game/terrain/load-terrain'
import { environmentJson as read } from './helpers/content'
import { glbShapeOf, haveForest } from './helpers/prop-forest'

/**
 * `Spire_B_w_Collision.prefab`'s two Unity-native capsules, in the SPIRE ROOT's
 * own local frame — Unity space, Unity units, Unity's left hand.
 *
 * Written down rather than read, for the reason `landmark-collider.test.ts`
 * gives for the same prefab's radii: `$FF2_LEGACY` is on one machine and CI is
 * not it. The file and the fileIDs are here to re-derive them from —
 * `Assets/Quantum Theory/Polyworld/Ancient East/Meshes/Spires/Spire_B_w_Collision.prefab`,
 * Transforms `&454740` (`Capsule`, GameObject `&173508`) and `&463942`
 * (`Capsule 1`, GameObject `&151488`), each with a `CapsuleCollider` and a
 * MeshFilter on Unity's built-in capsule, `{fileID: 10208, guid: 0000…e000…}`.
 *
 * Both GameObjects are `m_IsActive: 0`, so 2016 collided on the MeshCollider
 * and not on these — which costs them nothing as a WITNESS. They are still two
 * objects a human placed onto this rock, in a frame no importer touched, and
 * where a human put them is the question being asked.
 */
const CAPSULES = [
  {
    name: 'Capsule',
    position: [-0.3, 0.9, 40.3],
    rotation: [0.102149546, -0.69464535, -0.7044865, 0.103596605],
    scale: 34.15942,
  },
  {
    name: 'Capsule 1',
    position: [-0.1, 5.6, 76.3],
    rotation: [0.1021495, -0.6946454, -0.7044864, 0.1035965],
    scale: 16.48427,
  },
] as const

/** Unity's built-in capsule: radius 0.5, height 2, along local +y. */
const CAPSULE_RADIUS = 0.5
const CAPSULE_HALF_LENGTH = 1

/** Rotate a vector by a quaternion. Unity and three agree on this algebra. */
const qRot = (q: readonly number[], v: readonly number[]): number[] => {
  const [x, y, z, w] = q as [number, number, number, number]
  const [vx, vy, vz] = v as [number, number, number]
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

/**
 * Points along one capsule's axis, in the spire root's local frame and then
 * flipped into the MESH-LOCAL frame the GLB's vertices are already in.
 *
 * `three = neg_z(unity)` for a mesh-local point — the claim `convert-fbx.py`'s
 * `orient_prop()` was calibrated to and `render/unity-space.ts` states for the
 * world. The GLB agrees out loud: its z runs -92.372..0 where the Unity mesh's
 * runs 0..92.372.
 */
const capsuleAxisSamples = (capsule: (typeof CAPSULES)[number], n: number): THREE.Vector3[] => {
  const dir = qRot(capsule.rotation, [0, 1, 0])
  const out: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 - 1 // -1 .. +1 along the capsule
    const s = t * CAPSULE_HALF_LENGTH * capsule.scale
    const ux = (capsule.position[0] as number) + (dir[0] as number) * s
    const uy = (capsule.position[1] as number) + (dir[1] as number) * s
    const uz = (capsule.position[2] as number) + (dir[2] as number) * s
    out.push(new THREE.Vector3(ux, uy, -uz))
  }
  return out
}

/** Every live landmark drawn from `spire-b.glb` — the prefab the capsules belong to. */
const spireBLandmarks = (): { env: string; landmark: PropLandmark }[] => {
  const out: { env: string; landmark: PropLandmark }[] = []
  for (const env of ['simonet', 'desert', 'kauai', 'alpine']) {
    for (const l of drawnLandmarks(read(env))) {
      if (l.meshAsset === 'assets/props/spire-b.glb') out.push({ env, landmark: l })
    }
  }
  return out
}

/**
 * Two relationships between the capsules and the rock, in METRES in the frame
 * the rock is drawn in, each divided by the big capsule's own radius there.
 *
 * ── Why not "is the capsule near the mesh" ────────────────────────────────
 *
 * Because it does not separate, and finding that out is the point. The node
 * translation is (27.19, −35.19, 74.55) against a rod 92.4 units long and 20
 * wide — so **three quarters of it is a slide ALONG the rod's own axis**, and a
 * 600 m rock slid 500 m down its own length still has vertices all round the
 * capsules. Nearest-vertex came out 1.02 for the truth and 0.88 for the bug:
 * the bug scored BETTER. That is the shape of a measurement taken along the one
 * direction the error does not show in.
 *
 * So take the two the error does show in, and take them against the capsules'
 * OWN axis rather than any axis this port chose:
 *
 *   ALONG   the capsule union and the mesh must END in the same places. The
 *           capsule pair was placed to cover the rod, so the two spans agree
 *           within a capsule radius — and a slide down the axis is exactly what
 *           this sees.
 *   ACROSS  the mesh's vertex CENTROID must sit within a capsule radius of the
 *           capsule union's axis LINE. A centroid is not a bound and not a box
 *           centre; the drawn matrix computes neither (trap 24).
 */
const capsuleFit = (
  landmark: PropLandmark,
  /**
   * The capsules' frame: the landmark's authored transform, ALWAYS. They are
   * children of the Unity spire root, so no matrix out of a GLB can move them —
   * which is the whole reason they can testify about one.
   */
  authored: THREE.Matrix4,
  /** The frame the MESH is drawn in, which is the thing under test. */
  drawn: THREE.Matrix4,
  verts: Float32Array,
): { along: number; across: number; alongMetres: number; acrossMetres: number; radius: number } => {
  const s = landmark.scale ?? [1, 1, 1]
  // A non-uniform scale turns the capsule's circular section into an ellipse;
  // its SMALLEST axis is the strictest reading of "within a radius".
  const radius =
    CAPSULE_RADIUS * CAPSULES[0].scale * Math.min(s[0] as number, s[1] as number, s[2] as number)

  // The union's two extreme endpoints, drawn. `capsuleAxisSamples(c, 1)` is the
  // two ends of one capsule and nothing between.
  const ends = CAPSULES.flatMap((c) => capsuleAxisSamples(c, 1)).map((p) =>
    p.applyMatrix4(authored),
  )
  let a = ends[0] as THREE.Vector3
  let b = ends[1] as THREE.Vector3
  let span = -1
  for (const p of ends)
    for (const q of ends) {
      const d = p.distanceTo(q)
      if (d > span) {
        span = d
        a = p
        b = q
      }
    }
  const axis = b.clone().sub(a).normalize()

  const v = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  let meshLo = Infinity
  let meshHi = -Infinity
  let n = 0
  for (let i = 0; i < verts.length; i += 3) {
    v.set(verts[i] as number, verts[i + 1] as number, verts[i + 2] as number).applyMatrix4(drawn)
    centroid.add(v)
    n++
    const t = v.clone().sub(a).dot(axis)
    meshLo = Math.min(meshLo, t)
    meshHi = Math.max(meshHi, t)
  }
  centroid.divideScalar(n)

  const alongMetres = Math.max(Math.abs(meshLo - 0), Math.abs(meshHi - span))
  const rel = centroid.clone().sub(a)
  const acrossMetres = rel
    .clone()
    .sub(axis.clone().multiplyScalar(rel.dot(axis)))
    .length()
  return {
    along: alongMetres / radius,
    across: acrossMetres / radius,
    alongMetres,
    acrossMetres,
    radius,
  }
}

/** The glTF node matrix the renderer USED to hand to `landmarkMatrixOf`. */
const shippedSourceMatrix = (asset: string): THREE.Matrix4 =>
  glbShapeOf(asset).node ?? new THREE.Matrix4()

describe.skipIf(!haveForest)('DEV-196: a spire is drawn on its own prefab’s capsules', () => {
  it('every Spire_B ends where its capsules end, and stands on their axis', () => {
    const rows: string[] = []
    let worstAlong = 0
    let worstAcross = 0
    for (const { env, landmark } of spireBLandmarks()) {
      const g = glbShapeOf(landmark.meshAsset as string)
      const drawn = landmarkMatrixOf(
        landmark,
        terrainLocalPosition(environmentTerrains(env).land),
        new THREE.Matrix4(),
      )
      const m = capsuleFit(landmark, drawn, drawn, g.verts())
      rows.push(
        `${env.padEnd(8)} ${(landmark.name ?? '?').padEnd(24)} ` +
          `along ${m.alongMetres.toFixed(0).padStart(4)} m = ${m.along.toFixed(2)} r   ` +
          `across ${m.acrossMetres.toFixed(0).padStart(4)} m = ${m.across.toFixed(2)} r   ` +
          `(r = ${m.radius.toFixed(0)} m)`,
      )
      worstAlong = Math.max(worstAlong, m.along)
      worstAcross = Math.max(worstAcross, m.across)
      expect(
        m.along,
        `${env} ${landmark.name}: the rock ends ${m.alongMetres.toFixed(0)} m from where its own capsules end, against a capsule radius of ${m.radius.toFixed(0)} m — it has slid down its own axis`,
      ).toBeLessThan(1)
      expect(
        m.across,
        `${env} ${landmark.name}: the rock's centroid is ${m.acrossMetres.toFixed(0)} m off the axis of the capsules placed on it, against a capsule radius of ${m.radius.toFixed(0)} m`,
      ).toBeLessThan(1)
    }
    console.log(`DEV-196 spire capsules:\n  ${rows.join('\n  ')}`)
    console.log(
      `DEV-196: worst along ${worstAlong.toFixed(2)} r, worst across ${worstAcross.toFixed(2)} r`,
    )
    // THE PREMISE: thirteen live `Spire_B_w_Collision` instances — twelve on
    // desert (a thirteenth is switched off) and Simonet's one. Without this the
    // loop above would pass over an empty set.
    expect(rows.length, 'no Spire_B landmarks: this file tested nothing').toBe(13)
  })

  it('would FAIL with the GLB node’s translation in — the state it shipped in', () => {
    // The other half of the claim, and the one that records the size of the
    // signal. `buildLandmarkGroup` post-multiplied this matrix into every
    // landmark for four sessions, and this is the composition it used.
    let leastAlong = Infinity
    let leastAcross = Infinity
    let worstMetres = 0
    for (const { env, landmark } of spireBLandmarks()) {
      const g = glbShapeOf(landmark.meshAsset as string)
      const authored = landmarkMatrixOf(
        landmark,
        terrainLocalPosition(environmentTerrains(env).land),
        new THREE.Matrix4(),
      )
      // The capsules stay in `authored`; only the MESH gets the GLB node's own
      // matrix, because only the mesh ever had it.
      const drawn = authored.clone().multiply(shippedSourceMatrix(landmark.meshAsset as string))
      const m = capsuleFit(landmark, authored, drawn, g.verts())
      leastAlong = Math.min(leastAlong, m.along)
      leastAcross = Math.min(leastAcross, m.across)
      worstMetres = Math.max(worstMetres, Math.max(m.alongMetres, m.acrossMetres))
    }
    console.log(
      `DEV-196: with the node translation in, along ${leastAlong.toFixed(1)} r and across ` +
        `${leastAcross.toFixed(1)} r at BEST, ${worstMetres.toFixed(0)} m at worst`,
    )
    // Not "greater than the gate" but comfortably past it, on every one of the
    // thirteen: the bug is not a near miss that a tolerance could have absorbed.
    expect(leastAlong).toBeGreaterThan(2)
    expect(leastAcross).toBeGreaterThan(1.5)
  })

  it('the premise: a landmark’s GLB node is a pure TRANSLATION, nothing else', () => {
    // Why dropping the whole node matrix is the same change as dropping its
    // translation, and the guard on that being true. `orient_prop()` bakes
    // rotation and scale into the vertices, so a landmark mesh whose node grew
    // one is a converter change and a new question — not something to apply
    // silently, in either direction.
    const seen: string[] = []
    for (const env of ['simonet', 'desert', 'kauai', 'alpine']) {
      for (const l of drawnLandmarks(read(env))) {
        const node = glbShapeOf(l.meshAsset as string).node
        seen.push(l.meshAsset as string)
        if (!node) continue
        const p = new THREE.Vector3()
        const q = new THREE.Quaternion()
        const s = new THREE.Vector3()
        node.decompose(p, q, s)
        expect(Math.abs(q.w), `${l.meshAsset} node rotation`).toBeCloseTo(1, 6)
        expect(s.x, `${l.meshAsset} node scale`).toBeCloseTo(1, 6)
        expect(s.y, `${l.meshAsset} node scale`).toBeCloseTo(1, 6)
        expect(s.z, `${l.meshAsset} node scale`).toBeCloseTo(1, 6)
      }
    }
    expect(seen.length, 'seventeen live landmarks, or this asserted nothing').toBe(17)
  })
})

describe.skipIf(haveForest)('DEV-196: the spire capsule measurement is skipped here', () => {
  it('says so, and says why, rather than reporting a pass', () => {
    // The loud counterpart. `public/assets/props/*.glb` is gitignored for
    // licensing (CLAUDE.md hard rule 7) and comes from R2, so CI has none of it.
    expect(haveForest).toBe(false)
    console.log(
      'DEV-196: `spire-pivot` skipped — the spire GLBs are gitignored and come from R2 ' +
        '(`pnpm assets:pull`). There is no synthetic half: the bug was a real node ' +
        'translation in a real file composed with a real authored transform.',
    )
  })
})
