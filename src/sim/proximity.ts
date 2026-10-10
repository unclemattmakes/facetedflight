// src/sim/proximity.ts — G1, the low line is the fast line.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// ANNIVERSARY.md §4.1's first gameplay lever, in its own words:
//
//   *"A score multiplier for flying within N metres of terrain or water, shown
//    as a meter — Superflight's whole design in one rule. It aligns the player's
//    incentive with the game's one great sensation (§2.3 item 1): the fast-
//    feeling line is the low line."*
//
// §2.3 item 1 is the diagnosis it answers: perceived speed is optic flow, optic
// flow falls off with distance, and this game's ground is 8 m facets with no
// texture gradient. **The one place the port already feels fast is low over a
// ridge**, and nothing rewarded going there. This does.
//
// ── This is a GAMEPLAY change and it is fenced like one ───────────────────
//
// §0.2: *"Anything that changes the GAME — scoring, rules, routes — is a
// separate, explicitly gameplay-tagged flag … Classic never reads them."* So:
// the arithmetic is here, pure and deterministic; the DECISION to apply it is
// `edition.gameplay.proximity.enabled`, read in `src/game/`; and Classic's score
// for a given flight is bit-identical with this file in the build, because the
// bonus is a separate pool that stays 0.
//
// ── Why a separate POOL rather than a multiplier on the gate ──────────────
//
// `mission.ts:readScores` recomputes `state.score` every time anything is taken,
// as the SUM of the component scorers (`course.score`, `targets.score`,
// `orbs.score`). It is derived, not accumulated. So multiplying a gate's points
// where they are banked would mean reaching into `sim/course.ts` and making the
// shipped 2016 scorer take a parameter it has no business knowing about.
//
// The pool keeps the 2016 scorers untouched and byte-exact, and it has a second
// property worth more than that: **the bonus is separable after the fact.** The
// results panel can say "4,200 + 900 proximity" rather than "5,100", which is
// the difference between a mechanic a player can learn and a number that went up.
//
// ── THE POOL IS NEVER MEDALLED, and that is the balance answer ────────────
//
// §5's table gives G1 *"Measure: playtest, Risk: balance"*, and the first pass
// at this row tried to answer the risk with a NUMBER — a `maxBonus` small enough
// that a bonused run could not reach the next medal. Its note claimed 0.6 put a
// perfect low run at "3,360 against 2,100, deliberately below the platinum
// thresholds". **That was arithmetic nobody checked, and it is false twice
// over**: 3,360 is not below 2,100, and `int_01`'s platinum is 2,100 while a
// clean 21-gate run scores exactly 2,100. Platinum IS a perfect run. There is no
// headroom to tune into, so no value of `maxBonus` above zero can satisfy the
// claim, and the test that asserted it went red on the first run.
//
// The structural answer is better than any number: **`state.score` — the thing
// medals are read from — never sees this pool.** A medal keeps meaning exactly
// what it meant in 2016, on the same flight, to the point. The bonus is the
// Anniversary SCORE: what the results panel totals and what a leaderboard would
// rank. So the risk the table names is answered by construction rather than by
// tuning, `maxBonus` is free to be generous enough to feel like something, and
// `gameplay-levers.test.ts` pins the invariant that matters — **the medal for a
// given flight is identical with the lever on and off.**
//
// ── DEV-027: say what each number is the ... OF ───────────────────────────
//
// `clearance` is METRES from the ship's hull to the NEAREST probed surface —
// ground or water, whichever is closer — and it is the caller's job to measure
// it, because this file cannot see a height field. At DEV-110 it was the
// vertical distance under the belly alone, and this paragraph said so: *"a
// cliff face 3 m off the wingtip reads as whatever is under the belly."* Matt's
// *"hugging a wall scores higher"* (DEV-112) replaced that with
// `sim/surface-proximity.ts`: six probes in the ship's frame plus the belly,
// the belly being the probe that needs no march, so the number here is one
// minimum over one function and a wall off the wingtip pays like a ridge under
// the hull. G2's CLOSE reads the same number, so the two cannot disagree.
//
// `level` is a 0..1 SMOOTHED closeness, not a distance and not a multiplier.
// `speed` is forward speed in m/s, the same quantity the whoosh and the pulse
// are keyed on.
//
// ── TWO CHANNELS, and why the second one had to exist (DEV-154) ───────────
//
// Matt, 2026-09-16, having flown it: *"i've yet to see scoring influenced by
// flying near objects/terrain."*
//
// At DEV-110 this pool had ONE inlet: `bankProximity`, on a gate. That pays for
// being low AT A GATE, which is 21 instants in an 8,174-tick lap of `int_01` —
// and the gates are not low. Their centres sit 17.8 to 336.5 m above the
// surface, median 87.6, and **not one of the twenty-one is within `nearMetres`
// of it**; on `rookie_01` not one of sixteen, on `int_02` not one of
// twenty-one. So a full meter at a gate is unreachable by construction, and a
// ship flown exactly through every centre — an ideal nobody can fly — caps at
// +319 of the 1,260 that `maxBonus` 0.6 advertises. Five of the autopilot's
// twenty-one crossings read the meter at exactly 0.00.
//
// `perSecond` is the second inlet and it pays for the LINE: every tick, at the
// meter, on all thirteen missions rather than on the seven with rings. The gate
// channel stays — taking THIS gate low is still a choice worth making, and it
// is the half Matt said he liked.

