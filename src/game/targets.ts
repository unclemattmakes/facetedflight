// src/game/targets.ts — jump pads, turned into something the sim can score.
//
// Game rules, not physics, and deliberately THREE-FREE: `game/mission.ts`
// imports this and has to keep running in Vitest's node environment. The pad
// ART lives in `game/pad-art.ts`.
//
// The measurements and every code citation below come from
// `docs/research/_modes-spec.md` §1–§4, which traced the 2016 project so this
// file would not have to. Where the spec and the generated data disagreed, the
// generated data won — see "What the level JSON does and does not carry".
//
// ── A pad is a dartboard with a latch ─────────────────────────────────────
//
// 17 `Trigger_JumpTarget` boxes per pad: one bullseye worth 100, eight wedges
// worth 50, eight worth 25. `Trigger_JumpTarget.cs:52-55` then disables a SET of
// them — and the set is asymmetric:
//
//   · a 25 or a 50 hit disables all three tiers        -> the pad is spent
//   · a 100 hit disables ONLY the bullseye             -> a mid plate can follow
//
// which is why 2016's real per-pad ceiling is **150** (bullseye, then a mid
// plate on the way back out) and not 100. That asymmetry looks like a bug, and
// `_modes-spec.md` §1.5 recommends collapsing it. **`PAD_LATCH` below is the one
// line that chooses**, and either way it is a `docs/DEVIATIONS.md` row, because
// 2016's behaviour is the asymmetric one.
//
// ── What the level JSON does and does not carry ───────────────────────────
//
// It carries, per pad: the pose, `live`, and 17 `zones` as world-space boxes
// with `half` already in metres (Unity sizes a `BoxCollider` by the transform
// scale, and `m_Size` is (1,1,1) on every one of them, so the composed scale IS
// the extent). Checked against `int_01_jumpSeat`: the bullseye's half-width
// reads 7.268339 m and the 25-plates' half-thickness 0.15925 m, matching the
// spec's 7.268 m and 0.3185 m to five figures. Live pad counts read
// 5 / 7 / 6 / 9 / 10 / 12 across the six missions, matching §9's table exactly.
//
// It does NOT carry:
//
//  1. **`val_score`.** The extractor reads colliders, not the `Trigger_JumpTarget`
//     component, and `src/content/level-schema.ts` says so out loud: "What a
//     `score` hit is WORTH is the JumpSeat mode's business, not this file's".
//     So `TIER_POINTS` below is the one hand-carried table in this module, with
//     its provenance on the line. `tests/unit/pad-zones.test.ts` pins it against
//     the pad's own `canvas_scoreLabels`, which reads 100 / 50 / 50 / 25 / 25.
//  2. **Which pad carries the finale** — as a flag on the pad row. It does not
//     need to: the extractor emits the finish volume itself as
//     `level.finish.shape === 'convexMesh'`, and `_meta.path` on it names the pad.
//     See `finishFor`.
//
// ── Which tier a zone is ──────────────────────────────────────────────────
//
// From the PATH, not the name: eight objects called `collider_ground (N)` are
// one ring of the target, and the ring they belong to is their parent —
// `trigger_bullseye (1)`, `trigger_mid_section (1)`, `trigger_large_section (1)`.
// An unrecognised path THROWS rather than scoring zero: a plate the port cannot
// classify is a plate the player flies through for nothing, which reads as a
// detection bug and is the quietest possible failure.

