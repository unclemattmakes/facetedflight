// src/render/ui-tokens.ts: the UI's palette, type and scale, in one place.
//
// DEV-647. Matt, 2026-10-05: *"i'd love the overall UI aesthetic to be
// clean-broadcast. as if it was for a popular action sports broadcast."* Read
// as: flat solid plates with one hard accent edge, no pills, no gradients or
// glass, a tight condensed sans in caps for labels, tabular figures for every
// number, generous margins, elements that slide or wipe in rather than pop.
//
// Eleven files used to retype six colours and a monospace stack as
// file-private constants. D35 settled the question that comment was guarding
// (menus always wear Anniversary), so there is exactly one UI palette and one
// place to retune it, and `tests/unit/ui-token-guard.test.ts` refuses a UI
// colour or font stack typed anywhere else.
//
// ── One face ─────────────────────────────────────────────────────────────────
//
// CRYSTAL (`render/hud-font.ts`, 2016's own HUD face, CC BY-SA 4.0, served
// unmodified from the content bucket) is the UI's face for every label and
// number (DEV-848, Matt, 2026-10-08: *"the UI face should be CRYSTAL, more
// on-brand"*). DEV-647 had chosen Roboto Condensed because its figures are all
// one width and a canvas cannot switch tabular figures on; CRYSTAL's are
// proportional (a 1 is 530 units of 2048, an 8 is 1353), so a number that
// ticks is drawn through `render/ui-digits.ts`, which seats each digit in a
// fixed cell. CRYSTAL is ONE weight (Regular): `uiFont` names it at 400 once it
// has loaded, because a canvas asked for 700 of a one-weight family fakes a
// bold that smears its thin strokes. Until it lands (a 13 KB file that has
// normally arrived before the first plate paints) the fallback stack draws at
// the weight the painter asked for, and `render/ui-font.ts` owes every plate
// one repaint.
//
// THREE-FREE ON PURPOSE. `tv-panel-layout.ts` is DOM-free and three-free and
// draws against a fake context in node, so the strings live here and a colour
// that a three material wants as a number (`menu-reticle.ts`) is exported as
// its own `_HEX` from the same source.
//
// What is NOT here, deliberately, and must stay local: the variants that are
// distinct looks and not drift. The loading scene has its own palette; the HUD's
// plate is the cockpit's inset teal; the editor bench's ink is the room's; and
// the developer instruments (the perf plate and its DOM panel, `?lookdev=1`,
// the editor desk) keep a monospace because they are columns of numbers a
// developer diffs by eye. `tests/unit/ui-token-guard.test.ts` lists each of
// those, with the reason, so an exception is a visible row and not a habit.

import { HUD_FONT_FAMILY, hudFontLoaded } from './hud-font'

// ── colour ──────────────────────────────────────────────────────────────────

/** The HUD's ink: labels, values, anything the player reads. */
export const UI_INK = '#f2f7fb'
/** Secondary ink: notes, footers, an option that does nothing right now. */
export const UI_DIM = '#9fb4c4'
/** The one accent (gold): titles, the selected row, a setting's value. */
export const UI_ACCENT = '#ffcf7a'
/** A gain: a gap closed, a place won, a time under the target. */
export const UI_GAIN = '#8ef0a8'
/** A loss: a gap opened, a streak broken. The HUD's muted blue-grey since 2016's port. */
export const UI_LOSS = '#8fb3bd'
/** An alarm: an empty tank, a failed row. Warm, so it is not read as a loss. */
export const UI_ALERT = '#ff8a5c'
/** The instrument cyan: gauges, a satisfied checklist row. */
export const UI_CYAN = '#8ad8e0'
/** A plate's backing: flat and solid (a broadcast bug, not glass). */
export const UI_PLATE = 'rgba(10, 22, 30, 0.94)'
/** The plate's hairline: a faint ink edge all round, under the accent bar. */
export const UI_PLATE_EDGE = 'rgba(242, 247, 251, 0.16)'
/** A faint dim ink (key outlines, a disabled mark) and a cyan wash (a key's fill). */
export const UI_DIM_FAINT = 'rgba(159, 180, 196, 0.45)'
export const UI_CYAN_WASH = 'rgba(138, 216, 224, 0.08)'
/** The wash behind the selected row (the accent at 16 %). */
export const UI_SELECTED_FILL = 'rgba(255, 207, 122, 0.16)'
/** The hangar's holotable detail ink (a cold white-cyan, the holograms' own light). */
export const UI_HOLO = '#bdf3ff'
/** A dead plate's inks: the room's recessive greys, taken two steps down from dim. */
export const UI_DEAD = '#66737f'
export const UI_DEAD_DIM = '#4f5a65'
/** An empty bar's track on a variant label (dim at 25 %). */
export const UI_DIM_TRACK = 'rgba(159, 180, 196, 0.25)'
/** The dark pill-less backing behind every line of a holotable label, and its outline. */
export const UI_LABEL_BACK = 'rgba(4, 8, 14, 0.8)'
export const UI_LABEL_HALO = 'rgba(4, 8, 14, 0.95)'
/** A full-screen scrim: the page's ground at 94 % (the turn-your-phone screen). */
export const UI_SCRIM = 'rgba(7, 11, 18, 0.94)'
/** The broadcast "live" red: the LIVE bug's plate. */
export const UI_LIVE = '#e0283f'
/** Ink for text sitting ON a light plate (the cyan SHARED LAP bug). */
export const UI_INK_DARK = '#0b1a20'
/** Ink for text sitting ON the accent (a gold bug's words). */
export const UI_ON_ACCENT = '#1a1206'

