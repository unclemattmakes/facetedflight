/**
 * tests/unit/gameplay-levers.test.ts — G1 and G2, the only two flags in the
 * game that change the SCORE (DEV-110).
 *
 * The order is the order these would hurt in:
 *
 *  1. **Classic scores exactly what 2016 scored.** Every other Anniversary flag
 *     can be judged by eye and argued about; this block cannot, because a wrong
 *     number here is indistinguishable from a right one until somebody compares
 *     two runs. §0.2 fenced it for this reason and this is the fence.
 *  2. **The ramp is not inverted.** `nearMetres >= farMetres` makes the meter
 *     read full at altitude and empty on the deck — a lever rewarding the exact
 *     opposite of what §4.1 argues for, with nothing about the frame looking
 *     wrong. Refused at load.
 *  3. **The bonus is never medalled**, which is how §5's *"Risk: balance"* got
 *     answered. The first design tried to answer it with a number — a
 *     `maxBonus` low enough that a bonused run could not reach the next medal —
 *     and the arithmetic here killed it on the first run: `int_01`'s platinum
 *     is 2,100 and a clean 21-gate run scores exactly 2,100, so platinum IS a
 *     perfect run and there was never headroom to tune into. The structural
 *     answer replaced it.
 *  4. **Centredness is measured on the swept segment**, not at the crossing
 *     tick — the tick-sampled distance is mostly frame rate, and this is the
 *     test that separates them.
 *  5. **A near miss is a MISS**, and a long low pass is one event.
 *
 * Pure: no GL, no DOM, no fields. Everything here is arithmetic over content.
 */
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { editionFeatures, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { medalFor, NO_LEVERS, startMission, stepMission } from '@/game/mission'
import {
  createGateEvents,
  gateCentredness,
  rayDistance,
  recordGate,
  stepNearMiss,
} from '@/sim/gate-quality'
import { v3 } from '@/sim/math/vec3'
import {
  bankNearMiss,
  bankProximity,
  createProximity,
  proximityBonus,
  proximityDemand,
  stepProximity,
} from '@/sim/proximity'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import kauai from '../../content/levels/hoverJet_kauai_beg.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import rookie01JumpSeat from '../../content/levels/rookie_01_jumpSeat.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition
const prox = anniversary.gameplay.proximity
const events = anniversary.gameplay.gateEvents

const FIXED_DT = 0.0121999998

describe('G1/G2 — Classic scores exactly what 2016 scored', () => {
  it('every gameplay flag is off, and in the list the all-off test walks', () => {
    for (const key of ['proximity', 'gateEvents', 'chainMeter'] as const) {
      expect(`${key}:${classic.gameplay[key].enabled}`).toBe(`${key}:false`)
    }
    const paths = editionFeatures(classic).map(([p]) => p)
    expect(paths).toContain('gameplay.proximity')
    expect(paths).toContain('gameplay.gateEvents')
    expect(paths).toContain('gameplay.chainMeter')
  })

  it('is zeroed TWICE OVER, so a flipped flag alone still scores 2016', () => {
    // The same posture as `fx.motes` (a pool of none at no alpha) and
    // `fx.gatePulse` (no strength against a flat-zero curve). A preset is a
    // hand-editable file; one flipped boolean must not be able to change what a
    // score means.
    expect(classic.gameplay.proximity.maxBonus, 'no bonus however low you fly').toBe(0)
    const state = createProximity()
    state.level = 1
    expect(proximityBonus(100, state, classic.gameplay.proximity)).toBe(0)
    // And a gate through the mathematical centre is what Classic asks for,
    // which no swept segment reaches.
    expect(classic.gameplay.gateEvents.cleanCentredness).toBe(1)
  })

  it('cannot take points AWAY, whatever a hand-edited preset says', () => {
    // G1 is a reward. A lever that can punish is a different design decision
    // than the one §4.1 argues for, so the floor is in the arithmetic rather
    // than in the schema alone.
    const spiteful = { ...prox, maxBonus: -5 }
    const state = createProximity()
    state.level = 1
    expect(proximityBonus(1000, state, spiteful)).toBe(0)
  })
})

describe('G1 — the ramp', () => {
  it('is FULL on the deck and EMPTY at altitude, not the other way round', () => {
    expect(proximityDemand(0, 200, prox)).toBe(1)
    expect(proximityDemand(prox.nearMetres, 200, prox)).toBe(1)
    expect(proximityDemand(prox.farMetres, 200, prox)).toBe(0)
    expect(proximityDemand(10_000, 200, prox)).toBe(0)
  })

  it('is LINEAR between them, because a player has to be able to predict it', () => {
    const mid = (prox.nearMetres + prox.farMetres) / 2
    expect(proximityDemand(mid, 200, prox)).toBeCloseTo(0.5, 12)
    const quarter = prox.nearMetres + (prox.farMetres - prox.nearMetres) * 0.25
    expect(proximityDemand(quarter, 200, prox)).toBeCloseTo(0.75, 12)
  })

  it('refuses an inverted ramp at load, which is the silent failure', () => {
    const bad = structuredClone(anniversary) as Edition & {
      gameplay: { proximity: { nearMetres: number; farMetres: number } }
    }
    bad.gameplay.proximity.nearMetres = 200
    bad.gameplay.proximity.farMetres = 10
    expect(() => validateEdition(bad)).toThrow(/BELOW farMetres/)
  })

  it('pays nothing for hovering, however low', () => {
    // Without this the optimal play is to stop dead one metre off a hillside.
    expect(proximityDemand(0, prox.minSpeed - 1, prox)).toBe(0)
    expect(proximityDemand(0, prox.minSpeed, prox)).toBe(1)
  })

  it('answers 0 rather than NaN over the open sea, where there is no field', () => {
    expect(proximityDemand(Number.POSITIVE_INFINITY, 200, prox)).toBe(0)
    expect(proximityDemand(Number.NaN, 200, prox)).toBe(0)
  })

  it('rises faster than it falls, and both at the same wall-clock rate', () => {
    // A meter that empties the instant you clear a ridge flickers on every
    // crest. The asymmetry is the decision; that it is FRAME-RATE INDEPENDENT is
    // the property, and it is asserted across a 4x spread of step sizes rather
    // than restated from the exponential.
    expect(prox.releaseSeconds).toBeGreaterThan(prox.attackSeconds)
    // Equal TOTAL time at each rate, not equal loop counts — `t += dt` until
    // `t < seconds` overshoots by up to one step, which at 1/30 is 7 % of a
    // quarter second and is the harness's error rather than the code's. The
    // first version of this test compared 0.267 s of simulation against 0.250 s
    // and called the difference frame dependence.
    const levelAfter = (dt: number, steps: number): number => {
      const s = createProximity()
      for (let i = 0; i < steps; i++) stepProximity(s, 0, 200, prox, dt)
      return s.level
    }
    const coarse = levelAfter(1 / 30, 15) // 0.5 s
    const fine = levelAfter(1 / 144, 72) // 0.5 s
    expect(coarse).toBeCloseTo(fine, 2)
    // One attack constant gets you ~1 - 1/e = 63 % of the way there, which is
    // the defining property of an exponential and not a restatement of the
    // expression in the module (trap 24). A BAND rather than a point, because
    // 0.25 s is not a whole number of 0.0122 s steps — 20 steps is 0.244 s, and
    // a `toBeCloseTo(1 - 1/e, 2)` fails on that 6 ms by a hair. The band is the
    // honest assertion; the tighter one was measuring the fixed step.
    const oneTau = levelAfter(FIXED_DT, Math.round(prox.attackSeconds / FIXED_DT))
    expect(oneTau).toBeGreaterThan(0.6)
    expect(oneTau).toBeLessThan(0.66)
  })

  it('a backgrounded tab cannot slam the meter', () => {
    const s = createProximity()
    stepProximity(s, 0, 200, prox, 600)
    expect(s.level).toBeLessThan(1)
  })
})

describe('G1 — the pool is never medalled, and that IS the balance answer', () => {
  it('int_01’s platinum IS a perfect run, so there was never headroom to tune into', () => {
    // **The measurement that killed the first design.** §5's table gives this
    // row *Risk: balance*, and the first pass answered it with a number — a
    // `maxBonus` small enough that a bonused run could not reach the next medal.
    // The preset's note asserted 0.6 put a perfect low run at "3,360 against
    // 2,100, deliberately below the platinum thresholds", which is false twice:
    // 3,360 is not below 2,100, and platinum is exactly what a clean run scores.
    // No `maxBonus` above zero could have satisfied it. This is that arithmetic,
    // checked, so the claim cannot come back.
    const level = int01 as unknown as {
      routes: { rings: { scoring: { addScore: number } }[] }[]
      scoring: { gateMultiplier: number }
      medals: Record<string, number>
    }
    const rings = level.routes.flatMap((r) => r.rings)
    const basePoints = rings.reduce(
      (n, r) => n + r.scoring.addScore * level.scoring.gateMultiplier,
      0,
    )
    expect(basePoints).toBe(level.medals.platinum as number)
  })

  it('the bonus is real, and lands in its own pool rather than in the score', () => {
    const level = int01 as unknown as {
      routes: { rings: { scoring: { addScore: number } }[] }[]
      scoring: { gateMultiplier: number }
    }
    const rings = level.routes.flatMap((r) => r.rings)
    const state = createProximity()
    state.level = 1
    let banked = 0
    for (const r of rings) {
      banked += bankProximity(state, r.scoring.addScore * level.scoring.gateMultiplier, prox)
    }
    expect(banked).toBe(state.bonus)
    expect(banked).toBeGreaterThan(0)
    // A whole 21-gate run on the deck, at the shipped `maxBonus`.
    expect(banked).toBe(Math.round(21 * 100 * prox.maxBonus))
  })

  it('the MEDAL for a flight is the same with the lever on and off', () => {
    // The invariant that replaced the tuning. `sim/proximity.ts` never touches
    // `state.score` — the thing medals are read from — so a medal keeps meaning
    // exactly what it meant in 2016 on the same flight, to the point, and the
    // risk §5 names is answered by construction. Asserted here as a property of
    // the MODULE's surface: nothing it exports can produce a score.
    const state = createProximity()
    state.level = 1
    bankProximity(state, 10_000, prox)
    expect(state.bonus).toBeGreaterThan(0)
    // Every key this state has. The point is not the list, it is that none of
    // them is a SCORE: `pending` and `unannounced` joined it for DEV-154's line
    // channel and both feed the same pool. If a key ever appears here that the
    // medal could read, this test is the tell.
    expect(Object.keys(state).sort()).toEqual([
      'bonus',
      'clearance',
      'level',
      'pending',
      'unannounced',
    ])
    // `mission-scoring.test.ts`'s medal tests read `state.score`, and there is
    // no path from this pool to it: the only writer is `readScores`, which sums
    // the 2016 scorers. If that ever changes, this comment is the tell.
  })
})

describe('G2 — centredness is measured on the SWEPT SEGMENT', () => {
  it('a dead-centre line reads 1 however the tick boundaries fall', () => {
    // THE TEST THAT SEPARATES THE TWO READINGS. The ship flies straight through
    // the middle of a gate; the sampled positions either side of it are 3.7 m
    // out, which is one tick at 300 m/s. Measured at the tick, this gate is 63 %
    // centred and its score depends on phase. Measured on the segment, it is
    // perfect, which is what the player did.
    const centre = v3(0, 0, 0)
    const from = v3(0, 0, -3.7)
    const to = v3(0, 0, 3.7)
    const radius = 10
    expect(gateCentredness(from, to, centre, radius)).toBeCloseTo(1, 12)
    // The tick-sampled reading, for contrast — this is the number NOT used.
    const atTick = 1 - Math.hypot(to.x, to.y, to.z) / radius
    expect(atTick).toBeLessThan(0.7)
  })

  it('reads 0 at the rim and clamps outside it', () => {
    const centre = v3(0, 0, 0)
    expect(gateCentredness(v3(10, 0, -5), v3(10, 0, 5), centre, 10)).toBeCloseTo(0, 12)
    expect(gateCentredness(v3(50, 0, -5), v3(50, 0, 5), centre, 10)).toBe(0)
  })

  it('measures the FORWARD RAY, because a gate fires at the rim of its sphere', () => {
    // **The bug an autopilot lap found.** `sim/course.ts` fires on a point test
    // against a ~22 m sphere, so the tick it returns on is the tick the ship
    // ENTERS that sphere — at the rim, by construction — and closest approach is
    // several ticks later. Clamped to the swept segment, every gate on `int_01`
    // recorded 0.01-0.09 centred and not one of twenty-one came out clean.
    //
    // This is that geometry: the ship enters a 22 m sphere at the rim, dead on
    // line for the centre. The segment ends there; the ray carries on through.
    const centre = v3(0, 0, 0)
    const from = v3(0, 0, -25)
    const to = v3(0, 0, -21.3) // one tick at 300 m/s, just inside the sphere
    expect(rayDistance(from, to, centre)).toBeCloseTo(0, 6)
    expect(gateCentredness(from, to, centre, 22)).toBeCloseTo(1, 6)
  })

  it('still refuses a gate BEHIND the ship, which is what the clamp is for', () => {
    // The lower clamp survives and does the whole job the upper one was thought
    // to be doing: a gate 100 m astern reports its point distance, not the
    // distance to a line the ship is travelling away from.
    const centre = v3(0, 0, 0)
    const from = v3(0, 0, 100)
    const to = v3(0, 0, 200)
    expect(rayDistance(from, to, centre)).toBeCloseTo(100, 12)
    expect(gateCentredness(from, to, centre, 10)).toBe(0)
  })

  it('a ship at rest gets a point distance rather than a divide by zero', () => {
    const p = v3(3, 4, 0)
    expect(rayDistance(p, p, v3(0, 0, 0))).toBeCloseTo(5, 12)
  })

  it('an unmeasurable gate is not a perfect one', () => {
    expect(gateCentredness(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 0), 0)).toBe(0)
  })
})

