// src/render/hud-gauges.ts — the panel's continuous readings, as geometry.
//
// DEV-257. `docs/plan/HUD-REDESIGN.md` §5.3.
//
// ── The finding this exists to act on ─────────────────────────────────────
//
// The HUD is one 560 x 203 canvas and it is the most expensive single thing in
// the game — 2.1 ms of the worn median flight frame, and ~16 ms of the frame
// flight begins, against an ocean that shades in 0.93 ms and a shadow pass of
// 0.52. §3.1 of the redesign paper shows the panel's own DRAWING is a rounding
// error (about 22 context calls on 113,680 pixels, i.e. ~95 microseconds a
// call, which no rounded-rect fill costs anywhere) — so essentially all of it
// is the cross-process raster the upload has to wait for.
//
// Then ask what FORCES that raster. From `hudSignature()`: speed moves every
// frame, the proximity meter is an exponential that never settles, the chain
// cooldown steps ~20 times per cooldown, and the boost tank steps ~6 times a
// second while boosting. (DEV-615 took the proximity meter off the panel.)
// **Every reading that moves at frame rate is a
// continuous quantity, and three of the four were already drawn as plain
// `fillRect` bars.** A `fillRect` and a scaled quad are the same object to look
// at; one costs a cross-process raster and the other costs a matrix.
//
// So the four continuous readings move here, and text stays on the canvas. What
// remains on the canvas is the clock (1 Hz), the gate count (a few times a
// minute) and events — which is the repaint rate this whole module is for.
//
// ── And it is the ART answer, from the project's own page ─────────────────
//
// `ART_DIRECTION.md` pillar 2 is *"One colour per face, and never a texture"*,
// with the test *"does the new thing carry a texture map? Then it is out of
// register."* The HUD is the game's largest standing violation of its own
// pillar. Pillar 1 is silhouette — a needle is a silhouette and a three-digit
// number is not. Pillar 5 says extend the scale ladder DOWNWARD, more and
// smaller faces near the eye, and a faceted instrument 0.78 m from the pilot's
// eye is precisely that.
//
// ── Why ONE merged geometry and not four meshes ───────────────────────────
//
// Because in a headset this is the same single render pass as everything else.
// `bloom.ts:436` returns false on `renderer.xr.isPresenting` and `app.ts` then
// falls through to a plain `renderer.render( stage, camera )` — the two-pass
// split with a `clearDepth()` is MONITOR-ONLY. So these are plain extra draws
// in the frame that is already tight, and four meshes would be four of them.
// One merged `BufferGeometry` with dynamic `position` and `color` attributes is
// **one** extra draw call, against the 121 the reveal already reaches.
//
// No `onBeforeCompile`, deliberately: every one needs a matching
// `tagProgramCacheKey` or two materials share one program and whichever
// compiled first wins (DEV-194), and a stock `MeshBasicMaterial` with
// `vertexColors` needs neither. The colour attribute is **itemSize 4** so the
// alpha the panel's palette carries survives — three defines `USE_COLOR_ALPHA`
// off exactly that.
//
// ── Why this file imports almost nothing ──────────────────────────────────
//
// `render/instrument-colour.ts`'s header is the cautionary tale: one import
// edge from a spec to a module that eventually reaches `import.meta.glob` took
// the WHOLE Playwright suite to `Total: 0 tests in 0 files`. This module takes
// the panel's size and its palette as PARAMETERS rather than importing them
// from `hud.ts`, which would be a runtime cycle (`hud.ts` imports this). The
// only import from `hud.ts` is `type HudState`, and `verbatimModuleSyntax` is
// on, so that edge is erased at build time and does not exist at runtime.
//
// ── Absent is not zero, and that is load-bearing (DEV-154) ────────────────
//
// An ABSENT reading draws nothing at all; a reading of 0 draws an empty TRACK.
// The canvas did not make that distinction for the proximity meter until
// DEV-154, and a player who had never been low had therefore never seen the
// instrument. Here "nothing" is a COLLAPSED quad — four identical vertices, so
// the two triangles have zero area and the rasteriser emits no fragments. It
// costs four vertex writes and no pixels, and it keeps the vertex count fixed,
// which is what lets one static index buffer serve every state.

import * as THREE from 'three'
import { clamp01 } from '@/sim/math/scalar'
import type { HudState } from './hud'
import { tankFillInk, tankMark, tankMarkWidth, tankTrackInk } from './hud-dash'

/**
 * Which form the speed gauge takes, and whether the speed DIGITS survive it.
 *
 * `off` is the shipped panel — with it nothing in this module is constructed
 * and nothing joins the scene graph, which is stricter than "the flag is off"
 * and is what `render/cockpit-interior.ts` promises for Classic.
 *
 * The two forms exist because the speed gauge is the one genuinely new design
 * on this panel and the project's rule is to photograph a thing before
 * believing it: a horizontal bar is the smallest change and a swept needle is
 * the most instrument-like, and the frames decide. The `-only` pair drop the
 * digits, which is the variant that takes the canvas's repaint rate all the way
 * down to the clock — see `hudSignature`.
 */
