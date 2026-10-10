// tests/unit/app-icon.test.ts: the home-screen icon is icon.svg, rasterised.
// DEV-595. `tools/dev/app-icon.mjs` says why it is drawn at build time rather
// than committed.

import fs from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  APPLE_TOUCH_ICON,
  APPLE_TOUCH_SIZE,
  appleTouchIconPng,
  parseIconSvg,
  pathPoints,
  rasterize,
  rasterizeCard,
  SHARE_CARD,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_MARK,
  SHARE_CARD_WIDTH,
  shareCardPng,
} from '../../tools/dev/app-icon.mjs'

const SVG = fs.readFileSync('icon.svg', 'utf8')

/** The colour at a point in the 32-unit viewBox, read off a raster. */
const at = (rgb: Uint8Array, size: number, x: number, y: number) => {
  const col = Math.floor((x / 32) * size)
  const row = Math.floor((y / 32) * size)
  const i = (row * size + col) * 3
  return [rgb[i], rgb[i + 1], rgb[i + 2]]
}
const centroid = (pts: readonly (readonly [number, number])[]): [number, number] => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
]

describe('the home-screen icon is the tab icon', () => {
  it('reads icon.svg: the ground and two straight-edged shapes, in its own colours', () => {
    const icon = parseIconSvg(SVG)
    expect(icon.size).toBe(32)
    expect(icon.ground).toEqual([0x07, 0x0b, 0x12])
    expect(icon.shapes.map((s) => s.fill)).toEqual([
      [0xfa, 0xcf, 0x63],
      [0xc2, 0xc8, 0xe5],
    ])
  })

  it('paints each shape its colour, and the ground to the very corners (iOS rounds it)', () => {
    const icon = parseIconSvg(SVG)
    const size = APPLE_TOUCH_SIZE
    const rgb = rasterize(icon, size)
    for (const shape of icon.shapes) {
      const [x, y] = centroid(shape.points)
      expect(at(rgb, size, x, y)).toEqual([...shape.fill])
    }
    const corners: [number, number][] = [
      [0, 0],
      [31.9, 0],
      [0, 31.9],
      [31.9, 31.9],
    ]
    for (const [x, y] of corners) {
      expect(at(rgb, size, x, y), `corner ${x},${y}`).toEqual([...icon.ground])
    }
  })

  it('is a 180 px RGB PNG at the site root, which is where iOS looks', () => {
    expect(APPLE_TOUCH_ICON).toBe('apple-touch-icon.png')
    expect(APPLE_TOUCH_SIZE).toBe(180)
    const png = appleTouchIconPng(SVG)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.toString('latin1', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(180)
    expect(png.readUInt32BE(20)).toBe(180)
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(2)
    // The image data inflates to one filter byte and 180 RGB pixels per row.
    const idat = png.indexOf('IDAT', 0, 'latin1')
    const length = png.readUInt32BE(idat - 4)
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length))
    expect(raw.length).toBe((180 * 3 + 1) * 180)
  })

  it('reads relative and absolute straight lines, and refuses a curve', () => {
    expect(pathPoints('M3 6h26L16 18Z')).toEqual([
      [3, 6],
      [29, 6],
      [16, 18],
    ])
    expect(pathPoints('M8 20h16l-8 6Z')).toEqual([
      [8, 20],
      [24, 20],
      [16, 26],
    ])
    expect(() => pathPoints('M0 0C1 1 2 2 3 3Z')).toThrow(/not a straight line/)
    expect(() =>
      parseIconSvg('<svg viewBox="0 0 32 32"><rect fill="#000000"/><circle r="3"/></svg>'),
    ).toThrow(/circle/)
  })
})

describe('the link-preview card (DEV-602)', () => {
  it('is a 1200 x 630 RGB PNG, the size chat clients crop to', () => {
    const png = shareCardPng(SVG)
    expect(png.toString('latin1', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(SHARE_CARD_WIDTH)
    expect(png.readUInt32BE(20)).toBe(SHARE_CARD_HEIGHT)
    expect([SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT]).toEqual([1200, 630])
  })

  it('is the emblem centred on the icon ground, with ground to every edge', () => {
    const icon = parseIconSvg(SVG)
    const w = SHARE_CARD_WIDTH
    const h = SHARE_CARD_HEIGHT
    const rgb = rasterizeCard(icon, w, h, SHARE_CARD_MARK)
    const px = (x: number, y: number) => [...rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)]
    for (const [x, y] of [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
      [40, h / 2],
    ] as const) {
      expect(px(x, y), `ground at ${x},${y}`).toEqual([...icon.ground])
    }
    // Each shape's colour appears, and the mark is centred: the painted pixels'
    // bounding box sits symmetric about the card's middle to within a pixel.
    const painted: [number, number][] = []
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (px(x, y).join() !== icon.ground.join()) painted.push([x, y])
    expect(painted.length).toBeGreaterThan(0)
    const xs = painted.map((p) => p[0])
    const left = Math.min(...xs)
    const right = Math.max(...xs)
    expect(Math.abs(left + right - (w - 1))).toBeLessThanOrEqual(2)
  })

  it('is the file index.html points og:image and twitter:image at', () => {
    const html = fs.readFileSync('index.html', 'utf8')
    const og = /property="og:image" content="([^"]+)"/.exec(html)?.[1]
    const tw = /name="twitter:image" content="([^"]+)"/.exec(html)?.[1]
    expect(og).toBe(`https://facetedflight.net/${SHARE_CARD}`)
    expect(tw).toBe(og)
    expect(html).toMatch(/property="og:image:width" content="1200"/)
    expect(html).toMatch(/property="og:image:height" content="630"/)
  })
})
