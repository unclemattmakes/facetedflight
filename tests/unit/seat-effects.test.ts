// tests/unit/seat-effects.test.ts — the JumpSeat flies with its own effects (DEV-416).
//
// 2016's seat carries four scripted effects: `Thruster.thruster_fx` and
// `boost_fx`, `HoverMotor.ground_fx` and `JumpSeat_EffectsManager.windEffects`.
// The port flew it with the HoverJet's systems instead. Directions are tested
// against the SHEET's own thrust direction, not against a rotation I believe.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type ExtractedParticle, emitterLocalMatrix, jumpSeatEffectSpecs } from '@/game/particle-fx'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { createParticleField } from '@/render/particles'

const SEAT = JUMPSEAT as unknown as {
  readonly effects: { readonly minWindEffectSpeed: number; readonly componentEnabled: boolean }
  readonly thruster: { readonly thrustDirection: { x: number; y: number; z: number } }
}

/**
 * The mean UNIT LAUNCH velocity of a system's particles, in the ship's frame.
 * Gravity is zeroed on a copy: a particle that has been falling for half a
 * second points down whatever it was launched at, which would pass the
 * exhaust test for any nozzle.
 */
const meanDirection = (spec: ExtractedParticle): { mean: THREE.Vector3; n: number } => {
  const launch = { ...spec, initial: { ...spec.initial, gravityModifier: 0 } } as ExtractedParticle
  const field = createParticleField(launch, new THREE.Texture(), { capacity: 2000 })
  const e = field.addEmitter()
  e.matrix.copy(emitterLocalMatrix(spec))
  e.play()
  const camera = new THREE.PerspectiveCamera()
  for (let k = 0; k < 60 && field.alive < 60; k++) field.update(0.02, camera)
  const attr = (field.object as THREE.Mesh).geometry.getAttribute('iVelocity')
  const mean = new THREE.Vector3()
  const v = new THREE.Vector3()
  const n = field.alive
  for (let i = 0; i < n; i++) mean.add(v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).normalize())
  if (n > 0) mean.divideScalar(n)
  field.dispose()
  return { mean, n }
}

describe("the seat's own effects, off the sheet", () => {
  const specs = jumpSeatEffectSpecs()

  it('names each script reference with its children, as Play() starts them', () => {
    expect(specs.thruster.map((s) => s.name)).toEqual([
      'fx_thruster_gameplay 2 (1)',
      'fx_thruster_gameplay 2 (2)',
      'fx_thruster_gameplay 2 (3)',
    ])
    expect(specs.boost[0]?.name).toBe('fx_afterburner_gameplay 2 (4)')
    expect(specs.boost).toHaveLength(6)
    expect(specs.ground.map((s) => s.name)).toEqual(['fx_ground', 'fx_ground (1)'])
    expect(specs.wind.map((s) => s.name)).toEqual(['flight_particles'])
  })

  it("winds at the PREFAB's 7 m/s, not the HoverJet's effects speed", () => {
    // The HoverJet's `minEffectsSpeed` is what the seat flew on before DEV-416.
    // The C# field has no initialiser; 7 is the prefab's.
    expect(SEAT.effects.componentEnabled).toBe(true)
    expect(SEAT.effects.minWindEffectSpeed).toBe(7)
    const hoverjet = (HOVERJET.ship as unknown as { minEffectsSpeed: number }).minEffectsSpeed
    expect(hoverjet).not.toBe(SEAT.effects.minWindEffectSpeed)
  })
})

describe('which way they spray (geometry against the sheet)', () => {
  const specs = jumpSeatEffectSpecs()
  // Unity to three flips z; the sheet's thrust direction is Unity space.
  const t = SEAT.thruster.thrustDirection
  const thrust = new THREE.Vector3(t.x, t.y, -t.z).normalize()

  // Below the horizontal by at least ~15 degrees. Not "straight down": the
  // nozzles splay. Measured at launch: 52-58 degrees below the horizontal, and
  // the third nozzle (each group's `(3)`) 26.
  for (const spec of [...specs.thruster, ...specs.boost]) {
    it(`${spec.name}: exhaust leaves AGAINST the thrust`, () => {
      const { mean, n } = meanDirection(spec)
      expect(n).toBeGreaterThan(20)
      expect(mean.dot(thrust)).toBeLessThan(-0.25)
    })
  }

  it('would not, pointed along its bare cone, so the test can fail', () => {
    const lead = specs.thruster[0] as ExtractedParticle
    const bare = { ...lead, rotation: [0, 0, 0, 1] } as ExtractedParticle
    expect(meanDirection(bare).mean.dot(thrust)).toBeGreaterThan(-0.25)
  })

  it('kicks the ground dust UP, and fans its child out FLAT along the ground', () => {
    // Measured at launch: the lead leaves 75 degrees up, the child 0.3.
    const [lead, fan] = specs.ground as [ExtractedParticle, ExtractedParticle]
    const up = meanDirection(lead)
    expect(up.n).toBeGreaterThan(20)
    expect(up.mean.dot(thrust) / up.mean.length()).toBeGreaterThan(0.8)
    const flat = meanDirection(fan)
    expect(flat.n).toBeGreaterThan(20)
    expect(Math.abs(flat.mean.dot(thrust) / flat.mean.length())).toBeLessThan(0.1)
  })
})
