// src/render/hud-dash.ts — the readout SET INTO the dashboard, the way 2016 had
// it. DEV-362.
//
// Matt, with two 2016 screenshots: *"see how they're recessed into the
// 'dashboard'?"* The port had drawn one floating plate in front of the dash
// nose since the panel was written; 2016 drew TWO screens inside a bezel the
// cockpit mesh already has.
//
// ── What 2016 did ─────────────────────────────────────────────────────────
//
// `Resources/PlayerShip_SR14_Photon.prefab`, under
// `art_pivot/Art/FirstPerson/FirstPersonHUDRoot/Ship_HUD` — a world-space
// canvas — carries two Image panels:
//
//   panel_shipUI    the UPPER screen: GATES and TIME, two lines
//   panel_speedUI   its child, the lower STRIP: SPEED, on its own text plane
//
// Every RectTransform in that chain has centred anchors and pivots, so each
// local x,y is its `m_AnchoredPosition` and z is `m_LocalPosition.z` (the
// serialised `m_LocalPosition` x,y of a RectTransform are always 0, and a reader
// that trusts them puts the canvas 2.8 m from where it is). Composed through
// `art_pivot` / `Art` / `FirstPerson` (yawed -90, scaled 0.98, 0.98, 0.938) and
// converted to THREE space (z negated), the numbers below are what comes out.
// `tests/unit/hud-recess.test.ts` re-reads the prefab and recomposes them.
//
// ── Where they are, against the mesh ───────────────────────────────────────
//
// `hoverjet-cockpit.glb` has the recess: a near-black glass face (vertex colour
// #0f0f0f, laid back 59 degrees) under a brown hood, between two side walls,
// above a brown sill. 2016's upper screen stands 14-36 mm proud of that glass
// and its top edge tucks 4 mm under the hood; the strip lies 4-7 mm above the
// sill. That is what "recessed" means here, and it is a measurement against the
// shipped mesh, not a placement by eye: the same test fails for the panel the
// port drew before this row.
//
// ── How the port draws it ──────────────────────────────────────────────────
//
// ONE canvas, the panel's own (560 x 203 — nothing about the raster, the upload
// or the cadence changes), and ONE mesh with three quads in it:
//
//   upper screen   canvas rows [0, split)            2016's panel_shipUI
//   speed card     canvas rows [split, swatch)       2016's text_speed plane
//   strip plate    one row of the swatch, stretched  2016's panel_speedUI
//
// One draw call, exactly as before: the three quads share the panel's material.
// The strip is a flat colour, so it samples a four-row swatch at the bottom of
// the canvas rather than costing rows it would only fill with one teal.
//
// The third-person panel (`boot/app.ts`, DEV-128) is NOT this: that is the
// panel on the lens, and it keeps the flat quad and the three plates it always
// had. `hud.ts`'s `setMount` swaps between the two.

import * as THREE from 'three'
import { clamp01 } from '@/sim/math/scalar'
import { hudFace } from './hud-font'

/** Where the readout is mounted: set into the dash, or on the chase camera's lens. */
export type HudMount = 'dash' | 'lens'

// ── 2016's geometry, composed ───────────────────────────────────────────────
//
// TODO(extract): these belong on the generated sheet with `hoverjet.camera.*`,
// like `ART_POSITION` and `ART_SCALE` in `game/flight.ts`. Until then the
// prefab test is their guard.

/**
 * The upper screen, metres: `panel_shipUI`'s 59.507 x 27.95 rect through its
 * own scale (0.006289, 0.0057) and `FirstPerson`'s (0.938 across, 0.98 up —
 * the canvas is yawed +90 under a -90, so the art's z scale lands on its x).
 */
export const DASH_SCREEN = { width: 0.351053, height: 0.156129 } as const

/**
 * The upper screen's pose in 2016, as the preset's placement block spells it:
 * an offset from the EYE and a tilt about x. `content/editions/*.json`'s
 * `cockpit.placement.hud` carries these numbers; this copy exists so the test
 * can say which numbers the recess is.
 */
export const DASH_POSE_2016 = {
  offset: [-0.00443, -0.37397, -0.84614] as const,
  /** `panel_shipUI`'s 51.0551 degrees about x, negated for THREE space. */
  tilt: -0.891079,
} as const

/**
 * The strip (`panel_speedUI`), in the upper screen's own frame: 125 mm down,
 * 68 mm toward the pilot, and folded a further 51.2 degrees about x so that it
 * lies on the sill face-up. Its height is not the upper's, because the parent's
 * scale is not uniform in y and z and the fold turns one into the other.
 */
export const DASH_STRIP = {
  width: 0.351053,
  height: 0.156685,
  position: [-0.00012, -0.12513, 0.06817] as const,
  tilt: -0.893942,
} as const

