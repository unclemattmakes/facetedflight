// src/sim/terrain-collision.ts — the ground stops you.
//
// Until now it did not. You could fly through Simonet.
//
// ── What 2016 actually had ────────────────────────────────────────────────
//
// A `TerrainCollider` on each `FacetedTerrain` (see `terrain/height-field.ts`
// for why that surface is not the mesh), and five solid colliders on the ship:
// two capsules and three boxes, all `isTrigger: false`, all on layer 25. The
// response was PhysX's, against `m_DefaultMaterial: {fileID: 0}` — Unity's
// built-in default, which is **bounciness 0** and friction 0.6.
//
// So the shipped behaviour is: you do not bounce. You stop, or you scrape along.
// That matters more than it sounds — a bouncy hull turns every mistake into a
// pinball, and 2016 deliberately did not have that.
//
// `Ship_HoverShip.OnCollisionEnter` adds one thing on top: `Flash()`, which
// triples `angularDrag` for **0.3 s**. A hit costs you the ability to turn for a
// third of a second, which is the handling penalty the physics alone would not
// give you. `endOnCollide` is **0** on the shipped prefab, so hitting ground does
// NOT end the run — the boundary is what kills you (DEV-017), not the hillside.
//
// ── The hull, and why it is spheres ──────────────────────────────────────
//
// Exact capsule-and-box against a heightfield is a lot of code for a surface
// that is already a bilinear approximation of a jittered mesh. Each of the five
// colliders becomes one sphere at its own centre with its own radius, which is
// stable, cheap, deterministic, and errs toward stopping you slightly early
// rather than letting you clip a ridge.
//
// Recorded as a deviation (DEV-020) rather than presented as the collider set.
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.

import { HOVERJET } from '@/generated/constants.generated'
import {
  createHoverMotor,
  type HoverMotorSpec,
  type HoverMotorState,
  stepHoverMotor,
} from './hover-motor'
import { type Quat, rotateVec3 } from './math/quat'
import { type Vec3, v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'
import {
  belowField,
  type HeightField,
  highestGroundUnder,
  outsideField,
  terrainHeightAt,
  terrainNormalAt,
} from './terrain/height-field'

/** One sphere standing in for one of the ship's five colliders. */
export interface HullSphere {
  /** Centre in the ship's own frame, SIM space. */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly radius: number
}

export interface TerrainCollisionSpec {
  readonly hull: readonly HullSphere[]
  /** Unity's default physics material. Bounciness 0: the ship does NOT bounce. */
  readonly restitution: number
  /** Unity's default. Applied to the tangential velocity on contact. */
  readonly friction: number
  /** `Flash()` holds for 0.3 s. */
  readonly flashSeconds: number
  /** `Flash()` multiplies angular drag by 3 while it holds. */
  readonly flashAngularDrag: number
}

export interface TerrainCollisionState {
  /** Seconds left of the `Flash()` handling penalty. */
  flashFor: number
  /** True on the tick a contact began, for audio and effects. */
  struck: boolean
  /** Deepest penetration resolved this tick, metres. */
  depth: number
  /**
   * METRES PER SECOND of velocity INTO the surface this tick — the normal
   * component the zero-bounciness contact removed. 0 when nothing was touched
   * or the body was already moving away from what it touched.
   *
   * EVERY tick of a contact, not only the `struck` one: a belly slide that
   * meets a cliff face is one continuous contact to `wasTouching` and a wall to
   * the pilot, and the crash rule (`sim/crash.ts`, DEV-126) needs the wall.
   * The number 2016 never computed — `OnCollisionEnter` has `Collision.
   * relativeVelocity` and `Flash()` does not read it — so nothing below the
   * threshold changes; this is a reading, not a response.
   */
  impactSpeed: number
}

export const createTerrainCollision = (): TerrainCollisionState => ({
  flashFor: 0,
  struck: false,
  depth: 0,
  impactSpeed: 0,
})

/**
 * Where one hull sphere's centre is in the world, SIM space, for a body at
 * (bx, by, bz) with `orientation`. Written into the caller's own `out` and
 * returned: never a module scratch two callers could share (trap 19).
 * `HullSphere` already has x, y, z, so it is the rotated vector as it stands.
 */
export const hullSphereWorld = (
  out: Vec3,
  bx: number,
  by: number,
  bz: number,
  orientation: Quat,
  sphere: HullSphere,
): Vec3 => {
  rotateVec3(out, orientation, sphere)
  out.x = bx + out.x
  out.y = by + out.y
  out.z = bz + out.z
  return out
}

const _world = v3()
const _normal = { x: 0, y: 1, z: 0 }

/**
 * The deepest the hull goes into `fields` with the body at (bx, by, bz), and
 * the surface normal there, into `out`. 0 when it touches nothing. The one
 * probe the end-of-tick test and the swept test (below) both take.
 */
const _probe = { depth: 0, nx: 0, ny: 1, nz: 0 }
const probeHull = (
  body: RigidBody,
  bx: number,
  by: number,
  bz: number,
  fields: readonly HeightField[],
  hull: readonly HullSphere[],
  out: typeof _probe,
): typeof _probe => {
  out.depth = 0
  out.nx = 0
  out.ny = 1
  out.nz = 0
  for (const sphere of hull) {
    hullSphereWorld(_world, bx, by, bz, body.orientation, sphere)
    const px = _world.x
    const py = _world.y
    const pz = _world.z

    for (const field of fields) {
      if (outsideField(field, px, pz)) continue
      // Wholly under a floating pad is under it, not inside it (DEV-383).
      if (belowField(field, py + sphere.radius)) continue
      const ground = terrainHeightAt(field, px, pz)
      const penetration = ground - (py - sphere.radius)
      if (penetration <= 0 || penetration <= out.depth) continue
      out.depth = penetration
      terrainNormalAt(field, px, pz, _normal)
      out.nx = _normal.x
      out.ny = _normal.y
      out.nz = _normal.z
    }
  }
  return out
}

/**
 * How far the hull reaches fore and aft, metres: the spread of its sphere
 * centres along the ship's own z, which is the way a ship travels fast. The
 * end-of-tick probe covers this much of each tick's path; the rest is a gap.
 */
export const hullSpan = (hull: readonly HullSphere[]): number => {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const sphere of hull) {
    if (sphere.z < lo) lo = sphere.z
    if (sphere.z > hi) hi = sphere.z
  }
  return hi > lo ? hi - lo : 0
}

