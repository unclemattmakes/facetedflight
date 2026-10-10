// src/sim/sky-dome.ts — the sky as faceted geometry, not as a gradient.
//
// Matt: *"i thought visually, we were rendering a lowpoly skybox?"*
//
// He was right and we were not. `render/sky.ts` drew a `SphereGeometry(1,
// 64, 32)` shaded per fragment: a smooth vertical gradient with the extracted
// spherical harmonics on top. The 2016 sky is
// `Quantum Theory/PolyWorld Skies/SkyJ.mat`, and opening its six faces settles
// it — **facets everywhere**: chunky cloud masses in flat polygons, a faceted
// band along the horizon, and the sun as a bright hexagon rather than a disc.
// PolyWorld Skies is a LOW-POLY sky pack, which is presumably why it was bought
// for a low-poly game.
//
// So the colour was right and the delivery was wrong. `lighting.sky.sh` carries
// the real sky's colour in every direction to nine coefficients, validated
// against the mission's own sun to 1.5 degrees. What this file adds is the
// surface to paint it on: an icosphere, jittered so the facets are irregular,
// and one flat colour per face.
//
// ── Why the facets have to be irregular ──────────────────────────────────
//
// The same lesson the clouds just taught. A subdivided icosahedron is a regular
// solid subdivided regularly: its faces are near-identical and near-coplanar
// with their neighbours, so a smooth field sampled per face reads as a smooth
// sphere with faint banding, not as facets. The vertex jitter is what turns
// "quantised" into "faceted" — and SkyJ's own cells are visibly irregular, so
// this is the faithful answer as well as the good-looking one.
//
// SIM LAYER: pure. No three, no DOM, no `Math.random()`.

import { icosphere } from '@/sim/clouds'
import { insideUnitSphere, makeRandom } from '@/sim/terrain/faceted'

/** A flat-shaded dome: split triangles, plus each face's own direction. */
export interface SkyDomeMesh {
  /** 9 floats per triangle, on a unit sphere. */
  readonly positions: Float32Array
  /**
   * 3 floats per TRIANGLE — the unit direction of each face's centre.
   *
   * This is what a colour is looked up with, and it is emitted rather than
   * recomputed because the caller would otherwise average three jittered
   * vertices and get a direction that is not quite a unit vector, on a
   * different ray to the one the face actually covers.
   */
  readonly faceDirections: Float32Array
  readonly triangleCount: number
}

/**
 * How far a dome vertex may wander, as a fraction of the sphere's radius.
 *
 * Small: the dome is at infinity, so displacement is only ever an angular
 * change, and a vertex moved 3% of the radius shifts the facet edge by about
 * two degrees. That is enough to break the icosahedral regularity — which is
 * all it has to do — without letting two facets swap places and fold the
 * silhouette of the sun through itself.
 */
export const DOME_JITTER = 0.03

/**
 * Build the dome.
 *
 * Mean cell size is `sqrt(4*pi / faces)`. Subdivision 2 is 320 faces at 11.4
 * degrees, 3 is 1,280 at 5.7, 4 is 5,120 at 2.8. SkyJ's cells span roughly a
 * tenth of a cube face — 6 to 11 degrees — so 3 is the match; the finer levels
 * are there for a mission that wants a smoother sky.
 *
 * The result is a UNIT sphere. The caller scales and positions it; nothing here
 * knows how far away the sky is, because nothing should.
 */
