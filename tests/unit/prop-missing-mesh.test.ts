// tests/unit/prop-missing-mesh.test.ts: DEV-898, one missing mesh costs one mesh.
//
// A clone of the public repository has none of the bought Asset Store meshes (they ship from the
// content bucket, never from git), and the live game meets the same condition when the CDN drops
// one file. `loadProps` used to throw on the first failed `loadMesh`, and `world/build.ts` caught
// that around the whole layer, so ONE absent palm took the entire prop layer with it. This loads
// the real desert environment (palette, baked placements, landmarks) with `loadMesh` replaced by
// a stand-in that fails for named assets, and asserts the rest is built and that nothing
// invisible is solid.
//
// Nothing here renders: an `InstancedMesh` is plain data until a renderer draws it.

import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMissingAssetWarnings } from '@/game/missing-asset'
import { type LoadPropsOptions, loadProps } from '@/game/props/load-props'
import { MeshLoadError } from '@/render/load-mesh'

/** Assets the stand-in refuses, set per test. */
const missing = new Set<string>()
/** Every URL asked for, in order. */
const asked: string[] = []

vi.mock('@/render/load-mesh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/render/load-mesh')>()
  return {
    ...actual,
    loadMesh: async (url: string) => {
      asked.push(url)
      if (missing.has('*') || [...missing].some((m) => url.endsWith(m))) {
        throw new actual.MeshLoadError(url, '404 (test stand-in)')
      }
      // A tiny mesh with no colour attribute: the loader's fallback material path.
      const object = new THREE.Group()
      object.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)))
      return { object, meshCount: 1, vertexCount: 24, dispose: () => {} }
    },
  }
})

/** A flat height map: the placements' y does not matter to anything asserted here. */
const FLAT = {
  width: 4,
  height: 4,
  sample(_u: number, _v: number, out: { r: number; g: number; b: number }): void {
    out.r = out.g = out.b = 0.25
  },
}

const OPTIONS: LoadPropsOptions = {
  terrain: { terrainSize: 4096, terrainHeight: 100, chunkSize: 256 },
  heightMap: FLAT,
  // Anniversary draws every baked pass; the landmarks need the terrain's own position.
  unbakedPasses: true,
  landmarks: { terrainLocalPosition: [0, 0, 0] },
}

const load = async () => {
  const props = await loadProps('desert', OPTIONS)
  if (!props) throw new Error('desert has prop data')
  return props
}

const meshNames = (p: {
  scatterMeshes: readonly THREE.Object3D[]
  landmarkMeshes: readonly THREE.Object3D[]
}) => ({
  scatter: new Set(p.scatterMeshes.map((m) => m.name)),
  landmarks: new Set(p.landmarkMeshes.map((m) => m.name)),
})

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubEnv('VITE_ASSET_BASE_URL', '/')
  missing.clear()
  asked.length = 0
  resetMissingAssetWarnings()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  vi.unstubAllEnvs()
})

/** console.warn calls that name `asset`. */
const warningsAbout = (asset: string): number =>
  warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(asset)).length

describe('DEV-898: a missing scatter mesh is skipped, not the whole layer', () => {
  it('builds the whole forest when every mesh loads (the baseline the rest compare to)', async () => {
    const all = await load()
    expect(all.instanceCount).toBeGreaterThan(1000)
    expect(all.colliderInputs.length).toBeGreaterThan(1000)
    const { scatter, landmarks } = meshNames(all)
    expect(scatter).toContain('props:cactus-tall-01.glb')
    expect(scatter).toContain('props:bush-grassland-02.glb')
    expect(landmarks.size).toBeGreaterThan(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops only the missing palette entry, with its placements and its colliders', async () => {
    const all = await load()
    missing.add('assets/props/cactus-tall-01.glb')
    const some = await load()

    const { scatter } = meshNames(some)
    expect(scatter).not.toContain('props:cactus-tall-01.glb')
    // Everything else in the palette is still drawn.
    for (const kept of [
      'props:bush-grassland-02.glb',
      'props:bush-large-02.glb',
      'props:cactus-tall-02.glb',
      'props:cactus-tall-03.glb',
      'props:cactus-short-02.glb',
    ]) {
      expect(scatter, `${kept} survives`).toContain(kept)
    }

    // The placements of the missing entry are gone from the count AND from the colliders, by the
    // same number: nothing invisible is solid, and the ids stay compact.
    const lost = all.instanceCount - some.instanceCount
    expect(lost).toBeGreaterThan(0)
    expect(all.colliderInputs.length - some.colliderInputs.length).toBe(lost)
    expect(some.instanceCount).toBeGreaterThan(all.instanceCount / 2)
    // The landmarks are a different mesh and are untouched.
    expect(some.landmarkCount).toBe(all.landmarkCount)
  })

  it('warns once for the asset, however many times it is asked for or loaded', async () => {
    missing.add('assets/props/bush-grassland-02.glb') // 7 of desert's 13 palette slots
    await load()
    await load()
    expect(warningsAbout('bush-grassland-02.glb')).toBe(1)
    // And the failed mesh is not re-fetched for each of its seven slots within a pass.
    const askedForIt = asked.filter((u) => u.endsWith('bush-grassland-02.glb')).length
    expect(askedForIt, 'one fetch per pass, not one per palette slot').toBeLessThanOrEqual(2)
  })

  it('survives every scatter mesh missing: an empty forest, not a throw', async () => {
    missing.add('*')
    const none = await load()
    expect(none.instanceCount).toBe(0)
    expect(none.colliderInputs).toHaveLength(0)
    expect(none.scatterMeshes).toHaveLength(0)
  })
})

describe('DEV-898: a missing landmark mesh is skipped with its collider', () => {
  it('keeps the other landmarks and the whole scatter', async () => {
    const all = await load()
    missing.add('assets/props/spire-b.glb')
    const some = await load()

    const { landmarks } = meshNames(some)
    expect([...landmarks].some((n) => n.includes('spire-b.glb'))).toBe(false)
    expect([...landmarks].some((n) => n.includes('spire-c.glb'))).toBe(true)
    expect([...landmarks].some((n) => n.includes('spire-d.glb'))).toBe(true)

    const lost = all.landmarkCount - some.landmarkCount
    expect(lost).toBeGreaterThan(0)
    // No invisible wall: the colliders fall by exactly the landmarks that are not drawn.
    expect(all.colliderInputs.length - some.colliderInputs.length).toBe(lost)
    // And the scatter is exactly as it was.
    expect(some.scatterCount).toBe(all.scatterCount)
    expect(warningsAbout('spire-b.glb')).toBe(1)
  })
})

describe('DEV-898: only a mesh that failed to load is forgiven', () => {
  it('rethrows anything else, so a real bug is not swallowed as a missing asset', async () => {
    // The stand-in throws a MeshLoadError for a 404. A different error (a programming mistake
    // upstream of the fetch) must still reach the caller.
    expect(new MeshLoadError('x', 'y')).toBeInstanceOf(Error)
    vi.stubEnv('VITE_ASSET_BASE_URL', '')
    await expect(loadProps('desert', OPTIONS)).rejects.toThrow(/VITE_ASSET_BASE_URL/)
  })
})
