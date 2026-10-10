// tests/unit/ocean-density.test.ts — the sea's density ladder, and the facet
// size the shader is told about. DEV-183.
//
// ── What went wrong, and what a test of it has to look like ──────────────
//
// `uFacet` is *"one water quad in WORLD metres"* and it is a uniform on ONE
// material that every ocean chunk shares. The value it carried was the LOD 0
// one, for the whole 262 km plate. That is wrong for every other band even
// before `subdivisionByLod` widens the spread, because **LOD is a stride over
// the vertex grid** (`sim/terrain/faceted.ts`: `stride = 1 << lod`), so a LOD 3
// chunk's quads really are eight times the LOD 0 ones.
//
// The consequence is not subtle and it is not a tidy-up. `render/water.ts`
// blends the derived normal toward vertical over `footprint / uFacet` — the
// mip-map argument, correct — and clamps its lean to
// `maxFacetTiltRadians(amplitude, facetMetres)`. Told 32 m when the geometry is
// 256 m, the far sea flattens everywhere and the clamp allows eight times the
// lean the mesh can actually produce. On `int_01` the sun is 4 degrees above
// the horizon, so the glint band IS the far sea.
//
// ── Why the assertions are measurements ──────────────────────────────────
//
// CLAUDE.md trap 24: *"a test that re-derives its expectation the way the code
// does has not tested the code."* `facetMetresAt` is
// `baseResolution * 2^lod * scale / subdivide`, and a test that writes that
// product out again proves only that two copies of one expression agree.
//
// So the oracle here is the GEOMETRY. Build the chunk, walk its triangles, and
// measure the shortest non-zero edge in the xz plane — which for this generator
// is one quad's side, because a quad is two triangles with axis-aligned legs
// and a longer diagonal. That number comes from `generateChunk` and
// `subdivideTriangleSoup` doing whatever they do; it is not this file's opinion
// about what they ought to do.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  environmentTerrains,
  facetMetresAt,
  subdivideAt,
  terrainLocalPosition,
  terrainParams,
} from '@/game/terrain/load-terrain'
import { TERRAIN } from '@/generated/constants.generated'
import { createLodFadePool } from '@/render/lod-fade'
import { chunkGeometry } from '@/render/terrain-mesh'
import { createUnityFog } from '@/render/unity-fog'
import {
  applyWaterWaves,
  FACET_METRES_DEFAULT,
  maxFacetTiltRadians,
  type WaterDisplace,
} from '@/render/water'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import { chunkFootprintDistance, initialLod, lodBands } from '@/sim/terrain/lod'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { appSource } from './helpers/app-source'

/**
 * A terrain small enough to build nine times in a unit test, with
 * `randomOffset` **0**.
 *
 * The jitter is off on purpose: it is a per-vertex displacement of up to
 * `randomOffset` metres, so with it on the "shortest edge" is the shortest
 * PERTURBED edge and the measurement acquires a tolerance that hides exactly
 * the factor-of-two errors this file is about. `tests/unit/subdivide.test.ts`
 * covers the jitter; this one covers the pitch.
 */
const params: FacetedTerrainParams = {
  terrainSize: 256,
  terrainHeight: 64,
  chunkSize: 64,
  baseResolution: 8,
  randomOffset: 0,
  seed: 12345,
}

/** The ocean plates are (8, 1, 8); anything but 1 catches a dropped scale. */
const SCALE = 8

const heightMap = (): MapSampler => ({
  width: 128,
  height: 128,
  sample(u, v, out) {
    const h = 0.5 + 0.4 * Math.sin(u * Math.PI * 5) * Math.cos(v * Math.PI * 3)
    out.r = h
    out.g = h
    out.b = h
  },
})

const colorMap = (): MapSampler => ({
  width: 128,
  height: 128,
  sample(u, v, out) {
    out.r = u
    out.g = v
    out.b = 0.5
  },
})

const height = heightMap()
const color = colorMap()
const grid = buildVertexGrid(height, params)

/**
 * The shortest non-zero edge of any triangle, projected onto xz, in MESH units.
 *
 * Projected because the surface has relief and a sloping quad's 3-D edge is
 * longer than its footprint — the facet size the shader compares a screen-space
 * footprint against is the footprint, not the hypotenuse. Non-zero because the
 * SKIRT quads are degenerate in xz by construction (`generateChunk` pins their
 * outer corners to the interior vertex's own x/z and drops them to y = 0), so
 * they contribute edges of length exactly zero and would win every time.
 */