export type HudGauges =
  | { readonly kind: 'off' }
  | { readonly kind: 'bar'; readonly digits: boolean }
  | { readonly kind: 'needle'; readonly digits: boolean }

/** The shipped panel: no geometry, nothing constructed. */
export const HUD_GAUGES_OFF: HudGauges = { kind: 'off' }

/** Is any gauge geometry live? Spelled once, because four call sites ask. */
export const hudGaugesOn = (g: HudGauges): boolean => g.kind !== 'off'

/**
 * Does the SPEED ROW still print a number?
 *
 * Separate from `hudGaugesOn` because it is a different question with a
 * different consequence: the digits are what keeps `hudSignature` moving with
 * the speed, so this is the switch that decides whether the canvas settles at
 * ~1 Hz or merely slows down.
 */
export const hudGaugesKeepDigits = (g: HudGauges): boolean => g.kind !== 'off' && g.digits

/**
 * `?hudGauges=` / `__ff2.hudGauges(...)`, parsed. `null` for anything
 * unrecognised, which the caller warns about and drops — house style for a DEV
 * switch, and the same contract `parseHudRedraw` and `parseHudUpload` have.
 *
 * `bar` and `needle` keep the digits; `bar-only` and `needle-only` mean the
 * gauge is the only speed indicator. `on` is `bar`, which is the smaller of the
 * two changes, and `off` is spelled as well as defaulted for `parseHudRedraw`'s
 * reason: **an arm expressed by ABSENCE is the one nobody can check
 * afterwards.**
 *
 * `live`, `freeze`, `mip` and `nomip` are REFUSED by omission rather than by
 * name — they belong to the other two pins on this same panel, and
 * `parseHudUpload`'s header explains at length why one word meaning different
 * things on two pins of one panel is a trap. Here the words simply are not in
 * the table, and the test names them.
 */
export const parseHudGauges = (raw: string | null | undefined): HudGauges | null => {
  if (raw === null || raw === undefined) return null
  // Hyphens, underscores and spaces come off first so `bar-only`, `bar_only`
  // and `baronly` are one answer — `parseHudUpload` takes the same liberty for
  // the same reason: a spelling a shell command plausibly carries has to
  // compare equal to what the probe prints, or a mechanism check refuses its
  // own arm.
  const text = raw.trim().toLowerCase().replaceAll('-', '').replaceAll('_', '').replaceAll(' ', '')
  if (text === '') return null
  if (text === 'off' || text === 'none') return HUD_GAUGES_OFF
  if (text === 'on' || text === 'bar' || text === 'bars') return { kind: 'bar', digits: true }
  if (text === 'needle') return { kind: 'needle', digits: true }
  if (text === 'baronly' || text === 'barsonly') return { kind: 'bar', digits: false }
  if (text === 'needleonly') return { kind: 'needle', digits: false }
  return null
}

/**
 * The mode as one short token — `off`, `bar`, `needle-only`.
 *
 * Round-trips through `parseHudGauges`, so an arm that asked for `barOnly`
 * reads back as something `parseHudGauges` maps to the same value. The e2e
 * mechanism check compares an ASK against a READING by string.
 */
export const describeHudGauges = (g: HudGauges): string =>
  g.kind === 'off' ? 'off' : g.digits ? g.kind : `${g.kind}-only`

/** Two gauge modes are the same mode. */
export const sameHudGauges = (a: HudGauges, b: HudGauges): boolean =>
  a.kind === b.kind && (a.kind === 'off' || b.kind === 'off' || a.digits === b.digits)

