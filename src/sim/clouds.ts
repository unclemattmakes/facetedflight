// src/sim/clouds.ts — faceted clouds, generated rather than imported.
//
// Matt: *"write a generator - feel free to create blender tools for re-usable
// procedural assets."*
//
// ── Why this is generated and not converted ───────────────────────────────
//
// The 2016 clouds are `GL-Cloud-01` .. `GL-Cloud-06` out of
// `Assets/Geometric-Landscape-Tropic-Island`, a bought pack. That is
// `licence: REPLACE` — the same bucket as the pilot and the seat — and
// `tools/assets/check-assets-present.mjs` refuses to let a REPLACE asset reach
// the public bucket at all (D26). So the geometry has to be ours.
//
// What IS faithful is in `level.clouds`: nineteen placements, composed through
// the level-art prefab instance, with each one's non-uniform scale and which of
// three source silhouettes it wore. This file only has to fill those nineteen
// boxes with something that reads as a low-poly cloud.
//
// ── The shape, and why lobes rather than metaballs ───────────────────────
//
// A cloud is a handful of overlapping bulges. The honest way to build that is a
// metaball field and march it, which is a lot of machinery for something that
// is a few hundred triangles and never seen closer than a hundred metres.
//
// Instead: take an icosphere and push each vertex out along its own direction
// by how much it faces each lobe —
//
//   r(dir) = 1 + Σ strength_i · max(0, dir · lobe_i)^sharpness
//
// which is a smooth sum of directional bulges. High `sharpness` gives tight
// cauliflower knots; low gives a soft pillow. It cannot produce an overhang or
// a hole, and a cloud does not need either. Every vertex stays on a ray from
// the centre, so the result is star-shaped and cannot self-intersect — which
// means no cleanup pass and no degenerate triangles.
//
// Then the triangles are SPLIT, one normal per face. That is the whole look:
// the terrain, the gates and the ship are all flat-shaded, and a smooth cloud
// in the middle of them would read as a different game.
//
// SIM LAYER: pure. No three, no DOM, no `Math.random` — the seed goes in and
// the same bytes come out, so a cloud can be built in a worker or asserted in a
// headless test.

import { blobLobes, crunchVertices, displaceByLobes, splitFlat } from '@/sim/blob'
import { makeRandom } from '@/sim/terrain/faceted'

/**
 * Half the width of a finished cloud, before the placement's own scale.
 *
 * THE ONE NUMBER HERE THAT IS A GUESS, and it is flagged rather than hidden.
 *
 * The placements carry a scale — 182 to 893 — which multiplied the SOURCE
 * mesh, and that mesh is in a bought pack we do not ship and cannot measure
 * from the YAML (an FBX's bounds live in the binary, not in the importer's
 * metadata). So the only thing that fixes the absolute size is what the source
 * mesh was, and it is unknowable at this distance.
 *
 * 0.5 makes the scale read directly as METRES ACROSS: a cloud placed at 543
 * comes out 543 m wide, and the nineteen run 182 m to 893 m. That is the right
 * order for cumulus over a 4 km archipelago, and it is the reading that assumes
 * the pack was authored the way these packs usually are — a roughly unit-sized
 * mesh the artist scales to taste.
 *
 * If the sky reads too big or too small, this is the number to move, and moving
 * it is a deviation rather than a correction, because there is nothing to be
 * correct against.
 */
export const NOMINAL_RADIUS = 0.5

/** A generated cloud: a flat-shaded triangle soup, centred, `NOMINAL_RADIUS` across the mean. */
export interface CloudMesh {
  /** 9 floats per triangle. */
  readonly positions: Float32Array
  /** 9 floats per triangle, one face normal repeated three times. */
  readonly normals: Float32Array
  readonly triangleCount: number
}

