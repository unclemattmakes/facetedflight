// tests/unit/pad-streak.test.ts — Target Practice's accuracy streak.
//
// **This is the one place in the port where inventing was the instruction.**
// Matt, this session: *"target practice - yeah, this went in late and wasn't
// ever really satisfied with how it shipped. come up with a arcade-feeling
// scoring method and let's use that."* There is no 2016 behaviour to diff
// against — `ScoreKeeper_JumpPads.cs:84` is `jumpPadScore += val_score` and no
// medal was ever awarded — so every assertion here is about FF2's own rule.
//
// ── What these tests pin, and what they deliberately do not ──────────────
//
// The tier LADDER is pinned as behaviour: *a bullseye makes the next plate worth
// more, a mid plate leaves it alone, an outer plate puts it back where it
// started.* Those three sentences are true for any cap above 1 and any point
// values, so they survive the three knobs in `game/targets.ts` being moved —
// which is the point. `expect(score).toBe(300)` would be the arithmetic, and
// arithmetic is what a knob is allowed to change.
//
// Two things ARE pinned as numbers, because they are the design and not an
// implementation: the first bullseye of a run is worth exactly its face value
// (which settles "the multiplier BEFORE, not after"), and the six missions'
// ceilings and medal thresholds (which is what Matt is being asked to sign off).
// Both are computed from the shipped rule rather than typed twice —
// `arcadePadCeiling` and a flown run have to agree.
//
// ── Trap 19 ──────────────────────────────────────────────────────────────
//
// A multiplier is EXACTLY the kind of state DEV-032 rode in on: one number, read
// every step, meaningless on its own, and catastrophic if two runs share it. A
// second pad set carrying the first one's x4 would be invisible to every
// single-object test in this file, so the last describe block steps a SECOND one
// — at both layers, `TargetsState` and `MissionState` — and asserts the first
// did not move.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import {
  type MissionState,
  medalFor,
  medalInput,
  medalThresholds,
  padBanner,
  startMission,
  stepMission,
  streakMultiplier,
} from '@/game/mission'
import { rulesFor, runningMode, TARGET_PRACTICE_MEDAL_RULE } from '@/game/modes'
import {
  arcadePadCeiling,
  finishPadAirspace,
  livePads,
  maxPadScore,
  PAD_LATCH,
  padStreakRules,
  padZones,
} from '@/game/targets'
import { type HudState, hudSignature } from '@/render/hud'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createTargets, stepTargets, streakCeiling, type TargetZone } from '@/sim/targets'
import { levelJson as level } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'

/** The six missions that carry pads, in ascending pad count. */
const PAD_MISSIONS = [
  'rookie_01_jumpSeat',
  'int_01_jumpSeat',
  'rookie_02_jumpSeat',
  'int_02_jumpSeat',
  'adv_01_jumpSeat',
  'adv_02_jumpSeat',
] as const

/**
 * The missions a Target Practice run can actually be FLOWN on.
 *
 * It used to exclude `int_02_jumpSeat`: 2016 forces that scene into Free Flight,
 * so `startMission` could never run it in Target Practice however it was asked,
 * and its ceiling and curve were real but untestable through the scorer. DEV-061
 * dropped that forcing and all six are flyable now.
 *
 * **Asked of `runningMode`, not of `forcedMode`.** The 2016 forcing is still in
 * the JSON and still says `freeFlight`; a filter on it would keep excluding the
 * mission while every test stayed green, which is a test asserting the record
 * instead of the rule.
 */
const FLYABLE = PAD_MISSIONS.filter((id) => runningMode(level(id)) === 'targetPractice')

const RULES = padStreakRules()

// ── Segment helpers, in each zone's OWN frame ─────────────────────────────
//
// "Half a box along its own x axis" is inside that box whatever its orientation,
// so nothing here depends on a quaternion being what anyone believed. CLAUDE.md's
// orientation lesson, applied to a test rather than to a mesh.

const at = (zone: TargetZone, a: number, b: number, c: number): Vec3 => {
  const [u, v, w] = zone.axes
  return v3(
    zone.centre.x + u.x * a + v.x * b + w.x * c,
    zone.centre.y + u.y * a + v.y * b + w.y * c,
    zone.centre.z + u.z * a + v.z * b + w.z * c,
  )
}

type Tier = 'bullseye' | 'mid' | 'large'
const FACE: Record<Tier, number> = { bullseye: 100, mid: 50, large: 25 }

const zoneOn = (zones: readonly TargetZone[], pad: number, tier: Tier): TargetZone => {
  const found = zones.find((z) => z.pad === pad && z.points === FACE[tier])
  if (!found) throw new Error(`no ${tier} on pad ${pad}`)
  return found
}

