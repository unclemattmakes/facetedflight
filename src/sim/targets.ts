// src/sim/targets.ts — did the ship fly through a jump pad's scoring plate?
//
// SIM LAYER: no three, no DOM, no clock, no randomness. Same contract as
// `sim/course.ts`, for the same reason — a Target Practice run has to score
// identically headless, on replay, and in a headset.
//
// ── A jump pad is a DARTBOARD, not a pad ──────────────────────────────────
//
// `Prefabs/target_jumppad.prefab` carries **17** `Trigger_JumpTarget` volumes,
// every one a `BoxCollider` with `m_Size (1,1,1)` and `m_Center (0,0,0)` — so
// the world extent of a zone is exactly its composed world scale, and the
// extractor already did that composition (`Pad.zones[].half`, in metres).
//
//   · 1 bullseye box over the centre        val_score 100
//   · 8 wedges in a  7.27–17.84 m annulus   val_score  50
//   · 8 wedges in a 13.67–21.22 m annulus   val_score  25
//
// `Trigger_JumpTarget.OnTriggerEnter` (`Scripts/Trigger_JumpTarget.cs:31-68`) is
// `CompareTag("Player") && !triggered` and nothing else. **It is a fly-through,
// not a landing** — `LandedJumpPad` is an aspirational method name.
// (`docs/research/_modes-spec.md` §1.1–1.5.)
//
// ── Why the boxes and not the radii ───────────────────────────────────────
//
// The spec offers a radial approximation (r < 7.27 -> 100, and so on) and is
// honest that it is one: the bullseye is SQUARE, so its corners reach 10.0–10.7
// m where the radial rule says 50, and the eight wedges leave angular gaps. The
// boxes are already in the level JSON at their real world size and pose, so
// there is nothing to approximate and no radius for this file to invent. The
// radial reading survives only as a test oracle (`tests/unit/pad-zones.test.ts`
// checks that the two agree where the spec says they agree).
//
// ── Why a SWEPT segment and not a point ───────────────────────────────────
//
// **The 25 and 50 plates are 0.3185 m thick.** At the fixed 0.0122 s step a ship
// descending faster than ~26 m/s steps straight over one, and the symptom is not
// a crash — it is a pad that silently does not score, read as a detection bug.
// `sim/course.ts` names this as the fix it would need if its 22 m gate spheres
// ever shrank; here the volume is already two orders of magnitude thinner, so
// the swept test is not an optimisation, it is the only correct reading.
//
// The bullseye is 2.6087 m thick — **eight times the tolerance of the plates it
// beats**. That inversion (the centre is worth the most AND is the easiest to
// hit) is the feel of the mode, and `tests/unit/pad-scoring.test.ts` asserts it
// as a distance rather than trusting it as prose.
//
// ── The ACCURACY STREAK — FF2's own, and the one place inventing is the job ──
//
// **Matt, this session: "target practice - yeah, this went in late and wasn't
// ever really satisfied with how it shipped. come up with a arcade-feeling
// scoring method and let's use that."** So the scoring below is a DESIGN, not a
// port, and every knob that shapes it is one commented line in
// `game/targets.ts` rather than a number traced out of Unity. 2016's own rule is
// still in here, as the identity case: hand this file `NO_STREAK` and it scores
// flat, additive, once each, exactly as `ScoreKeeper_JumpPads.cs:84` does.
//
// The rule is:
//
//     pad score  =  the plate's val_score  x  the multiplier standing BEFORE it
//     bullseye (100)  then raises the multiplier, to a cap
//     mid      (50)   then leaves it alone
//     large    (25)   then resets it to 1
//
// plus a flat **perfect-clear bonus** the instant every live pad has been taken.
//
// ── Why a streak on ACCURACY and not a timer ──────────────────────────────
//
// A time-window combo is the obvious arcade move and it is the wrong one here,
// and that is a measurement rather than a taste. The pads on the six shipped
// missions sit **288–707 m from their nearest neighbour** (median 365–612 m by
// mission, widest pair 3,088 m on `adv_02_jumpSeat`), and a JumpSeat in a
// level-flight cruise does **34.45 m/s** — measured by stepping `sim/jumpseat.ts`
// for 60 s at the 50.2 degree tilt where the vertical velocity settles to zero,
// not reasoned from the 750 N / 15 kg / 32 m/s^2 numbers. So **a pad-to-pad leg
// is 8.3 to 20.5 seconds.** Any window tight enough to be a skill test is
// impossible to hold, and any window loose enough to hold is not a test.
//
// That conclusion is deliberately robust to the one open vehicle question. If
// OQ-1 resolves the other way and `tuning.mass` goes 15 -> 16 kg, thrust accel
// falls 50 -> 46.875 and the same balance gives 31.1 m/s, which moves the legs
// to 9.3–22.7 s. The design turns on the ORDER of magnitude — "ten seconds, not
// one" — so it survives being wrong about the cruise by a fifth.
//
// The dartboard already has a centre, so the chain is about WHERE you hit rather
// than how fast you got there — which also makes the three tiers matter, which
// `_modes-spec.md` §9 notes they otherwise do not (100/50/25 are, in 2016, three
// ways to tick the same box).
//
// ── Why the multiplier BEFORE the bullseye raises it ──────────────────────
//
// Two readings are available and they differ by one pad's worth of score. This
// file pays at the multiplier **standing when the plate is crossed**, and then
// applies the plate's effect. Three reasons, in order of weight:
//
//  1. **The panel is not allowed to lie.** `render/hud.ts` shows the multiplier
//     while it is above 1. If a bullseye paid at the raised value, the number the
//     player is looking at as they cross would be the wrong one, every time.
//  2. It is the arcade contract — earn it now, spend it next. A combo builds on
//     the action and pays on the following one.
//  3. It keeps the ladder legible: the first bullseye of a run is worth exactly
//     100, not 200, so "what is a bullseye worth" has a first answer a player can
//     hold on to.
//
// `tests/unit/pad-streak.test.ts` pins it as the SEQUENCE 100, 200, 300 rather
// than as an implementation detail, so the choice cannot be reversed silently.
//
// ── Trap 19 ───────────────────────────────────────────────────────────────
//
// Nothing here is module-level mutable state. Every scratch number lives in a
// local, and the streak is a field on the `TargetsState` it belongs to — so
// stepping a second pad set cannot disturb the first, which is exactly what
// `tests/unit/pad-scoring.test.ts` and `tests/unit/pad-streak.test.ts` each step
// a SECOND one to prove. A multiplier held in a module-level `let` would be the
// purest form of DEV-032: two runs, one stick.