export interface CloudShape {
  /**
   * Icosphere subdivisions. 0 is 20 triangles, 1 is 80, 2 is 320, 3 is 1280.
   *
   * 3, because the knots need somewhere to live: at 320 the lobes have so few
   * facets to work with that a high `lobeSharpness` only tilts whole triangles
   * and the silhouette stays a smooth lens. Nineteen clouds at 1280 is 24k
   * triangles against the island's 100k+, built once at load.
   */
  readonly subdivisions: number
  /** How many directional bulges. */
  readonly lobes: number
  /** How far each bulge pushes, as a fraction of the base radius. */
  readonly lobeStrength: number
  /** Bulge tightness. 1 is a soft pillow; 6 is a cauliflower knot. */
  readonly lobeSharpness: number
  /**
   * Vertical squash of the UNIT blob, before the placement's own scale.
   *
   * All three shapes leave this at 1, and that is the point of having it: the
   * PLACEMENTS are already flattened — y is typically 40-50% of x — so a shape
   * that squashes as well squashes twice. The first pass set it to 0.6-0.8 and
   * the clouds came out as flying saucers, which is a 0.32 aspect ratio doing
   * exactly what it says. It stays in the interface so a hand-authored
   * environment with round placements can still ask for a flat cloud.
   */
  readonly flatten: number
  /**
   * How far lobes are pushed toward the horizontal, 0..1.
   *
   * A cloud spreads sideways. Left isotropic the lobes point up and down as
   * often as out, and the silhouette reads as a boulder.
   */
  readonly spread: number
  /**
   * Per-vertex jitter radius, as a fraction of the blob's own radius.
   *
   * THE CRUNCH. A lobed icosphere is smooth: every facet is a regular
   * subdivision of a regular solid, so the silhouette reads as a pillow and the
   * shading reads as a sphere someone forgot to smooth. The game's look is
   * faceted, and faceting only shows when the facets are IRREGULAR.
   *
   * This is the terrain's own trick — `FacetedTerrain` displaces every grid
   * vertex by `Random.insideUnitSphere * RandomOffset` before it triangulates,
   * and that jitter is the whole reason the island reads as carved rather than
   * as a heightmap. Matt: *"they look smooth, where our signature look is
   * mainly 'crunchy low poly' - and that's typically by applying some noise
   * across the verts (like we did w/ the water)."*
   *
   * Applied to the SHARED vertices, before the split. Jittering after the split
   * moves each face's copy independently and the cloud comes apart into
   * confetti — which is the one way to get this wrong, and the reason
   * `clouds.test.ts` counts distinct positions.
   */
  readonly jitter: number
}

/**
 * The three silhouettes, keyed by the source mesh each placement wore.
 *
 * FF2's own art, NOT extracted numbers — the shapes they stand in for cannot
 * ship and were never measured. They are here rather than in the level JSON
 * because they describe the generator, not the mission; a hand-authored course
 * that wants clouds names a shape and gets one, which is rule 6.
 *
 * `"02"` carries seventeen of the nineteen placements, so it is the one that
 * has to look right; `01` and `03` appear once each and exist to stop the sky
 * being one shape repeated.
 */
export const CLOUD_SHAPES: Readonly<Record<string, CloudShape>> = {
  // The workhorse — seventeen of the nineteen. Many tight knots.
  '02': {
    subdivisions: 3,
    lobes: 22,
    lobeStrength: 0.5,
    lobeSharpness: 9,
    flatten: 1,
    spread: 0.75,
    jitter: 0.1,
  },
  // Smaller and puffier: fewer, rounder, deeper bulges, and a coarser crunch —
  // it is the smallest on screen and needs the facets to carry further.
  '01': {
    subdivisions: 3,
    lobes: 13,
    lobeStrength: 0.62,
    lobeSharpness: 5,
    flatten: 1,
    spread: 0.65,
    jitter: 0.13,
  },
  // Torn and streaky, for the one that sits highest.
  '03': {
    subdivisions: 3,
    lobes: 30,
    lobeStrength: 0.46,
    lobeSharpness: 14,
    flatten: 1,
    spread: 0.9,
    jitter: 0.11,
  },
}