import type { Level, Pad, PadBoxVolume, QuatTuple, Vec3Tuple } from '@/content/level-schema'
import { type Quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import {
  type OrientedBox,
  padCeiling,
  type StreakEffect,
  type StreakRules,
  streakCeiling,
  type TargetZone,
} from '@/sim/targets'

/**
 * `Trigger_JumpTarget.val_score`, by tier.
 *
 * Prefab `Prefabs/target_jumppad.prefab`; identical on all 17 zones and
 * **never overridden in any shipped scene** — `_modes-spec.md` §1.4 diffed every
 * `m_Modifications` block of all 57 pad instances and not one touches
 * `val_score`, `trigger_once`, `giveRefuelBonus` or `refuelMultiplier`.
 *
 * Hand-carried, and it is the only number in this file that is. It belongs in
 * the level JSON the day `tools/extract/level.mjs` reads the component rather
 * than the collider; until then `tests/unit/pad-zones.test.ts` is the guard.
 */
const TIER_POINTS = {
  bullseye: 100,
  mid: 50,
  large: 25,
} as const

export type PadTier = keyof typeof TIER_POINTS

/**
 * Which zones close the whole pad when taken. **SETTLED by the streak design.**
 *
 * `'group'`   — any hit spends the pad. Deterministic, per-pad flat ceiling 100.
 * `'zone2016'` — 2016's asymmetry verbatim: a 25 or a 50 disables all three
 *               tiers but a 100 disables only the bullseye, so a bullseye
 *               followed by a mid plate on the way out scores twice. Flat
 *               ceiling 150.
 *
 * This was an open taste question — `_modes-spec.md` §1.5 recommends `'group'`
 * and left it to Matt — right up until the accuracy streak landed, and then it
 * stopped being one. Under a multiplier the 2016 asymmetry is not a 50 % quirk,
 * it is **a farm on a single pad**: cross the bullseye, bank 100 x m, turn round
 * and clip a mid plate for another 50 x m without ever leaving that pad. At the
 * cap of 5 that is 250 free points per pad, 3,000 on `adv_02_jumpSeat`, and it is
 * bought by flying badly — a wobble over one dish outscores a clean line over
 * two. A scoring rule whose best play is to stop moving is not an arcade rule.
 *
 * So: `'group'`. The streak decides it, not taste, and 2016's behaviour is the
 * asymmetric one either way, so it is a `docs/DEVIATIONS.md` row regardless.
 * Everything downstream — the medal ceilings, `padCeiling`, `streakCeiling`, the
 * tests — is derived from this line rather than typed next to it.
 */
export const PAD_LATCH: 'group' | 'zone2016' = 'group'

const closesPad = (tier: PadTier): boolean => (PAD_LATCH === 'group' ? true : tier !== 'bullseye')

// ── The three knobs. Every one a DESIGN value; none of them is 2016's ──────
//
// There is nothing to port here: `ScoreKeeper_JumpPads.cs:84` is
// `jumpPadScore += val_score` and `CalcScore()`'s arithmetic is commented out,
// so no multiplier, streak, combo or completion bonus has ever existed in this
// game. These three lines ARE the design, and each is one line so that Matt can
// move it without reading the rest of the file. Ceilings and medal thresholds
// are computed from them (`game/modes.ts`), never typed alongside them.

/**
 * How high the multiplier goes. **DESIGN value — start at 5.**
 *
 * Chosen against the pad counts rather than for a round number. The six missions
 * carry 5 / 6 / 7 / 9 / 10 / 12 live pads, so a cap of 5 is reached on the fifth
 * clean bullseye and then HELD — every mission can get there, the shortest one
 * only on its last pad, and the longest one still has seven pads of holding it
 * to do. That is the shape you want: the build is the early game, the hold is
 * the late game, and no run is decided by a tail that pays more than everything
 * before it. Uncapped, `adv_02_jumpSeat`'s twelfth pad alone would be worth 1,200
 * against a whole-run 7,800 — one plate, 15 % of the run.
 */
const STREAK_CAP = 5

/**
 * The perfect-clear bonus, per live pad. **DESIGN value — start at 100.**
 *
 * Per pad rather than flat, so it means the same thing on a 5-pad mission and a
 * 12-pad one: one extra bullseye's worth of reward for every pad on the board,
 * or about 23 % of the ceiling on every mission (500/2,000 through 1,200/6,200).
 * A flat bonus would be a rounding error on `adv_02_jumpSeat` and the whole game
 * on `rookie_01_jumpSeat`.
 *
 * It pays for COMPLETION and is deliberately not multiplied: the streak already
 * rewards accuracy, and multiplying the clear as well would stack the two axes
 * into one and make a single grazed pad cost the run twice.
 */
const PERFECT_CLEAR_PER_PAD = 100

/**
 * Does a mid plate HOLD the multiplier, or knock a rung off it?
 * **DESIGN value — start at holds (`true`).**
 *
 * Holding makes the ladder read as one clean idea — centre builds, ring holds,
 * edge breaks — and it gives a player who is not hitting centres something to
 * play for other than not-losing. Decaying (`false`) makes the mid plate a slow
 * bleed and turns the mode into "bullseye or nothing", which is a harder game and
 * a narrower one; it is worth trying in a headset before ruling on it, because
 * the 50-plates are 0.3185 m thick against the bullseye's 2.6087 m and a
 * mid-plate hit is therefore the RARER skill, not the consolation prize
 * (`_modes-spec.md` §1.2). Flip the line, re-run `pnpm test`, and the ceilings,
 * the thresholds and every assertion follow.
 */
const MID_HOLDS = true

/** The ladder: which tier does what to the multiplier. See `StreakEffect`. */
const TIER_STREAK: Record<PadTier, StreakEffect> = {
  bullseye: 'raise',
  mid: MID_HOLDS ? 'hold' : 'decay',
  large: 'reset',
}

/**
 * The streak as the sim consumes it. One door, so `src/sim/` holds no knob.
 *
 * A function rather than a frozen constant because a `StreakRules` handed to two
 * `TargetsState`s would be shared — it is `readonly` and never written, so that
 * is safe today, and a fresh object per run means it stays safe if it ever stops
 * being readonly. Trap 19 is cheaper to prevent than to find.
 */
export const padStreakRules = (): StreakRules => ({
  cap: STREAK_CAP,
  clearBonusPerPad: PERFECT_CLEAR_PER_PAD,
})

/** `jumpPad 1/trigger_mid_section (1)/collider_ground (4)` -> `'mid'`. */
export const tierOf = (zone: PadBoxVolume): PadTier => {
  if (zone.path.includes('trigger_bullseye')) return 'bullseye'
  if (zone.path.includes('trigger_mid_section')) return 'mid'
  if (zone.path.includes('trigger_large_section')) return 'large'
  throw new Error(
    `pad zone "${zone.path}" belongs to no known scoring tier. ` +
      'The three are trigger_bullseye / trigger_mid_section / trigger_large_section ' +
      '(target_jumppad.prefab). A zone that cannot be classified would silently ' +
      'score nothing — see docs/research/_modes-spec.md §1.1.',
  )
}

/**
 * A world-space collider row (THREE space) -> an `OrientedBox` (SIM space).
 *
 * Two flips, and they are the same flip: the centre's z is negated, and so is
 * each axis's z. That is legitimate because the handedness change is an
 * isometry — negating z on both sides of a dot product cancels — so the box
 * test gives the same answer in either space and no quaternion convention has to
 * be got right here. `tests/unit/pad-zones.test.ts` checks the consequence
 * rather than the derivation: the axes come out orthonormal and the distances
 * between plates match the prefab's.
 */
const boxFrom = (pos: Vec3Tuple, quat: QuatTuple, half: Vec3Tuple): OrientedBox => {
  const q: Quat = { x: quat[0], y: quat[1], z: quat[2], w: quat[3] }
  const axis = (x: number, y: number, z: number): Vec3 => {
    const a = rotateVec3(v3(), q, v3(x, y, z))
    a.z = -a.z
    return a
  }
  return {
    centre: v3(pos[0], pos[1], -pos[2]),
    axes: [axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1)],
    half: v3(half[0], half[1], half[2]),
  }
}

