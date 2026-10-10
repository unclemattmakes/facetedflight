// src/sim/course.ts — did the ship go through the ring?
//
// SIM LAYER: no three, no DOM, no clock, no randomness. Ring detection has to
// be deterministic for the same reason the flight model does — a replayed
// ghost must score exactly what the live run scored, or a personal best is not
// a personal best.
//
// ── A sphere, not a torus ─────────────────────────────────────────────────
//
// The 2016 gate is a `SphereCollider` on a trigger, and it is BIG: 22.6 m on
// the first ring of `int_01`, against a ring mesh 15 m across. So "through the
// ring" in Faceted Flight means "within 22 m of the gate's centre", and a tight
// geometric through-the-hole test would reject runs the original accepted. The
// radii are extracted per ring; nothing here invents one.
//
// ── Tunnelling ────────────────────────────────────────────────────────────
//
// The HoverJet's top speed is 437.5 m/s and the sim step is 0.0122 s, so it
// covers **5.3 m** per step. A 22 m sphere is comfortably larger than that, so
// a point test cannot miss — but only just, and only because the gates are
// generous. The margin is asserted in the tests rather than assumed, because a
// smaller gate or a faster vehicle in a later mission would fail silently: the
// ring simply would not count, and it would look like a detection bug rather
// than a stepping one.
//
// If that margin ever goes, the fix is a swept segment test against the sphere,
// not a smaller timestep — the timestep is 2016's and is not ours to change.
//
// ── A TRIGGER FIRES ON AN EDGE (DEV-149) ──────────────────────────────────
//
// 2016's gate is `TriggerCheckpoint.OnTriggerEnter`, and Unity fires that for a
// collider that has COME IN. This file shipped the level test instead — *are
// you inside a ring right now?* — which is the same shape as `boundary.ts`'s
// bug and cost the same way, which is DEV-074's lesson arriving a second time:
// **the two agree everywhere except where something TELEPORTS.**
//
// DEV-126 gave the game a teleport. Measured exhaustively over all seven
// shipped HoverJet courses, the reset lands inside an unscored gate's sphere
// in exactly one situation — and that one fires from EVERY crash position on
// the whole route (2,254 of 2,254 sampled arc positions on `int_01`):
//
//   1. the authored `route` STARTS at ring 1. `gateArc[0]` is 0.0 and the
//      line's first point is **1.4 m** from ring 1's trigger centre, against a
//      22.62 m radius;
//   2. the crash reset may not search past the next gate you still owe, so
//      MISS ring 1 and that bound is 0 for the rest of the run;
//   3. `routeArcLengthNearWithin(route, pos, 0)` can only answer ~0, and
//      `max(0, 0 - resetBackMetres)` is 0 — the start of the line;
//   4. next tick the level test finds the ship 1.4 m from an unscored ring
//      and pays for it.
//
// Miss the first ring, crash anywhere, get it free. So: `inside[]`, scored on
// the transition OUT-to-IN, and `seedCourse` for a teleport — the ship is
// PLACED inside the volume, which is not an entry and which Unity, reloading
// its scene, would never have fired one for. Fly out and back in and it counts,
// because that is flying through a ring.
//
// This is also, incidentally, what `triggerOnce: false` always meant. Nothing
// 2016 shipped sets it, but under the level test such a ring paid on every
// tick the ship was inside it — i.e. by frame rate. It now pays per entry.

import { distanceSq, type Vec3 } from './math/vec3'

export interface Gate {
  /** Sphere centre, SIM space. */
  readonly centre: Vec3
  readonly radius: number
  /** `addScore * gateMultiplier`, already multiplied out by the loader. */
  readonly points: number
  /** 2016's `triggerOnce`. Every shipped ring sets it. */
  readonly triggerOnce: boolean
}