const shortestQuadEdge = (lod: number, subdivide: number): number => {
  const geometry = chunkGeometry(
    generateChunk(grid, color, height, params, 1, 1, lod),
    subdivide,
    0,
  )
  const p = geometry.getAttribute('position').array as ArrayLike<number>
  let best = Number.POSITIVE_INFINITY
  for (let t = 0; t < p.length; t += 9) {
    for (const [a, b] of [
      [0, 3],
      [3, 6],
      [6, 0],
    ] as const) {
      const dx = (p[t + a] as number) - (p[t + b] as number)
      const dz = (p[t + a + 2] as number) - (p[t + b + 2] as number)
      const d = Math.hypot(dx, dz)
      if (d > 1e-6 && d < best) best = d
    }
  }
  return best
}

describe('subdivideAt — a number is a rung, a list is a ladder', () => {
  it('reads a plain number as the same density at every level', () => {
    for (const lod of [0, 1, 2, 3, 4, 5]) expect(subdivideAt(8, lod)).toBe(8)
  })

  it('holds the LAST rung for every level beyond the list', () => {
    const ladder = [8, 4, 2, 1, 1, 1]
    // A preset may name fewer rungs than a terrain has levels; the tail must
    // extend rather than fall off into 1, which would be a silently different
    // ocean beyond the last named band.
    expect(subdivideAt([8, 4], 9)).toBe(4)
    expect(subdivideAt(ladder, 12)).toBe(1)
    // And the named part is the named part.
    expect(ladder.map((_, lod) => subdivideAt(ladder, lod))).toEqual(ladder)
  })

  it('takes rung 0 for the detail ring, which no subdivided terrain reaches', () => {
    // LOD -1 is land-only (`detailRingFor` is handed `isOcean: false`), so this
    // is a guard rather than a behaviour — but an index of -1 into the rungs
    // array is `undefined`, and `undefined` sub-quads is a chunk built at 1.
    expect(subdivideAt([8, 4, 2], -1)).toBe(8)
  })

  it('refuses to produce a density below 1, whatever it is handed', () => {
    // `subdivideTriangleSoup` allocates `triangles * n * n * 9` floats and a
    // fractional or zero n is a Float32Array of a non-integer length or an
    // empty mesh. The preset schema refuses these too; this is the second
    // wall, because `?ocean=` and a hand-edited preset both reach here.
    expect(subdivideAt([0], 0)).toBe(1)
    expect(subdivideAt([-4], 0)).toBe(1)
    expect(subdivideAt([2.7], 0)).toBe(2)
    expect(subdivideAt(undefined, 0)).toBe(1)
    expect(subdivideAt([], 3)).toBe(1)
  })
})

describe('facetMetresAt is the quad the GEOMETRY has, not the LOD 0 one', () => {
  it('matches the measured quad edge at every LOD and every density', () => {
    // The whole bug in one loop: before DEV-183 the left-hand side was the
    // `lod = 0` value for every row of this table, and the right-hand side
    // doubled with each level. At LOD 3 that is eight times apart.
    const seen: string[] = []
    for (const lod of [0, 1, 2]) {
      for (const subdivide of [1, 2, 4]) {
        const measured = shortestQuadEdge(lod, subdivide) * SCALE
        const told = facetMetresAt(params.baseResolution, SCALE, [subdivide], lod)
        expect(told, `lod ${lod}, subdivide ${subdivide}`).toBeCloseTo(measured, 4)
        seen.push(`lod${lod}/x${subdivide} = ${measured} m`)
      }
    }
    // The loud half: a measurement that came back identical for every row
    // would satisfy the nine assertions above and mean nothing.
    expect(new Set(seen).size, seen.join(', ')).toBe(9)
  })

  it('reads a LADDER the same way — the rung for the level, not for the plate', () => {
    // The shipped Anniversary ladder, against the geometry each of its rungs
    // actually produces. This is the composition the assertion above tests one
    // rung at a time, and it is the one the loader performs.
    const ladder = [8, 4, 2, 1, 1, 1]
    for (const lod of [0, 1, 2]) {
      const subdivide = subdivideAt(ladder, lod)
      const measured = shortestQuadEdge(lod, subdivide) * SCALE
      expect(facetMetresAt(params.baseResolution, SCALE, ladder, lod)).toBeCloseTo(measured, 4)
    }
  })

  it('carries the transform SCALE, which the ocean plates are 8 of', () => {
    // A dropped scale is the same class of error as a dropped LOD stride and
    // is worth its own line: Simonet's water is a 32 km terrain stretched to
    // 262 km, so the facet is eight times what the mesh says.
    const one = facetMetresAt(params.baseResolution, 1, [4], 2)
    const eight = facetMetresAt(params.baseResolution, 8, [4], 2)
    expect(eight / one).toBe(8)
  })
})

