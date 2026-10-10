// src/game/wing-trail-fade.ts — how strongly the wing-tip trails draw, as
// arithmetic. DEV-358.
//
// Matt, 2026-09-24, on third person: *"particle trails on the wing-tips once
// we're at a decent speed (show them on the ai racers as well)."*
//
// `render/wing-trails.ts` draws the ribbons; this decides how much of them to
// draw. Three-free, so the unit test runs it bare.
//
// ── "A decent speed" is the speed the engine holds on its own ────────────
//
// The sheet derives the HoverJet's two terminal speeds from the prefab's
// thrust, mass and drag: `derived.hoverjet.terminalSpeedCruise`, 89.81 m/s,
// where an UNBOOSTED ship settles, and `terminalSpeedBoost`, 179.62 m/s, where
// a ship on full boost does — exactly twice cruise, because the boost doubles
// the thrust. The trails are WHOLE at cruise and fade out over the same factor
// of two below it: nothing at cruise / 2 = cruise² / boost = 44.91 m/s. Both
// ends off the generated sheet (`DERIVED`); no speed here is typed in.
//
// **The follow-up moved this, and why is the answer to Matt's "add a trail to
// the player in third person".** DEV-358 shipped the fade from cruise to FULL
// BOOST, so a ship flying at its own terminal speed made no vapour at all. The
// autopilot boosts, which is why every burst showed trails; a player holds a
// button to boost (`input/keyboard.ts`, Z or Ctrl), and a player who does not
// settles at 89.8 m/s and saw nothing. The trail was there, and could not be
// seen by the one person the flag was for. Before that, the first cut was
// 2016's first speed-effect cut, 120 to 180 m/s, which two of the five racers
// never reach. Whole at cruise, every racer and an unboosted player draw it,
// and only a ship below half its own cruising speed (the grid, a crash, a hover)
// does not.
//
// A SMOOTHSTEP between the two, not a straight line: its slope is zero at both
// ends, so crossing into the band in a corner begins the trails with no visible
// edge. "Binary" was the complaint about the speed lines (DEV-351), and a
// linear ramp's corner at its start is a small version of the same step.
//
// It rises with speed and never falls with it. That is the whole of the
// "monotonic" claim, and the unit test holds it.
//
// ── The comfort slider ───────────────────────────────────────────────────
//
// A sense of speed is vection (ART_DIRECTION: *"anything that creates vection
// is scaled by the speed-FX comfort slider"*), so the trails ride `speedFx`:
// 0 is OFF, whatever the flag says, and above 0 the slider MULTIPLIES the
// opacity. `light` (0.5, the default) is half the preset's `alpha`, because
// `game/edition.ts` asks every feature to author at `full` and to let `light`
// be a real reduction. Width and length are not scaled: a thinner or shorter
// trail is a different shape, and the slider is about how much is seen.
//
// ── Forward speed, not the speed ─────────────────────────────────────────
//
// `bodyForwardSpeed` is the same quantity `boot/app.ts`'s `forwardSpeedOf`
// keys the speed lines to: the velocity along the ship's own nose, which is
// what 2016 reads (`ForwardSpeed`). A ship falling or sliding sideways at
// 200 m/s is not flying at a decent speed.

import type { EditionWingTrails } from '@/content/edition-schema'
import { DERIVED } from '@/generated/constants.generated'

/** Where the fade starts and where it is whole, metres per second of forward speed. */
export interface WingTrailFade {
  /** At and below this, nothing: cruise over the boost's factor, cruise² / boost. */
  readonly from: number
  /** At and above this, whole: the unboosted terminal speed. */
  readonly full: number
}

/** The two terminal speeds a fade is built from. */
export interface TerminalSpeeds {
  readonly terminalSpeedCruise: number
  readonly terminalSpeedBoost: number
}

/**
 * The fade from two terminal speeds: whole at cruise, and nothing the boost's
 * own factor BELOW it. Pass `DERIVED.hoverjet`.
 */
export const wingTrailFade = (terminals: TerminalSpeeds): WingTrailFade => {
  const cruise = terminals.terminalSpeedCruise
  const factor = terminals.terminalSpeedBoost / cruise
  return Object.freeze({ from: factor > 0 ? cruise / factor : 0, full: cruise })
}

