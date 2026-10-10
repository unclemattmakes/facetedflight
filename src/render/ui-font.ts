// src/render/ui-font.ts: when the UI's face is in. DEV-647, reworked by DEV-848.
//
// The face (`ui-tokens.ts`'s `UI_FONT_FAMILY`) is CRYSTAL, which `hud-font.ts`
// loads through the FontFace API at boot (`boot/app.ts`). A canvas does not
// wait for a font: a `fillText` in a family that has not loaded draws the
// fallback and stays that way until something draws again. So a plate that
// cares owes itself one repaint when CRYSTAL lands, and `uiFontEpoch` is the
// number its redraw signature includes: 0 until the load has settled (loaded or
// failed), then 1, so its next update redraws once.
//
// Nothing here loads anything. The old `loadUiFont` asked for two Roboto Condensed
// weights from this origin; CRYSTAL is one file from the content bucket, and
// there is exactly one place that fetches it.

import { type HudFontState, hudFontState } from '@/render/hud-font'
import { UI_FONT_FAMILY } from '@/render/ui-tokens'

const settled = (s: HudFontState): boolean => s === 'loaded' || s === 'failed'

/** 0 until the CRYSTAL load has settled (either way), then 1. Put it in a plate's redraw signature. */
export const uiFontEpoch = (): number => (settled(hudFontState()) ? 1 : 0)

// ── glyph fallback (DEV-883) ────────────────────────────────────────────────
//
// CRYSTAL is a small face: 116 code points, no © or · or an em-dash or ellipsis
// or arrow, and a "?" it does hold but draws as a P at the note size ("NEW
// HERE?" was photographed as "NEW HEREP"). A canvas falls back PER GLYPH down
// the font stack, so a character the file lacks is already drawn by the next
// family (`UI_STACK`: Arial Narrow, Segoe UI, the system face); and the one
// character it holds and draws badly is cut out of the FontFace itself
// (`hud-font.ts`'s `HUD_FONT_BAD_GLYPHS`, a `unicode-range`), so it falls the
// same way. `tests/unit/ui-glyph-coverage.test.ts` reads CRYSTAL's cmap and
// sweeps the player-facing string literals: a character CRYSTAL lacks must be
// named HERE, so a new one is a decision somebody made rather than an accident
// a screenshot finds.

/**
 * The non-ASCII characters the UI's strings use that CRYSTAL has no glyph for,
 * written as escapes (the repo has no em-dashes): em-dash, middle dot, ellipsis,
 * box rule, copyright, right single quote, envelope, left and right arrow,
 * diamond, trigram, multiplication X. They draw in the fallback face.
 */
export const UI_FALLBACK_CHARS =
  '\u2014\u00b7\u2026\u2500\u00a9\u2019\u2709\u2190\u2192\u25c6\u2630\u2715'

// ── caps ────────────────────────────────────────────────────────────────────
//
// CRYSTAL is a capitals face. Its lowercase glyphs are a degenerate cut: the
// stem of a d is gone and an i is a bare sliver, so "Edition" reads "Edtion"
// (photographed, DEV-848). 2016's HUD only ever set it in capitals, and the UI's
// painters were written for a face with a lowercase (a few hundred `fillText`
// calls in a dozen files, many of them measuring the same string first). So the
// 2-D context itself sets text in capitals when, and only when, the font it was
// given names the UI's stack: `fillText`, `strokeText` and `measureText` all see
// the uppercased string, so a painter's width maths and its drawing still agree.
// The HUD's own `hudFace` stack (Bahnschrift behind CRYSTAL, never "Arial
// Narrow") and every other face are left alone. Installed once at boot.

/** The head of the UI's stack: CRYSTAL, then "Arial Narrow" (the HUD's own stack has Bahnschrift there). */
const UI_STACK_HEAD = `"${UI_FONT_FAMILY}", "Arial Narrow"`

/** True when a canvas `font` string is the UI's stack (as `uiFont` writes it). */
export const isUiFont = (font: string): boolean => font.includes(UI_STACK_HEAD)

/**
 * DEV-894's measuring instrument: when a page has set `globalThis.__ff2TextLog` to a
 * Map, every `fillText` records, per canvas, how many characters were set at each
 * font size (canvas px). The phone sweep (`tests/e2e/phone-plates.spec.ts`) reads it
 * with `__ff2.uiText()` to say how big a plate's text is on the glass. Off unless a
 * page asks, and the game draws the same either way.
 */
export type TextLog = Map<unknown, Map<number, number>>

const logText = (
  ctx: { font: string; canvas?: unknown; measureText?: (t: string) => unknown },
  text: string,
  max?: number,
): void => {
  const log = (globalThis as { __ff2TextLog?: TextLog }).__ff2TextLog
  if (!log || ctx.canvas === undefined) return
  const px = /(\d+(?:\.\d+)?)px/.exec(ctx.font)
  if (!px) return
  const size = Math.round(Number(px[1]) * 10) / 10
  const sizes = log.get(ctx.canvas) ?? new Map<number, number>()
  log.set(ctx.canvas, sizes)
  sizes.set(size, (sizes.get(size) ?? 0) + text.length)
  // The widest line drawn on the canvas, canvas px (squeezed to `max` as `fillText` does).
  const widths = (globalThis as { __ff2TextWidth?: Map<unknown, number> }).__ff2TextWidth
  if (widths && ctx.measureText) {
    const w = (ctx.measureText(text) as { width: number }).width
    const drawn = max === undefined ? w : Math.min(w, max)
    widths.set(ctx.canvas, Math.max(widths.get(ctx.canvas) ?? 0, drawn))
  }
}

/** Forget a canvas's measured text extent before it is painted again (the sweep's overlap check). */
export const forgetTextExtent = (canvas: unknown): void => {
  ;(globalThis as { __ff2TextWidth?: Map<unknown, number> }).__ff2TextWidth?.delete(canvas)
}

interface TextProto {
  font: string
  canvas?: unknown
  fillText: (text: string, x: number, y: number, maxWidth?: number) => void
  strokeText: (text: string, x: number, y: number, maxWidth?: number) => void
  measureText: (text: string) => unknown
}

const PATCHED = Symbol.for('ff2.uiCaps')

/**
 * Patch `fillText`, `strokeText` and `measureText` on each prototype given so
 * UI-stack text is set in capitals. Idempotent per prototype.
 */
export const installUiCaps = (protos: readonly object[]): void => {
  for (const proto of protos) {
    const p = proto as TextProto & { [PATCHED]?: true }
    if (p[PATCHED]) continue
    p[PATCHED] = true
    for (const name of ['fillText', 'strokeText'] as const) {
      const original = p[name]
      p[name] = function (this: TextProto, text: string, x: number, y: number, max?: number) {
        const t = isUiFont(this.font) ? text.toUpperCase() : text
        if (name === 'fillText') logText(this, t, max)
        if (max === undefined) original.call(this, t, x, y)
        else original.call(this, t, x, y, max)
      }
    }
    const measure = p.measureText
    p.measureText = function (this: TextProto, text: string) {
      return measure.call(this, isUiFont(this.font) ? text.toUpperCase() : text)
    }
  }
}

/** The browser's 2-D context prototypes (the canvas and the offscreen one), where they exist. */
export const installUiCapsInBrowser = (): void => {
  const g = globalThis as unknown as Record<string, { prototype?: object } | undefined>
  const protos = ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']
    .map((n) => g[n]?.prototype)
    .filter((p): p is object => p !== undefined)
  installUiCaps(protos)
}
