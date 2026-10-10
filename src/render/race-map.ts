// src/render/race-map.ts — the course from above, the field on it, and your
// place. DEV-361, Anniversary `hud.raceMap`.
//
// Matt, 2026-09-24: *"simplified race mini map hud to understand your position
// relative to others - grab from king-tide"*.
//
// ── What came from king-tide, and what did not ────────────────────────────
//
// `king-tide/src/engine/render/race-hud.ts` draws its minimap into a DOM
// `<canvas>`: bounds over the racing line and the checkpoints, padded so an
// edge dot does not clip; a TRUE top-down projection (it notes that flipping an
// axis to put "north up" inverts handedness and makes a clockwise course read
// anticlockwise); the line baked once into a static layer and only the dots
// redrawn; the player's dot bigger than the field's AND ringed, because
// *"I can't tell which dot is me"* was its playtest's own complaint about a
// same-size dot. All four ideas are here.
//
// The DOM is not. A headset cannot see a DOM overlay (`hud.ts`'s header says
// why), so this is a plate beside the cockpit panel, a CHILD of it — which buys
// the preset's placement (DEV-129), the third-person re-parenting (DEV-128) and
// the pause menu hiding it, all three without a line of their own.
//
// ── Why geometry and not a second canvas ──────────────────────────────────
//
// `docs/plan/HUD-REWORK.md`: the panel's canvas was the most expensive single
// thing this engine did, and it was the RASTER and the UPLOAD, never the
// drawing. The racer dots are the fastest-moving reading a HUD could carry — a
// canvas map would repaint at the budget's ceiling for the whole race. So this
// takes DEV-257's answer (`hud-gauges.ts`) all the way: ONE merged
// `BufferGeometry` with vertex colours, ONE draw call, no texture, no canvas,
// no raster, no `onBeforeCompile`. Even the place readout is geometry: segment
// glyphs, seven bars a digit. What moves is a few hundred bytes of vertices,
// written through `addUpdateRange` so the static plate and outline are never
// re-sent.
//
// And it is the art answer too (`ART_DIRECTION.md` pillar 2): one colour per
// face, never a texture. The dots are hexagons, not circles — a facet is the
// register.
//
// ── How often it moves ────────────────────────────────────────────────────
//
// A dot's position is quantised to the panel's own texel grid
// (`PIXELS_PER_METRE`, 1400/m, which HUD-REDESIGN measured at 0.99 texels per
// display pixel on the target headset). If no dot has moved a texel and the
// readout text is unchanged, nothing is written. When something has, the write
// goes through the SAME redraw policy as the panel (DEV-243 / DEV-248, `10hz`
// by default, `?hudRedraw=live` for the A/B arm), so `__ff2.hud(...)` moves
// both together and the map can never outpace the panel beside it.
//
// ── The projection ────────────────────────────────────────────────────────
//
// Sim space is Unity's: x east, z north, y up. From above, with z up the plate
// and x to the right, that is a true top view with no mirror — the same answer
// three's own top-down camera gives (right = forward × up = (−y) × (−z_three) =
// +x, and z_three is −z_sim). A course that turns right turns right on the map.
// `tests/unit/race-map.test.ts` checks it as geometry (a point east of another
// lands to its right) rather than as a matrix, per the orientation lesson.
//
// ── The one mark with a direction (DEV-432) ───────────────────────────────
//
// Matt, 2026-09-26: *"it'd be nice if the player indicator in the mini-map was
// a triangle instead of circle"*. The player's mark is a triangle pointing
// along the ship's NOSE, projected onto the map the same way its position is
// (sim x to the right, sim z up), and ringed by the same ink the hexagon's ring
// was. The map stays north-up; only the mark turns — which answers DEV-361's
// open "north-up versus turning with you" for the one mark that has a heading.
// It is still one draw: two triangles in the same buffer where the ringed
// hexagon's eight were.