/** Everything G1 is tuned by. All of it is content — `edition.gameplay.proximity`. */
export interface ProximitySpec {
  /** METRES of clearance at or below which the meter reads full. */
  readonly nearMetres: number
  /** METRES at or above which it reads nothing. Must exceed `nearMetres`. */
  readonly farMetres: number
  /**
   * The bonus at a full meter, as a FRACTION of the gate's own points: 1 means
   * a gate taken on the deck is worth double. Not a multiplier — the pool adds
   * `points * bonus`, so 0 is exactly the shipped score.
   */
  readonly maxBonus: number
  /**
   * METRES PER SECOND below which no credit accrues, however low you are.
   *
   * Without it the optimal play is to stop dead one metre off a hillside, which
   * is the opposite of what §4.1 is for: the lever exists to reward the low
   * line, and a line has a speed.
   */
  readonly minSpeed: number
  /** Seconds for the meter to rise. Short: the reward should feel immediate. */
  readonly attackSeconds: number
  /**
   * Seconds for it to fall. LONGER than the attack, deliberately.
   *
   * A meter that empties the instant you clear a ridge punishes the terrain for
   * having a far side, and it flickers on every crest — which is a second thing
   * moving in the periphery, the same argument `vignette.ts` makes about its
   * own asymmetry.
   */
  readonly releaseSeconds: number
  /**
   * POINTS PER SECOND banked at a FULL meter, pro rata at a partial one.
   * 0 is the DEV-110 behaviour exactly — the gate channel and nothing else.
   *
   * **This is the channel that pays for the LINE** (DEV-154). The gate bonus
   * pays for being low at a GATE, which is 21 instants in an 8,174-tick lap of
   * `int_01`, and the gates are 17.8–336.5 m above the surface with **not one
   * of them within `nearMetres`** — so a full meter at a gate is unreachable by
   * construction and the whole channel caps at a quarter of what `maxBonus`
   * advertises. Measured, not assumed; the numbers are in DEV-154 §1.
   *
   * Gated by `minSpeed` through `proximityDemand`, like everything else here,
   * so the anti-hover clause covers this channel without a second number.
   */
  readonly perSecond: number
  /**
   * POINTS of accrual per announcement — **DISPLAY ONLY, it changes no score.**
   *
   * The pool accrues every tick and exactly; this is how often the event row is
   * allowed to say so. A rate is a state display and a player learns from
   * events (DEV-154 §2), so the accrual is chunked into `LOW +N` banners — and
   * the CADENCE of those banners is itself the meter: pinned on the deck they
   * come every `awardStep / perSecond` seconds, at a quarter meter four times
   * slower. 0 announces nothing, which is Classic.
   */
  readonly awardStep: number
}

export interface ProximityState {
  /** 0..1, smoothed. What the meter draws and what the bonus is scaled by. */
  level: number
  /** Points banked this run from the bonus pool. Never negative. */
  bonus: number
  /** The last clearance fed in, METRES. For the HUD and for telemetry. */
  clearance: number
  /**
   * The line channel's SUB-POINT accrual, carried between ticks (DEV-154).
   *
   * A tick is 0.0122 s, so at any sane rate one tick is a fraction of a point.
   * Rounding per tick would either round to zero for ever or pay a whole point
   * 82 times a second; carrying the remainder keeps `bonus` an integer — the
   * results panel adds it to a score — while the accrual itself stays exact.
   */
  pending: number
  /**
   * WHOLE points this channel has banked and not yet announced.
   *
   * This channel's own, never a watermark on `bonus`: the gate bonus and the
   * near miss bank into the same pool and each already has a banner of its own.
   * In the STATE rather than in the caller so the cadence is deterministic and
   * replayable with the rest of the sim, and so a second flight stepped after
   * the first cannot inherit it (trap 19).
   */
  unannounced: number
}

export const createProximity = (): ProximityState => ({
  level: 0,
  bonus: 0,
  clearance: Number.POSITIVE_INFINITY,
  pending: 0,
  unannounced: 0,
})

/**
 * The instantaneous demand, 0..1, before smoothing.
 *
 * Linear between `nearMetres` and `farMetres`. Linear rather than eased because
 * this is a SCORING signal a player has to be able to predict: "half the meter
 * is halfway between the two numbers" is learnable, and an ease is not.
 *
 * A non-finite clearance — outside every height field, which is most of the sky
 * over an ocean — answers 0 rather than NaN.
 */
