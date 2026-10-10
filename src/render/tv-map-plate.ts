// src/render/tv-map-plate.ts: the broadcast's mini-map and the followed racer's
// numbers. DEV-866 (Matt, 2026-10-08: *"i'd like to see a mini-map to have
// context as to where the observed racer is. i'd love to see their speed and
// any interesting timing information."*).
//
// One plate, bottom left on a flat screen: the course on the left with every
// racer a dot and the followed one ringed in the accent, and on the right the
// followed racer's name, speed, place, gap to the leader, last split and the
// race clock. In CRYSTAL, on the same plate and palette as the standings board.
//
// The map REUSES the player's race map's geometry (`render/race-map.ts`:
// `fitMap`, `mapPoint`, `simplifyPolyline`): the same uniform fit, the same
// x-east, z-north orientation, the same Douglas-Peucker thinning. What it does
// not reuse is that file's drawing, which is instanced triangles on a world-space
// HUD panel; this plate is a 2D canvas like the board beside it. TV's world is
// THREE space, where z is south, so a point's z is negated on the way in.
//
// Pure given a 2D context: `tests/unit/tv-map-plate.test.ts` fakes one.

import type { TvMapView } from '@/game/tv/tv-camera'
import { fitMap, type MapFit, mapPoint, simplifyPolyline } from './race-map'
import {
  drawPlate,
  type TvCtx,
  type TvPanelFeed,
  type TvPanelRow,
  tvClock,
  tvDrawnName,
  tvSplitLine,
} from './tv-panel-layout'
import {
  UI_ACCENT as ACCENT,
  UI_DIM as DIM,
  UI_PLATE_EDGE as EDGE,
  uiFont as font,
  UI_INK as INK,
  UI_LOSS as LOSS,
  UI_INK_DARK,
  UI_GAIN as WIN,
} from './ui-tokens'

/** The plate's canvas. */
export const MAP_CANVAS = { width: 560, height: 250 } as const

/** The context the map needs beyond the board's: paths. */
export interface TvMapCtx extends TvCtx {
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number): void
  stroke(): void
  fill(): void
}

/** The map's rectangle on the canvas, and where the figures start. */
const MAP_AREA = { minX: 22, maxX: 252, minY: 22, maxY: 228 } as const
const READOUT_X = 280

/** `412 km/h` as a number and its unit: the HUD's own setting (`edition.hud.speedUnit`). */
export const tvSpeedParts = (
  metresPerSecond: number,
  unit: 'ms' | 'kmh',
): { readonly value: string; readonly unit: string } =>
  unit === 'kmh'
    ? { value: String(Math.round(metresPerSecond * 3.6)), unit: 'km/h' }
    : { value: String(Math.round(metresPerSecond)), unit: 'm/s' }

/** What the plate says about the followed racer, as plain strings. Null fields are not drawn. */
export interface TvMapReadout {
  readonly name: string
  readonly speed: { readonly value: string; readonly unit: string } | null
  /** `P3/6` and the gate it is on, `GATE 8/21`. */
  readonly place: string | null
  readonly gate: string | null
  /** `+1.4 to leader`, `LEADER`, or `74.3s` once it is home; `gain` colours it. */
  readonly gap: string | null
  readonly gapKind: 'win' | 'loss' | 'dim'
  readonly split: string | null
  readonly splitKind: 'win' | 'loss'
  readonly clock: string
}

const secs = (s: number): string => `${s.toFixed(1)}s`

/** The followed row of the feed, or null (Free camera, nobody followed). */
const followedRow = (feed: TvPanelFeed): TvPanelRow | null =>
  feed.followed === null ? null : (feed.rows.find((r) => r.key === feed.followed) ?? null)

