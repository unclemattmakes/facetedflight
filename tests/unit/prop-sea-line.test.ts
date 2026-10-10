/**
 * tests/unit/prop-sea-line.test.ts : nothing in the scatter stands in the sea. DEV-862.
 *
 * Matt, 2026-10-08: *"we have palm trees spawning below the water-line on
 * simonet and possibly kauai. make sure no trees are spawned below the wave
 * height + ocean surface."*
 *
 * ── The defect ───────────────────────────────────────────────────────────
 *
 * The scatter is baked from a density map and a STUB height map, so a
 * placement knows nothing about the sea. Of the 633 placements Simonet's
 * Anniversary forest keeps after the slope limit, 495 (364 palms, 131 bushes)
 * stood under the sea's high-water mark, most on the SEABED, down to 146 m
 * under it; Kauai had 257 of 677 (198 palms, 59 bushes), down to 56 m. Only Anniversary draws those passes (2016 ran neither:
 * `shipped2016.bakedObjects` is 0), so Classic had none to drown.
 *
 * ── What is tested, against what ─────────────────────────────────────────
 *
 * The list swept is `placeScatter`'s, which is exactly what `loadProps` builds
 * its meshes and colliders from, run in each look's own configuration (the
 * ground snap, slope limit and diagonal are Anniversary's; Classic has none of
 * them). The OTHER side is independent of the code under test: the sea's rest
 * surface is read from a height field built here in world (sim) coordinates by
 * `terrainOriginSim`, and the line from `highWaterOf`, the function that makes
 * `LoadedTerrain.highWater`; the mesh-frame conversion in `seaLineFor` is
 * what this proves, rather than restates.
 *
 *   1. MUST FIRE: with no sea line, the sweep finds drowned props on Simonet
 *      and Kauai in Anniversary. Without this every assertion below passes on
 *      a build that never asked where the sea is.
 *   2. With the line, no placement of any environment, in either look, has a
 *      base under rest + high water. And what was dropped is exactly what the
 *      sweep says drowned (a conservation law, not a count we typed).
 *   3. Land-locked environments lose nothing.
 *   4. The wiring: `build.ts` hands `loadProps` a sea line, and an ocean's absence is null.
 *
 * The maps are gitignored (R2), so every read is inside an `it`, with the loud
 * counterpart for the host that has none.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PropScatter } from '@/content/load-environment'
import { terrainOriginSim } from '@/game/mission-shape'
import { type LoadPropsOptions, placeScatter, shippedIn2016 } from '@/game/props/load-props'
import { seaLineFor } from '@/game/props/sea-line'
import { environmentTerrains, highWaterOf, terrainParams } from '@/game/terrain/load-terrain'
import { TERRAIN } from '@/generated/constants.generated'
import type { WaterDisplace } from '@/render/water'
import { withoutDrowned } from '@/sim/props/scatter'
import { buildVertexGrid, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import anniversary from '../../content/editions/anniversary.json'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { appSource } from './helpers/app-source'
import { environmentJson } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'
import { haveMaps, MAPS, OCEAN_MAPS } from './helpers/terrain-field'

const ENVIRONMENTS = ['simonet', 'kauai', 'desert', 'alpine'] as const
type Look = 'classic' | 'anniversary'
const LOOKS: readonly Look[] = ['classic', 'anniversary']

interface EnvJson {
  scatter: PropScatter[]
}

interface Sea {
  readonly field: HeightField
  readonly highWater: number
}

interface World {
  readonly land: HeightField
  readonly landOrigin: readonly number[]
  readonly sea: Sea | null
  readonly params: (look: Look) => FacetedTerrainParams
  readonly heightMap: ReturnType<typeof importUnityTexture>
}

const worlds = new Map<string, World>()

const worldFor = (env: string): World => {
  const hit = worlds.get(env)
  if (hit) return hit
  const t = environmentTerrains(env)
  const baseParams = terrainParams(t.land)
  const png = (rel: string, label: string): ReturnType<typeof importUnityTexture> =>
    importUnityTexture(decodePngBuffer(fs.readFileSync(path.join(ROOT, rel)), label) as ImageData8)
  const heightMap = png(MAPS[env] as string, env)
  const origin = terrainOriginSim(t.land, [0, 0, 0])
  const land = buildHeightField(heightMap, baseParams, origin)
  let sea: Sea | null = null
  if (t.ocean) {
    const oo = terrainOriginSim(t.ocean, [0, 0, 0])
    const field = buildHeightField(
      png(OCEAN_MAPS[env] as string, `${env}-ocean`),
      terrainParams(t.ocean),
      oo,
    )
    const displace = (TERRAIN as unknown as Record<string, { terrains: Record<string, unknown> }>)[
      env
    ]?.terrains.ocean as { displace: WaterDisplace }
    sea = { field, highWater: highWaterOf(displace.displace, oo.position) }
  }
  const w: World = {
    land,
    landOrigin: origin.position,
    sea,
    // Anniversary reads the fixed diagonal (DEV-831); Classic, 2016's.
    params: (look) =>
      look === 'anniversary' ? { ...baseParams, faithfulDiagonalBug: false } : baseParams,
    heightMap,
  }
  worlds.set(env, w)
  return w
}

/** The options `build.ts` hands `loadProps`, per look, minus the meshes. */
const optionsFor = (env: string, look: Look, withSeaLine: boolean): LoadPropsOptions => {
  const w = worldFor(env)
  const p = w.params(look)
  const props = (look === 'anniversary' ? anniversary : null)?.props
  return {
    terrain: { terrainSize: p.terrainSize, terrainHeight: p.terrainHeight, chunkSize: p.chunkSize },
    heightMap: w.heightMap,
    unbakedPasses: look === 'anniversary',
    groundSnap: props ? { params: p, sink: props.groundSnap.sink } : null,
    maxSlope: props ? { params: p, sin: props.maxSlope.sin } : null,
    seaLine: withSeaLine && w.sea ? seaLineFor(w.land, w.sea.field, w.sea.highWater) : null,
  }
}