/**
 * Full scale for the speed gauge, m/s — the CHAINED boosted terminal.
 *
 * ── The first value was wrong and the frames are what said so ───────────
 *
 * This was `derived.hoverjet.terminalSpeedBoost` = **179.6229**, which is the
 * sheet's own figure and looked unarguable. The first photo set came back with
 * the bar and the needle both PEGGED at both marks, because the measured
 * flight speed at 6 s and at 25 s was 181.3 and 183.1 m/s — already past it.
 *
 * The reason is DEV-110, and `sim/speed-chain.ts`'s own header states it in
 * one line: *"Terminal goes 182 -> 340 m/s over twenty-one gates."* Every gate
 * adds `increment` 18 to `maxSpeed`, so the ship's terminal is a function of
 * how much of the chain is banked, and a gauge scaled to the UNCHAINED
 * terminal reads full for most of an Anniversary run — which is not a gauge.
 *
 * So the scale is the top of the range the mechanic can actually produce:
 *
 *     terminalSpeed( 437.5 + 18 x 21, 2, 4, 1.2 )
 *       = (2 x 815.5) / (4 x 1.2) = 339.79 m/s
 *
 * from `hoverjet.ship.maxSpeed` 437.5 N, the chain's code-default increment of
 * 18, `int_01_hoverJet`'s 21 gates, the boost multiplier of 2 (which is
 * `terminalSpeedBoost / terminalSpeedCruise` in the sheet — 1.9999989, i.e. 2
 * to within the four decimal places the sheet writes those two entries to, and
 * the test says so in those terms rather than claiming an exactness the source
 * does not carry), and the rigidbody's mass 4 and drag 1.2.
 *
 * **It is a DERIVED number and it carries a derived number's discipline**
 * (CLAUDE.md, DEV-027): it is the terminal speed OF a HoverJet under continuous
 * boost with a full 21-gate chain, in m/s, and `tests/unit/hud-gauges.test.ts`
 * asserts it against `sim/speed-chain.ts`'s OWN `terminalSpeed()` rather than
 * against this arithmetic written twice. The test imports the sim; this module
 * does not, which keeps it as import-poor as its header promises while still
 * being held to the sim's definition.
 *
 * ── Two things it is NOT, and both are questions for Matt ────────────────
 *
 * **It is not per-mission**, and the chain's ceiling is: a 16-gate course tops
 * out lower and a 28-gate one higher. **It is not per-vehicle** either — the
 * JumpSeat has no forward-speed terminal in the sheet at all (only
 * `derived.jumpseat.terminalClimbRate`, 16.144 m/s, which is a climb rate and
 * not this), so that vehicle's gauge reads low on this scale. Neither is
 * answered with a number nobody measured; both are one line through the
 * `speedFullScale` option, which exists for exactly this.
 *
 * And a Classic run has no chain at all, so its ceiling really is ~182 and its
 * needle never passes 54 %. Whether one scale should serve both presets is the
 * third question in the same family.
 */
export const HUD_GAUGE_SPEED_FULL_SCALE = 339.7916666666667

/**
 * How coarsely the speed DIGITS are rounded once a gauge carries the continuous
 * reading, in whatever unit the row is printing.
 *
 * **This is the one number to argue with** (`ART_DIRECTION.md`: *"Name the one
 * number to argue with"*), and it is a judgement rather than a measurement. The
 * argument for coarsening at all: the digits are the only thing left on the
 * speed row that can move at frame rate, and every time they move the whole
 * canvas rasters. The argument for 5 rather than 10: at cruise the HoverJet
 * sits near a terminal of 89.8 m/s and a step of 10 would quantise the
 * difference between cruising and nearly-stalled into two readings.
 *
 * Unused when `digits` is false, which is the variant that removes the question.
 */
export const HUD_GAUGE_DIGIT_STEP = 5

/**
 * Round a displayed speed to `HUD_GAUGE_DIGIT_STEP`, in the unit it is printed
 * in.
 *
 * Applied to the value BEFORE `formatSpeed` converts it, so that the step means
 * five of whatever the row shows rather than five m/s converted into an untidy
 * number of km/h. `unitScale` is what `formatSpeed` will multiply by — 1 for
 * m/s, 3.6 for km/h — and it is passed in rather than looked up because this
 * module does not know what an edition is, for the same reason `hud.ts` does
 * not.
 */
export const hudGaugeCoarsenSpeed = (speed: number, unitScale: number): number => {
  const shown = speed * unitScale
  return (Math.round(shown / HUD_GAUGE_DIGIT_STEP) * HUD_GAUGE_DIGIT_STEP) / unitScale
}

// ── The panel's own layout, in canvas pixels ──────────────────────────────
//
// Every number below is the arithmetic `hud.ts`'s `draw()` already does, in the
// same expressions and the same order, so the geometry lands on the pixels the
// canvas was covering. It is a SECOND copy of that arithmetic and it is held by
// a test that records the real `draw()`'s `fillRect` arguments and compares
// them to these rects — not by care. That is the same instrument
// `hudCanvasOps` is kept honest with, and for the same reason: a prediction of
// what `draw()` does, written beside `draw()`, is exactly the thing that
// drifts.

/** The plate metrics `draw()` derives from the canvas size. */
export interface HudPanelLayout {
  /** Canvas width and height, device pixels. */
  readonly w: number
  readonly h: number
  readonly gap: number
  readonly rowH: number
  readonly padX: number
  /** The two gameplay bars' height. The tank is twice this. */
  readonly barH: number
  /** Top of a bar inside row `row`, canvas pixels from the top. */
  barY(row: number): number
  /**
   * DEV-567: the boost tank on the TIME row, top and height. ONE definition,
   * read by the canvas (`hud.ts`) and by the geometry arm below, so the two
   * cannot put the tank in different places. DEV-143 made it twice `barH`;
   * Matt asked for it taller, and it is `LENS_TANK_HEIGHT` of the row now.
   */
  readonly tankY: number
  readonly tankH: number
}

/** DEV-567: the lens tank's height, and its gap above the row's bottom edge, as shares of a row. */
export const LENS_TANK_HEIGHT = 0.18
export const LENS_TANK_FLOOR = 0.05

