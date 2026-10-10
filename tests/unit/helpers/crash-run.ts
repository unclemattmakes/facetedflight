// tests/unit/helpers/crash-run.ts — the rig for flying a run into the ground.
//
// NOT a `.test.ts`, so vitest does not collect it. Two specs drive the crash
// rule through a REAL sequence rather than a teleport — `crash-gate-score`
// (DEV-149) and `crash-reset-behind` (DEV-289) — and both need the same four
// things: a flat collision surface, a HoverJet body with the shipped mass and
// drag, a way to fly a leg while the mission is stepped, and the hold-then-
// reset loop that `boot/app.ts` runs.
//
// Writing that twice is how the two would start disagreeing about what a crash
// IS — which is the whole risk DEV-074 named: *"every one of them started the
// ship in the middle of the sphere and teleported it out"*. One rig, and every
// spec that uses it flies.

import type { Level } from '@/content/level-schema'
import { type MissionState, stepMission } from '@/game/mission'
import { HOVERJET } from '@/generated/constants.generated'
import { type BoundarySpec, createBoundary } from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import {
  type CrashCourse,
  type CrashSpec,
  type CrashState,
  stepCrashAndBoundary,
} from '@/sim/crash'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRigidBody, type RigidBody } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { createGroundContact, HOVERJET_GROUND, stepGroundContact } from '@/sim/terrain-collision'

/** A constant-grey map, which `buildHeightField` turns into a flat plate. */
const flatMap = (g: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS = {
  terrainSize: 8192,
  terrainHeight: 400,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/** A flat collision surface at height `y`, covering the whole course. */
export const plateAt = (y: number): HeightField =>
  buildHeightField(flatMap(y / PARAMS.terrainHeight), PARAMS, {
    position: [-4096, 0, -4096],
    scale: [1, 1, 1],
  })

/** A body with the SHIPPED HoverJet's mass and drag, at rest, gravity off. */
export const hoverBody = (at: Vec3): RigidBody => {
  const b = createRigidBody({
    mass: HOVERJET.rigidbody.mass,
    drag: HOVERJET.rigidbody.drag,
    angularDrag: HOVERJET.rigidbody.angularDrag,
    useGravity: false,
  })
  b.position.x = at.x
  b.position.y = at.y
  b.position.z = at.z
  return b
}

const lerp = (a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 => {
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  out.z = a.z + (b.z - a.z) * t
  return out
}

/** Fly a straight leg at `speed`, stepping the mission at every fixed tick. */
export const flyLeg = (
  state: MissionState,
  level: Level,
  from: Vec3,
  to: Vec3,
  speed: number,
): Vec3 => {
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const steps = Math.max(1, Math.ceil(distance / (speed * FIXED_DT)))
  const at = v3()
  for (let i = 1; i <= steps; i++) {
    lerp(from, to, i / steps, at)
    stepMission(state, level, at, FIXED_DT)
  }
  return v3(at.x, at.y, at.z)
}

/**
 * Dive a body into a plate and run the crash rule until it puts the ship back.
 *
 * The number the crash consumes is the CONTACT's own — `stepGroundContact`
 * against a real `HeightField` — and the function stepped is the one
 * `boot/app.ts` calls, with the preset's own spec. Nothing is teleported.
 *
 * Returns the tick the hold began, the tick the reset landed — both -1 if it
 * never crashed, so a caller can assert the sequence really happened — and
 * WHERE THE WRECK WAS. That last one matters: the ship is tens of metres below
 * the line by the time it touches, and the reset is planned from the wreck's
 * position, not from the last waypoint the caller flew to. A spec that
 * measures "how far back is the reset" from the waypoint is measuring a
 * different question and will disagree by however much the line climbs.
 */
export const diveUntilReset = (
  crash: CrashState,
  spec: CrashSpec,
  body: RigidBody,
  plate: HeightField,
  course: CrashCourse,
  descentSpeed = 200,
  boundarySpec: BoundarySpec | null = null,
  maxTicks = 400,
): { crashedAt: number; resetAt: number; wreck: Vec3 } => {
  const ground = createGroundContact(body.angularDrag)
  const boundary = createBoundary()
  body.velocity.y = -descentSpeed
  let crashedAt = -1
  let resetAt = -1
  const wreck = v3()
  for (let i = 0; i < maxTicks && resetAt < 0; i++) {
    if (crash.phase !== 'crashed') {
      body.position.y += body.velocity.y * FIXED_DT
      stepGroundContact(ground, body, [plate], HOVERJET_GROUND, FIXED_DT)
    }
    const hazards = stepCrashAndBoundary(
      crash,
      spec,
      boundary,
      boundarySpec,
      body,
      ground.collision.impactSpeed,
      course,
      [plate],
      FIXED_DT,
    )
    if (hazards.crash === 'crashed') {
      crashedAt = i
      wreck.x = body.position.x
      wreck.y = body.position.y
      wreck.z = body.position.z
    }
    if (hazards.crash === 'reset') resetAt = i
  }
  return { crashedAt, resetAt, wreck }
}