import * as THREE from 'three'
import type { LivePlace, RaceLine } from '@/game/race-place'
import { type Quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { advanceRoute, createRouteCursor, rewindCursor, routeAt, routeTangentAt } from '@/sim/route'
import {
  createHudRedrawBudget,
  describeHudRedraw,
  HEIGHT,
  HUD_GAUGE_PALETTE,
  HUD_PLATE_INKS,
  HUD_REDRAW_DEFAULT,
  type HudRedraw,
  PIXELS_PER_METRE,
  WIDTH,
} from './hud'
import { parseColour } from './hud-gauges'
import { LIVERY_PANEL_SRGB, srgbHex } from './racer-livery'

// ── Sizes: the four that are the preset's, and the proportions that are not ──

/**
 * The plate's tunables, from `content/editions/*.json`'s `hud.raceMap` — every
 * one a number Matt may move, so none is typed here (hard rule 3's reasoning,
 * `EditionNextGateArrow`'s precedent).
 */
export interface RaceMapSize {
  /** Plate width, metres. Its height is the panel's, so the two plates line up. */
  readonly widthMetres: number
  /** Gap between the panel's right edge and the plate's left edge, metres. */
  readonly gapMetres: number
  /** A racer's dot, corner to corner, metres. */
  readonly dotMetres: number
  /**
   * The player's mark, metres — before its ring. The corner-to-corner span of
   * a hexagon; since DEV-432 the mark is a triangle with that hexagon's AREA.
   */
  readonly playerDotMetres: number
}

// The plate's own proportions. Layout, not tuning: each is a share of a size
// the preset already sets, so none of them is a length on its own.

/** The margin inside the plate edge, as a share of the plate's height. */
const INSET_SHARE = 0.06
/** The readout band across the top, as a share of the plate's height. */
const READOUT_SHARE = 0.24
/** A glyph's height as a share of the readout band. */
const GLYPH_SHARE = 0.72
/** The course outline's stroke, as a share of a racer's dot. */
const STROKE_PER_DOT = 0.36
/** The finish tick's half-length, as a share of a racer's dot. */
const FINISH_PER_DOT = 1.1
/** The finish tick's half-thickness, as a share of the line's stroke. */
const FINISH_PER_STROKE = 0.75

/** Where each part of the plate is, in the plate's own metres (origin at its centre, +y up). */
export interface RaceMapLayout {
  readonly width: number
  readonly height: number
  /** The plate centre's offset from the PANEL's centre, along the panel's x. */
  readonly offsetX: number
  readonly inset: number
  /** The readout's glyph height and the baseline its bottoms sit on. */
  readonly glyphHeight: number
  readonly glyphBottom: number
  readonly glyphLeft: number
  /** The rectangle the course is fitted into. Dots are kept inside it. */
  readonly area: {
    readonly minX: number
    readonly maxX: number
    readonly minY: number
    readonly maxY: number
  }
  readonly stroke: number
}

/**
 * The plate beside a panel `panelWidth` × `panelHeight`, on the pilot's RIGHT.
 *
 * Right because `render/perf-plate.ts` has the left (`PLATE_SIDE = -1`) under
 * `?perf=1`, and a map that sat under the dev plate would be a map nobody
 * measuring could see.
 */
export const raceMapLayout = (
  size: RaceMapSize,
  panelWidth: number,
  panelHeight: number,
): RaceMapLayout => {
  const width = size.widthMetres
  const height = panelHeight
  const inset = height * INSET_SHARE
  const band = height * READOUT_SHARE
  const glyphHeight = band * GLYPH_SHARE
  const stroke = size.dotMetres * STROKE_PER_DOT
  // The player's mark and its ring are the widest thing that moves; keep half of
  // it clear of the plate edge so a racer on the course's rim is not clipped —
  // king-tide pads its bounds for the same reason. DEV-432's triangle reaches
  // further than this along its tip, and on purpose it does not move the fit
  // (the course keeps its size): the tip can cross into the inset, never off
  // the plate and never into the readout's glyphs. `race-map.test.ts` sweeps it.
  const keep = size.playerDotMetres / 2 + stroke
  return {
    width,
    height,
    offsetX: panelWidth / 2 + size.gapMetres + width / 2,
    inset,
    glyphHeight,
    glyphBottom: height / 2 - inset - glyphHeight,
    glyphLeft: -width / 2 + inset,
    area: {
      minX: -width / 2 + inset + keep,
      maxX: width / 2 - inset - keep,
      minY: -height / 2 + inset + keep,
      maxY: height / 2 - inset - band - keep,
    },
    stroke,
  }
}

// ── The course, fitted ─────────────────────────────────────────────────────

/** Sim x/z to the plate's own metres. */
export interface MapFit {
  /** Plate metres per world metre. */
  readonly scale: number
  readonly worldX: number
  readonly worldZ: number
  readonly plateX: number
  readonly plateY: number
}

/**
 * The uniform fit that puts every point inside `area`, centred.
 *
 * UNIFORM, so a course keeps its shape — a map stretched to fill its plate
 * would bend every corner the player is trying to read.
 */
export const fitMap = (
  points: readonly { readonly x: number; readonly z: number }[],
  area: RaceMapLayout['area'],
): MapFit => {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  const spanX = maxX - minX
  const spanZ = maxZ - minZ
  const w = area.maxX - area.minX
  const h = area.maxY - area.minY
  // A course with no extent on an axis (one point, or a straight line) fits on
  // the other; with none on either there is nothing to scale and 1 is as good
  // as any number.
  const sx = spanX > 0 ? w / spanX : Number.POSITIVE_INFINITY
  const sz = spanZ > 0 ? h / spanZ : Number.POSITIVE_INFINITY
  const scale = Math.min(sx, sz)
  return {
    scale: Number.isFinite(scale) ? scale : 1,
    worldX: (minX + maxX) / 2,
    worldZ: (minZ + maxZ) / 2,
    plateX: (area.minX + area.maxX) / 2,
    plateY: (area.minY + area.maxY) / 2,
  }
}

/** A world point on the plate: x east to the right, z north up. See the header. */
export const mapPoint = (
  fit: MapFit,
  x: number,
  z: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } => {
  out.x = fit.plateX + (x - fit.worldX) * fit.scale
  out.y = fit.plateY + (z - fit.worldZ) * fit.scale
  return out
}

/**
 * Douglas–Peucker, in the plane of the map.
 *
 * "Simplified" in Matt's words, and the tolerance is chosen so the word costs
 * nothing visible: the caller passes HALF THE STROKE in world metres, so every
 * point dropped lay inside the line that is drawn anyway. The first and last
 * points always survive.
 */
export const simplifyPolyline = <P extends { readonly x: number; readonly z: number }>(
  points: readonly P[],
  tolerance: number,
): P[] => {
  const n = points.length
  if (n <= 2) return points.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: number[] = [0, n - 1]
  while (stack.length > 0) {
    const last = stack.pop() as number
    const first = stack.pop() as number
    const a = points[first] as P
    const b = points[last] as P
    const ex = b.x - a.x
    const ez = b.z - a.z
    const lenSq = ex * ex + ez * ez
    let worst = -1
    let worstD = tolerance
    for (let i = first + 1; i < last; i += 1) {
      const p = points[i] as P
      // Distance to the SEGMENT, not the infinite line: a course that doubles
      // back would otherwise lose its hairpin, whose tip lies on the line
      // through the two ends.
      const t =
        lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / lenSq)) : 0
      const d = Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t))
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push(first, worst, worst, last)
    }
  }
  const out: P[] = []
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(points[i] as P)
  return out
}

/** Volatile: a search cursor and a point, valid only inside one call below. */
const _cursor = createRouteCursor()
const _at = v3()
const _tangent = v3()