/**
 * Push the body out of the terrain and kill the velocity going into it.
 *
 * Returns true on the tick a contact STARTS, which is what a caller hangs a
 * sound or a particle burst off. Sustained scraping returns false after the
 * first tick — otherwise every frame of a belly slide is a fresh "impact".
 */
export const stepTerrainCollision = (
  state: TerrainCollisionState,
  body: RigidBody,
  fields: readonly HeightField[],
  spec: TerrainCollisionSpec,
  dt: number,
): boolean => {
  const wasTouching = state.depth > 0
  state.struck = false
  state.depth = 0
  state.impactSpeed = 0
  if (state.flashFor > 0) state.flashFor = Math.max(0, state.flashFor - dt)

  const hit = probeHull(
    body,
    body.position.x,
    body.position.y,
    body.position.z,
    fields,
    spec.hull,
    _probe,
  )

  // ── Swept, when the tick outran the hull (DEV-382 follow-up) ────────────
  //
  // The probe above is where the body ENDS the tick. The hull's sphere centres
  // span only 1.86 m fore and aft, so a tick that travels further leaves the
  // path between last tick's probe and this one unprobed: 2.3 m at standard's
  // chained top on `int_01` (340 m/s), 5.0 m at the speed jet's (564 m/s,
  // 6.9 m a tick) — and a crest thinner than that was flown through without
  // contact (DEV-381 §7). So when the end is clear and the tick travelled more
  // than the hull spans, the path is probed at hull-span steps back along
  // the tick's travel (`position - velocity * dt * (1 - t)`, the step
  // `integrate` took), and the FIRST step that touches is where the body is
  // put before the ordinary contact below resolves it: it stops at the crest
  // rather than beyond it.
  //
  // Only when the end-of-tick probe is clear, and only when a tick outruns
  // the hull, so every contact this function has ever resolved resolves as it
  // did, and a ship under 152 m/s (1.86 m a tick) takes no extra probe at all.
  // Deterministic: the step count is a function of the tick's own travel.
  if (hit.depth <= 0) {
    const v = body.velocity
    const travel = Math.hypot(v.x, v.y, v.z) * dt
    const span = hullSpan(spec.hull)
    if (span > 0 && travel > span) {
      const steps = Math.ceil(travel / span)
      for (let k = 1; k < steps; k++) {
        const back = dt * (1 - k / steps)
        const bx = body.position.x - v.x * back
        const by = body.position.y - v.y * back
        const bz = body.position.z - v.z * back
        if (probeHull(body, bx, by, bz, fields, spec.hull, _probe).depth > 0) {
          body.position.x = bx
          body.position.y = by
          body.position.z = bz
          break
        }
      }
    }
  }

  const deepest = hit.depth
  const bestNx = hit.nx
  const bestNy = hit.ny
  const bestNz = hit.nz

  if (deepest <= 0) return false

  state.depth = deepest

  // Push out along the surface normal. Positional, not impulsive: a heightfield
  // contact resolved by force alone jitters, and PhysX does the same depenetration.
  body.position.x += bestNx * deepest
  body.position.y += bestNy * deepest
  body.position.z += bestNz * deepest

  // Split the velocity about the surface.
  const v = body.velocity
  const into = v.x * bestNx + v.y * bestNy + v.z * bestNz
  if (into < 0) {
    // Read before it is removed: how hard this tick hit, for the crash rule.
    state.impactSpeed = -into
    // Normal component: reversed by `restitution`, which is ZERO on Unity's
    // default material — so this removes it rather than bouncing.
    const scale = -(1 + spec.restitution) * into
    v.x += bestNx * scale
    v.y += bestNy * scale
    v.z += bestNz * scale
    // Tangential component: COULOMB friction, not a damping factor.
    //
    // Unity caps the tangential impulse at `friction x normalImpulse`, so how
    // much a contact slows you depends on how hard you hit it — a graze barely
    // costs anything and a head-on hit costs everything. A per-tick damping
    // factor instead would be frame-rate dependent AND would scrub the same
    // fraction off a 1 m/s brush as off a 300 m/s impact, which stops the ship
    // dead on contact with a hillside it should have skimmed.
    const along = v.x * bestNx + v.y * bestNy + v.z * bestNz
    const tx = v.x - bestNx * along
    const ty = v.y - bestNy * along
    const tz = v.z - bestNz * along
    const tangent = Math.hypot(tx, ty, tz)
    if (tangent > 1e-6) {
      const drop = Math.min(tangent, spec.friction * Math.abs(into))
      const keep = (tangent - drop) / tangent
      v.x = bestNx * along + tx * keep
      v.y = bestNy * along + ty * keep
      v.z = bestNz * along + tz * keep
    }
  }

  if (!wasTouching) {
    // `OnCollisionEnter`, once per contact. `Flash()` triples angular drag for
    // 0.3 s — the turn penalty that makes a scrape cost something.
    state.struck = true
    state.flashFor = spec.flashSeconds
    return true
  }
  return false
}

