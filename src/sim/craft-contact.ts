// src/sim/craft-contact.ts — two ships cannot share the same air. DEV-364.
//
// Matt, 2026-09-24: *"right now players can fly straight into them and through
// them. it'd be nice if that was fixed."*
//
// ── What 2016 did ─────────────────────────────────────────────────────────
//
// Nothing, and on purpose: its opposition was a RECORDING (`GhostRacer`), a
// playback with no collider that the ship's hull could meet. The port's racers
// fly (DEV-026), and a thing that flies beside you and cannot be touched reads
// as a hologram, which is exactly what DEV-350 stopped them looking like. So
// this is an Anniversary rule (`gameplay.racers.contact`), and Classic keeps
// 2016's intangible opposition.
//
// ── The volume: the sheet's hull, composed, as ONE capsule ────────────────
//
// `hoverjet.shipCollisionColliders` is the hull 2016 authored on layer 25
// (`cockPit`), the same five colliders the ground and the forest already meet
// (`HOVERJET_GROUND.collision.hull`, DEV-214). Composed into the ship's frame —
// every box's eight corners and every capsule's two caps through the sheet's
// own composed rotation — they fill:
//
//     x  -2.401 .. 2.034   a 4.435 m beam
//     y  -0.866 .. 1.441
//     z  -3.188 .. 1.705   a 4.893 m length, and both capsules lie along +z
//
// So a craft is a capsule along its own +z, radius HALF THE BEAM, capped at the
// hull's two ends: side by side two ships touch at one beam, nose to tail at one
// length. Derived at load from the sheet, so a retuned prefab moves it — no
// number here is typed (hard rule 3). It is taller than the hull (the radius is
// isotropic about the axis, and the hull is 2.3 m deep against a 4.4 m beam):
// one ship passing a metre over another's canopy counts as touching. A capsule
// is the simplest shape that gets the two cases a race produces — alongside and
// behind — right to the centimetre, and banking cannot change it.
//
// The painted wing tips are wider than the colliders: `measureWingTips` puts
// them at +/-2.89 m (DEV-358), and 2016's wing boxes stop 0.67 m inboard of
// them. The sheet is kept because it is the one hull the sim has — the ground
// and the trees see the same one — and the gap is a call for Matt in the row.
//
// ── The response: a push, never a crash ───────────────────────────────────
//
// Equal hulls, so the closing speed along the contact normal is shared by
// inverse mass: momentum is conserved exactly, whatever the restitution. The
// overlap is removed the same way, so after this runs no two craft
// interpenetrate — the position is corrected, not merely the velocity, which is
// what keeps two ships flying side by side touching from sinking into each
// other a millimetre a tick.
//
// Two numbers from the preset: `restitution`, how much of the closing speed
// comes back out as a push (0 the two move off together, 1 they swap it), and
// `restingSpeed`, the closing speed under which there is no bounce at all. The
// second is the standard cure for contact jitter (Box2D's velocity threshold):
// two ships steered gently into each other lean on one another rather than
// bouncing apart and being steered back in, forever, at the fixed step.
//
// Nothing here reads or writes a crash state, a terrain contact or an impact
// speed, so a push cannot crash anyone by itself. A ship shoved into a hillside
// meets the hillside by DEV-126's rule, which is the world's and not this
// file's.
//
// ── Deterministic ─────────────────────────────────────────────────────────
//
// A fixed pair order (i < j, in the caller's order), a fixed number of passes,
// no allocation, no `Math.random`. A coincident pair — two centres on one
// point, which a teleport can produce — is separated along world +x rather than
// along a direction that does not exist.
//
// ── What it cannot catch ──────────────────────────────────────────────────
//
// It is not swept. Two capsules that close by more than their combined
// diameter in one tick can step through each other between ticks: `2r / dt` is
// **363 m/s** of CLOSING speed. A race is ships flying one way — the fastest
// closing speed it produces is the player's chained ship on the slowest racer —
// and that is well under it. A head-on pass at full speed each way is not.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random()`.

