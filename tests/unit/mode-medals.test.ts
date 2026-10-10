// tests/unit/mode-medals.test.ts — what each mode awards, and what it refuses to.
//
// Two facts this file exists to keep visible in CI, because both are decisions
// waiting on Matt and both would rot silently:
//
//  1. **2016 awards NO medal in Target Practice.** Not "a hard one" — none, for
//     three independent reasons (`_modes-spec.md` §5.1). The thresholds sitting
//     in those six level JSONs belong to a component that never finished
//     initialising, and at 100 points a pad the best any mission can reach is
//     1200 against a bronze of 1600. FF2's curve is therefore an INVENTION, and
//     `TARGET_PRACTICE_MEDAL_RULE` is the one line that says which one. What that
//     invention IS lives in `tests/unit/pad-streak.test.ts`: an accuracy streak,
//     asked for by name this session. This file keeps the 2016 finding visible —
//     `maxPadScore` is deliberately still the FLAT ceiling — and checks that the
//     new rule is wired through, nothing more.
//
//  2. **Free Flight's platinum was one orb short on two shipped missions.** Same
//     arithmetic shape as `rookie_01_hoverJet`'s 16 rings against 1700, which
//     Matt already ruled a fixable bug. This said "asserted here so that 'we
//     fixed it' needs a deliberate edit" — and DEV-393 is that edit: a count
//     curve is held to the objects that exist, so every orb is platinum. The
//     2016 number is still asserted, in the JSON, where it lives.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import {
  type Medal,
  type MissionState,
  medalFor,
  medalInput,
  medalThresholds,
  startMission,
  stepMission,
} from '@/game/mission'
import { rulesFor, TARGET_PRACTICE_MEDAL_RULE } from '@/game/modes'
import {
  arcadePadCeiling,
  finishPadAirspace,
  livePads,
  maxPadScore,
  PAD_LATCH,
  padZones,
} from '@/game/targets'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import type { TargetZone } from '@/sim/targets'
import { levelJson as level } from './helpers/content'

const PAD_MISSIONS = [
  'rookie_01_jumpSeat',
  'rookie_02_jumpSeat',
  'int_01_jumpSeat',
  'int_02_jumpSeat',
  'adv_01_jumpSeat',
  'adv_02_jumpSeat',
]

/** Fly a straight line at `speed`, collecting every award event on the way. */
const flyTo = (
  state: MissionState,
  L: Level,
  from: Vec3,
  to: Vec3,
  speed: number,
  awards?: { count: number; medal: Medal }[],
): Vec3 => {
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
    if (awards && state.event.awarded) {
      awards.push({ count: state.counted, medal: state.event.awarded })
    }
  }
  return v3(at.x, at.y, at.z)
}

