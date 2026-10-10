// tests/unit/variant-hoverjet.test.ts — the acrobat and the speed jet FEEL like their names. DEV-381.
//
// docs/plan/AIRCRAFT-VARIANTS.md §3.1 and §9.1. Matt, 2026-09-24: acrobat
// *"more nimble"*; speed *"faster top speed. insane boost"*. Both are
// multipliers in `content/aircraft/hoverjet.json`, resolved here through the
// SAME loader the game boards with (`resolveVariant`), so these tests fly the
// file, not a copy of it.
//
// RELATIONSHIPS, not values (trap 24): every number below is MEASURED on the
// shipped `stepHoverJet` for the variant and for `standard`, and compared. A
// re-extraction that corrects 2016's torque moves both sides together and
// changes nothing here; a variant that stops being what its name says goes red.
//
// Each block was proved red against the file (DEVIATIONS DEV-381 §6 has the
// factors that did it).

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { resolveVariant } from '@/content/load-aircraft'
import { HOVERJET_FULL_ROLL_RATE } from '@/render/vignette'
import { FIXED_DT } from '@/sim/constants'
import { energySpec } from '@/sim/energy'
import {
  createHoverJet,
  type HoverJetInput,
  type HoverJetSheet,
  hoverJetView,
  noInput,
  stepHoverJet,
} from '@/sim/hoverjet'
import { rotateVec3Inverse } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'

const ANNIVERSARY = JSON.parse(
  fs.readFileSync('content/editions/anniversary.json', 'utf8'),
) as Edition

/** The view the game boards `?variant=<id>` with on Anniversary. */
const viewOf = (id: string): HoverJetSheet => {
  const v = resolveVariant('hoverjet', id, ANNIVERSARY)
  // A request the file does not answer flies standard with a note; that would
  // make every comparison below standard against itself, and pass.
  if (v.id !== id) throw new Error(`hoverjet.json has no "${id}": ${v.note}`)
  return hoverJetView(v.scale)
}

const STANDARD = viewOf('standard')
const ACROBAT = viewOf('acrobat')
const SPEED = viewOf('speed')

const ticks = (seconds: number): number => Math.round(seconds / FIXED_DT)

/** A launched jet at full throttle, settled at its cruise terminal. */
const cruising = (sheet: HoverJetSheet, input: HoverJetInput) => {
  const jet = createHoverJet(sheet)
  jet.launched = true
  input.throttle = 1
  for (let i = 0; i < ticks(20); i++) stepHoverJet(jet, input)
  return jet
}

/**
 * Full stick on one axis from level cruise: the settled BODY-frame rate, in
 * rad/s, and the time to 63.2 % of it. Body axes: pitch x, yaw y, roll z.
 */
const fullStick = (sheet: HoverJetSheet, axis: 'roll' | 'pitch' | 'yaw') => {
  const input = noInput()
  const jet = cruising(sheet, input)
  input[axis] = 1
  const component = axis === 'roll' ? 'z' : axis === 'pitch' ? 'x' : 'y'
  const body = v3()
  const series: number[] = []
  for (let i = 0; i < ticks(6); i++) {
    stepHoverJet(jet, input)
    rotateVec3Inverse(body, jet.body.orientation, jet.body.angularVelocity)
    series.push(Math.abs(body[component]))
  }
  const settled = series[series.length - 1] as number
  return {
    rate: settled,
    t63: (series.findIndex((w) => w >= 0.632 * settled) + 1) * FIXED_DT,
  }
}

/** Speed after 40 s at full throttle, boosted or not: the unchained terminal. */
const terminal = (sheet: HoverJetSheet, boost: boolean): number => {
  const input = noInput()
  input.boost = boost
  const jet = cruising(sheet, input)
  for (let i = 0; i < ticks(20); i++) stepHoverJet(jet, input)
  const v = jet.body.velocity
  return Math.hypot(v.x, v.y, v.z)
}

/**
 * The vertical extent of a full-back-stick loop from a settled terminal, m.
 * Gravity is off for a launched jet, so the loop closes on itself and its
 * height is its diameter: how tightly the PATH follows the nose.
 */
const loopDiameter = (sheet: HoverJetSheet, boost: boolean): number => {
  const input = noInput()
  input.boost = boost
  const jet = cruising(sheet, input)
  for (let i = 0; i < ticks(10); i++) stepHoverJet(jet, input)
  input.pitch = -1
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < ticks(12); i++) {
    stepHoverJet(jet, input)
    lo = Math.min(lo, jet.body.position.y)
    hi = Math.max(hi, jet.body.position.y)
  }
  return hi - lo
}

