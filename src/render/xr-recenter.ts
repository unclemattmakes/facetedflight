// src/render/xr-recenter.ts — put the pilot's eyes back where the ship's are.
//
// ── Why a seated cockpit game needs this ──────────────────────────────────
//
// FF2 binds a `local` reference space (`renderer.ts`), whose origin is wherever
// your head was when the session began. That is the right choice for a cockpit —
// `local-floor` would put your head through the canopy roof — but it hands you a
// new problem: the origin is set by an accident of timing. You press Enter VR
// standing up, or leaning at the desk, or mid-turn, and that pose becomes the
// pilot's eye point for the rest of the run.
//
// Recentring re-picks it. `XRReferenceSpace.getOffsetReferenceSpace` returns a
// new space whose origin sits at a given transform IN THE OLD SPACE, so passing
// the viewer's current pose makes the viewer the new origin.
//
// ── Yaw only, and why that is not fussiness ───────────────────────────────
//
// The offset takes the head's POSITION but only its YAW. Inherit pitch and roll
// and the whole world tilts to match however your neck happened to be angled at
// the moment you pressed the button — a horizon that is not level is both wrong
// and, in a vehicle you are already rolling, actively nauseating. Yaw is the one
// component the player means: "forward is over there now."
//
// The maths is separated from the WebXR call for the usual reason: the maths is
// where the bugs are, and it can be tested without a headset or a browser.

import * as THREE from 'three'

export interface Pose {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly orientation: {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly w: number
  }
}

/**
 * The offset transform that makes `viewer` the new origin.
 *
 * Returns the position unchanged and the orientation reduced to its yaw. Feed it
 * to `getOffsetReferenceSpace` and the viewer lands at the origin, level, facing
 * down −Z.
 */
export const recenterOffset = (viewer: Pose): Pose => {
  const q = new THREE.Quaternion(
    viewer.orientation.x,
    viewer.orientation.y,
    viewer.orientation.z,
    viewer.orientation.w,
  )
  // Take yaw from where the head is LOOKING, not from the quaternion's own y
  // component. Extracting yaw algebraically (atan2 on the quaternion terms) is
  // the usual shortcut and it degenerates when you look straight up or down —
  // exactly when someone reaches for recentre, because they have lost the
  // horizon. Projecting the forward axis onto the ground plane does not.
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  const forward = look.clone()
  // Flattened FIRST, so `lengthSq` below measures the ground-plane projection.
  // (atan2 ignores y, so this line looks redundant and is not: it is what makes
  // the degeneracy test below able to see straight up.)
  forward.y = 0

  // Straight up or straight down leaves nothing to project. Fall back to the
  // head's own UP axis, which in that pose lies along the body's facing.
  //
  // The SIGN matters and is not symmetric. Tip your head back to look up and
  // your up-axis points BEHIND you; tip it forward to look down and it points
  // ahead. Take it unsigned and recentring while looking up turns the world 180
  // degrees — which is both wrong and the single most disorienting thing a
  // recentre button could do to someone who has just lost the horizon.
  if (forward.lengthSq() < 1e-8) {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    forward.copy(look.y > 0 ? up.negate() : up)
    forward.y = 0
    // Both degenerate is not reachable for a unit quaternion, but a caller
    // passing garbage should get an identity rather than a NaN world.
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1)
  }
  forward.normalize()

  // Both arguments NEGATED. A right-handed rotation about +Y by `yaw` sends
  // (0, 0, -1) to (-sin yaw, 0, -cos yaw), so recovering `yaw` from a forward
  // vector needs both signs flipped. Getting one of them wrong does not break
  // recentring visibly — it rotates the world the WRONG WAY, so pressing the
  // button doubles the error you were trying to remove instead of cancelling it.
  const yaw = Math.atan2(-forward.x, -forward.z)
  const out = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  return {
    position: { x: viewer.position.x, y: viewer.position.y, z: viewer.position.z },
    orientation: { x: out.x, y: out.y, z: out.z, w: out.w },
  }
}

/**
 * Recentre the live session on the viewer's current pose.
 *
 * Returns false and changes nothing when there is no session, no reference
 * space, or no viewer pose this frame — all three are ordinary states (out of
 * session, first frames, tracking lost) rather than errors, and a recentre that
 * silently does nothing is much better than one that throws mid-flight.
 *
 * MUST be called from inside the XR frame callback, because `getViewerPose`
 * needs the `XRFrame` and it is only valid for that frame.
 */
export const recenterXr = (renderer: THREE.WebGLRenderer, frame: XRFrame | undefined): boolean => {
  if (!frame) return false
  const space = renderer.xr.getReferenceSpace()
  if (!space) return false
  const pose = frame.getViewerPose(space)
  if (!pose) return false

  const offset = recenterOffset(pose.transform)
  renderer.xr.setReferenceSpace(
    space.getOffsetReferenceSpace(
      new XRRigidTransform(
        { x: offset.position.x, y: offset.position.y, z: offset.position.z },
        {
          x: offset.orientation.x,
          y: offset.orientation.y,
          z: offset.orientation.z,
          w: offset.orientation.w,
        },
      ),
    ),
  )
  return true
}
