// tests/unit/fog-deviation.test.ts — DEV-018, and the measurement behind it.
//
// The first version of this deviation halved both density terms and justified it
// with `heightDensity`: 0.2 on `int_01` against 0.03 almost everywhere else,
// "nearly seven times". That was one parameter read in isolation and it was
// wrong — the half-space term goes as `heightDensity x (targetY - height)^2`, so
// the low 164 m plane squares back most of what the high density adds.
//
// This suite asserts the thing that IS true: evaluated end to end, `int_01`'s
// fog is about twice as thick at mid range as the median mission's, the cause is
// `density` rather than the height fog, and the replacement lands inside the
// other ten's range.
//
// DEV-098 then widened it. The replacement used to reach only the three missions
// carrying the Simonet-sunset signature, and the eight it did not reach — every
// alpine and desert mission — were a flat sheet of fog colour from the altitude
// their own courses are flown at. The last `describe` is the SWEEP that landed
// with the fix: it reads every level JSON off the disk rather than naming
// missions, because the defect was exactly a rule that happened to be true of
// the missions somebody had checked.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FF2_FOG_REPLACEMENT, FF2_FOG_THINNING, ff2Fog } from '@/render/unity-fog'
import int01 from '../../content/levels/int_01_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import { REPO as ROOT } from './helpers/repo-root'

interface FogLike {
  height: number
  heightDensity: number
  density: number
  mode: number
  startDistance: number
  heightFog: boolean
  /** DEV-031: the dense half is ABOVE the plane. */
  inverted?: boolean
}

/**
 * Unity's `GlobalFog`, evaluated for one camera and one target.
 *
 * Transmittance: 1 is perfectly clear, 0 is solid fog. Written out here rather
 * than imported from the shader so the test is an independent statement of the
 * formula rather than a re-run of the implementation.
 */
const transmittance = (f: FogLike, camY: number, targetY: number, dist: number): number => {
  // DEV-031 mirrors the vertical axis about the plane so the dense half is
  // ABOVE it. One sign, applied to every height term — exactly as the shader
  // does, and written out here rather than imported so this stays an
  // independent statement of the formula.
  const sign = f.inverted ? -1 : 1
  const FdotC = (camY - f.height) * sign
  const k = FdotC <= 0 ? 1 : 0
  const dy = (targetY - camY) * sign
  let g = -Math.max(f.startDistance, 0) + dist
  if (f.heightFog) {
    const w = f.heightDensity * 0.5
    const FdotP = (targetY - f.height) * sign
    const c1 = k * (FdotP + FdotC)
    const c2 = (1 - 2 * k) * FdotP
    const gg = Math.min(c2, 0)
    g += -(w * dist) * (c1 - (gg * gg) / Math.abs(dy + 1e-5))
  }
  g = Math.max(0, g)
  const x = f.density * g
  return Math.min(1, Math.max(0, f.mode === 2 ? Math.exp(-x) : Math.exp(-(x * x))))
}

const SHIPPED = int01.fog as unknown as FogLike
const FF2 = ff2Fog(SHIPPED)
/** A mission with the modal fog, as the thing to be "in the ballpark" of. */
const TYPICAL = rookie01.fog as unknown as FogLike

const LEVELS = path.join(ROOT, 'content', 'levels')

/** Every shipped mission, read off the disk — never a list in this file. */
const everyLevel = (): { id: string; fog: FogLike }[] =>
  fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => ({
      id: f.replace(/\.json$/, ''),
      fog: (JSON.parse(fs.readFileSync(path.join(LEVELS, f), 'utf8')) as { fog: FogLike }).fog,
    }))

describe('what the shipped fog does', () => {
  it('is about twice as thick at mid range as a typical mission', () => {
    const mine = transmittance(SHIPPED, 800, 500, 2000)
    const theirs = transmittance(TYPICAL, 800, 500, 2000)
    expect(mine).toBeLessThan(theirs / 1.8)
  })

  it('is thick because of DENSITY, not because of the height fog', () => {
    // The claim that replaced the wrong one. A 500 m peak is above both fog
    // planes, so the half-space term contributes nothing to it — switching the
    // height fog off entirely changes that pixel by nothing at all.
    const withHeight = transmittance(SHIPPED, 800, 500, 2000)
    const without = transmittance({ ...SHIPPED, heightFog: false }, 800, 500, 2000)
    expect(without).toBeCloseTo(withHeight, 6)
  })

  it('has a heightDensity that is NOT seven times the others in effect', () => {
    // `0.2` against `0.03` looks like 6.7x and is not, because the plane height
    // is squared in the same term. Within 20 %.
    const mine = SHIPPED.heightDensity * SHIPPED.height ** 2
    const theirs = TYPICAL.heightDensity * TYPICAL.height ** 2
    expect(mine / theirs).toBeGreaterThan(0.8)
    expect(mine / theirs).toBeLessThan(1.3)
  })
})

