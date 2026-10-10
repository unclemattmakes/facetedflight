// tests/unit/share-card.test.ts: the designed link-preview card is composed, not
// committed. DEV-657. `tools/dev/share-card.mjs` says what goes into it.

import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { UI_ACCENT, UI_INK, UI_PLATE } from '@/render/ui-tokens'
import { appIcon, encodePng, parseIconSvg, shareCardPng } from '../../tools/dev/app-icon.mjs'
import {
  composeShareCard,
  loadStill,
  readLayout,
  SHARE_STILL_ASSET,
  SHARE_STILL_LOCAL,
  shareCardFromStill,
} from '../../tools/dev/share-card.mjs'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'

const SVG = fs.readFileSync('icon.svg', 'utf8')
const layout = readLayout('tools/dev/share-card.layout.json')
const icon = parseIconSvg(SVG)

/** A flat stand-in for the still: one colour, the card's size. */
const still = (rgb: [number, number, number]) => {
  const data = new Uint8Array(layout.width * layout.height * 3)
  for (let i = 0; i < layout.width * layout.height; i++) data.set(rgb, i * 3)
  return { width: layout.width, height: layout.height, channels: 3, data }
}
const px = (rgb: Uint8Array, x: number, y: number): number[] => {
  const i = (y * layout.width + x) * 3
  return [rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0]
}
const hexOf = (c: readonly number[]) =>
  `#${c.map((n) => (n as number).toString(16).padStart(2, '0')).join('')}`

describe('the layout is the UI tokens', () => {
  it('uses the tokens for the plate, the bar and the two lines', () => {
    expect(layout.width).toBe(1200)
    expect(layout.height).toBe(630)
    expect(layout.plate.bar.fill).toBe(UI_ACCENT)
    expect(layout.text.find((t: { id: string }) => t.id === 'title')?.fill).toBe(UI_INK)
    expect(layout.text.find((t: { id: string }) => t.id === 'edition')?.fill).toBe(UI_ACCENT)
    // The plate is the token's colour at the token's alpha.
    const [r = 0, g = 0, b = 0, a = 0] = UI_PLATE.match(/[\d.]+/g)?.map(Number) ?? []
    expect(hexOf([r, g, b])).toBe(layout.plate.fill)
    expect(a).toBe(layout.plate.alpha)
  })

  it('carries the two lines as outlines, inside the card', () => {
    for (const t of layout.text) {
      expect(t.contours.length, t.id).toBeGreaterThan(10)
      for (const c of t.contours) {
        for (const [x, y] of c) {
          expect(x).toBeGreaterThan(0)
          expect(x).toBeLessThan(layout.width)
          expect(y).toBeGreaterThan(layout.plate.y)
          expect(y).toBeLessThan(layout.height)
        }
      }
    }
  })
})

