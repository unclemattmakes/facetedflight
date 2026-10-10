// tools/dev/app-icon.mjs: the home-screen icon, drawn from icon.svg at build
// time. DEV-595.
//
// Matt's phone is an iPhone, which has no fullscreen for a web page; its route
// to a game without Safari's bars is Add to Home Screen (`index.html`'s
// manifest and apple-mobile-web-app tags). The icon that shortcut wears is an
// `apple-touch-icon`, and iOS reads only a PNG for it (no SVG), at 180 px.
//
// A PNG is a binary, and binaries do not go in git (CLAUDE.md hard rule 7). So
// nothing is committed but this file: the PNG is RASTERISED from `icon.svg`'s
// own shapes when Vite builds, emitted at the site root (where iOS also looks
// for `/apple-touch-icon.png` on its own), served from memory by `pnpm dev`, and
// linked from the page head. One source for the tab icon and the home-screen
// icon, so they cannot drift.
//
// The SVG reader is deliberately small: a `viewBox`, one `<rect>` (the ground)
// and `<path>`s made of straight lines (M, L, H, V, Z, absolute or relative),
// which is all `icon.svg` is. Anything else (a curve, an arc, a transform)
// THROWS, so a future icon that outgrows this reader fails the build loudly
// rather than shipping a wrong picture. The ground is drawn square, corners
// and all: iOS rounds the icon itself, and fills a transparent corner black.

import { readFileSync } from 'node:fs'
import { constants } from 'node:zlib'
import { encodePng as encodeRgbaPng } from '../terrain/png.mjs'

/** zlib's own default level, which this file's PNGs have always used. */
const DEFLATE_DEFAULT = constants.Z_DEFAULT_COMPRESSION

/** The file name, at the site root, and the size iOS asks an iPhone for. */
export const APPLE_TOUCH_ICON = 'apple-touch-icon.png'
export const APPLE_TOUCH_SIZE = 180
/** Subsamples per pixel side: 4 x 4, enough for clean edges on flat shapes. */
const SAMPLES = 4

const hex = (s) => {
  const m = /^#([0-9a-f]{6})$/i.exec(s ?? '')
  if (!m) throw new Error(`app-icon: a fill must be #rrggbb, got ${s}`)
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** Straight-line path data to one polygon's points. Throws on anything curved. */
export const pathPoints = (d) => {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const points = []
  let x = 0
  let y = 0
  let cmd = ''
  let i = 0
  const num = () => {
    const v = Number(tokens[i++])
    if (!Number.isFinite(v)) throw new Error(`app-icon: a number was expected in "${d}"`)
    return v
  }
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++]
    switch (cmd) {
      case 'M':
      case 'L':
        x = num()
        y = num()
        break
      case 'm':
      case 'l':
        x += num()
        y += num()
        break
      case 'H':
        x = num()
        break
      case 'h':
        x += num()
        break
      case 'V':
        y = num()
        break
      case 'v':
        y += num()
        break
      case 'Z':
      case 'z':
        continue
      default:
        throw new Error(`app-icon: path command "${cmd}" is not a straight line ("${d}")`)
    }
    points.push([x, y])
  }
  if (points.length < 3) throw new Error(`app-icon: "${d}" is not a polygon`)
  return points
}

/** `icon.svg`'s text to a ground colour, a viewBox size, and filled polygons. */
export const parseIconSvg = (svg) => {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '')
  const box = (attr(/<svg[^>]*>/.exec(body)?.[0] ?? '', 'viewBox') ?? '').split(/\s+/).map(Number)
  if (box.length !== 4 || box[0] !== 0 || box[1] !== 0 || box[2] !== box[3]) {
    throw new Error(`app-icon: a square viewBox from 0 0 is expected, got "${box.join(' ')}"`)
  }
  const rects = body.match(/<rect\b[^>]*>/g) ?? []
  if (rects.length !== 1)
    throw new Error(`app-icon: one <rect> (the ground) expected, found ${rects.length}`)
  for (const unsupported of ['<circle', '<ellipse', '<polygon', '<g ', 'transform=']) {
    if (body.includes(unsupported)) throw new Error(`app-icon: "${unsupported}" is not read here`)
  }
  const shapes = (body.match(/<path\b[^>]*>/g) ?? []).map((tag) => ({
    fill: hex(attr(tag, 'fill')),
    points: pathPoints(attr(tag, 'd') ?? ''),
  }))
  return { size: box[2], ground: hex(attr(rects[0], 'fill')), shapes }
}

/** Even-odd point in polygon. */
const inside = (px, py, pts) => {
  let hit = false
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [xa, ya] = pts[a]
    const [xb, yb] = pts[b]
    if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) hit = !hit
  }
  return hit
}

/** The icon at `size` x `size` px, RGB, row-major. Later shapes paint over earlier ones. */
export const rasterize = (icon, size) => {
  const rgb = new Uint8Array(size * size * 3)
  const scale = icon.size / size
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const sum = [0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (col + (sx + 0.5) / SAMPLES) * scale
          const y = (row + (sy + 0.5) / SAMPLES) * scale
          let c = icon.ground
          for (const shape of icon.shapes) if (inside(x, y, shape.points)) c = shape.fill
          sum[0] += c[0]
          sum[1] += c[1]
          sum[2] += c[2]
        }
      }
      const at = (row * size + col) * 3
      for (let k = 0; k < 3; k++) rgb[at + k] = Math.round(sum[k] / (SAMPLES * SAMPLES))
    }
  }
  return rgb
}

