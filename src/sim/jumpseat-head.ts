// src/sim/jumpseat-head.ts — the pilot's head touches anything, and the run is lost. DEV-403.
//
// SIM LAYER: no three, no DOM, no clock, no randomness, and no numbers of its
// own. The box and the hold arrive from the seam (`game/jumpseat-flight.ts`),
// which says where each comes from. Same contract as `sim/jumpseat-stranded.ts`.
//
// ── What 2016 did ─────────────────────────────────────────────────────────
//
// `JumpSeat_Photon.prefab`'s `collider_head` (`&174574`, active, layer 25
// `cockPit`) carries three things the rest of the seat does not:
//
//   · a SOLID BoxCollider (`&6575790`, not a trigger) around the pilot's head;
//   · its own Rigidbody (mass 1e-5), which `Trigger_Reset.Start()` unparents
//     and ties to the chassis with a runtime `FixedJoint`, so the box rides
//     the seat rigidly and never collides with the seat's own colliders
//     (`enableCollision` defaults false, and layer 25 ignores layer 25 anyway);
//   · `Trigger_Reset` (`&114000013867201522`, `m_Enabled: 1`).
//
// `Trigger_Reset.OnCollisionEnter` (`Trigger_Reset.cs:37-49`) fires on ANY
// collider not tagged `Player` — terrain, the sea, a pad, a tree — and starts
// `TriggerReset()`: latch `triggered`, `fader.trigger_FadeOut`,
// `WaitForSeconds(1f)`, then `Application.LoadLevel(Application.loadedLevel)`.
// A full scene reload: score, pads, clock and tank all start again. It is the
// JumpSeat's ONLY death in 2016; the HoverJet's prefab has no `Trigger_Reset`.
//
// Matt, 2026-09-25: ported as 2016 did it, on BOTH presets, and on Anniversary
// the props count too (2016's desert and alpine props had live colliders,
// DEV-214). DEVIATIONS.md, DEV-403.
//
// ── The test is the BOX, not the hull's sphere ────────────────────────────
//
// `hullFromColliders` already turns the head box into its INSCRIBED sphere
// (radius = the smallest half-extent), and that sphere is what stops the head
// on the ground. It is not the collider 2016 reset on: the box's corners reach
// 0.6 m past it. So this samples the box itself — the 27-point lattice of its
// corners, edge midpoints, face centres and centre, in the box's own frame —
// against the same surfaces the hull resolves on. For the props, which are
// tested sphere-against-capsule, the inscribed sphere joins the lattice so a
// trunk meeting the middle of a face is not missed between corners.
//
// A heightfield is solid below its surface, so a lattice point below it is a
// touch. A PAD is not: 2016's `jumpPad_04_collider` is a ~4 m thick bowl with
// an underside (`level.pads[].solid.bottom`), and a head passing under a pad's
// rim is in open air. DEV-383 gave the pad's field that underside
// (`belowField`) for the hull, the legs and the hover ray; the head asks the
// same question of the same fields, so the underside is defined once.
//
// ── When in the tick ──────────────────────────────────────────────────────
//
// Where the flight model PUT the seat, before the contact resolves it. PhysX
// generates a contact for every shape that reaches a surface and only then
// solves, so a head that reached a hillside touched it even when the chassis
// hit harder and the solve pushes the whole seat back out. The port's resolve
// moves the body along the deepest sphere's normal, which can lift a head that
// was in the ground back out of it; testing after would miss exactly the
// head-first-into-a-slope contact this rule is mostly about.
//
// ── One death at a time ───────────────────────────────────────────────────
//
// The JumpSeat has two ways to lose a run now, this and DEV-342's stranded
// tank, and like `sim/crash.ts`'s crash and boundary they must never both end
// one run. `stepJumpSeatDeaths` is the whole of that rule, in one place:
//
//   · a head already dying freezes the stranded rule — the run is lost;
//   · a tank already dying ignores the head — the curtain is already coming
//     down, and 2016's `triggered` latch has the same shape;
//   · a head touch while the tank is only COUNTING takes over at once, and the
//     count is cleared: 2016's reset needs no three seconds of anything.