export const hudPanelLayout = (w: number, h: number): HudPanelLayout => {
  const gap = h * 0.035
  const rowH = (h - gap * 2) / 3
  const padX = rowH * 0.22
  const barH = rowH * 0.06
  return {
    w,
    h,
    gap,
    rowH,
    padX,
    barH,
    barY: (row) => row * (rowH + gap) + rowH - barH * 1.6,
    tankY: 1 * (rowH + gap) + rowH * (1 - LENS_TANK_FLOOR - LENS_TANK_HEIGHT),
    tankH: rowH * LENS_TANK_HEIGHT,
  }
}

/** A rectangle in canvas pixels, with the colour the canvas would have used. */
export interface HudGaugeRect {
  /** Which reading, so a test and a probe can name one. */
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** A CSS colour from the panel's own palette. Never a new one. */
  readonly colour: string
}

/**
 * The five palette entries the gauges use, passed in from `hud.ts` so there is
 * one definition of each.
 *
 * **No colour here is invented** — `ART_DIRECTION.md` pillar 4's argument
 * applies to a UI palette as much as to the sun: in six months a colour typed
 * into `src/render/` is indistinguishable from one that was reasoned about. A
 * sixth entry would be a `DEVIATIONS.md` row and a question for Matt.
 */
export interface HudGaugePalette {
  /** The panel's type ink. DEV-567: the tank's threshold mark wears it while boost is out. */
  readonly ink: string
  /** The scoring readings' warm accent. */
  readonly accent: string
  /** The boost tank's cool charge. */
  readonly charge: string
  /** The loss ink (a broken streak). The tank wore it while out until DEV-567. */
  readonly muted: string
  /** The tank's empty track — the plate's ink darkened, a hole in the gauge. */
  readonly tankTrack: string
  /** The plate's edge, which is also the two thin bars' track. */
  readonly plateEdge: string
  /**
   * `render/instrument-colour.ts`'s `INSTRUMENT_ACCENT`, as a CSS string.
   *
   * The speed gauge's own ink. It is the colour the launch room, the elevator
   * shaft's lit bars, the diorama's orb and the hangar's flown holotable rim
   * already share — so a NEW instrument joining that family is the one choice
   * on this panel that is not a new colour at all.
   */
  readonly instrument: string
  /** DEV-567: the tank while boost is out, its refill and its track. */
  readonly boostOut: string
  readonly boostOutTrack: string
}

/**
 * The AXIS-ALIGNED gauge rectangles for a state, in canvas pixels.
 *
 * The readings that were already bars keep their rectangles EXACTLY: same
 * row, same inset, same height, same colour. That is deliberate and it is
 * what makes this change reviewable: with the flag on, those bars should be
 * indistinguishable from the ones the canvas drew, and any difference in a
 * frame is a bug rather than a design.
 *
 * The speed gauge is the new one, and it sits along the TOP edge of the speed
 * row's plate, mirroring `barY`'s inset from the bottom, where the chain
 * cooldown lived until DEV-615 moved it to the count row. Clear of the glyph
 * tops, which start about `0.29 * rowH` below the row's top.
 *
 * Does NOT include the needle: a needle is not axis-aligned, so it comes back
 * from `hudGaugeNeedle` as four corners. Splitting them keeps this function
 * comparable, rectangle for rectangle, against the canvas's own `fillRect`
 * arguments — which is the only reason the comparison is a real test rather
 * than a re-derivation (CLAUDE.md trap 24).
 */
export const hudGaugeRects = (
  state: HudState,
  layout: HudPanelLayout,
  palette: HudGaugePalette,
  gauges: HudGauges,
  speedFullScale: number,
): HudGaugeRect[] => {
  if (gauges.kind === 'off') return []
  const { w, padX, barH, rowH, gap } = layout
  const full = w - padX * 2
  const out: HudGaugeRect[] = []

  // ── DEV-110's speed chain cooldown, on the COUNT row (DEV-615) ─────────
  //
  // The gate combo's countdown, and the GATES line's bar since DEV-615 (it
  // was on the SPEED row, under G1's proximity meter on this one, which left
  // the panel). A track while a combo is live, so the fill reads as a share of
  // the cooldown, and nothing at all without one: `paintChain`'s two rects, on
  // the row the canvas paints them on. `stacks` is the `+N` badge, which
  // stays text.
  if (state.chain && state.chain.stacks > 0) {
    out.push({
      id: 'chain-track',
      x: padX,
      y: layout.barY(0),
      w: full,
      h: barH,
      colour: palette.plateEdge,
    })
    const f = clamp01(state.chain.fraction)
    if (f > 0) {
      out.push({
        id: 'chain',
        x: padX,
        y: layout.barY(0),
        w: full * f,
        h: barH,
        colour: palette.accent,
      })
    }
  }

  // ── DEV-143's tank, on the TIME row ────────────────────────────────────
  //
  // On a track, taller than the two readings above, and its colour says
  // whether boost is there: an empty tank and a tank that will not light look
  // alike and are not. DEV-567: the rect is the layout's (the canvas reads
  // the same one), and the inks and the quarter mark are `hud-dash.ts`'s,
  // which the canvas paints with on both mounts.
  if (state.energy) {
    const { tankY: y, tankH } = layout
    out.push({
      id: 'energy-track',
      x: padX,
      y,
      w: full,
      h: tankH,
      colour: tankTrackInk(state.energy, palette),
    })
    const f = clamp01(state.energy.fraction)
    const fill = tankFillInk(state.energy, palette)
    if (fill !== null) {
      out.push({ id: 'energy', x: padX, y, w: full * f, h: tankH, colour: fill })
    }
    const mark = tankMark(state.energy)
    if (mark !== null) {
      const mw = tankMarkWidth(tankH)
      out.push({
        id: 'energy-mark',
        x: padX + full * mark - mw / 2,
        y,
        w: mw,
        h: tankH,
        colour: palette.ink,
      })
    }
  }

  // ── The speed gauge — the one genuinely new instrument ─────────────────
  const speedTop = 2 * (rowH + gap) + barH * 0.6
  const f = clamp01(state.speed / speedFullScale)
  if (gauges.kind === 'bar') {
    out.push({
      id: 'speed-track',
      x: padX,
      y: speedTop,
      w: full,
      h: barH,
      colour: palette.plateEdge,
    })
    // An empty track and no gauge are different states here too, and the speed
    // gauge is always PRESENT — there is no vehicle without a speed — so a
    // stationary ship shows an empty track rather than nothing.
    if (f > 0) {
      out.push({
        id: 'speed',
        x: padX,
        y: speedTop,
        w: full * f,
        h: barH,
        colour: palette.instrument,
      })
    }
  }
  return out
}