/**
 * The speed CARD: 2016's `text_speed` / `val_speed` plane, which does not lie
 * on the strip. It is turned back 32.9 degrees toward the pilot about its own
 * centre, so the digits stand up off the sill like a tent card — seen at 38
 * degrees off normal from the seat instead of the strip's 67. The card spans
 * the strip's full width and one text rect's height (142.5 text units).
 */
export const DASH_CARD = {
  width: 0.351053,
  height: 0.084077,
  position: [-0.00012, -0.14324, 0.10742] as const,
  tilt: -0.242062,
} as const

/**
 * 2016's Image colours, `m_Color` on each panel: one teal, two opacities. The
 * sprite is Unity's built-in `UISprite` (fileID 10907), which is engine-locked
 * (hard rule 7) — so the plate is a plain rectangle, which is also what a
 * sliced sprite with a 10 px border looks like at 0.0059 m per canvas unit.
 */
export const DASH_PLATE_UPPER = 'rgba(17, 129, 144, 0.533)'
export const DASH_PLATE_STRIP = 'rgba(17, 129, 144, 0.655)'

/**
 * 2016's text is STRETCHED: every `Text` is scaled 1.585x taller than wide in
 * its own units, which on each panel's metric scale is 1.50x. That is part of
 * the look (a tall, squared face), so the port draws its glyphs to land at the
 * same metric aspect on each quad, whatever the band's texel shape.
 */
export const DASH_TEXT_ASPECT = 1.5

/** The swatch the strip samples, in canvas rows, at the bottom of the canvas. */
export const DASH_SWATCH_ROWS = 4

/**
 * Canvas rows for the upper screen, as a share of the canvas height; the rest,
 * less the swatch, is the speed card. Chosen so both bands spend their texels
 * evenly on what the seat sees: the upper screen subtends ~8.6 degrees of
 * height from the eye and the card ~4.9.
 */
export const DASH_UPPER_SHARE = 0.625

/** The split row between the upper band and the card band, for a canvas `h` tall. */
export const dashSplitRow = (h: number): number => Math.round(h * DASH_UPPER_SHARE)

// ── The layout, as 2016's shares ────────────────────────────────────────────

/**
 * Where 2016's text sits on each panel, as shares of the panel's width and
 * height, out of the same RectTransforms (upper-left aligned, `m_Alignment` 0):
 * labels at 8.8 % and values at 53.9 % across the upper screen, and 15.4 % /
 * 54.2 % across the speed card; the upper lines' tops at 8.0 % and 46.0 % down,
 * one em (97 pt) being 41.6 % of the upper screen's height and 68.1 % of the
 * card's.
 */
const UPPER = {
  labelX: 0.0883,
  valueX: 0.5387,
  lineTops: [0.0803, 0.4596],
  em: 0.4155,
} as const
const CARD = { labelX: 0.1538, valueX: 0.542, em: 0.6807 } as const
/**
 * A line's baseline sits one ASCENT below the top of its text rect: that is
 * where Unity's `Text` puts the first line, and CRYSTAL's ascent is its whole
 * em (hhea ascender 2048 of 2048 units per em; cap height 1434, 0.70 em — read
 * out of the font's own tables). So 2016's caps start 0.3 em below each rect's
 * top, and the speed card's digits stand clear of the upper screen's edge.
 */
const BASELINE = 1

/**
 * What the dash drew in before CRYSTAL could — and still draws in if the font
 * does not load. Upright and heavy, the nearest system face to 2016's.
 */
export const dashFallbackFont = (px: number): string =>
  `700 ${Math.max(1, Math.round(px))}px "Bahnschrift", "Segoe UI", ui-sans-serif, system-ui, sans-serif`

/**
 * The face the dash draws in: 2016's own, CRYSTAL, once it has loaded (DEV-362
 * follow-up, `render/hud-font.ts`), upright at 400 as 2016 drew it.
 */
export const dashFont = (px: number): string => hudFace(px, dashFallbackFont)

// ── What the dash draws ─────────────────────────────────────────────────────

/**
 * Everything the dash draws, already formatted. `render/hud.ts` builds it
 * (`dashContent`) from the same functions the lens panel formats its rows
 * with, so the two mounts cannot disagree about what a reading says — and so
 * this module needs nothing from `hud.ts` and there is no import cycle.
 */