describe('Free Flight awards a medal in the air, off a raw orb count', () => {
  const L = level('hoverJet_kauai_beg')

  it('uses 2016 s own 3 / 5 / 9 / 12 and never multiplies by 100', () => {
    // 2016's curve, as extracted — a raw count, never x 100.
    const exp = (L as Level & { medalsExp?: Record<string, number | null> }).medalsExp
    expect(exp).toMatchObject({ bronze: 3, silver: 5, gold: 9, platinum: 12 })
    // What FF2 awards against: the same, with platinum held to the 11 orbs the
    // course has live (DEV-393).
    expect(medalThresholds(L, 'freeFlight')).toEqual({
      bronze: 3,
      silver: 5,
      gold: 9,
      platinum: 11,
    })
    // The ring curve for the same mission, for contrast: points, not objects.
    expect(medalThresholds(L, 'ringAttack')?.bronze).toBe(900)
  })

  it('fires once, on the crossing orb, at 3 and 5 and 9 and 11 — and not in between', () => {
    // `LevelEnd.cs:202-243` tests `score == <that band's min>`, equality rather
    // than `>=`, so the banner fires on the object that crosses the threshold and
    // never again. It is the only part of these two modes that shipped working.
    // The eleventh orb is platinum since DEV-393 (2016 asked for a twelfth).
    const state = startMission(L)
    const awards: { count: number; medal: Medal }[] = []
    const orbs = state.orbs.orbs
    let at = v3(orbs[0]?.centre.x, (orbs[0]?.centre.y ?? 0) + 300, orbs[0]?.centre.z)
    for (const orb of orbs) at = flyTo(state, L, at, orb.centre, 90, awards)

    expect(state.orbs.collected).toBe(11)
    expect(awards.map((a) => a.medal)).toEqual(['bronze', 'silver', 'gold', 'platinum'])
    expect(awards.map((a) => a.count)).toEqual([3, 5, 9, 11])
    expect(rulesFor('freeFlight').awardWhen).toBe('onCrossing')
  })

  it('collects every orb exactly once — nothing re-arms', () => {
    // `SelfDestruct()` disables the orb root and nothing re-enables it.
    const state = startMission(L)
    const orbs = state.orbs.orbs
    let at = v3(orbs[0]?.centre.x, (orbs[0]?.centre.y ?? 0) + 300, orbs[0]?.centre.z)
    for (const orb of orbs) at = flyTo(state, L, at, orb.centre, 90)
    for (const orb of orbs) at = flyTo(state, L, at, orb.centre, 90)
    expect(state.orbs.collected).toBe(11)
    expect(state.score).toBe(11)
  })

  // ── The one-orb-short bug, fixed out loud (DEV-393) ───────────────────
  it('holds kauai and int_01_hoverJet platinum to the eleven orbs they have', () => {
    for (const id of ['hoverJet_kauai_beg', 'int_01_hoverJet']) {
      const L2 = level(id)
      const exp = (L2 as Level & { medalsExp?: Record<string, number | null> }).medalsExp
      const curve = medalThresholds(L2, 'freeFlight')
      const orbs = L2.orbs.filter((o) => o.live).length
      expect(orbs, id).toBe(11)
      // 2016 asked for twelve, and the JSON still says so...
      expect(exp?.platinum, id).toBe(12)
      // ...and FF2 awards platinum at every orb there is.
      expect(curve?.platinum, `${id}: platinum is every live orb`).toBe(orbs)
    }
  })

  it('awards platinum to a perfect kauai run', () => {
    const state = startMission(L)
    const orbs = state.orbs.orbs
    let at = v3(orbs[0]?.centre.x, (orbs[0]?.centre.y ?? 0) + 300, orbs[0]?.centre.z)
    for (const orb of orbs) at = flyTo(state, L, at, orb.centre, 90)
    expect(medalInput(state)).toBe(11)
    expect(medalFor(state, L)).toBe('platinum')
  })

  it('preserves the missions where Free Flight can score NOTHING', () => {
    // `int_02_jumpSeat` is the mission 2016 FORCES into Free Flight with every
    // one of its 12 orbs at `m_IsActive: 0`. Both facts are still true and the
    // 2016 forcing is still on the record — DEV-061 changes only which mode FF2
    // RUNS it in, so the way to see the empty Free Flight course now is to ask
    // for Free Flight rather than to be locked into it.
    const L2 = level('int_02_jumpSeat')
    expect(L2.forcedMode).toBe('freeFlight')
    expect(L2.orbs.filter((o) => o.live)).toHaveLength(0)
    const state = startMission(L2, 'freeFlight')
    expect(state.mode).toBe('freeFlight')
    expect(state.countTotal).toBe(0)
    expect(state.orbs.orbs).toHaveLength(0)
    expect(medalFor(state, L2)).toBe('none')
  })

  it('no longer LOCKS that empty course on anybody — DEV-061', () => {
    // The other half, and it is the behaviour rather than the field: asked for
    // nothing, the mission now boots in the mode its live content belongs to.
    const L2 = level('int_02_jumpSeat')
    const state = startMission(L2)
    expect(state.mode).toBe('targetPractice')
    expect(state.countTotal).toBe(9)
  })

  it('awards no medal at all where 2016 has no thresholds to read', () => {
    // `rookie_01_jumpSeat` has no `finale_logic` instance, so its `medalsExp` is
    // four nulls. null means "this mode awards none here", which is not the same
    // as "you earned none".
    const L2 = level('rookie_01_jumpSeat')
    expect(medalThresholds(L2, 'freeFlight')).toBeNull()
    const state = startMission(L2, 'freeFlight')
    expect(medalFor(state, L2)).toBeNull()
  })
})