/**
 * The racing line from its start to the FINISH, as x/z points.
 *
 * Every shipped route runs on past the finish — about a kilometre on `int_01`
 * — because 2016's Curvy path was not cut where the race ends. A map drawing
 * the whole of it would show a leg nobody flies. The finish's own arc is
 * searched from the last gate on, so a course that passes near its finish
 * earlier (int_01 folds back twice) cannot cut the outline short.
 */
export const courseOutline = (
  line: RaceLine,
  finish: Vec3 | null,
): { points: { x: number; z: number }[]; finishArc: number } => {
  const { route, gateArc } = line
  let end = route.length
  if (finish) {
    const lastGate = gateArc.length > 0 ? Math.max(...gateArc) : 0
    rewindCursor(route, _cursor, lastGate)
    advanceRoute(route, _cursor, finish, route.count)
    end = _cursor.s
  }
  const points: { x: number; z: number }[] = []
  for (let i = 0; i < route.count; i += 1) {
    if ((route.cumulative[i] as number) >= end) break
    points.push({ x: route.points[i * 3] as number, z: route.points[i * 3 + 2] as number })
  }
  routeAt(route, end, _at)
  points.push({ x: _at.x, z: _at.z })
  return { points, finishArc: end }
}

// ── The readout, as segment glyphs ───────────────────────────────────────

/**
 * `P2/6`, or the empty string where there is no place to state.
 *
 * Empty rather than `P-/6`: a run the clock ended has no place on the results
 * panel either (`withStandings` returns null, and that panel says DNF in words),
 * and an absent reading draws nothing — the rule every instrument on the panel
 * follows (DEV-154). Before the release there is no race yet, and the caller
 * passes no place for the same reason.
 */
export const placeText = (place: LivePlace | null): string =>
  place === null || place.place === null || place.field === 0
    ? ''
    : `#${place.place}/${place.field}`

/**
 * The seven bars of a segment digit, as rectangles on a unit cell
 * `GLYPH_W` wide and 1 tall, origin bottom-left: `[x0, y0, x1, y1]`.
 *
 *      a
 *    f   b
 *      g
 *    e   c
 *      d
 */
const GLYPH_W = 0.56
const BAR = 0.15
const NICK = 0.03
const SEGMENTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  a: [NICK, 1 - BAR, GLYPH_W - NICK, 1],
  b: [GLYPH_W - BAR, 0.5 + NICK, GLYPH_W, 1 - NICK],
  c: [GLYPH_W - BAR, NICK, GLYPH_W, 0.5 - NICK],
  d: [NICK, 0, GLYPH_W - NICK, BAR],
  e: [0, NICK, BAR, 0.5 - NICK],
  f: [0, 0.5 + NICK, BAR, 1 - NICK],
  g: [NICK, 0.5 - BAR / 2, GLYPH_W - NICK, 0.5 + BAR / 2],
  // The place mark's own four bars (a hash: two uprights, two crossbars), so it
  // never borrows a digit's bars and reads as a "y" (Matt saw "Y3/6").
  h: [0.13, 0.08, 0.13 + BAR, 0.92],
  i: [GLYPH_W - 0.13 - BAR, 0.08, GLYPH_W - 0.13, 0.92],
  j: [0, 0.64 - BAR / 2, GLYPH_W, 0.64 + BAR / 2],
  k: [0, 0.36 - BAR / 2, GLYPH_W, 0.36 + BAR / 2],
}
/** Which bars light for each character the readout can print. */
export const GLYPH_BARS: Readonly<Record<string, string>> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  // DEV-844: the place mark, drawn as a real hash from its own four bars.
  '#': 'hijk',
}
/** Advance from one glyph to the next, in glyph heights. */
const GLYPH_ADVANCE = GLYPH_W + 0.24
/** The most glyphs the readout can hold: `P`, two digits, `/`, two digits. */
export const MAX_GLYPHS = 6
/** Quads per glyph at most: seven bars, or the slash's one. */
const QUADS_PER_GLYPH = 7

/**
 * A glyph's quads as four corners each, in plate metres, bottom-left at
 * (`x`, `y`) and `h` tall. Unknown characters draw nothing.
 */
export const glyphQuads = (ch: string, x: number, y: number, h: number): number[][] => {
  if (ch === '/') {
    // One slanted bar, corner to corner across the cell.
    const w = GLYPH_W * h
    const t = BAR * h
    return [[x, y, x + t, y, x + w, y + h, x + w - t, y + h]]
  }
  const bars = GLYPH_BARS[ch]
  if (!bars) return []
  const out: number[][] = []
  for (const s of bars) {
    const r = SEGMENTS[s]
    if (!r) continue
    const x0 = x + r[0] * h
    const y0 = y + r[1] * h
    const x1 = x + r[2] * h
    const y1 = y + r[3] * h
    out.push([x0, y0, x1, y0, x1, y1, x0, y1])
  }
  return out
}

// ── The palette: the panel's own inks, and the ships' own colours ─────────

/**
 * Every colour this plate uses, and not one of them new.
 *
 * The plate and the type are the panel's (`HUD_PLATE_INKS`); the line is the
 * panel's muted ink and the finish its accent (`HUD_GAUGE_PALETTE`). A racer's
 * dot is the colour it WEARS — `spec.colour`, DEV-350's livery — and the
 * player's is the player's own hull, `LIVERY_PANEL_SRGB`, the orange DEV-350's
 * palette (a rainbow since its follow-up) is held clear of. So a dot and the ship it stands for are
 * the same colour, and the only thing that reads as "you" is your own paint,
 * plus the ring king-tide's playtest asked for.
 */
