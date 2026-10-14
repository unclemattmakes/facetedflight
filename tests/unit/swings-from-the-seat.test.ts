// tests/unit/swings-from-the-seat.test.ts: the premise for NOT trimming the
// vapour cone in a headset. DEV-934 (lever 5 of
// docs/plan/ANNIVERSARY-VR-FRAMERATE.md).
//
// A headset always flies from the seat: the chase camera refuses while a
// session presents (`boot/settings.ts`, `cameraView`). The lead asked for a VR
// alpha or rate scale on the three new swings "if one is cheap". Alpha moves
// no pixel's cost, so only a rate could buy fill, and a rate buys fill only
// for particles the eye can see. This holds the geometry that says the vapour
// cone is not among them: every puff is born, and lives out its life, BEHIND
// the cockpit eye, so a player looking forward never draws one. If this goes
// red (the cone moved forward, or the eye moved aft), the DEV-934 row's
// reason for leaving the cone alone in VR is gone and the trim is worth
// pricing again.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { EYE } from '@/game/flight'
import { vapourConePose, vapourConeSpec } from '@/game/particle-fx'
import { createParticleField, particleAttribute } from '@/render/particles'
import anniversaryJson from '../../content/editions/anniversary.json'

const VAPOUR = (anniversaryJson as unknown as Edition).fx.vapourCone
const camera = new THREE.PerspectiveCamera()

describe('DEV-934: the vapour cone, seen from the seat', () => {
  it('is born and dies behind the cockpit eye (+Z is aft in the ship frame)', () => {
    // The ship at the origin, unturned: its frame IS the world frame here, so
    // a particle's z is its station fore and aft and EYE.z is the eye's.
    const field = createParticleField(vapourConeSpec(VAPOUR), new THREE.Texture(), {
      capacity: 500,
    })
    const e = field.addEmitter()
    e.matrix.copy(vapourConePose(VAPOUR, new THREE.Matrix4()))
    field.update(0, camera)
    e.play()
    let seen = 0
    // Step through more than a lifetime, emitting the whole time.
    for (let t = 0; t < VAPOUR.lifetime * 1.5; t += 0.01) {
      field.update(0.01, camera)
      const pa = particleAttribute(field, 'iPosition')
      for (let i = 0; i < field.alive; i++) {
        const z = pa.getZ(i)
        seen += 1
        // Behind the eye along the line of flight, so outside any forward view
        // whatever the lens's field: the angle off the eye's forward is > 90.
        expect(z, 'a vapour puff forward of the eye').toBeGreaterThan(EYE.z)
      }
    }
    expect(seen, 'the cone emitted').toBeGreaterThan(50)
    field.dispose()
  })
})