/**
 * The needle form's geometry: a swept pointer over a graduated arc.
 *
 * ── Why the pivot is off the panel, and why that is not a fudge ──────────
 *
 * A row is `rowH` tall (about 63 px of a 203 px panel) and `w` wide, so a
 * classic round dial does not fit without giving the panel a fourth row — and
 * `hud.ts` already argues, for DEV-110's bars, that a fourth row changes the
 * panel's silhouette and is a bigger deviation than the reading asks for.
 *
 * So the needle is long and the visible BLADE is its outer segment, exactly as
 * a real instrument hides its hub: the pivot sits below the panel, the tip
 * sweeps a shallow arc across the middle of the speed row, and the arithmetic
 * that sizes it is the two-equation system
 *
 *     L * sin(halfSweep)       = halfSpan      (how far the tip travels)
 *     L * (1 - cos(halfSweep)) = bandHeight    (how far it dips doing it)
 *
 * which gives `tan(halfSweep / 2) = bandHeight / halfSpan` and then `L`. Both
 * inputs are chosen against the row, and the sweep falls out rather than being
 * picked — which is the difference between a number that is derived and a
 * number that was typed until it looked right (DEV-027).
 *
 * The span is deliberately NOT the full row width: the row's own text flanks it
 * — `SPEED:` left-aligned at `padX` and the value right-aligned at `w - padX` —
 * so the gauge takes the middle, which is the part of the plate that is empty.
 */
export interface HudGaugeQuad {
  readonly id: string
  /** Four corners in canvas pixels, in triangle-strip-friendly order TL,TR,BR,BL. */
  readonly corners: readonly [number, number, number, number, number, number, number, number]
  readonly colour: string
}

/**
 * How many graduations the needle sweeps over. Odd, so one sits at the centre.
 *
 * Annotated `number` rather than left at its literal type so the guard against
 * a single tick below is legal code rather than a comparison TypeScript can
 * prove is never true. A divide by `HUD_GAUGE_TICKS - 1` that nobody guarded
 * is how a one-tick scale becomes a NaN and takes the whole attribute with it.
 */
export const HUD_GAUGE_TICKS: number = 7