describe('the replacement', () => {
  it('is the modal parameter set, thinned by ONE number', () => {
    // The modal set stays visible underneath; the deviation is the multiplier.
    // 500, not 387: DEV-031 inverted the half-space, and the plane moved with
    // it. Under 500 the course is crisp; over it the world softens.
    expect(FF2_FOG_REPLACEMENT.height).toBe(500)
    expect(FF2_FOG_REPLACEMENT.inverted).toBe(true)
    expect(FF2_FOG_THINNING).toBe(0.5)
    expect(FF2_FOG_REPLACEMENT.heightDensity).toBeCloseTo(0.03 * FF2_FOG_THINNING, 12)
    expect(FF2_FOG_REPLACEMENT.density).toBeCloseTo(0.00025 * FF2_FOG_THINNING, 12)
  })

  it('is clearer than the shipped fog at every distance', () => {
    for (const [camY, targetY, dist] of [
      [800, 500, 2000],
      [800, 0, 2000],
      [800, 500, 5000],
    ] as [number, number, number][]) {
      const before = transmittance(SHIPPED, camY, targetY, dist)
      const after = transmittance(FF2, camY, targetY, dist)
      expect(after, `${targetY}m at ${dist}m`).toBeGreaterThan(before)
    }
  })

  it('is a HINT at close range and still does something far away', () => {
    // Matt: "it's supposed to give a hint of atmosphere." Both halves are the
    // claim — too thin at range and the islands stop sitting back, too thick up
    // close and it is what he has been flying through.
    //
    // Measured from INSIDE the clear layer, which is where the course is:
    // DEV-031 put the dense half above 500 m and `int_01` runs 134 to 890.
    const massif = 1 - transmittance(FF2, 300, 338, 930)
    const far = 1 - transmittance(FF2, 300, 200, 4000)
    const far2016 = 1 - transmittance(SHIPPED, 300, 200, 4000)
    expect(massif).toBeLessThan(0.15)
    expect(far).toBeGreaterThan(0.25)
    expect(far).toBeLessThan(far2016)
  })

  it('is thicker the HIGHER you fly, which is the whole of DEV-031', () => {
    // Unity's half-space is an atmosphere: dense at the bottom, thinning
    // upward. Physically right, and backwards for a racer — it is murkiest at
    // exactly the altitude the course is flown at and clears as you climb away
    // from it. Inverted, low flight is crisp and climbing dissolves the world.
    //
    // Same target, 3 km away, from a ladder of altitudes. The sequence has to
    // be MONOTONIC UP; the un-inverted model is monotonic down, which is what
    // makes this a real test rather than a threshold someone picked.
    const ladder = [120, 300, 500, 700, 900, 1200].map(
      (camY) => 1 - transmittance(FF2, camY, 150, 3000),
    )
    // Non-DECREASING, with a float tolerance: below the plane there is no
    // height term at all, so 120 m, 300 m and 500 m are the same number to
    // within rounding, and they should be — that flat stretch IS the crisp
    // racing layer. A strict `>` would be asserting noise.
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] as number, `climbing step ${i}`).toBeGreaterThanOrEqual(
        (ladder[i - 1] as number) - 1e-6,
      )
    }
    // And the flat stretch is real: the three altitudes under the plane agree.
    expect(ladder[0] as number).toBeCloseTo(ladder[2] as number, 5)
    // And it genuinely moves: not a flat line dressed as a gradient.
    expect((ladder.at(-1) as number) / (ladder[0] as number)).toBeGreaterThan(2)

    // The stock model, for contrast, goes the other way.
    const stock = [120, 300, 500, 700, 900, 1200].map(
      (camY) => 1 - transmittance({ ...FF2, inverted: false }, camY, 150, 3000),
    )
    expect(stock.at(-1) as number).toBeLessThan(stock[0] as number)
  })

  it('keeps low flight clear — the case DEV-018 was about', () => {
    // DEV-018's whole subject: the replacement raised the fog plane and was
    // chosen on a shot of a 500 m peak, and a HoverJet spends its run BELOW
    // that, so the un-thinned replacement was murkier down low than 2016's own
    // fog. DEV-031 settles it by construction rather than by tuning — under the
    // plane there is no height fog at all, so the only term left is distance.
    const shipped2016 = 1 - transmittance(SHIPPED, 200, 150, 600)
    const now = 1 - transmittance(FF2, 200, 150, 600)
    expect(now).toBeLessThan(shipped2016)
    // And by a margin this time, not by 2%: the ceiling that DEV-018b had to
    // guard is gone, because thickening the fog no longer costs low flight.
    expect(now).toBeLessThan(shipped2016 * 0.5)
  })

  it('no longer has a multiplier ceiling, because the mechanism is gone', () => {
    // DEV-018b needed one. With the dense half BELOW the plane, a HoverJet
    // flies inside it, so the height term does most of the work down low and
    // thickening costs low flight faster than anything else — the crossover
    // where the port became murkier than 2016 down there was x0.508, and
    // FF2_FOG_THINNING sat at 0.50.
    //
    // Inverted, the course is under the plane and sees no height fog at all, so
    // the multiplier can move without touching it. This is the test that says
    // the ceiling is GONE rather than merely unbreached: at twice the shipped
    // thinning, low flight is still clearer than 2016's.
    const shipped2016 = 1 - transmittance(SHIPPED, 200, 150, 600)
    const doubled = {
      ...FF2,
      density: FF2.density * 2,
      heightDensity: FF2.heightDensity * 2,
    }
    expect(1 - transmittance(doubled, 200, 150, 600)).toBeLessThan(shipped2016)
    // The multiplier is still a real number and not accidentally zero.
    expect(FF2_FOG_THINNING).toBeGreaterThan(0.1)
    expect(FF2_FOG_THINNING).toBeLessThan(1)
  })
})