import type { Vec3 } from './math/vec3'

/**
 * A box with a pose, already in SIM space and already at its world size.
 *
 * `axes` are the box's three local unit axes. They are carried instead of a
 * quaternion on purpose: the handedness flip between the level JSON and the sim
 * is an isometry, so flipping the axes' z and the point's z leaves every dot
 * product unchanged — no quaternion convention has to be got right here, and
 * every assertion a test can make about this struct is a distance or a length
 * rather than a belief written twice. (CLAUDE.md, "the orientation lesson".)
 */
export interface OrientedBox {
  /** Box centre, SIM space. */
  readonly centre: Vec3
  /** The box's local x/y/z unit axes, SIM space. */
  readonly axes: readonly [Vec3, Vec3, Vec3]
  /** Half extents along those axes, metres. */
  readonly half: Vec3
}

/**
 * What a plate does to the streak AFTER it has been paid at the standing
 * multiplier. The tier ladder, as a vocabulary rather than as arithmetic.
 *
 * Carried as data instead of derived from `points` on purpose: 100 / 50 / 25 are
 * `Trigger_JumpTarget.val_score`, traced out of the 2016 prefab, while "the
 * bullseye is the one that raises" is FF2's design. Deriving one from the other
 * would fuse a ported number to an invented rule, and the day a pad ships a
 * fourth tier — or the day Matt wants the mid plate to decay — the ladder would
 * have to be re-read out of the point values. `game/targets.ts` assigns these
 * from the plate's tier, which is read from its prefab PATH.
 */