describe('composeShareCard', () => {
  const rgb = composeShareCard(still([200, 40, 40]), icon, layout)

  it('keeps the still above the plate, pixel for pixel', () => {
    expect(px(rgb, 600, 100)).toEqual([200, 40, 40])
    expect(px(rgb, 5, layout.plate.y - 1)).toEqual([200, 40, 40])
  })

  it('lays a flat plate across the foot, a hard accent bar on its left and a faint hairline on top', () => {
    const [pr, pg, pb] = [0x0a, 0x16, 0x1e]
    const a = layout.plate.alpha
    const inside = px(rgb, 1100, 600)
    expect(inside).toEqual([
      Math.round(200 * (1 - a) + pr * a),
      Math.round(40 * (1 - a) + pg * a),
      Math.round(40 * (1 - a) + pb * a),
    ])
    expect(hexOf(px(rgb, 3, 600))).toBe(UI_ACCENT)
    // The hairline brightens the plate's first rows over the plate colour.
    expect(px(rgb, 1100, layout.plate.y)[0] ?? 0).toBeGreaterThan(inside[0] ?? 0)
  })

  it('paints the emblem in its own colours inside its box, and nothing of its ground', () => {
    const e = layout.emblem
    const k = e.size / icon.size
    const gold = icon.shapes[0]
    if (!gold) throw new Error('no gold shape')
    const cx = gold.points.map((p) => p[0]).reduce((a, b) => a + b, 0) / gold.points.length
    const cy = gold.points.map((p) => p[1]).reduce((a, b) => a + b, 0) / gold.points.length
    expect(px(rgb, Math.floor(e.x + cx * k), Math.floor(e.y + cy * k))).toEqual([...gold.fill])
    // The emblem's box corner is the plate, not the icon's dark ground.
    const corner = px(rgb, e.x + 1, e.y + 1)
    expect(corner[0] ?? 255).toBeLessThan(60)
  })

  it('paints the words: both lines leave ink inside their own box', () => {
    for (const t of layout.text) {
      const xs = t.contours.flat().map((p) => p[0])
      const ys = t.contours.flat().map((p) => p[1])
      const want = t.fill === layout.plate.bar.fill ? [0xff, 0xcf, 0x7a] : [0xf2, 0xf7, 0xfb]
      let found = 0
      for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
        for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
          const p = px(rgb, x, y)
          if (p[0] === want[0] && p[1] === want[1] && p[2] === want[2]) found++
        }
      }
      expect(found, `${t.id} has solid ink`).toBeGreaterThan(500)
    }
  })

  it('refuses a still that is not the card size', () => {
    expect(() =>
      composeShareCard(
        { width: 10, height: 10, channels: 3, data: new Uint8Array(300) },
        icon,
        layout,
      ),
    ).toThrow(/still is 10 x 10/)
  })
})

describe('shareCardFromStill', () => {
  it('reads a PNG still and writes a 1200 x 630 RGB PNG', () => {
    const s = still([10, 20, 30])
    const png = encodePng(s.data, s.width, s.height)
    const out = decodePngBuffer(shareCardFromStill(png, SVG, layout), 'card')
    expect([out.width, out.height, out.channels]).toEqual([1200, 630, 3])
  })
})

describe('loadStill: where the build finds the picture', () => {
  const ok = (body: string) => async () =>
    ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) }) as unknown as Response
  const missing = async () => ({ ok: false, status: 404 }) as unknown as Response

  it('names the staged file and the bucket path in one place', () => {
    expect(SHARE_STILL_ASSET).toBe('assets/share/share-still.png')
    expect(SHARE_STILL_LOCAL).toBe('public/assets/share/share-still.png')
  })

  it('reads the bucket when the base is a URL and nothing is staged', async () => {
    const got = await loadStill({
      root: '/nowhere',
      env: { VITE_ASSET_BASE_URL: 'https://content.example/' },
      fetchImpl: ok('PNG'),
    })
    expect(got.bytes?.toString()).toBe('PNG')
    expect(got.from).toBe('https://content.example/assets/share/share-still.png')
  })

  it('says why, and does not throw, when the bucket has no still', async () => {
    const got = await loadStill({
      root: '/nowhere',
      env: { VITE_ASSET_BASE_URL: 'https://content.example' },
      fetchImpl: missing,
    })
    expect(got.bytes).toBeNull()
    expect(got.why).toBe('HTTP 404')
  })

  it('has nothing to read for a local base with no staged file', async () => {
    const got = await loadStill({ root: '/nowhere', env: { VITE_ASSET_BASE_URL: '/' } })
    expect(got.bytes).toBeNull()
  })
})

describe('the plugin falls back to the emblem card when there is no still', () => {
  it('emits the DEV-602 card, and does not throw', async () => {
    const emitted: { fileName: string; source: Buffer }[] = []
    const plugin = appIcon('icon.svg', {
      root: '/nowhere',
      layoutPath: 'tools/dev/share-card.layout.json',
    }) as unknown as {
      generateBundle: (this: { emitFile: (f: (typeof emitted)[number]) => void }) => Promise<void>
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prior = process.env.VITE_ASSET_BASE_URL
    process.env.VITE_ASSET_BASE_URL = '/'
    try {
      await plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) })
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, 'VITE_ASSET_BASE_URL')
      else process.env.VITE_ASSET_BASE_URL = prior
      warn.mockRestore()
    }
    const card = emitted.find((f) => f.fileName === 'share-card.png')
    expect(card?.source.equals(shareCardPng(SVG))).toBe(true)
  })
})
