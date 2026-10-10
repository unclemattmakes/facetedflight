// tests/unit/speed-lines.test.ts — the 2016 speed lines, and the one thing the
// Anniversary preset is allowed to do to them.
//
// **What this file can claim.** That the re-authoring is confined to the four
// numbers it says it is; that the Classic path builds a field which is the 2016
// material in every respect the engine can be asked about; that the comfort
// slider scales the deviation rather than switching it; and that the three
// BOOST systems are the ones that get it.
//
// **What it cannot claim.** That the streaks read. Nobody has A/B'd the 2016
// build against this one (ANNIVERSARY.md §2.3 item 3 says as much: the
// bloom-dependence is a hypothesis), and "0.3 m of soft streak is visible at
// 100 m" is a statement about a headset, not about a Float32Array. §2.6's
// warning — that the features which create a sense of speed are the features
// that make people ill — is settled by wearing it, and by three external
// testers on the Anniversary preset separately from Classic.
//
// The width assertions go through `evaluateMinMax` on the GENERATED spec rather
// than a typed-in 5-8 cm, because the point of the exercise is that the
// authored size is not ours to write down (hard rule 3, and DEV-069: import the
// key and assert against it).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EditionSpeedLines } from '@/content/edition-schema'
import { speedLineLift, speedLineOverride } from '@/game/particle-fx'
import { HOVERJET } from '@/generated/constants.generated'
import {
  ADDITIVE_TINT_GAIN,
  createParticleField,
  evaluateMinMax,
  type MinMaxCurveLike,
  NO_OVERRIDE,
  type ParticleOverride,
  type ParticleSpec,
} from '@/render/particles'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

interface ShipParticle extends ParticleSpec {
  readonly fileId: string
}
const SHIP = HOVERJET.particles as unknown as ShipParticle[]
const named = (name: string): ShipParticle => {
  const p = SHIP.find((s) => s.name === name)
  if (!p) throw new Error(`no ${name} in the sheet`)
  return p
}

const ANNIVERSARY = anniversary.fx.speedLines as unknown as EditionSpeedLines
const CLASSIC = classic.fx.speedLines as unknown as EditionSpeedLines

/** A material's uniforms, without pretending to know three's types. */
const uniformsOf = (m: THREE.Material): Record<string, { value: unknown }> =>
  (m as THREE.ShaderMaterial).uniforms as Record<string, { value: unknown }>

const fieldFor = (spec: ParticleSpec, override: Partial<ParticleOverride> | null = null) =>
  createParticleField(spec, new THREE.Texture(), { capacity: 32, override })

describe('the authored streak, off the sheet', () => {
  it('is 5-8 cm wide on all three boost stages — which is the whole problem', () => {
    for (const name of ['boost_particles', 'fasterBoost', 'ludacrisSpeed']) {
      const size = named(name).initial?.size as MinMaxCurveLike
      // Mode 3: `scalar * (min + (max - min) * r)`, so the two ends are the
      // narrowest and widest a particle of this system can be.
      const lo = evaluateMinMax(size, 0, 0)
      const hi = evaluateMinMax(size, 0, 1)
      expect(lo, name).toBeCloseTo(0.05, 3)
      expect(hi, name).toBeCloseTo(0.08, 3)
    }
  })

  it('is a STRETCH system on all four, and flight_particles is the mote', () => {
    // The reason `flight_particles` is DEV-080's business and not DEV-079's: it
    // is stretch-mode too, but `velocityScale` 0 and `lengthScale` 1 make its
    // length its size. A square, not a streak.
    const flight = named('flight_particles')
    expect(flight.renderer?.mode).toBe('stretch')
    expect(flight.renderer?.velocityScale).toBe(0)
    expect(flight.renderer?.lengthScale).toBe(1)
    for (const name of ['boost_particles', 'fasterBoost', 'ludacrisSpeed']) {
      const r = named(name).renderer
      expect(r?.mode, name).toBe('stretch')
      expect(r?.velocityScale, name).toBeGreaterThan(0)
    }
  })
})

