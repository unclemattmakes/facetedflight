// src/sim/props/generate-bird.ts — a bird, and the loop it flies.
//
// ANNIVERSARY.md §2.5 S5, DEV-089.
//
// ── A flock is a scale cue AND a speed cue ───────────────────────────────
//
// §1.1: familiar size works at any distance, and a bird is the most familiar
// size there is — a person knows a gull is about a metre across without being
// told. Put one at 100 m and the ridge behind it has a ruler laid on it.
//
// §2.1 is the other half: perceived speed is optic flow, v/d, so the near field
// dominates and the game's near field is empty. A flock crossing the canopy at
// 40 m is a thing that sweeps past at a rate the eye can read, which is the same
// argument the motes are built on (DEV-080) with the difference that a bird is
// an OBJECT — it has a known size, so it says how fast AND how far.
//
// ── Two triangles, and a flap in the vertex shader ───────────────────────
//
// A bird at 40–300 m is a silhouette with a beat. Two triangles carry that: a
// body on the fore-aft axis and a wing either side. The BEAT is what makes it
// read as alive rather than as a drifting speck, and it is four lines of GLSL in
// `render/dressing.ts` — the wing tips rotate about the body axis by
// `sin(t * rate + phase)`, one phase per instance, so a flock beats out of step
// the way a real one does.
//
// The bird's SPAN is 1 by construction, exactly as a prop's width is, so the
// preset's `size` is metres across and the number means the thing it says.
//
// ── Why the loop is here and not in the renderer ─────────────────────────
//
// The path a flock flies is a placement, and placements are data this layer
// computes once and hands over (hard rule 6). `birdAt` is a pure function of
// (flock, bird, seconds) — no `dt`, no accumulator, no state — so it is exactly
// periodic, it can be asserted in a headless test, and a paused frame and a
// resumed one at the same clock give the same answer.
//
// SIM LAYER: pure. No three, no DOM, no `Math.random`, no wall clock.

import { writeFlatTri } from '@/sim/math/flat-tri'

/** A bird, as a triangle soup. Span 1, nose on +z, up on +y. */
export interface BirdMesh {
  /** 9 floats per triangle. */
  readonly positions: Float32Array
  /** 9 floats per triangle, one face normal repeated three times. */
  readonly normals: Float32Array
  readonly triangleCount: number
  /** Wing tip to wing tip. 1 by construction. */
  readonly span: number
}

/**
 * The one bird.
 *
 * Not seeded and not varied: every bird in the world is this mesh, and the
 * variety is in the phase, the size and the loop. A two-triangle silhouette has
 * nothing to vary that anyone could see at the distance it is seen from, and one
 * geometry is what keeps every flock in the world inside a single draw call.
 *
 * Wound so both faces point up; the material is double-sided anyway, because a
 * bird banking past the canopy shows its underside and a back-face-culled bird
 * would blink out for half its loop.
 */