export interface CourseState {
  readonly gates: readonly Gate[]
  /** Parallel to `gates`. A gate that has scored never scores again. */
  readonly passed: boolean[]
  /**
   * Parallel to `gates`. Is the ship in this gate's sphere as far as the
   * trigger is concerned? A gate scores on the OUT-to-IN edge and never on
   * being inside — see the header, and `seedCourse` for what a teleport does
   * to this array.
   *
   * Not simply "was it within the radius last tick": an entry that lost the
   * nearest-wins contest stays FALSE so it can still fire on a later tick,
   * which is what it did under the level test.
   */
  readonly inside: boolean[]
  passedCount: number
  score: number
}

export const createCourse = (gates: readonly Gate[]): CourseState => ({
  gates,
  passed: gates.map(() => false),
  inside: gates.map(() => false),
  passedCount: 0,
  score: 0,
})

/** Is this point in gate `i`'s trigger sphere? The one distance test. */
const withinGate = (course: CourseState, i: number, position: Vec3): boolean => {
  const gate = course.gates[i] as Gate
  return distanceSq(position, gate.centre) <= gate.radius * gate.radius
}

/**
 * The ship has been PLACED, not flown: take note of which gates it is standing
 * in and score none of them. DEV-149.
 *
 * Every teleport in the game goes through here — the crash reset (DEV-126),
 * the boundary respawn, the first tick of a run, a mission swap. A gate whose
 * sphere the ship is put inside becomes a gate it is already in, so the next
 * thing that can score it is leaving and coming back, which is what flying
 * through a ring is.
 *
 * Unity does the same thing by brute force: 2016's only reset RELOADS the
 * scene, so the ship arrives at the respawn marker with a fresh set of
 * triggers that have never fired anything.
 */
export const seedCourse = (course: CourseState, position: Vec3): void => {
  for (let i = 0; i < course.gates.length; i++) {
    course.inside[i] = withinGate(course, i, position)
  }
}

/**
 * Advance the course by one sim step.
 *
 * Returns the index of the gate ENTERED this step, or -1. One per step at most:
 * two gates 22 m apart would both contain the ship, and scoring both from one
 * position would double-count a single pass. The nearest wins.
 *
 * An ENTRY, not a containment (DEV-149, and the header): a gate scores on the
 * tick the ship crosses into its sphere from outside. Being inside one because
 * something put you there is not flying through it — see `seedCourse`.
 */
export const stepCourse = (course: CourseState, position: Vec3): number => {
  let best = -1
  let bestDistanceSq = Number.POSITIVE_INFINITY

  for (let i = 0; i < course.gates.length; i++) {
    if (course.passed[i]) continue
    // Already in there: no edge, nothing to fire. The ship has to LEAVE before
    // this gate can pay, which is `inside[i]` going false below.
    if (course.inside[i]) continue
    const gate = course.gates[i] as Gate
    const d = distanceSq(position, gate.centre)
    if (d > gate.radius * gate.radius) continue
    if (d < bestDistanceSq) {
      bestDistanceSq = d
      best = i
    }
  }

  // Leaving a sphere re-arms that gate, and being inside one that has ALREADY
  // fired (or that scored this tick) keeps it armed-down.
  //
  // The one case worth spelling out is the entry that LOST the nearest-wins
  // contest: it is left false, so it fires on a later tick while the ship is
  // still in there. That is what the level test did, and dropping it would
  // silently stop paying for the second of two overlapping rings.
  for (let i = 0; i < course.gates.length; i++) {
    const now = withinGate(course, i, position)
    if (!now) course.inside[i] = false
    else if (course.passed[i] || i === best) course.inside[i] = true
  }

  if (best < 0) return -1
  const gate = course.gates[best] as Gate
  if (gate.triggerOnce) course.passed[best] = true
  course.passedCount++
  course.score += gate.points
  return best
}

/** Metres the ship covers in one sim step at a given speed. See "Tunnelling". */
export const stepDistance = (speed: number, dt: number): number => speed * dt
