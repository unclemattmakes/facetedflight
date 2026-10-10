// tools/dev/share-card.mjs: the designed link-preview card. DEV-657.
//
// The card a pasted link unfurls as (`og:image`, 1200 x 630). DEV-602 drew the
// emblem on the page's ground; Matt, 2026-10-05 ("go with the rec", Q31): a
// still of the game with a gate in frame, the emblem and "10th Anniversary
// Edition" laid over it, under a flat broadcast plate.
//
// Three inputs, composed at BUILD time (no binary in git, hard rule 7):
//
//  1. THE STILL: a 1200 x 630 PNG of the Simonet reveal with a gate in frame.
//     It is a render of bought art, so it is NOT in the repository: it is staged
//     at `public/assets/share/share-still.png` and published to the content
//     bucket like every other asset. A build finds it on disk (a local build, a
//     machine with `pnpm assets:pull`) or fetches it from the asset base the
//     build is configured with (Cloudflare Pages). `loadStill` says which.
//  2. THE EMBLEM: `icon.svg`'s own shapes, laid over the still with no ground.
//  3. THE LAYOUT: `share-card.layout.json`, committed: the plate, the emblem's
//     box and the words as outlines (`share-card-layout.py` writes it).
//
// A card with no still is today's emblem card, and the build says so: a missing
// picture must never fail a deploy, and a link must always have a card.

import { existsSync, readFileSync } from 'node:fs'
import { decodePngBuffer } from '../terrain/png.mjs'
import { encodePng, parseIconSvg } from './app-icon.mjs'

/** Where the still lives, relative to the asset root and to the repo. */
export const SHARE_STILL_ASSET = 'assets/share/share-still.png'
export const SHARE_STILL_LOCAL = `public/${SHARE_STILL_ASSET}`

/** Subsamples per pixel side, as the icon rasteriser uses. */
const SAMPLES = 4

const hex = (s) => {
  const m = /^#([0-9a-f]{6})$/i.exec(s ?? '')
  if (!m) throw new Error(`share-card: a fill must be #rrggbb, got ${s}`)
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `a` over `b` at `alpha`, in place on `rgb` at byte offset `at`. */
const blend = (rgb, at, color, alpha) => {
  for (let k = 0; k < 3; k++) rgb[at + k] = Math.round(rgb[at + k] * (1 - alpha) + color[k] * alpha)
}

/** Even-odd point in one closed contour. */
const insideContour = (px, py, pts) => {
  let hit = false
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [xa, ya] = pts[a]
    const [xb, yb] = pts[b]
    if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) hit = !hit
  }
  return hit
}

const boxOf = (pts) => {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

/**
 * Fill `shapes` (each `{ fill, contours }`, later over earlier, even-odd across
 * a shape's contours so a letter's hole is a hole) over `rgb`, anti-aliased.
 * Only pixels inside a shape's box are visited.
 */
const paintShapes = (rgb, width, height, shapes) => {
  for (const shape of shapes) {
    const boxes = shape.contours.map(boxOf)
    const all = boxes.reduce(
      (a, b) => ({
        x0: Math.min(a.x0, b.x0),
        y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
      }),
      { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: -1, y1: -1 },
    )
    const color = shape.fill
    for (
      let row = Math.max(0, Math.floor(all.y0));
      row <= Math.min(height - 1, Math.ceil(all.y1));
      row++
    ) {
      for (
        let col = Math.max(0, Math.floor(all.x0));
        col <= Math.min(width - 1, Math.ceil(all.x1));
        col++
      ) {
        let covered = 0
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const x = col + (sx + 0.5) / SAMPLES
            const y = row + (sy + 0.5) / SAMPLES
            let hit = false
            for (let i = 0; i < shape.contours.length; i++) {
              const b = boxes[i]
              if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue
              if (insideContour(x, y, shape.contours[i])) hit = !hit
            }
            if (hit) covered++
          }
        }
        if (covered > 0) blend(rgb, (row * width + col) * 3, color, covered / (SAMPLES * SAMPLES))
      }
    }
  }
}

/** The icon's shapes as polygons scaled into the layout's emblem box (no ground). */
const emblemShapes = (icon, box) => {
  const k = box.size / icon.size
  return icon.shapes.map((s) => ({
    fill: s.fill,
    contours: [s.points.map(([x, y]) => [box.x + x * k, box.y + y * k])],
  }))
}

/**
 * The card's RGB: `still` (`{ width, height, channels, data }`, exactly the
 * layout's size) under the plate, the emblem and the words.
 */
export const composeShareCard = (still, icon, layout) => {
  const { width, height } = layout
  if (still.width !== width || still.height !== height) {
    throw new Error(
      `share-card: the still is ${still.width} x ${still.height}, the card ${width} x ${height}`,
    )
  }
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) rgb[i * 3 + k] = still.data[i * still.channels + k]
  }
  const p = layout.plate
  const plateFill = hex(p.fill)
  const barFill = hex(p.bar.fill)
  const hairFill = hex(p.hairline.fill)
  for (let row = p.y; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const at = (row * width + col) * 3
      blend(rgb, at, plateFill, p.alpha)
      if (row < p.y + p.hairline.h) blend(rgb, at, hairFill, p.hairline.alpha)
      if (col < p.bar.w) rgb.set(barFill, at)
    }
  }
  paintShapes(rgb, width, height, emblemShapes(icon, layout.emblem))
  paintShapes(
    rgb,
    width,
    height,
    layout.text.map((t) => ({ fill: hex(t.fill), contours: t.contours })),
  )
  return rgb
}

/** The card's PNG bytes, from the still's PNG bytes, the icon's SVG text and the layout. */
export const shareCardFromStill = (stillPng, svg, layout) => {
  const still = decodePngBuffer(stillPng, 'share-still.png')
  return encodePng(composeShareCard(still, parseIconSvg(svg), layout), layout.width, layout.height)
}

/** The committed layout. */
export const readLayout = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * The still's bytes, or null (and why). Order: an explicit file (`SHARE_STILL`
 * in the environment), the staged file under `public/`, then the content bucket
 * the build is configured to read (`VITE_ASSET_BASE_URL`, an absolute URL).
 */
export const loadStill = async ({ root, env = process.env, fetchImpl = globalThis.fetch }) => {
  const explicit = env.SHARE_STILL
  const local = `${root}/${SHARE_STILL_LOCAL}`
  for (const file of [explicit, local]) {
    if (file && existsSync(file)) return { bytes: readFileSync(file), from: file }
  }
  const base = env.VITE_ASSET_BASE_URL ?? ''
  if (/^https?:\/\//.test(base) && fetchImpl) {
    const url = `${base.replace(/\/+$/, '')}/${SHARE_STILL_ASSET}`
    try {
      const res = await fetchImpl(url)
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()), from: url }
      return { bytes: null, from: url, why: `HTTP ${res.status}` }
    } catch (err) {
      return { bytes: null, from: url, why: String(err) }
    }
  }
  return { bytes: null, from: local, why: 'not staged and no content bucket to read' }
}