/** The pads a run can actually score against — the extractor's liveness walk. */
export const livePads = (level: Level): Pad[] => level.pads.filter((p) => p.live)

/** One live pad's landing surface: its axis in SIM world space and how far it reaches. */
export interface PadSurface {
  readonly x: number
  readonly z: number
  /** `solid.outer`, metres — the bowl's last radius with surface under it. */
  readonly radius: number
}

/**
 * Where each live pad's landing surface stands, SIM space. DEV-345.
 *
 * The axis is the SOLID's node, not the pad root: `solid.outer` is measured
 * from it, and the two differ by the prefab's own offset. `outer` is in the
 * n-gon norm with a vertex on the node's +x (`sim/pad-surface.ts`), so it is
 * the octagon's CIRCUMradius and a circle of that radius holds the whole bowl.
 * A pad without a solid is refused by `pnpm extract:levels --check`, so it
 * does not ship; one that did would clear nothing rather than a guessed disc.
 */
export const padSurfaces = (level: Level): PadSurface[] => {
  const out: PadSurface[] = []
  for (const pad of livePads(level)) {
    if (!pad.solid) continue
    // THREE -> SIM is the z mirror, as `boxFrom` above does it.
    out.push({ x: pad.solid.pos[0], z: -pad.solid.pos[2], radius: pad.solid.outer })
  }
  return out
}

/**
 * Every scoring plate on every live pad, in SIM space, in pad order.
 *
 * `pad` on each zone indexes into `livePads(level)`, NOT into `level.pads` — a
 * dead pad has no index here at all, so a latch can never be spent on one.
 */
