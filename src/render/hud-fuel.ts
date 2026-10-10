// src/render/hud-fuel.ts — the JumpSeat's readout, as 2016 drew it. DEV-360.
//
// ── What 2016 showed a JumpSeat pilot ─────────────────────────────────────
//
// ONE instrument: a fuel gauge. `JumpSeat_Photon.prefab`'s `Ship_HUD` is a
// world-space canvas in the cockpit, and the only live thing on it that reads
// the run is `panel_jumpSeatUI` — a translucent half-disc, a coloured arc that
// empties from the right, and `Fuel : 75%` across the bottom of the dome.
// `panel_shipUI` (gates, time, speed) is on the same canvas, authored inactive,
// and nothing in the shipped game switches it on (DEV-201 §1). The 2016
// capture shows exactly that and nothing else: `docs/private/ref-video-2016`,
// f0510 (`FUEL : 75%`) and f0530 (`FUEL : 76%`).
//
// Until DEV-360 the port drew the HoverJet's three teal plates on a JumpSeat
// (`PADS`, `TIME`, `SPEED`, none of which 2016 showed), with the tank as a thin
// bar along the middle one. Matt, 2026-09-24: *"make jumpseat UI match the
// classic jumpseat ui."* This file is that instrument.
//
// ── Where the numbers come from ───────────────────────────────────────────
//
// `FUEL_GAUGE_2016` is the prefab's own RectTransforms, Images and Texts, with
// their fileIDs, read out of `$FF2_LEGACY` by a liveness walk (`m_IsActive` up
// the `m_Father` chain). `tests/unit/hud-fuel.test.ts` re-reads each one out of
// the prefab BYTES where the Unity project is present, so this table cannot
// drift from the thing it copies. `fuelDomeLayout()` turns it into metres, and
// the drawing reads only the layout.
//
// The two sprites are Matt's own textures (`circle_outline.png`,
// `circle_transparent.png`), but nothing of them is used here except their
// MEASURED geometry: a disc of radius 107/128 of the sprite, and a ring 8 px
// thick at the same outer radius. The canvas draws both shapes. The FONT is
// 2016's own, CRYSTAL, since the DEV-362 follow-up: it is CC BY-SA 4.0 by Felipe
// Munoz (this comment used to say it had no licence trail; the trail was in its
// own name table), it ships unmodified from the content bucket, and the dome
// draws in it at 2016's best-fit size through the `font` it is handed
// (`render/hud-font.ts`), falling back to the panel's own stack if it fails.
//
// ── What it costs ─────────────────────────────────────────────────────────
//
// Fewer canvas calls than the rows (about 10 against about 25) and FAR fewer
// repaints: the only continuous reading is the tank, and it moves only while
// the throttle is open or a pad is filling it. The rows' SPEED changed on most
// frames of every JumpSeat flight; the dome's signature holds nothing that
// moves with the ship. Same cadence budget and upload path as the rows — this
// is a different drawing on the same panel (HUD-REWORK: repaint on change).
//
// ── What is NOT 2016's, and stays ─────────────────────────────────────────
//
// The port's own transient layer — the launch banner, the pad-hit event line,
// the streak multiplier and `AUTO` — has no other surface in a headset, so it
// is drawn INSIDE the dome, above the fuel line, only while it has something
// to say. With none of them live the panel is 2016's instrument and nothing
// else. `DEVIATIONS.md` DEV-360 has the table.
//
// Imports almost nothing, for `hud-gauges.ts`'s reason: `hud.ts` imports this
// module, so the only edge back is `import type`, which is erased at build.

import { JUMPSEAT } from '@/generated/constants.generated'
import type { HudCanvasOps, HudState } from './hud'
import { linearToSrgb, srgbToLinear } from './unity-space'

/**
 * Which drawing the panel carries. `rows` is the HoverJet's three plates and
 * the default; `fuel` is 2016's JumpSeat instrument.
 */
export type HudLayout = 'rows' | 'fuel'

/**
 * **The JumpSeat's panel. DEV-360.** ONE exported name, pinned by value in
 * `tests/unit/hud-fuel.test.ts`, and read by `game/jumpseat-flight.ts` — so
 * the day somebody wants the three FF2 rows back on this vehicle (DEV-201 §4
 * recorded Matt keeping them, 2026-09-17), it is this line, and a test that has
 * to be edited on purpose.
 */