describe('the shipped presets', () => {
  it('leaves CLASSIC at one density for every band', async () => {
    const classic = (await import('../../content/editions/classic.json')).default
    const ladder = classic.terrain.ocean.subdivisionByLod
    // Unchanged by DEV-183: eight at every level is the ocean this port has
    // drawn since DEV-023, and the ladder has to be FLAT or Classic's geometry
    // has moved. Asserted as "every rung equals rung 0" plus the value, so a
    // future change to the value alone still has to be deliberate.
    expect(new Set(ladder).size, `classic ladder ${ladder.join('/')}`).toBe(1)
    expect(ladder[0]).toBe(8)
    // The terrains with six LOD levels are the deepest shipped; a ladder
    // shorter than that is still flat, but say so at the length that matters.
    for (const lod of [0, 1, 2, 3, 4, 5]) expect(subdivideAt(ladder, lod)).toBe(8)
  })

  it('gives ANNIVERSARY a ladder that never rises with distance', async () => {
    const anniversary = (await import('../../content/editions/anniversary.json')).default
    const ladder = anniversary.terrain.ocean.subdivisionByLod
    expect(ladder.length).toBeGreaterThan(1)
    for (const lod of [1, 2, 3, 4, 5]) {
      expect(
        subdivideAt(ladder, lod),
        `anniversary rung ${lod} is denser than rung ${lod - 1}`,
      ).toBeLessThanOrEqual(subdivideAt(ladder, lod - 1))
    }
    // It starts where Classic is — the near band is not what DEV-183 moved —
    // and it reaches 2016's own geometry somewhere out there.
    expect(subdivideAt(ladder, 0)).toBe(8)
    expect(subdivideAt(ladder, 5)).toBe(1)
  })

  it('never coarsens water inside the sheet’s own LOD 0 distance', async () => {
    // THE claim that makes the trade safe, and it is the sheet's number rather
    // than a metre figure typed here: LOD 0 reaches out to `lodDistance`
    // (1,800 m on Simonet's ocean, horizontal, to the chunk FOOTPRINT — see
    // `sim/terrain/lod.ts`), so every facet within that of the eye is rung 0.
    // Anniversary's rung 0 is Classic's, so the sea the player is close to is
    // drawn at exactly the density it was before DEV-183 and the ladder can
    // only ever act on water that is further away than the whole course.
    const [classic, anniversary] = await Promise.all([
      import('../../content/editions/classic.json'),
      import('../../content/editions/anniversary.json'),
    ])
    for (const env of ['simonet', 'kauai'] as const) {
      const ocean = TERRAIN[env].terrains.ocean
      expect(ocean.lodDistance, `${env} has an LOD 0 band at all`).toBeGreaterThan(0)
      expect(
        subdivideAt(anniversary.default.terrain.ocean.subdivisionByLod, 0),
        `${env}: rung 0 moved, so the near sea is not what it was`,
      ).toBe(subdivideAt(classic.default.terrain.ocean.subdivisionByLod, 0))
    }
  })

  it('makes the far sea COARSER in facets and never finer, against Classic', async () => {
    // The direction of the trade, stated as the thing a reviewer would check:
    // every band of the Anniversary sea is at most as dense as Classic's, so
    // this can only ever remove vertices. `int_01`'s ocean plate, real numbers.
    const [classic, anniversary] = await Promise.all([
      import('../../content/editions/classic.json'),
      import('../../content/editions/anniversary.json'),
    ])
    const OCEAN_BASE_RESOLUTION = 32
    const OCEAN_SCALE = 8
    for (const lod of [0, 1, 2, 3, 4, 5]) {
      const a = facetMetresAt(
        OCEAN_BASE_RESOLUTION,
        OCEAN_SCALE,
        anniversary.default.terrain.ocean.subdivisionByLod,
        lod,
      )
      const c = facetMetresAt(
        OCEAN_BASE_RESOLUTION,
        OCEAN_SCALE,
        classic.default.terrain.ocean.subdivisionByLod,
        lod,
      )
      expect(a, `lod ${lod}`).toBeGreaterThanOrEqual(c)
    }
  })
})

