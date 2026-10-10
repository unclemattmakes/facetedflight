// src/game/briefing-copy.ts: what the briefing plate says, on Anniversary. DEV-631.
//
// Matt, 2026-10-04, playing 0.20.0: *"the briefing panel (ends with DONT
// CRASH!!) could be more helpful to players: instead of the dev name, show the
// location name + course difficulty icon; change the copy to something more
// helpful like "Rings give boost and increase top speed. Don't Crash!!"; for
// jumpseat "Target pads refuel your craft. See how far you can get""*.
//
// 2016's plate said one sentence for every mission, off the HoverJet prefab
// (`level.ui.briefing`), and the JumpSeat courses carry the same ring sentence
// though they have no rings to fly through. The Classic look keeps it (D35: a
// look is the in-mission visuals, and 2016's words are part of them).
//
// ── Each claim was checked against the rules before it shipped ─────────────
//
//   RINGS GIVE BOOST       `app.ts` pays the boost tank `gameplay.energy.ringRefill`
//                          (Anniversary 0.5 of a tank) on every scored ring, HoverJet
//                          only, when `gameplay.energy.enabled`. Under `?rules=classic`
//                          a ring pays nothing (boost is free there), so the words
//                          drop that clause: `ringsPayBoost` below.
//   INCREASE TOP SPEED     `chainGate` (`sim/speed-chain.ts`) on every scored ring, in
//                          every rule set: +18 to `maxSpeed` a ring, falling back after
//                          5.5 s without one. True, and temporary.
//   PADS REFUEL            every live `target_jumppad` carries a `trigger_refuel`
//                          sphere (10 units/s) that `game/jumpseat-flight.ts` steps,
//                          in every rule set. True while you are on or over one.
//   RINGS REFILL THE TANK  the energy race (DEV-144): `payGate` on every scored ring,
//   (energy race)          and an empty tank turns the engines off.
//   ORBS, NO CLOCK         Free Flight (`game/modes.ts`): orbs score, `clock: false`,
//   (Free Flight)          and a medal is awarded in the air on the orb count.
//
// A pair this table does not know says 2016's own sentence (the level's).
//
// PURE: no three, no DOM.

import type { GameMode, VehicleId } from '@/content/level-schema'
import { BRIEFING_WORDS, type BriefingWords } from './modes'

/** The rule facts the words depend on. */
export interface BriefingRules {
  /** A ring the player takes pays the boost tank (`gameplay.energy`, enabled, `ringRefill > 0`). */
  readonly ringsPayBoost: boolean
}

/**
 * The plate's body for a vehicle in a mode, or null where this table has no
 * words for the pair (the caller then says the level's 2016 sentence).
 */
export const briefingCopy = (
  vehicle: VehicleId | string,
  mode: GameMode | string,
  rules: BriefingRules,
): string | null => {
  // The words live on the mode table (`game/modes.ts`), the one file that may
  // spell a mode's name.
  const words = (BRIEFING_WORDS as Readonly<Record<string, Record<string, BriefingWords>>>)[mode]?.[
    vehicle
  ]
  if (!words) return null
  return !rules.ringsPayBoost && words.withoutRingBoost ? words.withoutRingBoost : words.text
}