export interface DashContent {
  readonly banner: string | null
  readonly countLabel: string
  readonly countValue: string
  readonly timeLabel: string
  readonly timeValue: string
  /** The last 20 s of a clock that ends the run: the time line in the accent. */
  readonly urgent: boolean
  readonly speedLabel: string
  /** `null` where a DEV-257 gauge has taken the digits. */
  readonly speedValue: string | null
  /**
   * A gate bonus, a medal or a pad hit, in the count line's LABEL slot: the
   * count's number stays where it is (DEV-397).
   */
  readonly event: { readonly text: string; readonly tone: 'gain' | 'loss' } | null
  readonly energy: TankReading | undefined
  /**
   * The gate combo's countdown: the speed chain's cooldown fraction, or absent
   * (no combo banked). Drawn under the GATES line since DEV-615.
   */
  readonly chain: number | undefined
  /**
   * DEV-399. The glider's stall margin on the speed card, or absent — every
   * aircraft but the glider. Optional so every content built before it (the
   * tests' fixtures) still reads as no bar.
   */
  readonly stall?: { readonly margin: number; readonly stalling: boolean } | undefined
  /**
   * Small badges on the time line, right to left: `AUTO`, `x3`, `+4`, and the
   * glider's `STALL` (DEV-399). Drawn in the room the clock leaves, never over
   * it (DEV-397); none once the run is over, since each is a reading of a run
   * still going.
   */
  readonly badges: readonly string[]
}

/** The inks, handed in so this module owns no colour but its two plates. */
export interface DashInks {
  readonly ink: string
  readonly accent: string
  readonly muted: string
  readonly charge: string
  readonly tankTrack: string
  readonly plateEdge: string
  /** DEV-567: the tank while boost is out (`TankInks`). */
  readonly boostOut: string
  readonly boostOutTrack: string
}

/**
 * The 2-D context the dash asks of. `setTransform` is the one call the lens
 * panel never makes: it is how a glyph is widened to land at 2016's aspect on
 * a band whose texels are not square.
 */
export type DashContext = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'setTransform'
  | 'fillStyle'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>

/** Everything positional, for a canvas `w` x `h` with `inset` px kept clear on the upper screen's right. */
export interface DashLayout {
  readonly split: number
  readonly swatchTop: number
  /** Width of the upper screen's text area, px: the canvas less the side plate. */
  readonly area: number
  /** Horizontal pre-stretch per band, so a glyph lands at `DASH_TEXT_ASPECT`. */
  readonly stretchUpper: number
  readonly stretchCard: number
  readonly upperFont: number
  readonly upperBaselines: readonly [number, number]
  readonly upperLabelX: number
  readonly upperValueX: number
  readonly cardFont: number
  readonly cardBaseline: number
  readonly cardLabelX: number
  readonly cardValueX: number
  /** DEV-567: the boost tank's track, top and height in canvas rows. */
  readonly tankY: number
  readonly tankH: number
}

/**
 * DEV-567. With a tank on the upper screen, both of its text lines ride up by
 * this share of the screen's height. 2016's shares leave a quarter-em of air
 * above the count's caps (the font's ascent is its whole em, its caps 0.7) and
 * a sliver below the time line; this moves a little of the first to the
 * second, so the tank gets twice the height DEV-143 gave it and the text keeps
 * its size. Classic draws no tank, so Classic's lines do not move.
 */
export const DASH_TANK_LIFT = 0.07
/** The tank's gap under the time line's baseline, and its height, as shares of the upper screen. */
export const DASH_TANK_GAP = 0.035
export const DASH_TANK_HEIGHT = 0.14

export const dashLayout = (w: number, h: number, inset = 0, tank = false): DashLayout => {
  const split = dashSplitRow(h)
  const swatchTop = h - DASH_SWATCH_ROWS
  const area = Math.max(1, w - Math.max(0, inset))
  // How much taller a canvas pixel is than it is wide, once it is on its quad.
  const texelX = DASH_SCREEN.width / w
  const upperTexelAspect = DASH_SCREEN.height / split / texelX
  const cardTexelAspect = DASH_CARD.height / (swatchTop - split) / texelX
  // A glyph drawn at its natural shape lands `texelAspect` times too tall;
  // widening it by texelAspect / DASH_TEXT_ASPECT leaves 2016's stretch and
  // nothing more.
  const stretchUpper = upperTexelAspect / DASH_TEXT_ASPECT
  const stretchCard = cardTexelAspect / DASH_TEXT_ASPECT
  // With a side plate the text shrinks with the width it has, so a race keeps
  // 2016's proportions in a narrower column rather than running under the map.
  const k = area / w
  const upperEm = UPPER.em * split * k
  const cardH = swatchTop - split
  const lift = tank ? DASH_TANK_LIFT * split : 0
  const b1 = (UPPER.lineTops[1] + UPPER.em * BASELINE) * split - lift
  return {
    split,
    swatchTop,
    area,
    stretchUpper,
    stretchCard,
    upperFont: upperEm,
    upperBaselines: [(UPPER.lineTops[0] + UPPER.em * BASELINE) * split - lift, b1],
    tankY: b1 + DASH_TANK_GAP * split,
    tankH: DASH_TANK_HEIGHT * split,
    upperLabelX: UPPER.labelX * area,
    upperValueX: UPPER.valueX * area,
    cardFont: CARD.em * cardH,
    cardBaseline: split + CARD.em * BASELINE * cardH,
    cardLabelX: CARD.labelX * w,
    cardValueX: CARD.valueX * w,
  }
}