export const RACE_MAP_INKS = {
  plate: HUD_PLATE_INKS.plate,
  edge: HUD_GAUGE_PALETTE.plateEdge,
  line: HUD_GAUGE_PALETTE.muted,
  finish: HUD_GAUGE_PALETTE.accent,
  type: HUD_PLATE_INKS.ink,
  place: HUD_GAUGE_PALETTE.accent,
  ring: HUD_PLATE_INKS.ink,
  player: srgbHex(LIVERY_PANEL_SRGB),
  /**
   * A racer with no colour on its spec — a test, or a racer built without the
   * livery. The type ink, NOT the line's: a dot the colour of the line it sits
   * on is a dot nobody can see.
   */
  racer: HUD_PLATE_INKS.ink,
  /**
   * DEV-373: the player's GHOST, a HOLLOW dot in the type ink. Hollow because
   * the ghost is the one ship on the course that is not there: the hologram
   * says so in the world (DEV-350: solid is a racer you can touch), and the
   * outline says so on the map. PLAYER-GHOSTS §4.2 asked for exactly this.
   */
  ghost: HUD_PLATE_INKS.ink,
} as const

// ── The player's mark: a triangle along the nose (DEV-432) ────────────────

/**
 * The triangle's base as a share of its length: an apex of about 39 degrees.
 * Proportion, not tuning. An equilateral triangle points three ways at once,
 * and at a few pixels across only a narrow one says which of them is ahead.
 */
const PLAYER_ASPECT = 0.7
/**
 * The ring's width round the triangle, as a share of the line's stroke. Half
 * the hexagon's ring, because an offset outline runs past a sharp tip by the
 * width over the sine of the half-apex, about three times the width here: a
 * whole stroke would put a spike of ring ink three strokes past the tip.
 */
const PLAYER_RING_PER_STROKE = 0.5
/** A regular hexagon's area over its corner-to-corner span squared: 3√3 / 8. */
const HEXAGON_AREA_PER_SPAN_SQ = (3 * Math.sqrt(3)) / 8

/** A point in the mark's own frame: `u` along the heading, `v` to its left. */
export type MarkPoint = readonly [number, number]
/** Tip, left corner, right corner. */
export type MarkTriangle = readonly [MarkPoint, MarkPoint, MarkPoint]

export interface PlayerMark {
  readonly fill: MarkTriangle
  readonly ring: MarkTriangle
}

/**
 * The player's triangle and its ring, in the mark's own frame, centred on the
 * triangle's CENTROID — so the ship sits in the middle of its mark, as it sat
 * at the hexagon's centre.
 *
 * The triangle has the AREA of the hexagon it replaced (`playerDotMetres`
 * corner to corner): Matt asked for a different shape, not a smaller mark, and
 * the first version — the hexagon's span as the triangle's length — drew half
 * the ink, about a racer's dot, and read that way in the photograph.
 *
 * The ring is the triangle offset outward by one constant width: the same
 * triangle scaled about its INCENTRE by (r + w) / r, which puts every edge of
 * the ring exactly `w` outside its own and parallel to it. Scaled about the
 * centroid instead, the base would carry a wider border than the sides.
 */
export const playerMark = (size: RaceMapSize, stroke: number): PlayerMark => {
  // aspect · length² / 2 = the hexagon's area.
  const length = size.playerDotMetres * Math.sqrt((2 * HEXAGON_AREA_PER_SPAN_SQ) / PLAYER_ASPECT)
  const half = (length * PLAYER_ASPECT) / 2
  const tip: MarkPoint = [(2 * length) / 3, 0]
  const left: MarkPoint = [-length / 3, half]
  const right: MarkPoint = [-length / 3, -half]
  // Each side's length, named for the corner it faces.
  const a = Math.hypot(left[0] - right[0], left[1] - right[1])
  const b = Math.hypot(tip[0] - right[0], tip[1] - right[1])
  const c = Math.hypot(tip[0] - left[0], tip[1] - left[1])
  const perimeter = a + b + c
  const ix = (a * tip[0] + b * left[0] + c * right[0]) / perimeter
  const iy = (a * tip[1] + b * left[1] + c * right[1]) / perimeter
  const area =
    Math.abs((left[0] - tip[0]) * (right[1] - tip[1]) - (right[0] - tip[0]) * (left[1] - tip[1])) /
    2
  const inradius = (2 * area) / perimeter
  const k = (inradius + stroke * PLAYER_RING_PER_STROKE) / inradius
  const out = (p: MarkPoint): MarkPoint => [ix + (p[0] - ix) * k, iy + (p[1] - iy) * k]
  return { fill: [tip, left, right], ring: [out(tip), out(left), out(right)] }
}

/** Volatile: the nose, valid only inside one `plateHeading` call. */
const _nose = v3()
/** Body +Z: the nose, in the sim's frame (`sim/math/quat.ts`'s `lookAlong`). */
const NOSE = Object.freeze(v3(0, 0, 1))

/**
 * The ship's heading ON THE PLATE, a unit vector: its nose, projected the way
 * `mapPoint` projects a position (sim x to the right, sim z up). Null when the
 * nose points straight up or down and has no heading to give; the caller keeps
 * the last one.
 */
export const plateHeading = (
  orientation: Quat,
  out: { x: number; y: number },
): { x: number; y: number } | null => {
  rotateVec3(_nose, orientation, NOSE)
  const len = Math.hypot(_nose.x, _nose.z)
  if (!(len > 1e-6)) return null
  out.x = _nose.x / len
  out.y = _nose.z / len
  return out
}

// ── The mesh ─────────────────────────────────────────────────────────────

export interface RaceMapSpec {
  /** The line the field is measured along — the same one `race-place.ts` uses. */
  readonly line: RaceLine
  /** The finish sphere's centre, SIM space, or null for a course with none. */
  readonly finish: Vec3 | null
  /** One per racer, in racer order: `spec.colour`, or null. */
  readonly racerColours: readonly (string | null)[]
  readonly size: RaceMapSize
  /**
   * The panel this plate sits beside. Absent is `hud.ts`'s own `WIDTH` and
   * `HEIGHT`, which is every production caller: a second copy of `0.4` here
   * would be a plate that slides into the panel the day it is resized, which
   * is `perf-plate.ts`'s reason for importing them too.
   */
  readonly panelWidth?: number
  readonly panelHeight?: number
  /** The panel's cadence. Absent is the panel's default. */
  readonly redraw?: HudRedraw
}