/** Seconds of boost a full Anniversary tank holds, net of its recharge. */
const tankSeconds = (sheet: HoverJetSheet): number => {
  const spec = energySpec(ANNIVERSARY.gameplay.energy.rechargeScale, sheet)
  return spec.maxEnergy / (spec.burnPerSecond - spec.rechargePerSecond)
}

const deg = (rad: number): string => `${((rad * 180) / Math.PI).toFixed(1)} deg/s`

describe('the acrobat is more nimble (Matt: "more nimble")', () => {
  const std = fullStick(STANDARD, 'roll')
  const acro = fullStick(ACROBAT, 'roll')

  it('rolls at least 1.3x faster at full stick', () => {
    expect(acro.rate, `${deg(acro.rate)} against ${deg(std.rate)}`).toBeGreaterThanOrEqual(
      1.3 * std.rate,
    )
  })

  it('gets there sooner: 63 % of its roll rate in at most 0.85x the time', () => {
    expect(
      acro.t63,
      `${acro.t63.toFixed(3)} s against ${std.t63.toFixed(3)} s`,
    ).toBeLessThanOrEqual(0.85 * std.t63)
  })

  it('pitches and yaws faster too, so it is nimble on every axis', () => {
    for (const axis of ['pitch', 'yaw'] as const) {
      const a = fullStick(ACROBAT, axis).rate
      const s = fullStick(STANDARD, axis).rate
      expect(a, `${axis}: ${deg(a)} against ${deg(s)}`).toBeGreaterThan(s)
    }
  })

  it('and its path follows the nose: a tighter loop at cruise', () => {
    const a = loopDiameter(ACROBAT, false)
    const s = loopDiameter(STANDARD, false)
    expect(a, `${a.toFixed(0)} m against ${s.toFixed(0)} m`).toBeLessThan(0.85 * s)
  })

  it('PAYS for it in top speed — a trade-off, not an upgrade (§11 call 1)', () => {
    expect(terminal(ACROBAT, false)).toBeLessThan(terminal(STANDARD, false))
    expect(terminal(ACROBAT, true)).toBeLessThan(terminal(STANDARD, true))
  })
})

describe('the speed jet is faster, and its boost is insane (Matt: "faster top speed. insane boost")', () => {
  const stdCruise = terminal(STANDARD, false)
  const stdBoost = terminal(STANDARD, true)

  it('cruises at least 1.15x faster', () => {
    const v = terminal(SPEED, false)
    expect(v, `${v.toFixed(1)} m/s against ${stdCruise.toFixed(1)}`).toBeGreaterThanOrEqual(
      1.15 * stdCruise,
    )
  })

  it('boosts to at least 1.6x the standard boosted terminal', () => {
    const v = terminal(SPEED, true)
    expect(v, `${v.toFixed(1)} m/s against ${stdBoost.toFixed(1)}`).toBeGreaterThanOrEqual(
      1.6 * stdBoost,
    )
  })

  it('PAYS for it: less rotation, a wider loop, and a tank that empties sooner', () => {
    expect(fullStick(SPEED, 'roll').rate).toBeLessThan(fullStick(STANDARD, 'roll').rate)
    expect(loopDiameter(SPEED, false)).toBeGreaterThan(loopDiameter(STANDARD, false))
    const s = tankSeconds(SPEED)
    const t = tankSeconds(STANDARD)
    expect(s, `${s.toFixed(2)} s of boost against ${t.toFixed(2)} s`).toBeLessThan(t)
  })
})

describe('the comfort vignette measures an ABSOLUTE rate, and a variant does not move it (§1.3)', () => {
  // `render/vignette.ts`'s full rate is 2016's sheet on purpose: the vignette
  // answers "how nauseogenic is this rotation", and an acrobat rolling at
  // 118 deg/s should close it harder than a standard at 86 — not by the same
  // fraction of its own envelope. "Fixing" it to follow the variant would
  // quietly hand the acrobat a weaker vignette.
  it('stays the sheet rate with the acrobat loaded, and the acrobat exceeds it', () => {
    const acro = fullStick(ACROBAT, 'roll').rate
    const std = fullStick(STANDARD, 'roll').rate
    // Measured from cruise rather than from rest, so to 1e-4 rad/s rather than
    // the 1e-9 `comfort-vignette.test.ts` pins it to from rest.
    expect(HOVERJET_FULL_ROLL_RATE).toBeCloseTo(std, 4)
    expect(acro).toBeGreaterThan(1.3 * HOVERJET_FULL_ROLL_RATE)
  })
})