/** Canvas calls one dash repaint makes, predicted — the lens panel's `hudCanvasOps`, for this mount. */
export interface DashCanvasOps {
  readonly total: number
  readonly texts: number
  readonly measures: number
}

/**
 * Predict `drawDash`'s calls for `content`, branch for branch. Held against the
 * real draw through a counting context in `tests/unit/hud-dash.test.ts`, the
 * way `hudCanvasOps` is held in `hud-upload.test.ts`: a prediction that is
 * never measured is the thing that drifts.
 */
export const dashCanvasOps = (content: DashContent): DashCanvasOps => {
  let total = 3 // clearRect, the upper plate, the swatch
  let texts = 0
  let measures = 0
  const text = (n = 1) => {
    total += n
    texts += n
  }
  if (content.banner) {
    total += 2 // setTransform in, setTransform out
    text()
    return { total, texts, measures }
  }
  const measure = () => {
    total += 1
    measures += 1
  }
  total += 2 // the upper band's transform, in and out
  // The count's number, then its label or the event in the label's slot —
  // which is measured, to be fitted rather than squeezed (DEV-397).
  text(2)
  if (content.event) measure()
  text(2) // the time line's label and value
  if (content.badges.length > 0) {
    measure() // the clock, so the badges start where it ends
    text() // the badges, one run
  }
  if (content.chain !== undefined) total += chainRects(content.chain)
  if (content.energy) {
    total += tankRects(content.energy)
    total += 2 // the word's transform, in and out (DEV-555)
    text() // the word
  }
  if (content.stall) total += content.stall.margin > 0 ? 2 : 1
  total += 2 // the card's transform, in and out
  text(content.speedValue === null ? 1 : 2)
  return { total, texts, measures }
}

// ── The boost tank, for both mounts ─────────────────────────────────────────
//
// DEV-567. Matt, 2026-10-02: *"i think i'd rather the bar be taller i still
// don't understand when i have boost or not. it's unclear to me."*
//
// `sim/energy.ts` puts a player in one of five places (DEVIATIONS DEV-567 has
// the table): full, ready and part full, boosting, OUT (ran dry and refilling
// to a quarter, when a press does nothing), and ready but LOW (let go below a
// quarter without running dry, when a press boosts for what is left). The
// last two are both a short bar below a quarter, and before this row the only
// thing between them was the fill's ink, two pale cyans (`CHARGE` and
// `MUTED`) that are one colour at the dash's size in a headset.
//
// So the panel shows THREE states, and the one that matters is a HUE:
//
//   READY    cyan fill on the dark track       a press lights it
//   BOOST    cyan fill on the dark track       lit and burning
//   EMPTY    the whole gauge goes WARM: a      a press does nothing; the
//            warm track, the refill in warm,   refill crosses the mark and
//            and a light mark at the quarter   the gauge turns cyan again
//
// Cyan means you have boost and warm means you do not, at any size, in
// peripheral vision, before the word is read. Chosen by photograph over four
// others (the row lists them and keeps the frames): today's inks made taller,
// a dim refill, a warm refill on the dark track, and the word alone.

/** What the panel is told about the tank: `HudState.energy`'s shape. */
export interface TankReading {
  /** 0..1 of the tank. */
  readonly fraction: number
  /** A press lights it now (`sim/energy.ts`'s `boostAvailable`). */
  readonly available: boolean
  /**
   * DEV-567: lit and burning this tick (`EnergyState.lit`). Only the boost tank
   * reports it; absent (the energy race, the glider's rocket) keeps the word
   * BOOST for an available tank, as before this row.
   */
  readonly burning?: boolean
  /**
   * DEV-567: the share of the tank a dry tank must hold again before boost
   * lights (the edition's `gameplay.energy.reengage`). Absent or 0 draws no mark.
   */
  readonly reengage?: number
}

/** DEV-567: the three states the panel shows. */
export type TankState = 'ready' | 'boosting' | 'out'

export const tankState = (r: TankReading): TankState =>
  !r.available ? 'out' : r.burning ? 'boosting' : 'ready'

export type TankWordText = 'READY' | 'BOOST' | 'EMPTY'

/**
 * The tank's word. DEV-410 follow-up: the tank names itself, inside its own
 * track at the left end. ONE source for both mounts (DEV-555): `render/hud.ts`
 * and `drawDash` both paint through `paintTank`, so the panels cannot say
 * different things at the same moment. DEV-567 splits BOOST into READY (you
 * have it) and BOOST (you are using it); EMPTY is unchanged, the word Matt
 * approved for the wait.
 */