// ── the other half: the material a chunk of that size draws with ─────────

/** Everything `WaterSurface` wants and this file does not care about. */
const blankSurface = {
  specColor: null,
  shininess: null,
  sun: null,
  color: null,
  fresnel: null,
  skySh: null,
}

const OCEAN = TERRAIN.simonet.terrains.ocean
const WAVE = OCEAN.displace as unknown as WaterDisplace

/** The LOD 0 facet on Simonet at the shipped density: 32 * 8 / 8. */
const BASE_FACET = facetMetresAt(OCEAN.baseResolution, 8, [8], 0)

const sea = () => {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true })
  const water = applyWaterWaves(material, WAVE, { ...blankSurface, facetMetres: BASE_FACET })
  return { material, water }
}

/**
 * Run a material's whole `onBeforeCompile` chain over a stub carrying every
 * hook the patches key off, and hand back what they bound.
 *
 * `coast.test.ts`'s `compileWater`, plus the clipping-planes include and a
 * `void main()` so `render/lod-fade.ts`'s splice has somewhere to go.
 */
const compiled = (material: THREE.Material) => {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <begin_vertex>',
    fragmentShader:
      'void main() {\n#include <clipping_planes_fragment>\n#include <color_fragment>\n' +
      '#include <normal_fragment_begin>\n#include <opaque_fragment>\n}',
  }
  ;(material.onBeforeCompile as unknown as (s: typeof shader, r: unknown) => void)(shader, null)
  return shader
}

const facetOf = (material: THREE.Material): number =>
  compiled(material).uniforms.uFacet?.value as number
const tiltCosOf = (material: THREE.Material): number =>
  compiled(material).uniforms.uTiltCos?.value as number
/** `uLodFade.y`: +1 fades in, -1 fades out, 0 draws everything. */
const fadeModeOf = (material: THREE.Material): number =>
  (compiled(material).uniforms.uLodFade?.value as { y: number } | undefined)?.y ?? Number.NaN

