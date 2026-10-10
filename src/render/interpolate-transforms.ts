// src/render/interpolate-transforms.ts — the bridge from an 81.967 Hz sim to a
// 72 / 90 / 120 Hz display. Read the previous and current sim poses, write a
// three.js Object3D. Data flows sim → render and never the other way.

import { type Object3D, Quaternion } from 'three'
import type { Quat } from '@/sim/math/quat'
import type { Vec3 } from '@/sim/math/vec3'

export interface Pose {
  position: Vec3
  orientation: Quat
}

export const copyPose = (out: Pose, a: Pose): Pose => {
  out.position.x = a.position.x
  out.position.y = a.position.y
  out.position.z = a.position.z
  out.orientation.x = a.orientation.x
  out.orientation.y = a.orientation.y
  out.orientation.z = a.orientation.z
  out.orientation.w = a.orientation.w
  return out
}

// Module-level scratch. Only valid inside one synchronous call — never store a
// reference to it (polyfish's "volatile temp vector" trap).
const _a = new Quaternion()
const _b = new Quaternion()

/**
 * `alpha` is the value `stepFixed` returned this frame. Applying the *current*
 * sim pose directly instead judders visibly at 72 Hz against an 82 Hz sim,
 * because the beat frequency is ~10 Hz — right in the range the eye hates.
 */
export const applyInterpolated = (
  target: Object3D,
  previous: Pose,
  current: Pose,
  alpha: number,
): void => {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha
  target.position.set(
    previous.position.x + (current.position.x - previous.position.x) * t,
    previous.position.y + (current.position.y - previous.position.y) * t,
    previous.position.z + (current.position.z - previous.position.z) * t,
  )
  _a.set(
    previous.orientation.x,
    previous.orientation.y,
    previous.orientation.z,
    previous.orientation.w,
  )
  _b.set(current.orientation.x, current.orientation.y, current.orientation.z, current.orientation.w)
  target.quaternion.copy(_a).slerp(_b, t)
}
