// src/game/cockpit-common.ts: the parts of the two cockpit flights
// (`flight.ts`, `jumpseat-flight.ts`) that are the SAME values, held once.
//
// Only what is identical lives here (code-reuse audit XC-10). Where the two
// vehicles differ on purpose, the difference stays at its call site: the
// JumpSeat's pause plate sits at `JUMPSEAT_EYE.z - 0.86` while the HoverJet's
// uses `PANEL_DISTANCE`, which is a look decision rather than a copy that
// drifted, so it is deliberately not unified here.

import type { TerrainCollisionSpec } from '@/sim/terrain-collision'

/**
 * How the hull meets the ground, everything but the hull itself. Both vehicles
 * are on Unity's built-in default physics material: zero bounciness is the
 * shipped behaviour and load-bearing (a hull that bounced would turn every
 * mistake into a pinball, and on a lander most landings), friction is Unity's
 * default, and `Ship_HoverShip.Flash()` holds for `WaitForSeconds(0.3f)` with
 * angular drag x3.
 */
export const SHIP_GROUND_CONTACT: Omit<TerrainCollisionSpec, 'hull'> = {
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}