export const HUD_LAYOUT_JUMPSEAT: HudLayout = 'fuel'

/**
 * 2016's `panel_jumpSeatUI`, as serialised. Unity space, Unity units; nothing
 * here is converted. Every entry is on `JumpSeat_Photon.prefab` under
 * `offset/art_pivot (1)/art_firstPerson/Ship_HUD/panel_jumpSeatUI`, live at
 * spawn, and the third-person copy under `Ship_HUD 3rd Person` carries the
 * same four children with the same numbers.
 */
export const FUEL_GAUGE_2016 = {
  prefab: 'Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab',
  /** `panel_jumpSeatUI`. Its own Image is `m_Enabled: 0` — no plate behind it. */
  panel: {
    gameObject: '1000012157621704',
    rectTransform: '224000013137755918',
    image: '114000013675763262',
    imageEnabled: 0,
    scale: [0.0053047542, 0.004807934, 0.0053047547],
  },
  /** `fuelgauge_bg`: `circle_transparent.png`, filled Radial360 to 0.5 — the half-disc. */
  disc: {
    gameObject: '1000011661231544',
    rectTransform: '224000013172023102',
    image: '114000010989956386',
    anchored: [0, -13.5],
    z: 13.3,
    scale: [0.34323362, 0.31799862, 0.32684004],
    color: [0.42231235, 1, 0.3455882, 1],
    fillAmount: 0.5,
    /** The sprite: 256 px square, the disc 107 px in radius, texels ~27/255 grey at 119/255. */
    spriteHalfPx: 128,
    radiusPx: 107,
    meanGrey: 27,
    alpha: 119,
  },
  /**
   * `fuelGauge`: `circle_outline.png`. `img_fuel` of the first-person
   * `UI_CamDependant` (114000012266587596), so it is the Image `FuelManager`
   * fills (`fillAmount = pct / 2`, `:93`) and recolours (`:99-115`).
   */
  ring: {
    gameObject: '1000013736572298',
    rectTransform: '224000013488697576',
    image: '114000012048482736',
    anchored: [0, -13.8],
    z: 13,
    scale: [0.34261024, 0.31799856, 0.32624647],
    spriteHalfPx: 128,
    radiusPx: 107,
    thicknessPx: 8,
    alpha: 183,
  },
  /** `text_fuel`: `Fuel :`. MiddleCenter, best fit 48..101. */
  label: {
    gameObject: '1000013782127906',
    text: '114000010841930590',
    anchored: [-11.2, -8.4],
    z: 8.2,
    scale: [0.08635627, 0.0930399, 0.088596106],
    maxSize: 101,
  },
  /** `val_fuel`: `100%`, then whatever `FuelManager` writes. */
  value: {
    gameObject: '1000010274130854',
    text: '114000012061380330',
    anchored: [15.7, -8.4],
    z: 8.1,
    scale: [0.08635626, 0.09320919, 0.08875731],
    maxSize: 101,
  },
  /**
   * The gauge and both labels sit at `qx(-30°)` inside the panel (the Texts'
   * `m_LocalRotation.x` is -0.25937867, i.e. 30.07°); the sprites add an
   * in-plane `qz(-90°)`, which is what turns Radial360's `Bottom` origin into
   * the LEFT end of the dome.
   */
  childTiltDegrees: 30.07,
} as const

/** The dome in metres, in the gauge's own plane, origin at the middle of its flat edge, +y up. */
export interface FuelDomeLayout {
  /** The panel quad: the dome's bounding box. */
  readonly widthM: number
  readonly heightM: number
  /** The half-disc, and the ring's OUTER edge. */
  readonly radiusM: number
  /** The ring, measured inward from `radiusM`. */
  readonly ringM: number
  /** `Fuel :` and the value, each CENTRED here (MiddleCenter). */
  readonly labelXM: number
  readonly valueXM: number
  /** Height of the text line's middle above the flat edge. */
  readonly textYM: number
  /** 2016's best-fit ceiling (101) as an em, in metres. */
  readonly emM: number
}

