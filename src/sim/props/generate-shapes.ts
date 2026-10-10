// src/sim/props/generate-shapes.ts — boulders, rocks and shrubs, generated.
//
// ANNIVERSARY.md §1.5 item 6 / §3.2 V9, DEV-089.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// §1.3 item 6: *"the palms are the only familiar-size object and there are too
// few of them."* Simonet draws 1,241 of them, on a handful of ridges, and every
// other unit-bearing object beyond the canopy is a facet (8 m, the same at every
// distance) or a gate. §1.4's mechanism follows: with nothing human-sized on the
// ground the eye assumes the facets are ordinary clutter, and a 35 m gate reads
// as a 4 m one.
//
// The scatter system already exists (`sim/props/scatter.ts`) and it takes a
// density map and a PALETTE. §1.5 item 6: *"the palette is the whole cost."*
// This file is the palette — a boulder at 1–3 m, a rock at 0.3–1 m and a shrub
// at 0.5–1.5 m, all of them ours, all of them generated, none of them an asset
// anybody has to licence or download.
//
// ── The shape, and why it is the cloud generator again ───────────────────
//
// `sim/clouds.ts` already solves "a faceted blob, seeded, with no imported
// geometry": an icosphere pushed out along each vertex's own direction by how
// much it faces each of a handful of lobes, then crunched by a per-vertex
// jitter, then SPLIT so every triangle carries its own normal. A cloud and a
// boulder are the same object with different numbers — soft pillow versus
// angular lump — so `icosphere` is imported from there rather than written a
// second time, and only the parameters differ. The lobe, displace, crunch and
// flat-split stages are `sim/blob.ts`'s, shared by both generators (SG-3).
//
// What is NOT shared is the normalisation. A cloud normalises its MEAN RADIUS,
// because a placement's scale was authored against a bought mesh of unknown
// size. A prop normalises its **widest horizontal extent to exactly 1**, so a
// preset that says `scaleMin: 1, scaleMax: 3` gets boulders that are one to
// three metres across and the number in the JSON means the thing it says. That
// is what makes them familiar-size objects rather than blobs.
//
// ── The numeric literals in this file, and why they are allowed ──────────
//
// CLAUDE.md hard rule 3: a numeric literal under `src/sim/` is a code smell that
// needs explicit justification. The justification is `sim/clouds.ts`'s, verbatim
// and for the same reason: **`PROP_SHAPES` describes the GENERATOR, not the
// mission and not the tuning.** How many lobes an icosphere gets is the same
// kind of statement as "a cloud is a lobed icosphere" — it is FF2's own art, it
// is not extracted from anything, and there is nothing for it to be wrong
// against. Everything a person would want to TURN — how many props, how big,
// which slopes, what colour — is in `content/editions/anniversary.json` under
// `props`, where every other Anniversary number lives.
//
// SIM LAYER: pure. No three, no DOM, no `Math.random` — the seed goes in and the
// same bytes come out, so a variant can be built in a worker or asserted in a
// headless test.

import { blobLobes, crunchVertices, displaceByLobes, splitFlat } from '@/sim/blob'
import { icosphere } from '@/sim/clouds'
import { makeRandom } from '@/sim/terrain/faceted'

/** The three classes of familiar-size object this file makes. */
export const PROP_KINDS = ['boulder', 'rock', 'shrub'] as const
export type PropKind = (typeof PROP_KINDS)[number]