export const tankWord = (r: TankReading): TankWordText => {
  const s = tankState(r)
  if (s === 'out') return 'EMPTY'
  if (r.burning === undefined) return 'BOOST'
  return s === 'boosting' ? 'BOOST' : 'READY'
}

/** The inks the tank paints in, handed in by `hud.ts`, which owns the colours. */
export interface TankInks {
  /** The panel's light type ink: the word on a bare track, and the mark. */
  readonly ink: string
  /** Boost available: the fill. */
  readonly charge: string
  /** The dark track while boost is available, and the word on a lit fill. */
  readonly tankTrack: string
  /** DEV-567: boost out, the refill. */
  readonly boostOut: string
  /** DEV-567: boost out, the track. */
  readonly boostOutTrack: string
}

/** The track's ink for `r`. */
export const tankTrackInk = (r: TankReading, inks: TankInks): string =>
  tankState(r) === 'out' ? inks.boostOutTrack : inks.tankTrack

/** The fill's ink for `r`, or null where nothing is filled. */
export const tankFillInk = (r: TankReading, inks: TankInks): string | null =>
  clamp01(r.fraction) > 0 ? (tankState(r) === 'out' ? inks.boostOut : inks.charge) : null

/**
 * The quarter mark: where on the track (a share of it), only while boost is
 * out, because that is the only state it explains (the refill turns the gauge
 * cyan when it reaches it). Shown in the other states it would sit above a
 * READY low tank and say the opposite of the word.
 */
export const tankMark = (r: TankReading): number | null => {
  const at = r.reengage ?? 0
  return at > 0 && at < 1 && tankState(r) === 'out' ? at : null
}

/** The mark's width, px, for a track `h` tall: a fifth of it, never under 2. */
export const tankMarkWidth = (h: number): number => Math.max(2, h * 0.2)

/** What `paintTank` leaves for the caller to draw: the word, its ink and its room. */
export interface TankWordPlan {
  readonly word: TankWordText
  readonly ink: string
  readonly pad: number
  readonly reach: number
}

/**
 * Paint the tank's track, fill and mark into the rect, and say which word goes
 * on it in which ink. Both mounts call this, so the bar is one drawing; each
 * draws the word in its own face.
 */
export const paintTank = (
  ctx: Pick<CanvasRenderingContext2D, 'fillRect' | 'fillStyle'>,
  x: number,
  y: number,
  w: number,
  h: number,
  r: TankReading,
  inks: TankInks,
): TankWordPlan => {
  const f = clamp01(r.fraction)
  ctx.fillStyle = tankTrackInk(r, inks)
  ctx.fillRect(x, y, w, h)
  const fill = tankFillInk(r, inks)
  if (fill !== null) {
    ctx.fillStyle = fill
    ctx.fillRect(x, y, w * f, h)
  }
  const mark = tankMark(r)
  if (mark !== null) {
    const mw = tankMarkWidth(h)
    ctx.fillStyle = inks.ink
    ctx.fillRect(x + w * mark - mw / 2, y, mw, h)
  }
  const pad = h * TANK_WORD_PAD
  const reach = w * TANK_WORD_REACH
  return {
    word: tankWord(r),
    ink: tankWordOnCharge(w * f, reach, pad) ? inks.tankTrack : inks.ink,
    pad,
    reach,
  }
}

/** The `fillRect`s `paintTank` makes for `r`: the track, a fill, a mark. */
export const tankRects = (r: TankReading): number =>
  1 + (clamp01(r.fraction) > 0 ? 1 : 0) + (tankMark(r) !== null ? 1 : 0)

// ── The gate combo's countdown, for both mounts (DEV-615) ──────────────────
//
// Matt, 2026-10-03: *"in flight hud - let's remove the bars from speed and
// time. just boost and gates. (to show the gate combo countdown)"*. The combo
// is the speed chain (`sim/speed-chain.ts`, 2016's `EnergySystem_Ship`): every
// gate adds 18 m/s to the ship's top speed and the `+N` badge counts them, and
// all of it falls back if 5.5 s pass without a gate. The bar is that 5.5 s,
// full at a gate and empty as the combo drops: how long is left to take the
// next one. Before this row it sat on the SPEED line, the number it moves.

/** The dash's combo bar, under the count's baseline, as shares of the upper screen. */
export const DASH_CHAIN_GAP = 0.03
export const DASH_CHAIN_HEIGHT = 0.035

/**
 * Paint the combo's bar: a track and the fill. Called only while a combo is
 * live (no combo, no bar at all), so the track is what makes a short fill read
 * as a share of the cooldown rather than as a short bar. Both mounts paint
 * through this, so the bar is one drawing, as the tank's is.
 */