/**
 * A flight path that crosses exactly one tier of one pad, and starts OUTSIDE it.
 *
 * The bullseye gets a descent straight down the pad's axis, where no annulus
 * reaches — the mid ring starts at 7.27 m, so nothing else is on that line at any
 * speed. The two annulus tiers get a pass along the plate's own length, which
 * stays in that plate's own height band: the three bands are vertically disjoint
 * (bullseye −4.30..−1.69, mid −1.22..+0.16, outer +0.68..+1.17 pad-local), so a
 * pass at one tier's height cannot take another's. A DESCENT through an outer
 * plate would, because the mid band sits under it and `stepTargets` awards the
 * highest-value plate in the segment — a 25 test that quietly measured a 50.
 *
 * Starting 2 % outside the box rather than inside it matters for the
 * `stepMission` paths: the first step of a run sweeps from where it is to where
 * it is, so a path that begins inside a plate scores on step one and leaves the
 * step under test with nothing to find.
 */
const segment = (zone: TargetZone, tier: Tier): [Vec3, Vec3] =>
  tier === 'bullseye'
    ? [at(zone, 0, 30, 0), at(zone, 0, -30, 0)]
    : [at(zone, -zone.half.x * 1.02, 0, 0), at(zone, zone.half.x * 0.9, 0, 0)]

/** Cross one plate, at the sim layer. */
const cross = (state: ReturnType<typeof createTargets>, pad: number, tier: Tier): number => {
  const [from, to] = segment(zoneOn(state.zones, pad, tier), tier)
  return stepTargets(state, from, to)
}

/** Play a whole run as a list of tiers, one per pad, in pad order. */
const playRun = (L: Level, tiers: readonly Tier[]) => {
  const state = createTargets(padZones(L), livePads(L).length, RULES)
  tiers.forEach((tier, pad) => {
    cross(state, pad, tier)
  })
  return state
}

/** `['bullseye','bullseye','mid', …]` — a cycle stretched to `n` pads. */
const cycle = (pattern: readonly Tier[], n: number): Tier[] =>
  Array.from({ length: n }, (_, i) => pattern[i % pattern.length] as Tier)

describe('the tier ladder — stated as behaviour, not as arithmetic', () => {
  // Every assertion below compares one payout to another, so it stays true when
  // STREAK_CAP, PERFECT_CLEAR_PER_PAD or MID_HOLDS move. That is the difference
  // between pinning a design and pinning a number.
  const L = level('adv_02_jumpSeat')
  const ZONES = padZones(L)
  const PADS = livePads(L).length
  const fresh = () => createTargets(ZONES, PADS, RULES)

  /**
   * What pad `pad` was worth, taken on `tier` — **the PLATE only.**
   *
   * The perfect-clear bonus is netted out, because it lands on the same step as
   * the last pad's plate and is not a property of the ladder. Without this the
   * "the cap holds" assertion below reads 1,700 on the twelfth pad of
   * `adv_02_jumpSeat` and looks like a cap that does not bite.
   */
  const worth = (state: ReturnType<typeof createTargets>, pad: number, tier: Tier): number => {
    const before = state.score
    const bonusBefore = state.clearBonus
    cross(state, pad, tier)
    return state.score - before - (state.clearBonus - bonusBefore)
  }

  it('makes the NEXT plate worth more after a bullseye', () => {
    const state = fresh()
    const first = worth(state, 0, 'bullseye')
    const second = worth(state, 1, 'bullseye')
    expect(second).toBeGreaterThan(first)
  })

  it('leaves the next plate worth the same after a mid plate', () => {
    // The MID_HOLDS knob. If it is flipped to 'decay' this expectation flips with
    // it, which is why the knob is read here rather than the outcome assumed.
    const state = fresh()
    worth(state, 0, 'bullseye') // get the multiplier off 1 so a hold is visible
    const a = worth(state, 1, 'mid')
    const b = worth(state, 2, 'mid')
    expect(b).toBe(a)
  })

  it('puts the next plate back to square one after an outer plate', () => {
    const state = fresh()
    const opening = worth(state, 0, 'bullseye')
    worth(state, 1, 'bullseye')
    worth(state, 2, 'bullseye')
    expect(streakMultiplier({ targets: state } as MissionState)).toBeGreaterThan(1)
    worth(state, 3, 'large')
    expect(streakMultiplier({ targets: state } as MissionState)).toBe(1)
    // A bullseye after a graze is worth exactly what the run's first one was.
    expect(worth(state, 4, 'bullseye')).toBe(opening)
  })

  it('pays a graze at the multiplier it is about to destroy, not at 1', () => {
    // The order of operations, from the losing side: you keep what the plate was
    // worth when you crossed it. A rule that reset first would make an outer
    // plate worth 25 flat and turn a late graze into a non-event.
    const state = fresh()
    worth(state, 0, 'bullseye')
    worth(state, 1, 'bullseye')
    const before = state.multiplier
    expect(before).toBeGreaterThan(1)
    expect(worth(state, 2, 'large')).toBe(FACE.large * before)
  })

  it('caps the multiplier, and holds it there for the rest of the run', () => {
    const state = fresh()
    const each: number[] = []
    for (let pad = 0; pad < PADS; pad++) each.push(worth(state, pad, 'bullseye'))
    expect(state.multiplier).toBe(RULES.cap)
    // Strictly rising while it builds, then flat. Both halves matter: a cap that
    // never bites leaves the last pad worth more than the first five together.
    for (let i = 1; i < RULES.cap; i++) {
      expect(each[i], `pad ${i}`).toBeGreaterThan(each[i - 1] as number)
    }
    for (let i = RULES.cap; i < each.length; i++) {
      expect(each[i], `pad ${i}`).toBe(each[RULES.cap - 1] as number)
    }
    // …and the cap is reached on the pad the knob's comment says it is.
    expect(PADS).toBeGreaterThanOrEqual(RULES.cap)
  })
})