describe('Target Practice has no 2016 medal, and FF2 invents one on purpose', () => {
  it('cannot reach the shipped bronze on any mission — that is the finding', () => {
    for (const id of PAD_MISSIONS) {
      const L = level(id)
      const ceiling = maxPadScore(L)
      // `rookie_01_jumpSeat` has no thresholds AT ALL — four nulls, because it
      // has no `finale_logic` instance. That is the sixth of §5.1's reasons and
      // it is why `medalThresholds` has to be allowed to answer null.
      if (typeof L.medals.bronze !== 'number') {
        expect(id).toBe('rookie_01_jumpSeat')
        expect(medalThresholds(L, 'ringAttack'), id).toBeNull()
        continue
      }
      // 1800 is `adv_02_jumpSeat`'s ceiling at 150 a pad, and 2000 is silver.
      // Nothing anywhere reaches silver under either latch.
      expect(ceiling, `${id} vs silver`).toBeLessThan(L.medals.silver)
      if (PAD_LATCH === 'group') {
        expect(ceiling, `${id} vs bronze`).toBeLessThan(L.medals.bronze)
      }
    }
  })

  it('refuses to award platinum for nothing where the thresholds are null', () => {
    // `awardMedal(0, { bronze: null, … })` evaluates `0 >= null` as `0 >= 0` and
    // returns platinum. `?mission=rookie_01_jumpSeat` does exactly that today.
    const L = level('rookie_01_jumpSeat')
    expect(L.medals.bronze as number | null).toBeNull()
    const state = startMission(L)
    expect(state.score).toBe(0)
    expect(medalThresholds(L, 'ringAttack')).toBeNull()
    expect(medalThresholds(L, 'freeFlight')).toBeNull()
    // Target Practice still has one, because FF2's is derived from the pads
    // rather than read out of a component that never ran: five pads, and a
    // streak ceiling of 2000 against a `medals` block of four nulls.
    expect(medalThresholds(L, 'targetPractice')?.platinum).toBe(arcadePadCeiling(L))
    expect(livePads(L)).toHaveLength(5)
    expect(medalFor(state, L)).toBe('none')
  })

  it('never lets scoring.gateMultiplier near a pad', () => {
    // `gateMultiplier: 100` is a RING multiplier. A pad plate's `val_score` is
    // already a point value, so a 100-zone is worth 100 and not 10,000.
    const L = level('int_01_jumpSeat')
    expect(L.scoring.gateMultiplier).toBe(100)
    expect(Math.max(...padZones(L).map((z) => z.points))).toBe(100)
    expect(maxPadScore(L)).toBe(livePads(L).length * (PAD_LATCH === 'group' ? 100 : 150))
  })

  it('scales the invented curve to the mission and keeps platinum reachable', () => {
    // The rule Matt asked for this session. What it DOES is
    // `tests/unit/pad-streak.test.ts`'s business; what this asserts is that every
    // mission gets a coherent, climbable curve out of it — including
    // `rookie_01_jumpSeat`, whose own `medals` block is four nulls.
    expect(TARGET_PRACTICE_MEDAL_RULE).toBe('padStreak')
    for (const id of PAD_MISSIONS) {
      const L = level(id)
      const curve = medalThresholds(L, 'targetPractice')
      if (!curve) throw new Error(`${id}: expected an invented curve`)
      // Platinum is a perfect run — the same coherence Free Flight's own working
      // curve has on `rookie_01_hoverJet` (18 orbs, platinum 18).
      expect(curve.platinum, id).toBe(arcadePadCeiling(L))
      expect(curve.bronze, id).toBeLessThan(curve.silver)
      expect(curve.silver, id).toBeLessThan(curve.gold)
      expect(curve.gold, id).toBeLessThan(curve.platinum)
      expect(curve.bronze, id).toBeGreaterThanOrEqual(1)
    }
  })

  it('awards against POINTS, and one pad is nowhere near platinum', () => {
    // The streak moved Target Practice from a pad COUNT onto a points scale, so
    // the shape of the mistake changed with it: the danger is no longer platinum
    // on pad one, it is a time bonus sneaking onto a points curve. Both are
    // checked — the first pad is worth its face value and nothing else, and the
    // clock contributes zero.
    const L = level('int_01_jumpSeat')
    expect(rulesFor('targetPractice').medalScale).toBe('points')
    const state = startMission(L)
    const eye = padZones(L).find((z) => z.pad === 0 && z.points === 100) as TargetZone
    stepMission(state, L, v3(eye.centre.x, eye.centre.y + 30, eye.centre.z), FIXED_DT)
    stepMission(state, L, v3(eye.centre.x, eye.centre.y - 30, eye.centre.z), FIXED_DT)
    expect(state.score).toBe(100)
    expect(medalInput(state)).toBe(100)
    expect(state.timeBonus).toBe(0)
    expect(medalFor(state, L)).toBe('none')
  })
})