export const paintChain = (
  ctx: Pick<CanvasRenderingContext2D, 'fillRect' | 'fillStyle'>,
  x: number,
  y: number,
  w: number,
  h: number,
  fraction: number,
  inks: { readonly track: string; readonly fill: string },
): void => {
  ctx.fillStyle = inks.track
  ctx.fillRect(x, y, w, h)
  const f = clamp01(fraction)
  if (f > 0) {
    ctx.fillStyle = inks.fill
    ctx.fillRect(x, y, w * f, h)
  }
}

/** The `fillRect`s `paintChain` makes: the track, and a fill while any is left. */
export const chainRects = (fraction: number): number => 1 + (clamp01(fraction) > 0 ? 1 : 0)

/**

 * Whether the charge covers enough of the word that it wants DARK ink (the
 * track's) rather than the light ink it wears on the bare track: past half the
 * word's reach, from the word's left pad. Shared for the same reason as
 * `tankWord`; all three arguments are px in the caller's own space.
 */
export const tankWordOnCharge = (chargePx: number, wordReach: number, pad: number): boolean =>
  chargePx >= wordReach * 0.5 + pad

/** The word's reach, as a share of the track's width, on both mounts. */
export const TANK_WORD_REACH = 0.3

/** The word's left pad inside the track, as a share of the track's HEIGHT. */
export const TANK_WORD_PAD = 0.4

/**
 * The dash's word, as a share of the track's height: CRYSTAL's caps are 0.70
 * em (`BASELINE` above), so an em of 1.14 tracks puts caps at about 0.8 of the
 * track, centred, with a pixel clear above and below on the shipped canvas.
 */
const DASH_TANK_WORD_EM = 1.14
/** Cap height over em, CRYSTAL's and near enough the fallback's. */
const CAP_HEIGHT = 0.7

/**
 * Draw the dash layout into a canvas `w` x `h`. The two plates are 2016's; the
 * text is placed at 2016's shares; the bars and badges are the Anniversary
 * readings, drawn only where `content` carries them — Classic's content never
 * does, so Classic draws exactly 2016's two screens.
 */