/** An 8-bit RGB PNG, filter 0 on every row. The one encoder is tools/terrain/png.mjs (TL-13). */
export const encodePng = (rgb, width, height) =>
  encodeRgbaPng({ width, height, channels: 3, data: rgb }, { level: DEFLATE_DEFAULT })

// ── DEV-602: the link-preview card ────────────────────────────────────────
//
// The 2026-10-03 persona playtest pasted facetedflight.net into a team chat
// and got a bare URL: no image, no card. `og:image` must be a raster (no chat
// client reads an SVG) at an absolute URL, and 1200 x 630 is the size every
// big client crops to. Same rule as the icon above, for the same reason: no
// binary in git, so it is drawn from `icon.svg` at build time. The emblem on
// the page's own ground, and nothing else: Matt's own mark, no bought art in
// it. The words travel in `og:title` and `og:description`, which every
// client prints under the image.

/** The card's file name at the site root, its size, and the emblem's size within it. */
export const SHARE_CARD = 'share-card.png'
export const SHARE_CARD_WIDTH = 1200
export const SHARE_CARD_HEIGHT = 630
export const SHARE_CARD_MARK = 420

/**
 * The card's pixels: the icon's ground over the whole card, the icon centred at
 * `mark` px. The icon's own corners are its ground (see the header), so the
 * mark sits on the card with no seam.
 */
export const rasterizeCard = (icon, width, height, mark) => {
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) rgb.set(icon.ground, i * 3)
  const art = rasterize(icon, mark)
  const left = Math.round((width - mark) / 2)
  const top = Math.round((height - mark) / 2)
  for (let row = 0; row < mark; row++) {
    rgb.set(art.subarray(row * mark * 3, (row + 1) * mark * 3), ((top + row) * width + left) * 3)
  }
  return rgb
}

/** The card's bytes, from an SVG's text. */
export const shareCardPng = (svg) =>
  encodePng(
    rasterizeCard(parseIconSvg(svg), SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT, SHARE_CARD_MARK),
    SHARE_CARD_WIDTH,
    SHARE_CARD_HEIGHT,
  )

/** The home-screen icon's bytes, from an SVG's text. */
export const appleTouchIconPng = (svg, size = APPLE_TOUCH_SIZE) =>
  encodePng(rasterize(parseIconSvg(svg), size), size, size)

/**
 * The Vite plugin: link it, serve it in dev, emit it in a build.
 *
 * DEV-657: given `options.root` (the repo) and `options.layoutPath`, the share
 * card is the DESIGNED one (`share-card.mjs`: a still of the game, the emblem and
 * the words under a flat plate) whenever a still can be found (staged under
 * `public/assets/share/`, or on the content bucket the build reads). Without a
 * still, or if composing fails, it is DEV-602's emblem card and the build says
 * so: a missing picture never fails a deploy and a link always has a card.
 */
export const appIcon = (svgPath, options = {}) => {
  let png = null
  const bytes = () => {
    png ??= appleTouchIconPng(readFileSync(svgPath, 'utf8'))
    return png
  }
  // DEV-602: the link-preview card, drawn and served the same way.
  let card = null
  const cardBytes = async () => {
    if (card) return card
    const svg = readFileSync(svgPath, 'utf8')
    if (options.root && options.layoutPath) {
      // Dynamic, so this file and share-card.mjs (which reads this one's
      // rasteriser) are not a cycle at load.
      const { loadStill, readLayout, shareCardFromStill } = await import('./share-card.mjs')
      const found = await loadStill({ root: options.root })
      if (found.bytes) {
        try {
          card = shareCardFromStill(found.bytes, svg, readLayout(options.layoutPath))
          console.info(`share card: composed from the still at ${found.from}`)
          return card
        } catch (err) {
          console.warn(
            `share card: the still at ${found.from} could not be used (${err}); emblem card`,
          )
        }
      } else {
        console.warn(`share card: no still (${found.why}); emblem card`)
      }
    }
    card = shareCardPng(svg)
    return card
  }
  return {
    name: 'ff2-app-icon',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path !== `/${APPLE_TOUCH_ICON}` && path !== `/${SHARE_CARD}`) return next()
        res.setHeader('Content-Type', 'image/png')
        if (path === `/${SHARE_CARD}`) {
          cardBytes().then(
            (b) => res.end(b),
            (err) => next(err),
          )
        } else res.end(bytes())
      })
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: APPLE_TOUCH_ICON, source: bytes() })
      this.emitFile({ type: 'asset', fileName: SHARE_CARD, source: await cardBytes() })
    },
    transformIndexHtml() {
      return [
        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', href: `/${APPLE_TOUCH_ICON}` },
          injectTo: 'head',
        },
      ]
    },
  }
}