export const hudGaugeNeedle = (
  state: HudState,
  layout: HudPanelLayout,
  palette: HudGaugePalette,
  speedFullScale: number,
): HudGaugeQuad[] => {
  const { w, rowH, gap, barH } = layout
  const rowTop = 2 * (rowH + gap)
  // ── Sizing, and the constraint that actually binds ────────────────────
  //
  // The first pass set `halfSpan` to `w * 0.215` and `bandH` to `rowH * 0.62`
  // and the blade's ROOT came out 6 px BELOW the bottom of the panel. The
  // arithmetic that catches it is worth writing down, because the tempting
  // check — *does the TIP stay in the row* — passes on the broken version:
  //
  //   tip drop over the sweep   = radius * (1 - cos)            = bandH
  //   root drop over the sweep  = (radius - bladeLen)*(1 - cos)
  //   TOTAL vertical extent     = bladeLen + bandH*(1 - bladeLen/radius)
  //
  // So the blade's own LENGTH is part of the band it needs, and at a long
  // radius the two terms simply add. `tests/unit/hud-gauges.test.ts` asserts
  // every vertex of every quad is inside the panel at six speeds and both
  // forms, which is what found it.
  //
  // What is left is a genuine trade and the frames are what settle it: for a
  // fixed band, a WIDER sweep of the tip buys a SHALLOWER angle.
  //
  // ── And the first pass put the blade THROUGH the speed reading ────────
  //
  // It was centred on the panel at `w * 0.17`, sized against `SPEED:` on the
  // left and a three-digit value on the right. The frame showed the blade
  // sitting on the `6` of `660 km/h`, because **Anniversary's row is not three
  // digits** — S8 appends the unit, so the right-aligned value can be eight
  // characters and starts near x 347 rather than near x 480. The scale is
  // therefore centred on the GAP rather than on the panel: the label runs to
  // about x 135, the longest value starts about x 347, and the sweep takes the
  // middle of that with ~19 px of clearance each side.
  //
  // (A gauge that only fits the SHORTER of two shipped strings is the same
  // shape of bug as a corner badge that only fits when the speed is small —
  // which `drawCorner` has a comment about, from the time the chain's `+N`
  // landed on top of `381 km/h`.)
  const centreX = w * 0.43
  const halfSpan = w * 0.155
  const bandTop = rowTop + barH * 1.2
  const bandH = rowH * 0.22
  // tan(halfSweep / 2) = bandH / halfSpan — see the block above.
  const halfSweep = 2 * Math.atan2(bandH, halfSpan)
  const radius = halfSpan / Math.sin(halfSweep)
  const pivotX = centreX
  // Canvas y runs DOWN, so the pivot is BELOW the band and the blade points up.
  const pivotY = bandTop + radius
  const bladeLen = rowH * 0.4
  const bladeHalfW = barH * 0.62
  const tickLen = rowH * 0.12
  const tickHalfW = barH * 0.42

  /** A quad centred on the ray at `angle`, from radius `r0` to `r1`, `halfW` wide. */
  const radial = (
    id: string,
    angle: number,
    r0: number,
    r1: number,
    halfW: number,
    colour: string,
  ): HudGaugeQuad => {
    // The ray points UP the canvas at angle 0, so the radial unit vector is
    // (sin, -cos) and the perpendicular is (cos, sin).
    const ux = Math.sin(angle)
    const uy = -Math.cos(angle)
    const px = Math.cos(angle) * halfW
    const py = Math.sin(angle) * halfW
    const ax = pivotX + ux * r1
    const ay = pivotY + uy * r1
    const bx = pivotX + ux * r0
    const by = pivotY + uy * r0
    return {
      id,
      corners: [ax - px, ay - py, ax + px, ay + py, bx + px, by + py, bx - px, by - py],
      colour,
    }
  }

  const out: HudGaugeQuad[] = []
  // The graduations are STATIC — they are the scale, not the reading — and they
  // are drawn in the plate's edge colour so the scale reads as part of the
  // plate and the pointer reads as the thing moving on it.
  for (let i = 0; i < HUD_GAUGE_TICKS; i += 1) {
    const t = HUD_GAUGE_TICKS === 1 ? 0.5 : i / (HUD_GAUGE_TICKS - 1)
    const angle = (t * 2 - 1) * halfSweep
    out.push(radial(`tick-${i}`, angle, radius - tickLen, radius, tickHalfW, palette.plateEdge))
  }
  const f = clamp01(state.speed / speedFullScale)
  out.push(
    radial(
      'speed',
      (f * 2 - 1) * halfSweep,
      radius - bladeLen,
      radius,
      bladeHalfW,
      palette.instrument,
    ),
  )
  return out
}

// ── The mesh ──────────────────────────────────────────────────────────────

/** Everything the panel has to tell the gauges about itself. */
export interface HudGaugeSpec {
  /** Panel size in metres — `hud.ts`'s `WIDTH` and `HEIGHT`. */
  readonly width: number
  readonly height: number
  /** `hud.ts`'s `PIXELS_PER_METRE`, so one layout serves the canvas and this. */
  readonly pixelsPerMetre: number
  readonly palette: HudGaugePalette
  /** Full scale for the speed gauge, m/s. */
  readonly speedFullScale: number
}

export interface HudGaugeMesh {
  readonly object: THREE.Object3D
  /** Which form is live. */
  readonly gauges: HudGauges
  /** Write this state into the dynamic attributes. */
  update(state: HudState): void
  /**
   * How many quads carried a non-zero area on the last `update`.
   *
   * A COUNT, never a duration, and it is the instrument this row is argued
   * with: `report()` on the panel puts it beside the canvas's own ops so a
   * reader can see the work that moved rather than the work that vanished.
   */
  readonly live: number
  dispose(): void
}