export const generateSkyDome = (subdivisions: number, seed: number): SkyDomeMesh => {
  const { vertices, faces } = icosphere(subdivisions)
  const rnd = makeRandom(seed)

  // Jitter the SHARED vertices, before the split — the clouds' lesson, and for
  // the same reason: after the split each face's copy moves on its own and the
  // dome opens up into gaps that show the clear colour behind it.
  const moved = new Float32Array(vertices.length)
  const offset = { x: 0, y: 0, z: 0 }
  const count = vertices.length / 3
  for (let v = 0; v < count; v++) {
    insideUnitSphere(rnd, offset)
    const x = (vertices[v * 3] as number) + offset.x * DOME_JITTER
    const y = (vertices[v * 3 + 1] as number) + offset.y * DOME_JITTER
    const z = (vertices[v * 3 + 2] as number) + offset.z * DOME_JITTER
    // Back onto the unit sphere. The jitter is an ANGULAR perturbation; letting
    // the radius vary would make the dome lumpy, and a lumpy sky at a finite
    // radius parallaxes against itself as the camera turns.
    const l = Math.hypot(x, y, z) || 1
    moved[v * 3] = x / l
    moved[v * 3 + 1] = y / l
    moved[v * 3 + 2] = z / l
  }

  const triangleCount = faces.length / 3
  const positions = new Float32Array(triangleCount * 9)
  const faceDirections = new Float32Array(triangleCount * 3)
  for (let f = 0; f < triangleCount; f++) {
    const p = f * 9
    let cx = 0
    let cy = 0
    let cz = 0
    for (let k = 0; k < 3; k++) {
      const i = (faces[f * 3 + k] as number) * 3
      const x = moved[i] as number
      const y = moved[i + 1] as number
      const z = moved[i + 2] as number
      positions[p + k * 3] = x
      positions[p + k * 3 + 1] = y
      positions[p + k * 3 + 2] = z
      cx += x
      cy += y
      cz += z
    }
    const l = Math.hypot(cx, cy, cz) || 1
    faceDirections[f * 3] = cx / l
    faceDirections[f * 3 + 1] = cy / l
    faceDirections[f * 3 + 2] = cz / l
  }

  return { positions, faceDirections, triangleCount }
}

/**
 * Nine-coefficient SH radiance in a direction, three.js `SphericalHarmonics3`
 * basis order.
 *
 * The CPU twin of the `shRadiance` that used to run per fragment in
 * `render/sky.ts`. Moved here because the sky is now coloured per FACE, and a
 * few thousand evaluations at load beat a million a frame.
 *
 * Clamped at zero: SH rings where the real sky has a hard edge, and on a sunset
 * horizon it does. A negative radiance is not a colour. That clamp is the
 * visible half of the 37.6% residual the extractor reports, so it is named
 * rather than hidden.
 */
export const shRadiance = (
  sh: readonly (readonly number[])[],
  x: number,
  y: number,
  z: number,
  out: { r: number; g: number; b: number },
): { r: number; g: number; b: number } => {
  const basis = [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ]
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < 9; i++) {
    const k = basis[i] as number
    const c = sh[i]
    if (!c) continue
    r += (c[0] as number) * k
    g += (c[1] as number) * k
    b += (c[2] as number) * k
  }
  out.r = r > 0 ? r : 0
  out.g = g > 0 ? g : 0
  out.b = b > 0 ? b : 0
  return out
}

/**
 * The faceted cloud masses SkyJ has and nine coefficients cannot hold.
 *
 * FF2's own art, and the honest half of the residual: the extractor reports
 * 37.6% error on SkyJ, and looking at the faces says where it goes — chunky
 * dark-blue cloud banks across the upper sky, which are high frequency and
 * therefore exactly what an SH projection throws away.
 *
 * Built the clouds' way, because it is the same problem: a handful of
 * directional lobes, summed. Returns 0 in clear sky and up to 1 inside a bank.
 */
export const skyCloudMask = (
  lobes: Float32Array,
  lobeCount: number,
  x: number,
  y: number,
  z: number,
): number => {
  let m = 0
  for (let i = 0; i < lobeCount; i++) {
    const d =
      x * (lobes[i * 4] as number) +
      y * (lobes[i * 4 + 1] as number) +
      z * (lobes[i * 4 + 2] as number)
    if (d > 0) m += (lobes[i * 4 + 3] as number) * d ** SKY_CLOUD_SHARPNESS
  }
  return m > 1 ? 1 : m
}

/** How tightly a sky-cloud lobe falls off. Higher is a smaller, harder bank. */
export const SKY_CLOUD_SHARPNESS = 5

/**
 * Lobe directions and weights for the sky's cloud banks.
 *
 * Biased ABOVE the horizon: SkyJ's banks sit in the upper sky and the band
 * along the horizon is clear. `bias` 0.35 lifts the draw so roughly three in
 * four land above the equator, which is the shape of the reference.
 */