export const proximityDemand = (clearance: number, speed: number, spec: ProximitySpec): number => {
  if (!Number.isFinite(clearance)) return 0
  if (!(speed >= spec.minSpeed)) return 0
  const span = spec.farMetres - spec.nearMetres
  if (!(span > 0)) return 0
  if (clearance <= spec.nearMetres) return 1
  if (clearance >= spec.farMetres) return 0
  return (spec.farMetres - clearance) / span
}

/**
 * Advance one FIXED sim step. `dt` is the fixed step, never a frame delta (D4).
 *
 * Exponential toward the demand, asymmetric, so that 72 Hz and 144 Hz converge
 * at the same wall-clock rate — the same shape and the same reason as the
 * comfort vignette's.
 */
export const stepProximity = (
  state: ProximityState,
  clearance: number,
  speed: number,
  spec: ProximitySpec,
  dt: number,
): number => {
  state.clearance = clearance
  const demand = proximityDemand(clearance, speed, spec)
  const tau = demand > state.level ? spec.attackSeconds : spec.releaseSeconds
  const step = dt < 0 ? 0 : dt > 0.25 ? 0.25 : dt
  if (!(tau > 0)) state.level = demand
  else state.level += (demand - state.level) * (1 - Math.exp(-step / tau))
  // The LINE channel (DEV-154), AFTER the meter has moved, so a tick banks at
  // the level the meter is SHOWING. Deliberately `state.level` and not
  // `demand`: the gate channel is paid at `state.level` too, and two channels
  // of one lever reading two different numbers is how the meter comes to
  // disagree with the money — the same argument DEV-112 makes about G1 and G2
  // reading one clearance. The cost is that the 0.9 s release keeps paying a
  // little while you climb away, which is the same generosity the gate channel
  // has always had.
  return bankProximityRate(state, spec, step)
}

/**
 * Accrue the line channel and say what to ANNOUNCE this tick, in points.
 *
 * Whole points move into `bonus` as they complete and the remainder is carried
 * in `pending`, so `bonus` is always an integer — the results panel adds it to
 * a score — while the accrual itself is exact over any number of ticks.
 *
 * `unannounced` counts THIS CHANNEL's points only. A watermark on `bonus` would
 * have been shorter and wrong: the gate bonus and the near miss bank into the
 * same pool and each already has its own banner, so a +60 gate would have made
 * the next tick announce a `LOW +50` nobody flew for.
 *
 * The return is 0 or a whole MULTIPLE of `awardStep`, because one long tick can
 * in principle cross two and a banner that silently dropped one would be the
 * panel and the pool disagreeing about what was earned.
 */
export const bankProximityRate = (
  state: ProximityState,
  spec: ProximitySpec,
  dt: number,
): number => {
  const rate = spec.perSecond
  if (rate > 0 && state.level > 0 && dt > 0) {
    state.pending += rate * state.level * dt
    const whole = Math.floor(state.pending)
    if (whole > 0) {
      state.pending -= whole
      state.bonus += whole
      state.unannounced += whole
    }
  }
  const step = spec.awardStep
  if (!(step > 0) || state.unannounced < step) return 0
  const paid = Math.floor(state.unannounced / step) * step
  state.unannounced -= paid
  return paid
}

/**
 * The bonus a gate worth `points` earns at the current meter, in POINTS.
 *
 * Rounded, because a score is an integer in this game and `2350.4` on the
 * results panel would be the mechanic announcing its own arithmetic. Floored at
 * zero so a negative `maxBonus` in a hand-edited preset cannot take points away
 * — G1 is a reward, and a lever that can punish is a different design decision
 * than the one §4.1 argues for.
 */
export const proximityBonus = (
  points: number,
  state: ProximityState,
  spec: ProximitySpec,
): number => {
  const raw = points * spec.maxBonus * state.level
  return raw > 0 ? Math.round(raw) : 0
}

/** Bank a gate's bonus. Returns what was added, for the event record. */
export const bankProximity = (
  state: ProximityState,
  points: number,
  spec: ProximitySpec,
): number => {
  const gained = proximityBonus(points, state, spec)
  state.bonus += gained
  return gained
}

/**
 * Bank a NEAR MISS (DEV-112). Returns what was added, for the event record.
 *
 * A flat award — `gateEvents.nearMissPoints` — rather than a fraction of
 * anything, because a near miss has no gate to be a fraction of: it fires
 * between gates, and on six of the thirteen missions there are no gates at all
 * (DEV-110 §6). Into THIS pool, the same one the gate bonus fills, so the
 * results panel's `+ N low` line and the medal invariant both hold without a
 * second pool to explain. Rounded and floored at zero for `proximityBonus`'s
 * reasons: a score is an integer here, and a lever that can punish is a
 * different design than the one §4.1 argues for.
 */
export const bankNearMiss = (state: ProximityState, points: number): number => {
  const gained = points > 0 ? Math.round(points) : 0
  state.bonus += gained
  return gained
}