/** The HoverJet's fade, off the generated sheet: half cruise to cruise. */
export const hoverJetWingTrailFade = (): WingTrailFade => wingTrailFade(DERIVED.hoverjet)

// ── the tint ─────────────────────────────────────────────────────────────

/** An sRGB triple, 0..1. `render/racer-livery.ts`'s `Srgb`, restated to stay three-free. */
export type TintSrgb = readonly [number, number, number]

/**
 * A craft's trail colour, sRGB 0..1: white, moved `amount` of the way toward
 * the livery's own hue at FULL BRIGHTNESS. DEV-358 follow-up.
 *
 * "At full brightness" is the whole design, and it is what kept DEV-350's
 * charcoal from reading as smoke: the livery is divided by its brightest channel
 * before it is mixed, so what the trail takes from it is its hue and its
 * saturation and never its darkness. A grey such as that charcoal (0.15, 0.15,
 * 0.15; the rainbow palette has none) has no hue, so it comes out WHITE, the
 * same vapour as an untinted trail; blue comes out a pale blue; no
 * channel can fall below `1 - amount`, which is what "mostly white" means as a
 * number. `null` (no livery) and an amount of 0 are white.
 */
export const trailTint = (livery: TintSrgb | null, amount: number): [number, number, number] => {
  const k = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0
  if (!livery || k === 0) return [1, 1, 1]
  const peak = Math.max(livery[0], livery[1], livery[2])
  if (!(peak > 0)) return [1, 1, 1]
  const mix = (c: number): number => 1 - k * (1 - Math.min(1, Math.max(0, c / peak)))
  return [mix(livery[0]), mix(livery[1]), mix(livery[2])]
}

/**
 * 0 at and below `fade.from`, 1 at and above `fade.full`, a smoothstep between.
 * A non-finite speed is no speed. A degenerate fade (`full <= from`) is a step
 * at `from`, the way DEV-351's degenerate onset is.
 */
export const wingTrailSpeedFactor = (forwardSpeed: number, fade: WingTrailFade): number => {
  const v = Number.isFinite(forwardSpeed) ? forwardSpeed : 0
  if (v <= fade.from) return 0
  if (fade.full <= fade.from || v >= fade.full) return 1
  const t = (v - fade.from) / (fade.full - fade.from)
  return t * t * (3 - 2 * t)
}

/**
 * What the preset and the comfort slider allow, before the speed: 0 is off.
 * The flag off, or the slider at 0, is 0; otherwise the slider, clamped to 1.
 */
export const wingTrailScale = (
  flag: Pick<EditionWingTrails, 'enabled'>,
  speedFx: number,
): number => (!flag.enabled || !(speedFx > 0) ? 0 : Math.min(1, speedFx))

/**
 * The whole of it: how strongly one craft's trails draw this frame, 0-1. The
 * renderer multiplies the preset's `alpha` by this.
 */
export const wingTrailStrength = (
  forwardSpeed: number,
  fade: WingTrailFade,
  flag: Pick<EditionWingTrails, 'enabled'>,
  speedFx: number,
): number => wingTrailScale(flag, speedFx) * wingTrailSpeedFactor(forwardSpeed, fade)

/** The parts of a sim body this reads. Sim space in, which the dot product does not care about. */
export interface ForwardSpeedBody {
  readonly orientation: {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly w: number
  }
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * Velocity along the ship's own +Z, m/s: `boot/app.ts`'s `forwardSpeedOf`,
 * for a body rather than a `Flight`, so the racers can use it too.
 *
 * The rotated axis is the third column of the orientation's matrix, written
 * out so nothing is allocated per racer per frame.
 */
export const bodyForwardSpeed = (body: ForwardSpeedBody): number => {
  const { x, y, z, w } = body.orientation
  const fx = 2 * (x * z + w * y)
  const fy = 2 * (y * z - w * x)
  const fz = 1 - 2 * (x * x + y * y)
  const v = body.velocity
  return fx * v.x + fy * v.y + fz * v.z
}