interface Swept {
  readonly built: number
  readonly drowned: number
  readonly cleared: number
  /** Worst base-below-high-water, metres; 0 when nothing is under it. */
  readonly worst: number
  readonly byKind: Record<string, number>
}

/** Every pass of `env` in `look`, placed, and judged against the INDEPENDENT sea line. */
const sweep = (env: string, look: Look, withSeaLine: boolean): Swept => {
  const w = worldFor(env)
  const options = optionsFor(env, look, withSeaLine)
  const grid =
    options.groundSnap || options.maxSlope ? buildVertexGrid(w.heightMap, w.params(look)) : null
  const scatter = environmentJson<EnvJson>(env).scatter.filter(
    (s) => look === 'anniversary' || shippedIn2016(s),
  )
  let built = 0
  let drowned = 0
  let cleared = 0
  let worst = 0
  const byKind: Record<string, number> = {}
  for (const s of scatter) {
    const r = placeScatter(s, options, s.placements.seed, grid)
    cleared += r.clearedByWater
    built += r.placed.count
    for (let i = 0; i < r.placed.count; i++) {
      if (!w.sea) continue
      // WORLD (sim) coordinates, composed here and not by `seaLineFor`.
      const wx = (w.landOrigin[0] as number) + (r.placed.positions[i * 3] as number)
      const wy = (w.landOrigin[1] as number) + (r.placed.positions[i * 3 + 1] as number)
      const wz = (w.landOrigin[2] as number) + (r.placed.positions[i * 3 + 2] as number)
      const under = terrainHeightAt(w.sea.field, wx, wz) + w.sea.highWater - wy
      if (under > 0) {
        drowned++
        worst = Math.max(worst, under)
        const kind = s.palette[r.placed.palette[i] as number]?.kind ?? '?'
        byKind[kind] = (byKind[kind] ?? 0) + 1
      }
    }
  }
  return { built, drowned, cleared, worst, byKind }
}