export interface PropShape {
  /**
   * Icosphere subdivisions. 0 is 20 triangles, 1 is 80, 2 is 320.
   *
   * 1 for a boulder and 0 for a rock: these are metre-scale objects seen from
   * fifty metres and up, and the whole point of the class is that there are
   * THOUSANDS of them. A 320-triangle rock times 6,000 is a budget; an
   * 80-triangle one is the silhouette, which is all the eye gets at that size.
   */
  readonly subdivisions: number
  /** How many directional bulges. */
  readonly lobes: number
  /** How far each bulge pushes, as a fraction of the base radius. */
  readonly lobeStrength: number
  /** Bulge tightness. 1 is a soft pillow; 6 is a cauliflower knot. */
  readonly lobeSharpness: number
  /** How far lobes are pushed toward the horizontal, 0..1. A shrub spreads; a rock does not. */
  readonly spread: number
  /** Vertical scale of the blob BEFORE the width normalisation, so it sets the aspect. */
  readonly flatten: number
  /** Per-vertex jitter radius, as a fraction of the blob's radius. THE CRUNCH — see `sim/clouds.ts`. */
  readonly jitter: number
  /**
   * Fraction of the blob's own height buried below y = 0.
   *
   * A boulder resting exactly ON a plane reads as a prop sitting on a table.
   * Half-buried is what a boulder looks like, and it is also insurance: the
   * rendered terrain carries ±0.8 m of `RandomOffset` jitter that the height map
   * this is placed against does not (PROP-AUDIT §3.3), so a prop that is not
   * sunk will float somewhere.
   */
  readonly sink: number
  /** Per-face lightness spread, ± this. 0 is one flat colour for the whole prop. */
  readonly shadeSpread: number
}

/**
 * A generated prop: a flat-shaded triangle soup, one metre across, standing on
 * y = 0 with `sink` of itself below.
 */
export interface PropMesh {
  /** 9 floats per triangle. */
  readonly positions: Float32Array
  /** 9 floats per triangle: one face normal, repeated three times. */
  readonly normals: Float32Array
  /**
   * 3 floats per triangle: one lightness per FACE, repeated three times.
   *
   * Multiplied into the instance's own colour, so "flat faces, one colour each"
   * survives the instancing: every triangle of every boulder is a single flat
   * colour, and no two triangles of one boulder are quite the same.
   */
  readonly shades: Float32Array
  readonly triangleCount: number
  /** Widest horizontal extent. 1 by construction — the whole point. */
  readonly width: number
  /** Height above y = 0. Below 1 for a boulder, above it for a shrub. */
  readonly height: number
  /** How far below y = 0 the mesh reaches. `sink` of the full height. */
  readonly buried: number
}

/**
 * The three recipes.
 *
 * FF2's own art. See the header on why these literals are here and the tuning
 * is not: this table says what a boulder IS, and `content/editions/
 * anniversary.json` says how many there are, how big, and where.
 */
export const PROP_SHAPES: Readonly<Record<PropKind, PropShape>> = {
  // Angular and roughly equidimensional: a few hard bulges, a heavy crunch, and
  // barely any vertical squash. Sunk to the waist.
  boulder: {
    subdivisions: 1,
    lobes: 5,
    lobeStrength: 0.5,
    lobeSharpness: 2.2,
    spread: 0.25,
    flatten: 0.82,
    jitter: 0.16,
    sink: 0.28,
    shadeSpread: 0.12,
  },
  // The same thing smaller and flatter, at the lowest subdivision the icosphere
  // has. 20 triangles is a pebble with a silhouette, and there are more of these
  // than of anything else in the world.
  rock: {
    subdivisions: 0,
    lobes: 3,
    lobeStrength: 0.45,
    lobeSharpness: 1.8,
    spread: 0.55,
    flatten: 0.6,
    jitter: 0.2,
    sink: 0.34,
    shadeSpread: 0.14,
  },
  // A few soft lobes pushed OUT and UP: taller than wide, which is what
  // separates a bush from a stone at a glance and at a distance.
  shrub: {
    subdivisions: 1,
    lobes: 7,
    lobeStrength: 0.62,
    lobeSharpness: 1.3,
    spread: 0.15,
    flatten: 1.45,
    jitter: 0.11,
    sink: 0.1,
    shadeSpread: 0.16,
  },
}

/**
 * Build one prop.
 *
 * Deterministic in `seed` alone: same seed, same bytes, forever. The variants a
 * kind draws from are this function at `seed`, `seed + 1`, ... — see
 * `generatePropVariants`.
 */