/** Angular drag right now: tripled while `Flash()` holds. */
/**
 * METRES from the lowest point of the hull to the surface under it, or
 * `Infinity` outside every field. G1's input (DEV-110).
 *
 * **The same hull and the same fields `stepTerrainCollision` uses**, which is
 * the whole reason it lives here rather than in `sim/proximity.ts`: two modules
 * with their own idea of how far the ground is would eventually disagree, and
 * the one that scores would be the one nobody checked. `penetration` in the
 * collision loop above is this number with its sign flipped — clearance is what
 * you have before it starts resolving.
 *
 * MINIMUM over the spheres, so a nose-down attitude measures from the nose. It
 * is a VERTICAL distance and not a distance to the nearest surface: a cliff
 * 3 m off the wingtip is not seen at all. Deliberate — see `proximity.ts`.
 *
 * Negative while the hull is inside the ground, which is a real state during a
 * scrape and is left signed rather than clamped: a caller that wants "how close
 * did I come" should not be handed a 0 that could mean touching or buried.
 */
export const hullClearance = (
  body: RigidBody,
  fields: readonly HeightField[],
  spec: TerrainCollisionSpec,
): number => {
  let lowest = Number.POSITIVE_INFINITY
  for (const sphere of spec.hull) {
    hullSphereWorld(
      _world,
      body.position.x,
      body.position.y,
      body.position.z,
      body.orientation,
      sphere,
    )
    const py = _world.y
    // DEV-705: wholly under a floating pad is under it, not above it, the
    // same test `probeHull` makes (`py + radius`), so the clearance this
    // reports and the penetration the collision resolves are one rule.
    const ground = highestGroundUnder(fields, _world.x, _world.z, py + sphere.radius)
    // `(py - r) - highest` is `min` over fields of `(py - r) - h`, to the bit.
    const gap = py - sphere.radius - ground
    if (gap < lowest) lowest = gap
  }
  return lowest
}