/** Where the ships are this frame, SIM space. Racers in racer order. */
export interface RaceMapFeed {
  readonly player: { readonly x: number; readonly z: number }
  /**
   * DEV-432: the player's orientation, SIM space, which the mark points along.
   * Absent or null keeps the last heading (north before there was one).
   */
  readonly playerOrientation?: Quat | null
  readonly racers: readonly { readonly x: number; readonly z: number }[]
  /**
   * DEV-373: the ghost the run races, SIM space, or null (none, not released
   * yet, or its lap is over). Absent is null.
   */
  readonly ghost?: { readonly x: number; readonly z: number } | null
  /** Null before the release: there is no race yet, so no place to state. */
  readonly place: LivePlace | null
}

/** What `__ff2.raceMap()` answers. Counts and positions; nothing is a duration. */
export interface RaceMapReport {
  readonly text: string
  readonly place: number | null
  readonly field: number
  readonly racers: number
  readonly cadence: string
  /** Writes admitted — each one a vertex upload of `bytesPerWrite` or less. */
  readonly writes: number
  /** `update` calls where no dot moved a texel and the text held. */
  readonly unchanged: number
  /** Calls where something moved and the cadence withheld the write. */
  readonly skipped: number
  readonly triangles: number
  /** The dynamic tail, the most one write can send: glyphs and dots, both attributes. */
  readonly bytesPerWrite: number
  readonly routePoints: number
  readonly outlinePoints: number
  /** World metres per plate metre. */
  readonly metresPerPlateMetre: number
  readonly layout: RaceMapLayout
  /** The last WRITTEN dots, plate metres: racers in order, then the player. */
  readonly dots: readonly { readonly x: number; readonly y: number }[]
  /** DEV-432: the heading the player's mark was last WRITTEN along, a unit vector on the plate. */
  readonly playerHeading: { readonly x: number; readonly y: number }
  /** DEV-373: the ghost's hollow dot as last written, plate metres, or null when none is drawn. */
  readonly ghost: { readonly x: number; readonly y: number } | null
}

export interface RaceMap {
  readonly object: THREE.Mesh
  update(feed: RaceMapFeed, nowMs: number): void
  /** The panel's cadence; a no-op when it is already in force. */
  setRedraw(next: HudRedraw): void
  report(): RaceMapReport
  dispose(): void
}

/** Triangles in one hexagonal dot: a fan of four. */
const HEX_TRIS = 4
/** DEV-432: the player's mark, its ring and then the triangle itself. */
const PLAYER_TRIS = 2
/** Triangles in one HOLLOW hexagon: a quad an edge (DEV-373's ghost). */
const RING_TRIS = 12
/** A hollow dot's wall, as a share of its radius: thick enough to read as a ring, not a smudge. */
const RING_WALL_SHARE = 0.38
/** A unit hexagon's six corners, point up. */
const HEX_X = Array.from({ length: 6 }, (_, i) => Math.cos(Math.PI / 2 + (i * Math.PI) / 3))
const HEX_Y = Array.from({ length: 6 }, (_, i) => Math.sin(Math.PI / 2 + (i * Math.PI) / 3))

