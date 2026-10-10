// src/game/next-target.ts — what the next-gate arrow points at. DEV-124.
//
// One answer per mode, in SIM space, or null when there is nothing to point
// at — and null is a real answer, not a fallback: an arrow that always points
// somewhere is an arrow the eye learns to ignore (DEV-044's lesson, from the
// other side).
//
//   Ring Attack       the next unpassed ring, in course order — the same
//                     `nextGate` the autopilot and the racers fly to, so the
//                     arrow and the AI cannot disagree about where the course
//                     goes. After the last ring, the FINISH gate (DEV-045),
//                     until it is crossed.
//   Target Practice   the NEAREST pad that is still open. Pads are taken in
//                     any order and 2016 never ranked them, so "next" is a
//                     distance. Once every pad is closed, the finish pad's
//                     airspace, which is where the run ends.
//   Free Flight       nothing. Orbs are collected in any order across the
//                     whole island; pointing at the nearest one would turn a
//                     free flight into a fetch quest.
//
// And it says nothing at all until the RACE HAS STARTED. Matt, from a VR
// playthrough: *"only enable the 'next gate' arrow when the race has started"*
// (DEV-159). On the pad and through the 3-2-1 the arrow pointed at gate 1 the
// whole time, which is noise before it is information — you cannot fly at it
// yet, and the one thing you should be looking at is the briefing and the
// count. The caller hands in the answer rather than this file inventing a
// second one: `!launchHoldsShip(launch)` is the game's ONE definition of "the
// run is under way", already the gate on the cockpit shake and the speed lens,
// and it is true from the first frame on a mission with no elevator rig.
//
// Pure: a `MissionState` in, a point out. No three, no DOM, no preset — the
// renderer decides whether to DRAW the answer.

import { nextGate } from '@/sim/autopilot'
import { distanceSq, type Vec3 } from '@/sim/math/vec3'
import type { MissionState } from './mission'
import { scores } from './modes'

/**
 * The point the arrow should point at, SIM space, or null.
 *
 * `from` is the ship's position, used only to pick the nearest open pad.
 *
 * `started` is whether the run is under way — `!launchHoldsShip(launch)` at the
 * call site. **Required, with no default**, for `sim/launch.ts`'s reason: a
 * default is how a stale call site stays quiet, and making it required turns
 * the compiler into the thing that finds the next one (DEV-159).
 *
 * Branches on what the running mode SCORES, never on its name: `modes.ts` is
 * the one file allowed to spell a mode, and a fourth mode that scores rings
 * gets an arrow without this file hearing about it.
 */
export const nextTargetSim = (mission: MissionState, from: Vec3, started: boolean): Vec3 | null => {
  if (!started) return null
  if (mission.finished) return null
  if (scores(mission.mode, 'ring')) {
    const i = nextGate(mission.course.gates, mission.course.passed)
    if (i >= 0) {
      const gate = mission.course.gates[i]
      return gate ? gate.centre : null
    }
    if (mission.finishGate && !mission.finishCrossed) {
      const f = mission.finishGate
      return { x: f.x, y: f.y, z: f.z }
    }
    return null
  }
  if (scores(mission.mode, 'padZone')) {
    const targets = mission.targets
    // One point per pad: its highest-scoring plate, which is the bullseye
    // and sits at the pad's centre. A pad with every plate taken is closed.
    let best: Vec3 | null = null
    let bestDistanceSq = Number.POSITIVE_INFINITY
    const seen = new Set<number>()
    for (const zone of targets.zones) {
      if (seen.has(zone.pad)) continue
      if (targets.padClosed[zone.pad]) continue
      const centre = padCentre(targets.zones, zone.pad)
      if (!centre) continue
      seen.add(zone.pad)
      const d = distanceSq(centre, from)
      if (d < bestDistanceSq) {
        bestDistanceSq = d
        best = centre
      }
    }
    if (best) return best
    const airspace = mission.finishAirspace
    return airspace && !mission.finishCrossed ? airspace.centre : null
  }
  // Orbs, or nothing scored at all: no target. See the header.
  return null
}

/** The centre of pad `pad`'s highest-scoring plate, or null if it has none. */
const padCentre = (zones: MissionState['targets']['zones'], pad: number): Vec3 | null => {
  let best: (typeof zones)[number] | null = null
  for (const zone of zones) {
    if (zone.pad !== pad) continue
    if (!best || zone.points > best.points) best = zone
  }
  return best ? best.centre : null
}

/**
 * How steep the nose must be before the arrow stops aiming at the target in
 * three dimensions and aims at it along the horizon (DEV-892).
 *
 * Lesson 1's playtest: a one-second hold of the climb control puts the nose
 * straight up, the target is back down on the horizon, and the arrow, which is
 * the true bearing in the ship's own frame, pointed at the dash's sky end: a
 * correct arrow nobody could read as "turn". Past this the arrow answers the
 * question a lost player is asking, which way round is it, and the vertical
 * half of the bearing is the nose's job (the lesson's "level out" line).
 */
export const STEEP_NOSE_DEGREES = 60

/**
 * `target` as the arrow should aim at it: unchanged while the nose is within
 * {@link STEEP_NOSE_DEGREES} of the horizon, otherwise at the ship's own
 * height, so the bearing is the horizontal one. `pitchDeg` is signed (nose up
 * positive); a dive counts the same as a climb. A new point, never a mutation.
 */
export const arrowTargetForPitch = (target: Vec3, from: Vec3, pitchDeg: number): Vec3 =>
  Math.abs(pitchDeg) > STEEP_NOSE_DEGREES ? { x: target.x, y: from.y, z: target.z } : target