describe('Classic builds the 2016 material', () => {
  it('leaves every uniform at the value the shader used to hard-code', () => {
    const field = fieldFor(named('boost_particles'))
    const u = uniformsOf((field.object as THREE.Mesh).material as THREE.Material)
    expect(field.override).toEqual(NO_OVERRIDE)
    expect(u.uWidthScale?.value).toBe(1)
    expect(u.uAlphaScale?.value).toBe(1)
    expect(u.uSoft?.value).toBe(0)
    expect(u.uCore?.value).toBe(0)
    // The x2 of Unity's Particles/Additive. Dropping it halves every particle
    // in the game, which is why it is asserted rather than assumed.
    expect(u.uGain?.value).toBe(ADDITIVE_TINT_GAIN)
    field.dispose()
  })

  it('is additive, depth-tested, and does not write depth', () => {
    const field = fieldFor(named('boost_particles'))
    const m = (field.object as THREE.Mesh).material as THREE.Material
    expect(m.blending).toBe(THREE.AdditiveBlending)
    expect(m.premultipliedAlpha).toBe(false)
    expect(m.depthWrite).toBe(false)
    expect(m.depthTest).toBe(true)
    field.dispose()
  })

  it('builds the SAME field with the preset off as with no preset at all', () => {
    // The guard the brief asked for, and the one that matters: Classic's flag
    // is off, so `speedLineOverride` returns null, so the field it constructs
    // is the one that existed before the preset did.
    expect(speedLineOverride(CLASSIC, 1)).toBeNull()
    const bare = fieldFor(named('fasterBoost'))
    const off = fieldFor(named('fasterBoost'), speedLineOverride(CLASSIC, 1))
    expect(off.override).toEqual(bare.override)
    const a = uniformsOf((bare.object as THREE.Mesh).material as THREE.Material)
    const b = uniformsOf((off.object as THREE.Mesh).material as THREE.Material)
    for (const key of ['uWidthScale', 'uAlphaScale', 'uSoft', 'uCore', 'uGain']) {
      expect(b[key]?.value, key).toBe(a[key]?.value)
    }
    bare.dispose()
    off.dispose()
  })
})

describe('Anniversary re-authors the width, and only the width', () => {
  it('scales the rendered width by the preset number and nothing else', () => {
    const override = speedLineOverride(ANNIVERSARY, 1)
    expect(override?.widthScale).toBe(ANNIVERSARY.widthScale)
    const field = fieldFor(named('boost_particles'), override)
    const u = uniformsOf((field.object as THREE.Mesh).material as THREE.Material)
    expect(u.uWidthScale?.value).toBe(ANNIVERSARY.widthScale)
    field.dispose()
  })

  it('lands in the 0.25-0.4 m the eye can measure at 100 m', () => {
    // Derived, not typed in: the authored size off the sheet times the preset's
    // multiplier. DEV-027's rule — say what the number is the width OF.
    const size = named('boost_particles').initial?.size as MinMaxCurveLike
    const lo = evaluateMinMax(size, 0, 0) * ANNIVERSARY.widthScale
    const hi = evaluateMinMax(size, 0, 1) * ANNIVERSARY.widthScale
    expect(lo).toBeGreaterThanOrEqual(0.2)
    expect(hi).toBeLessThanOrEqual(0.45)
  })

  it('does not touch the spec: rate, speed, lifetime and length stay generated', () => {
    const spec = named('ludacrisSpeed')
    const before = JSON.stringify(spec)
    const field = fieldFor(spec, speedLineOverride(ANNIVERSARY, 1))
    // The spec object the field carries IS the generated one, unmutated. An
    // override that edited its way to a wider streak would show up right here.
    expect(field.spec).toBe(spec)
    expect(JSON.stringify(spec)).toBe(before)
    field.dispose()
  })

  it('goes over the sky instead of adding to it, and drops the additive x2', () => {
    const field = fieldFor(named('boost_particles'), speedLineOverride(ANNIVERSARY, 1))
    const m = (field.object as THREE.Mesh).material as THREE.Material
    const u = uniformsOf(m)
    expect(m.blending).toBe(THREE.NormalBlending)
    expect(m.premultipliedAlpha).toBe(true)
    // A doubled colour saturates to white, and then a dark core cannot darken.
    expect(u.uGain?.value).toBe(1)
    expect(u.uSoft?.value).toBe(1)
    expect(u.uCore?.value).toBeGreaterThan(0)
    // Still not writing depth. Whatever else changes, a particle occluding the
    // terrain behind it does not.
    expect(m.depthWrite).toBe(false)
    field.dispose()
  })

  it('puts a field back to 2016 on a flip, blend and all', () => {
    const field = fieldFor(named('boost_particles'), speedLineOverride(ANNIVERSARY, 1))
    field.setOverride(speedLineOverride(CLASSIC, 1))
    const m = (field.object as THREE.Mesh).material as THREE.Material
    expect(field.override).toEqual(NO_OVERRIDE)
    expect(m.blending).toBe(THREE.AdditiveBlending)
    expect(m.premultipliedAlpha).toBe(false)
    expect(uniformsOf(m).uGain?.value).toBe(ADDITIVE_TINT_GAIN)
    field.dispose()
  })
})

