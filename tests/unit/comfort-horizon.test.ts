// tests/unit/comfort-horizon.test.ts — the horizon is level, and stays level.
//
// PORT_PLAN §2.9 item 2 asks for *"a faint horizon ring or star layer that does
// not rotate with the ship."* The one property worth a test is the clause after
// the comma, and there is a wrong way and a right way to test it.
//
// The wrong way is to assert the object's quaternion is identity. That is the
// mistake "the orientation lesson" in `docs/DEVIATIONS.md` is about: *"test the
// geometry, not the rotation — a distance or an aspect ratio is true
// independently of what you believed; a quaternion assertion is your belief
// written twice."* Six orientation bugs, five of them caught by Matt from a
// screenshot with 600+ tests green.
//
// So these measure the band's WORLD-SPACE BOUNDING BOX: is it flat, is it
// centred on the eye, is it the radius it claims. And the last test does the
// thing the lesson's corollary asks — *"what case makes my rule and the
// alternative disagree?"* — by hanging the band under a rolled parent and
// showing the measurement goes red. A test that cannot fail is not a test.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { BAND_DEGREES, bandHeight, createHorizon, RADIUS, SEGMENTS } from '@/render/horizon'

/** The band's bounding box in WORLD space, after whatever parenting is in play. */
const worldBox = (object: THREE.Object3D) => {
  object.updateWorldMatrix(true, true)
  return new THREE.Box3().setFromObject(object)
}

describe('the horizon band is level, wherever the eye is', () => {
  it('is a flat disc centred on the eye', () => {
    const horizon = createHorizon()
    // Somewhere real: Simonet is 4 km across and the launch shaft tops out at
    // 127.86 m, so the numbers below are the order of magnitude this actually
    // runs at rather than the origin, where a scaling bug hides.
    const eye = new THREE.Vector3(1873.4, 214.6, -902.1)
    horizon.update(eye)
    const box = worldBox(horizon.object)

    const centre = box.getCenter(new THREE.Vector3())
    expect(centre.x).toBeCloseTo(eye.x, 3)
    expect(centre.y).toBeCloseTo(eye.y, 3)
    expect(centre.z).toBeCloseTo(eye.z, 3)

    const size = box.getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(2 * RADIUS, 2)
    expect(size.z).toBeCloseTo(2 * RADIUS, 2)
    // FLAT: the only vertical extent is the band's own thickness.
    expect(size.y).toBeCloseTo(bandHeight(RADIUS, BAND_DEGREES), 6)
    horizon.dispose()
  })

  it('puts the band ON the eye line, not above or below it', () => {
    // The whole mechanism. A level reference 2 metres below your eyes is a line
    // across the lower third of the view, and the inner ear does not read it as
    // a horizon — it reads it as a floor, which is a thing that can tilt.
    const horizon = createHorizon()
    const eye = new THREE.Vector3(-300, 88.25, 41)
    horizon.update(eye)
    const box = worldBox(horizon.object)
    const half = bandHeight(RADIUS, BAND_DEGREES) / 2
    expect(box.min.y).toBeCloseTo(eye.y - half, 6)
    expect(box.max.y).toBeCloseTo(eye.y + half, 6)
    horizon.dispose()
  })

  it('follows the eye without dragging, over many updates', () => {
    const horizon = createHorizon()
    for (const p of [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(2048, 300, 2048),
      new THREE.Vector3(-17.5, -4.25, 933),
    ]) {
      horizon.update(p)
      const centre = worldBox(horizon.object).getCenter(new THREE.Vector3())
      expect(centre.distanceTo(p)).toBeLessThan(1e-3)
    }
    horizon.dispose()
  })
})

describe('...and the measurement would actually catch it rolling', () => {
  it('goes red when the band is hung under a rolled parent', () => {
    // The disagreement case. Every assertion above passes whether the band is in
    // the scene root or parented to the ship, AS LONG AS THE SHIP IS LEVEL —
    // which is what the agreement lesson warns about: "a rule tested only where
    // two explanations agree has not been tested."
    //
    // Parenting this to the ship is the obvious mistake, because everything else
    // in the cockpit is parented to the ship. So: roll a parent 45 degrees and
    // confirm the flatness measurement stops holding. If this ever passes, the
    // three tests above have stopped being able to fail.
    const horizon = createHorizon()
    const ship = new THREE.Object3D()
    ship.rotation.z = Math.PI / 4
    ship.add(horizon.object)
    horizon.update(new THREE.Vector3(0, 0, 0))

    const size = worldBox(horizon.object).getSize(new THREE.Vector3())
    const flat = bandHeight(RADIUS, BAND_DEGREES)
    // A 45-degree roll lifts one side of a 120 m band ~42 m out of plane.
    expect(size.y).toBeGreaterThan(flat * 100)
    horizon.dispose()
  })
})

describe('the band is big enough to see and cheap enough to leave on', () => {
  it('subtends an angle a person can actually see', () => {
    // DEV-044: "a thing that is too small, too dark, too fast or off-screen has
    // not been reviewed; it has been rendered." The title jets flew backwards
    // for a whole session at four pixels across. A mathematical line would go
    // the same way.
    const subtended = (2 * Math.atan(bandHeight(RADIUS, BAND_DEGREES) / 2 / RADIUS) * 180) / Math.PI
    expect(subtended).toBeCloseTo(BAND_DEGREES, 6)
    expect(BAND_DEGREES).toBeGreaterThan(0.25)
    // ...and small enough to stay a reference rather than becoming scenery.
    expect(BAND_DEGREES).toBeLessThan(2)
  })

  it('is one draw call', () => {
    // §2.9 calls this "the highest-value mitigation available for exactly this
    // locomotion pattern, and one draw call." R6's exit is a DRAW-CALL budget
    // (<= 120 per eye), not a triangle budget, so a ring assembled from 96 line
    // segments would cost 96 of them.
    const horizon = createHorizon()
    let meshes = 0
    horizon.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes += 1
    })
    expect(meshes).toBe(1)
    const geometry = (horizon.object as THREE.Mesh).geometry
    expect(geometry.groups.length).toBeLessThanOrEqual(1)
    // An OPEN cylinder: 2 triangles per segment and no end caps. A closed one is
    // a drum, and a drum puts a lid over the whole world.
    expect(geometry.getIndex()?.count).toBe(SEGMENTS * 6)
    horizon.dispose()
  })

  it('starts hidden, because §2.9 says off by default', () => {
    const horizon = createHorizon()
    expect(horizon.object.visible).toBe(false)
    horizon.setVisible(true)
    expect(horizon.object.visible).toBe(true)
    horizon.dispose()
  })
})
