/**
 * tests/unit/prop-slope.test.ts — no 2016-scatter prop on a steep facet. DEV-356.
 *
 * Matt, 2026-09-24: *"don't place props on steep slopes."* `props.maxSlope`
 * drops, at load, every scatter placement whose RENDERED facet is steeper than
 * a sine, before the snap, the chunk layout and the colliders are derived — so
 * the prop is neither drawn nor solid.
 *
 * ── What is tested here, and against what ────────────────────────────────
 *
 *   1. `renderSurfaceSlopeAt` against the MESH: `generateChunk`'s own flat
 *      normal on the triangle whose plan covers the point, found by brute
 *      force. That is the normal the facet is LIT with, so "the slope under a
 *      prop" is the slope you can see. The height map's own slope is shown to
 *      DISAGREE with it on relief — the DEV-288 trap — or a build that asked
 *      the map would pass the same test.
 *   2. `withoutSteep` as a SUBTRACTION: on the limit stays, over it goes, and
 *      every survivor is bit-identical to what it was.
 *   3. The two composed over a synthetic relief, both ways: some go, some stay,
 *      and the line between them is the limit.
 *   4. The presets: on in Anniversary at the value the e2e fixture was pinned
 *      at, off in Classic.
 *   5. The shipped terrains (gitignored maps, so guarded, with its loud
 *      counterpart): the per-environment counts the ledger row quotes, and the
 *      alpine pair `spawn-clearing.spec.ts` holds the browser to.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PropScatter } from '@/content/load-environment'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { slopeAt } from '@/sim/props/dressing'
import { decodeBase64, expandPlacements } from '@/sim/props/placements'
import { type ScatteredProps, withoutSteep } from '@/sim/props/scatter'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import { type ImageData8, importUnityTexture, type Rgb } from '@/sim/terrain/image-sampler'
import { renderSurfaceSlopeAt } from '@/sim/terrain/surface'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import {
  SLOPE_CLEARS,
  SLOPE_CLEARS_ENVIRONMENT,
  SLOPE_CLEARS_SIN,
} from '../e2e/fixtures/slope-clears'
import { REPO as ROOT } from './helpers/repo-root'
import { lcg } from './helpers/seeded'
import { haveMaps, MAPS } from './helpers/terrain-field'

// ── a synthetic world with real relief ────────────────────────────────────

/**
 * High relief, off-axis, so the diagonal choice flips quad to quad and slopes
 * run the whole range from flat to a wall. A flat map would make the facet and
 * the map agree and every "which surface" assertion below would pass for the
 * wrong reason.
 */
const relief = (u: number, v: number): number =>
  0.5 + 0.25 * Math.sin(u * 23.1 + 1.3) * Math.cos(v * 17.7 - 0.4) + 0.15 * Math.sin((u + v) * 41)