export type StreakEffect =
  /** Raise the multiplier by one, to the cap. The bullseye. */
  | 'raise'
  /** Leave it exactly where it is. The mid plates, under today's knob. */
  | 'hold'
  /** Take one off it, never below 1. What `MID_HOLDS = false` selects. */
  | 'decay'
  /** Back to 1. The outer plates: a graze breaks the run. */
  | 'reset'

/**
 * The shape of the streak, supplied by the game layer.
 *
 * Both numbers are DESIGN values with no 2016 provenance — see `game/targets.ts`,
 * where each is one line with its reasoning. They arrive as data so that this
 * file, which is under `src/sim/`, carries no tuned number of its own
 * (CLAUDE.md hard rule 3).
 */
export interface StreakRules {
  /** The highest the multiplier can reach. */
  readonly cap: number
  /** Flat points per live pad, awarded once when every live pad has been taken. */
  readonly clearBonusPerPad: number
}

/**
 * The identity: no streak, no bonus — **2016's own flat, additive scoring.**
 *
 * `cap: 1` makes every `'raise'` a no-op, so every plate is paid at x1 and the
 * score is the plain sum of `val_score`s that `ScoreKeeper_JumpPads.cs:84`
 * accumulates. Named rather than spelled out at each call site so that "this
 * assertion is about the 2016 reading" is legible in the tests that make it.
 */
export const NO_STREAK: StreakRules = { cap: 1, clearBonusPerPad: 0 }

/** One scoring plate. */
export interface TargetZone extends OrientedBox {
  /** Which pad this plate belongs to. The latch below is per PAD, not per plate. */
  readonly pad: number
  /** `Trigger_JumpTarget.val_score` — 100, 50 or 25. */
  readonly points: number
  /**
   * True when taking this plate closes every plate on the pad.
   *
   * 2016's `objectsToDisableOnTriggered` is asymmetric: a 25 or a 50 disables
   * all three tiers, a 100 disables only the bullseye — which is what makes the
   * shipped per-pad ceiling **150** (bullseye then a mid plate) rather than 100.
   * That asymmetry is a content/deviation decision, not a sim one, so this flag
   * arrives as data from `game/targets.ts` and this file just obeys it.
   */
  readonly closesPad: boolean
  /** This plate's rung on the tier ladder. See `StreakEffect`. */
  readonly streak: StreakEffect
}

export interface TargetsState {
  readonly zones: readonly TargetZone[]
  /** Parallel to `zones`. A plate that has scored never scores again. */
  readonly taken: boolean[]
  /** Indexed by pad. A closed pad's remaining plates never score. */
  readonly padClosed: boolean[]
  /**
   * Indexed by pad. Has this pad yielded ANYTHING yet?
   *
   * Not the same array as `padClosed`, and the difference is only visible under
   * the 2016 latch: there a bullseye leaves the pad open, so a mid plate taken
   * on the way out would walk into `padsHit++` a second time on a pad already
   * counted — a mission of six pads reporting seven "pads landed", and a
   * perfect-clear bonus firing one pad early. Under `PAD_LATCH = 'group'` the two
   * arrays are identical, which is exactly the shape of bug CLAUDE.md's agreement
   * lesson is about: correct everywhere anyone would look.
   */
  readonly padTaken: boolean[]
  /** Distinct pads that have scored at least once. */
  padsHit: number
  /** Plate points x the standing multiplier, plus the perfect-clear bonus. */
  score: number
  /** The streak's shape. Supplied by the game layer; never mutated here. */
  readonly streak: StreakRules
  /**
   * The multiplier a plate crossed RIGHT NOW would be paid at.
   *
   * Starts at 1 — the multiplicative identity, not a tuned value — and moves only
   * through `applyStreak`. `render/hud.ts` shows it while it is above 1, which is
   * the whole reason a plate is paid at the value standing BEFORE its own effect.
   */
  multiplier: number
  /** The perfect-clear bonus banked, or 0. A total, not a per-step reading. */
  clearBonus: number
  /** Latch, so the clear bonus cannot pay twice even at a bonus of zero. */
  cleared: boolean
}

