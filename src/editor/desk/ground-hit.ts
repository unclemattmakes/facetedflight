// src/editor/desk/ground-hit.ts: where a click's ray meets the ground when the
// sea is drawn as rings (DEV-339). The rings are not meshes the desk can pick,
// so over open water the ray is intersected with the sea's resting plane, and
// whichever of that and the land mesh the ray reaches first is the ground.
import * as THREE from 'three'

/**
 * The nearer of the land hit (or null) and the ray's meeting with the plane
 * y = `seaY`. Null when the ray reaches neither. Pure: no scene, no state.
 */
export const groundHit = (
  ray: THREE.Ray,
  landPoint: THREE.Vector3 | null,
  seaY: number | null,
): THREE.Vector3 | null => {
  if (seaY === null) return landPoint
  const seaPoint = ray.intersectPlane(
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -seaY),
    new THREE.Vector3(),
  )
  if (!seaPoint) return landPoint
  if (!landPoint) return seaPoint
  return ray.origin.distanceToSquared(seaPoint) < ray.origin.distanceToSquared(landPoint)
    ? seaPoint
    : landPoint
}
