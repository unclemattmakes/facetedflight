// src/sim/surface-proximity.ts — how close is the NEAREST surface, not just the
// one under the belly. DEV-112.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// Matt, 2026-09-15: *"flying low IS fun — and intense. we should also score
// near misses and whatnot, so hugging a wall scores higher."*
//
// G1 (`proximity.ts`) and G2's CLOSE (`gate-quality.ts`) were both keyed on
// `hullClearance`, and that number is VERTICAL by its own admission: *"a cliff
// face 3 m off the wingtip reads as whatever is under the belly."* So a canyon
// wall paid nothing and a knife-edge pass down a ridge paid nothing, which is
// the opposite of what the sensation §2.3 names — skimming — feels like when
// the thing you are skimming is beside you rather than under you.
//
// ── What this measures, and what each number is the distance OF (DEV-027) ─
//
// A hull sphere at centre `c` with radius `r`, and a unit direction `d`. The
// GAP function along the probe is
//
//     g(t) = (c.y + d.y·t) − h(c.x + d.x·t, c.z + d.z·t)
//
// the vertical height of the probe line above the surface at distance `t`
// along it. The probe ENTERS the surface at the first root of `g`. The reading
// for that probe is **`t* − r`: METRES along `d` from the sphere's surface to
// the point where the line through its centre enters the terrain or the
// water**, whichever it meets first. It is a distance along ONE fixed line, so
// it is an UPPER BOUND on the true nearest-surface distance: a wall that sits
// between two probes is seen by neither until it is close enough to cross one.
// Six lines are a fan, not a sphere, and the row says so.
//
// **The vertical reading is the same function with a direction that has no
// horizontal component.** Then `h` is constant along the march, `g` is linear
// in `t`, and the root is `g(0)` in one sample — which is exactly
// `hullClearance`'s `py − r − h`, signed, unbounded, negative while buried. It
// is not a second measurement bolted on beside the probes; it is the probe the
// march is unnecessary for. That is what makes `nearest` ONE number: G1's
// meter and G2's CLOSE read the same field, and a reach of 0 collapses this
// module to the belly line the port had before, exactly.
//
// The march samples at the height field's OWN grid pitch (`field.step`, 8 m on
// every 2016 land terrain), because that is the finest structure the surface
// can express — a feature narrower than a facet does not exist in this
// collider. Between the last clear sample and the first buried one the root is
// interpolated linearly, which is exact for a planar face and within a step of
// exact for anything else. Reach is the FAR end of G1's ramp (`farMetres`):
// beyond it the meter reads nothing anyway, so a longer march would be samples
// spent on a number nobody reads.
//
// ── The sample budget, counted ────────────────────────────────────────────
//
// Per tick: for every hull sphere and every field, ONE sample for the vertical
// (which is also the `t = 0` bracket of every march) plus `ceil(reach / pitch)`
// per probe, where `pitch` is the field's grid step in WORLD metres.
// `sampleBudget()` is that formula and `SurfaceProximity.samples` is the count
// actually taken, so a test can pin one against the other. With the HoverJet's
// five spheres, two 8 m fields and a 90 m reach that is 5 × 2 × (1 + 6 × 12) =
// 730 bilinear reads; on the real island the ocean plate's pitch is 256 m (32
// scaled by 8), its march is one sample, and the bound is 5 × (73 + 7) = 400.
// Upper bounds, because a march stops at its first hit. At 82 Hz the island's
// is 33k reads a second. `tests/unit/surface-proximity.test.ts` asserts both.
//
// SIM LAYER: no three, no DOM, no wall clock, no allocation in the hot path.
// Readings are written to a caller-OWNED `out` — never a module scratch — so a
// second ship stepped after the first cannot move the first's numbers (trap
// 19, DEV-032).