export const createRaceMap = (spec: RaceMapSpec): RaceMap => {
  const layout = raceMapLayout(spec.size, spec.panelWidth ?? WIDTH, spec.panelHeight ?? HEIGHT)
  const { points: route, finishArc } = courseOutline(spec.line, spec.finish)
  const fit = fitMap(route, layout.area)
  const outline = simplifyPolyline(route, layout.stroke / 2 / fit.scale)
  const racerCount = spec.racerColours.length

  // ── The pool. Static first, so one update range covers the whole dynamic tail.
  const staticTris =
    2 + // the plate
    8 + // its edge, four thin quads
    2 * Math.max(0, outline.length - 1) + // the line, a quad a segment
    (spec.finish ? 2 : 0) // the finish tick
  const glyphStart = staticTris
  const glyphTris = MAX_GLYPHS * QUADS_PER_GLYPH * 2
  // DEV-373: the ghost's hollow dot, UNDER the racers and the player: it is a
  // benchmark, and a ship passing it should be drawn over it. Always allocated
  // and collapsed when there is no ghost, so the buffer never changes size.
  const ghostStart = glyphStart + glyphTris
  const dotStart = ghostStart + RING_TRIS
  // Racers, then the player's ring, then the player — the player LAST, so it
  // is drawn over any racer it is passing. `depthTest` is off, so buffer order
  // is draw order and nothing else. DEV-432: the player is a triangle and its
  // ring, one triangle each.
  const dotTris = racerCount * HEX_TRIS + PLAYER_TRIS
  const mark = playerMark(spec.size, layout.stroke)
  const total = dotStart + dotTris
  const positions = new Float32Array(total * 9)
  const colours = new Float32Array(total * 12)

  const rgba = (css: string) => parseColour(css)
  const ink = {
    plate: rgba(RACE_MAP_INKS.plate),
    edge: rgba(RACE_MAP_INKS.edge),
    line: rgba(RACE_MAP_INKS.line),
    finish: rgba(RACE_MAP_INKS.finish),
    type: rgba(RACE_MAP_INKS.type),
    place: rgba(RACE_MAP_INKS.place),
    ring: rgba(RACE_MAP_INKS.ring),
    player: rgba(RACE_MAP_INKS.player),
    ghost: rgba(RACE_MAP_INKS.ghost),
  }
  const racerInk = spec.racerColours.map((c) => rgba(c ?? RACE_MAP_INKS.racer))

  type Rgba = { r: number; g: number; b: number; a: number }
  const tri = (
    t: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    c: Rgba,
  ): void => {
    const p = t * 9
    positions[p] = ax
    positions[p + 1] = ay
    positions[p + 2] = 0
    positions[p + 3] = bx
    positions[p + 4] = by
    positions[p + 5] = 0
    positions[p + 6] = cx
    positions[p + 7] = cy
    positions[p + 8] = 0
    const q = t * 12
    for (let k = 0; k < 3; k += 1) {
      colours[q + k * 4] = c.r
      colours[q + k * 4 + 1] = c.g
      colours[q + k * 4 + 2] = c.b
      colours[q + k * 4 + 3] = c.a
    }
  }
  /** Four corners in order round the quad, as two triangles. Returns the next free triangle. */
  const quad = (t: number, k: readonly number[], c: Rgba): number => {
    tri(t, k[0] ?? 0, k[1] ?? 0, k[2] ?? 0, k[3] ?? 0, k[4] ?? 0, k[5] ?? 0, c)
    tri(t + 1, k[0] ?? 0, k[1] ?? 0, k[4] ?? 0, k[5] ?? 0, k[6] ?? 0, k[7] ?? 0, c)
    return t + 2
  }
  const rect = (t: number, x0: number, y0: number, x1: number, y1: number, c: Rgba): number =>
    quad(t, [x0, y0, x1, y0, x1, y1, x0, y1], c)
  /**
   * A zero-area triangle with no alpha: absent draws nothing and the vertex
   * count stays fixed, `hud-gauges.ts`'s `collapse` for the same reason.
   */
  const collapse = (t: number): void => {
    positions.fill(0, t * 9, t * 9 + 9)
    colours.fill(0, t * 12, t * 12 + 12)
  }
  /** A hexagon, point up, as a fan of four. Allocates nothing: it runs every write. */
  const hexagon = (t: number, cx: number, cy: number, r: number, c: Rgba): number => {
    for (let i = 0; i < HEX_TRIS; i += 1) {
      tri(
        t + i,
        cx + r * (HEX_X[0] as number),
        cy + r * (HEX_Y[0] as number),
        cx + r * (HEX_X[i + 1] as number),
        cy + r * (HEX_Y[i + 1] as number),
        cx + r * (HEX_X[i + 2] as number),
        cy + r * (HEX_Y[i + 2] as number),
        c,
      )
    }
    return t + HEX_TRIS
  }
  /**
   * DEV-432: one of the player's triangles at (`cx`, `cy`), turned to the
   * heading. `u` runs along it and `v` to its left, which on a y-up plate is
   * (−y, x). Allocates nothing, like `hexagon`.
   */
  const markTriangle = (t: number, s: MarkTriangle, cx: number, cy: number, c: Rgba): void => {
    const hx = heading.x
    const hy = heading.y
    const a = s[0]
    const b = s[1]
    const d = s[2]
    tri(
      t,
      cx + a[0] * hx - a[1] * hy,
      cy + a[0] * hy + a[1] * hx,
      cx + b[0] * hx - b[1] * hy,
      cy + b[0] * hy + b[1] * hx,
      cx + d[0] * hx - d[1] * hy,
      cy + d[0] * hy + d[1] * hx,
      c,
    )
  }
  /** A HOLLOW hexagon: a quad per edge between radius `r` and `r` less its wall. DEV-373. */
  const hollowHexagon = (t: number, cx: number, cy: number, r: number, c: Rgba): number => {
    const inner = r * (1 - RING_WALL_SHARE)
    let at = t
    for (let i = 0; i < 6; i += 1) {
      const j = (i + 1) % 6
      at = quad(
        at,
        [
          cx + r * (HEX_X[i] as number),
          cy + r * (HEX_Y[i] as number),
          cx + r * (HEX_X[j] as number),
          cy + r * (HEX_Y[j] as number),
          cx + inner * (HEX_X[j] as number),
          cy + inner * (HEX_Y[j] as number),
          cx + inner * (HEX_X[i] as number),
          cy + inner * (HEX_Y[i] as number),
        ],
        c,
      )
    }
    return at
  }

  // ── The static part: written once, uploaded once ─────────────────────
  {
    const w = layout.width / 2
    const h = layout.height / 2
    const e = layout.stroke / 2
    let t = 0
    t = rect(t, -w, -h, w, h, ink.plate)
    // The edge, as the panel's plates carry one: four bars inside the rim.
    t = rect(t, -w, h - e, w, h, ink.edge)
    t = rect(t, -w, -h, w, -h + e, ink.edge)
    t = rect(t, -w, -h + e, -w + e, h - e, ink.edge)
    t = rect(t, w - e, -h + e, w, h - e, ink.edge)
    // The line: a quad a segment, each carried half a stroke past both ends so
    // the corners close. OPAQUE ink, so the overlap at a joint cannot show as a
    // darker knot the way a translucent stroke's would.
    const hw = layout.stroke / 2
    const a = { x: 0, y: 0 }
    const b = { x: 0, y: 0 }
    for (let i = 0; i + 1 < outline.length; i += 1) {
      const p = outline[i] as { x: number; z: number }
      const q = outline[i + 1] as { x: number; z: number }
      mapPoint(fit, p.x, p.z, a)
      mapPoint(fit, q.x, q.z, b)
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len === 0) {
        collapse(t)
        collapse(t + 1)
        t += 2
        continue
      }
      const dx = ((b.x - a.x) / len) * hw
      const dy = ((b.y - a.y) / len) * hw
      t = quad(
        t,
        [
          a.x - dx - dy,
          a.y - dy + dx,
          b.x + dx - dy,
          b.y + dy + dx,
          b.x + dx + dy,
          b.y + dy - dx,
          a.x - dx + dy,
          a.y - dy - dx,
        ],
        ink.line,
      )
    }
    if (spec.finish) {
      // A bar ACROSS the line where the race ends, in the panel's accent.
      routeAt(spec.line.route, finishArc, _at)
      routeTangentAt(spec.line.route, finishArc, _tangent)
      const c = mapPoint(fit, _at.x, _at.z)
      const tl = Math.hypot(_tangent.x, _tangent.z) || 1
      const along = { x: _tangent.x / tl, y: _tangent.z / tl }
      const half = spec.size.dotMetres * FINISH_PER_DOT
      const thick = layout.stroke * FINISH_PER_STROKE
      t = quad(
        t,
        [
          c.x - along.y * half - along.x * thick,
          c.y + along.x * half - along.y * thick,
          c.x + along.y * half - along.x * thick,
          c.y - along.x * half - along.y * thick,
          c.x + along.y * half + along.x * thick,
          c.y - along.x * half + along.y * thick,
          c.x - along.y * half + along.x * thick,
          c.y + along.x * half + along.y * thick,
        ],
        ink.finish,
      )
    }
  }
  for (let t = glyphStart; t < total; t += 1) collapse(t)

  const geometry = new THREE.BufferGeometry()
  const positionAttr = new THREE.BufferAttribute(positions, 3)
  positionAttr.setUsage(THREE.DynamicDrawUsage)
  const colourAttr = new THREE.BufferAttribute(colours, 4)
  colourAttr.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttr)
  // itemSize 4 so three defines `USE_COLOR_ALPHA` and the plate keeps the
  // panel's 0.86 — the same argument `hud-gauges.ts` makes for its tracks.
  geometry.setAttribute('color', colourAttr)
  // Set once from the plate: the dots move inside it and a sphere computed from
  // one frame's dots would be wrong for the next.
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.hypot(layout.width, layout.height) / 2,
  )

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // `render/tone.ts`'s line: a surface that is UI is not tone-mapped. It is
    // also the flag `bloom.ts`'s `classify()` moves onto `UI_LAYER` (layer 3,
    // stereo — never 1 or 2, which are the eyes, DEV-141), so removing it
    // would put the map in the world pass on a monitor. The panel and the
    // gauges rest on the same flag; `race-map.test.ts` asserts `isUiObject`.
    toneMapped: false,
    depthWrite: false,
    // The panel's reason, and in a headset its only mechanism: one pass, no
    // depth clear, and a console that would otherwise occlude the plate's
    // lower edge. See `hud.ts`'s material.
    depthTest: false,
    // Both faces, because the quads are wound both ways (a stroke's corners go
    // round clockwise, a rectangle's anticlockwise) and a culled face is a
    // piece of map that silently is not there. And in ONE pass: three draws a
    // transparent DoubleSide material TWICE, back faces then front
    // (`WebGLRenderer.js:2133`), which the first e2e run measured as two draw
    // calls for this mesh. Nothing here overlaps itself in depth — it is flat
    // and depth-free — so the two-pass ordering buys nothing.
    side: THREE.DoubleSide,
    forceSinglePass: true,
  })

  const object = new THREE.Mesh(geometry, material)
  object.name = 'race-map'
  // After the panel's 10, beside the gauges' 11. The plate does not overlap
  // either, so this orders nothing today; it is the number that keeps it so.
  object.renderOrder = 11
  object.position.set(layout.offsetX, 0, 0)

  // ── The moving part ─────────────────────────────────────────────────────
  const budget = createHudRedrawBudget(spec.redraw ?? HUD_REDRAW_DEFAULT)
  const dotCount = racerCount + 1
  /** The last WRITTEN dot per slot, in texels; the player is the last slot. */
  const texels = new Int32Array(dotCount * 2)
  const written = new Float64Array(dotCount * 2)
  let everWritten = false
  let text = ''
  let writtenText: string | null = null
  let lastPlace: LivePlace | null = null
  let writes = 0
  let unchanged = 0
  let skipped = 0
  const scratch = { x: 0, y: 0 }
  /**
   * DEV-373: the ghost's dot this frame, and as last written — plate metres,
   * and texels for the compare. `on` false is no ghost drawn. Mutated in place:
   * this runs every frame, and `hexagon` allocates nothing for the same reason.
   */
  const ghostNow = { on: false, x: 0, y: 0 }
  const ghostWritten = { on: false, x: 0, y: 0, tx: 0, ty: 0 }
  /**
   * DEV-432: the player's heading on the plate this frame and as last written,
   * a unit vector; and its TIP's offset from the centre in texels, as written.
   * North until a feed says otherwise. The tip is the compare, for the same
   * reason the dots compare in texels: a turn that moves no pixel is no write.
   */
  const heading = { x: 0, y: 1 }
  const headingWritten = { x: 0, y: 1, tx: 0, ty: 0 }
  const headingScratch = { x: 0, y: 1 }
  const tipU = mark.fill[0][0]
  const clampX = (x: number) => Math.max(layout.area.minX, Math.min(layout.area.maxX, x))
  const clampY = (y: number) => Math.max(layout.area.minY, Math.min(layout.area.maxY, y))
  /** This frame's dots, plate metres — filled before the compare, written after. */
  const now = new Float64Array(dotCount * 2)

  const writeGlyphs = (s: string): void => {
    let t = glyphStart
    let x = layout.glyphLeft
    const h = layout.glyphHeight
    for (let i = 0; i < s.length && i < MAX_GLYPHS; i += 1) {
      const ch = s[i] as string
      // The place itself in the accent; `P` and the field in the type ink.
      const c = i > 0 && ch !== '/' && s.indexOf('/') > i ? ink.place : ink.type
      for (const k of glyphQuads(ch, x, layout.glyphBottom, h)) t = quad(t, k, c)
      x += GLYPH_ADVANCE * h
    }
    for (; t < ghostStart; t += 1) collapse(t)
  }

  const writeGhost = (): void => {
    if (!ghostNow.on) {
      for (let t = ghostStart; t < dotStart; t += 1) collapse(t)
      return
    }
    // A racer's size, so it reads as one more ship; hollow, so it reads as none.
    hollowHexagon(ghostStart, ghostNow.x, ghostNow.y, spec.size.dotMetres / 2, ink.ghost)
  }

  const writeDots = (): void => {
    let t = dotStart
    for (let i = 0; i < racerCount; i += 1) {
      t = hexagon(
        t,
        now[i * 2] as number,
        now[i * 2 + 1] as number,
        spec.size.dotMetres / 2,
        racerInk[i] as Rgba,
      )
    }
    const px = now[racerCount * 2] as number
    const py = now[racerCount * 2 + 1] as number
    // DEV-432: the ring, then the triangle over it, along the heading.
    markTriangle(t, mark.ring, px, py, ink.ring)
    markTriangle(t + 1, mark.fill, px, py, ink.player)
  }

  return {
    object,
    update(feed, nowMs) {
      text = placeText(feed.place)
      lastPlace = feed.place
      let moved = !everWritten
      for (let i = 0; i < dotCount; i += 1) {
        const ship = i < racerCount ? feed.racers[i] : feed.player
        if (!ship) continue
        mapPoint(fit, ship.x, ship.z, scratch)
        // Clamped to the area: a ship that has left the course's box — the
        // racers climb away after the finish (`FLY_OUT_CLIMB`) and fly on — sits
        // on the rim rather than off the plate.
        const x = clampX(scratch.x)
        const y = clampY(scratch.y)
        now[i * 2] = x
        now[i * 2 + 1] = y
        const tx = Math.round(x * PIXELS_PER_METRE)
        const ty = Math.round(y * PIXELS_PER_METRE)
        if (tx !== texels[i * 2] || ty !== texels[i * 2 + 1]) moved = true
      }
      // DEV-432: the heading, and whether the mark's tip turned a texel about
      // its centre since the last write. A nose straight up or down has no
      // heading, and the mark keeps the last one.
      const q = feed.playerOrientation ?? null
      if (q && plateHeading(q, headingScratch)) {
        heading.x = headingScratch.x
        heading.y = headingScratch.y
      }
      if (
        Math.round(tipU * heading.x * PIXELS_PER_METRE) !== headingWritten.tx ||
        Math.round(tipU * heading.y * PIXELS_PER_METRE) !== headingWritten.ty
      ) {
        moved = true
      }
      // DEV-373: the ghost, the same way; appearing and going count as moving.
      const g = feed.ghost ?? null
      ghostNow.on = g !== null
      if (g) {
        mapPoint(fit, g.x, g.z, scratch)
        ghostNow.x = clampX(scratch.x)
        ghostNow.y = clampY(scratch.y)
        const tx = Math.round(ghostNow.x * PIXELS_PER_METRE)
        const ty = Math.round(ghostNow.y * PIXELS_PER_METRE)
        if (!ghostWritten.on || tx !== ghostWritten.tx || ty !== ghostWritten.ty) moved = true
      } else if (ghostWritten.on) {
        moved = true
      }
      const retext = text !== writtenText
      if (!moved && !retext) {
        unchanged += 1
        return
      }
      if (!budget.admit(true, nowMs)) {
        skipped += 1
        return
      }
      if (retext) {
        writeGlyphs(text)
        writtenText = text
      }
      writeGhost()
      writeDots()
      for (let i = 0; i < dotCount * 2; i += 1) {
        written[i] = now[i] as number
        texels[i] = Math.round((now[i] as number) * PIXELS_PER_METRE)
      }
      ghostWritten.on = ghostNow.on
      ghostWritten.x = ghostNow.x
      ghostWritten.y = ghostNow.y
      ghostWritten.tx = Math.round(ghostNow.x * PIXELS_PER_METRE)
      ghostWritten.ty = Math.round(ghostNow.y * PIXELS_PER_METRE)
      headingWritten.x = heading.x
      headingWritten.y = heading.y
      headingWritten.tx = Math.round(tipU * heading.x * PIXELS_PER_METRE)
      headingWritten.ty = Math.round(tipU * heading.y * PIXELS_PER_METRE)
      everWritten = true
      // Only the tail moves: glyphs when the text did, the ghost and the dots
      // always. The plate and the line went up once with the geometry and are
      // never re-sent.
      const from = retext ? glyphStart : ghostStart
      positionAttr.addUpdateRange(from * 9, (total - from) * 9)
      colourAttr.addUpdateRange(from * 12, (total - from) * 12)
      positionAttr.needsUpdate = true
      colourAttr.needsUpdate = true
      writes += 1
    },
    setRedraw(next) {
      budget.set(next)
    },
    report() {
      const dots: { x: number; y: number }[] = []
      for (let i = 0; i < dotCount; i += 1) {
        dots.push({ x: written[i * 2] as number, y: written[i * 2 + 1] as number })
      }
      return {
        text,
        place: lastPlace?.place ?? null,
        field: lastPlace?.field ?? 0,
        racers: racerCount,
        cadence: describeHudRedraw(budget.policy),
        writes,
        unchanged,
        skipped,
        triangles: total,
        bytesPerWrite: (total - glyphStart) * (9 + 12) * Float32Array.BYTES_PER_ELEMENT,
        routePoints: route.length,
        outlinePoints: outline.length,
        metresPerPlateMetre: 1 / fit.scale,
        layout,
        dots,
        playerHeading: { x: headingWritten.x, y: headingWritten.y },
        ghost: ghostWritten.on ? { x: ghostWritten.x, y: ghostWritten.y } : null,
      }
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
