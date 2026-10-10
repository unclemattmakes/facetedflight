// src/game/racer-hit.ts — what the player HEARS and FEELS when a racer hits it.
// The DEV-364 follow-up.
//
// Matt, 2026-09-25: *"sound and physics cost - nudge the players as if they got
// hit"*. The physics is the sim's (`sim/craft-hit.ts`, deterministic, in the
// fixed step). This file is the other two costs, and they are the RENDER
// side's because they read a render clock and a speaker:
//
//   · the sound — `ship.hit`, 2016's mission-bank `hit` group, which 2016
//     configured and never called (`audio/cues.ts`);
//   · the jolt — `cockpit.shake`'s own waveform, harder for a moment
//     (`game/cockpit-shake.ts`'s `jolt`). The Squadrons rule holds: the
//     cockpit moves around a still head, the camera never does, and the speed
//     effects slider scales it with the buffet it rides on.
//
// Both are taken off the sim's report AFTER each fixed step, so a hit on any
// tick of a frame is heard once and felt from that frame. Nothing here writes
// the body; nothing here decides whether a hit happened.
//
// Pure, three-free and DOM-free, like `cockpit-shake.ts`: a test can hand it a
// report and a time and read back what the game would do.

import type { AudioEvent } from '@/audio/events'
import type { EditionRacerHit } from '@/content/edition-schema'
import type { CraftHitReport } from '@/sim/craft-hit'

/** The jolt in flight: when the last hit landed (render seconds) and how hard. */
export interface HitJolt {
  at: number
  strength: number
}

/** No hit yet: a jolt that died away before the game began. */
export const createHitJolt = (): HitJolt => ({ at: Number.NEGATIVE_INFINITY, strength: 0 })

/**
 * The event to play for the hit the last fixed step reported, and the jolt
 * restarted at `time` — or null, and nothing touched, when there was none.
 * The caller hands the event to `audio.event` exactly as it does every other.
 */
export const takeRacerHit = (
  hit: CraftHitReport,
  jolt: HitJolt,
  time: number,
): AudioEvent | null => {
  if (!hit.struck) return null
  jolt.at = time
  jolt.strength = hit.strength
  return { type: 'ship.hit' }
}

/**
 * The jolt's gain at `time`, in multiples of `cockpit.shake`'s amplitude and
 * angle: `shakeGain x strength` at the hit, falling on a square to nothing at
 * `shakeSeconds` — the square so it leaves as it would from a blow, fast and
 * then trailing, with no step at the end. 0 with the feature off.
 */
export const hitJoltGain = (spec: EditionRacerHit, jolt: HitJolt, time: number): number => {
  if (!spec.enabled || !(spec.shakeSeconds > 0)) return 0
  const age = time - jolt.at
  if (!(age >= 0) || age >= spec.shakeSeconds) return 0
  const left = 1 - age / spec.shakeSeconds
  return spec.shakeGain * jolt.strength * left * left
}