export const createTargets = (
  zones: readonly TargetZone[],
  padCount: number,
  streak: StreakRules,
): TargetsState => ({
  zones,
  taken: zones.map(() => false),
  padClosed: Array.from({ length: padCount }, () => false),
  padTaken: Array.from({ length: padCount }, () => false),
  padsHit: 0,
  score: 0,
  streak,
  multiplier: 1,
  clearBonus: 0,
  cleared: false,
})

/**
 * The multiplier after a plate with this effect has been paid.
 *
 * The step is one rung and the floor is 1. Neither is a tuned game constant —
 * a ladder whose rungs are integers is what makes `x3` a thing a player can read
 * off a panel and predict, and a multiplier below 1 would be a penalty rather
 * than a streak. The only tuned number in sight is the cap, and that arrives as
 * data. (CLAUDE.md hard rule 3 asks for the justification out loud; this is it.)
 */
export const applyStreak = (effect: StreakEffect, multiplier: number, cap: number): number => {
  if (effect === 'raise') return multiplier < cap ? multiplier + 1 : cap
  if (effect === 'reset') return 1
  if (effect === 'decay') return multiplier > 1 ? multiplier - 1 : 1
  return multiplier
}

/**
 * Degeneracy guard, not a game constant.
 *
 * A segment parallel to a slab has zero component along that axis, and the
 * division that finds its entry and exit times is then 0/0. This is the
 * threshold below which the component counts as parallel; it has no units in
 * the game's terms and no provenance to trace. (CLAUDE.md hard rule 3 asks for
 * the justification out loud, so: this is it.)
 */
const PARALLEL_EPSILON = 1e-9

/**
 * Does the segment `from` -> `to` touch this box at all?
 *
 * Slab clipping in the box's own frame. Returns the entry parameter in [0, 1],
 * or -1 for a miss. A segment that starts inside returns 0, and passing the same
 * vector twice degrades to a containment test.
 *
 * Shared with the Target Practice finish volume, which is a 30.345 x 5.653 x
 * 28.860 m prism over one pad (§4.2) — the same shape, tested the same way, so
 * the finish and the plates cannot disagree about what "inside" means.
 */
export const sweepHitsBox = (zone: OrientedBox, from: Vec3, to: Vec3, radius = 0): number => {
  const cx = zone.centre.x
  const cy = zone.centre.y
  const cz = zone.centre.z
  const dx0 = from.x - cx
  const dy0 = from.y - cy
  const dz0 = from.z - cz
  const dx1 = to.x - cx
  const dy1 = to.y - cy
  const dz1 = to.z - cz

  let enter = 0
  let exit = 1

  for (let axis = 0; axis < 3; axis++) {
    const a = zone.axes[axis] as Vec3
    // A swept SPHERE against a box is a swept point against the box grown by the
    // sphere's radius on every face (Minkowski). Exact on the faces, generous by
    // up to (sqrt(3) - 1) r at a corner — 7 cm on a 16 cm foot, and the plates'
    // corners are 10 m from anywhere a foot lands.
    const half = (axis === 0 ? zone.half.x : axis === 1 ? zone.half.y : zone.half.z) + radius
    const start = dx0 * a.x + dy0 * a.y + dz0 * a.z
    const end = dx1 * a.x + dy1 * a.y + dz1 * a.z
    const delta = end - start

    if (delta > -PARALLEL_EPSILON && delta < PARALLEL_EPSILON) {
      // Parallel to this slab: either wholly between its faces or wholly outside.
      if (start < -half || start > half) return -1
      continue
    }

    let near = (-half - start) / delta
    let far = (half - start) / delta
    if (near > far) {
      const swap = near
      near = far
      far = swap
    }
    if (near > enter) enter = near
    if (far < exit) exit = far
    if (enter > exit) return -1
  }

  return enter
}