const map = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 128,
    height: 128,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, f(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS: FacetedTerrainParams = {
  terrainSize: 512,
  terrainHeight: 200,
  chunkSize: 128,
  baseResolution: 8,
  // Simonet's jitter, the largest shipped: the facets move the most.
  randomOffset: 1.3,
  seed: 20160101,
}

const HEIGHT = map(relief)
const GRID = buildVertexGrid(HEIGHT, PARAMS)

/**
 * The MESH's own answer: `sin` of the tilt of the emitted triangle whose plan
 * covers (x, z), off the flat normal `generateChunk` shades it with. Null where
 * no interior face covers the point.
 */
const meshSlopeAt = (
  chunk: { positions: Float32Array; normals: Float32Array },
  x: number,
  z: number,
): number | null => {
  const p = chunk.positions
  for (let t = 0; t < p.length; t += 9) {
    const ax = p[t] as number
    const ay = p[t + 1] as number
    const az = p[t + 2] as number
    const bx = p[t + 3] as number
    const by = p[t + 4] as number
    const bz = p[t + 5] as number
    const cx = p[t + 6] as number
    const cy = p[t + 7] as number
    const cz = p[t + 8] as number
    // Skirt walls are degenerate in plan and pinned to y = 0; never the answer.
    if (ay === 0 && by === 0 && cy === 0) continue
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
    if (Math.abs(det) < 1e-9) continue
    const wb = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det
    const wc = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det
    const wa = 1 - wb - wc
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue
    return Math.hypot(chunk.normals[t] as number, chunk.normals[t + 2] as number)
  }
  return null
}

describe('DEV-356: the slope under a prop is the slope of the facet you SEE', () => {
  it('renderSurfaceSlopeAt is the tilt of the triangle generateChunk draws and lights there', () => {
    const rnd = lcg(29)
    const chunk = generateChunk(
      GRID,
      map(() => 0.5),
      HEIGHT,
      PARAMS,
      1,
      2,
      0,
    )
    let checked = 0
    let steep = 0
    let worst = 0
    for (let i = 0; i < 400; i++) {
      // Inside chunk (1,2), a cell in from its edge so no skirt is in play.
      const x = 128 + 8 + rnd() * (128 - 16)
      const z = 256 + 8 + rnd() * (128 - 16)
      const truth = meshSlopeAt(chunk, x, z)
      if (truth === null) continue
      const got = renderSurfaceSlopeAt(GRID, HEIGHT, PARAMS, x, z)
      worst = Math.max(worst, Math.abs(got - truth))
      if (truth > 0.7) steep++
      checked++
    }
    expect(checked).toBeGreaterThan(350)
    // The sample has to contain steep ground or it cannot see this row's case.
    expect(steep, 'facets steeper than 0.7 in the sample').toBeGreaterThan(20)
    expect(worst).toBeLessThan(1e-4)
  })

  it('MUST-FIRE: the height map’s own slope is NOT that number on relief (DEV-288)', () => {
    // Without this, a filter that asked the dressing's `slopeAt` — the 4 m
    // bilinear map, differenced over one grid step — would be indistinguishable
    // here from one that asks the facet, and the trap CLAUDE.md names would be
    // live under a green suite.
    const rnd = lcg(31)
    const terrain = {
      terrainSize: PARAMS.terrainSize,
      terrainHeight: PARAMS.terrainHeight,
      step: PARAMS.baseResolution,
      originX: 0,
      originY: 0,
      originZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    }
    let far = 0
    const n = 400
    for (let i = 0; i < n; i++) {
      const x = 16 + rnd() * (PARAMS.terrainSize - 32)
      const z = 16 + rnd() * (PARAMS.terrainSize - 32)
      const facet = renderSurfaceSlopeAt(GRID, HEIGHT, PARAMS, x, z)
      const smooth = slopeAt(HEIGHT, terrain, x, z)
      if (Math.abs(facet - smooth) > 0.1) far++
    }
    expect(far / n, 'a real share differ by more than 0.1 in sine').toBeGreaterThan(0.1)
  })
})

// ── the subtraction ───────────────────────────────────────────────────────

/** A pass whose placement `i` stands at x = i, so a slope can be keyed on x. */
const passOf = (n: number): ScatteredProps => {
  const positions = new Float32Array(n * 3)
  const yaw = new Float32Array(n)
  const scale = new Float32Array(n)
  const palette = new Uint8Array(n)
  const chunk = new Uint16Array(n)
  const texel = new Uint16Array(n * 2)
  for (let i = 0; i < n; i++) {
    positions[i * 3] = i
    positions[i * 3 + 1] = 100 + i * 0.25
    positions[i * 3 + 2] = 7 * i
    yaw[i] = 0.1 * (i + 1)
    scale[i] = 1 + i
    palette[i] = i % 3
    chunk[i] = 10 + i
    texel[i * 2] = 2 * i
    texel[i * 2 + 1] = 2 * i + 1
  }
  return { count: n, positions, yaw, scale, palette, chunk, texel, chunkPerSide: 4 }
}

describe('DEV-356: withoutSteep subtracts and moves nothing', () => {
  it('over the limit goes, ON the limit stays, and every survivor is bit-identical', () => {
    const props = passOf(5)
    const slopes = [0.1, 0.5, 0.51, 0.9, 0.2]
    const { props: kept, removed } = withoutSteep(props, 0.5, (x) => slopes[x] as number)
    expect(removed).toBe(2)
    expect(kept.count).toBe(3)
    for (const [k, i] of [
      [0, 0],
      [1, 1],
      [2, 4],
    ] as const) {
      expect(kept.positions[k * 3], `survivor ${k} x`).toBe(props.positions[i * 3])
      expect(kept.positions[k * 3 + 1], `survivor ${k} y`).toBe(props.positions[i * 3 + 1])
      expect(kept.positions[k * 3 + 2], `survivor ${k} z`).toBe(props.positions[i * 3 + 2])
      expect(kept.yaw[k], `survivor ${k} yaw`).toBe(props.yaw[i])
      expect(kept.scale[k], `survivor ${k} scale`).toBe(props.scale[i])
      expect(kept.palette[k], `survivor ${k} palette`).toBe(props.palette[i])
      expect(kept.chunk[k], `survivor ${k} chunk`).toBe(props.chunk[i])
      expect(kept.texel[k * 2], `survivor ${k} texel x`).toBe(props.texel[i * 2])
      expect(kept.texel[k * 2 + 1], `survivor ${k} texel y`).toBe(props.texel[i * 2 + 1])
    }
    expect(kept.chunkPerSide).toBe(props.chunkPerSide)
  })

  it('asks the slope at each placement’s OWN (x, z), in the frame positions are in', () => {
    const props = passOf(4)
    const asked: string[] = []
    withoutSteep(props, 1, (x, z) => {
      asked.push(`${x},${z}`)
      return 0
    })
    expect(asked).toEqual(['0,0', '1,7', '2,14', '3,21'])
  })

  it('hands back the SAME object when nothing is too steep', () => {
    const props = passOf(3)
    expect(withoutSteep(props, 0.7, () => 0.2).props).toBe(props)
    expect(withoutSteep(props, 0.7, () => 0.7).removed).toBe(0)
  })
})

describe('DEV-356: composed over relief, the limit is the line between kept and cleared', () => {
  it('every survivor stands on a facet at or under the limit, every cleared one over it, and both sets are real', () => {
    const rnd = lcg(37)
    const n = 2000
    const props = passOf(n)
    for (let i = 0; i < n; i++) {
      props.positions[i * 3] = 8 + rnd() * (PARAMS.terrainSize - 16)
      props.positions[i * 3 + 2] = 8 + rnd() * (PARAMS.terrainSize - 16)
    }
    const limit = 0.7
    const facet = (x: number, z: number): number => renderSurfaceSlopeAt(GRID, HEIGHT, PARAMS, x, z)
    const { props: kept, removed } = withoutSteep(props, limit, facet)

    expect(removed, 'something was steep enough to go').toBeGreaterThan(n * 0.05)
    expect(kept.count, 'and something was gentle enough to stay').toBeGreaterThan(n * 0.05)
    expect(kept.count + removed).toBe(n)
    let over = 0
    for (let k = 0; k < kept.count; k++) {
      if (facet(kept.positions[k * 3] as number, kept.positions[k * 3 + 2] as number) > limit)
        over++
    }
    expect(over, 'a survivor stands on a facet over the limit').toBe(0)
    // And the cleared set is exactly the steep one: counted independently.
    let steep = 0
    for (let i = 0; i < n; i++) {
      if (facet(props.positions[i * 3] as number, props.positions[i * 3 + 2] as number) > limit)
        steep++
    }
    expect(removed).toBe(steep)
  })
})

// ── the presets ───────────────────────────────────────────────────────────

describe('DEV-356: the presets', () => {
  it('Anniversary leaves steep ground bare at the limit the e2e fixture was pinned at', () => {
    expect(anniversary.props.maxSlope.enabled).toBe(true)
    // Edit this and `tests/e2e/fixtures/slope-clears.ts` together, on purpose.
    expect(anniversary.props.maxSlope.sin).toBe(SLOPE_CLEARS_SIN)
  })

  it('Classic keeps 2016’s forest: 2016’s generator had no slope rule', () => {
    expect(classic.props.maxSlope.enabled).toBe(false)
  })
})

// ── the shipped terrains ──────────────────────────────────────────────────

interface EnvJson {
  scatter: PropScatter[]
}

/** Placements per pass on a facet steeper than `sin`, keyed `<env>:<index>`. */
const clearsOn = (
  environment: string,
  sin: number,
): Record<string, { n: number; cleared: number }> => {
  const env = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content', 'environments', `${environment}.json`), 'utf8'),
  ) as EnvJson
  // DEV-831: the slope limit is Anniversary's, so it reads Anniversary's facets,
  // which take the fixed diagonal when its `terrain.diagonalFix` is on.
  const params = {
    ...terrainParams(environmentTerrains(environment).land),
    faithfulDiagonalBug: !anniversary.terrain.diagonalFix.enabled,
  }
  const img = decodePngBuffer(
    fs.readFileSync(path.join(ROOT, MAPS[environment] as string)),
    environment,
  ) as ImageData8
  const heightMap = importUnityTexture(img)
  const grid = buildVertexGrid(heightMap, params)
  const out: Record<string, { n: number; cleared: number }> = {}
  for (const s of env.scatter) {
    const placed = expandPlacements(
      decodeBase64(s.placements.data),
      { width: s.placements.mapWidth, height: s.placements.mapHeight },
      heightMap,
      {
        terrainSize: params.terrainSize,
        terrainHeight: params.terrainHeight,
        chunkSize: params.chunkSize,
      },
      {
        probabilityScale: s.probabilityScale,
        heightOffset: s.heightOffset,
        scaleMin: s.scaleMin,
        scaleMax: s.scaleMax,
        paletteSize: s.palette.length,
        seed: s.placements.seed,
      },
    )
    const { removed } = withoutSteep(placed, sin, (x, z) =>
      renderSurfaceSlopeAt(grid, heightMap, params, x, z),
    )
    out[`${environment}:${s.index}`] = { n: placed.count, cleared: removed }
  }
  return out
}