describe('water.materialFor — one material per facet size, one program', () => {
  it('hands back the material it was given for the size it was built with', () => {
    // The flat-ladder case, which is Classic and every land terrain: nothing is
    // cloned at all, so this cannot cost a draw call or a uniform upload on a
    // preset that asked for none.
    const { material, water } = sea()
    expect(water.materialFor(BASE_FACET)).toBe(material)
  })

  it('memoises, so a plate of 1,024 chunks is at most one material per band', () => {
    const { water } = sea()
    const first = water.materialFor(BASE_FACET * 8)
    expect(water.materialFor(BASE_FACET * 8)).toBe(first)
    expect(water.materialFor(BASE_FACET * 4)).not.toBe(first)
  })

  it('gives the clone its OWN uFacet, and leaves the base reading its own', () => {
    // The trap this whole mechanism exists for: `applyWaterWaves` binds ONE
    // uniforms object with `Object.assign(shader.uniforms, uniforms)`, shared
    // by every material that runs the chain. A clone that did not override
    // afterwards would read the base's 32 m — which is exactly the bug.
    const { material, water } = sea()
    const far = water.materialFor(BASE_FACET * 8)
    expect(facetOf(far)).toBeCloseTo(BASE_FACET * 8, 6)
    expect(facetOf(material)).toBeCloseTo(BASE_FACET, 6)
  })

  it('keeps uTiltCos in step with the uFacet on the SAME material', () => {
    // Read both off the compiled shader and check they describe one facet,
    // rather than checking either against a number written here: the clamp is
    // "how far can a quad of THIS size lean", so the two uniforms are one fact.
    for (const multiple of [1, 2, 8, 64]) {
      const { water } = sea()
      const m = water.materialFor(BASE_FACET * multiple)
      expect(Math.acos(tiltCosOf(m)), `x${multiple}`).toBeCloseTo(
        maxFacetTiltRadians(WAVE.amplitude, facetOf(m)),
        9,
      )
    }
  })

  it('lets a COARSER facet lean less, which is what the geometry can do', () => {
    // The relationship, independent of the arithmetic: the wave's whole range
    // is the same metres across a wider quad, so the steepest face it can make
    // is shallower. A clamp that did not tighten with distance is the one that
    // let the far sea speckle.
    const { water } = sea()
    const near = tiltCosOf(water.materialFor(BASE_FACET))
    const far = tiltCosOf(water.materialFor(BASE_FACET * 8))
    const further = tiltCosOf(water.materialFor(BASE_FACET * 64))
    expect(far).toBeGreaterThan(near)
    expect(further).toBeGreaterThan(far)
    expect(further).toBeLessThanOrEqual(1)
  })

  it('shares the base program, so N bands are N materials and ONE program', () => {
    // `Material.copy` carries neither hook, and three's default cache key is
    // `onBeforeCompile.toString()` — a different function per clone, so a
    // compile per band. The facet is a UNIFORM; there is nothing here to vary.
    const { material, water } = sea()
    const far = water.materialFor(BASE_FACET * 8)
    expect(far.customProgramCacheKey()).toBe(material.customProgramCacheKey())
    expect(far).not.toBe(material)
  })

  it('moves every band when the sea changes variant', () => {
    // `side` and `defines` are both in the program cache key, so a clone left
    // behind by `applyVariant` is not a dim picture — it is the sea two-sided
    // in the chunks you are over and one-sided in the chunks beyond them.
    const { material, water } = sea()
    const far = water.materialFor(BASE_FACET * 8)
    water.setEyeHeight(5_000, 0)
    expect(material.side).toBe(THREE.FrontSide)
    expect(far.side).toBe(THREE.FrontSide)
    expect(far.defines?.FF2_WATER_TWO_SIDED).toBeUndefined()
    // ...and back, because the eye crosses this twice on every launch ride.
    water.setEyeHeight(0, 0)
    expect(material.side).toBe(THREE.DoubleSide)
    expect(far.side).toBe(THREE.DoubleSide)
    expect(far.defines?.FF2_WATER_TWO_SIDED).toBe('')
  })

  it('carries the variant to a band CUT AFTER the flip, not just before it', () => {
    // A band is cloned lazily, the first time a chunk lands on it — which for
    // the far sea is minutes into a lap, long after the breach. A clone born
    // into the wrong variant would be the same bug from the other end.
    const { material, water } = sea()
    water.setEyeHeight(5_000, 0)
    const late = water.materialFor(BASE_FACET * 16)
    expect(late.side).toBe(material.side)
    expect(late.defines?.FF2_WATER_TWO_SIDED).toBeUndefined()
  })
})