describe('a whole Target Practice run', () => {
  const L = level('int_01_jumpSeat')

  /** Straight down through a pad's bullseye and out the bottom of its airspace. */
  const descend = (state: MissionState, pad: number, from: Vec3): Vec3 => {
    const eye = padZones(L).find((z) => z.pad === pad && z.points === 100) as TargetZone
    const top = v3(eye.centre.x, eye.centre.y + 80, eye.centre.z)
    flyTo(state, L, from, top, 200)
    return flyTo(state, L, top, v3(eye.centre.x, eye.centre.y - 40, eye.centre.z), 40)
  }

  it('ends at the finish pad with every pad counted, including the finish pad s own', () => {
    const air = finishPadAirspace(L)
    if (!air) throw new Error('expected a finish pad')
    const state = startMission(L)
    const others = [0, 1, 2, 3, 4, 5].filter((p) => p !== air.pad)

    let at = v3(0, 2000, 0)
    for (const pad of others) {
      at = descend(state, pad, at)
      expect(state.finished, `pad ${pad} should not end the run`).toBe(false)
    }
    // Five bullseyes under the accuracy streak: 100 + 200 + 300 + 400 + 500.
    expect(state.score).toBe(1500)
    expect(state.counted).toBe(5)

    at = descend(state, air.pad, at)
    expect(state.finished).toBe(true)
    expect(state.finishCrossed).toBe(true)
    // The finish pad's own bullseye is IN the total, which is the whole point of
    // the settle: the finish slab sits 6.9 m above it. And it is the sixth pad,
    // so it also completes the board and pays the perfect-clear bonus.
    expect(state.score).toBe(arcadePadCeiling(L))
    expect(state.counted).toBe(6)
    expect(medalInput(state)).toBe(state.score)
    expect(medalFor(state, L)).toBe('platinum')
    // No time bonus in this mode: an accuracy streak, not a stopwatch. 2016
    // throws its own away too (`ScoreKeeper_JumpPads.cs:54, 67`).
    expect(state.timeBonus).toBe(0)
  })

  it('crosses the finish BEFORE the finish pad scores — and still counts it', () => {
    // The exact trap `finishPadAirspace` exists for. Recorded rather than
    // reasoned about: the score at the moment the slab is entered is five
    // bullseyes' worth, and the score when the run actually commits is the whole
    // ceiling — the sixth pad AND the perfect-clear bonus it completes.
    const air = finishPadAirspace(L)
    if (!air) throw new Error('expected a finish pad')
    const state = startMission(L)
    let at = v3(0, 2000, 0)
    for (const pad of [0, 1, 2, 3, 4, 5].filter((p) => p !== air.pad)) at = descend(state, pad, at)

    const eye = padZones(L).find((z) => z.pad === air.pad && z.points === 100) as TargetZone
    const top = v3(eye.centre.x, eye.centre.y + 80, eye.centre.z)
    flyTo(state, L, at, top, 200)

    let scoreAtCrossing = -1
    const from = top
    const to = v3(eye.centre.x, eye.centre.y - 40, eye.centre.z)
    const steps = Math.ceil(Math.hypot(0, from.y - to.y, 0) / (40 * FIXED_DT))
    const p = v3()
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      p.x = from.x + (to.x - from.x) * t
      p.y = from.y + (to.y - from.y) * t
      p.z = from.z + (to.z - from.z) * t
      stepMission(state, L, p, FIXED_DT)
      if (state.finishCrossed && scoreAtCrossing < 0) scoreAtCrossing = state.score
    }

    expect(scoreAtCrossing).toBe(1500)
    expect(state.score).toBe(arcadePadCeiling(L))
    expect(state.finished).toBe(true)
  })
})