export const generatePropMesh = (shape: PropShape, seed: number): PropMesh => {
  const { vertices, faces } = icosphere(shape.subdivisions)
  const rnd = makeRandom(seed)

  // ── the lobes ───────────────────────────────────────────────────────────
  //
  // Directions on the sphere, flattened toward the horizontal by `spread` and
  // RENORMALISED: a lobe pushed flat must not also push weakly. `sim/blob.ts`'s
  // stage, shared with the cloud generator.
  const lobes = blobLobes(rnd, shape.lobes, shape.spread, shape.lobeStrength)

  // ── displace ────────────────────────────────────────────────────────────
  const count = vertices.length / 3
  const moved = displaceByLobes(vertices, lobes, shape.lobeSharpness, shape.flatten)

  // ── the crunch, on the SHARED vertices ──────────────────────────────────
  //
  // Before the split, so the faces around a vertex all follow it and the mesh
  // stays closed; jittering after the split moves each face's copy
  // independently and the prop comes apart into confetti. `clouds.test.ts`
  // counts distinct positions for exactly this reason and so does ours.
  crunchVertices(moved, rnd, shape.jitter)

  // ── normalise the WIDTH, not the mean radius ────────────────────────────
  //
  // A cloud normalises its mean radius because the placement scale was authored
  // against a mesh nobody can measure. A prop is the opposite case: nothing
  // authored it, and the number in the preset is supposed to mean METRES ACROSS.
  // So the widest horizontal extent becomes exactly 1 and `scale` reads
  // directly — `scaleMin: 1, scaleMax: 3` is a boulder one to three metres wide.
  // Horizontal and not the diagonal, because "how big is that rock" is a
  // question about its silhouette on the ground.
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let v = 0; v < count; v++) {
    const x = moved[v * 3] as number
    const z = moved[v * 3 + 2] as number
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const widest = Math.max(maxX - minX, maxZ - minZ) || 1
  const fit = 1 / widest
  for (let i = 0; i < moved.length; i++) moved[i] = (moved[i] as number) * fit

  // ── stand it on the ground, partly buried ───────────────────────────────
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let v = 0; v < count; v++) {
    const y = moved[v * 3 + 1] as number
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const fullHeight = maxY - minY
  // `minY` goes to `-sink * fullHeight`: the base sits that far under y = 0.
  const lift = -shape.sink * fullHeight - minY
  for (let v = 0; v < count; v++) moved[v * 3 + 1] = (moved[v * 3 + 1] as number) + lift

  // ── split, one normal and one shade per face ────────────────────────────
  const shades = new Float32Array((faces.length / 3) * 3)
  // The shade is drawn AFTER each face is written, one draw per face in face
  // order: the stream the prop's variants have always had.
  const { positions, normals, triangleCount } = splitFlat(moved, faces, (f) => {
    const s = 1 + (rnd() * 2 - 1) * shape.shadeSpread
    for (let k = 0; k < 3; k++) shades[f * 3 + k] = s
  })

  return {
    positions,
    normals,
    shades,
    triangleCount,
    width: Math.max(maxX - minX, maxZ - minZ) * fit,
    height: maxY + lift,
    buried: -(minY + lift),
  }
}

/**
 * The variants one kind draws from.
 *
 * Every variant of a kind has the SAME topology — the same icosphere, the same
 * triangle count, the same face order — because the renderer packs them into one
 * geometry and swaps between them per instance to keep the kind at a single draw
 * call. That is a contract, not a coincidence, and `dressing-shapes.test.ts`
 * asserts it: a variant with a different triangle count would render as a
 * silently truncated buffer rather than as an error.
 */
export const generatePropVariants = (
  kind: PropKind,
  count: number,
  seed: number,
): readonly PropMesh[] => {
  const shape = PROP_SHAPES[kind]
  const out: PropMesh[] = []
  // A stride rather than `seed + i`: adjacent seeds into a hash-based PRNG are
  // fine, but a stride makes two kinds sharing a base seed produce unrelated
  // streams rather than interleaved ones, and costs nothing.
  for (let i = 0; i < count; i++) out.push(generatePropMesh(shape, (seed + i * 7919) >>> 0))
  return out
}