describe('a fading chunk keeps its band (DEV-130 x DEV-183)', () => {
  it('cuts fade clones from the BAND material and they carry its facet', () => {
    const { material, water } = sea()
    const pool = createLodFadePool()
    pool.applyTo(material)
    const far = water.materialFor(BASE_FACET * 8)
    // `applyTo` would splice the fade GLSL a second time — the include it keys
    // off survives the first pass — and tag the cache key twice. `adopt` says
    // "this one already carries the patch, by delegation".
    pool.adopt(far)
    const pair = pool.acquire(far)
    expect(pair).not.toBeNull()
    if (!pair) return
    for (const m of [pair.incoming, pair.outgoing]) {
      expect(facetOf(m)).toBeCloseTo(BASE_FACET * 8, 6)
      // And the fade still works on it: its own coverage uniform, not the
      // base's OFF one, or every fading chunk would draw fully opaque.
      expect(Math.abs(fadeModeOf(m))).toBe(1)
      expect(compiled(m).fragmentShader).toContain('ff2LodFadeDither')
    }
    // ONE copy of the fade's declaration, not two — `adopt` rather than a
    // second `applyTo` is what keeps that true, and two would not compile.
    const text = compiled(pair.incoming).fragmentShader
    expect(text.split('uniform vec2 uLodFade;').length - 1).toBe(1)
    // The complementary pair, unchanged: one owns the fragments below the
    // dither, the other the rest.
    pair.setCoverage(0.5)
    expect(fadeModeOf(pair.incoming)).toBe(1)
    expect(fadeModeOf(pair.outgoing)).toBe(-1)
  })

  it('re-reads the variant at acquire, so a pooled clone is not stuck two-sided', () => {
    // The pool hands the same clones back. One cut during the launch ride —
    // where the sea IS two-sided, for 97 m of a 106 m climb — would otherwise
    // go on drawing the two-sided program for every fading ocean chunk for the
    // rest of the lap: the right picture, at the wrong price, invisibly.
    const { material, water } = sea()
    const pool = createLodFadePool()
    pool.applyTo(material)
    water.setEyeHeight(0, 0)
    expect(material.side).toBe(THREE.DoubleSide)
    const first = pool.acquire(material)
    if (!first) throw new Error('pool refused at its first acquire')
    expect(first.incoming.side).toBe(THREE.DoubleSide)
    pool.release(first)
    water.setEyeHeight(5_000, 0)
    const second = pool.acquire(material)
    if (!second) throw new Error('pool refused the reused pair')
    // The SAME two materials, which is what makes this a real test: the pool
    // cut nothing new, so anything stale on them is still stale. (The pair
    // pops LIFO, so `incoming` and `outgoing` swap round — that is why this
    // asserts the set and the clone count rather than the identity of one.)
    expect(pool.cloneCount).toBe(2)
    expect(new Set([second.incoming, second.outgoing])).toEqual(
      new Set([first.incoming, first.outgoing]),
    )
    expect(second.incoming.side).toBe(THREE.FrontSide)
    expect(second.outgoing.side).toBe(THREE.FrontSide)
    expect(second.incoming.defines?.FF2_WATER_TWO_SIDED).toBeUndefined()
  })
})

// ── and what the ladder is WORTH, which is not what the plan assumed ──────