describe('G2 — the clean streak', () => {
  it('needs BOTH the line and the speed', () => {
    const s = createGateEvents()
    expect(recordGate(s, 1, events.minSpeed - 1, events)).toBe(false)
    expect(recordGate(s, events.cleanCentredness - 0.01, 300, events)).toBe(false)
    expect(recordGate(s, events.cleanCentredness, events.minSpeed, events)).toBe(true)
  })

  it('RESETS on a scrappy gate rather than decaying', () => {
    // The same shape as 2016's own speed chain — one assignment, no decay — and
    // as DEV-053's accuracy streak. A chain you can half lose is a chain nobody
    // counts.
    const s = createGateEvents()
    for (let i = 0; i < 5; i++) recordGate(s, 1, 300, events)
    expect(s.cleanStreak).toBe(5)
    expect(s.bestCleanStreak).toBe(5)
    recordGate(s, 0, 300, events)
    expect(s.cleanStreak).toBe(0)
    expect(s.bestCleanStreak, 'the best is kept for the results panel').toBe(5)
  })
})

describe('G2 — a near miss is a MISS, and one piece of flying is one event', () => {
  it('does not fire on a tick that struck the ground', () => {
    const s = createGateEvents()
    expect(stepNearMiss(s, 0.5, 300, true, events, FIXED_DT)).toBe(false)
    expect(s.nearMisses).toBe(0)
  })

  it('fires once, then not again until the cooldown', () => {
    // A long low pass down a valley at 82 Hz is four hundred ticks under the
    // threshold. It is one piece of flying.
    const s = createGateEvents()
    let fired = 0
    for (let t = 0; t < 1; t += FIXED_DT) {
      if (stepNearMiss(s, events.nearMissMetres / 2, 300, false, events, FIXED_DT)) fired++
    }
    expect(fired).toBe(1)
    expect(s.nearMisses).toBe(1)
    // Past the cooldown, the next one counts.
    for (let t = 0; t < events.nearMissCooldown + 0.1; t += FIXED_DT) {
      if (stepNearMiss(s, events.nearMissMetres / 2, 300, false, events, FIXED_DT)) fired++
    }
    expect(fired).toBe(2)
  })

  it('a strike RE-ARMS it, because the tick after a scrape is somewhere else', () => {
    const s = createGateEvents()
    expect(stepNearMiss(s, 1, 300, false, events, FIXED_DT)).toBe(true)
    stepNearMiss(s, 1, 300, true, events, FIXED_DT)
    expect(stepNearMiss(s, 1, 300, false, events, FIXED_DT)).toBe(true)
    expect(s.nearMisses).toBe(2)
  })

  it('ignores an unmeasurable clearance', () => {
    const s = createGateEvents()
    expect(stepNearMiss(s, Number.POSITIVE_INFINITY, 300, false, events, FIXED_DT)).toBe(false)
  })

  it('needs SPEED, because points now ride on it (DEV-112)', () => {
    // The anti-hover clause, G2's copy. A ship parked a metre off a cliff would
    // otherwise bank `nearMissPoints` once per cooldown for as long as the clock
    // ran. One definition of "at speed" for both G2 events: the CLEAN gate's.
    const s = createGateEvents()
    expect(stepNearMiss(s, 1, events.minSpeed - 1, false, events, FIXED_DT)).toBe(false)
    expect(s.nearMisses).toBe(0)
    expect(stepNearMiss(s, 1, events.minSpeed, false, events, FIXED_DT)).toBe(true)
    // And a refused tick does not consume the cooldown: the arming clock is
    // only reset on a FIRE, so slowing through the threshold and speeding up
    // again inside the window is one near miss, not zero.
  })
})

