// src/boot/feel-events.ts: the stateful glue between game events and `feel`.
// DEV-636/637/642/643/797.
//
// `boot/app.ts` is being split and three builders share it, so the LOGIC for
// the events that need a little memory (a boost stage rising, a racer going
// by, the crash's one timeline) lives here and the app calls each with one
// line. Everything is per-instance state, never module scratch (trap 19), and
// nothing here reads a clock: the caller passes time.

import type { Feel } from '@/boot/feel'
import { JOLTS } from '@/game/cockpit-jolt'
import { boostStage } from '@/game/cockpit-shake'
import { createFlybyTracker, type Flyby } from '@/game/flyby'
import { TRAUMA } from '@/render/camera-shake'
import { type Quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'

// ── the boost: a hum while it burns, a shove when a stage is reached ───────

/** The boost hum's level at stage 0 and its step per stage (0.4, 0.6, 0.8, 1.0). */
const HUM_BASE = 0.4
const HUM_PER_STAGE = 0.2

export interface BoostFeel {
  /**
   * One fixed step. `boosting` is whether this tick's boost was PAID (the
   * tank's answer, `actions.boost`), so an empty tank stops the hum.
   */
  step(boosting: boolean, forwardSpeed: number): void
  /** Forget the stage and stop the hum: a respawn, a new run. */
  reset(): void
}

export const createBoostFeel = (feel: Feel): BoostFeel => {
  let stage = 0
  return {
    step(boosting, forwardSpeed) {
      const now = boostStage(forwardSpeed)
      // A rising stage is a small shove, but only while boosting: the chain can
      // lift the terminal without the player doing anything, and a shake with no
      // cause reads as a bug.
      if (boosting && now > stage) feel.shake(TRAUMA.boostStage)
      stage = now
      feel.boostHum(boosting ? Math.min(1, HUM_BASE + HUM_PER_STAGE * now) : 0)
    },
    reset() {
      stage = 0
      feel.boostHum(0)
    },
  }
}

// ── a racer whooshing past ────────────────────────────────────────────────

/** One other ship, in SIM space. */
export interface FlybyShip {
  readonly id: string | number
  readonly x: number
  readonly y: number
  readonly z: number
}

interface Placed {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface FlybyFeel {
  /**
   * One frame: `player` is where the player is (SIM space) and how it is turned,
   * `racers` the AI field and `room` a room's drawn remote ships (either may be
   * absent). Returns the strongest pass this frame (for DEV-641's whoosh to
   * read) or null; the shake and the tick are already done.
   */
  step(
    player: Placed,
    orientation: Quat,
    racers:
      | readonly {
          readonly spec: { readonly id: string }
          readonly jet: { readonly body: { readonly position: Placed } }
        }[]
      | null,
    room:
      | readonly { readonly slot: number; readonly drawn: boolean; readonly position: Placed }[]
      | null,
    dt: number,
  ): Flyby | null
  /** A teleport (crash reset, restart): forget every history. */
  reset(): void
}

export const createFlybyFeel = (feel: Feel): FlybyFeel => {
  const tracker = createFlybyTracker()
  const right: Vec3 = v3()
  const unitX: Vec3 = v3(1, 0, 0)
  const input = { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 }
  const best: Flyby = { distance: 0, speed: 0, trauma: 0, side: 0 }
  return {
    step(player, orientation, racers, room, dt) {
      rotateVec3(right, orientation, unitX)
      input.rx = right.x
      input.ry = right.y
      input.rz = right.z
      let found = false
      const one = (id: string | number, p: Placed): void => {
        input.dx = p.x - player.x
        input.dy = p.y - player.y
        input.dz = p.z - player.z
        const pass = tracker.step(id, input, dt)
        if (pass && (!found || pass.trauma > best.trauma)) {
          best.distance = pass.distance
          best.speed = pass.speed
          best.trauma = pass.trauma
          best.side = pass.side
          found = true
        }
      }
      if (racers) for (const r of racers) one(r.spec.id, r.jet.body.position)
      if (room) {
        for (const d of room) {
          if (d.drawn) one(`room:${d.slot}`, d.position)
          else tracker.forget(`room:${d.slot}`)
        }
      }
      if (!found) return null
      feel.shake(best.trauma)
      // A light tick: a pass is not a hit.
      feel.haptic('gate')
      return best
    },
    reset() {
      tracker.reset()
    },
  }
}

// ── a near miss: where the whoosh comes from (DEV-642) ─────────────────────

/** Metres from the head to the point the terrain whoosh is emitted from. */
export const NEAR_MISS_WHOOSH_METRES = 8

/**
 * The side a near miss was on, from `sim/surface-proximity.ts`'s probe index
 * (`PROBES`: 0 left, 1 right, 2 down, 3 lower left, 4 lower right, 5 forward
 * down): -1 left, +1 right, 0 for the probes that face down or ahead (and for
 * -1, the vertical winning).
 */
export const nearMissSide = (probe: number): -1 | 0 | 1 =>
  probe === 0 || probe === 3 ? -1 : probe === 1 || probe === 4 ? 1 : 0

/**
 * The world point (three space, which is WebAudio's) the whoosh is emitted
 * from: `NEAR_MISS_WHOOSH_METRES` toward the terrain that was nearly hit. To
 * the side for a wall in a bank, straight below for the ground. `right` is the
 * player's right-hand unit vector in the same space.
 */
export const nearMissAt = (
  out: [number, number, number],
  head: Placed,
  right: Placed,
  probe: number,
): [number, number, number] => {
  const side = nearMissSide(probe)
  const d = NEAR_MISS_WHOOSH_METRES
  // The lower probes are 45 degrees down as well as to the side.
  const down = side === 0 ? d : probe === 3 || probe === 4 ? d * Math.SQRT1_2 : 0
  const lateral = side === 0 ? 0 : probe === 3 || probe === 4 ? d * Math.SQRT1_2 : d
  out[0] = head.x + right.x * side * lateral
  out[1] = head.y + right.y * side * lateral - down
  out[2] = head.z + right.z * side * lateral
  return out
}

// ── the crash: ONE timeline (DEV-643 and DEV-797) ──────────────────────────
//
// hold, splash, curtain. On the tick the crash begins the frame on screen is
// HELD for `CRASH_HOLD_MS` (hit-stop: a render hold, the sim keeps stepping and
// is untouched), then the world draws live again for the rest of
// `CRASH_CURTAIN_DELAY_SECONDS` so the player sees their own wreck and its
// splash (DEV-613), and only then does the curtain come down. The delay is on
// the SIM's hold clock (`crash.heldFor`), so it is the same however fast the
// frames come; the sim's own `holdSeconds` (0.55) is unchanged, which leaves the
// black beat short (the reset lands a moment after the screen is solid) and
// every AI racer's crash exactly as it was.

/** The hit-stop, ms. Matt's brief: 80 to 120. Flat only: a held frame under a moving head is nausea. */
export const CRASH_HOLD_MS = 100
/** Seconds of the sim's hold the player watches before the curtain starts. DEV-797: "about 0.4 s". */
export const CRASH_CURTAIN_DELAY_SECONDS = 0.4

export interface CrashFeel {
  /** The crash tick: the shake, the jolt, the rumble and the hold. */
  begin(nowMs: number, presenting: boolean): void
  /** Is the last frame being held at `nowMs`? Never in a session. */
  holdsFrame(nowMs: number, presenting: boolean): boolean
  /** Has the player watched long enough (the sim's `heldFor`, seconds)? */
  curtainDue(heldFor: number): boolean
  /** A reset, a restart, a mission swap: drop the hold. */
  clear(): void
}

export const createCrashFeel = (feel: Feel): CrashFeel => {
  let holdUntil = Number.NEGATIVE_INFINITY
  return {
    begin(nowMs, presenting) {
      feel.shake(TRAUMA.crash)
      feel.jolt(JOLTS.crash)
      feel.haptic('crash')
      holdUntil = presenting ? Number.NEGATIVE_INFINITY : nowMs + CRASH_HOLD_MS
    },
    holdsFrame(nowMs, presenting) {
      return !presenting && nowMs < holdUntil
    },
    curtainDue(heldFor) {
      return heldFor >= CRASH_CURTAIN_DELAY_SECONDS
    },
    clear() {
      holdUntil = Number.NEGATIVE_INFINITY
    },
  }
}