/** The shape a placement asks for, falling back to the workhorse. */
export const cloudShape = (shape: string | null): CloudShape =>
  (shape !== null && CLOUD_SHAPES[shape]) || (CLOUD_SHAPES['02'] as CloudShape)

// ── the icosphere ─────────────────────────────────────────────────────────
//
// Built here rather than taken from three's `IcosahedronGeometry` because this
// file may not import three (rule 4), and because what is wanted is the
// VERTEX-SHARED form to subdivide, not the split form three hands back.

const T = (1 + Math.sqrt(5)) / 2

const ICOSAHEDRON_VERTICES: readonly (readonly [number, number, number])[] = [
  [-1, T, 0],
  [1, T, 0],
  [-1, -T, 0],
  [1, -T, 0],
  [0, -1, T],
  [0, 1, T],
  [0, -1, -T],
  [0, 1, -T],
  [T, 0, -1],
  [T, 0, 1],
  [-T, 0, -1],
  [-T, 0, 1],
]

const ICOSAHEDRON_FACES: readonly (readonly [number, number, number])[] = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
]

/**
 * A unit icosphere as a shared-vertex mesh, subdivided `n` times.
 *
 * Midpoints are cached by edge so the two faces sharing an edge get the SAME
 * vertex. Without that the sphere still renders, and every later stage that
 * cares about vertex identity — here, the radial displacement — silently does
 * its work twice with different answers on each side of the seam.
 */
export const icosphere = (subdivisions: number): { vertices: Float32Array; faces: Uint32Array } => {
  const verts: number[] = ICOSAHEDRON_VERTICES.flatMap(([x, y, z]) => {
    const l = Math.hypot(x, y, z)
    return [x / l, y / l, z / l]
  })
  let faces: number[] = ICOSAHEDRON_FACES.flatMap((f) => [f[0], f[1], f[2]])

  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map<number, number>()
    const next: number[] = []
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a
      const hit = mid.get(key)
      if (hit !== undefined) return hit
      const x = ((verts[a * 3] as number) + (verts[b * 3] as number)) / 2
      const y = ((verts[a * 3 + 1] as number) + (verts[b * 3 + 1] as number)) / 2
      const z = ((verts[a * 3 + 2] as number) + (verts[b * 3 + 2] as number)) / 2
      const l = Math.hypot(x, y, z) || 1
      const index = verts.length / 3
      verts.push(x / l, y / l, z / l)
      mid.set(key, index)
      return index
    }
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f] as number
      const b = faces[f + 1] as number
      const c = faces[f + 2] as number
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    faces = next
  }
  return { vertices: new Float32Array(verts), faces: new Uint32Array(faces) }
}

/**
 * Build one cloud.
 *
 * The result is centred on the origin and roughly a unit across, so the
 * placement's own scale is the only thing that sets its size. `seed` is what
 * makes nineteen placements of three shapes read as nineteen clouds.
 */