export const drawDash = (
  ctx: DashContext,
  w: number,
  h: number,
  content: DashContent,
  inks: DashInks,
  inset = 0,
): void => {
  const L = dashLayout(w, h, inset, content.energy !== undefined)
  ctx.clearRect(0, 0, w, h)
  // The two plates. The upper screen is one plate for both lines, as 2016's
  // `panel_shipUI` is; the strip is a swatch the third quad stretches.
  ctx.fillStyle = DASH_PLATE_UPPER
  ctx.fillRect(0, 0, w, L.split)
  ctx.fillStyle = DASH_PLATE_STRIP
  ctx.fillRect(0, L.swatchTop, w, h - L.swatchTop)

  ctx.textBaseline = 'alphabetic'

  // ── the launch banner: the upper screen, nothing on the card ─────────
  if (content.banner) {
    const big = content.banner.length <= 2
    const sx = L.stretchUpper
    ctx.setTransform(sx, 0, 0, 1, 0, 0)
    ctx.fillStyle = big ? inks.accent : inks.ink
    ctx.font = dashFont(big ? L.split * 0.78 : L.split * 0.32)
    ctx.textAlign = 'center'
    ctx.fillText(
      content.banner,
      L.area / 2 / sx,
      L.split * (big ? 0.84 : 0.62),
      (L.area * 0.9) / sx,
    )
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return
  }

  // ── the upper screen: count and time ──────────────────────────────────
  const su = L.stretchUpper
  ctx.setTransform(su, 0, 0, 1, 0, 0)
  ctx.font = dashFont(L.upperFont)
  const gap = L.upperFont * 0.25
  const labelRoom = (L.upperValueX - L.upperLabelX - gap) / su
  const valueRoom = (L.area - L.upperValueX - L.upperLabelX * 0.5) / su
  const [b0, b1] = L.upperBaselines
  // The count's NUMBER is always drawn, in its own column. An event takes the
  // LABEL's slot beside it, never the number (DEV-397): the event line used to
  // replace the whole count line, so the number a gate had just moved was
  // hidden for the 1.6 s after every gate, and a low pass that banks `LOW +N`
  // every 0.8 s hid it for most of a lap.
  ctx.textAlign = 'left'
  if (content.event) {
    ctx.fillStyle = content.event.tone === 'loss' ? inks.muted : inks.accent
    // Fitted to the slot rather than squeezed into it: `CLEAN x3  LOW +10` and
    // 2016's `gold medal AwarDeD!` are sentences, `GOLD` is a word.
    const most = L.upperFont * 0.6
    ctx.font = dashFont(most)
    const natural = ctx.measureText(content.event.text).width
    ctx.font = dashFont(natural > labelRoom ? (most * labelRoom) / natural : most)
    ctx.fillText(content.event.text, L.upperLabelX / su, b0, labelRoom)
    ctx.font = dashFont(L.upperFont)
  } else {
    ctx.fillStyle = inks.ink
    ctx.fillText(content.countLabel, L.upperLabelX / su, b0, labelRoom)
  }
  ctx.fillStyle = inks.ink
  ctx.fillText(content.countValue, L.upperValueX / su, b0, valueRoom)
  ctx.fillStyle = content.urgent ? inks.accent : inks.ink
  ctx.fillText(content.timeLabel, L.upperLabelX / su, b1, labelRoom)
  // The badges ride the time line's right end, in the room the clock LEAVES,
  // measured. "The clock is at most three digits, so that end is the one place
  // nothing else reaches" was assumed, and at 2016's stretch the badges landed
  // on the clock's last digit (DEV-397). The clock keeps its natural width;
  // the badges start past it and narrow if they must.
  let clockRoom = valueRoom
  if (content.badges.length > 0) {
    clockRoom = Math.min(valueRoom, ctx.measureText(content.timeValue).width)
    const right = (L.area - L.upperLabelX * 0.5) / su
    const left = L.upperValueX / su + clockRoom + gap / su
    ctx.fillStyle = inks.accent
    ctx.textAlign = 'right'
    ctx.font = dashFont(L.upperFont * 0.42)
    // Right to left as before, AUTO at the end, as one run with one reach.
    ctx.fillText([...content.badges].reverse().join('  '), right, b1, Math.max(1, right - left))
    ctx.font = dashFont(L.upperFont)
    ctx.textAlign = 'left'
    ctx.fillStyle = content.urgent ? inks.accent : inks.ink
  }
  ctx.fillText(content.timeValue, L.upperValueX / su, b1, clockRoom)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // ── the Anniversary bars: the gate combo and the tank (DEV-615) ───────
  const barX = L.upperLabelX
  const barW = L.area - L.upperLabelX * 2
  if (content.chain !== undefined) {
    // The GATES line's bar: the gate combo's countdown, between the count's
    // baseline and the time line's cap tops, which are ~10 px apart on the
    // shipped canvas; the bar takes the upper half of it. G1's proximity
    // meter had this slot, and the chain had the speed card, until Matt asked
    // for *"just boost and gates"* (DEV-615).
    paintChain(
      ctx,
      barX,
      b0 + L.split * DASH_CHAIN_GAP,
      barW,
      L.split * DASH_CHAIN_HEIGHT,
      content.chain,
      {
        track: inks.plateEdge,
        fill: inks.accent,
      },
    )
  }
  if (content.energy) {
    const y = L.tankY
    const bh = L.tankH
    const t = paintTank(ctx, barX, y, barW, bh, content.energy, inks)
    // DEV-555: the word the lens draws (`tankWord`), in the dash's own face
    // and stretch, caps centred in the track at its left end. The caps sit on
    // an alphabetic baseline rather than `middle`, which CRYSTAL's whole-em
    // ascent would put a few px low.
    const em = Math.max(1, Math.round(bh * DASH_TANK_WORD_EM))
    ctx.setTransform(su, 0, 0, 1, 0, 0)
    ctx.font = dashFont(em)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = t.ink
    ctx.fillText(t.word, (barX + t.pad) / su, y + (bh + em * CAP_HEIGHT) / 2, t.reach / su)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
  // DEV-399: the glider's stall margin, on the SPEED card because it is a
  // reading of the speed: full at trim, empty at the stall. A track, so an
  // empty bar reads as empty and not absent. The card's one bar since DEV-615
  // moved the chain's to the GATES line; it stays because it is the glider's
  // stall instrument, not one of the HoverJet's readings Matt took off.
  if (content.stall) {
    const cardH = L.swatchTop - L.split
    const y = L.cardBaseline + cardH * 0.1
    const bw = w - L.cardLabelX * 2
    ctx.fillStyle = inks.tankTrack
    ctx.fillRect(L.cardLabelX, y, bw, cardH * 0.08)
    if (content.stall.margin > 0) {
      ctx.fillStyle = content.stall.stalling ? inks.muted : inks.ink
      ctx.fillRect(L.cardLabelX, y, bw * clamp01(content.stall.margin), cardH * 0.08)
    }
  }

  // ── the speed card ────────────────────────────────────────────────────
  const sc = L.stretchCard
  ctx.setTransform(sc, 0, 0, 1, 0, 0)
  ctx.font = dashFont(L.cardFont)
  ctx.fillStyle = inks.ink
  ctx.textAlign = 'left'
  const cardGap = L.cardFont * 0.25
  ctx.fillText(
    content.speedLabel,
    L.cardLabelX / sc,
    L.cardBaseline,
    (L.cardValueX - L.cardLabelX - cardGap) / sc,
  )
  if (content.speedValue !== null) {
    ctx.fillText(
      content.speedValue,
      L.cardValueX / sc,
      L.cardBaseline,
      (w - L.cardValueX - L.cardLabelX * 0.5) / sc,
    )
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// ── The geometry ────────────────────────────────────────────────────────────

/** What `geometry.parameters` says for the dash: the UPPER screen, as a PlaneGeometry would. */
export interface DashGeometryParameters {
  readonly width: number
  readonly height: number
  /** The share of the canvas's height the upper screen shows, from its top. */
  readonly upperShare: number
}

/**
 * The dash's three quads as ONE geometry, in the upper screen's frame (which is
 * the panel object's frame: the preset's placement IS the upper screen's pose).
 *
 * Index order is draw order, and it matters because the material writes no
 * depth: the strip plate first, the speed card over it, the upper screen last.
 *
 * `parameters` says what a `PlaneGeometry` would for the upper screen, because
 * the HUD pixel specs read the panel's size off it; `upperShare` is the one
 * thing they need that a plane does not have.
 */
export const createDashGeometry = (canvasH: number): THREE.BufferGeometry => {
  const split = dashSplitRow(canvasH)
  const swatchTop = canvasH - DASH_SWATCH_ROWS
  // Canvas row -> v, with `flipY` (row 0 is the TOP of the texture, v = 1).
  const v = (row: number) => 1 - row / canvasH
  const swatchV = v(swatchTop + DASH_SWATCH_ROWS / 2)
  const positions: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  const quad = (
    width: number,
    height: number,
    position: readonly [number, number, number],
    tilt: number,
    vTop: number,
    vBottom: number,
  ) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt),
      new THREE.Vector3(1, 1, 1),
    )
    const base = positions.length / 3
    const corners: [number, number, number, number][] = [
      [-width / 2, height / 2, 0, vTop],
      [width / 2, height / 2, 1, vTop],
      [-width / 2, -height / 2, 0, vBottom],
      [width / 2, -height / 2, 1, vBottom],
    ]
    for (const [x, y, u, vv] of corners) {
      const p = new THREE.Vector3(x, y, 0).applyMatrix4(m)
      positions.push(p.x, p.y, p.z)
      uvs.push(u, vv)
    }
    // PlaneGeometry's winding, so the front face is +z like the lens quad's.
    index.push(base, base + 2, base + 1, base + 2, base + 3, base + 1)
  }
  quad(DASH_STRIP.width, DASH_STRIP.height, DASH_STRIP.position, DASH_STRIP.tilt, swatchV, swatchV)
  quad(
    DASH_CARD.width,
    DASH_CARD.height,
    DASH_CARD.position,
    DASH_CARD.tilt,
    v(split),
    v(swatchTop),
  )
  quad(DASH_SCREEN.width, DASH_SCREEN.height, [0, 0, 0], 0, v(0), v(split))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(index)
  geometry.computeBoundingSphere()
  const parameters: DashGeometryParameters = {
    width: DASH_SCREEN.width,
    height: DASH_SCREEN.height,
    upperShare: split / canvasH,
  }
  return Object.assign(geometry, { parameters })
}

