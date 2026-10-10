// src/content/player-course-light.ts — a player course's sun and tint. DEV-476.
//
// Matt, 2026-09-27, his first session in the editor: *"would love to change
// time-of-day and lighting tint settings"*; and, of the options put to him,
// *"sun sliders plus a tint: sun height and direction, and a colour tint
// reusing DEV-446's scene tint, saved in the course. Sky and ambient still
// come from the chosen sky mission."*
//
// So a course may carry an OPTIONAL `light` block (`player-course.ts` parses it
// and writes it only when present, so a course without one keeps its bytes and
// its id): where the sun stands, and a colour filter over the picture. This
// file is the arithmetic: the angles, the one direction they make, and how far
// the SKY lets the sun move.
//
// ── The angles ───────────────────────────────────────────────────────────
//
// `sunAzimuth` is the heading the sun stands AT, in the start pad's own
// convention (`yawForward`, 2016's spawn yaw): 0 is toward −z, and a positive
// angle turns toward −x. `sunElevation` is degrees above the horizon, as
// `SunLight.elevationDeg` is. The level's `lighting.sun.direction` is the way
// the light TRAVELS, three space — the negation of the unit vector toward the
// sun — so every shipped mission's sun has an azimuth and an elevation in this
// convention (`sunAnglesOf`), and a course's light starts from its sky's.
//
// ── What the sky allows, and why that is the clamp ───────────────────────
//
// The sky is the donor's (Matt's answer), so a moved sun must not contradict
// it. What in a sky can disagree with a sun?
//
//  * **A decoded sky** (`lighting.sky.available`: `int_01_hoverJet`,
//    `adv_02_hoverJet`, `hoverJet_kauai_beg`, the SkyJ skybox) carries its
//    colour in every direction as nine SH coefficients, and its glow was
//    painted round the mission's own sun (1.5° off it, the extractor's
//    receipt). The dome still draws a disc and a glow wherever the sun is,
//    but the nine coefficients stay where 2016 painted them. So the rule is
//    measured on them: **the sun may stand wherever the donor's own sky is at
//    least as bright as its own average** over the upper hemisphere
//    (`PLAYER_COURSE_LIGHT.skyAgreement`, 1). Past that the disc sits in the
//    darkest quarter of a sunset sky, which a sky lit by it cannot be. On
//    SkyJ, at 2016's own 4°, that lets the sun turn 58° one way round the
//    horizon and 198° the other (the painted warmth wraps round behind the
//    sun), and climb to 58° over its own heading; it refuses the dark sector
//    between, and the zenith, which is darker than SkyJ's mean from every side
//    (`tests/unit/player-course-light.test.ts` measures and holds all three).
//  * **An undecoded sky** (the other four HoverJet skies) is FF2's own
//    fog-derived gradient, the same in every direction round the horizon,
//    with the glow and the disc drawn at the sun. Nothing in it is 2016's
//    painting of a sun, so nothing disagrees: the sun turns all the way
//    round. The same test would be WRONG there — the gradient is brightest at
//    the horizon and would refuse the 43–53° suns three of those missions
//    ship with.
//
// And one floor under every sky: **the far-shadow march's own**
// (`MIN_SUN_HEIGHT_SIN`, 0.5°). `sim/terrain/sun-height.ts` marches no sun
// lower than that: one between it and the horizon has its shadows marched AT
// the floor (DEV-527), so the editor offers no sun whose shadows would come
// from a different sun than the one it lights by. (`int_02_hoverJet` ships at
// 0.083° and is the one sun that lift serves; a course on that sky without a
// `light` keeps 2016's sun and gets the same lifted march.)
//
// The clamp is applied twice, on purpose: the editor stores the clamped value,
// so the course says what is flown; and the expansion clamps again, so a
// hand-written file, or a sky changed under a stored light, flies inside the
// band rather than being refused.
//
// Pure and synchronous, three-free: the expansion is, and a Playwright spec
// imports this through `player-course.ts`.

import { RAD_PER_DEG } from '@/sim/math/scalar'
import { shRadiance } from '@/sim/sky-dome'
import { MIN_SUN_HEIGHT_SIN } from '@/sim/terrain/sun-height'
import type { Level, SunLight, Vec3Tuple } from './level-schema'
import { normaliseDegreesOnGrid, quantise } from './quantise'

