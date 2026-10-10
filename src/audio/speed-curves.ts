// src/audio/speed-curves.ts — the Anniversary preset's continuous controls, as
// arithmetic. PURE, and it knows nothing about cues, Web Audio or the DOM.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// docs/plan/ANNIVERSARY.md §2.3 item 5, in one line: *the sound does not change
// with speed.* 2016's loops gate on and off and sit at one pitch and one gain
// from 25 m/s to 340 m/s, because there is **zero runtime pitch modulation in
// first-party 2016 code** — see `engine.ts`'s header, which traces every gate to
// a line. Classic keeps that. Anniversary puts a curve where the edge was, and
// this file is the curve.
//
// ── Why breakpoints and not a formula ─────────────────────────────────────
//
// Because the numbers are CONTENT (hard rule 6, and rule 3's reasoning): a
// tuning constant typed into `src/audio/` is indistinguishable from an extracted
// one in six months, which is DEV-008's trap exactly. A formula would put its
// shape in code and only its coefficients in the preset; a breakpoint table puts
// the whole shape in `content/editions/anniversary.json`, where Matt can move a
// number and hear it without a compile. The types are declared in
// `src/content/edition-schema.ts`, the gate is `content/editions/_schema.json`,
// and `tests/unit/edition-content.test.ts` refuses a key nobody declared.
//
// ── DEV-027: say what a number is the ... OF ──────────────────────────────
//
// Every curve here has its x named in its type and its unit written down, because
// the failure this file invites is exactly the one DEV-027 cost a day to: two
// curves whose x is "speed" where one means metres per second and the other means
// a 0..1 throttle. So: the wind curves are keyed on **forward speed in m/s** (the
// same `Ship_HoverShip.ForwardSpeed` `engine.ts` gates on) and the engine curves
// are keyed on the **throttle demand, 0..1** (the right trigger). Nothing here is
// keyed on a frame delta, because nothing here sees one (D4).

import type {
  Breakpoints,
  EditionEnginePitchTracking,
  EditionEngineRumble,
  EditionSpeedCurves,
} from '@/content/edition-schema'

/**
 * Read a breakpoint curve at `x`, linearly between the points and FLAT outside
 * them.
 *
 * Flat rather than extrapolated, and that is the whole safety property: a ship
 * that somehow reaches 500 m/s gets the 340 m/s value, not a gain of 1.6 or a
 * cutoff past Nyquist. Extrapolation is how a tuning table becomes a crash.
 *
 * `curve` is assumed sorted ascending in x — `validateEdition` refuses a preset
 * where it is not, so the check is at load rather than at 82 Hz.
 *
 * An EMPTY curve answers 0. The loader refuses one (the schema's `minItems` is
 * two), so this exists only to make the function total; it is pinned by a test
 * rather than left to be discovered.
 */
export const sampleCurve = (curve: Breakpoints, x: number): number => {
  const n = curve.length
  if (n === 0) return 0
  const first = curve[0] as readonly [number, number]
  if (n === 1 || x <= first[0]) return first[1]
  const last = curve[n - 1] as readonly [number, number]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < n; i++) {
    const b = curve[i] as readonly [number, number]
    if (x > b[0]) continue
    const a = curve[i - 1] as readonly [number, number]
    const span = b[0] - a[0]
    // Two points at the same x is a step, not a divide by zero. The loader
    // allows it (ascending is `>=`, not `>`) because a step is a legitimate
    // thing to author — "silent below 120, half above it".
    if (!(span > 0)) return b[1]
    return a[1] + ((x - a[0]) / span) * (b[1] - a[1])
  }
  return last[1]
}

/**
 * The two numbers the wind layers are driven by at one airspeed.
 *
 * One cutoff for BOTH loops, two gains. The gains differ because the loops
 * occupy different bands — `AircraftWind` from 25 m/s, `FlightWind` from 120 —
 * and the crossfade between them is what replaces 2016's duck (see below). The
 * cutoff is shared because it stands for one physical quantity: how much air is
 * going past the canopy.
 */
export interface WindModulation {
  readonly aircraftGain: number
  readonly flightGain: number
  readonly cutoffHz: number
  /**
   * Playback rate on both loops, `CueSpec.pitch`'s meaning. DEV-425.
   *
   * Shared for the cutoff's reason: one quantity, the air. The cutoff opens the
   * top of the wind and this lifts every band in it, and the two are not the
   * same gesture — a brighter noise and a HIGHER one — which is why Matt could
   * hear the wind get louder and brighter for ten days and still ask for it to
   * pitch up with speed.
   */
  readonly rate: number
}

