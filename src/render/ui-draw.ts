// src/render/ui-draw.ts: what the plates draw with that is not about three.
//
// THREE-FREE, so `tv-panel-layout.ts` (which draws against a fake context in
// node) can import it as well as the plates.

import { UI_ACCENT, UI_PLATE, UI_PLATE_EDGE, UI_SELECTED_FILL, uiFont } from '@/render/ui-tokens'

/** The context calls {@link drawPlate} and {@link drawSelectedRow} make: narrow, so a test's fake satisfies it. */
export type PlateContext = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'rect' | 'fill' | 'stroke' | 'fillRect' | 'fillStyle' | 'strokeStyle' | 'lineWidth'
>

export interface BroadcastPlate {
  /** The accent bar's width at the plate's left edge, pixels. Per panel and visible: pass it. */
  readonly bar: number
  /** The hairline's width, pixels. Also per panel. */
  readonly lineWidth: number
  /** Default {@link UI_PLATE}. */
  readonly fill?: string
  /** Default {@link UI_PLATE_EDGE}. */
  readonly stroke?: string
  /** The bar's ink. Default {@link UI_ACCENT}. */
  readonly accent?: string
}

/**
 * A plate's backing, in the broadcast look (DEV-647): a flat rectangle over the
 * whole `w` x `h` canvas, filled, a hairline inside its edge, and ONE hard accent
 * bar down its left side. No rounded corners, no gradient, no glass.
 */
export const drawPlate = (ctx: PlateContext, w: number, h: number, plate: BroadcastPlate): void => {
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.fillStyle = plate.fill ?? UI_PLATE
  ctx.fill()
  // Inset by half the line so the hairline is whole inside the canvas, not clipped at it.
  ctx.beginPath()
  ctx.rect(plate.lineWidth / 2, plate.lineWidth / 2, w - plate.lineWidth, h - plate.lineWidth)
  ctx.lineWidth = plate.lineWidth
  ctx.strokeStyle = plate.stroke ?? UI_PLATE_EDGE
  ctx.stroke()
  ctx.fillStyle = plate.accent ?? UI_ACCENT
  ctx.fillRect(0, 0, plate.bar, h)
}

/**
 * The selected row's mark, in the same look: the accent wash over the row's box
 * and a hard accent bar at its left edge (where the plate's own bar is).
 */
export const drawSelectedRow = (
  ctx: PlateContext,
  x: number,
  y: number,
  w: number,
  h: number,
  bar: number,
): void => {
  ctx.fillStyle = UI_SELECTED_FILL
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = UI_ACCENT
  ctx.fillRect(x, y, bar, h)
}

/**
 * Greedy wrap of `parts` against a measured width, joined by `joiner`.
 *
 * A single part longer than the line still gets its own line rather than being
 * dropped: better to overflow one word than to lose it silently. `measure` is
 * injected so a test needs no canvas. Empty parts are kept as given (the caller
 * decides whether they mean anything).
 */
export const wrapParts = (
  parts: readonly string[],
  joiner: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] => {
  const lines: string[] = []
  let line = ''
  for (const part of parts) {
    const candidate = line ? `${line}${joiner}${part}` : part
    if (line && measure(candidate) > maxWidth) {
      lines.push(line)
      line = part
    } else line = candidate
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Greedy word wrap against a measured width.
 *
 * Exported because it is the only thing in `briefing.ts` that can be wrong in a
 * way a screenshot would not show: a wrap that overflows the plate is obvious,
 * but one that drops a word is not.
 */
export const wrapText = (
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] => wrapParts(text.split(/\s+/).filter(Boolean), ' ', maxWidth, measure)

/** DEV-854: the word on the tag every AI rival wears, wherever racers are listed. */
export const AI_TAG = 'AI'

/** The context calls {@link drawTag} makes. */
export type TagContext = Pick<
  CanvasRenderingContext2D,
  | 'fillText'
  | 'strokeRect'
  | 'font'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'textAlign'
  | 'textBaseline'
> & { measureText(text: string): { readonly width: number } }

/** The tag's drawn width for a type `size` px: its word plus the padding. */
export const tagWidth = (ctx: Pick<TagContext, 'measureText' | 'font'>, size: number): number => {
  ctx.font = uiFont(size, 700)
  return ctx.measureText(AI_TAG).width + size * 0.7
}

/**
 * DEV-854: a small outlined tag (`AI`) at `x`, vertically centred on `mid`, in
 * `ink`. Returns the width it took, so a caller can reserve it. The caller
 * resets the font and alignment it needs afterwards.
 */
export const drawTag = (
  ctx: TagContext,
  x: number,
  mid: number,
  size: number,
  ink: string,
): number => {
  const w = tagWidth(ctx, size)
  const h = size * 1.2
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = ink
  ctx.lineWidth = Math.max(1, size * 0.07)
  ctx.strokeRect(x, mid - h / 2, w, h)
  ctx.fillStyle = ink
  ctx.fillText(AI_TAG, x + size * 0.35, mid + size * 0.03)
  return w
}