describe.skipIf(!haveMaps)('DEV-356: on the shipped terrains', () => {
  it('pins the alpine pair the browser is held to, and prints every environment for the ledger', () => {
    const sin = anniversary.props.maxSlope.sin
    const lines: string[] = []
    for (const environment of ['simonet', 'kauai', 'desert', 'alpine']) {
      const counts = clearsOn(environment, sin)
      for (const [key, c] of Object.entries(counts)) {
        lines.push(
          `  ${key.padEnd(10)} ${String(c.cleared).padStart(5)} of ${String(c.n).padStart(5)} ` +
            `(${((100 * c.cleared) / c.n).toFixed(1)} %)`,
        )
        // Some ground in every shipped environment is steeper than 44 degrees,
        // and none of them is ALL cliff: a limit that cleared nothing or
        // everything would be a limit read against the wrong thing.
        expect(c.cleared, `${key}: something stood on steep ground`).toBeGreaterThan(0)
        expect(c.cleared, `${key}: and not everything did`).toBeLessThan(c.n)
      }
      if (environment === SLOPE_CLEARS_ENVIRONMENT) {
        for (const [key, pinned] of Object.entries(SLOPE_CLEARS)) {
          expect(counts[key]?.cleared, `${key}: the fixture the e2e census is held to`).toBe(pinned)
        }
      }
    }
    console.log(
      `DEV-356 props.maxSlope ${sin}: scatter placements on a steeper rendered facet\n${lines.join('\n')}`,
    )
  })
})

describe.skipIf(haveMaps)('DEV-356: on the shipped terrains (loud counterpart)', () => {
  it('says so when the gitignored height maps are absent, rather than passing silently', () => {
    expect(haveMaps, 'the shipped-terrain pins are skipped: no height maps here').toBe(false)
  })
})
