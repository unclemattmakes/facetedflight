// tests/unit/custom-ground.test.ts — DEV-489, the custom-ground core.
//
// Relationships, not re-derivations (trap 24): the ramp is judged against the
// colour it was measured from, the density bands against the density a bake
// was DRAWN from, the placement against the donor's centre, and "no path
// special to where the heights came from" against the 8-bit sampler the 2016
// maps use.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import type { EnvironmentProps, PropScatter } from '@/content/load-environment'
import { playtestLevel } from '@/editor/core/playtest'
import { urlTaint } from '@/game/run-taint'
import {
  assertCustomGround,
  buildColourRamp,
  CUSTOM_GROUND_LIMITS,
  type CustomGround,
  coneIsland,
  courseCorridor,
  customEnvironmentProps,
  customGroundGrid,
  customGroundOf,
  customGroundProblems,
  customHeightSampler,
  customScatterPass,
  customTerrainLocal,
  customTerrainParams,
  donorLand,
  groundGrid,
  MIN_BAND_AREA,
  measureDensityBands,
  paintCustomColour,
  previewIsland,
  previewIslandDoor,
  readBandTable,
  SLOPE_BANDS,
  withCustomGround,
} from '@/game/terrain/custom-ground'
import { TERRAIN_SEED, terrainParams } from '@/game/terrain/load-terrain'
import { withSunLightRule } from '@/render/sun-light-rule'
import {
  encodeBase64,
  encodePlacements,
  expandPlacements,
  PLACEMENT_STRIDE,
} from '@/sim/props/placements'
import { scatterProps } from '@/sim/props/scatter'
import { buildVertexGrid, grayscale } from '@/sim/terrain/faceted'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import {
  createMapSampler,
  type ImageData8,
  importUnityTexture,
  type MapSampler,
} from '@/sim/terrain/image-sampler'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { fittedCourse } from './helpers/editor-course'
import { haveMaps, loadLevelJson } from './helpers/terrain-field'

/** A sampler from a function of (u, v), for a synthetic donor. */
const fnSampler = (f: (u: number, v: number) => [number, number, number]): MapSampler => ({
  width: 1024,
  height: 1024,
  sample(u, v, out) {
    const [r, g, b] = f(u, v)
    out.r = r
    out.g = g
    out.b = b
  },
})

/** Desert is the synthetic donor: 4096 m, 1024 m tall, 512 m chunks, 8 m facets. */
const DESERT = donorLand('desert').entry

const flatGround = (value: number, edge = 65): CustomGround => ({
  heights: { width: edge, height: edge, data: new Float32Array(edge * edge).fill(value) },
  size: 2048,
  maxHeight: 512,
  island: 'desert',
})

describe('DEV-489 — the policy, pinned by value', () => {
  it('names every bound, and derives the two extents from the sheet', () => {
    expect(CUSTOM_GROUND_LIMITS).toEqual({
      maxSize: 8192,
      maxHeight: 1536,
      maxEdge: 4097,
      minEdge: 2,
    })
    expect(SLOPE_BANDS).toBe(8)
    expect(MIN_BAND_AREA).toBe(4096)
  })
})