/** The plate's words. Pure. */
export const tvMapReadout = (
  feed: TvPanelFeed,
  view: TvMapView,
  unit: 'ms' | 'kmh',
): TvMapReadout => {
  const row = followedRow(feed)
  const racing = feed.phase === 'racing'
  // DEV-886: a racer who is home stops the plate's clock at the time the results
  // card prints for them (one clock), instead of the race clock running on
  // beside a finish the card puts at another time (playtest 2026-10-09: 1:53 vs 2:03.25).
  const clock = !racing
    ? ''
    : row?.status === 'finished' && row.seconds !== null
      ? tvClock(row.seconds)
      : tvClock(feed.raceSeconds)
  if (!row) {
    return {
      name: 'FREE CAMERA',
      speed: null,
      place: null,
      gate: null,
      gap: null,
      gapKind: 'dim',
      split: null,
      splitKind: 'win',
      clock,
    }
  }
  const home = row.status === 'finished'
  const gap = home
    ? row.seconds !== null
      ? secs(row.seconds)
      : null
    : row.gap === undefined || row.gap === null
      ? null
      : row.gap > 0
        ? `+${row.gap.toFixed(1)} to leader`
        : 'LEADER'
  return {
    name: tvDrawnName(row).toUpperCase(),
    speed: view.speed === null || home ? null : tvSpeedParts(view.speed, unit),
    place: row.status === 'dnf' ? null : `#${row.place}/${feed.rows.length}`,
    gate: row.rings !== null && feed.gates > 0 ? `GATE ${row.rings}/${feed.gates}` : null,
    gap,
    gapKind: home ? 'win' : row.gap != null && row.gap > 0 ? 'loss' : 'win',
    split: feed.split ? tvSplitLine(feed.split) : null,
    splitKind: feed.split && feed.split.seconds > 0 ? 'loss' : 'win',
    clock,
  }
}

/** The map's cached fit: it depends on the outline only, and the outline is one array for a whole course. */
const fits = new WeakMap<
  TvMapView['outline'],
  { fit: MapFit; line: readonly { x: number; z: number }[] }
>()

const fitFor = (view: TvMapView): { fit: MapFit; line: readonly { x: number; z: number }[] } => {
  let hit = fits.get(view.outline)
  if (hit) return hit
  // THREE's z runs south; the race map's runs north. Negate it on the way in.
  const points = view.outline.map((p) => ({ x: p.x, z: -p.z }))
  const fit = fitMap(points, MAP_AREA)
  // Half a stroke of tolerance in world metres: every point dropped lay inside the drawn line.
  const line = simplifyPolyline(points, 1.5 / fit.scale)
  hit = { fit, line }
  fits.set(view.outline, hit)
  return hit
}

/** A world point on the canvas, clamped into the map's rectangle. North is up. */
const toCanvas = (fit: MapFit, x: number, z: number): { x: number; y: number } => {
  const p = mapPoint(fit, x, -z)
  return {
    x: Math.max(MAP_AREA.minX, Math.min(MAP_AREA.maxX, p.x)),
    // The fit's y grows with z (north); a canvas's grows down.
    y: Math.max(MAP_AREA.minY, Math.min(MAP_AREA.maxY, MAP_AREA.minY + MAP_AREA.maxY - p.y)),
  }
}

const circle = (ctx: TvMapCtx, x: number, y: number, r: number): void => {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
}

