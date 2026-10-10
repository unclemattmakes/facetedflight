// tests/unit/holo-palette.test.ts — the tables' palettes are the terrain's
// colour maps, cut small, and nothing else (DEV-140).
//
// Three claims. The committed palettes are well-formed and were cut from the
// bytes the asset manifest names (provenance, checkable with no PNG on disk).
// Every environment the levels use has one, so a table never falls back to
// the cyan ramp for a shipped course. And — guarded on the maps — a palette's
// mean colour is the full colour map's mean colour to within a couple of
// levels, which is the one relationship a thumbnail must keep and the one a
// wrong (u, v) convention, a dropped channel or a bad stride would break.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePalette, paletteDocs, paletteFor } from '@/content/holo-palette'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { loadLevelJson, MISSIONS } from './helpers/terrain-field'

const manifest = JSON.parse(fs.readFileSync('tools/assets/required-assets.json', 'utf8')) as {
  assets: { id: string; path: string; sha256: string }[]
}
const colourAssets = manifest.assets.filter((a) => /^terrain\.[a-z]+\.color$/.test(a.id))
const havePngs = colourAssets.every((a) => fs.existsSync(path.join('public', a.path)))

describe('the committed palettes', () => {
  it('are one per colour map in the manifest, and decode to their headers', () => {
    const docs = paletteDocs()
    expect([...docs.keys()].sort()).toEqual(colourAssets.map((a) => a.id.split('.')[1]).sort())
    for (const doc of docs.values()) {
      expect(doc.width).toBe(64)
      expect(doc.height).toBe(64)
      expect(doc.channels).toBe(3)
      const img = decodePalette(doc)
      expect(img.data.length).toBe(64 * 64 * 3)
    }
  })

  it('were cut from the bytes the manifest names — path and sha256', () => {
    for (const doc of paletteDocs().values()) {
      const asset = colourAssets.find((a) => a.id === doc.source.id)
      expect(asset, `${doc.environment}'s source is in the manifest`).toBeDefined()
      expect(doc.source.path).toBe(asset?.path)
      expect(doc.source.sha256).toBe(asset?.sha256)
    }
  })

  it('cover every environment a shipped mission uses', () => {
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      expect(paletteFor(level.environment), `${id} (${level.environment})`).not.toBeNull()
    }
    expect(paletteFor('nowhere')).toBeNull()
  })

  it('sample in range, and are not one flat colour', () => {
    const p = paletteFor('simonet')
    expect(p).not.toBeNull()
    const out = { r: 0, g: 0, b: 0 }
    const seen = new Set<string>()
    for (let v = 0.05; v < 1; v += 0.1) {
      for (let u = 0.05; u < 1; u += 0.1) {
        p?.sample(u, v, out)
        for (const c of [out.r, out.g, out.b]) {
          expect(c).toBeGreaterThanOrEqual(0)
          expect(c).toBeLessThanOrEqual(1)
        }
        seen.add(`${out.r.toFixed(2)},${out.g.toFixed(2)},${out.b.toFixed(2)}`)
      }
    }
    expect(seen.size).toBeGreaterThan(10)
  })
})

describe.skipIf(!havePngs)('against the full colour maps', () => {
  it('keep the mean colour of the map they were cut from, to two levels', () => {
    for (const asset of colourAssets) {
      const env = asset.id.split('.')[1] as string
      const img = decodePngBuffer(fs.readFileSync(path.join('public', asset.path)), env)
      const mean = [0, 0, 0]
      const n = img.width * img.height
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) {
          mean[c] = (mean[c] as number) + (img.data[i * img.channels + c] as number)
        }
      }
      const doc = paletteDocs().get(env)
      expect(doc).toBeDefined()
      const small = decodePalette(doc as NonNullable<typeof doc>)
      const smallMean = [0, 0, 0]
      for (let i = 0; i < 64 * 64; i++) {
        for (let c = 0; c < 3; c++)
          smallMean[c] = (smallMean[c] as number) + (small.data[i * 3 + c] as number)
      }
      for (let c = 0; c < 3; c++) {
        const big = (mean[c] as number) / n
        const little = (smallMean[c] as number) / (64 * 64)
        expect(
          Math.abs(big - little),
          `${env} channel ${c}: map ${big.toFixed(1)} vs palette ${little.toFixed(1)}`,
        ).toBeLessThan(2.5)
      }
    }
  }, 60_000)
})

describe.skipIf(havePngs)('the colour maps are not on disk', () => {
  it('so the mean-colour check above was SKIPPED, not passed', () => {
    expect(havePngs).toBe(false)
  })
})