describe('the comfort slider scales the deviation, not the effect', () => {
  it('draws 2016 at off, half the extra width at light, all of it at full', () => {
    expect(speedLineOverride(ANNIVERSARY, 0)).toBeNull()
    const light = speedLineOverride(ANNIVERSARY, 0.5)
    const full = speedLineOverride(ANNIVERSARY, 1)
    // HALF THE EXTRA, not half the width: at `light` the streak is still wider
    // than 2016's, which is the point of a slider between two known ends.
    expect(light?.widthScale).toBeCloseTo(1 + (ANNIVERSARY.widthScale - 1) * 0.5, 6)
    expect(light?.widthScale).toBeGreaterThan(1)
    expect(light?.widthScale).toBeLessThan(full?.widthScale as number)
    expect(light?.coreDarkness).toBeCloseTo(ANNIVERSARY.coreDarkness * 0.5, 6)
    expect(light?.alphaScale).toBeCloseTo(1 + (ANNIVERSARY.alphaScale - 1) * 0.5, 6)
  })

  it('is monotonic from 2016 to the preset across the whole slider', () => {
    let last = 1
    for (const k of [0.25, 0.5, 0.75, 1]) {
      const w = speedLineOverride(ANNIVERSARY, k)?.widthScale as number
      expect(w).toBeGreaterThan(last)
      last = w
    }
    expect(last).toBe(ANNIVERSARY.widthScale)
  })
})

describe('the tube is lifted to the eye — the second pass', () => {
  // The measurement behind the knob, off the SHEET rather than typed in: the
  // three boost emitters sit under `Effects` under `shipOffset`, and their axis
  // is below the eye by the sum of those local y's. If the prefab ever moved,
  // this is the assertion that would say the lift no longer means what its
  // description says.
  it('2016 authors the boost tubes 6.6 m below the eye, which is why a lift exists', () => {
    const EYE_Y = 0.86 // `game/flight.ts` EYE, the cockpit eye point in the ship frame
    for (const name of ['boost_particles', 'fasterBoost', 'ludacrisSpeed']) {
      const p = named(name) as unknown as {
        position: readonly number[]
        ancestors: readonly { position: readonly number[] }[]
      }
      const axisY =
        (p.position[1] as number) +
        p.ancestors.slice(0, -1).reduce((y, a) => y + (a.position[1] as number), 0)
      expect(EYE_Y - axisY, name).toBeCloseTo(6.63, 1)
    }
  })

  it('lifts nothing on Classic, at off, or for a disabled preset', () => {
    expect(speedLineLift(CLASSIC, 1)).toBe(0)
    expect(speedLineLift(ANNIVERSARY, 0)).toBe(0)
    expect(speedLineLift({ ...ANNIVERSARY, enabled: false }, 1)).toBe(0)
  })

  it('lifts by the preset number at full and half of it at light', () => {
    expect(speedLineLift(ANNIVERSARY, 1)).toBe(ANNIVERSARY.tubeLift)
    expect(speedLineLift(ANNIVERSARY, 0.5)).toBeCloseTo(ANNIVERSARY.tubeLift * 0.5, 9)
    // And the preset's number puts stage 1's shell (radius 4.63) around the
    // canopy rather than under the floor: the axis lands within a metre of the
    // eye, so the top of the tube clears the glass by roughly its radius.
    expect(Math.abs(ANNIVERSARY.tubeLift - 6.63)).toBeLessThan(1)
  })
})