/** A course's light (DEV-476). Optional in v2; absent is the sky mission's own. */
export interface PlayerCourseLight {
  /** Degrees, [−180, 180): the heading the sun stands at (see the header). */
  readonly sunAzimuth: number
  /** Degrees above the horizon. */
  readonly sunElevation: number
  /** sRGB 0..1, as a colour picker gives it: DEV-446's `SceneTintValue.color`. */
  readonly tint: readonly [number, number, number]
  /** 0..1: DEV-446's `SceneTintValue.strength`. 0 is no tint whatever the colour. */
  readonly tintAmount: number
}

/**
 * The light block's grid and bounds. Policy, each with its reason, pinned by
 * value in `tests/unit/player-course-light.test.ts` (the HUD_RASTER_SHIPPED
 * pattern), so moving one is an edit made on purpose.
 */
export const PLAYER_COURSE_LIGHT = {
  /** The pad's heading grid (`PLAYER_COURSE_SHAPE.yawQuantumDegrees`): a slider's step. */
  angleQuantumDegrees: 0.1,
  /**
   * A tint channel to 1/1000: finer than the picker's 8 bits (1/255), so a
   * colour picked, stored and picked again is the same colour.
   */
  tintQuantum: 0.001,
  /** The tint's strength to a hundredth, as DEV-446's lookdev slider steps it. */
  tintAmountQuantum: 0.01,
  /** Overhead. The structural bound; the sky's band may be lower. */
  elevationMaxDegrees: 90,
  /**
   * How bright, against its own upper-hemisphere mean, a decoded sky must be
   * where the sun stands. 1: at least its average (the header's argument).
   */
  skyAgreement: 1,
  /** The lat-long step, degrees, the sky's mean is integrated over. */
  skyMeanStepDegrees: 1,
} as const

const Q = PLAYER_COURSE_LIGHT.angleQuantumDegrees

/** An azimuth on its grid, in [-180, 180): the pad's `normaliseYaw`, for the sun. */
export const normaliseAzimuth = (a: number): number => normaliseDegreesOnGrid(a, Q)

/**
 * The lowest elevation a course's sun may have, degrees, on the grid: the far-
 * shadow march's floor (`MIN_SUN_HEIGHT_SIN`), rounded UP to the grid so the
 * march always runs.
 */
export const SUN_ELEVATION_FLOOR = ((): number => {
  let e = quantise(Math.asin(MIN_SUN_HEIGHT_SIN) / RAD_PER_DEG, Q)
  while (Math.sin(e * RAD_PER_DEG) < MIN_SUN_HEIGHT_SIN) e = quantise(e + Q, Q)
  return e
})()

/** The unit vector TOWARD the sun, three space, from its two angles. */
export const towardSunOf = (azimuth: number, elevation: number): Vec3Tuple => {
  const a = azimuth * RAD_PER_DEG
  const e = elevation * RAD_PER_DEG
  const c = Math.cos(e)
  return [-Math.sin(a) * c, Math.sin(e), -Math.cos(a) * c]
}

/** `lighting.sun.direction`: the way the light TRAVELS, the negation of `towardSunOf`. */
export const sunTravelOf = (azimuth: number, elevation: number): Vec3Tuple => {
  const t = towardSunOf(azimuth, elevation)
  return [-t[0] || 0, -t[1] || 0, -t[2] || 0]
}

/** The two angles of a travel direction (a level's `lighting.sun.direction`). Not quantised. */
export const sunAnglesOf = (
  travel: readonly number[],
): { readonly azimuth: number; readonly elevation: number } => {
  const x = -(travel[0] as number)
  const y = -(travel[1] as number)
  const z = -(travel[2] as number)
  const len = Math.hypot(x, y, z) || 1
  return {
    azimuth: Math.atan2(-x, -z) / RAD_PER_DEG,
    elevation: Math.asin(Math.max(-1, Math.min(1, y / len))) / RAD_PER_DEG,
  }
}

// ── The sky's agreement ──────────────────────────────────────────────────

type Sh = readonly (readonly number[])[]