describe('DEV-112 — a near miss PAYS, into the pool and never the score', () => {
  it('banks nearMissPoints into G1’s pool, rounded, floored at zero', () => {
    const state = createProximity()
    expect(bankNearMiss(state, events.nearMissPoints)).toBe(events.nearMissPoints)
    expect(state.bonus).toBe(events.nearMissPoints)
    expect(bankNearMiss(state, -40), 'a spiteful preset cannot take points away').toBe(0)
    expect(bankNearMiss(state, 2.4)).toBe(2)
    expect(state.bonus).toBe(events.nearMissPoints + 2)
  })

  it('is zeroed on Classic, TWICE OVER, like every other lever number', () => {
    expect(classic.gameplay.gateEvents.nearMissPoints).toBe(0)
    const state = createProximity()
    expect(bankNearMiss(state, classic.gameplay.gateEvents.nearMissPoints)).toBe(0)
    expect(state.bonus).toBe(0)
    // And the flag is off, so `app.ts` never raises the banner there either —
    // which DEV-110 had left unguarded; Classic's 8 m threshold could show CLOSE.
    expect(classic.gameplay.gateEvents.enabled).toBe(false)
  })

  it('refuses a negative award at load', () => {
    const bad = structuredClone(anniversary) as Edition & {
      gameplay: { gateEvents: { nearMissPoints: number } }
    }
    bad.gameplay.gateEvents.nearMissPoints = -1
    expect(() => validateEdition(bad)).toThrow(/nearMissPoints must not be negative/)
  })

  it('pays at least as well off a wall as off the belly — it is ONE number', () => {
    // Matt: "hugging a wall scores higher". The lever cannot pay a wall LESS
    // than a floor, because `mission.ts` hands both G1 and G2 a single
    // clearance — `sim/surface-proximity.ts`'s `nearest` — and neither can tell
    // which probe produced it. Asserted on the module surface: the near-miss
    // step takes one distance and no direction.
    const wall = createGateEvents()
    const floor = createGateEvents()
    const d = events.nearMissMetres / 2
    expect(stepNearMiss(wall, d, 300, false, events, FIXED_DT)).toBe(
      stepNearMiss(floor, d, 300, false, events, FIXED_DT),
    )
    expect(proximityDemand(d, 300, prox)).toBe(1)
    expect(stepNearMiss.length, 'no axis argument exists to pay one side less').toBe(6)
  })

  it('a whole run through `stepMission` lands the points in the pool and NOT the score', () => {
    // The medal invariant DEV-110 §2 pins, extended to the new channel: the
    // same flight, the lever on and off, one `state.score`. `startMission`
    // needs a level; the smallest 2016 course is fine — no ring is crossed
    // here, so the score is provably 0 either way and the pool is the only
    // thing that can move.
    const level = int01 as unknown as Level
    const on = startMission(level)
    const off = startMission(level)
    // A THIRD run with the line channel shut (DEV-154's `perSecond` 0), which
    // is the DEV-110 preset exactly. It is what separates the near miss's share
    // of the pool from the rate's, rather than re-deriving the rate the way
    // `proximity.ts` does — trap 24.
    const noRate = startMission(level)
    const at = v3(level.spawn.pos[0] as number, 2000, -(level.spawn.pos[2] as number))
    const onLevers = { ...NO_LEVERS, clearance: 1, speed: 300, gateEvents: events, proximity: prox }
    const noRateLevers = { ...onLevers, proximity: { ...prox, perSecond: 0, awardStep: 0 } }
    const SECONDS = 5
    let levelIntegral = 0
    let announced = 0
    let announcements = 0
    for (let i = 0; i < Math.ceil(SECONDS / FIXED_DT); i++) {
      stepMission(on, level, at, FIXED_DT, onLevers)
      stepMission(noRate, level, at, FIXED_DT, noRateLevers)
      stepMission(off, level, at, FIXED_DT)
      levelIntegral += on.proximity.level * FIXED_DT
      if (on.event.lowPoints > 0) {
        announced += on.event.lowPoints
        announcements++
      }
      expect(noRate.event.lowPoints, 'perSecond 0 announces nothing').toBe(0)
    }
    // Five seconds under 8 m at speed, 1.5 s cooldown: 4 near misses (t = 0,
    // 1.5, 3.0, 4.5), each banked. Unchanged by the new channel.
    expect(on.gateEvents.nearMisses).toBe(4)
    expect(noRate.gateEvents.nearMisses).toBe(4)
    expect(noRate.proximity.bonus).toBe(4 * events.nearMissPoints)
    // The line channel is the difference, and it is `perSecond` times the
    // integral of the meter — accumulated HERE, off the state, not recomputed
    // from the recurrence. Within a point, because the pool carries a fraction.
    const line = on.proximity.bonus - noRate.proximity.bonus
    const accrued = prox.perSecond * levelIntegral
    expect(line).toBeLessThanOrEqual(accrued)
    expect(line).toBeGreaterThan(accrued - 1)
    // THE ANNOUNCEMENT IS NOT THE MONEY. What was said out loud is whole
    // `awardStep` chunks of what was banked, never more than it and never more
    // than one step behind — the rest is still in `unannounced` waiting for the
    // next chunk. A banner that could outrun the pool would be the panel and
    // the score disagreeing about what was earned.
    expect(announced % prox.awardStep, 'only whole chunks are said').toBe(0)
    expect(announced).toBe(announcements * prox.awardStep)
    expect(announced).toBeLessThanOrEqual(line)
    expect(line - announced).toBeLessThan(prox.awardStep)
    // Five seconds pinned on the deck is enough to say something at all — an
    // instrument that can go a whole low pass without speaking would be the
    // state display this channel exists to replace.
    expect(announcements).toBeGreaterThan(0)
    // And the pool the panel adds to a score is still an integer.
    expect(Number.isInteger(on.proximity.bonus), 'the pool is a score, so an integer').toBe(true)
    expect(off.proximity.bonus).toBe(0)
    expect(on.score, 'the medal reads this, and it did not move').toBe(off.score)
    expect(on.score).toBe(0)
    expect(medalFor(on, level)).toBe(medalFor(off, level))
    expect(medalFor(noRate, level)).toBe(medalFor(off, level))
  })
})