/**
 * Colour parsing, because three's `Color` throws the alpha away.
 *
 * The panel's palette is half hex and half `rgba(...)`, and two of the five
 * entries carry an alpha that is the whole of how they read — `PLATE_EDGE` at
 * 0.55 is a track you can see the plate through, and `TANK_TRACK` at 0.7 is a
 * hole in the gauge. So the alpha is kept and goes into the vertex attribute's
 * fourth channel, which is what makes it an itemSize-4 attribute.
 *
 * The RGB goes through `Color.setRGB(..., SRGBColorSpace)` rather than being
 * used raw: a vertex colour is in three's WORKING space (linear), the panel's
 * strings are sRGB, and a raw copy would render every gauge too bright by the
 * transfer function. The canvas texture gets the same treatment for free
 * because `texture.colorSpace = SRGBColorSpace` decodes it on sample — this is
 * the same conversion, done where there is no texture to do it.
 */
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/
const scratchColour = new THREE.Color()
export const parseColour = (css: string): { r: number; g: number; b: number; a: number } => {
  const m = RGBA.exec(css.trim())
  if (m) {
    const [, r, g, b, a] = m
    scratchColour.setRGB(Number(r) / 255, Number(g) / 255, Number(b) / 255, THREE.SRGBColorSpace)
    return {
      r: scratchColour.r,
      g: scratchColour.g,
      b: scratchColour.b,
      a: a === undefined ? 1 : Number(a),
    }
  }
  // `setStyle` handles `#rgb`, `#rrggbb` and the named colours, and converts
  // from the space it is told rather than from a guess.
  scratchColour.setStyle(css, THREE.SRGBColorSpace)
  return { r: scratchColour.r, g: scratchColour.g, b: scratchColour.b, a: 1 }
}

/**
 * How many quads the pool holds.
 *
 * Fixed, because a fixed vertex count is what lets ONE static index buffer
 * serve every state and one `setDrawRange`-free draw serve every frame. The
 * worst case is the needle form: `HUD_GAUGE_TICKS` graduations, the blade, and
 * the five bar quads the two ported readings can want at once (chain track +
 * fill since DEV-615, tank track + fill + mark), and the bar form's two
 * speed quads are fewer than the needle's eight, so the needle sets the size.
 */
export const HUD_GAUGE_QUADS = HUD_GAUGE_TICKS + 1 + 5

