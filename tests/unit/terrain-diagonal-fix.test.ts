// tests/unit/terrain-diagonal-fix.test.ts: Anniversary's terrain takes the
// fixed diagonal, Classic keeps 2016's. DEV-831 (Matt, 2026-10-08).
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { validateEdition } from '@/content/edition-schema'
import { buildVertexGrid, type FacetedTerrainParams, generateChunk } from '@/sim/terrain/faceted'
import { createGreySampler } from '@/sim/terrain/image-sampler'
import { ISLAND_SYNTH_VERSION, synthesiseIsland } from '@/sim/terrain/island-synth'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

describe('DEV-831: the terrain diagonal by edition', () => {
  it('Anniversary takes the fixed diagonal; Classic keeps 2016’s', () => {
    expect(validateEdition(anniversary as unknown as Edition).terrain.diagonalFix.enabled).toBe(
      true,
    )
    expect(validateEdition(classic as unknown as Edition).terrain.diagonalFix.enabled).toBe(false)
  })

  it('the mission land, the sea and the title valley all pass the edition’s switch to loadTerrain', () => {
    const build = fs.readFileSync('src/boot/app/world/build.ts', 'utf8')
    const title = fs.readFileSync('src/boot/app/title/world.ts', 'utf8')
    const pass = 'fixDiagonal: editionState.current.terrain.diagonalFix.enabled'
    expect(build.split(pass).length - 1).toBe(2)
    expect(title).toContain(pass)
  })

  it('loadTerrain applies it before the vertex grid is built, on every path', () => {
    const src = fs.readFileSync('src/game/terrain/load-terrain.ts', 'utf8')
    const set = src.indexOf(
      'if (options.fixDiagonal) params = { ...params, faithfulDiagonalBug: false }',
    )
    expect(set).toBeGreaterThan(0)
    expect(set).toBeLessThan(src.indexOf('const grid = buildVertexGrid(height, params)'))
    expect(set).toBeGreaterThan(src.indexOf('params = customTerrainParams('))
  })

  it('with the switch on, the generator splits quads differently (a high-relief island)', () => {
    const edge = 129
    const e = synthesiseIsland(
      5,
      { size: 1024, height: 300, rugged: 0.8, sea: 0.3 },
      edge,
      ISLAND_SYNTH_VERSION,
    )
    const data = new Float32Array(e.length)
    for (let i = 0; i < e.length; i++) data[i] = Math.max(0, e[i] as number)
    const map = createGreySampler({ width: edge, height: edge, data })
    const base: FacetedTerrainParams = {
      terrainSize: 1024,
      terrainHeight: 300,
      chunkSize: 256,
      baseResolution: 8,
      randomOffset: 0.8,
      seed: 1,
    }
    const faithful = generateChunk(buildVertexGrid(map, base), map, map, base, 1, 1)
    const fixedParams = { ...base, faithfulDiagonalBug: false }
    const fixed = generateChunk(buildVertexGrid(map, fixedParams), map, map, fixedParams, 1, 1)
    expect(fixed.triangleCount).toBe(faithful.triangleCount)
    let differ = 0
    for (let i = 0; i < fixed.positions.length; i++)
      if (fixed.positions[i] !== faithful.positions[i]) differ++
    expect(differ).toBeGreaterThan(0)
  })
})
