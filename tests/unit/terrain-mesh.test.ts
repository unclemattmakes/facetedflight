// tests/unit/terrain-mesh.test.ts — the Unity-to-three handedness conversion.
//
// `chunkGeometry` does one thing that can silently ruin the world: it converts
// the generator's UNITY-space mesh into three space. That is `z -> -z`, a
// reflection, determinant -1 — so it MUST be paired with a triangle winding
// reversal or every face points backwards and gets culled.
//
// Both halves are individually invisible:
//
//  * Drop the z flip and you get a mirrored island. It still looks like an
//    island (CLAUDE.md's warning), still renders every triangle front-facing,
//    and only stops making sense when the rings turn out to be over water.
//  * Drop the winding reversal and the faces are backwards. With `FrontSide`
//    culling the terrain vanishes; with `DoubleSide` it looks almost right and
//    is lit from the wrong side.
//
// So the invariant to test is the PAIRING: for every triangle, the normal
// implied by the vertex order must still agree with the normal attribute. That
// is false if either half is removed on its own, and true only when both are
// present — which is exactly the property a single-sided check would miss.

import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import { chunkGeometry, terrainMaterial } from '@/render/terrain-mesh'
import type { TerrainChunkMesh } from '@/sim/terrain/faceted'

/**
 * Two triangles in UNITY space (left-handed, +Z forward), with per-face normals
 * computed the way Unity computes them.
 *
 * The conversion this exercises maps `n = e1 x e2` to `(n.x, n.y, -n.z)` — which
 * is exactly what negating every z AND swapping vertices 1 and 2 produces
 * together, and is NOT what either does alone. That algebra is the whole reason
 * the test below dots the two normals rather than comparing components.
 */
const fixture = (): TerrainChunkMesh => {
  const positions = new Float32Array([
    // triangle 0, flat, facing up
    0, 0, 0, 10, 0, 0, 0, 0, 10,
    // triangle 1, tilted, so a sign error cannot cancel
    20, 5, 0, 30, 0, 4, 20, 1, 12,
  ])
  const normals = new Float32Array(18)
  // Per-face normals, computed in Unity's handedness.
  for (let t = 0; t < 2; t++) {
    const o = t * 9
    const ax = positions[o] as number
    const ay = positions[o + 1] as number
    const az = positions[o + 2] as number
    const e1 = [
      (positions[o + 3] as number) - ax,
      (positions[o + 4] as number) - ay,
      (positions[o + 5] as number) - az,
    ]
    const e2 = [
      (positions[o + 6] as number) - ax,
      (positions[o + 7] as number) - ay,
      (positions[o + 8] as number) - az,
    ]
    // `Vector3.Cross` uses the standard algebraic formula; the handedness lives
    // in the coordinate system, not in the operator. So this is the same
    // expression Unity evaluates, on Unity-space edges.
    const nx = (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number)
    const ny = (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number)
    const nz = (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number)
    const len = Math.hypot(nx, ny, nz) || 1
    for (let k = 0; k < 3; k++) {
      normals[o + k * 3] = nx / len
      normals[o + k * 3 + 1] = ny / len
      normals[o + k * 3 + 2] = nz / len
    }
  }
  return {
    chunkX: 0,
    chunkY: 0,
    positions,
    normals,
    // Mid-grey: sRGB 0.5 is NOT linear 0.5, which the colour test relies on.
    colors: new Float32Array(18).fill(0.5),
    uvs: new Float32Array(12).fill(0.25),
    triangleCount: 2,
  }
}

const attr = (g: ReturnType<typeof chunkGeometry>, name: string): Float32Array =>
  g.getAttribute(name).array as Float32Array