describe('the ladder’s leverage on int_01, over int_01’s own route', () => {
  /**
   * The thing this file exists to stop anyone believing without checking.
   *
   * `subdivisionByLod` can only act on a chunk that is NOT at LOD 0, and the
   * ocean's chunks are `chunkSize` 1024 mesh units at the plate's 8x scale —
   * **8,192 m across**. The LOD test measures to the chunk FOOTPRINT (DEV-023,
   * and it is right to: measuring to an 8 km chunk's CENTRE judged the water
   * under the ship four kilometres away), so standing anywhere near where the
   * four built chunks meet puts every one of them at LOD 0 — and `int_01`'s
   * course is centred on the island, which is near that meeting point.
   *
   * So the ladder is INERT over most of the one mission the release ships, and
   * the arithmetic below is what says so. It is a mechanism — chunk counts and
   * LOD levels, no milliseconds — and it is asserted rather than printed
   * because a feature whose leverage nobody measured is the shape of DEV-102
   * and DEV-069 both.
   */
  const oceanChunkCensus = () => {
    const env = environmentTerrains('simonet')
    const key = env.ocean as string
    const p = terrainParams(key)
    const entry = TERRAIN.simonet.terrains.ocean
    const tp = terrainLocalPosition(key)
    const wo = int01.worldOffset as number[]
    const ts = entry.transform.scale as readonly number[]
    const footprint = {
      originX: (wo[0] as number) + (tp[0] as number),
      originZ: (wo[2] as number) - (tp[2] as number),
      scaleX: ts[0] as number,
      scaleZ: ts[2] as number,
      chunkSize: p.chunkSize,
    }
    const perSide = p.terrainSize / p.chunkSize
    const bands = lodBands(entry.lodDistance, entry.lodLevels, entry.flipFlopPercent)
    const centre = env.oceanCentre
    // `boot/app.ts` passes `visibleRadius: CAMERA_FAR` around the LAND's own
    // position, so the ocean's window is fixed at the island rather than
    // following the camera. That is why there are only ever a handful.
    const CAMERA_FAR = 6000
    const built: [number, number][] = []
    for (let cx = 0; cx < perSide; cx++) {
      for (let cy = 0; cy < perSide; cy++) {
        const x0 = footprint.originX + footprint.scaleX * cx * p.chunkSize
        const x1 = footprint.originX + footprint.scaleX * (cx + 1) * p.chunkSize
        const z1 = footprint.originZ - footprint.scaleZ * cy * p.chunkSize
        const z0 = footprint.originZ - footprint.scaleZ * (cy + 1) * p.chunkSize
        const dx = Math.max(x0 - centre[0], 0, centre[0] - x1)
        const dz = Math.max(z0 - centre[2], 0, centre[2] - z1)
        if (Math.hypot(dx, dz) <= CAMERA_FAR) built.push([cx, cy])
      }
    }
    /** Triangles in one chunk at `lod`, skirt ring included, after subdivision. */
    const tris = (lod: number, ladder: number | readonly number[]) => {
      const quads = (p.chunkSize / p.baseResolution) >> lod
      return (quads + 2) ** 2 * 2 * subdivideAt(ladder, lod) ** 2
    }
    const standing = (x: number, z: number) => {
      const hist: Record<number, number> = {}
      for (const [cx, cy] of built) {
        const lod = initialLod(bands, chunkFootprintDistance(footprint, cx, cy, x, z))
        hist[lod] = (hist[lod] ?? 0) + 1
      }
      const total = (ladder: number | readonly number[]) =>
        Object.entries(hist).reduce((s, [lod, n]) => s + n * tris(Number(lod), ladder), 0)
      return { hist, total }
    }
    return { built, standing, tris }
  }

  /** The spawn and twenty-two stands spread along the authored route. */
  const stands = (): [string, number, number][] => {
    const out: [string, number, number][] = [
      ['spawn', int01.spawn.pos[0] as number, int01.spawn.pos[2] as number],
    ]
    const route = (int01 as unknown as { route: number[][] }).route
    for (let i = 0; i < route.length; i += 20) {
      const p = route[i] as number[]
      out.push([`route${i}`, p[0] as number, p[2] as number])
    }
    return out
  }

  it('builds a handful of chunks, each 8 km across, and they are mostly LOD 0', async () => {
    const anniversary = (await import('../../content/editions/anniversary.json')).default
    const ladder = anniversary.terrain.ocean.subdivisionByLod
    const { built, standing } = oceanChunkCensus()
    // Four. The window is `CAMERA_FAR` around the ISLAND, and the chunks are
    // 8,192 m, so the whole visible sea is a 2x2.
    expect(built.length).toBe(4)

    const rows = stands().map(([name, x, z]) => {
      const s = standing(x, z)
      const flat = s.total(8)
      const laddered = s.total(ladder)
      return { name, hist: s.hist, flat, laddered, saving: 1 - laddered / flat }
    })
    const savings = rows.map((r) => r.saving)
    const inert = rows.filter((r) => r.saving === 0).length
    console.info(
      `DEV-183: int_01's ocean is ${built.length} chunks of 8,192 m. Over ${rows.length} stands on\n` +
        `  its own route the ladder [${ladder.join(',')}] removes ` +
        `${(100 * Math.min(...savings)).toFixed(1)}%-${(100 * Math.max(...savings)).toFixed(1)}% of the\n` +
        `  sea's triangles, and NOTHING at ${inert} of them — every chunk is LOD 0 there.\n` +
        rows
          .map(
            (r) =>
              `    ${r.name.padEnd(9)} ${JSON.stringify(r.hist).padEnd(20)} ` +
              `${r.flat.toLocaleString().padStart(9)} -> ${r.laddered.toLocaleString().padStart(9)}` +
              `  ${(100 * r.saving).toFixed(1)}%`,
          )
          .join('\n'),
    )

    // THE finding, asserted so it cannot quietly stop being true: there are
    // stands on this course where every built chunk is LOD 0 and the ladder
    // therefore changes not one triangle. If this ever fails because the
    // saving went UP, that is good news and the row needs rewriting.
    expect(inert, 'stands where the ladder is inert').toBeGreaterThan(0)
    expect(Math.max(...savings), 'the best the ladder ever does on int_01').toBeLessThan(0.25)
  })

  it('names the rung that WOULD move it, and what each one costs in facet metres', () => {
    // Rung 0 is the number to argue with. On a frame where all four chunks are
    // LOD 0 — most of this course — nothing else in the ladder is reachable.
    // `?ocean=<n>` is the same dial without editing a preset.
    const { tris } = oceanChunkCensus()
    const table = [8, 4, 2, 1].map((rung) => ({
      rung,
      // The LOD 0 facet in world metres: `baseResolution * scale / rung`.
      facet: facetMetresAt(TERRAIN.simonet.terrains.ocean.baseResolution, 8, [rung], 0),
      removed: 1 - tris(0, [rung]) / tris(0, [8]),
    }))
    console.info(
      `DEV-183: rung 0 on an all-LOD-0 frame — ${table
        .map((t) => `x${t.rung} = ${t.facet} m facet, -${(100 * t.removed).toFixed(1)}%`)
        .join('; ')}`,
    )
    // 2016's own sea is rung 0 = 1, and it is 256 m a facet.
    expect(table.find((t) => t.rung === 1)?.facet).toBe(FACET_METRES_DEFAULT)
    // ...and the shipped rung removes nothing, which is the point of the row.
    expect(table.find((t) => t.rung === 8)?.removed).toBe(0)
  })
})

