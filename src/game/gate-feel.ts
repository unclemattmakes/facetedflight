// src/game/gate-feel.ts: the gate as the hero, and what a loss sounds like.
// DEV-638 (the pitch ladder, the clean flag), DEV-639 (the losses).
//
// CONSULTANT-REVIEW-2026-10-05 items B and C. The sim already decides whether a
// gate was CLEAN (`sim/gate-quality.ts`'s `recordGate`, read through
// `MissionEvent.gateClean`), and it owns the best-streak the results panel
// reports. This module reads that answer and keeps ONE extra thing the sim has no
// reason to hold: a LADDER, the count of consecutive clean gates as the PLAYER
// would count them, which also falls when the speed chain expires (5.5 s without
// a gate), because a rhythm that stopped is a rhythm that ended. The ladder is
// presentation. It changes no score and no result (hard rule 4); the sim's own
// `cleanStreak` and `bestCleanStreak` are untouched.
//
// PURE: no three, no DOM, no clock, no randomness. State is per ladder, never
// module scratch (trap 19): `tests/unit/gate-feel.test.ts` steps a second one and
// asserts the first did not move.

/**
 * What a gate feels like, in one table so the numbers read as a set. FF2's own
 * (2016 has no feel layer), and every one is a presentation number.
 */
export const GATE_FEEL = {
  /** Flat FOV kick on EVERY gate, degrees: the +18 m/s read as a shove. DEV-638 (d). */
  fovKickDegrees: 2,
  /** ...and how long it takes to fall back, seconds. */
  fovKickSeconds: 0.15,
  /** A clean gate's pulse peak, as a multiple of a plain gate's. DEV-638 (c). */
  cleanPulseScale: 1.6,
  /** A clean gate's sparkle layer: the burst's emitter scale and its spawn-speed drive. */
  sparkleScale: 0.5,
  sparkleSpeed: 1.7,
  /** DEV-639: the grey flash of a gate taken in time but not clean: the same layer, smaller. */
  missScale: 0.35,
} as const

/**
 * The chain the player counts, and what it last lost. DEV-845 (Matt, 2026-10-08:
 * "getting through a gate within the time-limit should keep the chain, clean or
 * not").
 *
 * `streak` is the CHAIN: every gate taken in time extends it, centred or not,
 * and only the chain running out (5.5 s without a gate, `ladderChainExpired`)
 * ends it. It is what the pitch ladder climbs. `run` is the separate count of
 * CONSECUTIVE CLEAN gates, which is what the "CLEAN x3" banner reads and what the
 * sim's own `cleanStreak` (the clean-gate bonus) mirrors; an off-centre gate
 * resets it but not the chain. `lost` is the chain the LAST event destroyed
 * (0 when it destroyed nothing), for the loss cue to size itself.
 */
export interface GateLadder {
  streak: number
  run: number
  lost: number
}

export const createGateLadder = (): GateLadder => ({ streak: 0, run: 0, lost: 0 })

/** Back to nothing: a restart, a mission swap. */
export const resetGateLadder = (ladder: GateLadder): void => {
  ladder.streak = 0
  ladder.run = 0
  ladder.lost = 0
}

/**
 * Record one gate taken in time. The chain always extends. `clean` is the SIM's
 * verdict and only moves the clean run: a clean gate climbs it, one that is not
 * clean drops it to the floor, and neither costs the chain anything.
 */
export const ladderGate = (ladder: GateLadder, clean: boolean): void => {
  ladder.streak += 1
  ladder.run = clean ? ladder.run + 1 : 0
  ladder.lost = 0
}

/** The speed chain fell back to nothing: the rhythm ended. Returns what it cost. */
export const ladderChainExpired = (ladder: GateLadder): number => {
  ladder.lost = ladder.streak
  ladder.streak = 0
  ladder.run = 0
  return ladder.lost
}

/**
 * Watches the speed chain for the edge that is NOT a gate: stacks above zero
 * last step and zero now. A gate raises the stacks, so a step that scored cannot
 * look like an expiry; a crash reset that cleared the chain is the caller's to
 * mask (`ignore`).
 */
export interface ChainWatch {
  /** Feed the chain's `stacks` after the step. True on the one step it fell to nothing. */
  step(stacks: number, ignore?: boolean): boolean
  reset(): void
}

export const createChainWatch = (): ChainWatch => {
  let last = 0
  return {
    step(stacks, ignore = false) {
      const expired = !ignore && last > 0 && stacks === 0
      last = stacks
      return expired
    },
    reset() {
      last = 0
    },
  }
}