export const skyCloudLobes = (count: number, seed: number): Float32Array => {
  const rnd = makeRandom(seed)
  const out = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const yUp = rnd() * 2 - 1 + 0.35
    const a = rnd() * Math.PI * 2
    const clamped = yUp > 1 ? 1 : yUp
    const r = Math.sqrt(Math.max(0, 1 - clamped * clamped))
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const l = Math.hypot(x, clamped, z) || 1
    out[i * 4] = x / l
    out[i * 4 + 1] = clamped / l
    out[i * 4 + 2] = z / l
    out[i * 4 + 3] = 0.5 + rnd() * 0.8
  }
  return out
}

// ── The sun, which the dome cannot draw ──────────────────────────────────
//
// DEV-293, wishlist #22b. Matt: *"our 'sun' shows up oddly on the faceted sky.
// maybe it should be a bloom instead?"* Photographed on `int_01_hoverJet` at
// `?view=cam&cam=sky-only`, what is on screen is an angular, asymmetric SHARD
// with a spike up-left and another right — the brightest few TRIANGLES of the
// dome, clipped to white, with their own edges for a silhouette.
//
// That is not a sun drawn badly. It is a sun not drawn at all: nine spherical
// harmonics cannot hold a disc (the extractor reports a 37.6 % residual on
// SkyJ, and this is most of it), and `render/sky.ts` was adding its own disc
// term to a field sampled ONCE PER FACE. A 1.8-degree feature quantised onto a
// 1.4-degree triangulation is three or four polygons, and their union is a
// shard whichever way the jitter happened to fall.
//
// So the disc needs a surface of its own, at the angular scale of the disc
// rather than of the sky. This is that surface: a spherical cap centred on the
// sun, tessellated finely enough that the falloff is smooth across it, welded
// into the dome's own geometry by `render/sky.ts`.
//
// ── Why a cap on the dome and not a billboard ────────────────────────────
//
// `docs/plan/WISHLIST-2026-09-21.md` §2c prescribes *"a billboard disc, plus
// the bloom that already exists"*, and this is that disc by a route that costs
// less. A cap welded into the dome inherits, by construction rather than by
// remembering:
//
//   * the dome's DRAW ORDER and far-plane pin (`setSkyLast`, DEV-241), so it is
//     occluded by the world exactly as the sky behind it is;
//   * the dome's LAYER, so it cannot land on 1 or 2 and ship monocular
//     (DEV-141 — the trap §2c warns a separate billboard would have to dodge);
//   * the dome's MATERIAL, so there is no second program, no second cache key
//     and no `onBeforeCompile` to tag (DEV-177a / DEV-186 / DEV-194);
//   * the PMREM prefilter, so what LIGHTS the world stays exactly what is drawn
//     behind it — which is `render/sky.ts`'s own stated reason for prefiltering
//     the dome rather than a second sphere.
//
// A billboard would have had to reproduce all four, correctly, in a file where
// each of them has already cost a session. The cap is always square to the eye
// anyway: the camera sits at the dome's centre, so a cap on the sphere faces it
// from every direction a billboard would have turned to.
//
// SIM LAYER: still pure. This returns numbers on a unit sphere and knows
// nothing about what draws them.

/** A tessellated spherical cap: split triangles, plus each VERTEX's angle. */
export interface SunCapMesh {
  /** 9 floats per triangle, on a unit sphere. */
  readonly positions: Float32Array
  /**
   * 3 floats per TRIANGLE — the cosine of the angle from the cap's centre at
   * each of its three vertices.
   *
   * Per vertex, not per face, because the whole point of the cap is that its
   * colour VARIES across a triangle. `faceDirections` on the dome is the
   * opposite choice for the opposite reason.
   */
  readonly vertexCosines: Float32Array
  readonly triangleCount: number
}

/**
 * Triangles in a cap of `rings` rings and `segments` segments.
 *
 * One fan of `segments` triangles at the centre, then `rings - 1` bands of
 * `2 * segments`. Exported so the count is derived in one place and the specs
 * that pin the dome's size import it rather than writing a sum down — the
 * checklist-count rule, in the form a geometry budget takes.
 */