export const createHudGauges = (gauges: HudGauges, spec: HudGaugeSpec): HudGaugeMesh | null => {
  // The arm, and it is an ARM: with `off` this returns before allocating
  // anything at all, so there is no geometry, no material and no node — which
  // is stricter than "the flag is off" (`render/cockpit-interior.ts`'s header
  // makes the same promise for Classic and is the model here).
  if (gauges.kind === 'off') return null

  const layout = hudPanelLayout(
    Math.round(spec.width * spec.pixelsPerMetre),
    Math.round(spec.height * spec.pixelsPerMetre),
  )
  const positions = new Float32Array(HUD_GAUGE_QUADS * 4 * 3)
  const colours = new Float32Array(HUD_GAUGE_QUADS * 4 * 4)
  const indices = new Uint16Array(HUD_GAUGE_QUADS * 6)
  for (let q = 0; q < HUD_GAUGE_QUADS; q += 1) {
    const v = q * 4
    const i = q * 6
    // TL, TR, BR, BL -> (TL,BL,BR) (TL,BR,TR). Counter-clockwise seen from +z,
    // which is the side the pilot is on: the panel's plane faces the eye and a
    // quad that wound the other way would be back-face culled, which looks
    // exactly like a gauge that is never drawn.
    indices[i] = v
    indices[i + 1] = v + 3
    indices[i + 2] = v + 2
    indices[i + 3] = v
    indices[i + 4] = v + 2
    indices[i + 5] = v + 1
  }

  const geometry = new THREE.BufferGeometry()
  const positionAttr = new THREE.BufferAttribute(positions, 3)
  positionAttr.setUsage(THREE.DynamicDrawUsage)
  const colourAttr = new THREE.BufferAttribute(colours, 4)
  colourAttr.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttr)
  // itemSize 4, which is what makes three define `USE_COLOR_ALPHA` and carry
  // the palette's two translucent tracks. An itemSize-3 attribute would render
  // both of them opaque and the plate would disappear behind its own gauge.
  geometry.setAttribute('color', colourAttr)
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  // The panel is a fixed-size plane and every quad is inside it. A bounding
  // sphere computed from a frame's worth of collapsed quads would be wrong for
  // the next frame, and three only recomputes when asked — so it is set once,
  // from the panel, and it cannot go stale.
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.hypot(spec.width, spec.height) / 2,
  )

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // `render/tone.ts`'s line, and the same one the panel answers to: a surface
    // that exists to modify the frame rather than to be in the world is not
    // tone-mapped. It is also what puts this object on `UI_LAYER` —
    // `bloom.ts`'s `classify()` keys on exactly this flag (`isUiObject`), so
    // removing it would silently move the gauges into the world pass on a
    // monitor and draw them UNDER the panel they sit on.
    toneMapped: false,
    depthWrite: false,
    // The panel's own flag, for the panel's own reason: the cockpit will
    // happily occlude an instrument's bottom edge and chasing a position that
    // clears every strut is fragile. It is also load-bearing IN THE HEADSET in
    // a way the flat build does not show — `bloom.ts:436` returns false on
    // `isPresenting`, so in a session there is one pass and no depth clear, and
    // this flag is the entire mechanism keeping the readout legible.
    depthTest: false,
    side: THREE.DoubleSide,
  })

  const object = new THREE.Mesh(geometry, material)
  object.name = 'hud-gauges'
  // Beside the panel's 10 and AFTER it: the gauges sit on the plates, and with
  // `depthTest: false` on both it is the draw order and nothing else that
  // decides which is on top.
  object.renderOrder = 11
  // ── The layer, and why there is no `layers.set` here ──────────────────
  //
  // `UI_LAYER` is 3 because layers 1 and 2 are the WebXR EYES: an object on
  // one is ABSENT from the other, not dim and not half-drawn, and that shipped
  // once and survived every test because a monocular harness cannot see a
  // monocular bug (DEV-141).
  //
  // This object never names a layer, and that is the same answer
  // `render/perf-plate.ts` reaches: `bloom.ts`'s `classify()` moves every
  // surface whose material is `toneMapped: false` onto `UI_LAYER`, so the flag
  // above IS the mechanism — *"do not remove without reading `classify()` and
  // DEV-141"*. Two things make it safe here specifically, and both are about
  // being a CHILD of the panel rather than a sibling:
  //
  //  · `classify()` TRAVERSES, so the panel and this are moved on the same
  //    frame by the same pass. The failure that would matter — the panel on
  //    `UI_LAYER` while its gauges are still on 0, i.e. gauges drawn in the
  //    world pass and then painted over by the panel — needs them classified
  //    apart, and a traverse cannot do that.
  //  · `classify()` runs only on the composite path, which never runs in VR.
  //    In a session neither object is moved, both stay on layer 0, and the one
  //    pass draws both. Same answer, by a different route.
  //
  // `tests/unit/hud-gauges.test.ts` asserts `isUiObject` accepts this mesh,
  // which is the guard against somebody removing `toneMapped: false` as
  // redundant.

  let live = 0
  const write = (quad: number, corners: readonly number[], colour: string): void => {
    const { r, g, b, a } = parseColour(colour)
    const v = quad * 4
    for (let c = 0; c < 4; c += 1) {
      const px = corners[c * 2] ?? 0
      const py = corners[c * 2 + 1] ?? 0
      // Canvas pixels to the panel's own local metres. The canvas's origin is
      // its top-left with y running down; the plane is centred on its own
      // origin with y running up, and `CanvasTexture`'s `flipY` already agrees
      // with that for the texture — so this is the same mapping, done to
      // vertices instead of texels.
      positions[(v + c) * 3] = px / spec.pixelsPerMetre - spec.width / 2
      positions[(v + c) * 3 + 1] = spec.height / 2 - py / spec.pixelsPerMetre
      // A hair in front of the plane, so that anything which ever DOES depth
      // test — a third-person camera, a future bezel (DEV-258) — resolves the
      // way it looks. It is 0.1 mm and cannot be seen at 0.78 m.
      positions[(v + c) * 3 + 2] = 0.0001
      colours[(v + c) * 4] = r
      colours[(v + c) * 4 + 1] = g
      colours[(v + c) * 4 + 2] = b
      colours[(v + c) * 4 + 3] = a
    }
  }
  /**
   * Collapse a quad to one point.
   *
   * Zero-area triangles emit no fragments, which is how ABSENT draws nothing
   * while the vertex count stays fixed. Not `setDrawRange`, because the quads
   * that are live are not a contiguous prefix — the tank can be absent while
   * the chain is not — and not a second geometry, because the whole point is
   * one draw call.
   */
  const collapse = (quad: number): void => {
    const v = quad * 4
    for (let c = 0; c < 4; c += 1) {
      positions[(v + c) * 3] = 0
      positions[(v + c) * 3 + 1] = 0
      positions[(v + c) * 3 + 2] = 0
      colours[(v + c) * 4 + 3] = 0
    }
  }

  return {
    object,
    gauges,
    get live() {
      return live
    },
    update(state) {
      let q = 0
      for (const rect of hudGaugeRects(state, layout, spec.palette, gauges, spec.speedFullScale)) {
        if (q >= HUD_GAUGE_QUADS) break
        // A rectangle with no width draws nothing — the fill of a reading that
        // is exactly zero. `hudGaugeRects` already refuses to emit those, and
        // this is the belt: a clamp that let a negative through would otherwise
        // wind the quad backwards.
        if (rect.w > 0 && rect.h > 0) {
          write(
            q,
            [
              rect.x,
              rect.y,
              rect.x + rect.w,
              rect.y,
              rect.x + rect.w,
              rect.y + rect.h,
              rect.x,
              rect.y + rect.h,
            ],
            rect.colour,
          )
          q += 1
        }
      }
      if (gauges.kind === 'needle') {
        for (const quad of hudGaugeNeedle(state, layout, spec.palette, spec.speedFullScale)) {
          if (q >= HUD_GAUGE_QUADS) break
          write(q, quad.corners, quad.colour)
          q += 1
        }
      }
      live = q
      for (; q < HUD_GAUGE_QUADS; q += 1) collapse(q)
      positionAttr.needsUpdate = true
      colourAttr.needsUpdate = true
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