describe.skipIf(!haveMaps)('DEV-862: the scatter stands clear of the sea', () => {
  it('MUST FIRE: with no sea line, Simonet and Kauai stand props under the water in Anniversary', () => {
    for (const env of ['simonet', 'kauai']) {
      const s = sweep(env, 'anniversary', false)
      expect(s.drowned, `${env}: the premise of DEV-862`).toBeGreaterThan(100)
      expect(s.byKind.palm ?? 0, `${env}: palms are what Matt saw`).toBeGreaterThan(0)
      expect(s.worst, `${env}: some stand on the seabed, not at the waterline`).toBeGreaterThan(20)
    }
  })

  for (const env of ENVIRONMENTS) {
    for (const look of LOOKS) {
      it(`${env} / ${look}: no base under the sea's rest surface plus its high-water mark`, () => {
        const s = sweep(env, look, true)
        expect(s.drowned, `${JSON.stringify(s)}`).toBe(0)
      })
    }
  }

  it('what the line dropped is exactly what the unfiltered sweep found drowned', () => {
    for (const env of ['simonet', 'kauai']) {
      const before = sweep(env, 'anniversary', false)
      const after = sweep(env, 'anniversary', true)
      expect(after.cleared, `${env}: the receipt`).toBe(before.drowned)
      expect(after.built + after.cleared, `${env}: nothing else left`).toBe(before.built)
    }
  })

  it('a land-locked environment loses nothing, and Classic keeps what 2016 ran', () => {
    for (const env of ['desert', 'alpine']) {
      for (const look of LOOKS) {
        expect(sweep(env, look, true).cleared, `${env}/${look}`).toBe(0)
      }
    }
  })

  it('the line is a high-water mark, not the rest surface', () => {
    const w = worldFor('simonet')
    const sea = w.sea as Sea
    expect(sea.highWater, 'Simonet: bob 3.459 + wave 4').toBeGreaterThan(7)
    const line = seaLineFor(w.land, sea.field, sea.highWater)
    const rest =
      terrainHeightAt(sea.field, w.landOrigin[0] as number, w.landOrigin[2] as number) -
      (w.landOrigin[1] as number)
    expect(line(0, 0) - rest).toBeCloseTo(sea.highWater, 6)
  })
})

describe.skipIf(haveMaps)('DEV-862 loud counterpart', () => {
  it('this host has no terrain maps, so the sweep above did not run', () => {
    expect(haveMaps).toBe(false)
  })
})

describe('DEV-862: the pieces, on a synthetic scatter (no assets)', () => {
  const props = (ys: number[]) => ({
    count: ys.length,
    positions: Float32Array.from(ys.flatMap((y, i) => [i, y, 0])),
    yaw: new Float32Array(ys.length),
    scale: new Float32Array(ys.length).fill(1),
    palette: new Uint8Array(ys.length),
    chunk: new Uint16Array(ys.length),
    chunkPerSide: 1,
    texel: new Uint16Array(ys.length * 2),
  })

  it('drops under the line, keeps on it and over it, and survivors are untouched', () => {
    const p = props([9.99, 10, 10.01, -50])
    // biome-ignore lint/suspicious/noExplicitAny: the shape is ScatteredProps; the helper above is minimal
    const r = withoutDrowned(p as any, () => 10)
    expect(r.removed).toBe(2)
    expect(Array.from(r.props.positions).map((v) => Math.round(v * 100) / 100)).toEqual([
      1, 10, 0, 2, 10.01, 0,
    ])
  })

  it('build.ts hands loadProps a sea line, null where there is no ocean', () => {
    const src = appSource()
    expect(src).toMatch(
      /seaLine:\s*ocean\s*\?\s*seaLineFor\(terrain\.heightField, ocean\.heightField, ocean\.highWater\)\s*:\s*null/,
    )
  })
})