/**
 * Advance the pads by one sim step. Returns the zone scored, or -1.
 *
 * `from` is the previous step's position and `to` is this one's — see "Why a
 * SWEPT segment" above. Passing the same vector twice degrades to a point test,
 * which is correct but will miss thin plates at speed.
 *
 * **At most one plate per step, and it is the highest-value one the segment
 * touched.** The tiers are vertically disjoint (bullseye −4.30..−1.69, mid
 * −1.22..+0.16, outer +0.68..+1.17 in pad-local metres), so "highest value"
 * means "innermost", which is §1.5's recommendation. Ties inside one tier — the
 * eight wedges overlap slightly at their seams, which is authoring noise — go to
 * the lowest index, so the award never depends on iteration order the way
 * 2016's `OnTriggerEnter` dispatch does. The tiers' point values are distinct, so
 * "highest value" and "best for the streak" cannot disagree; if a pad ever ships
 * two tiers at the same `val_score` and different effects, this needs a
 * tie-break and `tests/unit/pad-streak.test.ts` will not notice.
 *
 * **The order of operations is the design** (see the header): pay at the
 * standing multiplier, THEN apply the plate's effect, THEN check for a clear.
 */
export const stepTargets = (state: TargetsState, from: Vec3, to: Vec3): number =>
  award(state, bestOpenZoneHit(state, from, to, 0, -1))

/**
 * One swept sphere: where a contact was last step, where it is now, and how
 * big it is. The JumpSeat's four FEET are these (DEV-120).
 *
 * ── Why the feet and not the body ─────────────────────────────────────────
 *
 * The plates are set INTO the pad's tier floors: the bullseye box tops out
 * 9.5 cm above the bullseye floor, the mid plates 1.5 cm above theirs, the
 * outer plates 2.6 cm above theirs (pad-local, `level.pads[].zones` against
 * `level.pads[].solid`). On the shipped JumpSeat the only enabled colliders
 * tagged `Player` — the tag `Trigger_JumpTarget.OnTriggerEnter` tests — are the
 * four leg capsules, r 0.16 m; the three body boxes are `Untagged`. So in 2016
 * a plate fired when a FOOT touched the floor inside its ring, and never for a
 * hull passing overhead. Sweeping the body origin (which sits 1.12 m above the
 * floor on parked gear) scores nothing once the floor is solid, and it was only
 * ever scoring because the seat fell through the floor and into the plates.
 */
export interface ContactProbe {
  readonly from: Vec3
  readonly to: Vec3
  readonly radius: number
}

/**
 * `stepTargets` for a set of contacts. The same one-plate-per-step rule: the
 * highest-value open plate any probe touched, ties to the lowest index, then
 * the award. Four feet on one bullseye pay once.
 */
export const stepTargetsProbes = (state: TargetsState, probes: readonly ContactProbe[]): number => {
  let best = -1
  for (const probe of probes) {
    best = bestOpenZoneHit(state, probe.from, probe.to, probe.radius, best)
  }
  return award(state, best)
}

/**
 * The highest-value open plate the swept sphere touches, or `best` unchanged.
 * `best` is an index into `state.zones` (or -1) whose points the candidate has
 * to BEAT — strictly, so the lowest index wins a tie inside one tier.
 */
const bestOpenZoneHit = (
  state: TargetsState,
  from: Vec3,
  to: Vec3,
  radius: number,
  best: number,
): number => {
  let bestPoints = best < 0 ? -1 : (state.zones[best] as TargetZone).points
  let found = best
  for (let i = 0; i < state.zones.length; i++) {
    if (state.taken[i]) continue
    const zone = state.zones[i] as TargetZone
    if (state.padClosed[zone.pad]) continue
    if (zone.points <= bestPoints) continue
    if (sweepHitsBox(zone, from, to, radius) < 0) continue
    bestPoints = zone.points
    found = i
  }
  return found
}

/** Pay for plate `best` (or nothing for -1) and apply its effect. Returns `best`. */
const award = (state: TargetsState, best: number): number => {
  if (best < 0) return -1
  const zone = state.zones[best] as TargetZone
  state.taken[best] = true
  if (!state.padTaken[zone.pad]) {
    state.padTaken[zone.pad] = true
    state.padsHit++
  }
  if (zone.closesPad) state.padClosed[zone.pad] = true

  state.score += zone.points * state.multiplier
  state.multiplier = applyStreak(zone.streak, state.multiplier, state.streak.cap)

  // The perfect clear. It is a COMPLETION reward and the streak is an ACCURACY
  // one, deliberately on separate axes: taking every pad pays the same whether
  // you bullseyed them or grazed them, and the streak pays the same whether you
  // finished the board or not. Two things to chase rather than one, which is
  // what stops a single sloppy pad from writing off the whole run.
  if (!state.cleared && state.padTaken.length > 0 && state.padsHit >= state.padTaken.length) {
    state.cleared = true
    state.clearBonus = state.streak.clearBonusPerPad * state.padTaken.length
    state.score += state.clearBonus
  }
  return best
}