import { HOVERJET } from '@/generated/constants.generated'
import { rotateVec3 } from './math/quat'
import { clamp01 } from './math/scalar'
import { type Vec3, v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'

/**
 * A craft's contact volume: a capsule along the ship's own +z, in its own
 * frame, SIM space. The axis runs from `aft` to `fore` at (`x`, `y`).
 */
export interface CraftVolume {
  readonly x: number
  readonly y: number
  /** Ship-frame z of the aft end of the capsule's AXIS (not of the hull). */
  readonly aft: number
  /** Ship-frame z of the fore end of the capsule's axis. */
  readonly fore: number
  /** Half the hull's beam. */
  readonly radius: number
}

/** The sheet's collider records, as far as a volume needs them. */
export interface CraftColliderInput {
  readonly centerInShipRootSpace: { readonly x: number; readonly y: number; readonly z: number }
  readonly composedFromShipRoot: {
    readonly rotation: {
      readonly x: number
      readonly y: number
      readonly z: number
      readonly w: number
    }
  }
  readonly effective: {
    readonly radius?: number
    readonly height?: number
    readonly halfExtents?: { readonly x: number; readonly y: number; readonly z: number }
  }
  readonly shape?: { readonly direction?: number }
  readonly enabled: boolean
  readonly isTrigger: boolean
}

/** Volatile scratch for `craftVolumeFromColliders`. */
const _local = v3()
const _world = v3()

/**
 * The hull's box in its own frame, from the sheet's colliders, and the capsule
 * that fits it: radius half the beam, capped at the two ends.
 *
 * Every collider enters through its OWN composed rotation — a box through all
 * eight corners, a capsule through both caps plus its radius — because a wing
 * box yawed 38 degrees does not reach as far as its half extent says.
 */
export const craftVolumeFromColliders = (colliders: readonly CraftColliderInput[]): CraftVolume => {
  const lo = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    z: Number.POSITIVE_INFINITY,
  }
  const hi = {
    x: Number.NEGATIVE_INFINITY,
    y: Number.NEGATIVE_INFINITY,
    z: Number.NEGATIVE_INFINITY,
  }
  const take = (c: CraftColliderInput, px: number, py: number, pz: number, pad: number) => {
    _local.x = px
    _local.y = py
    _local.z = pz
    rotateVec3(_world, c.composedFromShipRoot.rotation, _local)
    const cx = c.centerInShipRootSpace.x + _world.x
    const cy = c.centerInShipRootSpace.y + _world.y
    const cz = c.centerInShipRootSpace.z + _world.z
    lo.x = Math.min(lo.x, cx - pad)
    lo.y = Math.min(lo.y, cy - pad)
    lo.z = Math.min(lo.z, cz - pad)
    hi.x = Math.max(hi.x, cx + pad)
    hi.y = Math.max(hi.y, cy + pad)
    hi.z = Math.max(hi.z, cz + pad)
  }
  for (const c of colliders) {
    if (!c.enabled || c.isTrigger) continue
    const e = c.effective
    if (e.halfExtents) {
      const h = e.halfExtents
      for (const sx of [-h.x, h.x])
        for (const sy of [-h.y, h.y]) for (const sz of [-h.z, h.z]) take(c, sx, sy, sz, 0)
    } else if (e.radius !== undefined && e.height !== undefined) {
      // Unity's capsule: `height` is tip to tip, so the axis is height - 2r,
      // along the local axis `direction` names (0 x, 1 y, 2 z; Unity's default
      // is y). A sphere of `radius` swept along it.
      const half = Math.max(0, e.height / 2 - e.radius)
      const axis = c.shape?.direction ?? 1
      for (const s of [-half, half]) {
        take(c, axis === 0 ? s : 0, axis === 1 ? s : 0, axis === 2 ? s : 0, e.radius)
      }
    }
  }
  const radius = (hi.x - lo.x) / 2
  const midZ = (lo.z + hi.z) / 2
  return {
    x: (lo.x + hi.x) / 2,
    y: (lo.y + hi.y) / 2,
    // A hull shorter than it is wide would put the caps past each other; then it
    // is a sphere, centred.
    aft: Math.min(midZ, lo.z + radius),
    fore: Math.max(midZ, hi.z - radius),
    radius,
  }
}

/**
 * The HoverJet's craft volume, off the shipped prefab's colliders. Every racer
 * is a HoverJet and so is the player on every course that races.
 */
export const HOVERJET_CRAFT_VOLUME: CraftVolume = craftVolumeFromColliders(
  HOVERJET.shipCollisionColliders as unknown as readonly CraftColliderInput[],
)

/** `gameplay.racers.contact`, as the sim reads it. */
export interface CraftContactSpec {
  readonly enabled: boolean
  /** 0..1: how much of the closing speed along the normal comes back out as a push. */
  readonly restitution: number
  /** m/s of closing speed under which a contact does not bounce at all. */
  readonly restingSpeed: number
  /** Sweeps over every pair per tick. One resolves a pair; more settle a pile of three. */
  readonly passes: number
}