import type { JumpSeat } from './jumpseat'
import type { RefuelState } from './jumpseat-refuel'
import {
  resetStranded,
  type StrandedSpec,
  type StrandedState,
  stepJumpSeatStranded,
} from './jumpseat-stranded'
import { type Quat, rotateVec3 } from './math/quat'
import { type Vec3, v3 } from './math/vec3'
import { type PropColliders, propPenetrationAt } from './props/collision'
import { type HeightField, highestGroundUnder, PADS_SOLID } from './terrain/height-field'
import type { HullSphere } from './terrain-collision'

/** `collider_head`'s box, in the SHIP's frame, SIM space. The seam reads it off the sheet. */
export interface HeadBoxSpec {
  readonly centre: { readonly x: number; readonly y: number; readonly z: number }
  /** The box's own rotation in the ship frame (8.6° about x on the shipped prefab). */
  readonly rotation: Quat
  readonly halfExtents: { readonly x: number; readonly y: number; readonly z: number }
}

/** The box, prepared once: the lattice as points and, for the props, as spheres. */
export interface HeadBox {
  /** The box's centre in the SHIP frame. */
  readonly centre: Vec3
  /** 27 points in the SHIP frame: corners, edge midpoints, face centres, centre. */
  readonly points: readonly Vec3[]
  /** The same points as zero-radius spheres, plus the inscribed sphere. For `propPenetrationAt`. */
  readonly spheres: readonly HullSphere[]
}

export const headBox = (spec: HeadBoxSpec): HeadBox => {
  const points: Vec3[] = []
  const local = v3()
  const turned = v3()
  const h = spec.halfExtents
  // -1, 0, +1 of each half-extent: structure, not tuning.
  for (const sx of [-1, 0, 1])
    for (const sy of [-1, 0, 1])
      for (const sz of [-1, 0, 1]) {
        local.x = sx * h.x
        local.y = sy * h.y
        local.z = sz * h.z
        rotateVec3(turned, spec.rotation, local)
        points.push(
          v3(spec.centre.x + turned.x, spec.centre.y + turned.y, spec.centre.z + turned.z),
        )
      }
  const spheres: HullSphere[] = points.map((p) => ({ x: p.x, y: p.y, z: p.z, radius: 0 }))
  spheres.push({
    x: spec.centre.x,
    y: spec.centre.y,
    z: spec.centre.z,
    radius: Math.min(h.x, h.y, h.z),
  })
  return { centre: v3(spec.centre.x, spec.centre.y, spec.centre.z), points, spheres }
}

/**
 * Where the seat is: a rigid body satisfies it, and so does a pose the
 * autopilot projects ahead of one (`sim/jumpseat-autopilot.ts`'s head guard).
 */
export interface HeadPose {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly orientation: Quat
}

// Volatile module-level scratch: written and read inside ONE synchronous call,
// never stored, never read across calls (trap 19).
const _world = v3()

/**
 * How deep one SIM-space point is in the deepest field under it, metres:
 * positive inside, negative its clearance, `-Infinity` over nothing. A point
 * under a floating pad is under it, not in it (`belowField`, DEV-383) —
 * unless `solidBelow`, which reads every field as solid to the ground.
 */
const pointDepth = (
  fields: readonly HeightField[],
  x: number,
  y: number,
  z: number,
  solidBelow: boolean,
): number => {
  // `max(h - y)` is `max(h) - y` to the bit (monotone rounding); -Infinity
  // over nothing stays -Infinity for any finite y.
  return highestGroundUnder(fields, x, z, solidBelow ? PADS_SOLID : y) - y
}