describe('DEV-154 — the LINE channel: the meter pays while you fly it', () => {
  // Matt, 2026-09-16, having flown G1/G2: *"i've yet to see scoring influenced
  // by flying near objects/terrain. maybe ui would help similar to the new gate
  // score bonus ui"*.
  //
  // The lever was paying, at gates, into a pool — 21 instants in an 8,174-tick
  // lap, on gates 17.8-336.5 m above the surface. `surface-proximity.test.ts`
  // holds the measurement; this file holds the arithmetic.

  /**
   * 5 s of flying at a fixed clearance, on a level whose mode is given.
   *
   * The NEAR MISS is switched off (`nearMissPoints` 0) so that `proximity.bonus`
   * here is the line channel and nothing else. Both fill the same pool by
   * design (DEV-112), and a test of one channel that reads a pool two of them
   * feed has measured neither.
   */
  const fly = (
    level: Level,
    clearance: number,
    spec: typeof prox,
    seconds = 5,
  ): { mission: ReturnType<typeof startMission>; announced: number; announcements: number } => {
    const mission = startMission(level)
    // FAR from anything scoreable: the pool must be the only thing that moves,
    // so a pad or an orb cannot be what a rising number came from.
    const at = v3(0, 20_000, 0)
    const levers = {
      ...NO_LEVERS,
      clearance,
      speed: 300,
      gateEvents: { ...events, nearMissPoints: 0 },
      proximity: spec,
    }
    let announced = 0
    let announcements = 0
    for (let i = 0; i < Math.ceil(seconds / FIXED_DT); i++) {
      stepMission(mission, level, at, FIXED_DT, levers)
      if (mission.event.lowPoints > 0) {
        announced += mission.event.lowPoints
        announcements++
      }
    }
    return { mission, announced, announcements }
  }

  it('pays on a mission with NO RINGS, which is six of the thirteen', () => {
    // THE HEADLINE. DEV-110 §6: *"G1 currently banks only on rings, so on those
    // missions the meter fills and pays nothing."* Target Practice scores pad
    // plates and Free Flight scores orbs; neither ever calls `bankProximity`.
    // The rate does not need a gate, so it closes that gap for the pool's main
    // channel rather than only for the near miss DEV-112 added.
    const pads = rookie01JumpSeat as unknown as Level
    const orbs = kauai as unknown as Level
    expect(pads.mode).toBe('targetPractice')
    expect(orbs.forcedMode).toBe('freeFlight')
    for (const level of [pads, orbs]) {
      const deck = fly(level, 0, prox)
      const high = fly(level, prox.farMetres * 2, prox)
      // Not one ring was taken on either — there are none to take.
      expect(deck.mission.ringsPassed).toBe(0)
      expect(deck.mission.score, 'the 2016 scorers never moved').toBe(0)
      // And the pool did. This is the sentence DEV-110 §6 could not say.
      expect(deck.mission.proximity.bonus).toBeGreaterThan(0)
      expect(deck.announcements).toBeGreaterThan(0)
      // At altitude it pays nothing, so it is the LEVER paying and not the clock.
      expect(high.mission.proximity.bonus).toBe(0)
      expect(high.announcements).toBe(0)
      // The medal is untouched either way — it reads `state.score`.
      expect(medalFor(deck.mission, level)).toBe(medalFor(high.mission, level))
    }
  })

  it('`perSecond` 0 is the DEV-110 build, to the point', () => {
    // The clean A/B dial, the way `maxBonus` 0 is. A preset is a hand-editable
    // file and one number must be able to take the whole channel back out.
    const level = rookie01JumpSeat as unknown as Level
    const off = fly(level, 0, { ...prox, perSecond: 0 })
    expect(off.mission.proximity.bonus).toBe(0)
    expect(off.announced).toBe(0)
    // Classic is that preset, twice over: the flag, and both numbers.
    expect(classic.gameplay.proximity.perSecond).toBe(0)
    expect(classic.gameplay.proximity.awardStep).toBe(0)
    const classicRun = fly(level, 0, classic.gameplay.proximity)
    expect(classicRun.mission.proximity.bonus).toBe(0)
  })

  it('pays at the METER, so half as low is half as much', () => {
    // The ramp is linear and the money rides it — otherwise the bar under GATES
    // is telling the player something the score does not honour. Measured as a
    // RATIO between two flights, which is true whatever `perSecond` is set to.
    const level = rookie01JumpSeat as unknown as Level
    const mid = (prox.nearMetres + prox.farMetres) / 2
    const full = fly(level, prox.nearMetres, prox, 20).mission.proximity.bonus
    const half = fly(level, mid, prox, 20).mission.proximity.bonus
    expect(half / full).toBeCloseTo(0.5, 1)
    // And the anti-hover clause covers this channel too, with no second number:
    // the demand is already 0 below `minSpeed` and the rate rides the demand.
    const parked = startMission(level)
    for (let i = 0; i < 400; i++) {
      stepMission(parked, level, v3(0, 20_000, 0), FIXED_DT, {
        ...NO_LEVERS,
        clearance: 0,
        speed: prox.minSpeed - 1,
        gateEvents: { ...events, nearMissPoints: 0 },
        proximity: prox,
      })
    }
    expect(parked.proximity.bonus, 'a metre off a cliff at a standstill earns nothing').toBe(0)
  })

  it('announces in whole chunks and never more than it banked', () => {
    const level = rookie01JumpSeat as unknown as Level
    const run = fly(level, 0, prox, 30)
    const banked = run.mission.proximity.bonus
    expect(run.announced % prox.awardStep).toBe(0)
    expect(run.announced).toBeLessThanOrEqual(banked)
    expect(banked - run.announced).toBeLessThan(prox.awardStep)
    // The CADENCE is the meter: pinned on the deck, one chunk every
    // `awardStep / perSecond` seconds. Asserted as the count over a known
    // window, not as the interval — the first and last are clipped by the ends.
    expect(run.announcements).toBeGreaterThanOrEqual(
      Math.floor((30 * prox.perSecond) / prox.awardStep) - 1,
    )
  })

  it('a SECOND mission stepped after the first does not inherit its cadence', () => {
    // Trap 19 / DEV-032: the carry and the watermark are per-`ProximityState`,
    // not module scratch. Two missions, one of them flown high, and the high one
    // must have banked and announced nothing whatever the other did.
    const level = rookie01JumpSeat as unknown as Level
    const low = startMission(level)
    const high = startMission(level)
    const noMiss = { ...events, nearMissPoints: 0 }
    const at = v3(0, 20_000, 0)
    let highSaidSomething = false
    for (let i = 0; i < 2000; i++) {
      const shared = { ...NO_LEVERS, speed: 300, gateEvents: noMiss, proximity: prox }
      stepMission(low, level, at, FIXED_DT, { ...shared, clearance: 0 })
      stepMission(high, level, at, FIXED_DT, { ...shared, clearance: prox.farMetres * 2 })
      if (high.event.lowPoints > 0) highSaidSomething = true
    }
    expect(low.proximity.bonus).toBeGreaterThan(0)
    expect(high.proximity.bonus).toBe(0)
    expect(high.proximity.pending).toBe(0)
    expect(high.proximity.unannounced).toBe(0)
    expect(highSaidSomething).toBe(false)
  })

  it('a negative rate or step is refused at load, not floored in silence', () => {
    for (const key of ['perSecond', 'awardStep'] as const) {
      const bad = structuredClone(anniversary) as Edition
      ;(bad.gameplay.proximity as unknown as Record<string, number>)[key] = -1
      expect(() => validateEdition(bad)).toThrow(new RegExp(`${key} must not be negative`))
    }
  })
})
