// tests/unit/cockpit-body.test.ts — where the pilot is, measured off the meshes.
//
// DEV-088. Every assertion here is a DISTANCE or an EXTENT taken from geometry
// that was actually built, never a transform read back from the thing that set
// it: the orientation lesson's short version is *test the geometry, not the
// rotation*, because a quaternion assertion is your belief written twice. Four
// orientation bugs in this port, three of them caught by Matt from a screenshot
// rather than by a green suite.
//
// The three invariants this feature could break, and all three are here:
//
//   * it must sit BELOW the eye line — a body at eye height is a body you are
//     inside;
//   * it must stay inside the hull — a knee through the canopy is the failure
//     everyone would see first;
//   * no vertex may come inside the 0.08 m near plane, which is the reason
//     the cockpit is comfortable
//     at all (research 05 R4).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EditionCockpitBody } from '@/content/edition-schema'
import { EYE } from '@/game/flight'
import { HOVERJET } from '@/generated/constants.generated'
import { buildCockpitBody, FLOOR_BELOW_EYE } from '@/render/cockpit-body'

/** The near plane `game/flight.ts`'s header fixes at 0.08 m. */
const NEAR_PLANE = 0.08

const PRESET: EditionCockpitBody = {
  enabled: true,
  hands: true,
  offset: [0, 0, 0],
  palette: {
    seat: [0.055, 0.062, 0.075],
    trim: [0.26, 0.06, 0.016],
    suit: [0.105, 0.115, 0.135],
    glove: [0.03, 0.031, 0.035],
  },
}

/**
 * Every world vertex of the built body, in EYE-LOCAL ship space.
 *
 * Built by actually composing the matrices three would compose, which is the
 * only way the answer describes the thing that will be drawn rather than the
 * arithmetic the builder did.
 */
const vertices = (body: { object: THREE.Object3D }): THREE.Vector3[] => {
  body.object.updateMatrixWorld(true)
  const out: THREE.Vector3[] = []
  const v = new THREE.Vector3()
  body.object.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible) return
    // A hidden ancestor hides the mesh too, and `visible` does not compose.
    for (let p: THREE.Object3D | null = mesh.parent; p; p = p.parent) if (!p.visible) return
    const position = mesh.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      out.push(v.clone())
    }
  })
  return out
}

const built = () => {
  const body = buildCockpitBody()
  body.set(PRESET)
  return body
}