/**
 * The prefab, in metres.
 *
 * Scale chains are the only arithmetic. The sprite's in-plane `qz(-90°)` swaps
 * its axes, so the dome's WIDTH is the sprite's local Y scale times the
 * panel's X — which is also why the dome is very slightly an ellipse in 2016
 * (0.1805 m across, 0.176 m tall). The port draws the circle at the width.
 * The text's height above the flat edge is the offset between the two anchors
 * projected on the tilted plane's own up axis, because the text is 4.8 panel
 * units nearer the eye than the gauge and that depth reads as height once the
 * plane leans back.
 */
export const fuelDomeLayout = (g = FUEL_GAUGE_2016): FuelDomeLayout => {
  const [px, py, pz] = g.panel.scale
  const spriteToM = g.ring.scale[1] * px
  const radiusM = g.ring.radiusPx * spriteToM
  const tilt = (g.childTiltDegrees * Math.PI) / 180
  const dy = (g.label.anchored[1] - g.ring.anchored[1]) * py
  const dz = (g.label.z - g.ring.z) * pz
  return {
    widthM: radiusM * 2,
    heightM: radiusM,
    radiusM,
    ringM: g.ring.thicknessPx * spriteToM,
    labelXM: g.label.anchored[0] * px,
    valueXM: g.value.anchored[0] * px,
    textYM: dy * Math.cos(tilt) - dz * Math.sin(tilt),
    emM: g.label.maxSize * g.label.scale[1] * py,
  }
}

/** Evaluated once; the panel is built from it. */
export const FUEL_DOME: FuelDomeLayout = fuelDomeLayout()

/**
 * `FuelManager.cs:83` — what the value reads at an empty tank. A code literal
 * in 2016, not a serialised string, so it is here rather than in `level.ui`.
 */
export const FUEL_EMPTY_TEXT = 'EMPTY!'

/** `text_fuel`'s `Fuel :`, upper-cased the way the panel's other labels are. */
export const FUEL_LABEL_FALLBACK = 'FUEL'

/**
 * The value's text. `FuelManager.cs:95-97`: `((int)(pct * 100)) + "%"` —
 * TRUNCATED, so 59.9 % is `59%` — and `:82-83` writes `EMPTY!` at or below
 * zero. The port's tank goes negative on purpose (`sim/jumpseat.ts`), and 2016's
 * did too, so every negative is `EMPTY!` until a pad fills it back past zero.
 */
export const fuelValueText = (fraction: number): string =>
  fraction <= 0 ? FUEL_EMPTY_TEXT : `${Math.floor(Math.min(fraction, 1) * 100 + 1e-9)}%`

export type FuelBand = 'full' | 'med' | 'warning'

/**
 * `FuelManager.cs:99-115`, on the UNROUNDED fraction: above `medPercent` is
 * full, above `warningPercent` is medium, the rest is warning. Both thresholds
 * are the shipped prefab's (0.7 and 0.4), by key.
 */
export const fuelBand = (fraction: number): FuelBand =>
  fraction > JUMPSEAT.fuel.medPercent
    ? 'full'
    : fraction > JUMPSEAT.fuel.warningPercent
      ? 'med'
      : 'warning'

/**
 * How finely the arc moves. 2016 set `fillAmount` every frame; a canvas repaint
 * per frame is the cost HUD-REWORK exists to remove. 400 steps over half a
 * turn is two pixels of rim at the panel's density, which is the arc moving
 * rather than stepping, and the cadence budget still caps the paints.
 */
export const FUEL_ARC_STEPS = 400

/** The arc's share of its half-turn, 0..1, on the steps the signature holds. */
export const fuelArc = (fraction: number): number =>
  fraction <= 0 ? 0 : Math.round(Math.min(fraction, 1) * FUEL_ARC_STEPS) / FUEL_ARC_STEPS

/**
 * DEV-383. The spider's charge as a share of the half-turn, on the tank's own
 * steps — and 0 whenever no charge is building, which is every frame of every
 * seat that is not a spider.
 */
export const chargeArc = (state: HudState): number => fuelArc(state.jumpCharge ?? 0)

/**
 * The one line of FF2's own badges inside the dome — `AUTO`, `x3` — or ''.
 * None once the run is over (DEV-397): they are readings of a run still going.
 */
export const fuelBadges = (state: HudState): string => {
  if (state.finished) return ''
  const parts: string[] = []
  if (state.autopilot) parts.push('AUTO')
  const m = state.multiplier ?? 1
  if (m > 1) parts.push(`x${m}`)
  return parts.join('  ')
}