export const sunCapTriangles = (rings: number, segments: number): number =>
  segments * (2 * rings - 1)

/**
 * Build a cap of unit vectors around `dir`, out to `outerRadians`.
 *
 * The rings are spaced LINEARLY in angle. The falloff the caller paints across
 * them occupies the outer two thirds of the radius, so a linear walk already
 * spends most of its rings where the gradient is, and a power law would buy
 * resolution in the one place — the blown-out core — where nothing can see it.
 *
 * Wound to match `generateSkyDome`: the face normal points AWAY from the
 * origin, which is what `side: THREE.BackSide` wants from inside. Asserted
 * against the dome's own winding in `tests/unit/sky-dome.test.ts` rather than
 * stated here, because a winding convention written down twice is a belief
 * written down twice (the orientation lesson).
 */
export const generateSunCap = (
  dir: readonly [number, number, number],
  outerRadians: number,
  rings: number,
  segments: number,
): SunCapMesh => {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const cx = dir[0] / l
  const cy = dir[1] / l
  const cz = dir[2] / l

  // Any two vectors perpendicular to the centre will do — the cap is
  // rotationally symmetric, so the basis decides only where vertex zero lands.
  // Seeded off the axis the centre is LEAST aligned with, so the cross product
  // is never near zero.
  const ax = Math.abs(cx)
  const ay = Math.abs(cy)
  const az = Math.abs(cz)
  const seed: [number, number, number] =
    ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  let e1x = cy * seed[2] - cz * seed[1]
  let e1y = cz * seed[0] - cx * seed[2]
  let e1z = cx * seed[1] - cy * seed[0]
  const e1l = Math.hypot(e1x, e1y, e1z) || 1
  e1x /= e1l
  e1y /= e1l
  e1z /= e1l
  // `e2 = centre x e1`, so (e1, e2, centre) is right-handed and walking phi
  // upward runs counter-clockwise seen from OUTSIDE the sphere.
  const e2x = cy * e1z - cz * e1y
  const e2y = cz * e1x - cx * e1z
  const e2z = cx * e1y - cy * e1x

  // ring 0 is the centre point itself; rings 1..rings are the bands' edges.
  const ringCount = rings + 1
  const vx = new Float64Array(ringCount * segments)
  const vy = new Float64Array(ringCount * segments)
  const vz = new Float64Array(ringCount * segments)
  const vc = new Float64Array(ringCount * segments)
  for (let r = 0; r < ringCount; r++) {
    const theta = (outerRadians * r) / rings
    const st = Math.sin(theta)
    const ct = Math.cos(theta)
    for (let s = 0; s < segments; s++) {
      const phi = (Math.PI * 2 * s) / segments
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      const i = r * segments + s
      vx[i] = cx * ct + (e1x * cp + e2x * sp) * st
      vy[i] = cy * ct + (e1y * cp + e2y * sp) * st
      vz[i] = cz * ct + (e1z * cp + e2z * sp) * st
      vc[i] = ct
    }
  }

  const triangleCount = sunCapTriangles(rings, segments)
  const positions = new Float32Array(triangleCount * 9)
  const vertexCosines = new Float32Array(triangleCount * 3)
  let t = 0
  const emit = (a: number, b: number, c: number): void => {
    const p = t * 9
    const q = t * 3
    const idx = [a, b, c]
    for (let k = 0; k < 3; k++) {
      const i = idx[k] as number
      positions[p + k * 3] = vx[i] as number
      positions[p + k * 3 + 1] = vy[i] as number
      positions[p + k * 3 + 2] = vz[i] as number
      vertexCosines[q + k] = vc[i] as number
    }
    t++
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      const inner = r * segments + s
      const inner2 = r * segments + s2
      const outer = (r + 1) * segments + s
      const outer2 = (r + 1) * segments + s2
      if (r === 0) {
        // Ring 0's `segments` copies are all the same point; use one of them as
        // the fan's apex so the band loop below needs no special case.
        emit(inner, outer, outer2)
      } else {
        emit(inner, outer, outer2)
        emit(inner, outer2, inner2)
      }
    }
  }
  return { positions, vertexCosines, triangleCount }
}