export const generateBird = (): BirdMesh => {
  // Nose at +z, tail at -z, tips at ±x. The tips sit slightly aft of centre, so
  // the silhouette is a shallow V rather than a cross — which is the shape a
  // person reads as "bird" and a cross reads as "aeroplane".
  const nose: readonly [number, number, number] = [0, 0, 0.3]
  const tail: readonly [number, number, number] = [0, 0, -0.22]
  const right: readonly [number, number, number] = [0.5, 0, -0.12]
  const left: readonly [number, number, number] = [-0.5, 0, -0.12]

  const tris: readonly (readonly (readonly [number, number, number])[])[] = [
    [nose, right, tail],
    [nose, tail, left],
  ]

  const triangleCount = tris.length
  const positions = new Float32Array(triangleCount * 9)
  const normals = new Float32Array(triangleCount * 9)
  for (let f = 0; f < triangleCount; f++) {
    const t = tris[f] as readonly (readonly [number, number, number])[]
    const a = t[0] as readonly [number, number, number]
    const b = t[1] as readonly [number, number, number]
    const c = t[2] as readonly [number, number, number]
    writeFlatTri(positions, normals, f * 9, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
  }

  return { positions, normals, triangleCount, span: 1 }
}

/** One bird's place in its flock. */
export interface BirdPlacement {
  /** Where it sits around the loop, 0..1 of a lap. */
  readonly phase: number
  /** Metres it flies outside (+) or inside (-) the flock's own ellipse. */
  readonly spread: number
  /** Metres above (+) or below (-) the flock's plane. */
  readonly rise: number
  /** Metres across. The preset's `size`, varied a little per bird. */
  readonly size: number
  /** Radians of wing-beat phase. Distinct per bird — a flock beating in unison is a mobile. */
  readonly wingPhase: number
  /** Linear RGB, from the preset's palette. */
  readonly color: readonly [number, number, number]
}

/** One flock: an ellipse, tilted a little, at an altitude over the ground it circles. */
export interface FlockPlacement {
  /** The loop's centre, TERRAIN MESH-LOCAL metres — the frame `load-props.ts` works in. */
  readonly centre: readonly [number, number, number]
  /** Metres. The ellipse's two semi-axes, before the heading rotates it. */
  readonly radiusX: number
  readonly radiusZ: number
  /** Radians: the ellipse's rotation about the vertical. */
  readonly heading: number
  /** Radians: how far the loop's plane is tipped out of horizontal. */
  readonly tilt: number
  /** Metres per second along the loop. Signed — half the flocks turn the other way. */
  readonly speed: number
  readonly birds: readonly BirdPlacement[]
}

/** A position and a heading, filled in place. Mesh-local metres and radians. */
export interface BirdPose {
  x: number
  y: number
  z: number
  /** Where the bird is pointing: a unit vector, the tangent of the loop. */
  dx: number
  dy: number
  dz: number
}

export const birdPose = (): BirdPose => ({ x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1 })

/**
 * The angular rate of the loop, radians per second. Signed.
 *
 * `speed` in the preset is **the speed at the flock's MEAN radius**, and saying
 * which radius is the whole of DEV-027's rule: a number nobody says the
 * reference of gets quoted in a comment and built on. The angular rate is
 * constant around the ellipse, so a bird on the wide part of the loop really is
 * moving faster than one on the narrow part — which is how a banking flock
 * looks — and every bird in a flock keeps station because they all share this.
 */
export const flockOmega = (flock: FlockPlacement): number => {
  const meanRadius = (Math.abs(flock.radiusX) + Math.abs(flock.radiusZ)) / 2
  return meanRadius > 1e-6 ? flock.speed / meanRadius : 0
}

/**
 * The flock's lap time, seconds. `2π / |omega|`, and therefore EXACT.
 *
 * This is the quantity a test uses to assert `birdAt` is periodic, which is the
 * property that matters: a bird that drifts by a metre a lap has left its flock
 * by the end of a mission. An earlier draft took the ellipse's perimeter over
 * the speed, which is the lap time of a bird travelling at a constant SPEED —
 * a different animal from one turning at a constant RATE, and periodic only on
 * a circle. Two plausible readings, and only one of them makes the assertion
 * true; that is the agreement lesson in miniature.
 */
export const flockPeriod = (flock: FlockPlacement): number => {
  const omega = Math.abs(flockOmega(flock))
  return omega > 1e-9 ? (Math.PI * 2) / omega : 0
}

/**
 * Where a bird is, and which way it points, at a wall-clock time.
 *
 * PURE and PERIODIC: `birdPose(t)` and `birdPose(t + flockPeriod)` are the same
 * pose, because the angle is taken modulo a full turn rather than integrated.
 * An integrated version accumulates float error and, worse, depends on how many
 * frames have been drawn — so a paused second would cost the flock a metre, and
 * a dropped frame would cost it another.
 *
 * The angle advances at `flockOmega` — `speed / meanRadius` — so a wide flock
 * and a tight one at the same `speed` really are flying at about the same
 * speed, rather than a wide one taking four times as long to come round.
 */
export const birdAt = (
  flock: FlockPlacement,
  bird: BirdPlacement,
  seconds: number,
  out: BirdPose,
): BirdPose => {
  const omega = flockOmega(flock)
  const TAU = Math.PI * 2
  // Modulo, not accumulate. See the doc comment.
  const angle = (((seconds * omega + bird.phase * TAU) % TAU) + TAU) % TAU
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)

  // On the ellipse, in the loop's own frame, then spread and raised.
  const lx = ca * (flock.radiusX + bird.spread)
  const lz = sa * (flock.radiusZ + bird.spread)
  // The tangent, in the same frame. Not normalised yet.
  const tx = -sa * (flock.radiusX + bird.spread) * omega
  const tz = ca * (flock.radiusZ + bird.spread) * omega

  // Tip the plane: the loop leans about its own x axis, so one side of the
  // circuit is higher than the other and the flock reads as banking rather than
  // as a carousel.
  const st = Math.sin(flock.tilt)
  const ct = Math.cos(flock.tilt)
  const ty = lz * st + bird.rise
  const tz2 = lz * ct
  const vy = tz * st
  const vz2 = tz * ct

  // Rotate by the heading, about the vertical.
  const ch = Math.cos(flock.heading)
  const sh = Math.sin(flock.heading)
  out.x = flock.centre[0] + lx * ch - tz2 * sh
  out.y = flock.centre[1] + ty
  out.z = flock.centre[2] + lx * sh + tz2 * ch

  const dx = tx * ch - vz2 * sh
  const dy = vy
  const dz = tx * sh + vz2 * ch
  const len = Math.hypot(dx, dy, dz) || 1
  out.dx = dx / len
  out.dy = dy / len
  out.dz = dz / len
  return out
}