describe('DEV-489 — what a CustomGround may be', () => {
  it('accepts a plain one', () => {
    expect(customGroundProblems(flatGround(0.2))).toEqual([])
  })
  it('refuses, with a reason each, what the generator cannot take', () => {
    const bad = (g: Partial<CustomGround>) => customGroundProblems({ ...flatGround(0.2), ...g })
    expect(bad({ island: 'atlantis' }).join()).toMatch(/not a shipped island/)
    expect(bad({ size: 1000 }).join()).toMatch(/whole number of desert's 512 m chunks/)
    expect(bad({ size: 16384 }).join()).toMatch(/not in \(0, 8192\]/)
    expect(bad({ maxHeight: 0 }).join()).toMatch(/maxHeight/)
    expect(bad({ maxHeight: Number.NaN }).join()).toMatch(/maxHeight/)
    const nan = flatGround(0.2)
    ;(nan.heights.data as Float32Array)[7] = Number.NaN
    expect(customGroundProblems(nan).join()).toMatch(/sample 7 is NaN/)
    expect(
      bad({ heights: { width: 5000, height: 2, data: new Float32Array(10000) } }).join(),
    ).toMatch(/over 4097/)
    expect(bad({ heights: { width: 4, height: 4, data: new Float32Array(15) } }).join()).toMatch(
      /15 samples/,
    )
    expect(() => assertCustomGround({ ...flatGround(0.2), size: 1000 })).toThrow(/custom ground/)
  })
})

describe('DEV-489 — a ground rides on a Level, and nowhere a Level is written', () => {
  const int01 = loadLevelJson('int_01_hoverJet') as Level
  const cone = coneIsland({
    island: 'simonet',
    size: 1024,
    maxHeight: 1536,
    edge: 33,
    shore: 0.129,
    peak: 0.45,
  })

  it('is carried, survives the spreads on the way to the world, and is invisible to JSON', () => {
    expect(customGroundOf(int01)).toBeNull()
    const grounded = withCustomGround(int01, cone)
    expect(customGroundOf(grounded)).toBe(cone)
    expect(customGroundOf(int01), 'the original is not touched').toBeNull()
    // `switchMission` puts every level through the sun rule, a spread copy.
    expect(customGroundOf(withSunLightRule(grounded, 'port'))).toBe(cone)
    expect(customGroundOf({ ...grounded })).toBe(cone)
    expect(JSON.stringify(grounded)).toBe(JSON.stringify(int01))
    expect(customGroundOf(withCustomGround(grounded, null))).toBeNull()
  })

  it('does NOT survive structuredClone — so an expansion against a grounded donor must be given it again', () => {
    expect(customGroundOf(structuredClone(withCustomGround(int01, cone)))).toBeNull()
  })
})

describe('DEV-489 — the generator takes the grid with no path special to it', () => {
  it('a float grid samples exactly as the 8-bit map it could have come from', () => {
    // An 8-bit map and the same values as floats, through the two samplers:
    // no rescale on either (power of two), so the grids must agree.
    const edge = 64
    const bytes = new Uint8Array(edge * edge)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >> 6) * 11) % 256
    const img: ImageData8 = { width: edge, height: edge, channels: 1, data: bytes }
    const f32 = Float32Array.from(bytes, (b) => b / 255)
    const ground: CustomGround = {
      heights: { width: edge, height: edge, data: f32 },
      size: 1024,
      maxHeight: 256,
      island: 'desert',
    }
    const params = customTerrainParams(ground, TERRAIN_SEED)
    const a = buildVertexGrid(customHeightSampler(ground), params)
    const b = buildVertexGrid(createMapSampler(img), params)
    let worst = 0
    for (let i = 0; i < a.verts.length; i++)
      worst = Math.max(worst, Math.abs((a.verts[i] as number) - (b.verts[i] as number)))
    expect(worst).toBeLessThan(1e-3)
  })

  it('takes the donor grain and the player extent', () => {
    const g = flatGround(0.2)
    expect(customTerrainParams(g, TERRAIN_SEED)).toEqual({
      terrainSize: 2048,
      terrainHeight: 512,
      chunkSize: DESERT.chunkSize,
      baseResolution: DESERT.baseResolution,
      randomOffset: DESERT.randomOffset,
      seed: TERRAIN_SEED,
    })
  })

  it('the collision field puts the cone summit where the grid put it, at its height', () => {
    const cone = coneIsland({
      island: 'simonet',
      size: 2048,
      maxHeight: 1000,
      edge: 257,
      shore: 0.1,
      peak: 0.6,
    })
    const field = buildHeightField(
      customHeightSampler(cone),
      customTerrainParams(cone, TERRAIN_SEED),
      {
        position: [0, 0, 0],
        scale: [1, 1, 1],
      },
    )
    // `GetPixelBilinear` addressing (`u * width`, image-sampler.ts): a grid of
    // W samples spans the terrain as W texels, so sample i stands at
    // i * size / W — the summit sample 128 of 257 at 1020.0 m, not at 1024.
    // The field's highest vertex is therefore the one nearest 1020, and it
    // reads within a texel's slope of the peak.
    let best = { h: -1, x: 0, z: 0 }
    for (let x = 960; x <= 1088; x += 8)
      for (let z = 960; z <= 1088; z += 8) {
        const h = terrainHeightAt(field, x, z)
        if (h > best.h) best = { h, x, z }
      }
    // The two vertices either side of 1020 m, and neither of them ON the peak:
    // corner-aligned addressing (`u * (W - 1)`) would put vertex 1024 exactly
    // on sample 128 and read 600.0 there.
    expect(Math.abs(best.x - 1020)).toBe(4)
    expect(Math.abs(best.z - 1020)).toBe(4)
    expect(best.h).toBeGreaterThan(590)
    expect(best.h).toBeLessThan(599.5)
    expect(terrainHeightAt(field, 10, 10)).toBeCloseTo(50, 0)
  })

  it('is centred on the donor land at any size, and stands exactly on it at the donor size', () => {
    const donorPos = [-109.9, -81.69, 180.86]
    const full = customTerrainLocal({ ...flatGround(0.2), size: 4096 }, donorPos)
    expect(full).toEqual(donorPos)
    for (const size of [1024, 2048, 3584]) {
      const at = customTerrainLocal({ ...flatGround(0.2), size }, donorPos)
      expect(at[0] + size / 2).toBeCloseTo((donorPos[0] as number) + DESERT.terrainSize / 2, 6)
      expect(at[2] + size / 2).toBeCloseTo((donorPos[2] as number) + DESERT.terrainSize / 2, 6)
      expect(at[1]).toBe(donorPos[1])
    }
  })
})

