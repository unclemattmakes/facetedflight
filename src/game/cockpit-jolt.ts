// src/game/cockpit-jolt.ts: a blow to the cockpit MESH, from any event. DEV-642/643.
//
// `game/racer-hit.ts` already jolts the cockpit for a racer's hit: the cockpit
// buffet's own waveform, harder for a moment, worn by the art pivot and nothing
// else (the Squadrons rule, DEV-083). This is the same device for the other
// things that hit you: a crash, a prop strike, a near miss, the GO shove. It is
// the half of the feel that is legal in a HEADSET: the mesh may vibrate around a
// still head, where the camera may not (ART_DIRECTION pillar 3).
//
// It rides `cockpit.shake`, so it follows that preset flag (Anniversary look
// only: Classic's cockpit is still) and the Speed FX slider linearly, exactly
// as the racer hit does, and it is not scaled by speed: a blow at 30 m/s is felt
// as surely as one at 300. The gain is in MULTIPLES of the preset's
// amplitude and angle, like `hitJoltGain`, so one tuning of the buffet moves
// both.
//
// Pure, three-free, DOM-free, no clock: the time is an argument.

/** A jolt in flight. One per flight, owned by the caller (trap 19: never module scratch). */
export interface CockpitJolt {
  /** Render seconds the jolt began. */
  at: number
  /** Multiples of `cockpit.shake`'s amplitude at the instant of the blow. */
  gain: number
  /** Seconds it takes to die away. */
  seconds: number
}

export const createCockpitJolt = (): CockpitJolt => ({
  at: Number.NEGATIVE_INFINITY,
  gain: 0,
  seconds: 0,
})

/** The named blows. Multiples of the preset's buffet amplitude, and how long they last. */
export const JOLTS = {
  /** A terrain crash. 14x the 5 mm amplitude is 7 cm and about 2.9 degrees at the instant of impact. */
  crash: { gain: 14, seconds: 0.7 },
  /** A prop broken through. */
  propStrike: { gain: 7, seconds: 0.45 },
  /** CLOSE: a near miss with terrain. */
  nearMiss: { gain: 2.5, seconds: 0.3 },
  /** GO: the shove as the ship is released. */
  go: { gain: 2, seconds: 0.3 },
} as const

/**
 * Start a jolt at `time`. A weaker blow does not cut a stronger one still
 * running short: whichever has more left to give wins.
 */
export const startJolt = (jolt: CockpitJolt, gain: number, seconds: number, time: number): void => {
  if (!(gain > 0) || !(seconds > 0)) return
  if (cockpitJoltGain(jolt, time) >= gain) return
  jolt.at = time
  jolt.gain = gain
  jolt.seconds = seconds
}

/**
 * The gain at `time`: `gain` at the blow, falling on a square to nothing at
 * `seconds` (fast, then trailing, no step at the end: `hitJoltGain`'s shape).
 */
export const cockpitJoltGain = (jolt: CockpitJolt, time: number): number => {
  const age = time - jolt.at
  if (!(age >= 0) || !(jolt.seconds > 0) || age >= jolt.seconds) return 0
  const left = 1 - age / jolt.seconds
  return jolt.gain * left * left
}