import { rotateVec3 } from './math/quat'
import { type Vec3, v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'
import { belowField, type HeightField, outsideField, terrainHeightAt } from './terrain/height-field'
import { type HullSphere, hullSphereWorld } from './terrain-collision'

/** What one call measured. Owned by the caller; see the header's last paragraph. */
export interface SurfaceProximity {
  /**
   * METRES to the nearest probed surface: the minimum of `below` and every
   * march. Signed like `below` while buried, clamped at 0 for a lateral hit
   * inside the sphere's own radius, `Infinity` when nothing is within reach.
   */
  nearest: number
  /**
   * METRES from the lowest point of the hull straight DOWN to the surface —
   * `hullClearance`'s number, produced here by the same gap function with a
   * vertical direction. Signed; negative while inside the ground.
   */
  below: number
  /**
   * Which probe produced `nearest`: an index into `PROBES`, or -1 when the
   * vertical won (or nothing did). For telemetry and the lap printout.
   */
  probe: number
  /** Height samples this call took. Pinned against `sampleBudget()` in test. */
  samples: number
}

export const createSurfaceProximity = (): SurfaceProximity => ({
  nearest: Number.POSITIVE_INFINITY,
  below: Number.POSITIVE_INFINITY,
  probe: -1,
  samples: 0,
})

/**
 * The fan, in the SHIP's frame (SIM space: +x right, +y up, +z forward).
 *
 * Six unit directions — geometry, not tuning, which is why they are literals:
 * the two beam directions, straight down in the ship's own frame (which is
 * what faces a wall in a knife-edge bank, when world-down faces the sky's
 * side of the valley), the two lower diagonals between them, and forward-down
 * for the ridge you are about to skim. Nothing points up or aft: there is no
 * such thing as hugging the sky, and a wall behind you is one you have
 * already passed.
 */
export const PROBES: readonly Vec3[] = Object.freeze([
  Object.freeze(v3(-1, 0, 0)),
  Object.freeze(v3(1, 0, 0)),
  Object.freeze(v3(0, -1, 0)),
  Object.freeze(v3(-Math.SQRT1_2, -Math.SQRT1_2, 0)),
  Object.freeze(v3(Math.SQRT1_2, -Math.SQRT1_2, 0)),
  Object.freeze(v3(0, -Math.SQRT1_2, Math.SQRT1_2)),
]) as readonly Vec3[]

/** Names for `SurfaceProximity.probe`, same order as `PROBES`. */
export const PROBE_NAMES: readonly string[] = Object.freeze([
  'left',
  'right',
  'down',
  'lower-left',
  'lower-right',
  'forward-down',
])

/** The field's grid pitch in WORLD metres — `step` is mesh space, the ocean plates are scaled. */
export const worldPitch = (field: HeightField): number => field.step * (field.scaleX || 1)

/** Samples per probe: the reach at the field's own pitch, rounded up. */
export const marchSteps = (field: HeightField, reachMetres: number): number => {
  const pitch = worldPitch(field)
  return reachMetres > 0 && pitch > 0 ? Math.ceil(reachMetres / pitch) : 0
}

/**
 * The most samples one call can take: the header's formula. An UPPER bound —
 * a march stops at its first hit, and a buried sphere marches nowhere.
 */
export const sampleBudget = (
  spheres: number,
  fields: readonly HeightField[],
  reachMetres: number,
): number => {
  let n = 0
  for (const field of fields) n += spheres * (1 + PROBES.length * marchSteps(field, reachMetres))
  return n
}

const _centre = v3()
const _dir = v3()

/**
 * Measure. Writes `out` and returns it.
 *
 * `reachMetres` is how far each lateral probe marches before answering
 * `Infinity`; the vertical is unbounded regardless. Pass 0 and this IS
 * `hullClearance` — the belly-only path, unchanged.
 */
export const probeSurface = (
  body: RigidBody,
  fields: readonly HeightField[],
  hull: readonly HullSphere[],
  reachMetres: number,
  out: SurfaceProximity,
): SurfaceProximity => {
  let nearest = Number.POSITIVE_INFINITY
  let below = Number.POSITIVE_INFINITY
  let probe = -1
  let samples = 0
  const reach = reachMetres > 0 && Number.isFinite(reachMetres) ? reachMetres : 0

  for (const sphere of hull) {
    hullSphereWorld(
      _centre,
      body.position.x,
      body.position.y,
      body.position.z,
      body.orientation,
      sphere,
    )
    const cx = _centre.x
    const cy = _centre.y
    const cz = _centre.z
    const r = sphere.radius

    for (const field of fields) {
      // ── the vertical: g(0), one sample, exact ──────────────────────
      //
      // `Infinity` outside the field's footprint, the way `hullClearance`
      // reads it: a sphere beyond the edge has no ground under it here. And,
      // since DEV-705, a sphere wholly under a floating pad has none either:
      // `hullClearance` makes the same `belowField` test, and this number is
      // its twin to the bit.
      let g0 = Number.POSITIVE_INFINITY
      if (!outsideField(field, cx, cz) && !belowField(field, cy + r)) {
        const h = terrainHeightAt(field, cx, cz)
        samples++
        // In `hullClearance`'s own operand order, so the two are equal to the
        // bit and a test can say `toBe` rather than `toBeCloseTo`.
        const vertical = cy - r - h
        g0 = cy - h
        if (vertical < below) below = vertical
        if (vertical < nearest) {
          nearest = vertical
          probe = -1
        }
        // Buried, or touching: the march would start inside the surface it
        // is looking for. The signed vertical is the whole answer.
        if (vertical <= 0) continue
      }

      // ── the fan ─────────────────────────────────────────────────────
      const steps = marchSteps(field, reach)
      if (steps === 0) continue
      const dt = reach / steps
      for (let p = 0; p < PROBES.length; p++) {
        rotateVec3(_dir, body.orientation, PROBES[p] as Vec3)
        let prevT = 0
        let prevG = g0
        for (let k = 1; k <= steps; k++) {
          const t = k * dt
          const sx = cx + _dir.x * t
          const sy = cy + _dir.y * t
          const sz = cz + _dir.z * t
          if (outsideField(field, sx, sz)) {
            // No surface to read here. Not a hit, and not a bracket either:
            // a hit on the next sample takes that sample's own `t`.
            prevT = t
            prevG = Number.POSITIVE_INFINITY
            continue
          }
          const g = sy - terrainHeightAt(field, sx, sz)
          samples++
          if (g > 0) {
            prevT = t
            prevG = g
            continue
          }
          // Entered the surface between the last sample and this one. The
          // root of a line through (prevT, prevG) and (t, g); the sample's own
          // `t` when the previous one was unreadable, which overstates the
          // distance by at most one step.
          const tStar =
            Number.isFinite(prevG) && prevG > g ? prevT + ((t - prevT) * prevG) / (prevG - g) : t
          // From the sphere's SURFACE, and never negative: a face inside the
          // sphere's own radius with the vertical still clear is "touching".
          const along = tStar - r
          const reading = along > 0 ? along : 0
          if (reading < nearest) {
            nearest = reading
            probe = p
          }
          break
        }
      }
    }
  }

  out.nearest = nearest
  out.below = below
  out.probe = probe
  out.samples = samples
  return out
}