export const collisionAngularDrag = (
  state: TerrainCollisionState,
  spec: TerrainCollisionSpec,
  baseAngularDrag: number,
): number => (state.flashFor > 0 ? baseAngularDrag * spec.flashAngularDrag : baseAngularDrag)

/** Build the hull from the sheet's collider list. */
export const hullFromColliders = (
  colliders: readonly {
    centerInShipRootSpace: { x: number; y: number; z: number }
    effective: { radius?: number; halfExtents?: { x: number; y: number; z: number } }
    enabled: boolean
    isTrigger: boolean
  }[],
): HullSphere[] =>
  colliders
    .filter((c) => c.enabled && !c.isTrigger)
    .map((c) => {
      const e = c.effective
      // A capsule gives its radius. A box gives the radius of the sphere that
      // fits INSIDE it — the inscribed one, not the circumscribed — so the hull
      // does not grow the ship at its corners.
      const radius =
        e.radius ?? Math.min(e.halfExtents?.x ?? 0, e.halfExtents?.y ?? 0, e.halfExtents?.z ?? 0)
      return {
        // SIM space: the sheet's collider centres are already Unity space.
        x: c.centerInShipRootSpace.x,
        y: c.centerInShipRootSpace.y,
        z: c.centerInShipRootSpace.z,
        radius,
      }
    })
    .filter((s) => s.radius > 0)

// ── The whole ground rule, as ONE function ────────────────────────────────
//
// Everything above is a part: a hover motor that holds the ship off, a
// depenetration that resolves having reached the ground anyway, and an angular
// drag penalty that makes a scrape cost you the turn. **The ORDER of those three
// is the rule**, and the order was written down in exactly one place — the
// player's `game/flight.ts` — so anything else that flies a HoverJet flew
// through Simonet.
//
// That is not hypothetical. The AI racers had no ground at all, which is why
// DEV-032's symptom was the SEA FLOOR rather than a hillside: with nothing to
// hit, a finished racer holding a frozen stick simply kept descending past
// y = 0. The autopilot's `pathClearance` term is a different job — it *avoids*
// terrain, it does not *collide* with it — and a racer knocked off its line by
// anything the avoidance does not see had nothing to stop it.
//
// So the rule lives here, once, and the player and the racers both call it.
// Duplicating four lines of call order is how two ships end up in two different
// worlds after the third time somebody tunes one of them.
//
// ── What a contact DOES, and what it deliberately does not ────────────────
//
// It does not kill you. `endOnCollide` is **0** on the shipped
// `PlayerShip_SR14_Photon.prefab`, so 2016's ground does not end a run — the
// `PlayerBoundary` does (DEV-017), and it is disabled in 6 of the 13 missions
// anyway. A hit costs you speed, through Coulomb friction against a zero-
// bounciness material, and the ability to turn out of it for 0.3 s.
//
// That answers the question for an AI racer too, and it answers it the same way
// for a racer mid-race and a racer that has finished: there is no third
// behaviour to invent, because hitting the ground is the WORLD, not a game rule.
// A racing rule would have to differ between the two cases; a wall does not. The
// thing that differs after the finish is where the racer chooses to fly, which
// is `ai-racer.ts`'s fly-out branch and not this file's business.