// ── The side plate (DEV-361's race map) ─────────────────────────────────────

/** Clear space between a side plate and the upper screen's edge, metres. */
export const DASH_SIDE_MARGIN = 0.006

/**
 * The side plate's centre x in the dash, in the upper screen's frame: INSIDE
 * the screen, against its right edge. There is nowhere beside it — the recess
 * is 0.35 m wide at the glass and the screen fills it — so a race map in the
 * dash shares the upper screen, and the text column narrows to make room.
 */
export const dashSidePlateX = (plateWidth: number): number =>
  DASH_SCREEN.width / 2 - DASH_SIDE_MARGIN - plateWidth / 2

/** How many canvas px the upper screen's text keeps clear for a plate `plateWidth` wide. */
export const dashSideInsetPx = (plateWidth: number, canvasW: number): number =>
  plateWidth > 0
    ? Math.round(((plateWidth + DASH_SIDE_MARGIN * 2) / DASH_SCREEN.width) * canvasW)
    : 0

// ── Placement ───────────────────────────────────────────────────────────────

/** The preset's placement block, structurally — `EditionHudPlacement`. */
export interface HudPlacementLike {
  readonly offset: readonly [number, number, number]
  readonly tilt: number
  readonly scale: number
}

/**
 * Put a readout at `eye + offset`, tilted about x, scaled — the one rule both
 * vehicles' `placeHud` apply. Exported so the recess test places the panel with
 * the function the game uses, rather than with a second reading of it.
 */
export const placeHudAt = (
  object: THREE.Object3D,
  p: HudPlacementLike,
  eye: { readonly x: number; readonly y: number; readonly z: number },
): void => {
  object.position.set(eye.x + p.offset[0], eye.y + p.offset[1], eye.z + p.offset[2])
  object.rotation.set(p.tilt, 0, 0)
  object.scale.setScalar(p.scale)
}
