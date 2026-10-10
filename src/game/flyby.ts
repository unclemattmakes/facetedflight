// src/game/flyby.ts: detects a ship WHOOSHING PAST the player. DEV-636.
//
// Matt, 2026-10-05, twice and underlined: camera shake when ships whoosh by.
// This is the detector; what a pass DOES is the caller's. The shake and the
// haptic tick are wired in `boot/app.ts`, and DEV-641's panned whoosh reads the
// same event (`side`), so the cue, the rattle and the tick are one moment.
//
// ── Why it is built on RELATIVE POSITION alone ───────────────────────────
//
// The AI racers have bodies with velocities; a room's remote ships have only a
// drawn position (`RoomDrawnRacer`). Everything here is derived from where the
// other ship is relative to the player, frame to frame: the distance, the rate
// the distance is closing, and the relative speed from the change in relative
// position. So one detector serves the AI, the room, the ghosts and the
// ambient traffic without asking any of them for a velocity.
//
// A PASS is the closest approach: the distance was falling and now is not.
// It fires once, at the minimum, with the distance and the relative speed at
// that moment, and the trauma is `render/camera-shake.ts`'s `flybyTrauma`: so a
// pass at 10 m rattles and one at 60 m does not.
//
// Pure, three-free, DOM-free, no clock (`dt` is an argument). State is per id in
// the tracker that owns it, never module scratch (trap 19): a second tracker
// stepped after the first cannot move the first's numbers.

import { flybyTrauma } from '@/render/camera-shake'

/** A pass, at the instant of closest approach. */
export interface Flyby {
  /** Metres between the two ships at the minimum. */
  distance: number
  /** M/S, the relative speed of the two ships as they crossed. */
  speed: number
  /** The `flybyTrauma` this pass is worth. */
  trauma: number
  /**
   * Which side of the player it went by: -1 left, +1 right, 0 dead ahead or
   * behind (inside a degree of the line). Of the player's own right vector, in
   * whatever space the positions were given in.
   */
  side: -1 | 0 | 1
}

/** One other ship, relative to the player, in one consistent space (sim space in the app). */
export interface FlybyInput {
  /** The other ship's position MINUS the player's. */
  dx: number
  dy: number
  dz: number
  /** The player's right-hand unit vector, same space. */
  rx: number
  ry: number
  rz: number
}

export interface FlybyTracker {
  /**
   * Feed one ship for one frame of `dt` seconds. Returns the pass this frame
   * completed, or null. A new `id` has no history and cannot pass this frame.
   * The returned object is OWNED by the tracker and valid until its next call.
   */
  step(id: string | number, input: FlybyInput, dt: number): Flyby | null
  /** Forget every history: a teleport (crash reset, respawn, a new run) would read as a pass. */
  reset(): void
  /** Forget one ship (it left the room, it was disposed). */
  forget(id: string | number): void
}

/** Closing speed above which a ship is "approaching", m/s. Below it a pair flying in formation is not passing. */
export const APPROACH_MIN_CLOSING = 4
/** The least relative speed a pass is worth reporting at, m/s. */
export const PASS_MIN_SPEED = 8

interface History {
  x: number
  y: number
  z: number
  d: number
  closing: number
  /** True after the second sample: `closing` is meaningful. */
  primed: boolean
}

export const createFlybyTracker = (): FlybyTracker => {
  const history = new Map<string | number, History>()
  const out: Flyby = { distance: 0, speed: 0, trauma: 0, side: 0 }
  return {
    step(id, input, dt) {
      const d = Math.hypot(input.dx, input.dy, input.dz)
      let h = history.get(id)
      if (!h || !(dt > 0)) {
        if (!h) {
          h = { x: input.dx, y: input.dy, z: input.dz, d, closing: 0, primed: false }
          history.set(id, h)
        }
        return null
      }
      const closing = (h.d - d) / dt
      const speed = Math.hypot(input.dx - h.x, input.dy - h.y, input.dz - h.z) / dt
      let result: Flyby | null = null
      if (h.primed && h.closing > APPROACH_MIN_CLOSING && closing <= 0) {
        const s = Math.max(speed, h.closing)
        const trauma = s >= PASS_MIN_SPEED ? flybyTrauma(s, d) : 0
        if (trauma > 0) {
          const lateral = input.dx * input.rx + input.dy * input.ry + input.dz * input.rz
          // Inside a degree of the line, sin(1 degree) of the distance.
          const centred = Math.abs(lateral) < d * 0.0175
          out.distance = d
          out.speed = s
          out.trauma = trauma
          out.side = centred ? 0 : lateral > 0 ? 1 : -1
          result = out
        }
      }
      h.x = input.dx
      h.y = input.dy
      h.z = input.dz
      h.d = d
      h.closing = closing
      h.primed = true
      return result
    },
    reset() {
      history.clear()
    },
    forget(id) {
      history.delete(id)
    },
  }
}