/** What the last `resolveCraftContacts` did. A reading; nothing is decided off it. */
export interface CraftContactReport {
  /** Pairs found touching, summed over every pass. */
  contacts: number
  /** The fastest closing speed resolved, m/s along the normal. */
  hardest: number
  /** Per craft, in the caller's order: touched something this tick. */
  readonly touched: boolean[]
  /**
   * Per craft, in the caller's order: the hardest closing speed it was struck
   * at this tick, m/s along the normal, and 0 for none. DEV-364 follow-up: the
   * player's entry is what `sim/craft-hit.ts` turns into a hit.
   */
  readonly impact: number[]
  /**
   * Per craft, three numbers each (x, y, z, world): the unit direction that
   * hardest contact pushed it, away from what it met. Meaningless where
   * `impact` is 0.
   */
  readonly away: number[]
  /**
   * Running totals since the report was made: pairs resolved, and the hardest
   * closing speed. A frame spans more than one fixed step, so a probe that
   * reads only the per-tick fields misses a contact that lasted one tick.
   */
  total: number
  hardestEver: number
}

export const createCraftContactReport = (): CraftContactReport => ({
  contacts: 0,
  hardest: 0,
  touched: [],
  impact: [],
  away: [],
  total: 0,
  hardestEver: 0,
})

/** Volatile scratch, valid only inside one `resolveCraftContacts`. */
const _p1 = v3()
const _q1 = v3()
const _p2 = v3()
const _q2 = v3()
const _c1 = v3()
const _c2 = v3()
const _axis = v3()

/** The capsule's axis endpoints, world space. */
const capsuleAxis = (body: RigidBody, volume: CraftVolume, p: Vec3, q: Vec3): void => {
  _axis.x = volume.x
  _axis.y = volume.y
  _axis.z = volume.aft
  rotateVec3(p, body.orientation, _axis)
  p.x += body.position.x
  p.y += body.position.y
  p.z += body.position.z
  _axis.z = volume.fore
  rotateVec3(q, body.orientation, _axis)
  q.x += body.position.x
  q.y += body.position.y
  q.z += body.position.z
}

/**
 * Nearest points between segments p1q1 and p2q2, into `_c1` and `_c2`.
 * Ericson, *Real-Time Collision Detection* §5.1.9, clamped both ways.
 */