// ── the guard for the bug this branch actually shipped and then found ─────

describe('a band is patched by DELEGATION, never a second time', () => {
  /**
   * `boot/app.ts` used to give the fog to every chunk's own material by walking
   * `group.children` — right while a terrain had exactly one material, and the
   * bug the moment it had bands. A band delegates its whole `onBeforeCompile`
   * chain back to the base, so patching it as well runs the fog's prologue
   * TWICE and the vertex shader fails to compile on
   * `'vUnityFogWorldPos' : redefinition`. `unity-fog` guards per MATERIAL, and
   * a clone is a different material, so its guard cannot see it.
   *
   * Every unit test on this branch passed while that was live, because the fog
   * is applied by `boot/app.ts` and none of them composed the two. `pnpm check`
   * was green; `boot.spec.ts` caught it, once, as a console error. This is the
   * cheap half of that spec.
   */
  const fogged = () =>
    createUnityFog({
      mode: 2,
      density: 0.00025,
      linearStart: 100,
      linearEnd: 2500,
      color: [0.87, 0.66, 0.7],
      distanceFog: true,
      heightFog: true,
      useRadialDistance: true,
      height: 387,
      heightDensity: 0.03,
      startDistance: 256,
    })

  it('declares the fog’s varying ONCE on a band cut before the fog lands', () => {
    // The real order: `loadTerrain` builds the bands while it builds the
    // chunks, and `boot/app.ts` fogs the terrain afterwards. So the band is
    // older than the patch it has to inherit — which it does, because its
    // `onBeforeCompile` reads the base's at CALL time rather than capturing it.
    const { material, water } = sea()
    const band = water.materialFor(BASE_FACET * 8)
    fogged().applyTo(material)
    const text = compiled(band)
    expect(text.vertexShader.split('varying vec3 vUnityFogWorldPos;').length - 1).toBe(1)
    expect(text.fragmentShader.split('varying vec3 vUnityFogWorldPos;').length - 1).toBe(1)
    // ...and it really did inherit it, rather than there being one copy
    // because there is none.
    expect(text.vertexShader).toContain('vUnityFogWorldPos')
    expect(text.uniforms.uFogColor).toBeDefined()
    // The band still has its own facet after all that chaining.
    expect(facetOf(band)).toBeCloseTo(BASE_FACET * 8, 6)
  })

  it('is what a SECOND patch on the band would break, so the guard is real', () => {
    // The loud counterpart: do the thing `boot/app.ts` used to do, and watch
    // the redefinition appear. Without this the assertion above passes on a
    // build where nothing patches anything.
    const { material, water } = sea()
    const band = water.materialFor(BASE_FACET * 8)
    fogged().applyTo(material)
    fogged().applyTo(band)
    const text = compiled(band)
    expect(text.vertexShader.split('varying vec3 vUnityFogWorldPos;').length - 1).toBe(2)
  })

  it('hands the caller ONE material to patch, not one per chunk', async () => {
    // The door itself. `LoadedTerrain.materials` is what `boot/app.ts` walks
    // now; a terrain that returned its chunks' materials instead would put the
    // bands straight back in front of `fog.applyTo`.
    const source = appSource()
    // Neither terrain's chunk children may be walked for a material any more.
    expect(source).not.toMatch(
      /for \(const child of (terrain|ocean|titleValley)\.group\.children\)/,
    )
    expect(source).toContain('for (const m of terrain.materials)')
    expect(source).toContain('for (const m of ocean.materials)')
  })
})