export const padZones = (level: Level): TargetZone[] => {
  const zones: TargetZone[] = []
  livePads(level).forEach((pad, padIndex) => {
    for (const zone of pad.zones) {
      if (!zone.live) continue
      const tier = tierOf(zone)
      zones.push({
        ...boxFrom(zone.pos, zone.quat, zone.half),
        pad: padIndex,
        points: TIER_POINTS[tier],
        closesPad: closesPad(tier),
        streak: TIER_STREAK[tier],
      })
    }
  })
  return zones
}

/**
 * The most a Target Practice run on this level can score **under 2016's flat
 * rule** — one plate per pad, x1, no bonus. §9's table, and nothing else.
 *
 * Kept flat on purpose. It is the number `_modes-spec.md` §9's finding is stated
 * in ("the shipped bronze of 1600 is reachable on exactly one mission"), and
 * `tests/unit/mode-medals.test.ts` holds that finding visible in CI. A ceiling
 * that silently grew when FF2's streak landed would quietly retire a finding
 * nobody had revisited. `arcadePadCeiling` is what the medal curve reads.
 */
export const maxPadScore = (level: Level): number => {
  const zones = padZones(level)
  let total = 0
  for (let pad = 0; pad < livePads(level).length; pad++) total += padCeiling(zones, pad)
  return total
}

/**
 * The most a Target Practice run can score under FF2's streak: every pad's
 * bullseye, in the order that pays best, plus the perfect clear.
 *
 * Derived from the same `applyStreak` the scorer runs, never a table — so the
 * day a knob above moves, the ceilings and the medal thresholds move with it and
 * `tests/unit/pad-streak.test.ts` flies a perfect run and checks the two agree.
 */
export const arcadePadCeiling = (level: Level): number =>
  streakCeiling(padZones(level), livePads(level).length, padStreakRules())

// ── What ends a Target Practice run ───────────────────────────────────────
//
// One `Trigger_Finish_JumpSeat`, and it lives INSIDE `target_jumppad.prefab` on
// a child called `finale_jumpSeat (1)` which ships `m_IsActive: 0`. Each mission
// scene switches it on for exactly one pad with an `m_Modifications` entry, and
// composed it is a **30.345 x 5.653 x 28.860 m** slab sitting ABOVE the pad — not
// the "32x-tall column" an earlier reading reported. (`_modes-spec.md` §4.2.)
//
// `level.finish` was null on all six JumpSeat missions for the whole life of the
// port, and that null was the extractor not looking rather than the object being
// absent — DEV-045's trap one prefab layer deeper. **It is no longer null:**
// `tools/extract/level.mjs` now emits `shape: 'convexMesh'` for the six, and the
// pad it names (`target_jumppad (4)` on `int_01_jumpSeat`, `(5)` on
// `adv_02_jumpSeat`, …) matches §4.2's table pad for pad. So there is nothing
// left for this module to guess, and it guesses nothing: a level whose data
// carries no finish at all says so, loudly, once.
//
// **The box, not the hull.** `FinishGateConvexMesh` carries `half` (an oriented
// bounding box) and `hull` (the ten true vertices, because the collider is
// convex and the box over-approximates a pentagonal prism). This uses `half`:
// unambiguous in the schema, exactly the slab §4.2 measured, and its error is
// one-sided — the box is never SMALLER than the gate, so it can end a run a
// couple of metres early at a cut corner and can never fail to end one. Tighten
// it with `hull` the day that matters.

export type FinishVolume =
  | { readonly kind: 'sphere'; readonly centre: Vec3; readonly radius: number }
  | ({ readonly kind: 'box' } & OrientedBox)

/**
 * The volume that ends a run, or null when the data carries none.
 *
 * Two shapes, one door, and they are narrowed on `shape` rather than on the
 * vehicle: a Ring Attack mission's `Trigger_FinishLine` is a union of spheres
 * whose largest (68.59 m on every shipped mission) is what the ship realistically
 * hits; a Target Practice mission's is the pad slab above. Reading
 * `FinishGateConvexMesh.radius` as the gate would be wrong by design — the schema
 * marks it BROAD PHASE ONLY, 21.13 m, bigger than the gate in every direction.
 */
