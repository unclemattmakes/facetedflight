// src/game/ring-takes.ts: who took which ring, for the burst. DEV-868.
//
// Matt, 2026-10-08: "in FFTV and game, i'd love to see the ring particle fx get
// triggered from other players." The player's pass already fires the gate's
// one-shot (`frame.ts`, beside `liveRings.pass`); a rival's did not, because
// nothing watched a rival's course. This is that watch, and it is PURE: it
// reads what the sim and the room already hold and answers with gate indices.
//
// Two sources, one answer:
//
//  · An AI racer (single player, a room's bots, FF-TV's exhibition) carries
//    its own `CourseState.passed[]`. The watch diffs it against what it saw
//    last frame: a gate that went false -> true is a take.
//  · A room player has no course here, only a drawn position. The watch keeps a
//    `CourseState` of its own for them and steps the SIM's `stepCourse` over
//    the position, so "taken" is the same OUT-to-IN edge of the same trigger
//    sphere as for everyone else (DEV-149), never a second containment test.
//
// What it does NOT do: hide the gate. Only the player's pass hides a ring, and
// that is DEV-869's rule on FF-TV and 2016's "npc" branch alike (DEV-122).
//
// ── Bounded ──────────────────────────────────────────────────────────────
//
// The emitters are pooled by construction: `particle-fx.ts` owns ONE one-shot
// emitter per gate per system, so a burst can never allocate and a second take
// of the same gate restarts the first. What is left to bound is how many
// DIFFERENT gates burst at once, which a 12-racer pack through a tight cluster
// could push high: {@link MAX_BURSTS_PER_FRAME} per call and
// {@link MAX_BURSTS_LIVE} inside {@link BURST_LIFE_SECONDS}, the excess dropped
// (a dropped burst is a gate that did not sparkle, nothing else).

import { type CourseState, createCourse, type Gate, seedCourse, stepCourse } from '@/sim/course'
import type { Vec3 } from '@/sim/math/vec3'

/** One call may start this many bursts. */
export const MAX_BURSTS_PER_FRAME = 4
/** Bursts started inside {@link BURST_LIFE_SECONDS} may not exceed this. */
export const MAX_BURSTS_LIVE = 8
/** How long a burst is counted as live: the one-shot's 0.25 s, with margin. */
export const BURST_LIFE_SECONDS = 0.5
/** A jump of more than this many gates in one frame is a seed or a reset, not a take. */
const SEED_JUMP = 3
/** A drawn position that moves farther than this in one frame was TELEPORTED (metres). */
const TELEPORT_METRES = 400

export interface RingTakeWatch {
  /**
   * An AI racer's course this frame. Returns nothing: takes are appended to
   * {@link RingTakeWatch.takes}. A first sight, a reset (fewer gates passed
   * than before) and a seed (a run of new passes at once) resync silently.
   */
  watchPassed(id: string, passed: readonly boolean[]): void
  /** A drawn ship's SIM position this frame, for the players the room draws without a course. */
  watchPosition(id: string, position: Vec3): void
  /** The ship is not drawn this frame: forget it, so the next sight re-seeds. */
  forget(id: string): void
  /**
   * The gates to burst this frame, within the caps, and the list is cleared by
   * the NEXT {@link RingTakeWatch.begin}. `now` is any monotone clock, seconds.
   */
  readonly takes: readonly number[]
  /** Start a frame: clear `takes`, and expire old bursts at `now`. */
  begin(now: number): void
  /** Forget everyone: a new world or a restart. */
  reset(): void
}

export const createRingTakeWatch = (gates: readonly Gate[]): RingTakeWatch => {
  const seen = new Map<string, boolean[]>()
  const bodies = new Map<string, { course: CourseState; at: Vec3 }>()
  const takes: number[] = []
  const live: number[] = []
  let clock = 0

  const accept = (gate: number) => {
    if (takes.length >= MAX_BURSTS_PER_FRAME) return
    if (live.length >= MAX_BURSTS_LIVE) return
    takes.push(gate)
    live.push(clock)
  }

  return {
    takes,
    begin(now) {
      clock = now
      takes.length = 0
      while (live.length > 0 && now - (live[0] as number) > BURST_LIFE_SECONDS) live.shift()
    },
    watchPassed(id, passed) {
      const before = seen.get(id)
      if (!before) {
        seen.set(id, passed.slice())
        return
      }
      let fresh = 0
      for (let i = 0; i < passed.length; i++) if (passed[i] && !before[i]) fresh++
      if (fresh <= SEED_JUMP) {
        for (let i = 0; i < passed.length; i++) if (passed[i] && !before[i]) accept(i)
      }
      before.length = passed.length
      for (let i = 0; i < passed.length; i++) before[i] = passed[i] === true
    },
    watchPosition(id, position) {
      const body = bodies.get(id)
      if (!body) {
        const course = createCourse(gates)
        seedCourse(course, position)
        bodies.set(id, { course, at: { x: position.x, y: position.y, z: position.z } })
        return
      }
      const dx = position.x - body.at.x
      const dy = position.y - body.at.y
      const dz = position.z - body.at.z
      body.at.x = position.x
      body.at.y = position.y
      body.at.z = position.z
      if (dx * dx + dy * dy + dz * dz > TELEPORT_METRES * TELEPORT_METRES) {
        seedCourse(body.course, position)
        return
      }
      const gate = stepCourse(body.course, position)
      if (gate >= 0) accept(gate)
    },
    forget(id) {
      seen.delete(id)
      bodies.delete(id)
    },
    reset() {
      seen.clear()
      bodies.clear()
      takes.length = 0
      live.length = 0
    },
  }
}