/**
 * The most one pad can yield under the supplied zones, **at x1 and with no
 * bonus** — i.e. 2016's flat reading.
 *
 * Derived, not asserted: `padCeiling` over a 'group'-latched pad is the
 * bullseye's 100, and over the 2016-latched one it is 150 (bullseye, then the
 * best plate still open). Kept as the FLAT number because that is what
 * `_modes-spec.md` §9's finding is about — the shipped bronze of 1600 against a
 * best-possible 1200 — and a finding whose own arithmetic drifts under a later
 * design change stops being a finding. `streakCeiling` is the arcade one.
 */
export const padCeiling = (zones: readonly TargetZone[], pad: number): number => {
  const mine = zones.filter((z) => z.pad === pad)
  if (mine.length === 0) return 0
  const best = Math.max(...mine.map((z) => z.points))
  const opener = mine.find((z) => z.points === best)
  if (!opener || opener.closesPad) return best
  const rest = mine.filter((z) => z.points !== best)
  return rest.length === 0 ? best : best + Math.max(...rest.map((z) => z.points))
}

/**
 * The most a whole run can score under a streak — **a run somebody could fly.**
 *
 * That property, not "the theoretical supremum", is what a platinum threshold
 * needs: `game/modes.ts` sets platinum AT the ceiling, so a ceiling nobody can
 * reach is `rookie_01_hoverJet`'s unreachable platinum all over again, and that
 * one is a `docs/DEVIATIONS.md` row Matt has already ruled a bug.
 *
 * The construction: take each pad's best RAISING plate, then meet them in
 * ascending order of value. Ascending is not a guess — the multiplier sequence
 * is non-decreasing, so by the rearrangement inequality the sum is maximised by
 * pairing the biggest plate with the biggest multiplier, which means the
 * smallest plate goes first. On every shipped pad the choice is trivial anyway:
 * all 57 instances are the same prefab, so every pad's best plate is a bullseye
 * worth 100 that raises, and the ceiling is simply "take every bullseye".
 *
 * A pad whose best plate does NOT raise falls back to that plate and its own
 * effect, and the answer is then achievable but possibly not optimal. That
 * branch is dead on the shipped data and
 * `tests/unit/pad-streak.test.ts` asserts it stays dead, so the "exact" claim is
 * checked rather than assumed. (CLAUDE.md: a derived number needs the same
 * provenance discipline as an extracted one.)
 */
export const streakCeiling = (
  zones: readonly TargetZone[],
  padCount: number,
  rules: StreakRules,
): number => {
  if (padCount <= 0) return 0
  const chosen: TargetZone[] = []
  for (let pad = 0; pad < padCount; pad++) {
    const mine = zones.filter((z) => z.pad === pad)
    if (mine.length === 0) continue
    const raisers = mine.filter((z) => z.streak === 'raise')
    const from = raisers.length > 0 ? raisers : mine
    let pick = from[0] as TargetZone
    for (const z of from) if (z.points > pick.points) pick = z
    chosen.push(pick)
  }
  // Raisers first, so every rung they buy is spent on the plates after them;
  // then ascending by value, per the rearrangement inequality above.
  chosen.sort((a, b) => {
    const ra = a.streak === 'raise' ? 0 : 1
    const rb = b.streak === 'raise' ? 0 : 1
    return ra !== rb ? ra - rb : a.points - b.points
  })

  let multiplier = 1
  let total = 0
  for (const zone of chosen) {
    total += zone.points * multiplier
    multiplier = applyStreak(zone.streak, multiplier, rules.cap)
  }
  // Every pad taken is, by construction, a perfect clear.
  return total + rules.clearBonusPerPad * chosen.length
}