describe('the multiplier applies BEFORE the bullseye raises it', () => {
  // The one piece of arithmetic pinned literally, because it IS the decision:
  // the panel shows the multiplier a plate is about to be paid at, so the first
  // bullseye of a run must be worth its face value and not double it.
  const L = level('adv_02_jumpSeat')

  it('pays 100, then 200, then 300 for the first three bullseyes', () => {
    const state = createTargets(padZones(L), livePads(L).length, RULES)
    const paid: number[] = []
    for (const pad of [0, 1, 2]) {
      const before = state.score
      cross(state, pad, 'bullseye')
      paid.push(state.score - before)
    }
    expect(paid).toEqual([100, 200, 300])
  })

  it('shows the multiplier that the next plate will actually be paid at', () => {
    const state = createTargets(padZones(L), livePads(L).length, RULES)
    for (const pad of [0, 1, 2, 3]) {
      const shown = state.multiplier
      const before = state.score
      cross(state, pad, 'bullseye')
      // What the HUD was showing is what the plate paid. If this ever fails the
      // panel is lying, which is the whole reason the order was chosen.
      expect(state.score - before, `pad ${pad}`).toBe(FACE.bullseye * shown)
    }
  })
})

describe('the perfect-clear bonus', () => {
  const L = level('int_01_jumpSeat')
  const PADS = livePads(L).length

  it('fires once, on the last pad, and is worth the same per pad everywhere', () => {
    const state = playRun(L, cycle(['bullseye'], PADS))
    expect(state.cleared).toBe(true)
    expect(state.clearBonus).toBe(RULES.clearBonusPerPad * PADS)
  })

  it('does not fire while a pad is still untaken', () => {
    const state = createTargets(padZones(L), PADS, RULES)
    for (let pad = 0; pad < PADS - 1; pad++) cross(state, pad, 'bullseye')
    expect(state.cleared).toBe(false)
    expect(state.clearBonus).toBe(0)
  })

  it('pays for COMPLETION, not accuracy — a grazed clear still earns it', () => {
    // The two axes are deliberately separate. A player who takes every pad badly
    // gets the clear and no streak; a player who bullseyes half the board and
    // leaves gets the streak and no clear.
    const grazed = playRun(L, cycle(['large'], PADS))
    expect(grazed.clearBonus).toBe(RULES.clearBonusPerPad * PADS)
    expect(grazed.multiplier).toBe(1)
  })

  it('cannot pay twice, however many times the board is re-crossed', () => {
    const state = playRun(L, cycle(['bullseye'], PADS))
    const after = state.score
    for (let pad = 0; pad < PADS; pad++) cross(state, pad, 'bullseye')
    expect(state.score).toBe(after)
    expect(state.clearBonus).toBe(RULES.clearBonusPerPad * PADS)
  })
})