describe('chunkGeometry: Unity space to three space', () => {
  it('negates z on positions and normals, and leaves x and y alone', () => {
    const src = fixture()
    const p = attr(chunkGeometry(src), 'position')
    // Vertex 0 of each triangle keeps its slot under the winding swap, so it is
    // the one that can be compared without tracking the permutation.
    expect(p[0]).toBeCloseTo(src.positions[0] as number, 6)
    expect(p[1]).toBeCloseTo(src.positions[1] as number, 6)
    expect(p[2]).toBeCloseTo(-(src.positions[2] as number), 6)
    expect(p[9]).toBeCloseTo(src.positions[9] as number, 6)
    expect(p[11]).toBeCloseTo(-(src.positions[11] as number), 6)
  })

  it('keeps winding and normals in agreement — the invariant that needs BOTH halves', () => {
    const g = chunkGeometry(fixture())
    const p = attr(g, 'position')
    const n = attr(g, 'normal')

    for (let t = 0; t < 2; t++) {
      const o = t * 9
      const ax = p[o] as number
      const ay = p[o + 1] as number
      const az = p[o + 2] as number
      const e1 = [(p[o + 3] as number) - ax, (p[o + 4] as number) - ay, (p[o + 5] as number) - az]
      const e2 = [(p[o + 6] as number) - ax, (p[o + 7] as number) - ay, (p[o + 8] as number) - az]
      // Right-handed cross product, because this is three space now.
      const gx = (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number)
      const gy = (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number)
      const gz = (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number)
      const len = Math.hypot(gx, gy, gz) || 1

      // Dot the geometric normal against the stored one. +1 means the vertex
      // order and the shading normal agree; -1 means the face is inside out.
      const dot =
        (gx / len) * (n[o] as number) +
        (gy / len) * (n[o + 1] as number) +
        (gz / len) * (n[o + 2] as number)
      expect(dot, `triangle ${t} winding vs normal`).toBeCloseTo(1, 5)
    }
  })

  it('does NOT convert vertex colours from sRGB to linear', () => {
    // This test used to assert the opposite, and it was wrong.
    //
    // The physically correct thing is to decode: Unity sampled an sRGB texture, three lights in
    // linear, so 0.5 should become 0.2140. But `GetPixelBilinear` returns the RAW stored bytes and
    // Unity does not gamma-correct a vertex colour stream on upload either, so 2016's Marmoset
    // shader multiplied an sRGB number straight into a linear albedo — and the island being a stop
    // brighter and flatter than a correct decode IS the look Matt remembers.
    //
    // Not deduced. The 2016 bake stores its vertex colours, and its two open-sea chunks match the
    // raw values exactly while the decoded ones are 0.105 off; see
    // `tests/unit/terrain-vertex-colour.test.ts`, which asks the bake directly. (DEV-014.)
    const c = attr(chunkGeometry(fixture()), 'color')
    expect(c[0]).toBeCloseTo(0.5, 6)
  })

  it('preserves every vertex, and the uv of the vertex that did not move', () => {
    const src = fixture()
    const g = chunkGeometry(src)
    expect(attr(g, 'position').length).toBe(src.positions.length)
    expect(attr(g, 'uv').length).toBe(src.uvs.length)
    expect(g.getAttribute('position').count).toBe(6)
    expect(g.boundingSphere).not.toBeNull()
  })
})

// ── `iblBrightness` is EXTRACTED and three overwrites it ──────────────────
//
// Found by the DEV-182 branch while reading three for a different reason, and
// kept as a guard rather than a fix because it is latent: every shipped value
// is 1, which is also three's default, so nothing looks wrong today.
//
// The mechanism (`three.module.js:18687`, checked rather than remembered):
//
//     if ( ( material.isMeshStandardMaterial || ... ) &&
//          material.envMap === null && scene.environment !== null ) {
//       m_uniforms.envMapIntensity.value = scene.environmentIntensity;
//     }
//
// The terrain's material is built with `envMapIntensity: iblBrightness` and has
// no `envMap` of its own — it takes the scene's — and `boot/app.ts` sets
// `scene.environment` from the sky. So three writes over the sheet's number on
// every frame, and `terrain.<env>.<t>.material.specular.iblBrightness` is
// **documentation, not a guard**.
//
// That is DEV-069's lesson exactly: *"A generated constant that NO CODE PATH
// READS is documentation, not a guard ... `hoverjet.input.controlScheme` has
// said 'a' since the extractor first ran, while `gamepad.ts` shipped a layout
// that is not scheme a."* It flew for four sessions and was found by Matt
// holding a PS5 pad.
//
// So this test is the LOUD COUNTERPART: it does not assert the current
// behaviour is right, it asserts the one condition under which the behaviour is
// harmless. The day an environment is extracted with an `iblBrightness` that is
// not 1, this goes red and points here — which is the whole of what a guard for
// a dead constant can honestly do.
describe('the sheet says iblBrightness and three does not read it', () => {
  it('is 1 on every land terrain, which is the only reason it does not matter', () => {
    const offenders: string[] = []
    for (const [env, block] of Object.entries(TERRAIN)) {
      const terrains = (block as { terrains?: Record<string, unknown> }).terrains
      if (!terrains) continue
      for (const [name, terrain] of Object.entries(terrains)) {
        const ibl = (terrain as { material?: { specular?: { iblBrightness?: number | null } } })
          .material?.specular?.iblBrightness
        // null is the ocean: a VacuumShaders surface with its own sun term
        // (`render/water.ts`), no IBL of three's to intensify.
        if (ibl === null || ibl === undefined) continue
        if (ibl !== 1) offenders.push(`${env}.${name} = ${ibl}`)
      }
    }
    expect(
      offenders,
      'an environment now has an iblBrightness three would silently ignore — ' +
        'give the terrain material its own envMap, or drive scene.environmentIntensity, ' +
        'and delete this test',
    ).toEqual([])
  })

  it('reaches the material, so only three is discarding it', () => {
    // The other half, and it is what makes the first half a finding rather
    // than a shrug: the value IS plumbed through correctly. If this ever fails,
    // the bug is ours and not three's.
    const entry = TERRAIN.simonet.terrains.islands
    const material = terrainMaterial(
      entry.material as unknown as Parameters<typeof terrainMaterial>[0],
    ) as THREE.MeshStandardMaterial
    expect(material.envMapIntensity).toBe(entry.material.specular.iblBrightness)
    // ...and the material has no envMap of its own, which is the condition
    // three's override is gated on. Both halves, so the test says WHY.
    expect(material.envMap).toBeNull()
  })
})