describe('DEV-489 — colour: the donor ramp, over the player ground', () => {
  // A donor whose height rises along u, and whose colour is a function of
  // height alone: the ramp must hand that function back at any height it saw.
  const colourOf = (h01: number): [number, number, number] => [h01, 1 - h01, 0.5 * h01 * h01]
  const donorH = fnSampler((u) => [0.9 * u, 0.9 * u, 0.9 * u])
  const donorC = fnSampler((u) => colourOf(0.9 * u))
  const donorGrid = groundGrid(
    donorH,
    DESERT.terrainSize,
    DESERT.terrainHeight,
    DESERT.baseResolution,
  )
  const ramp = buildColourRamp(donorGrid, donorC, DESERT)

  it('paints the donor colour for the donor height, wherever the player put it', () => {
    const cone = coneIsland({
      island: 'desert',
      size: 2048,
      maxHeight: 1024,
      edge: 129,
      shore: 0.1,
      peak: 0.8,
    })
    const grid = customGroundGrid(cone)
    const img = paintCustomColour(cone, grid, ramp, 8)
    const sampler = customHeightSampler(cone)
    const rgb = { r: 0, g: 0, b: 0 }
    let worst = 0
    for (let k = 0; k < 400; k++) {
      const x = (k * 97) % img.width
      const y = (k * 61) % img.height
      // The buffer's row 0 is the TOP; Unity's texel y counts from the bottom.
      sampler.sample(x / img.width, y / img.height, rgb)
      const want = colourOf(grayscale(rgb.r, rgb.g, rgb.b) * (1024 / 1024))
      const o = ((img.height - 1 - y) * img.width + x) * 3
      for (let c = 0; c < 3; c++)
        worst = Math.max(worst, Math.abs((img.data[o + c] as number) / 255 - (want[c] as number)))
    }
    // One height band is 4 m of 1024: a colour ramp that slope 1 moves 0.004 a band.
    expect(worst).toBeLessThan(0.02)
  })

  it('ground higher than anything the donor has wears the donor highest, never black', () => {
    const out = new Float32Array(3)
    readBandTable(ramp, 5000, 0, out)
    const top = colourOf(0.9)
    expect(out[0]).toBeCloseTo(top[0], 1)
    expect(out[1]).toBeCloseTo(top[1], 1)
  })

  it('separates slope: a flat and a steep face at one height take their own colours', () => {
    // A donor split in two: a flat terrace at 300 m (u < 0.5), and a steep
    // ramp through 300 m (u >= 0.5). Colour says which half.
    const h = fnSampler((u) => {
      const m = u < 0.5 ? 300 : 300 + (u - 0.75) * 4096 * 1.2
      const g = Math.min(1, Math.max(0, m / 1024))
      return [g, g, g]
    })
    const c = fnSampler((u) => (u < 0.5 ? [1, 0, 0] : [0, 0, 1]))
    const t = buildColourRamp(groundGrid(h, 4096, 1024, 8), c, DESERT)
    const flat = new Float32Array(3)
    const steep = new Float32Array(3)
    readBandTable(t, 300, 0, flat)
    readBandTable(t, 300, 0.75, steep)
    expect(flat[0]).toBeGreaterThan(0.9)
    expect(steep[2]).toBeGreaterThan(0.9)
  })
})

