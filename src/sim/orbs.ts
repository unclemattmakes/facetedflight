// src/sim/orbs.ts — did the ship collect an energy orb?
//
// SIM LAYER: no three, no DOM, no clock, no randomness — same contract as
// `sim/course.ts` and `sim/targets.ts`.
//
// ── Why orbs are not gates ────────────────────────────────────────────────
//
// They look like `sim/course.ts`'s job: a sphere that awards once. Two things
// separate them, and both are load-bearing.
//
// **1. The award is a COUNT, not points.** `LevelEnd.cs:185-192` — in Free
// Flight `score = energySystem.gatesCleared`, the raw orb count with no `x100`,
// against thresholds of 3 / 5 / 9 / 12. A gate's `points` field would invite
// somebody to multiply it by `gateMultiplier` one day, which is the whole bug
// this separation prevents.
//
// **2. The sphere is SMALL and the point test would miss it.** The collection
// volume is `SphereCollider m_Radius 3` on a child scaled 1.6284 — **4.885 m**
// in the world, against `sim/course.ts`'s 22.6 m gates. That file's tunnelling
// note says the 5.3 m the HoverJet covers per step is "comfortably larger than"
// nothing and "only just" smaller than a gate; at 4.885 m the margin is gone.
// A grazing pass whose closest approach is 4.8 m spends 1.8 m inside the sphere
// and the ship steps 2.2 m, so a point test drops it — silently, as an orb that
// simply did not count, on a mission (`hoverJet_kauai_beg`) whose platinum is
// already one orb short. So: swept.
//
// ── What an orb does NOT do ───────────────────────────────────────────────
//
// No impulse (`Trigger_EnergyOrb.giveBoost` is **0** on the prefab; the C#
// initialiser says true and `boostVal` 160 against the initialiser's 80, and
// none of it is read), no refuel, no respawn. Its only mechanical effect is the
// score. `docs/research/_modes-spec.md` §3.2.

import type { Vec3 } from './math/vec3'

export interface Orb {
  /** Centre, SIM space. */
  readonly centre: Vec3
  /** World collection radius, metres. Carried per orb; nothing here invents one. */
  readonly radius: number
}

export interface OrbsState {
  readonly orbs: readonly Orb[]
  /** Parallel to `orbs`. `SelfDestruct()` disables the root and nothing re-enables it. */
  readonly taken: boolean[]
  /** `EnergySystem_Ship.gatesCleared`. THE Free Flight score — raw, never scaled. */
  collected: number
}

export const createOrbs = (orbs: readonly Orb[]): OrbsState => ({
  orbs,
  taken: orbs.map(() => false),
  collected: 0,
})

/**
 * Squared distance from the segment `from` -> `to` to a point.
 *
 * The clamp to [0, 1] is what makes it a SEGMENT rather than a line: without it
 * an orb 300 m behind the ship, on the ray, would collect.
 */
const segmentDistanceSq = (from: Vec3, to: Vec3, p: Vec3): number => {
  const ex = to.x - from.x
  const ey = to.y - from.y
  const ez = to.z - from.z
  const px = p.x - from.x
  const py = p.y - from.y
  const pz = p.z - from.z
  const lengthSq = ex * ex + ey * ey + ez * ez
  // A stationary ship: the segment is a point and this degrades to a point test.
  let t = lengthSq > 0 ? (px * ex + py * ey + pz * ez) / lengthSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const dx = px - ex * t
  const dy = py - ey * t
  const dz = pz - ez * t
  return dx * dx + dy * dy + dz * dz
}

/**
 * Advance the orbs by one sim step. Returns the orb collected, or -1.
 *
 * One per step at most, nearest first — the same rule `sim/course.ts` applies to
 * gates, and for the same reason: two orbs whose spheres the ship crosses in one
 * step are one pass, and awarding both would make the count depend on the step
 * rate rather than on the flying.
 *
 * **Trap 19.** No module-level scratch: every intermediate is a local, so
 * stepping a second `OrbsState` cannot leave anything behind in the first.
 */
export const stepOrbs = (state: OrbsState, from: Vec3, to: Vec3): number => {
  let best = -1
  let bestDistanceSq = Number.POSITIVE_INFINITY

  for (let i = 0; i < state.orbs.length; i++) {
    if (state.taken[i]) continue
    const orb = state.orbs[i] as Orb
    const distanceSq = segmentDistanceSq(from, to, orb.centre)
    if (distanceSq > orb.radius * orb.radius) continue
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      best = i
    }
  }

  if (best < 0) return -1
  state.taken[best] = true
  state.collected++
  return best
}
