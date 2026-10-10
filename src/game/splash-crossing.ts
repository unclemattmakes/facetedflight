// src/game/splash-crossing.ts: when a jet goes into the sea, and when it comes
// back out. DEV-613.
//
// Matt, 2026-10-03: *"can you spawn a "splash" particle fx when anything goes
// in or out of the water? i'm thinking i'd see it the most w/ dolphins land in
// the water, and if jets crash into the water"*. The dolphins say when they
// cross for themselves (`render/life-leapers.ts`: a leap has two ends). A jet
// does not, and this is the rule that reads it off what the sim already says.
//
// ── In: the hull met the sea ──────────────────────────────────────────────
//
// The ocean is a collision surface of its own (2016 gave it a TerrainCollider,
// `game/flight.ts`), so a jet going into the water is a CONTACT that began,
// `TerrainCollisionState.struck`. Which surface it met is not recorded, and
// does not need to be: where the sea stands over the land (`seaUnder`'s depth
// above zero) the sea is the top surface, so a contact there is the sea. A
// crash into the water (DEV-126) is the same contact at a speed over the crash
// rule's threshold, and its splash is bigger because the speed is.
//
// ── Out: it rose back over the water ─────────────────────────────────────
//
// A jet skimming the sea touches and leaves the plate every few ticks: the
// contact removes the speed into it and nothing pulls it down again. So OUT is
// not the contact ending. It is the hull rising `exitMetres` over the height it
// went in at, one band for a skim and a clean exit for a bounce. A crash does
// not come out at all: the rule holds the ship where it hit and then PUTS it on
// the course, and a body that moved further in a tick than its own speed could
// take it was put somewhere, so it is dry, and nothing splashes.
//
// SIM space throughout, like the body. No three, no clock: the state counts
// the fixed steps it is handed, so a craft stepped before the mission's clock
// runs (the traffic during the ride) is rate-limited all the same.

import type { EditionSplash } from '@/content/edition-schema'

/** One jet's state, kept per craft by the caller. */
export interface CraftSplashState {
  /** In the water: it went in and has not risen back out. */
  wet: boolean
  /** Its height over the visible sea when it went in, metres. */
  wetHeight: number
  /** Seconds since it last threw a splash, counted in the steps it was given. */
  since: number
  /** Where the body was last tick, for the teleport test. */
  x: number
  y: number
  z: number
  /** False until a first tick has recorded `x, y, z`. */
  seen: boolean
}

export const createCraftSplash = (): CraftSplashState => ({
  wet: false,
  wetHeight: 0,
  since: Number.POSITIVE_INFINITY,
  x: 0,
  y: 0,
  z: 0,
  seen: false,
})

/** What one tick of a jet says, SIM space. */
export interface CraftSplashInput {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
  /** A terrain contact BEGAN this tick (`TerrainCollisionState.struck`). */
  readonly struck: boolean
  /**
   * The body's height over the VISIBLE sea here (the ocean's field plus this
   * frame's bob), metres, or null where there is no sea over the land.
   */
  readonly height: number | null
  /** The fixed step, seconds. */
  readonly dt: number
}

export type CraftSplashEvent = 'in' | 'out' | null

/**
 * Metres a body may move in a tick beyond twice what its own speed covers
 * before the move is read as a teleport (a crash reset, a respawn, a restart).
 * Generous both ways: a contact's depenetration moves a body centimetres, and
 * a reset moves it tens of metres at least.
 */
export const TELEPORT_SLACK_METRES = 10

/**
 * One tick of the rule. Mutates `state`; returns `in`, `out` or null. A splash
 * is at most one per `minSeconds` per craft, whichever way.
 */
export const stepCraftSplash = (
  state: CraftSplashState,
  input: CraftSplashInput,
  spec: Pick<EditionSplash, 'exitMetres' | 'minSeconds'>,
): CraftSplashEvent => {
  const p = input.position
  const v = input.velocity
  const moved = Math.hypot(p.x - state.x, p.y - state.y, p.z - state.z)
  const reach = Math.hypot(v.x, v.y, v.z) * input.dt * 2 + TELEPORT_SLACK_METRES
  const teleported = state.seen && moved > reach
  state.x = p.x
  state.y = p.y
  state.z = p.z
  state.seen = true
  state.since += input.dt
  if (teleported || input.height === null) {
    // Put somewhere, or over land: dry, and nothing to throw.
    state.wet = false
    return null
  }
  const due = state.since >= spec.minSeconds
  if (!state.wet) {
    if (!input.struck) return null
    state.wet = true
    state.wetHeight = input.height
    if (!due) return null
    state.since = 0
    return 'in'
  }
  if (input.height > state.wetHeight + spec.exitMetres) {
    state.wet = false
    if (!due) return null
    state.since = 0
    return 'out'
  }
  return null
}