/** A synthetic scatter pass: a density map drawn by a rule, baked as 2016's are. */
const bakedPass = (density: (h: number) => number, donorH: MapSampler, w = 1024): PropScatter => {
  const data = new Uint8Array(w * w)
  const rgb = { r: 0, g: 0, b: 0 }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < w; y++) {
      donorH.sample(x / w, y / w, rgb)
      data[(w - 1 - y) * w + x] = Math.round(
        density(grayscale(rgb.r, rgb.g, rgb.b) * DESERT.terrainHeight) * 255,
      )
    }
  const params = {
    probabilityScale: 0.05,
    heightOffset: 0,
    scaleMin: 1,
    scaleMax: 2,
    paletteSize: 3,
    seed: 1,
  }
  const s = scatterProps({ width: w, height: w, channels: 1, data }, donorH, DESERT, params)
  return {
    index: 0,
    placementMap: 'synthetic',
    placements: {
      count: s.count,
      mapWidth: w,
      mapHeight: w,
      seed: 1,
      stride: PLACEMENT_STRIDE,
      data: encodeBase64(encodePlacements(s, params)),
    },
    probabilityScale: params.probabilityScale,
    heightOffset: 0,
    scaleMin: 1,
    scaleMax: 2,
    lodDistance: 1280,
    lodTransitionTime: 1,
    flipFlopPercent: 0.03,
    palette: [0, 1, 2].map(() => ({
      prefab: null,
      mesh: null,
      meshAsset: null,
      origin: 'test',
      licence: 'test',
      meshTransform: null,
    })),
  }
}

describe('DEV-489 — density: measured off the bake, re-run over the player ground', () => {
  // Low ground dense, high ground sparse, on a donor rising along u.
  const rule = (h: number): number => (h < 300 ? 0.8 : 0.1)
  const donorH = fnSampler((u) => [0.6 * u, 0.6 * u, 0.6 * u])
  const pass = bakedPass(rule, donorH)
  const donorGrid = groundGrid(
    donorH,
    DESERT.terrainSize,
    DESERT.terrainHeight,
    DESERT.baseResolution,
  )
  const bands = measureDensityBands(pass, donorGrid, DESERT)

  it('gives back the density the bake was drawn from, band by band', () => {
    const d = new Float32Array(1)
    readBandTable(bands, 150, 0.1, d)
    expect(d[0]).toBeGreaterThan(0.72)
    expect(d[0]).toBeLessThan(0.88)
    readBandTable(bands, 500, 0.1, d)
    expect(d[0]).toBeGreaterThan(0.05)
    expect(d[0]).toBeLessThan(0.15)
  })

  it('over the donor ground itself at the donor size, draws the donor number of props', () => {
    const same: CustomGround = {
      heights: {
        width: 1025,
        height: 1025,
        data: Float32Array.from({ length: 1025 * 1025 }, (_, i) => (0.6 * (i % 1025)) / 1024),
      },
      size: 4096,
      maxHeight: 1024,
      island: 'desert',
    }
    const custom = customScatterPass(pass, bands, same, customGroundGrid(same), DESERT.terrainSize)
    expect(custom.placements.count / pass.placements.count).toBeGreaterThan(0.93)
    expect(custom.placements.count / pass.placements.count).toBeLessThan(1.07)
  })

  it('keeps props per hectare when the player island is smaller, and the loader expands it', () => {
    // Half the side over the same kind of ground: a quarter of the props.
    const half: CustomGround = {
      heights: {
        width: 513,
        height: 513,
        data: Float32Array.from({ length: 513 * 513 }, (_, i) => (0.6 * (i % 513)) / 512),
      },
      size: 2048,
      maxHeight: 1024,
      island: 'desert',
    }
    const custom = customScatterPass(pass, bands, half, customGroundGrid(half), DESERT.terrainSize)
    const ratio = custom.placements.count / pass.placements.count
    expect(ratio).toBeGreaterThan(0.25 * 0.9)
    expect(ratio).toBeLessThan(0.25 * 1.1)
    // `load-props.ts` expands it exactly as it expands a baked pass.
    const expanded = expandPlacements(
      Uint8Array.from(atob(custom.placements.data), (c) => c.charCodeAt(0)),
      { width: custom.placements.mapWidth, height: custom.placements.mapHeight },
      customHeightSampler(half),
      { terrainSize: 2048, terrainHeight: 1024, chunkSize: DESERT.chunkSize },
      {
        probabilityScale: custom.probabilityScale,
        heightOffset: 0,
        scaleMin: 1,
        scaleMax: 2,
        paletteSize: 3,
        seed: custom.placements.seed,
      },
    )
    expect(expanded.count).toBe(custom.placements.count)
    for (let i = 0; i < expanded.count; i++) {
      expect(expanded.positions[i * 3] as number).toBeLessThanOrEqual(2048)
      expect(expanded.positions[i * 3 + 2] as number).toBeLessThanOrEqual(2048)
    }
  })

  it('drops the landmarks and the donor spawns, keeps the clearing radius and the 2016 receipt', () => {
    const env: EnvironmentProps = {
      id: 'desert',
      environmentScene: 'x',
      source: { kind: 'x', path: 'x' },
      spawnClearing: { radius: 51.97, source: 's', note: 'n', missions: [{ id: 'm', x: 1, z: 2 }] },
      scatter: [{ ...pass, shipped2016: { componentEnabled: true, bakedObjects: 9, note: 'n' } }],
      landmarks: [
        {
          name: 'spire',
          mesh: 'm',
          origin: 'o',
          licence: 'l',
          position: [0, 0, 0],
          rotation: null,
          scale: null,
        },
      ],
    }
    const g = flatGround(0.2)
    const out = customEnvironmentProps(env, donorGrid, g, customGroundGrid(g)).env
    expect(out.landmarks).toEqual([])
    expect(out.spawnClearing?.radius).toBe(51.97)
    expect(out.spawnClearing?.missions).toEqual([])
    expect(out.scatter[0]?.shipped2016?.bakedObjects).toBe(9)
    expect(out.scatter[0]?.placements.seed).toBe(pass.placements.seed)
  })
})