describe('the ceilings, and the medal curve derived from them', () => {
  // The table Matt is signing off. Computed by `arcadePadCeiling` from the three
  // knobs, reproduced here so that a knob moving fails CI loudly instead of
  // quietly re-scaling six missions' medals.
  const CEILINGS: Record<string, number> = {
    rookie_01_jumpSeat: 2000,
    int_01_jumpSeat: 2600,
    rookie_02_jumpSeat: 3200,
    int_02_jumpSeat: 4400,
    adv_01_jumpSeat: 5000,
    adv_02_jumpSeat: 6200,
  }

  it('ships the rule Matt asked for, on a points scale', () => {
    expect(TARGET_PRACTICE_MEDAL_RULE).toBe('padStreak')
    expect(rulesFor('targetPractice').medalScale).toBe('points')
  })

  it('matches the reported ceiling on all six missions', () => {
    for (const id of PAD_MISSIONS) {
      expect(arcadePadCeiling(level(id)), id).toBe(CEILINGS[id])
    }
  })

  it('is worth several times 2016 s flat ceiling, which is the point', () => {
    // Not a target, an observation: the streak is why the three tiers matter.
    // Flat, `adv_02_jumpSeat` tops out at 1200 and cannot reach a bronze of 1600.
    for (const id of PAD_MISSIONS) {
      const L = level(id)
      expect(arcadePadCeiling(L), id).toBeGreaterThan(maxPadScore(L))
    }
    expect(maxPadScore(level('adv_02_jumpSeat'))).toBe(1200)
  })

  it('bands at 40 / 60 / 80 / 100 % with platinum AT the ceiling', () => {
    for (const id of PAD_MISSIONS) {
      const L = level(id)
      const ceiling = arcadePadCeiling(L)
      const curve = medalThresholds(L, 'targetPractice')
      if (!curve) throw new Error(`${id}: expected a curve`)
      expect(curve.platinum, id).toBe(ceiling)
      expect(curve.gold, id).toBe(Math.round(ceiling * 0.8))
      expect(curve.silver, id).toBe(Math.round(ceiling * 0.6))
      expect(curve.bronze, id).toBe(Math.round(ceiling * 0.4))
    }
  })

  it('keeps the streakCeiling construction exact — every pad s best plate raises', () => {
    // `streakCeiling` is only the true optimum when the highest-value plate on a
    // pad is also the one that raises the multiplier. That is true of all 57
    // shipped pad instances, because they are all the same prefab — and this is
    // the assertion that keeps the "exact" claim checked rather than assumed.
    for (const id of PAD_MISSIONS) {
      const L = level(id)
      const zones = padZones(L)
      for (let pad = 0; pad < livePads(L).length; pad++) {
        const mine = zones.filter((z) => z.pad === pad)
        const best = Math.max(...mine.map((z) => z.points))
        for (const z of mine.filter((z) => z.points === best)) {
          expect(z.streak, `${id} pad ${pad}`).toBe('raise')
        }
      }
    }
  })

  it('reports what a REALISTIC run scores, not just a perfect one', () => {
    // Three runs per mission, each taking EVERY pad — so the clear bonus is in
    // all three and the only variable is accuracy. These are the tuning
    // evidence, and the whole table is compared in one go so that a knob moving
    // prints all six missions rather than stopping at the first.
    //
    //   good    two bullseyes in three, the rest on a mid plate
    //   steady  a bullseye then two mids, round and round — NEVER grazes
    //   mixed   one of each, round and round — breaks the streak every third pad
    //   grazed  every pad on the outer ring: the clear bonus and nothing else
    const GOOD = {
      rookie_01_jumpSeat: 1650,
      int_01_jumpSeat: 2000,
      rookie_02_jumpSeat: 2600,
      int_02_jumpSeat: 3550,
      adv_01_jumpSeat: 4150,
      adv_02_jumpSeat: 5100,
    }
    const STEADY = {
      rookie_01_jumpSeat: 1150,
      int_01_jumpSeat: 1400,
      rookie_02_jumpSeat: 1800,
      int_02_jumpSeat: 2400,
      adv_01_jumpSeat: 2900,
      adv_02_jumpSeat: 3600,
    }
    const MIXED = {
      rookie_01_jumpSeat: 950,
      int_01_jumpSeat: 1100,
      rookie_02_jumpSeat: 1300,
      int_02_jumpSeat: 1650,
      adv_01_jumpSeat: 1850,
      adv_02_jumpSeat: 2200,
    }
    const score = (id: string, pattern: readonly Tier[]): number => {
      const L = level(id)
      return playRun(L, cycle(pattern, livePads(L).length)).score
    }
    const table = (pattern: readonly Tier[]): Record<string, number> =>
      Object.fromEntries(PAD_MISSIONS.map((id) => [id, score(id, pattern)]))

    expect(table(['bullseye', 'bullseye', 'mid'])).toEqual(GOOD)
    expect(table(['bullseye', 'mid', 'mid'])).toEqual(STEADY)
    expect(table(['bullseye', 'mid', 'large'])).toEqual(MIXED)

    for (const id of PAD_MISSIONS) {
      const L = level(id)
      const pads = livePads(L).length
      const curve = medalThresholds(L, 'targetPractice')
      if (!curve) throw new Error(`${id}: expected a curve`)

      // A strong run is silver-to-gold and never platinum: platinum is perfect.
      expect(GOOD[id], `${id} good >= silver`).toBeGreaterThanOrEqual(curve.silver)
      expect(GOOD[id], `${id} good < platinum`).toBeLessThan(curve.platinum)

      // **The design promise: never graze the outer ring and you get a medal.**
      // It is the one guarantee worth making to a player who is flying tidily
      // but not brilliantly, and it holds on all six.
      expect(STEADY[id], `${id} steady >= bronze`).toBeGreaterThanOrEqual(curve.bronze)
      expect(STEADY[id], `${id} steady < gold`).toBeLessThan(curve.gold)

      // The untidy run is worse than the tidy one on every mission, and on the
      // LONGER boards it drops under bronze — 0.48 of the ceiling on
      // `rookie_01_jumpSeat` down to 0.35 on `adv_02_jumpSeat`. That is the
      // streak compounding rather than a threshold being unfair: breaking it
      // every third pad costs more on a board with more pads to build on. It is
      // the strongest argument for the cap staying where it is.
      expect(MIXED[id], `${id} mixed < steady`).toBeLessThan(STEADY[id])
      expect(MIXED[id] / curve.platinum, `${id} mixed fraction`).toBeGreaterThan(0.34)
      expect(MIXED[id] / curve.platinum, `${id} mixed fraction`).toBeLessThan(0.5)

      // Grazing the whole board is the clear bonus plus 25 a pad, at x1 through-
      // out, and it is below bronze. Bad shooting scores badly; that is the mode.
      const grazed = playRun(L, cycle(['large'], pads))
      expect(grazed.score, `${id} grazed`).toBe((RULES.clearBonusPerPad + 25) * pads)
      expect(grazed.score, `${id} grazed < bronze`).toBeLessThan(curve.bronze)
      expect(grazed.score, `${id} grazed < mixed`).toBeLessThan(MIXED[id])
    }
  })

  it('makes taking the LAST pad worth it even on a graze', () => {
    // The design claim the clear bonus is actually for, and it is not the one I
    // first wrote down: a flawless five-pad run DOES beat an untidy six-pad one
    // (1500 against 1100 on `int_01_jumpSeat`), because this is an accuracy mode
    // and five clean approaches are better flying than six scruffy ones.
    //
    // What the bonus has to guarantee is narrower and more useful: **whatever you
    // have done so far, the next pad is worth taking** — there is never a run
    // where stopping short scores better. The finish pad ends the run, so
    // "incomplete" is a real choice a player can make by accident; this is what
    // stops it from ever being the right one.
    for (const id of FLYABLE) {
      const L = level(id)
      const pads = livePads(L).length
      const perfectButShort = playRun(L, cycle(['bullseye'], pads - 1))
      const sameThenGrazed = playRun(L, [...cycle(['bullseye'], pads - 1), 'large'])
      expect(perfectButShort.cleared, id).toBe(false)
      expect(sameThenGrazed.cleared, id).toBe(true)
      expect(sameThenGrazed.score, id).toBeGreaterThan(perfectButShort.score)
    }
  })
})