/** The accent and dim ink as the `0x` numbers a three material takes. */
export const UI_ACCENT_HEX = 0xffcf7a
export const UI_DIM_HEX = 0x9fb4c4

// ── type ────────────────────────────────────────────────────────────────────

/** The UI face's CSS family name: CRYSTAL, as `hud-font.ts` registers it. */
export const UI_FONT_FAMILY = HUD_FONT_FAMILY

/**
 * The UI's face as a CSS font-family list: the broadcast sans, then the
 * platform's own narrow and ordinary sans faces for a glyph it lacks (an
 * envelope, an arrow) or for the moments before it has loaded.
 */
export const UI_STACK = `"${UI_FONT_FAMILY}", "Arial Narrow", "Segoe UI", ui-sans-serif, system-ui, sans-serif`

/**
 * The developer instruments' face: columns of numbers somebody diffs by eye
 * (`render/perf-plate.ts`). Not a UI face: nothing a player reads wears it.
 */
export const UI_MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * A canvas `font` string in the UI's face. Bold by default while the fallback
 * stands in (caps labels read heavier on a plate); CRYSTAL is named at 400, its
 * only weight, the moment it has loaded.
 */
export const uiFont = (px: number, weight = 700): string =>
  `${hudFontLoaded() ? 400 : weight} ${px}px ${UI_STACK}`

/**
 * The type scale: THREE sizes (and one hero), as ratios of a surface's title size. A painter
 * keeps its own title size (a pause plate and a hangar label sit at different
 * distances and texel densities) and derives the other two from it, so a
 * label is always 0.7 of its title and a sub-line 0.46, on every surface.
 */
export const UI_TYPE_RATIO = { hero: 1.4, title: 1, label: 0.7, sub: 0.46 } as const

/**
 * The floor under a sub-line, in METRES of em on the plate. The ratio alone
 * puts a sub-line at 0.46 of a title, which on a small plate is a size nobody
 * can read at arm's length in a headset: 0.017 m is 24 px at the plates'
 * 1400 px per metre (`UI_PIXELS_PER_METRE`), the readable floor ART_DIRECTION
 * names for a headset. The floor wins where the ratio is smaller.
 */
export const UI_SUB_FLOOR_M = 0.017

export interface UiType {
  /** One display moment per surface (the medal word, a position number): 1.4 of the title. */
  readonly hero: number
  readonly title: number
  readonly label: number
  readonly sub: number
}

/**
 * The three sizes for a surface whose title is `titlePx` pixels tall on a canvas
 * of `pxPerM` pixels per metre. Never rounds: `uiFont` takes the number as given
 * and a painter that wants whole pixels rounds its own.
 */
export const uiType = (titlePx: number, pxPerM: number): UiType => ({
  hero: titlePx * UI_TYPE_RATIO.hero,
  title: titlePx,
  label: titlePx * UI_TYPE_RATIO.label,
  sub: Math.max(titlePx * UI_TYPE_RATIO.sub, UI_SUB_FLOOR_M * pxPerM),
})
