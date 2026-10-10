// tests/unit/terrain-vertex-colour.test.ts — what colour space the island is in,
// settled by the shipped bytes rather than by reasoning about Unity.
//
// ── The question ──────────────────────────────────────────────────────────
//
// `FacetedTerrain.cs:832` samples an sRGB PNG with `GetPixelBilinear` and writes the result into
// `mesh.colors`. The project is in Linear colour space (`m_ActiveColorSpace: 1`). So did the
// number that reached the shader get decoded to linear, or not?
//
// It matters more than a colour-space question usually does, because the terrain has no texture:
// the vertex colour IS the albedo of every facet in the world. Decode it and the island is darker
// and more saturated; leave it and the island is brighter and flatter. Matt's note on the 2016
// screenshots was that ours had lost the "softer colors", and this is half of the answer (the
// other half is the Skyshop ambient — `skyshop-ibl.test.ts`).
//
// ── Why this is a test and not a comment ──────────────────────────────────
//
// Because the 2016 bake stores its vertex colours, so the question has a factual answer sitting
// on disk, and "Unity does not gamma-correct vertex colour streams" is exactly the sort of
// received wisdom that is right until it is not. The bake is the oracle; this asks it.
//
// The skip is LOUD — a test that passes because its input is missing is worse than no test.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import { chunkGeometry } from '@/render/terrain-mesh'
import { buildVertexGrid, type FacetedTerrainParams, generateChunk } from '@/sim/terrain/faceted'
import { importUnityTexture } from '@/sim/terrain/image-sampler'
import { legacyRootOrAbsent } from '../../tools/legacy-root.mjs'
import { decodePng } from '../../tools/terrain/png.mjs'

const LEGACY = legacyRootOrAbsent()
const ORACLE_DIR = 'tools/terrain/.oracle'

const ISLANDS = TERRAIN.simonet.terrains.islands
const SIMONET: FacetedTerrainParams = {
  terrainSize: ISLANDS.terrainSize,
  terrainHeight: ISLANDS.terrainHeight,
  chunkSize: ISLANDS.chunkSize,
  baseResolution: ISLANDS.baseResolution,
  randomOffset: ISLANDS.randomOffset,
  seed: 20160101,
}

/** The sRGB electro-optical transfer function — the decode that must NOT be applied. */
const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

interface Dump {
  chunk: number[]
  colors: number[][] | null
}

const dumps = (): { name: string; cx: number; cz: number; dump: Dump }[] => {
  if (!fs.existsSync(ORACLE_DIR)) return []
  const out: { name: string; cx: number; cz: number; dump: Dump }[] = []
  for (const f of fs.readdirSync(ORACLE_DIR).sort()) {
    const m = /_x(\d+)_y(\d+)_lod0\.json$/.exec(f)
    if (!m) continue
    const dump = JSON.parse(fs.readFileSync(path.join(ORACLE_DIR, f), 'utf8')) as Dump
    if (!dump.colors) continue
    out.push({ name: f, cx: Number(m[1]), cz: Number(m[2]), dump })
  }
  return out
}

const heightMapFile = path.join(LEGACY, ISLANDS.sourceHeightMap)
const available = fs.existsSync(heightMapFile) && dumps().length > 0

/**
 * Vitest's default is 5 s, and these cases decode two 1025x1025 PNGs and then
 * generate up to ten 6,936-vertex chunks each. That fits comfortably on an idle
 * machine and does NOT fit on a busy one — it timed out first on a box that was
 * also running a dev server and a second agent's test suite.
 *
 * A test that passes or fails depending on what else is running is worse than a
 * slow one, so the budget is stated rather than inherited.
 */
const SLOW = { timeout: 60_000 }