describe('the body sits where a pilot sits', () => {
  it('is entirely below the eye line', () => {
    const body = built()
    const ys = vertices(body).map((v) => v.y)
    expect(ys.length).toBeGreaterThan(100)
    const top = Math.max(...ys)
    // Below, and by enough that the lean cannot push it up into the view: the
    // whole assembly hangs off `art_pivot`, which rolls +-5.25 degrees, and at
    // the body's ~0.3 m radius that is about 30 mm of swing.
    expect(top).toBeLessThan(-0.15)
    // And it is not a smear: the pilot occupies a body's worth of height.
    expect(Math.min(...ys)).toBeLessThan(-1.2)
  })

  it('stands on the MEASURED cockpit floor, 1.322 m below the eye', () => {
    // The one anchor here that is measured rather than chosen: the chair's mesh
    // origin is 1.322 m below the eye and the Mixamo pilot's is 1.323 m below
    // it, from two independent transform chains in the shipped prefab. The
    // boots' soles land on that plane.
    const lowest = Math.min(...vertices(built()).map((v) => v.y))
    expect(lowest).toBeCloseTo(-FLOOR_BELOW_EYE, 3)
  })

  it('has a human shin, which is what makes the chosen seat pan defensible', () => {
    // The pan is NOT measured — 2016's chair mesh cannot ship and its geometry
    // is not in the prefab. What makes the number honest is the relationship it
    // implies: floor to pan is the length of a shin plus a boot sole. Assert
    // the relationship, not the number (trap 24).
    const body = built()
    body.object.updateMatrixWorld(true)
    const pan = body.object.getObjectByName('seat_pan')
    expect(pan).toBeDefined()
    const panY = new THREE.Vector3().setFromMatrixPosition((pan as THREE.Object3D).matrixWorld).y
    const shin = panY + FLOOR_BELOW_EYE
    expect(shin).toBeGreaterThan(0.4)
    expect(shin).toBeLessThan(0.55)
  })

  it('never comes inside the 0.08 m near plane', () => {
    const distances = vertices(built()).map((v) => v.length())
    const nearest = Math.min(...distances)
    expect(nearest).toBeGreaterThan(NEAR_PLANE)
    // Reported as a real margin rather than a pass by a millimetre: the lean
    // and the buffet both move this assembly relative to a still head.
    expect(nearest).toBeGreaterThan(0.2)
  })

  it('is a seated human and not a ship-sized one', () => {
    // The bound the hull test below cannot give, because the hull is four
    // metres wide: a body that arrived 100x too big (the FBX centimetre trap)
    // or 100x too small would still be "inside the hull". A seated adult is
    // about a metre tall, two-thirds of a metre wide and a metre deep, and this
    // is the envelope that says so.
    const box = new THREE.Box3().setFromPoints(vertices(built()))
    const size = box.getSize(new THREE.Vector3())
    expect(size.y).toBeGreaterThan(0.8)
    expect(size.y).toBeLessThan(1.15)
    expect(size.x).toBeGreaterThan(0.4)
    expect(size.x).toBeLessThan(0.75)
    expect(size.z).toBeGreaterThan(0.6)
    expect(size.z).toBeLessThan(1.1)
  })

  it('stays inside the ship hull the sheet describes', () => {
    // The extent of every enabled collider on `HOVERJET.shipCollisionColliders`,
    // grown by its own radius or half-extents, in SHIP space — the sheet's
    // centres are Unity's, so z flips. This is a real outer bound on the hull
    // and it needs no gitignored asset to compute, which is the other half of
    // the requirement (a test that reads `public/assets/` is a test that is red
    // in CI and only in CI).
    //
    // NOT `hullFromColliders`, which is the same set reduced to one sphere
    // each — and reduced DOWNWARD, taking a box's INSCRIBED sphere so the hull
    // does not grow the ship at its corners. Measured: the boots sit 0.19 m
    // outside that reduction, which is a property of the reduction and not of
    // the boots. Extents are what the word means and what this needs.
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity)
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (const c of HOVERJET.shipCollisionColliders) {
      if (!c.enabled) continue
      const e = c.effective as {
        radius?: number
        halfExtents?: { x: number; y: number; z: number }
      }
      const half =
        e.halfExtents !== undefined
          ? new THREE.Vector3(e.halfExtents.x, e.halfExtents.y, e.halfExtents.z)
          : new THREE.Vector3(e.radius ?? 0, e.radius ?? 0, e.radius ?? 0)
      const centre = new THREE.Vector3(
        c.centerInShipRootSpace.x,
        c.centerInShipRootSpace.y,
        -c.centerInShipRootSpace.z,
      )
      lo.min(centre.clone().sub(half))
      hi.max(centre.clone().add(half))
    }
    // Sanity on the bound itself, so a sheet that lost its colliders fails here
    // rather than passing an empty box.
    expect(hi.y - lo.y).toBeGreaterThan(1)

    for (const v of vertices(built())) {
      const ship = v.clone().add(EYE)
      expect(ship.x, `x at ${ship.toArray()}`).toBeGreaterThanOrEqual(lo.x)
      expect(ship.x, `x at ${ship.toArray()}`).toBeLessThanOrEqual(hi.x)
      expect(ship.y, `y at ${ship.toArray()}`).toBeGreaterThanOrEqual(lo.y)
      expect(ship.y, `y at ${ship.toArray()}`).toBeLessThanOrEqual(hi.y)
      expect(ship.z, `z at ${ship.toArray()}`).toBeGreaterThanOrEqual(lo.z)
      expect(ship.z, `z at ${ship.toArray()}`).toBeLessThanOrEqual(hi.z)
    }
  })

  it('puts both hands ON their controls, not near them', () => {
    // The part of a procedural body that goes wrong first is the arms: a
    // forearm that misses its grip reads as a broken puppet. A distance between
    // two built meshes is the assertion; the angles that produced it are not.
    const body = built()
    body.object.updateMatrixWorld(true)
    const at = (name: string): THREE.Vector3 => {
      const node = body.object.getObjectByName(name)
      expect(node, name).toBeDefined()
      return new THREE.Vector3().setFromMatrixPosition((node as THREE.Object3D).matrixWorld)
    }
    expect(at('pilot_hand_r').distanceTo(at('control_stick_grip'))).toBeLessThan(0.02)
    expect(at('pilot_hand_l').distanceTo(at('control_throttle'))).toBeLessThan(0.06)
    // And the forearms reach them: a forearm is between 0.2 and 0.4 m long, so
    // an elbow that is 0.6 m from its hand means the limb was drawn to the
    // wrong point.
    for (const side of ['r', 'l'] as const) {
      const forearm = body.object.getObjectByName(`pilot_forearm_${side}`) as THREE.Mesh
      forearm.geometry.computeBoundingBox()
      const length = (forearm.geometry.boundingBox as THREE.Box3).getSize(new THREE.Vector3()).y
      expect(length, `forearm ${side}`).toBeGreaterThan(0.18)
      expect(length, `forearm ${side}`).toBeLessThan(0.45)
    }
  })

  it('drops the arms and the controls when `hands` is off, and keeps the seat', () => {
    // The escape hatch has to actually work: a body that is wrong is worse than
    // none, and the seat and legs must stand on their own without the arms.
    const body = buildCockpitBody()
    body.set({ ...PRESET, hands: false })
    const names = new Set<string>()
    body.object.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) names.add(n.name)
    })
    const shown = vertices(body)
    expect(names.has('pilot_hand_r')).toBe(true)
    for (const v of shown) expect(v.length()).toBeGreaterThan(NEAR_PLANE)
    // The arms group is hidden, so none of its vertices are in the drawn set.
    const withHands = built()
    expect(shown.length).toBeLessThan(vertices(withHands).length)
    expect(body.object.getObjectByName('cockpit_body_arms')?.visible).toBe(false)
    // The seat and a leg are still there.
    expect(body.object.getObjectByName('seat_pan')?.visible).toBe(true)
    expect(body.object.getObjectByName('pilot_shin_r')).toBeDefined()
  })

  it('takes its colours from the preset and nowhere else', () => {
    const body = buildCockpitBody()
    body.set({
      ...PRESET,
      palette: { seat: [1, 0, 0], trim: [0, 1, 0], suit: [0, 0, 1], glove: [0.5, 0.5, 0.5] },
    })
    const colourOf = (name: string): THREE.Color =>
      ((body.object.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial)
        .color
    expect(
      colourOf('seat_pan').getRGB(new THREE.Color(), THREE.LinearSRGBColorSpace).r,
    ).toBeCloseTo(1, 5)
    expect(
      colourOf('pilot_torso').getRGB(new THREE.Color(), THREE.LinearSRGBColorSpace).b,
    ).toBeCloseTo(1, 5)
  })
})