export const windModulation = (curves: EditionSpeedCurves, speed: number): WindModulation => ({
  aircraftGain: sampleCurve(curves.aircraftWindGain, speed),
  flightGain: sampleCurve(curves.flightWindGain, speed),
  cutoffHz: sampleCurve(curves.windCutoffHz, speed),
  rate: sampleCurve(curves.windRate, speed),
})

/**
 * The thruster loop's playback rate for a throttle demand, with the afterburner's
 * step folded in.
 *
 * The step is multiplicative and it is on the THRUSTER, not on the afterburner
 * loop: `Input_Ship.cs:426` needs both triggers, so the burner never sounds
 * alone, and what a pilot hears when the boost lights is the main engine
 * jumping — not a second sound at a different pitch arriving on its own.
 */
export const thrustRate = (
  curves: EditionSpeedCurves,
  throttle: number,
  burning: boolean,
): number => sampleCurve(curves.thrustRate, throttle) * (burning ? curves.afterburnerStep : 1)

/** The afterburner loop's own rate. Keyed on throttle, like the thruster. */
export const afterburnerRate = (curves: EditionSpeedCurves, throttle: number): number =>
  sampleCurve(curves.afterburnerRate, throttle)

/**
 * How loud and how high the gate whoosh is, at the speed you took the gate at.
 *
 * **Louder and HIGHER, not louder and shorter.** The brief for this feature
 * asked for shorter; the cue's length lives on its `CueSpec.durationSeconds` and
 * reaches the backend through `applyEnvelope` and `cueTailSeconds`, so a per-play
 * duration scale would have to thread through both plus the one-shot teardown —
 * three places, for a cue already at 0.34 s, which is about the floor of what
 * reads as a pass rather than a click. Pitch is the parameter the synthesis
 * already takes per play (`PlayOptions.pitch`), it moves the band-pass sweep's
 * whole trajectory up, and that is what a faster pass sounds like. Written down
 * rather than quietly substituted. (DEV-084.)
 */
export interface WhooshModulation {
  /** Multiplies the cue's catalogue gain. 0..1. */
  readonly gain: number
  /** Multiplies every layer's authored frequency, as `CueSpec.pitch` does. */
  readonly pitch: number
}

export const whooshModulation = (curves: EditionSpeedCurves, speed: number): WhooshModulation => ({
  gain: sampleCurve(curves.gateWhooshGain, speed),
  pitch: sampleCurve(curves.gateWhooshPitch, speed),
})

// ── DEV-137: pitch that tracks the AIR, and the rumble under it ───────────
//
// S4's engine curves are keyed on the throttle; these are keyed on FORWARD
// SPEED in m/s — the same quantity the wind curves read — and the two rates
// multiply in `engine.ts`. Named here, as DEV-027 asks, because a file with
// two "rate" curves whose x means two different things is the trap exactly.

/**
 * The speed-tracking playback rate for one forward speed. 1 is as authored.
 *
 * Flat outside the curve like every other, so a ship past the last knee holds
 * the last rate rather than climbing out of the audible range.
 */
export const speedRate = (tracking: EditionEnginePitchTracking, speed: number): number =>
  sampleCurve(tracking.rateBySpeed, speed)

/** The two numbers the rumble voice is driven by on one tick. */
export interface RumbleModulation {
  /** Gain as a multiple of the cue's catalogue gain. */
  readonly gain: number
  /** Low-pass cutoff on the whole voice, Hz. */
  readonly cutoffHz: number
}

/**
 * How loud and how open the rumble is, for a throttle demand and whether the
 * burner is lit.
 *
 * Throttle rather than speed for the GAIN, like the thruster it doubles: the
 * rumble is the engine's weight, and the engine answers the stick. The burner
 * is a step on both numbers, and opening the filter is most of what the step
 * sounds like — the octave-down sawtooths' harmonics were there all along, and
 * the cutoff decides how many of them are heard.
 */
export const rumbleModulation = (
  rumble: EditionEngineRumble,
  throttle: number,
  burning: boolean,
): RumbleModulation => ({
  gain: sampleCurve(rumble.gainByThrottle, throttle) * (burning ? rumble.boostGain : 1),
  cutoffHz: burning ? rumble.boostCutoffHz : rumble.cutoffHz,
})