/** The event line: an award while it lasts, else the medal once the run is over, else ''. */
const eventText = (state: HudState): string => {
  const shown = state.award ?? (state.finished ? state.medal : '')
  return shown && shown.toLowerCase() !== 'none' ? shown : ''
}

/**
 * Everything the dome DRAWS, as one string — `hudSignature`'s rule, for this
 * drawing. Deliberately absent: speed, the clock, the count, the proximity
 * meter and the chain. None of them is on this panel, so none of them may
 * repaint it.
 */
export const fuelSignature = (state: HudState): string => {
  const fraction = state.energy?.fraction
  const parts = [
    state.banner ?? '',
    state.fuelLabel ?? FUEL_LABEL_FALLBACK,
    fraction === undefined ? '-' : fuelValueText(fraction),
    fraction === undefined ? '-' : fuelBand(fraction),
    fraction === undefined ? '-' : fuelArc(fraction),
    eventText(state),
    state.award ? (state.awardTone ?? '') : '',
    fuelBadges(state),
  ]
  // DEV-383: appended only while a charge builds, so no other seat's string —
  // and no other seat's repaint — moves by one byte.
  const charge = chargeArc(state)
  if (charge > 0) parts.push(`charge ${charge}`)
  return parts.join('|')
}

/** What `drawFuelDome` asks of the canvas — `hudCanvasOps`, for this drawing. */
export const fuelCanvasOps = (state: HudState): HudCanvasOps => {
  let total = 1 // clearRect
  let texts = 0
  const disc = () => {
    total += 4 // beginPath + arc + closePath + fill
  }
  const text = () => {
    total += 1
    texts += 1
  }
  disc()
  if (state.banner) {
    text()
    return { total, texts, measures: 0 }
  }
  if (state.energy !== undefined && fuelArc(state.energy.fraction) > 0) total += 3 // beginPath + arc + stroke
  if (chargeArc(state) > 0) total += 3 // DEV-383's charge ring, the same three
  text()
  if (state.energy !== undefined) text()
  if (eventText(state)) text()
  if (fuelBadges(state)) text()
  return { total, texts, measures: 0 }
}

/** The panel's inks, passed in so this module never imports `hud.ts` at runtime. */
export interface FuelDomeInks {
  readonly ink: string
  readonly accent: string
  readonly muted: string
}