export const generateCloud = (shape: CloudShape, seed: number): CloudMesh => {
  const { vertices, faces } = icosphere(shape.subdivisions)
  const rnd = makeRandom(seed)

  // ── the lobes ───────────────────────────────────────────────────────────
  //
  // Directions are drawn on the sphere and then flattened toward the
  // horizontal by `spread`, so the bulges go OUT rather than up. Renormalised
  // after flattening, or a lobe pushed flat also pushes weakly. The stage is
  // `sim/blob.ts`'s, shared with the prop generator.
  const lobes = blobLobes(rnd, shape.lobes, shape.spread, shape.lobeStrength)

  // ── displace ────────────────────────────────────────────────────────────
  const count = vertices.length / 3
  const moved = displaceByLobes(vertices, lobes, shape.lobeSharpness, shape.flatten)

  // ── the crunch ──────────────────────────────────────────────────────────
  //
  // Every SHARED vertex, displaced inside a small ball: the terrain's
  // `insideUnitSphere * RandomOffset`, on a sphere instead of a grid. Shared is
  // the whole point: the faces around a vertex all follow it, so the mesh stays
  // closed and only the facet ANGLES change, which is exactly the look.
  //
  // Before the normalising pass, so the jitter is measured in the same units as
  // the blob it is roughening and the finished mean radius is still exact.
  crunchVertices(moved, rnd, shape.jitter)

  // ── normalise the size ──────────────────────────────────────────────────
  //
  // The lobes only ever ADD, so a blob's mean radius drifts up with the lobe
  // count and a 22-lobe shape would come out half again as big as a 9-lobe one
  // for the same placement. Scaling to a fixed MEAN — not a max, which one
  // spike would capture — makes `lobes` a texture control rather than a size
  // control, which is what the shape table assumes.
  let meanRadius = 0
  for (let v = 0; v < count; v++) {
    meanRadius += Math.hypot(
      moved[v * 3] as number,
      moved[v * 3 + 1] as number,
      moved[v * 3 + 2] as number,
    )
  }
  meanRadius = meanRadius / count || 1
  const fit = NOMINAL_RADIUS / meanRadius
  for (let i = 0; i < moved.length; i++) moved[i] = (moved[i] as number) * fit

  // ── split, and take one normal per face ─────────────────────────────────
  //
  // The whole look. Sharing vertices and averaging normals would make a smooth
  // blob in a world where the terrain, the gates and the ship are all flat.
  return splitFlat(moved, faces)
}

/**
 * DEV-414: is the point (x, y, z) inside a generated cloud's HULL? `positions`
 * is `generateCloud`'s triangle soup, in the blob's own frame.
 *
 * Matt, 2026-09-25, on `adv_02_hoverJet`: *"i ended up w/ cloud fx drawing
 * (fade to white) but didn't interpenetrate a cloud when it happened. i got
 * lost, and couldn't finish the course"*. DEV-277's whiteout asked whether
 * the eye was inside the blob's BOUNDING SPHERE. The blob is lobed, so its
 * surface lies anywhere from about 0.26 to 0.84 of that sphere's radius
 * depending on direction (all three shapes, measured). Between two lobes the
 * screen went fully white up to about two thirds of the sphere's radius
 * outside anything drawn, which on `adv_02`'s large clouds is hundreds of
 * metres.
 *
 * A parity ray cast: count the triangles a ray from the point crosses, and
 * an odd count is inside. It holds for any closed hull, lobes and jitter
 * included, so it does not lean on the blob being star-shaped. The direction
 * is fixed and deliberately off every axis and every diagonal, so it does not
 * run along an edge of the regular solid the blob was built from; 1e-12 is a
 * geometry epsilon (a ray parallel to a face), not a tuning number. 1,280
 * triangles, and only for a cloud whose sphere the eye is already inside.
 */
export const insideCloudHull = (
  positions: Float32Array,
  x: number,
  y: number,
  z: number,
): boolean => {
  const dx = 0.3141
  const dy = 0.8623
  const dz = 0.3972
  let crossings = 0
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i] as number
    const ay = positions[i + 1] as number
    const az = positions[i + 2] as number
    const e1x = (positions[i + 3] as number) - ax
    const e1y = (positions[i + 4] as number) - ay
    const e1z = (positions[i + 5] as number) - az
    const e2x = (positions[i + 6] as number) - ax
    const e2y = (positions[i + 7] as number) - ay
    const e2z = (positions[i + 8] as number) - az
    // Moller-Trumbore.
    const px = dy * e2z - dz * e2y
    const py = dz * e2x - dx * e2z
    const pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (det > -1e-12 && det < 1e-12) continue
    const inv = 1 / det
    const tx = x - ax
    const ty = y - ay
    const tz = z - az
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y
    const qy = tz * e1x - tx * e1z
    const qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) continue
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) crossings++
  }
  return (crossings & 1) === 1
}