/** Rec. 709 luma of linear rgb: how bright the sky is, as one number. */
const LUMA = [0.2126, 0.7152, 0.0722] as const
const rgb = { r: 0, g: 0, b: 0 }
/** The decoded sky's luminance TOWARD `(azimuth, elevation)`. UNITY space: one z negated, as `render/sky.ts` does it. */
const skyLumaAt = (sh: Sh, azimuth: number, elevation: number): number => {
  const t = towardSunOf(azimuth, elevation)
  shRadiance(sh, t[0], t[1], -t[2], rgb)
  return LUMA[0] * rgb.r + LUMA[1] * rgb.g + LUMA[2] * rgb.b
}

const MEANS = new WeakMap<object, number>()
/** The sky's mean luminance over the upper hemisphere, solid-angle weighted. Cached per sky. */
const skyMean = (sh: Sh): number => {
  const held = MEANS.get(sh)
  if (held !== undefined) return held
  const step = PLAYER_COURSE_LIGHT.skyMeanStepDegrees
  let sum = 0
  let weight = 0
  for (let e = step / 2; e < 90; e += step) {
    const w = Math.cos(e * RAD_PER_DEG)
    for (let a = -180 + step / 2; a < 180; a += step) {
      sum += skyLumaAt(sh, a, e) * w
      weight += w
    }
  }
  const mean = weight > 0 ? sum / weight : 0
  MEANS.set(sh, mean)
  return mean
}

/** The decoded sky's nine coefficients, or null (the gradient stands in, and allows any heading). */
const decodedSky = (donor: Level): Sh | null => {
  const sky = donor.lighting.sky
  return sky?.available && sky.sh.length === 9 ? sky.sh : null
}

/**
 * The decoded sky's brightness toward `(azimuth, elevation)` over its own mean,
 * or null for a sky that has none to measure. 1 is its average.
 */
export const skyAgreementAt = (donor: Level, azimuth: number, elevation: number): number | null => {
  const sh = decodedSky(donor)
  if (!sh) return null
  const mean = skyMean(sh)
  return mean > 0 ? skyLumaAt(sh, azimuth, elevation) / mean : null
}

export interface ClampedSun {
  readonly azimuth: number
  readonly elevation: number
  /** True when the sky or a bound moved it from where it was asked for. */
  readonly held: boolean
}

/**
 * The directions a decoded sky agrees with, on a coarse grid (one per degree of
 * azimuth, and per degree of elevation from the floor to overhead): toward
 * vectors and their angles. Built once per sky, for the clamp's first pass.
 */
interface AgreeingGrid {
  /** x, y, z, azimuth, elevation per agreeing cell. */
  readonly cells: Float64Array
  readonly count: number
}
const GRIDS = new WeakMap<object, AgreeingGrid>()
const agreeingGrid = (sh: Sh, need: number): AgreeingGrid => {
  const held = GRIDS.get(sh)
  if (held) return held
  const out: number[] = []
  const floor = SUN_ELEVATION_FLOOR
  const ceil = PLAYER_COURSE_LIGHT.elevationMaxDegrees
  const elevations = [floor]
  for (let e = Math.ceil(floor); e <= ceil; e++) if (e > floor) elevations.push(e)
  for (const e of elevations) {
    for (let a = -180; a < 180; a++) {
      if (skyLumaAt(sh, a, e) < need) continue
      const t = towardSunOf(a, e)
      out.push(t[0], t[1], t[2], a, e)
    }
  }
  const grid = { cells: Float64Array.from(out), count: out.length / 5 }
  GRIDS.set(sh, grid)
  return grid
}

/**
 * Where the sky lets the sun stand, nearest to `(azimuth, elevation)`, on the
 * grid. Inside the band it is returned as asked (quantised). Outside, it goes
 * to the NEAREST direction the sky agrees with — the least angle on the sky,
 * found on the one-degree grid and then refined on the tenth-degree one round
 * the cell that won — so a sun dragged into the dark sector stops at its edge
 * at about the height it was dragged at. Deterministic: the same donor and
 * angles give the same answer. Past the floor and overhead it is clamped to
 * them first, on every sky.
 */
