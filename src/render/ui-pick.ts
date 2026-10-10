// src/render/ui-pick.ts: a ray against a panel's own plane, one place.
//
// The pause plate, the XR checklist plate (removed, DEV-900), the room-code
// plate, the bench door and the TV panel each wrote "where does this ray meet
// z = 0 in my local space" (UI-3), with three different epsilons, while the
// checklist plate exported the helper nobody else imported. The
// painter-and-hit-test drift `pause.ts` warns about starts exactly here: two
// plates solving the same plane two ways.
//
// ── The epsilon, and why one is enough ────────────────────────────────────
//
// `RAY_PARALLEL_EPS` is 1e-6, on a UNIT local direction (what `transformDirection`
// gives). Below it the ray is parallel to the plane for every purpose a plate
// has: a hit at |dz| < 1e-6 lands at t = -oz / dz, more than a million times the
// eye's distance from the plane away, which is outside every plate in the game,
// whatever the epsilon was. The three old values (`dz === 0`, 1e-6, 1e-9) can
// therefore disagree only for an eye within a micrometre of the plane and
// grazing it, which no menu can produce. `tests/unit/ui-pick.test.ts` sweeps it.
//
// A caller whose local direction is NOT unit (the bench door and the TV panel
// carry the mesh's scale in it) passes its own epsilon: an absolute threshold
// depends on the direction's length, so that one stays a parameter.

import * as THREE from 'three'

/** Parallel, for a unit local direction. See the header. */
export const RAY_PARALLEL_EPS = 1e-6

/** A hit in the plane's local space, written into by {@link rayPlaneHit}. */
export interface PlaneHit {
  x: number
  y: number
}

/**
 * Where a ray meets the plane z = 0, written into `out`. False for a ray parallel
 * to the plane, and for one pointing away from it ("pointing away" is the case a
 * naive solve gets wrong by reporting a hit BEHIND your head). Allocation-free:
 * the pause plate asks every frame its menu is up.
 */
export const rayPlaneHit = (
  out: PlaneHit,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  eps: number = RAY_PARALLEL_EPS,
): boolean => {
  // Written so a NaN anywhere is a MISS, as `!(t > 0)` was in the bench door and
  // the TV panel: `NaN <= 0` is false and would have let it through.
  if (!(Math.abs(dz) >= eps)) return false
  const t = -oz / dz
  if (!(t > 0)) return false
  out.x = ox + dx * t
  out.y = oy + dy * t
  return true
}

/**
 * {@link rayPlaneHit} as a value: `{x, y}` in local metres, or null. Pure, so
 * the arithmetic that turns a ray into a point is testable without a scene.
 */
export const rayToLocal = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  eps: number = RAY_PARALLEL_EPS,
): { x: number; y: number } | null => {
  const hit: PlaneHit = { x: 0, y: 0 }
  return rayPlaneHit(hit, ox, oy, oz, dx, dy, dz, eps) ? hit : null
}

const _inverse = new THREE.Matrix4()

/**
 * A WORLD ray into `object`'s own space, written into `outOrigin` and
 * `outDirection` (a unit direction). `matrixWorld` is stale inside an XR frame
 * callback until `render()` runs (CLAUDE.md), so this refreshes it rather than
 * trusting the caller: one matrix compose, on the frames a menu is up.
 *
 * Volatile scratch is module-level and valid only inside this call.
 */
export const toPanelLocal = (
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  outOrigin: THREE.Vector3,
  outDirection: THREE.Vector3,
): void => {
  object.updateWorldMatrix(true, false)
  _inverse.copy(object.matrixWorld).invert()
  outOrigin.copy(origin).applyMatrix4(_inverse)
  // A DIRECTION: translation must not apply.
  outDirection.copy(direction).transformDirection(_inverse)
}
