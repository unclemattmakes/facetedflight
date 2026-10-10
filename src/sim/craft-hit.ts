// src/sim/craft-hit.ts — being hit by a racer COSTS something. DEV-364 follow-up.
//
// Matt, 2026-09-25, on DEV-364's open call ("should a hard hit cost speed
// beyond what it hands on?"): *"sound and physics cost - nudge the players as
// if they got hit"*. The push stays as it was (restitution 0.5, his call 5).
//
// ── What the push already does, and why it is not a hit ──────────────────
//
// `craft-contact.ts` shares the closing speed along the contact normal and
// moves nothing else: the player who rear-ends a racer loses what the racer
// gains and flies on, nose where it was, wings where they were. Momentum is
// exact and it reads as nothing happened — a ship you rammed at 20 m/s is a
// ship you nudged. So the PLAYER, and only the player, now takes a hit on top
// of the push. A racer the player hits feels the same push it always did.
//
// ── The law ───────────────────────────────────────────────────────────────
//
// One number says how hard: the closing speed along the normal, the same
// speed the push shares. Under `minSpeed` it is a lean, not a hit (the
// preset sets it to the push's own `restingSpeed`, under which nothing
// bounces either); at `fullSpeed` and above it is the hardest hit there is:
//
//     s = clamp01((closing - minSpeed) / (fullSpeed - minSpeed))
//
// and `a` is the unit direction the push threw the player, away from what hit
// it (the contact report's `away`). Then, once, on the tick of the hit:
//
//   · the SPEED is scrubbed:         v  *= 1 - scrub · s
//   · the HEADING is knocked:        ω  += headingKick · s · (f × a)
//   · the ATTITUDE is knocked:       ω  += attitudeKick · s · (u × a)
//
// with `f` and `u` the ship's own nose and top, world space. The two cross
// products are chosen for what they DO, not for a torque arm: an angular
// velocity `k × a` moves the vector `k` toward `a` (d k / dt = ω × k = a less
// its part along k). So the first swings the nose toward where the push
// threw the ship — hit from the left, the nose slews right — and the second
// tips the canopy the same way: hit from the left, the left wing comes up and
// the ship banks right. Rammed from behind (`a` along the nose) the heading
// term vanishes and the attitude term pitches the nose DOWN; ram something
// (`a` against the nose) and it pitches UP, the rammer riding up over the
// tail it hit. Every direction of hit therefore moves the ship; none moves
// it along a direction the push did not.
//
// The kicks are ANGULAR VELOCITY, not an orientation jump: the rigid body's
// own angular drag (the prefab's 1.95 /s) bleeds them away, so a kick of k
// rad/s turns the ship through about k / 1.95 rad over half a second, and the
// pilot's stick is live through all of it. A hit is felt and flown out of;
// it is not a cut.
//
// ── Never a crash ─────────────────────────────────────────────────────────
//
// This writes the player's velocity and angular velocity and nothing else —
// no crash state, no impact speed, no terrain contact. A ship knocked into a
// hillside meets it by DEV-126's rule, which is the world's.
//
// ── Deterministic ─────────────────────────────────────────────────────────
//
// It runs in the fixed step, off the contact report of that step, with no
// allocation, no clock and no `Math.random`. The sound and the cockpit's jolt
// are the RENDER side's (`game/racer-hit.ts`) and read this file's report.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random()`.

import { rotateVec3 } from './math/quat'
import { v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'

/** `gameplay.racers.hit`, as the sim reads it. */
export interface CraftHitSpec {
  readonly enabled: boolean
  /** m/s of closing speed at and under which a contact is a lean, not a hit. */
  readonly minSpeed: number
  /** m/s of closing speed at which the hit is at full strength. Above `minSpeed`. */
  readonly fullSpeed: number
  /** 0..1: the fraction of the player's speed a full-strength hit takes away. */
  readonly scrub: number
  /** rad/s of angular velocity swinging the nose toward the push, at full strength. */
  readonly headingKick: number
  /** rad/s of angular velocity tipping the canopy toward the push, at full strength. */
  readonly attitudeKick: number
}

/** What the hit rule did. A reading, for the render side and the probes. */
export interface CraftHitReport {
  /** The player was hit THIS tick. */
  struck: boolean
  /** The closing speed of this tick's hit, m/s; 0 when none. */
  speed: number
  /** Its strength, 0..1; 0 when none. */
  strength: number
  /** Hits since the report was made. A frame spans more than one fixed step. */
  total: number
  /** The strongest hit since the report was made, 0..1. */
  strongest: number
}

export const createCraftHitReport = (): CraftHitReport => ({
  struck: false,
  speed: 0,
  strength: 0,
  total: 0,
  strongest: 0,
})

/** How hard a hit at `closing` m/s is, 0..1. Zero at and under `minSpeed`. */
export const craftHitStrength = (spec: CraftHitSpec, closing: number): number => {
  if (!spec.enabled) return 0
  const span = spec.fullSpeed - spec.minSpeed
  if (!(span > 0)) return 0
  const t = (closing - spec.minSpeed) / span
  return t <= 0 ? 0 : t >= 1 ? 1 : t
}

/** Volatile scratch, valid only inside one `applyCraftHit`. */
const _axis = v3()
const _fore = v3()
const _up = v3()

/**
 * Hit `body`: it was struck at `closing` m/s and pushed along the unit
 * (`ax`, `ay`, `az`). Returns the strength applied, 0 for none (and then
 * nothing was written). Writes `report` either way.
 */
export const applyCraftHit = (
  body: RigidBody,
  closing: number,
  ax: number,
  ay: number,
  az: number,
  spec: CraftHitSpec,
  report: CraftHitReport | null = null,
): number => {
  const s = craftHitStrength(spec, closing)
  if (report) {
    report.struck = s > 0
    report.speed = s > 0 ? closing : 0
    report.strength = s
  }
  if (s <= 0) return 0
  // ── the speed ─────────────────────────────────────────────────────────
  const keep = 1 - spec.scrub * s
  const k = keep < 0 ? 0 : keep
  body.velocity.x *= k
  body.velocity.y *= k
  body.velocity.z *= k
  // ── the heading and the attitude ──────────────────────────────────────
  // The sim's body frame is +Z nose, +Y canopy (`lookAlong`).
  _axis.x = 0
  _axis.y = 0
  _axis.z = 1
  rotateVec3(_fore, body.orientation, _axis)
  _axis.z = 0
  _axis.y = 1
  rotateVec3(_up, body.orientation, _axis)
  const h = spec.headingKick * s
  const t = spec.attitudeKick * s
  // f × a and u × a, written out: no allocation, no shared scratch escaping.
  body.angularVelocity.x += h * (_fore.y * az - _fore.z * ay) + t * (_up.y * az - _up.z * ay)
  body.angularVelocity.y += h * (_fore.z * ax - _fore.x * az) + t * (_up.z * ax - _up.x * az)
  body.angularVelocity.z += h * (_fore.x * ay - _fore.y * ax) + t * (_up.x * ay - _up.y * ax)
  if (report) {
    report.total++
    if (s > report.strongest) report.strongest = s
  }
  return s
}