/**
 * DEV-098 — the treatment reaches EVERY mission, not the ones we had looked at.
 *
 * The narrow version of `ff2Fog` matched a fog signature and left ten missions
 * on 2016's un-inverted atmosphere. That was invisible for as long as Simonet
 * was the only environment the port had ever loaded, and the day the level
 * select could reach the other three it turned out that alpine and desert —
 * eight of the thirteen — rendered as a flat sheet of fog colour from the
 * altitude their own courses are flown at.
 *
 * These are a SWEEP rather than three named missions, because the defect was
 * precisely a rule that was true of the missions somebody checked. A fourteenth
 * course must not be able to arrive with 2016's fog and nobody notice.
 */
describe('every mission gets it, not just the ones we had flown', () => {
  it('leaves no mission on the un-inverted atmosphere', () => {
    for (const { id, fog } of everyLevel()) {
      expect(ff2Fog(fog).inverted, `${id} is on FF2's fog`).toBe(true)
    }
    // And the sweep is actually sweeping: the JSON still carries 2016's, so a
    // `ff2Fog` that had quietly become the identity would fail here.
    expect(everyLevel().length).toBeGreaterThan(1)
    expect(everyLevel().some(({ fog }) => fog.inverted !== true)).toBe(true)
  })

  it('keeps each mission its OWN colour and mode — only the amount is ours', () => {
    for (const { id, fog } of everyLevel()) {
      const after = ff2Fog(fog)
      expect(after.mode, `${id} keeps 2016's fog mode`).toBe(fog.mode)
      expect(after.startDistance, `${id} keeps 2016's start distance`).toBe(fog.startDistance)
      // The colour is not in `FogLike`; it must survive the spread untouched.
      expect(
        (after as unknown as { color: unknown }).color,
        `${id} keeps 2016's fog colour`,
      ).toEqual((fog as unknown as { color: unknown }).color)
    }
  })

  it('makes the two worlds that were unflyable to look at, flyable', () => {
    // The measurement that opened DEV-098, reproduced. Fraction of the original
    // colour SURVIVING at 2 km, from the altitude the autopilot actually flies
    // each course at, to terrain 300 m below it.
    //
    // As shipped: simonet 0.80, alpine 0.07, mesa canyon 0.00 — and 0.00 is not
    // atmosphere, it is a wall. The bar is "in the same ballpark as Simonet",
    // which is the standard DEV-018 set for itself.
    const before: Record<string, number> = {}
    const after: Record<string, number> = {}
    for (const { id, fog } of everyLevel()) {
      before[id] = transmittance(fog, 416, 116, 2000)
      after[id] = transmittance(ff2Fog(fog), 416, 116, 2000)
    }
    // Alpine and desert were the two that failed, and they are named here
    // because they are the REPORT — not because the rule knows about them.
    expect(before.rookie_01_hoverJet as number).toBeLessThan(0.2)
    expect(before.rookie_02_hoverJet as number).toBeLessThan(0.2)
    // Afterwards nothing in the game is a wall at 2 km.
    for (const { id } of everyLevel()) {
      expect(after[id] as number, `${id} at 2 km`).toBeGreaterThan(0.5)
    }
  })
})