// ── The whole thing, flown ────────────────────────────────────────────────

/** Fly a straight line at `speed`, stepping the mission at the fixed timestep. */
const flyTo = (state: MissionState, L: Level, from: Vec3, to: Vec3, speed: number): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (speed * FIXED_DT)))
  const at = v3(from.x, from.y, from.z)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    stepMission(state, L, at, FIXED_DT)
  }
  return v3(at.x, at.y, at.z)
}

/**
 * Straight down a pad's axis and out the bottom of its airspace.
 *
 * The bullseye is the only tier on the axis — the mid annulus starts at 7.27 m —
 * so this cannot accidentally take an outer plate on the way down and close the
 * pad for 25.
 */
const descend = (state: MissionState, L: Level, pad: number, from: Vec3): Vec3 => {
  const eye = zoneOn(padZones(L), pad, 'bullseye')
  const top = v3(eye.centre.x, eye.centre.y + 80, eye.centre.z)
  flyTo(state, L, from, top, 300)
  return flyTo(state, L, top, v3(eye.centre.x, eye.centre.y - 40, eye.centre.z), 40)
}

describe('a perfect run, flown through stepMission', () => {
  it('covers all six pad missions since DEV-061', () => {
    // Named, because "every flyable mission" below is only as strong as the set:
    // it was five of six while `int_02_jumpSeat` was locked into Free Flight, and
    // a filter that quietly dropped a mission would hide exactly the case the
    // next test exists to prove. `forced-mode.test.ts` carries the decision.
    expect([...FLYABLE].sort()).toEqual([...PAD_MISSIONS].sort())
  })

  it('reaches the ceiling exactly, and earns platinum, on every flyable mission', () => {
    for (const id of FLYABLE) {
      const L = level(id)
      const air = finishPadAirspace(L)
      if (!air) throw new Error(`${id}: expected a finish pad`)
      const pads = livePads(L).length
      const state = startMission(L)

      // The finish pad LAST: crossing it ends the run.
      let at = v3(0, 3000, 0)
      for (let pad = 0; pad < pads; pad++) {
        if (pad === air.pad) continue
        at = descend(state, L, pad, at)
        expect(state.finished, `${id}: pad ${pad} must not end the run`).toBe(false)
      }
      at = descend(state, L, air.pad, at)

      expect(state.finished, id).toBe(true)
      expect(state.counted, id).toBe(pads)
      // The flown score and the derived ceiling have to agree. This is the join
      // between `streakCeiling` (which sets platinum) and `stepTargets` (which
      // pays it): a ceiling nobody can reach is `rookie_01_hoverJet`'s
      // unreachable platinum again, and that one is a deviation row.
      expect(state.score, id).toBe(arcadePadCeiling(L))
      expect(medalInput(state), id).toBe(state.score)
      expect(medalFor(state, L), id).toBe('platinum')
    }
  })

  it('never adds a time bonus, however fast the run was', () => {
    // `scoring.timeAffectsMedal` is TRUE on all six and the par is 180 s, so a
    // points-scaled mode with no explicit gate would hand a 30 s run ~1,700
    // points — more than the streak ceiling on three of the six. The mode
    // descriptor's `timeBonus: false` is what stops it, and this is the
    // observable: an accuracy streak, not a stopwatch.
    const L = level('int_01_jumpSeat')
    expect(L.scoring.timeAffectsMedal).toBe(true)
    expect(rulesFor('targetPractice').timeBonus).toBe(false)
    const air = finishPadAirspace(L)
    if (!air) throw new Error('expected a finish pad')
    const state = startMission(L)
    let at = v3(0, 3000, 0)
    for (let pad = 0; pad < livePads(L).length; pad++) {
      if (pad === air.pad) continue
      at = descend(state, L, pad, at)
    }
    descend(state, L, air.pad, at)
    expect(state.finished).toBe(true)
    expect(state.elapsed).toBeLessThan(L.timer.bonusParTime)
    expect(state.timeBonus).toBe(0)
    expect(state.score).toBe(arcadePadCeiling(L))
  })

  it('raises the multiplier on the way, and the HUD can see it', () => {
    const L = level('int_01_jumpSeat')
    const air = finishPadAirspace(L)
    if (!air) throw new Error('expected a finish pad')
    const state = startMission(L)
    expect(streakMultiplier(state)).toBe(1)
    let at = v3(0, 3000, 0)
    const seen: number[] = []
    for (let pad = 0; pad < livePads(L).length; pad++) {
      if (pad === air.pad) continue
      at = descend(state, L, pad, at)
      seen.push(streakMultiplier(state))
    }
    expect(seen).toEqual([2, 3, 4, 5, 5])
  })
})