/** A colour off the sheet, as CSS, at `alpha` times its own. */
const css = (c: { r: number; g: number; b: number; a: number }, alpha: number): string =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${+(c.a * alpha).toFixed(4)})`

const BAND_COLOUR = {
  full: JUMPSEAT.fuel.colorFull,
  med: JUMPSEAT.fuel.colorMed,
  warning: JUMPSEAT.fuel.colorWarning,
} as const

/**
 * The half-disc's ink: the sprite's grey texel times the Image's green tint,
 * multiplied in LINEAR because 2016's project is `m_ActiveColorSpace: 1`, then
 * back to sRGB for the canvas. About rgb(5, 27, 4) at 47 % — near-black green,
 * which is why the dome reads dark red over a red pad and dark green over a
 * green one in the capture. Never recoloured: `FuelManager` touches only the ring.
 */
export const FUEL_DISC_CSS = (() => {
  const d = FUEL_GAUGE_2016.disc
  const texel = srgbToLinear(d.meanGrey / 255)
  const ch = (tint: number) => Math.round(linearToSrgb(texel * srgbToLinear(tint)) * 255)
  return `rgba(${ch(d.color[0])}, ${ch(d.color[1])}, ${ch(d.color[2])}, ${+(d.alpha / 255).toFixed(4)})`
})()

/** The ring's ink per band — the sheet's colour at the sprite's 183/255. */
export const fuelRingCss = (band: FuelBand): string =>
  css(BAND_COLOUR[band], FUEL_GAUGE_2016.ring.alpha / 255)

/**
 * Paint the dome. `w` × `h` is the whole canvas, which is the dome's bounding
 * box; the flat edge is its bottom row and the centre is its middle.
 *
 * Every text call carries a `maxWidth`, because the typeface is a stand-in and
 * its widths are the platform's: a value that would run into the label is
 * narrowed rather than allowed to overlap it.
 */
export const drawFuelDome = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: HudState,
  inks: FuelDomeInks,
  font: (px: number) => string,
): void => {
  const L = FUEL_DOME
  const ppm = w / L.widthM
  const cx = w / 2
  const cy = h
  const R = L.radiusM * ppm
  const em = L.emM * ppm
  /** The dome's half-width at a height above the flat edge — what a line of text may use. */
  const chord = (above: number) => Math.sqrt(Math.max(0, R * R - above * above))

  ctx.clearRect(0, 0, w, h)
  // The half-disc: Radial360 from the left, clockwise, to 0.5 — the upper half.
  ctx.fillStyle = FUEL_DISC_CSS
  ctx.beginPath()
  ctx.arc(cx, cy, R, Math.PI, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // The launch banner replaces the reading, as it does on the rows: the tank
  // is full and still during the ride, and the prompt is the only thing that
  // matters yet. Inside the same dome, so the panel does not change shape.
  if (state.banner) {
    const big = state.banner.length <= 2
    const y = big ? R * 0.42 : R * 0.3
    ctx.fillStyle = big ? inks.accent : inks.ink
    ctx.font = font(big ? R * 0.62 : em * 0.62)
    ctx.fillText(state.banner, cx, cy - y, chord(y) * 1.8)
    return
  }

  const fraction = state.energy?.fraction
  const arc = fraction === undefined ? 0 : fuelArc(fraction)
  if (fraction !== undefined && arc > 0) {
    // The ring, as a stroke centred inside the disc's edge. A butt cap on an
    // arc is a RADIAL cut, which is exactly what a Radial360 fill leaves.
    ctx.strokeStyle = fuelRingCss(fuelBand(fraction))
    ctx.lineWidth = L.ringM * ppm
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.arc(cx, cy, R - (L.ringM * ppm) / 2, Math.PI, Math.PI * (1 + arc))
    ctx.stroke()
  }

  // DEV-383: the spider's charge. A HALF-width ring flush against the inside
  // of the tank's, filling the same way over the same half-turn, in the
  // panel's accent so it cannot be read as fuel. Half width so it clears the
  // `AUTO` line at the top of the dome, which the spider's autopilot shows:
  // that line's em box reaches 0.85 R, a full-width ring's inner edge would
  // sit on it, and this one's is at R - 1.5 rings, 0.89 R. `hud-fuel.test.ts`
  // measures the clearance off the drawing.
  const charge = chargeArc(state)
  if (charge > 0) {
    const ring = L.ringM * ppm
    ctx.strokeStyle = inks.accent
    ctx.lineWidth = ring / 2
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.arc(cx, cy, R - ring * 1.25, Math.PI, Math.PI * (1 + charge))
    ctx.stroke()
  }

  // `Fuel :` and the value: two boxes, each centred on its own anchor.
  const textY = cy - L.textYM * ppm
  ctx.font = font(em)
  ctx.fillStyle = inks.ink
  // Each box may run to the midpoint between the two anchors and no further,
  // less a small gap, so `EMPTY!` narrows rather than meeting the colon.
  const gap = em * 0.2
  const split = (L.labelXM + L.valueXM) / 2
  ctx.fillText(
    `${state.fuelLabel ?? FUEL_LABEL_FALLBACK} :`,
    cx + L.labelXM * ppm,
    textY,
    (split - L.labelXM) * ppm * 2 - gap,
  )
  if (fraction !== undefined) {
    ctx.fillText(
      fuelValueText(fraction),
      cx + L.valueXM * ppm,
      textY,
      (L.valueXM - split) * ppm * 2 - gap,
    )
  }

  // FF2's own layer, above the fuel line and only while it has something to say.
  const event = eventText(state)
  if (event) {
    const y = R * 0.56
    ctx.fillStyle = state.award && state.awardTone === 'loss' ? inks.muted : inks.accent
    ctx.font = font(em * (event.length > 12 ? 0.42 : 0.6))
    ctx.fillText(event.toUpperCase(), cx, cy - y, chord(y) * 1.8)
  }
  const badges = fuelBadges(state)
  if (badges) {
    const y = R * 0.8
    ctx.fillStyle = inks.accent
    ctx.font = font(em * 0.42)
    ctx.fillText(badges, cx, cy - y, chord(y) * 1.8)
  }
}