/** Paint the whole plate. */
export const paintMapPlate = (
  ctx: TvMapCtx,
  feed: TvPanelFeed,
  view: TvMapView,
  unit: 'ms' | 'kmh',
): void => {
  const { width: W, height: H } = MAP_CANVAS
  ctx.clearRect(0, 0, W, H)
  drawPlate(ctx, 0, 0, W, H, 0.7)

  // ── the map ──
  if (view.outline.length >= 2) {
    const { fit, line } = fitFor(view)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // The line, with a dark under-stroke so it reads on any plate.
    for (const [width, colour] of [
      [9, UI_INK_DARK],
      [5, DIM],
    ] as const) {
      ctx.strokeStyle = colour
      ctx.lineWidth = width
      ctx.beginPath()
      line.forEach((p, i) => {
        const c = toCanvas(fit, p.x, -p.z)
        if (i === 0) ctx.moveTo(c.x, c.y)
        else ctx.lineTo(c.x, c.y)
      })
      ctx.stroke()
    }
    if (view.finish) {
      const f = toCanvas(fit, view.finish.x, view.finish.z)
      ctx.fillStyle = INK
      ctx.fillRect(f.x - 6, f.y - 6, 12, 12)
      ctx.strokeStyle = UI_INK_DARK
      ctx.lineWidth = 2
      ctx.strokeRect(f.x - 6, f.y - 6, 12, 12)
    }
    // Everyone else first, the followed racer on top.
    const ordered = [...view.dots].sort((a, b) => Number(a.followed) - Number(b.followed))
    for (const d of ordered) {
      const c = toCanvas(fit, d.x, d.z)
      if (d.followed) {
        ctx.fillStyle = UI_INK_DARK
        circle(ctx, c.x, c.y, 15)
        ctx.fill()
        ctx.strokeStyle = ACCENT
        ctx.lineWidth = 4
        circle(ctx, c.x, c.y, 13)
        ctx.stroke()
        ctx.fillStyle = d.colour ?? ACCENT
        circle(ctx, c.x, c.y, 8)
        ctx.fill()
      } else {
        ctx.fillStyle = d.colour ?? INK
        ctx.strokeStyle = UI_INK_DARK
        ctx.lineWidth = 3
        circle(ctx, c.x, c.y, d.finished ? 5 : 7)
        ctx.stroke()
        ctx.fill()
      }
    }
  }

  // ── the figures ──
  const r = tvMapReadout(feed, view, unit)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = EDGE
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(READOUT_X - 14, 20)
  ctx.lineTo(READOUT_X - 14, H - 20)
  ctx.stroke()
  ctx.fillStyle = ACCENT
  ctx.font = font(26, 800)
  ctx.fillText(r.name, READOUT_X, 38, W - READOUT_X - 16)
  if (r.speed) {
    ctx.fillStyle = INK
    ctx.font = font(76, 800)
    ctx.fillText(r.speed.value, READOUT_X, 106)
    const w = ctx.measureText(r.speed.value).width
    ctx.fillStyle = DIM
    ctx.font = font(26, 600)
    ctx.fillText(r.speed.unit, READOUT_X + w + 10, 120)
  }
  ctx.font = font(24, 600)
  let y = 162
  if (r.place || r.gate) {
    ctx.fillStyle = INK
    ctx.fillText([r.place, r.gate].filter(Boolean).join('   '), READOUT_X, y, W - READOUT_X - 16)
    y += 30
  }
  if (r.gap) {
    ctx.fillStyle = r.gapKind === 'win' ? WIN : r.gapKind === 'loss' ? LOSS : DIM
    ctx.fillText(r.gap, READOUT_X, y, W - READOUT_X - 16)
    y += 30
  }
  if (r.split) {
    ctx.fillStyle = r.splitKind === 'win' ? WIN : LOSS
    ctx.font = font(21, 500)
    ctx.fillText(r.split, READOUT_X, y, W - READOUT_X - 16)
  }
  if (r.clock) {
    ctx.textAlign = 'right'
    ctx.fillStyle = DIM
    ctx.font = font(24, 600)
    ctx.fillText(r.clock, W - 18, 38)
  }
}

/** A key that changes when the plate's pixels would: positions to the pixel, the figures as words. */
export const tvMapKey = (feed: TvPanelFeed, view: TvMapView, unit: 'ms' | 'kmh'): string => {
  const r = tvMapReadout(feed, view, unit)
  const { fit } = view.outline.length >= 2 ? fitFor(view) : { fit: null }
  const dots = fit
    ? view.dots
        .map((d) => {
          const c = toCanvas(fit, d.x, d.z)
          return `${Math.round(c.x)},${Math.round(c.y)}${d.followed ? 'f' : ''}${d.finished ? 'h' : ''}`
        })
        .join(';')
    : ''
  return [r.name, r.speed?.value, r.place, r.gate, r.gap, r.split, r.clock, dots].join('|')
}