const closestBetweenSegments = (p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): void => {
  const d1x = q1.x - p1.x
  const d1y = q1.y - p1.y
  const d1z = q1.z - p1.z
  const d2x = q2.x - p2.x
  const d2y = q2.y - p2.y
  const d2z = q2.z - p2.z
  const rx = p1.x - p2.x
  const ry = p1.y - p2.y
  const rz = p1.z - p2.z
  const a = d1x * d1x + d1y * d1y + d1z * d1z
  const e = d2x * d2x + d2y * d2y + d2z * d2z
  const f = d2x * rx + d2y * ry + d2z * rz
  // A capsule whose axis has no length is a sphere: `a` or `e` is then zero and
  // the parameter on that segment is 0. The guard is a floating-point zero, not
  // a tuning — the HoverJet's axis is 0.46 m long.
  const tiny = Number.EPSILON
  let s = 0
  let t = 0
  if (a <= tiny && e <= tiny) {
    s = 0
    t = 0
  } else if (a <= tiny) {
    t = clamp01(f / e)
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz
    if (e <= tiny) {
      s = clamp01(-c / a)
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z
      const denom = a * e - b * b
      s = denom > tiny ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }
  _c1.x = p1.x + d1x * s
  _c1.y = p1.y + d1y * s
  _c1.z = p1.z + d1z * s
  _c2.x = p2.x + d2x * t
  _c2.y = p2.y + d2y * t
  _c2.z = p2.z + d2z * t
}

/**
 * Metres of air between two craft's capsules; negative when they overlap. A
 * READING, for tests and probes — the same geometry the contact pass uses, so
 * a test of "never inside each other" measures the rule's own shape.
 */
export const craftGap = (a: RigidBody, b: RigidBody, volume: CraftVolume): number => {
  capsuleAxis(a, volume, _p1, _q1)
  capsuleAxis(b, volume, _p2, _q2)
  closestBetweenSegments(_p1, _q1, _p2, _q2)
  return Math.hypot(_c2.x - _c1.x, _c2.y - _c1.y, _c2.z - _c1.z) - volume.radius * 2
}

/**
 * Push apart every pair of craft that touch, and share their closing speed.
 *
 * `bodies` in a FIXED order — the caller's — with null for a craft that is out
 * of play this tick (held by a crash, still on the lift): it neither pushes nor
 * is pushed. Pairs are visited i < j, `spec.passes` times. Mutates positions
 * and velocities; never orientation, never anything else.
 */
export const resolveCraftContacts = (
  bodies: readonly (RigidBody | null)[],
  volume: CraftVolume,
  spec: CraftContactSpec,
  report: CraftContactReport | null = null,
): number => {
  if (report) {
    report.contacts = 0
    report.hardest = 0
    report.touched.length = bodies.length
    report.touched.fill(false)
    report.impact.length = bodies.length
    report.impact.fill(0)
    report.away.length = bodies.length * 3
    report.away.fill(0)
  }
  if (!spec.enabled) return 0
  const reach = volume.radius * 2
  let contacts = 0
  for (let pass = 0; pass < spec.passes; pass++) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]
      if (!a) continue
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]
        if (!b) continue
        // Broad phase: two capsules cannot touch if their centres are further
        // apart than both axes plus both radii.
        const cx = b.position.x - a.position.x
        const cy = b.position.y - a.position.y
        const cz = b.position.z - a.position.z
        const span = volume.fore - volume.aft + reach
        if (cx * cx + cy * cy + cz * cz > span * span) continue
        capsuleAxis(a, volume, _p1, _q1)
        capsuleAxis(b, volume, _p2, _q2)
        closestBetweenSegments(_p1, _q1, _p2, _q2)
        let nx = _c2.x - _c1.x
        let ny = _c2.y - _c1.y
        let nz = _c2.z - _c1.z
        let d = Math.hypot(nx, ny, nz)
        if (d >= reach) continue
        // The overlap is the SEGMENTS' distance, taken before the fallback
        // below borrows `d` for a direction.
        const depth = reach - d
        // Axes crossing through each other: fall back to the centres, and for
        // two centres on one point to world +x — a direction, deterministic,
        // rather than a division by zero.
        if (d <= Number.EPSILON) {
          nx = cx
          ny = cy
          nz = cz
          d = Math.hypot(nx, ny, nz)
          if (d <= Number.EPSILON) {
            nx = 1
            ny = 0
            nz = 0
            d = 1
          }
        }
        nx /= d
        ny /= d
        nz /= d
        const ia = 1 / a.mass
        const ib = 1 / b.mass
        const share = ia + ib
        // ── the overlap, shared by inverse mass ────────────────────────────
        const pa = (depth * ia) / share
        const pb = (depth * ib) / share
        a.position.x -= nx * pa
        a.position.y -= ny * pa
        a.position.z -= nz * pa
        b.position.x += nx * pb
        b.position.y += ny * pb
        b.position.z += nz * pb
        // ── the closing speed, shared the same way ─────────────────────────
        const closing =
          (b.velocity.x - a.velocity.x) * nx +
          (b.velocity.y - a.velocity.y) * ny +
          (b.velocity.z - a.velocity.z) * nz
        if (closing < 0) {
          const e = -closing > spec.restingSpeed ? spec.restitution : 0
          const impulse = (-(1 + e) * closing) / share
          a.velocity.x -= nx * impulse * ia
          a.velocity.y -= ny * impulse * ia
          a.velocity.z -= nz * impulse * ia
          b.velocity.x += nx * impulse * ib
          b.velocity.y += ny * impulse * ib
          b.velocity.z += nz * impulse * ib
          if (report) {
            if (-closing > report.hardest) report.hardest = -closing
            // Who was struck, how hard, and which way it went: `a` along -n,
            // `b` along +n. The hardest contact per craft wins, so a pile of
            // three reports each ship's own worst.
            if (-closing > (report.impact[i] as number)) {
              report.impact[i] = -closing
              report.away[i * 3] = -nx
              report.away[i * 3 + 1] = -ny
              report.away[i * 3 + 2] = -nz
            }
            if (-closing > (report.impact[j] as number)) {
              report.impact[j] = -closing
              report.away[j * 3] = nx
              report.away[j * 3 + 1] = ny
              report.away[j * 3 + 2] = nz
            }
          }
        }
        contacts++
        if (report) {
          report.touched[i] = true
          report.touched[j] = true
        }
      }
    }
  }
  if (report) {
    report.contacts = contacts
    report.total += contacts
    if (report.hardest > report.hardestEver) report.hardestEver = report.hardest
  }
  return contacts
}