describe.skipIf(!available)('the 2016 bake says which colour space the island is in', SLOW, () => {
  const build = () => {
    const height = importUnityTexture(decodePng(heightMapFile))
    const color = importUnityTexture(decodePng(path.join(LEGACY, ISLANDS.sourceColorMap)))
    return { color, height, grid: buildVertexGrid(height, SIMONET) }
  }

  it('reproduces the baked colours EXACTLY where the map is flat', () => {
    // Chunks (0,0) and (8,8) are open sea: one colour over the whole chunk, so the vertex jitter
    // cannot move the sample onto a different texel and there is no excuse left. If the generator
    // and the bake disagree here at all, they disagree about the colour space.
    const { color, height, grid } = build()
    let checked = 0
    for (const { cx, cz, dump } of dumps()) {
      const oracle = dump.colors as number[][]
      const gen = generateChunk(grid, color, height, SIMONET, cx, cz, 0)
      // 1e-6, not 0: the bake stores colour as a packed byte stream and UnityPy's unpack lands a
      // float ULP either side of it, so "the same colour" is the same to seven decimals and no
      // further. That tolerance is still four orders of magnitude tighter than the 0.105 an sRGB
      // decode would cost.
      const flat = oracle.every(
        (c) => Math.abs((c[0] as number) - (oracle[0]?.[0] as number)) < 1e-6,
      )
      if (!flat) continue
      checked++
      for (let i = 0; i < oracle.length; i++) {
        for (let k = 0; k < 3; k++) {
          expect(gen.colors[i * 3 + k] as number).toBeCloseTo(
            (oracle[i] as number[])[k] as number,
            6,
          )
        }
      }
    }
    // Two open-sea chunks are dumped. If a future sweep drops them this test must fail, not pass
    // by checking nothing.
    expect(checked).toBeGreaterThanOrEqual(2)
  })

  it('is 17x closer raw than decoded, across every dumped chunk', () => {
    // The whole-grid version of the same question. The residue on inland chunks is the vertex
    // jitter: `insideUnitSphere * randomOffset` moves the sample point, our RNG is not Unity's,
    // and near a colour edge that lands on a different texel (DEV-006). It is bounded and small.
    // A wrong colour space is neither.
    const { color, height, grid } = build()
    let rawSum = 0
    let linSum = 0
    let n = 0
    for (const { cx, cz, dump } of dumps()) {
      const oracle = dump.colors as number[][]
      const gen = generateChunk(grid, color, height, SIMONET, cx, cz, 0)
      for (let i = 0; i < oracle.length; i++) {
        for (let k = 0; k < 3; k++) {
          const mine = gen.colors[i * 3 + k] as number
          const theirs = (oracle[i] as number[])[k] as number
          rawSum += Math.abs(mine - theirs)
          linSum += Math.abs(srgbToLinear(mine) - theirs)
          n++
        }
      }
    }
    const raw = rawSum / n
    const decoded = linSum / n
    expect(raw).toBeLessThan(0.02)
    expect(decoded / raw).toBeGreaterThan(10)
  })

  it('carries that answer through to the geometry the renderer uploads', () => {
    // The decision only counts if `chunkGeometry` respects it. This is the seam where a
    // well-meaning sRGB decode would come back: the sim's output is compared against the bake, the
    // render layer's is not, so a conversion added here would be invisible to every other test.
    const { color, height, grid } = build()
    const first = dumps()[0]
    if (!first) throw new Error('no dumped chunk')
    const chunk = generateChunk(grid, color, height, SIMONET, first.cx, first.cz, 0)
    const before = Array.from(chunk.colors.slice(0, 3))
    const geometry = chunkGeometry(chunk)
    const attribute = geometry.getAttribute('color')
    // `chunkGeometry` reorders the triangle winding, so a specific index is not comparable — the
    // SET of values is. Every colour on the geometry must be one the sim produced, untouched.
    const produced = new Set(Array.from(chunk.colors).map((v) => v.toFixed(7)))
    for (let i = 0; i < attribute.count * 3; i++) {
      expect(produced.has((attribute.array[i] as number).toFixed(7))).toBe(true)
    }
    // And it must NOT be the decoded value, which for anything but 0 and 1 is a different number.
    const bright = before.find((v) => v > 0.05 && v < 0.95)
    if (bright !== undefined) {
      expect(produced.has(srgbToLinear(bright).toFixed(7))).toBe(false)
    }
    geometry.dispose()
  })
})

describe.skipIf(available)('terrain vertex colour — oracle not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(available).toBe(false)
  })
})