// ── The four real islands, where the gitignored maps are hydrated ─────────

const MAPS: Record<string, [string, string]> = {
  simonet: ['simonet/islandgroup-height.png', 'simonet/islandgroup-color.png'],
  kauai: ['kauai/kauai-height.png', 'kauai/kauai-color.png'],
  desert: ['desert/canyon_04-height.png', 'desert/canyon_04-color.png'],
  alpine: ['alpine/forest_02-height.png', 'alpine/forest_02-color.png'],
}

describe.skipIf(!haveMaps)('DEV-489 — every shipped island as a donor', () => {
  for (const island of Object.keys(MAPS)) {
    it(`${island}: its ramp predicts its own colour better than its mean colour does, and a cone wears it with a forest`, async () => {
      const [hp, cp] = MAPS[island] as [string, string]
      const read = (p: string) =>
        importUnityTexture(
          decodePngBuffer(fs.readFileSync(`public/assets/terrain/${p}`), p) as ImageData8,
        )
      const h = read(hp)
      const c = read(cp)
      const grain = terrainParams(donorLand(island).key)
      const grid = groundGrid(h, grain.terrainSize, grain.terrainHeight, grain.baseResolution)
      const ramp = buildColourRamp(grid, c, grain)
      // Self-consistency, against the thing it was measured from: over the
      // donor's own facets, the ramp's error is well under a flat mean's.
      const rgb = { r: 0, g: 0, b: 0 }
      const out = new Float32Array(3)
      const mean: [number, number, number] = [0, 0, 0]
      const n = grid.n
      const picks: number[] = []
      for (let k = 0; k < 4000; k++) picks.push((k * 7919) % (n * n))
      for (const i of picks) {
        c.sample((i % n) / (n - 1), Math.floor(i / n) / (n - 1), rgb)
        mean[0] += rgb.r / picks.length
        mean[1] += rgb.g / picks.length
        mean[2] += rgb.b / picks.length
      }
      let rampErr = 0
      let meanErr = 0
      for (const i of picks) {
        c.sample((i % n) / (n - 1), Math.floor(i / n) / (n - 1), rgb)
        readBandTable(ramp, grid.h[i] as number, grid.s[i] as number, out)
        rampErr +=
          Math.abs((out[0] as number) - rgb.r) +
          Math.abs((out[1] as number) - rgb.g) +
          Math.abs((out[2] as number) - rgb.b)
        meanErr +=
          Math.abs((mean[0] as number) - rgb.r) +
          Math.abs((mean[1] as number) - rgb.g) +
          Math.abs((mean[2] as number) - rgb.b)
      }
      expect(
        rampErr,
        `${island}: ramp ${rampErr.toFixed(1)} vs mean ${meanErr.toFixed(1)}`,
      ).toBeLessThan(0.9 * meanErr)

      const cone = coneIsland({
        island,
        size: grain.terrainSize,
        maxHeight: grain.terrainHeight,
        edge: 257,
        shore: 0.129,
        peak: 0.45,
      })
      const env = JSON.parse(
        fs.readFileSync(`content/environments/${island}.json`, 'utf8'),
      ) as EnvironmentProps
      const custom = customEnvironmentProps(env, grid, cone, customGroundGrid(cone)).env
      const total = custom.scatter.reduce((a, s) => a + s.placements.count, 0)
      expect(total, `${island}: a forest on the cone`).toBeGreaterThan(0)
      expect(custom.landmarks).toEqual([])
    }, 60_000)
  }
})