describe('the streak is VISIBLE — a bullseye does not read like a graze', () => {
  const L = level('adv_02_jumpSeat')
  const air = finishPadAirspace(L)
  const pads = livePads(L).length

  /** Every pad but the one that ENDS the run, so the banners are all mid-run. */
  const openPads = Array.from({ length: pads }, (_, i) => i).filter((p) => p !== air?.pad)

  /**
   * Fly a sequence of plates and hand back the banner the LAST scoring step
   * raised.
   *
   * "The last scoring step", not "the last step": the eight wedges of a tier tile
   * an annulus, so a path that starts a hair outside one wedge starts INSIDE its
   * neighbour, and the plate is then taken on the entry step rather than the
   * crossing step. Same tier, same points, same banner — but a test that read the
   * event one step later saw an empty one and reported "no banner", which is a
   * harness bug wearing a product bug's clothes (CLAUDE.md: when a bug will not
   * reproduce, suspect the harness).
   */
  const bannerFor = (tiers: readonly Tier[]) => {
    const state = startMission(L)
    let last = null as ReturnType<typeof padBanner>
    const step = (p: Vec3) => {
      stepMission(state, L, p, FIXED_DT)
      const banner = padBanner(state.event, pads)
      if (banner) last = banner
    }
    tiers.forEach((tier, i) => {
      const [from, to] = segment(zoneOn(state.targets.zones, openPads[i] as number, tier), tier)
      step(from)
      step(to)
    })
    return last
  }

  it('names a bullseye and shows what it actually banked', () => {
    const banner = bannerFor(['bullseye', 'bullseye', 'bullseye'])
    expect(banner?.text).toBe('BULLSEYE +300')
    expect(banner?.tone).toBe('gain')
  })

  it('says STREAK LOST, in a different tone, when a graze breaks a run', () => {
    const banner = bannerFor(['bullseye', 'bullseye', 'large'])
    expect(banner?.text).toContain('STREAK LOST')
    expect(banner?.tone).toBe('loss')
  })

  it('does not dress up a graze that cost nothing', () => {
    // Breaking a x1 is not a loss, and a panel that said so would be crying wolf
    // on the first pad of every run.
    const banner = bannerFor(['large'])
    expect(banner?.text).toBe('+25')
    expect(banner?.tone).toBe('gain')
  })

  it('lets the perfect clear take the line from the plate that completed it', () => {
    // Every open pad but not yet the finish pad: the board is incomplete, so the
    // banner is still an ordinary bullseye.
    expect(bannerFor(cycle(['bullseye'], openPads.length))?.text).not.toContain('ALL')

    const state = startMission(L)
    let done = null as ReturnType<typeof padBanner>
    for (const pad of [...openPads, air?.pad as number]) {
      const [from, to] = segment(zoneOn(state.targets.zones, pad, 'bullseye'), 'bullseye')
      stepMission(state, L, from, FIXED_DT)
      stepMission(state, L, to, FIXED_DT)
      if (state.event.padClearBonus > 0) done = padBanner(state.event, pads)
    }
    expect(done?.text).toBe(`ALL ${pads} PADS +${RULES.clearBonusPerPad * pads}`)
    expect(done?.tone).toBe('gain')
  })

  it('stays short enough to fit the panel it is drawn on', () => {
    // `render/hud.ts` fits the event line to 94 % of a 0.4 m panel and drops to a
    // smaller font past 12 characters. Anything much longer than the medal
    // banner it shares the row with is a string nobody can read at speed — and
    // "it survived N sessions" is not evidence that something illegible is
    // legible (DEV-044).
    const runs: Tier[][] = [['bullseye'], ['bullseye', 'large'], cycle(['bullseye'], 6)]
    for (const tiers of runs) {
      const banner = bannerFor(tiers)
      expect((banner?.text ?? '').length, banner?.text).toBeLessThanOrEqual(20)
    }
  })
})

