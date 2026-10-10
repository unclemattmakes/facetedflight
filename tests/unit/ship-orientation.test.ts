// tests/unit/ship-orientation.test.ts — which way the ship faces.
//
// Matt, looking at one screenshot: *"looks like it's flying backwards?"* He was
// right, and the reason is worth a test rather than a fix.
//
// ── Two wrongs that made one right-looking ship ───────────────────────────
//
// Every mesh out of `tools/assets/convert-fbx.py` arrived MIRRORED IN X
// (provenance trap 11). The cockpit is exactly symmetric in z — measured on the
// GLB, -3.083 to 3.083, against an asymmetric -3.162 to 3.653 in x — so z is the
// beam and x is the fore-aft axis. And for a mesh symmetric in z, a mirror in x
// IS a 180-degree yaw:
//
//     M_x = R_y(180) · M_z,  and  M_z · C = C,  so  M_x · C = R_y(180) · C
//
// So the mesh arrived already turned around. `SHIP_MODEL_YAW` was then
// established by eye against THAT mesh, picked the value that turned it back,
// and was "confirmed" by finding the same number in the prefab. The number
// agreed; the reasoning did not. Un-mirroring the mesh removed one error and
// left the other standing, and the ship flew backwards.
//
// ── The rule the fix actually follows ─────────────────────────────────────
//
// Our world is Unity's mirrored in z, and that flip is a conjugation: it negates
// a quaternion's x and y, turning a Unity yaw of θ into a three yaw of −θ. Every
// POSITION on this ship is converted — the prefab's (0, 1.03, -1.27) is `EYE`'s
// (0, 0.86, 1.27) — and the rotation was the one thing that was not.
//
// So this suite does not assert "+90 because it looks right". It asserts that
// the rotation goes through the SAME conversion the positions do, which is a
// statement that stays true if the prefab value ever changes.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ART_POSITION, EYE, SHIP_MODEL_YAW } from '@/game/flight'
import { flipQuaternion } from '@/render/unity-space'

/** `Art/FirstPerson`'s authored yaw in the shipped prefab, in UNITY space. */
const PREFAB_ART_YAW_DEG = -90

describe('the art yaw', () => {
  it('is the prefab yaw put through the SAME flip the positions get', () => {
    const unity = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      (PREFAB_ART_YAW_DEG * Math.PI) / 180,
    )
    const three = new THREE.Quaternion()
    flipQuaternion(three, unity)
    const yaw = new THREE.Euler().setFromQuaternion(three, 'YXZ').y
    expect(yaw).toBeCloseTo(SHIP_MODEL_YAW, 9)
  })

  it("is +90, not the prefab's -90 — the sign IS the conversion", () => {
    // Stated as a value too, because the whole bug was a number that looked
    // right next to the source and was not.
    expect(SHIP_MODEL_YAW).toBeCloseTo(Math.PI / 2, 9)
    expect(SHIP_MODEL_YAW).not.toBeCloseTo((PREFAB_ART_YAW_DEG * Math.PI) / 180, 3)
  })

  it('converts the positions the same way, which is how we know the rule', () => {
    // The prefab's world z for these two nodes is NEGATIVE; the code's is
    // positive. If either of these ever stops being a z-flip of the source, the
    // rotation above is following a rule the rest of the node has abandoned.
    expect(EYE.z).toBeCloseTo(1.27, 6)
    expect(ART_POSITION.z).toBeCloseTo(1.336, 6)
    // And the flip leaves x and y alone.
    expect(EYE.x).toBeCloseTo(0, 6)
    expect(EYE.y).toBeCloseTo(0.86, 6)
  })
})