export const finishFor = (level: Level): FinishVolume | null => {
  const finish = level.finish
  if (!finish) return null
  if (finish.shape === 'convexMesh') {
    return { kind: 'box', ...boxFrom(finish.pos, finish.quat, finish.half) }
  }
  return {
    kind: 'sphere',
    // Into SIM space, the same z flip every gate centre goes through.
    centre: v3(finish.pos[0], finish.pos[1], -finish.pos[2]),
    radius: finish.radius,
  }
}

/**
 * The finish pad's own AIRSPACE — what makes its score deterministic.
 *
 * §4.2's one unresolved ⚠️: the finish slab spans pad-local y −0.458 .. +5.194
 * and the scoring plates run +1.167 down to −4.300, so **a descent enters the
 * finish about 6.9 m above the bullseye it is about to cross.** 2016 ends the
 * run there and reads the score 0.1 s later (`LevelFinaleManager.cs:36`), which
 * makes the finish pad worth 0–100 points depending on how fast you were
 * falling — you would have to descend at 69 m/s to win that race. §4.2 says the
 * port should not reproduce it.
 *
 * The deterministic reading needs no invented number, because the pad already
 * carries one: `Trigger_JumpPad`'s landing volume is a **28.37 m sphere centred
 * 21.5 m above the pad** (Unity collapses the capsule to a sphere — `landing.
 * degenerateToSphere` is true on all 57 instances). Its floor is 6.8 m BELOW the
 * bullseye's and its roof is 50 m above, so it is exactly "this pad's airspace":
 * you enter it well before the slab and leave it after the last plate.
 *
 * So: **cross the finish, and the run commits when you leave the pad's airspace
 * or spend the pad, whichever comes first.** Fly through, come out the bottom,
 * run over — with the pad's points counted. Returns null if the data has no
 * landing volume, in which case the settle window alone applies.
 */
export const finishPadAirspace = (
  level: Level,
): { readonly pad: number; readonly centre: Vec3; readonly radius: number } | null => {
  const finish = finishFor(level)
  // Only a JumpSeat finish needs this; a Ring Attack gate is 234.6 m past the
  // last ring with no pad anywhere near it.
  if (finish?.kind !== 'box') return null
  const pads = livePads(level)
  let best = -1
  let bestDistanceSq = Number.POSITIVE_INFINITY
  pads.forEach((pad, i) => {
    if (!pad.landing) return
    const dx = pad.pos[0] - finish.centre.x
    const dy = pad.pos[1] - finish.centre.y
    // `finish.centre` is SIM space and `pad.pos` is THREE space: flip one.
    const dz = -pad.pos[2] - finish.centre.z
    const distanceSq = dx * dx + dy * dy + dz * dz
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      best = i
    }
  })
  const pad = pads[best]
  if (best < 0 || !pad?.landing) return null
  // The slab sits at pad-local (0, +2.368, +1.523), so the true pad is metres
  // away and every other pad is tens of metres away. A generous bound that still
  // refuses to guess if the data ever puts a finish nowhere near a pad.
  if (bestDistanceSq > pad.landing.radius * pad.landing.radius) return null
  const l = pad.landing
  return { pad: best, centre: v3(l.pos[0], l.pos[1], -l.pos[2]), radius: l.radius }
}

/**
 * Why this level has no end condition, or null if it has one.
 *
 * A string rather than a boolean, because the caller's job is to PRINT it: the
 * honest-degrade path. `game/mission.ts` logs it once per run start, and the run
 * then falls back to the clock — which is an invention on the six JumpSeat
 * missions, where `timer.timeLimit: 180` is a tuned, UNREAD field and 2016 has no
 * time limit at all (§4.3). Saying that out loud is the point of this function.
 *
 * All thirteen shipped missions carry a finish today, so this fires only for a
 * hand-authored or generated course — and `tests/unit/mode-rules.test.ts` asserts
 * that the thirteen stay silent, so the guard cannot rot into always-on noise.
 */
export const finishGap = (level: Level): string | null => {
  if (finishFor(level)) return null
  return (
    `level "${level.id}" (mode ${level.mode}) carries no finish volume, so nothing can end ` +
    'the run but the clock — and on a JumpSeat mission the clock is an invention: ' +
    'timer.timeLimit is 180 s and is a tuned, unread field on all six (2016 ends a ' +
    'Target Practice run at the Trigger_Finish_JumpSeat inside target_jumppad.prefab, ' +
    'docs/research/_modes-spec.md §4.2). Fix the DATA, not this fallback.'
  )
}