describe('the latch is settled by the streak, not by taste', () => {
  it('closes a pad on any hit, so a bullseye cannot be followed by a mid plate', () => {
    // Under `'zone2016'` a bullseye leaves the pad open and a mid plate on the
    // way out scores again — which under a multiplier is a farm worth 50 x m per
    // pad, bought by flying badly over one dish instead of cleanly over two.
    expect(PAD_LATCH).toBe('group')
    const L = level('int_01_jumpSeat')
    const state = createTargets(padZones(L), livePads(L).length, RULES)
    cross(state, 0, 'bullseye')
    const afterBullseye = state.score
    cross(state, 0, 'mid')
    expect(state.score).toBe(afterBullseye)
    expect(state.padsHit).toBe(1)
  })

  it('counts a pad ONCE even where the latch would leave it open', () => {
    // `padTaken`, not `padClosed`. Under `'group'` these two arrays are
    // identical, which is exactly the shape CLAUDE.md's agreement lesson warns
    // about — so this asserts the invariant that matters (`padsHit` never exceeds
    // the pad count) rather than the implementation that currently delivers it.
    const L = level('adv_02_jumpSeat')
    const pads = livePads(L).length
    const state = createTargets(padZones(L), pads, RULES)
    for (const tier of ['bullseye', 'mid', 'large'] as const) {
      for (let pad = 0; pad < pads; pad++) cross(state, pad, tier)
    }
    expect(state.padsHit).toBe(pads)
    expect(state.clearBonus).toBe(RULES.clearBonusPerPad * pads)
  })
})

describe('trap 19 — two streaks do not leak into each other', () => {
  const L = level('adv_02_jumpSeat')
  const ZONES = padZones(L)
  const PADS = livePads(L).length

  it('leaves the first pad set s multiplier alone when a second one is stepped', () => {
    // Both share the same readonly `ZONES` array — the sharing a port would
    // plausibly do, and the sharing that would leak if the multiplier lived on
    // the zones or in a module-level `let`. With one pad set there is nobody to
    // inherit from, which is why every single-object test above is blind to this.
    const first = createTargets(ZONES, PADS, RULES)
    const second = createTargets(ZONES, PADS, RULES)

    cross(first, 0, 'bullseye')
    const before = {
      score: first.score,
      multiplier: first.multiplier,
      padsHit: first.padsHit,
      cleared: first.cleared,
      taken: [...first.taken],
    }

    // Run the second one all the way to a perfect clear at the cap.
    for (let pad = 0; pad < PADS; pad++) cross(second, pad, 'bullseye')
    expect(second.multiplier).toBe(RULES.cap)
    expect(second.cleared).toBe(true)

    expect(first.score).toBe(before.score)
    expect(first.multiplier).toBe(before.multiplier)
    expect(first.padsHit).toBe(before.padsHit)
    expect(first.cleared).toBe(before.cleared)
    expect(first.taken).toEqual(before.taken)
  })

  it('keeps the per-step record apart at the mission layer too', () => {
    // `MissionEvent` now carries four more pad fields, every one written on a
    // scoring step and read by `app.ts` on the same step. A module-level record
    // would hand the first run the second run's bullseye.
    const air = finishPadAirspace(L)
    if (!air) throw new Error('expected a finish pad')
    const pad = air.pad === 0 ? 1 : 0
    const first = startMission(L)
    const second = startMission(L)

    const eye = zoneOn(padZones(L), pad, 'bullseye')
    stepMission(first, L, at(eye, 0, 30, 0), FIXED_DT)
    stepMission(first, L, at(eye, 0, -30, 0), FIXED_DT)
    expect(first.event.padZone).toBeGreaterThanOrEqual(0)
    const snapshot = { ...first.event }
    const score = first.score
    const multiplier = streakMultiplier(first)

    // Step the second one hard: three pads, so its multiplier ends up different.
    for (const p of [0, 1, 2].filter((p) => p !== air.pad)) {
      const z = zoneOn(padZones(L), p, 'bullseye')
      stepMission(second, L, at(z, 0, 30, 0), FIXED_DT)
      stepMission(second, L, at(z, 0, -30, 0), FIXED_DT)
    }

    expect(second.score).toBeGreaterThan(0)
    expect(streakMultiplier(second)).not.toBe(multiplier)
    expect(first.event).toEqual(snapshot)
    expect(first.score).toBe(score)
    expect(streakMultiplier(first)).toBe(multiplier)
  })

  it('clears the pad channel on a step that scored nothing', () => {
    // A stale `padPoints` read a step later is the same bug one frame down: the
    // HUD would raise a banner for a pad nobody crossed.
    const state = startMission(L)
    const eye = zoneOn(padZones(L), 0, 'bullseye')
    stepMission(state, L, at(eye, 0, 30, 0), FIXED_DT)
    stepMission(state, L, at(eye, 0, -30, 0), FIXED_DT)
    expect(state.event.padPoints).toBe(100)
    stepMission(state, L, v3(0, 4000, 0), FIXED_DT)
    expect(state.event.padZone).toBe(-1)
    expect(state.event.padPoints).toBe(0)
    expect(state.event.padMultiplier).toBe(1)
    expect(state.event.padEffect).toBeNull()
    expect(state.event.padClearBonus).toBe(0)
    expect(padBanner(state.event, PADS)).toBeNull()
  })
})