export interface GroundContactSpec {
  readonly hover: HoverMotorSpec
  readonly collision: TerrainCollisionSpec
}

export interface GroundContactState {
  readonly hover: HoverMotorState
  readonly collision: TerrainCollisionState
  /**
   * The body's own `angularDrag` before any contact, so `Flash()` has something
   * to multiply and something to fall back to.
   *
   * Held PER STATE rather than module-level, and that is the whole of trap 19 in
   * one field: a shared base would let the first ship to touch a hillside hand
   * its tripled drag to the second as if it were the second's resting value.
   */
  readonly baseAngularDrag: number
}

/**
 * One ship's ground state. One per ship — never shared, never module-level.
 *
 * `baseAngularDrag` is read off the body at construction, which is the sheet's
 * value on a fresh HoverJet and the right thing to restore to.
 */
export const createGroundContact = (baseAngularDrag: number): GroundContactState => ({
  hover: createHoverMotor(),
  collision: createTerrainCollision(),
  baseAngularDrag,
})

/**
 * Hover, then collide, then set the angular drag. Call it AFTER the flight model
 * has moved the body.
 *
 * Returns true on the tick a contact STARTS — what a caller hangs a sound or a
 * particle burst off.
 *
 * The hover motor goes FIRST and that is load-bearing: its whole job is to stop
 * the ship reaching the ground, so it has to act before the thing that resolves
 * having reached it.
 */
export const stepGroundContact = (
  state: GroundContactState,
  body: RigidBody,
  fields: readonly HeightField[],
  spec: GroundContactSpec,
  dt: number,
): boolean => {
  stepHoverMotor(state.hover, body, fields, spec.hover)
  const struck = stepTerrainCollision(state.collision, body, fields, spec.collision, dt)
  body.angularDrag = collisionAngularDrag(state.collision, spec.collision, state.baseAngularDrag)
  return struck
}

/**
 * The HoverJet's ground spec, off the sheet. Every ship flying the shipped
 * `PlayerShip_SR14_Photon.prefab` hull shares this one object.
 *
 * ── The four numbers that are NOT from the sheet, and why ─────────────────
 *
 * CLAUDE.md rule 3: a numeric literal under `src/sim/` is a code smell that
 * needs justifying. These four are justified, and the justification is that
 * **there is nothing in the Unity project to extract them from**:
 *
 *   restitution 0, friction 0.6   `m_Material: {fileID: 0}` on all five ship
 *                                 colliders — PhysX's built-in default, which
 *                                 lives in the ENGINE, not in an asset.
 *   flashSeconds 0.3              `Ship_HoverShip.Flash()`'s
 *                                 `WaitForSeconds(0.3f)` — a code constant in a
 *                                 coroutine, never serialised.
 *   flashAngularDrag 3            the same coroutine's `angularDrag * 3`.
 *
 * All four would be tagged `trust: "code-default"` if the extractor could see
 * them, and hard rule 2's test passes: none is a `public` field initialiser
 * whose prefab value could differ. They were already written by hand in
 * `game/flight.ts` with this same provenance; this moves them to where both
 * ships can read one copy.
 *
 * Zero bounciness is the load-bearing one. A hull that bounced would turn every
 * mistake into a pinball, and 2016 deliberately did not have that.
 */
export const HOVERJET_GROUND: GroundContactSpec = {
  hover: {
    // Off the PREFAB. The C# initialisers say 65 and 3.5 — and the C#'s HEIGHT
    // is the same number as the prefab's FORCE, so a misread lands somewhere
    // plausible and 18x too strong. See `hover-motor.ts`.
    hoverForce: HOVERJET.hoverMotor.hoverForce,
    hoverHeight: HOVERJET.hoverMotor.hoverHeight,
  },
  collision: {
    hull: hullFromColliders(
      HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
    ),
    restitution: 0,
    friction: 0.6,
    flashSeconds: 0.3,
    flashAngularDrag: 3,
  },
}

export type { Vec3 }
