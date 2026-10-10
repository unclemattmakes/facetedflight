// tests/unit/terrain-placement.test.ts — is the island under the rings?
//
// ── Why this is not obvious ───────────────────────────────────────────────
//
// The terrain and the mission content are placed INDEPENDENTLY in 2016.
// `LoadLevelArt.cs` is four lines of `SceneManager.LoadSceneAsync(levelName,
// Additive)` — no re-parenting, no offset. So the environment scene lands at
// its own world coordinates and the mission's `levelOffset` GameObject moves
// only the mission's own objects.
//
// That leaves the port with a question nothing in the source answers directly:
// where does the island go relative to the rings? Three plausible answers, and
// they disagree by kilometres.
//
// It is settled by measurement. Sample the heightmap under all 21 of
// `int_01_hoverJet`'s rings and see which placement puts them in the air:
//
//   terrain transform only      5/21 rings on the map
//   worldOffset only           21/21 on the map, but SEVEN underground
//   worldOffset + transform    20/21 on the map, 40-339 m up, none underground
//
// Only one of those describes a flyable course. This test holds that result, so
// that when M1 puts the rings in the scene and they line up, it is because the
// placement is right rather than because two errors cancelled.
//
// It does NOT check the handedness conversion, despite the temptation to claim
// it does: everything here works on the level JSON and the heightmap, and never
// touches `chunkGeometry`. Removing the z flip or the winding reversal leaves
// every assertion below green. That is `terrain-mesh.test.ts`'s job, and the
// claim was in this header for about ten minutes before a mutation run said
// otherwise — which is the same lesson as DEV-007, on a smaller scale.
//
// SKIPS when the legacy project is not mounted: it needs the real heightmap.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import { grayscale } from '@/sim/terrain/faceted'
import { importUnityTexture } from '@/sim/terrain/image-sampler'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { legacyRootOrAbsent } from '../../tools/legacy-root.mjs'
import { decodePng } from '../../tools/terrain/png.mjs'

const LEGACY = legacyRootOrAbsent()
const ISLANDS = TERRAIN.simonet.terrains.islands
const heightMapFile = path.join(LEGACY, ISLANDS.sourceHeightMap)
const available = fs.existsSync(heightMapFile)

/** Unity from three: the conversion is `z -> -z`, and it is its own inverse. */
const toUnity = (p: readonly number[]): [number, number, number] => [
  p[0] as number,
  p[1] as number,
  -(p[2] as number),
]

interface Placement {
  onMap: number
  belowGround: number
  clearances: number[]
}

const measure = (origin: readonly [number, number, number]): Placement => {
  const height = importUnityTexture(decodePng(heightMapFile))
  const rgb = { r: 0, g: 0, b: 0 }
  const clearances: number[] = []
  let onMap = 0
  let belowGround = 0

  for (const ring of int01.routes[0]?.rings ?? []) {
    const [rx, ry, rz] = toUnity(ring.pos as number[])
    // Into the terrain's own mesh space, where the generator's 0..TerrainSize
    // coordinates and the heightmap's UV agree.
    const mx = rx - origin[0]
    const mz = rz - origin[2]
    if (mx < 0 || mx > ISLANDS.terrainSize || mz < 0 || mz > ISLANDS.terrainSize) continue
    onMap++
    height.sample(mx / ISLANDS.terrainSize, mz / ISLANDS.terrainSize, rgb)
    const surface = origin[1] + grayscale(rgb.r, rgb.g, rgb.b) * ISLANDS.terrainHeight
    const clearance = ry - surface
    clearances.push(clearance)
    if (clearance < 0) belowGround++
  }
  return { onMap, belowGround, clearances }
}

const TRANSFORM = ISLANDS.transform.position as unknown as [number, number, number]
const WORLD_OFFSET = toUnity(int01.worldOffset as number[])
const CHOSEN: [number, number, number] = [
  WORLD_OFFSET[0] + TRANSFORM[0],
  WORLD_OFFSET[1] + TRANSFORM[1],
  WORLD_OFFSET[2] + TRANSFORM[2],
]

describe('the terrain transform came out of the prefab', () => {
  it('is not the identity, and the y is why sea level is not zero', () => {
    // The mesh runs 0..4096 in its own space; this is the only thing that puts
    // it anywhere. A zero here means the extractor stopped finding the
    // Transform and every placement below silently becomes "at the origin".
    expect(TRANSFORM[0]).toBeCloseTo(-109.91968, 4)
    expect(TRANSFORM[1]).toBeCloseTo(-81.69, 4)
    expect(TRANSFORM[2]).toBeCloseTo(180.8584, 4)
    expect(ISLANDS.transform.scale).toEqual([1, 1, 1])
  })

  it('records the ocean plate as scaled 8x, which is not a typo', () => {
    // 32768 m of terrain stretched to 262 km. Anything that reads terrainSize
    // without the scale puts the horizon in the wrong place.
    expect(TERRAIN.simonet.terrains.ocean.transform.scale).toEqual([8, 1, 8])
    expect(TERRAIN.simonet.terrains.ocean.terrainSize).toBe(32768)
  })
})

describe.skipIf(!available)('int_01_hoverJet rings, against the real heightmap', () => {
  it('puts 20 of 21 rings over the island, all of them airborne', () => {
    const { onMap, belowGround, clearances } = measure(CHOSEN)
    expect(onMap).toBeGreaterThanOrEqual(20)
    expect(belowGround).toBe(0)

    clearances.sort((a, b) => a - b)
    // A stunt course flies close to the ground but not through it, and not at
    // altitude either. Anything outside this band means the vertical placement
    // is wrong even if the horizontal one is right — and `transform.y` is
    // -81.69 m, so getting it wrong is easy and looks fine from above.
    expect(clearances[0]).toBeGreaterThan(10)
    expect(clearances[clearances.length - 1]).toBeLessThan(600)
    const median = clearances[clearances.length >> 1] as number
    expect(median).toBeGreaterThan(50)
    expect(median).toBeLessThan(300)
  })

  it('rejects the two placements that look plausible and are not', () => {
    // Terrain transform alone: the mission's own -2048 offset is never applied,
    // so most of the course is off the edge of the world.
    expect(measure(TRANSFORM).onMap).toBeLessThan(10)

    // worldOffset alone: every ring lands on the map, which is exactly what
    // makes it tempting — and several of them are inside a mountain.
    const offsetOnly = measure(WORLD_OFFSET)
    expect(offsetOnly.onMap).toBe(21)
    expect(offsetOnly.belowGround).toBeGreaterThan(0)
  })
})

describe.skipIf(available)('terrain placement — legacy project not mounted', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(available).toBe(false)
  })
})