export const clampSunToSky = (donor: Level, azimuth: number, elevation: number): ClampedSun => {
  const floor = SUN_ELEVATION_FLOOR
  const ceil = PLAYER_COURSE_LIGHT.elevationMaxDegrees
  const a0 = normaliseAzimuth(Number.isFinite(azimuth) ? azimuth : 0)
  const eAsked = quantise(Number.isFinite(elevation) ? elevation : floor, Q)
  const e0 = Math.min(ceil, Math.max(floor, eAsked))
  const sh = decodedSky(donor)
  if (!sh) return { azimuth: a0, elevation: e0, held: e0 !== eAsked }
  const need = PLAYER_COURSE_LIGHT.skyAgreement * skyMean(sh)
  if (skyLumaAt(sh, a0, e0) >= need) return { azimuth: a0, elevation: e0, held: e0 !== eAsked }
  const grid = agreeingGrid(sh, need)
  // A sky darker than its own mean everywhere is not a sky; keep the sun where asked.
  if (grid.count === 0) return { azimuth: a0, elevation: e0, held: e0 !== eAsked }
  const t = towardSunOf(a0, e0)
  let best = -1
  let bestDot = Number.NEGATIVE_INFINITY
  for (let i = 0; i < grid.count; i++) {
    const o = i * 5
    const d =
      t[0] * (grid.cells[o] as number) +
      t[1] * (grid.cells[o + 1] as number) +
      t[2] * (grid.cells[o + 2] as number)
    if (d > bestDot) {
      bestDot = d
      best = o
    }
  }
  // Refine round the winning cell, a degree either way, on the course's grid.
  const ca = grid.cells[best + 3] as number
  const ce = grid.cells[best + 4] as number
  let out = { azimuth: normaliseAzimuth(ca), elevation: quantise(ce, Q) }
  bestDot = Number.NEGATIVE_INFINITY
  const reach = Math.round(1 / Q)
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      const a = normaliseAzimuth(ca + i * Q)
      const e = quantise(ce + j * Q, Q)
      if (e < floor || e > ceil || skyLumaAt(sh, a, e) < need) continue
      const u = towardSunOf(a, e)
      const d = t[0] * u[0] + t[1] * u[1] + t[2] * u[2]
      if (d > bestDot) {
        bestDot = d
        out = { azimuth: a, elevation: e }
      }
    }
  }
  return { ...out, held: true }
}

// ── The light, on its grid, and the sun it makes ─────────────────────────

const unit = (x: number): number => Math.min(1, Math.max(0, x))

/** A light with every number on its grid (angles NOT clamped to a sky: that needs the donor). */
export const quantiseLight = (l: PlayerCourseLight): PlayerCourseLight => ({
  sunAzimuth: normaliseAzimuth(l.sunAzimuth),
  sunElevation: quantise(l.sunElevation, Q),
  tint: [
    quantise(unit(l.tint[0]), PLAYER_COURSE_LIGHT.tintQuantum),
    quantise(unit(l.tint[1]), PLAYER_COURSE_LIGHT.tintQuantum),
    quantise(unit(l.tint[2]), PLAYER_COURSE_LIGHT.tintQuantum),
  ],
  tintAmount: quantise(unit(l.tintAmount), PLAYER_COURSE_LIGHT.tintAmountQuantum),
})

/** `light`, quantised and with its sun inside `donor`'s sky. */
export const clampLight = (donor: Level, light: PlayerCourseLight): PlayerCourseLight => {
  const q = quantiseLight(light)
  const sun = clampSunToSky(donor, q.sunAzimuth, q.sunElevation)
  return { ...q, sunAzimuth: sun.azimuth, sunElevation: sun.elevation }
}

/**
 * The sky's own light as a course's: its sun's two angles (clamped to the
 * band, which only moves a sun under the march's floor), no tint. Where the
 * editor's sliders start.
 */
export const skyLight = (donor: Level): PlayerCourseLight => {
  const sun = donor.lighting.sun
  const angles = sun ? sunAnglesOf(sun.direction) : { azimuth: 0, elevation: 45 }
  return clampLight(donor, {
    sunAzimuth: angles.azimuth,
    sunElevation: angles.elevation,
    tint: [1, 1, 1],
    tintAmount: 0,
  })
}

/**
 * The sun a course with `light` flies under: the donor's own sun — its colour,
 * intensity, shadows and name — standing where the light says, inside the
 * sky's band. Without a light, or on a donor with no sun, the donor's, as it
 * is (the same object).
 */
export const playerCourseSun = (
  donor: Level,
  light: PlayerCourseLight | undefined,
): SunLight | null => {
  const sun = donor.lighting.sun
  if (!light || !sun) return sun
  const l = clampLight(donor, light)
  return {
    ...sun,
    direction: sunTravelOf(l.sunAzimuth, l.sunElevation),
    elevationDeg: l.sunElevation,
  }
}
