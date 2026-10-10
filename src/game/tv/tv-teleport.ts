// src/game/tv/tv-teleport.ts: the headset's Free camera (teleport and snap turn). DEV-481.
//
// Matt chose it (plan/FF-TV.md §8, call 4): in a headset, TV's Free mode is
// AIM a controller, pull the trigger, and the screen fades to black and back
// with the eye at the aimed point (on the ground, or a fixed height above it
// when the aim is at the sky), and the stick turns the view in 30° SNAPS. The
// head is free; the rig moves only at a teleport or a snap, never smoothly.
// A smooth free flight moves the wearer by something other than their own
// head, which is the thing this whole camera exists not to do.
//
// Pure: no three, no DOM, no clock. The world comes in as `heightAt` (the
// higher of the rendered and collision surfaces, THREE world, −∞ off the map),
// an optional `obstructed`, and the bounds (`tv-vantage.ts`'s types).
//
// ── The rig and the head ──────────────────────────────────────────────────
//
// The session's reference space is `local` (`render/renderer.ts`): the head
// pose arrives in the RIG's frame, offset from the rig by however far the
// wearer has leaned or stepped since the session began. So a teleport puts the
// HEAD at the target (the rig goes to `target − yaw·head`) and a snap turns
// the rig ABOUT the head, so the wearer turns on the spot rather than swinging
// round a point a metre beside them.

import {
  groundInDisk,
  type HeightAt,
  type Obstructed,
  type TvBounds,
  type Vec3T,
} from './tv-vantage'

export const TELEPORT_POLICY = {
  /** The furthest a teleport reaches along the aim, metres. */
  range: 1500,
  /** The aim is marched in steps this long, then the hit refined by halving. */
  step: 4,
  /** A ground target puts the eye this high above the highest ground within `groundDisk`. */
  groundEye: 1.8,
  groundDisk: 3,
  /** An aim at the sky: this far out along it, and at least this high above the ground. */
  airDistance: 120,
  airAbove: 25,
  /** The sphere asked of `obstructed` at the target, and how far back along the aim a blocked one retreats per try. */
  eyeRadius: 1.5,
  retreat: 6,
  retreatTries: 12,
  /** One stick flick turns the view this much. */
  snapDegrees: 30,
} as const

export interface TeleportWorld {
  readonly heightAt: HeightAt
  readonly obstructed?: Obstructed | undefined
  readonly bounds?: TvBounds | null | undefined
}

export interface TeleportTarget {
  /** Where the HEAD goes, THREE world. */
  readonly eye: Vec3T
  /** True for a ground target, false for one in the air. */
  readonly onGround: boolean
  /** How far along the aim the hit (or the air point) is, metres: the beam's length. */
  readonly distance: number
}

/**
 * Where a teleport aimed along the ray `origin` + t·`direction` lands, or null
 * when it cannot land anywhere (the whole aim is out of bounds, or every
 * point near the target is inside a prop). `direction` need not be unit.
 */
export const teleportTarget = (
  origin: Vec3T,
  direction: Vec3T,
  world: TeleportWorld,
): TeleportTarget | null => {
  const p = TELEPORT_POLICY
  const len = Math.hypot(direction[0], direction[1], direction[2])
  if (!(len > 1e-9)) return null
  const dx = direction[0] / len
  const dy = direction[1] / len
  const dz = direction[2] / len
  const at = (t: number): [number, number, number] => [
    origin[0] + dx * t,
    origin[1] + dy * t,
    origin[2] + dz * t,
  ]
  const below = (t: number): boolean => {
    const q = at(t)
    return q[1] <= world.heightAt(q[0], q[2])
  }
  // March to the first sample at or under the ground, then halve to the surface.
  let hit = -1
  let prev = 0
  for (let t: number = p.step; t <= p.range; t += p.step) {
    if (below(t)) {
      let lo = prev
      let hi = t
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2
        if (below(mid)) hi = mid
        else lo = mid
      }
      hit = lo
      break
    }
    prev = t
  }
  let distance: number
  let onGround: boolean
  let eye: [number, number, number]
  if (hit >= 0) {
    const q = at(hit)
    const ground = groundInDisk(world.heightAt, q[0], q[2], p.groundDisk, 8)
    eye = [q[0], ground + p.groundEye, q[2]]
    distance = hit
    onGround = true
  } else {
    eye = at(p.airDistance)
    const ground = groundInDisk(world.heightAt, eye[0], eye[2], 10, 8)
    if (Number.isFinite(ground)) eye[1] = Math.max(eye[1], ground + p.airAbove)
    distance = p.airDistance
    onGround = false
  }
  // Inside the bounds: pulled straight back towards the centre onto the sphere.
  const b = world.bounds
  if (b) {
    const ox = eye[0] - b.centre[0]
    const oy = eye[1] - b.centre[1]
    const oz = eye[2] - b.centre[2]
    const r = Math.hypot(ox, oy, oz)
    if (r > b.radius) {
      const k = (b.radius * 0.98) / r
      eye = [b.centre[0] + ox * k, b.centre[1] + oy * k, b.centre[2] + oz * k]
      const ground = groundInDisk(world.heightAt, eye[0], eye[2], p.groundDisk, 8)
      if (Number.isFinite(ground) && eye[1] < ground + p.groundEye) eye[1] = ground + p.groundEye
      onGround = false
    }
  }
  // Never inside a prop: retreat back along the aim, horizontally, keeping the height rule.
  for (let i = 0; i <= p.retreatTries; i++) {
    if (!world.obstructed?.(eye[0], eye[1], eye[2], p.eyeRadius)) {
      return { eye, onGround, distance }
    }
    eye = [eye[0] - dx * p.retreat, eye[1], eye[2] - dz * p.retreat]
    const ground = groundInDisk(world.heightAt, eye[0], eye[2], p.groundDisk, 8)
    if (Number.isFinite(ground) && eye[1] < ground + p.groundEye) eye[1] = ground + p.groundEye
  }
  return null
}

/** A rig pose: a position and a level yaw (three's convention: 0 looks down −Z). */
export interface RigPose {
  readonly position: Vec3T
  readonly yaw: number
}

/** `v` (x, z) turned by `yaw` about +Y, three's convention. */
const turn = (x: number, z: number, yaw: number): [number, number] => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [x * c + z * s, -x * s + z * c]
}

/**
 * The rig pose that puts the HEAD at `eye` facing `yaw`, given the head's
 * offset inside the rig (`head`, the camera's LOCAL position; CLAUDE.md: a
 * camera's position is local).
 */
export const rigForEye = (eye: Vec3T, yaw: number, head: Vec3T): RigPose => {
  const [hx, hz] = turn(head[0], head[2], yaw)
  return { position: [eye[0] - hx, eye[1] - head[1], eye[2] - hz], yaw }
}

/** The head's world position for a rig pose and the head's local offset. */
export const headWorld = (rig: RigPose, head: Vec3T): [number, number, number] => {
  const [hx, hz] = turn(head[0], head[2], rig.yaw)
  return [rig.position[0] + hx, rig.position[1] + head[1], rig.position[2] + hz]
}

/**
 * One snap: the rig turned by `direction` × 30° ABOUT THE HEAD, so the head's
 * world position does not move. `direction` +1 turns right (clockwise seen
 * from above: a negative yaw step, three's convention), −1 left.
 */
export const snapTurn = (rig: RigPose, head: Vec3T, direction: 1 | -1): RigPose => {
  const eye = headWorld(rig, head)
  const yaw = rig.yaw - direction * ((TELEPORT_POLICY.snapDegrees * Math.PI) / 180)
  return rigForEye(eye, yaw, head)
}