describe.skipIf(haveMaps)('DEV-489 — every shipped island as a donor (loud counterpart)', () => {
  it('skips only because the gitignored terrain maps are absent', () => {
    expect(haveMaps).toBe(false)
  })
})

describe('DEV-489 — the seams the front-ends call', () => {
  const int01 = loadLevelJson('int_01_hoverJet') as Level

  it('the line corridor is one capsule per leg, in the terrain mesh frame', () => {
    const c = courseCorridor(
      [
        { x: 100, z: 200 },
        { x: 300, z: 200 },
        { x: 300, z: 500 },
      ],
      52,
      [-2000, 0, 50],
    )
    expect(c).toEqual([
      { x: 2100, z: 150, x2: 2300, z2: 150, radius: 52 },
      { x: 2300, z: 150, x2: 2300, z2: 450, radius: 52 },
    ])
    expect(courseCorridor([{ x: 0, z: 0 }], 52, [0, 0, 0])).toEqual([])
    const two = [
      { x: 0, z: 0 },
      { x: 1, z: 1 },
    ]
    expect(courseCorridor(two, 0, [0, 0, 0])).toEqual([])
  })

  it('the preview door knows one ground, valid at its island size, and nothing else', () => {
    for (const island of ['simonet', 'kauai', 'desert', 'alpine']) {
      const g = previewIsland('cone', island)
      expect(g && customGroundProblems(g)).toEqual([])
      expect(g?.size).toBe(donorLand(island).entry.terrainSize)
    }
    expect(previewIsland('volcano', 'simonet')).toBeNull()
  })

  it('the door is shut on the release channel, and a lap flown through it is tainted', () => {
    expect(previewIslandDoor('release', 'cone', int01)).toBe(int01)
    expect(customGroundOf(previewIslandDoor('release', 'cone', int01))).toBeNull()
    expect(customGroundOf(previewIslandDoor('preview', 'cone', int01))?.island).toBe('simonet')
    expect(previewIslandDoor('preview', null, int01)).toBe(int01)
    expect(previewIslandDoor('preview', 'volcano', int01)).toBe(int01)
    // `island` is not a presentation switch (`game/run-taint.ts`'s allowlist).
    expect(urlTaint('?island=cone')).toEqual(['?island'])
  })

  it('a playtest over a grounded donor flies that ground, from the pad and from mid-line', () => {
    const cone = previewIsland('cone', 'simonet') as CustomGround
    const donor = withCustomGround(int01, cone)
    const course = fittedCourse(int01)
    expect(customGroundOf(playtestLevel(course, donor, null))).toBe(cone)
    expect(customGroundOf(playtestLevel(course, donor, 0.5))).toBe(cone)
    expect(customGroundOf(playtestLevel(course, int01, null))).toBeNull()
  })
})