/**
 * How deep the head box is in the deepest surface it reaches, metres. Zero is
 * touching; negative is the clearance of its lowest point. `-Infinity` over no
 * surface at all. Exported for the tests, which measure landings with it.
 *
 * `solidBelow` reads the pads as solid all the way down, as the autopilot's
 * head guard wants them (`sim/jumpseat-autopilot.ts`, `JumpSeatHeadGuard`).
 * The RULE never passes it: 2016's pad has an underside.
 */
export const headDepth = (
  body: HeadPose,
  box: HeadBox,
  fields: readonly HeightField[],
  solidBelow = false,
): number => {
  let deepest = Number.NEGATIVE_INFINITY
  for (const p of box.points) {
    rotateVec3(_world, body.orientation, p)
    const depth = pointDepth(
      fields,
      body.position.x + _world.x,
      body.position.y + _world.y,
      body.position.z + _world.z,
      solidBelow,
    )
    if (depth > deepest) deepest = depth
  }
  return deepest
}

/**
 * Does the head box touch a surface or a prop, with the body where it is?
 *
 * `props` null is a run with no prop collision: every Classic run, and an
 * Anniversary one whose props did not load or are switched off. Then the
 * props are simply not there, as they are not for the rest of the seat.
 */
export const headTouches = (
  body: HeadPose,
  box: HeadBox,
  fields: readonly HeightField[],
  props: PropColliders | null,
): boolean => {
  if (headDepth(body, box, fields) >= 0) return true
  return (
    props !== null && propPenetrationAt(body.position, body.orientation, box.spheres, props) > 0
  )
}

export interface HeadSpec {
  /** Seconds of `dying` between the touch and the restart: `WaitForSeconds(1f)`. */
  readonly holdSeconds: number
}

/** `ok`, or `dying` from the touch until the restart. There is no warning phase: 2016 had none. */
export type HeadPhase = 'ok' | 'dying'

export interface HeadState {
  phase: HeadPhase
  /** Seconds spent in `dying`. */
  dyingFor: number
}

export const createHead = (): HeadState => ({ phase: 'ok', dyingFor: 0 })

/** Back to `ok` — the respawn's half. PER STATE, never shared (trap 19). */
export const resetHead = (state: HeadState): void => {
  state.phase = 'ok'
  state.dyingFor = 0
}

/** Which rule lost the run. `fuel` is DEV-342's stranded tank. */
export type JumpSeatDeath = 'head' | 'fuel'

/**
 * One FIXED step of both of the JumpSeat's deaths, under the rules in the
 * header. Returns the cause on the single tick the run should restart, and
 * null on every other.
 *
 * `touching` is `headTouches` for this tick, taken where the header says. The
 * stranded rule is stepped here rather than by the caller so that the order —
 * and "one death at a time" — is written down once. Call it where the
 * stranded rule was called: AFTER the refuel.
 */
export const stepJumpSeatDeaths = (
  head: HeadState,
  stranded: StrandedState,
  touching: boolean,
  seat: JumpSeat,
  refuel: RefuelState,
  headSpec: HeadSpec,
  strandedSpec: StrandedSpec,
  dt: number,
): JumpSeatDeath | null => {
  if (head.phase === 'dying') {
    // True on the CROSSING tick only, so a caller that has not reset yet cannot
    // restart the run twice. `triggered`: further touches change nothing.
    const before = head.dyingFor
    head.dyingFor += dt
    return before < headSpec.holdSeconds && head.dyingFor >= headSpec.holdSeconds ? 'head' : null
  }
  if (stranded.phase === 'dying') {
    return stepJumpSeatStranded(stranded, seat, refuel, strandedSpec, dt) ? 'fuel' : null
  }
  if (touching) {
    head.phase = 'dying'
    head.dyingFor = 0
    resetStranded(stranded)
    // A zero hold has no crossing to wait for: the run is lost on the touch.
    return headSpec.holdSeconds <= 0 ? 'head' : null
  }
  return stepJumpSeatStranded(stranded, seat, refuel, strandedSpec, dt) ? 'fuel' : null
}