describe('the panel actually redraws when the streak moves', () => {
  // ── What this can check, and what it cannot ─────────────────────────────
  //
  // `createHud` needs a `document`, and `vitest.config.ts` runs `environment:
  // 'node'` on purpose, so the canvas cannot be exercised here. What CAN be
  // checked is the failure this panel is uniquely prone to: `hud.ts` redraws
  // only when a SIGNATURE of the displayed values changes, and a field added to
  // `HudState` and drawn by `draw()` but left out of that signature is invisible
  // until something else on the panel happens to move. The streak changes on a
  // pad hit and the score changes on the same step, so it would have looked fine
  // — right up to a run where it did not, which is exactly the shape of
  // DEV-044's four-pixel jets. The layout itself is a screenshot job.
  //
  // This used to SLICE THE SOURCE for `const next = [ ... ].join(`, because the
  // signature had no name of its own. DEV-083 gave it one — `hudSignature` is
  // exported and `update()` calls it — so these two now CALL it, which is the
  // same claim tested against behaviour instead of against a substring. (The
  // slice broke the moment the code moved, and it broke loudly, which is the
  // one good thing about a source scan.)
  const SOURCE = fs.readFileSync(path.join(ROOT, 'src/render/hud.ts'), 'utf8')

  const panel = (over: Partial<HudState> = {}): HudState => ({
    ringsPassed: 3,
    ringsTotal: 11,
    score: 300,
    elapsed: 12.5,
    timeLimit: 180,
    speed: 84,
    medal: '',
    finished: false,
    countLabel: 'PADS',
    timeLabel: 'TIME',
    speedLabel: 'SPEED',
    banner: null,
    autopilot: false,
    ...over,
  })

  it('keys the redraw on the multiplier and on the award tone', () => {
    expect(hudSignature(panel({ multiplier: 3 }))).not.toBe(hudSignature(panel()))
    expect(hudSignature(panel({ award: 'BULLSEYE', awardTone: 'loss' }))).not.toBe(
      hudSignature(panel({ award: 'BULLSEYE', awardTone: 'gain' })),
    )
  })

  it('draws the multiplier only above 1, and colours a lost streak apart', () => {
    // Two claims the words in `padBanner` depend on. Read off the source rather
    // than the canvas, and narrow enough to fail if either is deleted.
    expect(SOURCE).toContain('multiplier > 1')
    expect(SOURCE).toMatch(/awardTone === 'loss'\s*\?\s*MUTED/)
  })
})

describe('the sim layer holds no knob of its own', () => {
  it('scores 2016 s flat rule when handed no streak', () => {
    // `NO_STREAK` is the identity, and `tests/unit/pad-scoring.test.ts` is
    // written entirely in it. Asserted from this side too, so that "FF2's design
    // is additive to the port, not a rewrite of it" stays checkable.
    const L = level('int_01_jumpSeat')
    const zones = padZones(L)
    const pads = livePads(L).length
    expect(streakCeiling(zones, pads, { cap: 1, clearBonusPerPad: 0 })).toBe(maxPadScore(L))
  })

  it('moves every ceiling when a knob moves, without anything else changing', () => {
    // The knobs are real: a different cap gives a different ceiling, computed by
    // the same function the scorer runs. This is what makes "three knobs, one
    // line each" a claim rather than a comment.
    const L = level('adv_02_jumpSeat')
    const zones = padZones(L)
    const pads = livePads(L).length
    const capped = streakCeiling(zones, pads, { ...RULES, cap: 3 })
    const uncapped = streakCeiling(zones, pads, { ...RULES, cap: pads })
    expect(capped).toBeLessThan(arcadePadCeiling(L))
    expect(uncapped).toBeGreaterThan(arcadePadCeiling(L))
    const noBonus = streakCeiling(zones, pads, { ...RULES, clearBonusPerPad: 0 })
    expect(arcadePadCeiling(L) - noBonus).toBe(RULES.clearBonusPerPad * pads)
  })
})
