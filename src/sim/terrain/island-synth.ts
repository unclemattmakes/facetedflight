// src/sim/terrain/island-synth.ts — an island from a seed. DEV-493 (T1).
//
// docs/plan/EDITOR.md §5.4's T1: *"a seed and a few shape sliders; reroll
// until they like it, then lay a course on it"*. This is the shape: a pure,
// seeded function of a seed and four numbers, sampled on any grid. DEV-489's
// custom-ground core does everything after it (the colour ramp, the forest,
// the clearing), so what this file owes the game is a SILHOUETTE — ART_DIRECTION's
// pillar 1: ridge lines read at 500 m and 100 m/s — on an island that sits in
// its sea like Simonet's: a coast with bays and headlands, a beach shelf, a
// spine of ridges, and a summit or two.
//
// ── The shape ────────────────────────────────────────────────────────────
//
//   size     the side, metres (the course format holds it to the island's chunks)
//   height   the summit above the waterline, metres
//   rugged   0..1: smooth downs at 0, knife ridges and spires at 1
//   sea      0..1: how much of the square is sea — a broad island at 0, a
//            small one in open water at 1
//
// ── The output ───────────────────────────────────────────────────────────
//
// ELEVATION, `-1..1`, 0 the waterline and 1 the summit's height; below 0 the
// sea floor falls to -1 at the depth the caller maps it to. `game/terrain/
// custom-ground.ts`'s `seedGround` turns it into a `CustomGround` in the
// island's own mesh frame, the waterline where that island's sea stands.
//
// ── Deterministic, to the bit ────────────────────────────────────────────
//
// Seeded integer hashing (`Math.imul`) and IEEE arithmetic only: +, −, ×, ÷,
// `Math.sqrt` and `Math.floor`, which every engine rounds the same way. No
// `Math.random`, no `exp`/`sin`/`hypot` (whose last bit an engine may choose),
// no clock (hard rule 4). So a seed makes the same heights on every machine,
// and `tests/unit/island-synth.test.ts` holds them byte for byte.
//
// Features are laid out in METRES, not in fractions of the square, so an 8 km
// island has more ridges than a 2 km one rather than the same ridges drawn
// four times larger: the grain stays the grain (ART_DIRECTION pillar 5).

import { clamp, smooth01 } from '../math/scalar'

/** The four sliders. See the header. */
export interface IslandShape {
  readonly size: number
  readonly height: number
  readonly rugged: number
  readonly sea: number
}

/**
 * The generator's fixed numbers, under one name, pinned by value in the
 * test. Wavelengths are metres; weights are fractions of the summit.
 */
export const ISLAND_SYNTH = {
  /** The largest seed: a non-negative 31-bit integer, so it is a JSON integer everywhere. */
  seedMax: 2 ** 31 - 1,
  /** Where the coast stands, as a fraction of the half-side: at sea 0, and at sea 1. */
  radiusAtNoSea: 0.92,
  radiusAtMostSea: 0.3,
  /** The coast's bays and headlands: wavelength, and depth as a fraction of the radius. */
  coastWavelength: 1400,
  coastDepth: 0.35,
  /** The domain warp that bends ridges and coast alike. */
  warpWavelength: 2200,
  warpMetres: 420,
  /** The body of the island: the dome's share of the summit. */
  dome: 0.5,
  /** Rolling hills. */
  hillWavelength: 1100,
  hills: 0.22,
  /** Ridges: wavelength, and their share of the summit at rugged 0 and 1. */
  ridgeWavelength: 850,
  ridgeAtSmooth: 0.12,
  ridgeAtRugged: 0.62,
  /** The beach shelf: land this close above the waterline is flattened toward it. */
  shelf: 0.05,
  /** Octaves of each noise. */
  octaves: 5,
} as const

// ── Seeded value noise, integer-hashed ────────────────────────────────────

/** A lattice value in [-1, 1] for integer (x, z) under `seed`. */
const lattice = (x: number, z: number, seed: number): number => {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 2147483647.5 - 1
}

/** Quintic fade: C2, so facets do not crease along the lattice. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)

/** Value noise at (x, z) lattice units, in [-1, 1]. */
const noise = (x: number, z: number, seed: number): number => {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const fx = fade(x - x0)
  const fz = fade(z - z0)
  const a = lattice(x0, z0, seed)
  const b = lattice(x0 + 1, z0, seed)
  const c = lattice(x0, z0 + 1, seed)
  const d = lattice(x0 + 1, z0 + 1, seed)
  const ab = a + (b - a) * fx
  const cd = c + (d - c) * fx
  return ab + (cd - ab) * fz
}

/** Fractal sum, normalised to about [-1, 1]. Octave k has its own seed. */
const fbm = (x: number, z: number, seed: number, octaves: number): number => {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  for (let k = 0; k < octaves; k++) {
    sum += amp * noise(x * f, z * f, seed + k * 1013)
    norm += amp
    amp *= 0.5
    f *= 2.03
  }
  return sum / norm
}

/** Ridged fractal in [0, 1]: sharp crests where the noise crosses zero. */
const ridged = (x: number, z: number, seed: number, octaves: number): number => {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  let weight = 1
  for (let k = 0; k < octaves; k++) {
    const n = 1 - Math.abs(noise(x * f, z * f, seed + k * 7919))
    const r = n * n * weight
    weight = Math.min(1, r * 1.6)
    sum += amp * r
    norm += amp
    amp *= 0.5
    f *= 2.07
  }
  return sum / norm
}

/** `smooth01` from the shared kit: `clamp(t, 0, 1)` then the Hermite curve, as this file had it. */
const smooth = smooth01

/**
 * Generator version 1's elevation (DEV-493), KEPT BYTE FOR BYTE: every seed
 * course written before DEV-499 names no version and so means this one. Do not
 * edit a number or an operation in it; `tests/unit/island-synth.test.ts` pins
 * three seeds' bytes.
 */
const elevationV1 = (seed: number, shape: IslandShape, u: number, v: number): number => {
  const S = ISLAND_SYNTH
  const s = seed | 0
  const x = u * shape.size
  const z = v * shape.size
  // Warp the domain once; coast and ridges both bend with it.
  const wx = x + S.warpMetres * fbm(x / S.warpWavelength, z / S.warpWavelength, s + 11, 3)
  const wz = z + S.warpMetres * fbm(x / S.warpWavelength + 17.3, z / S.warpWavelength, s + 23, 3)
  // Distance from the centre, as a fraction of the half-side.
  const half = shape.size / 2
  const dx = (wx - half) / half
  const dz = (wz - half) / half
  const d = Math.sqrt(dx * dx + dz * dz)
  const sea = clamp(shape.sea, 0, 1)
  const radius = S.radiusAtNoSea + (S.radiusAtMostSea - S.radiusAtNoSea) * sea
  const coast =
    radius * (1 + S.coastDepth * fbm(wx / S.coastWavelength, wz / S.coastWavelength, s + 37, 4))
  // m: 1 at the centre, 0 at the coast, negative out at sea.
  const m = (coast - d) / coast
  if (m <= 0) {
    // The sea floor: a shelf, then a slope to the depth.
    return clamp(m * 2.2 - 0.02, -1, 0)
  }
  const inland = smooth(m * 2.5)
  const rugged = clamp(shape.rugged, 0, 1)
  const dm = smooth(m * 1.15)
  const dome = S.dome * dm * (2 - dm)
  const hills =
    S.hills *
    inland *
    (0.5 + 0.5 * fbm(wx / S.hillWavelength, wz / S.hillWavelength, s + 51, S.octaves))
  const ridgeWeight = S.ridgeAtSmooth + (S.ridgeAtRugged - S.ridgeAtSmooth) * rugged
  const ridges =
    ridgeWeight * inland * ridged(wx / S.ridgeWavelength, wz / S.ridgeWavelength, s + 71, S.octaves)
  let e = dome + hills + ridges
  // The beach shelf: the first few percent above the sea are pressed toward it.
  if (e < S.shelf) e = (e * e) / S.shelf
  return clamp(e, 0, 1)
}

// ── Version 2 (DEV-499): 2016's proportions, by measurement ──────────────
//
// Matt: *"i used generic terrain tutorials then tweaked to get the looks. i
// think they might be scaled in height a lil extra, to increase verticality.
// noise helps too."* DEV-499 measured Simonet's and kauai's height maps at the
// facet pitch against v1's seeds (the row has the table). At the SAME summit,
// v1's slopes were already 2016's; what differed was the DISTRIBUTION and the
// GRAIN: 2016's land is low with tall peaks, and rough at every scale. So v2
// keeps v1's layout (the warped coast, the dome, hills and ridges) and adds:
//
//   - a second domain warp, of the warp: domain-warped fBm, so ridges braid;
//   - REDISTRIBUTION, the terrain tutorials' `e^k`, as a blend toward `e * e`
//     (no `pow`): the body sinks toward the sea and the peaks stand, which is
//     the vertical exaggeration relative to the footprint;
//   - a fine ridged band, 160 m down to ~20 m, whose weight grows with
//     height, so the high ground is broken into crags and the shore is not.

/** Version 2's fixed numbers. Pinned by value in the test, like v1's. */
export const ISLAND_SYNTH_V2 = {
  /** The second warp: wavelength and reach, metres. */
  warp2Wavelength: 900,
  warp2Metres: 160,
  /** The body's shares: dome, hills, ridges at rugged 0 and 1. */
  dome: 0.42,
  hills: 0.24,
  ridgeAtSmooth: 0.2,
  ridgeAtRugged: 0.7,
  /** How much of the body is redistributed as `e * e`: 0 is v1's curve, 1 all squared. */
  redistribute: 1,
  /** The fine ridged band: wavelength (metres), octaves, and weight at the shore and at the top. */
  fineWavelength: 120,
  fineOctaves: 4,
  fineAtShore: 0.02,
  fineAtTop: 0.3,
  /** The fine band's zero: the ridged sum's typical value, so it adds crags without lifting the island. */
  fineBias: 0.35,
  /** The summit gain after redistribution, so the tallest ground still nears `height`. */
  gain: 1.05,
  /** v2's beach shelf: narrower than v1's, because redistribution already lowers the shore. */
  shelf: 0.02,
} as const

/**
 * A ridged sum for v2 whose octaves each turn by the 3-4-5 rotation (cos 0.8,
 * sin 0.6: exact, no trigonometry), so the crests do not line up with the
 * lattice the way an unrotated value noise's do. v1's `ridged` is untouched.
 */
const ridgedTurned = (x: number, z: number, seed: number, octaves: number): number => {
  let sum = 0
  let amp = 1
  let norm = 0
  let px = x
  let pz = z
  let weight = 1
  for (let k = 0; k < octaves; k++) {
    const n = 1 - Math.abs(noise(px, pz, seed + k * 7919))
    const r = n * n * weight
    weight = Math.min(1, r * 1.6)
    sum += amp * r
    norm += amp
    amp *= 0.5
    const tx = (0.8 * px - 0.6 * pz) * 2.07
    pz = (0.6 * px + 0.8 * pz) * 2.07
    px = tx
  }
  return sum / norm
}

/** Version 2's elevation (DEV-499). Same contract as v1's. */
const elevationV2 = (seed: number, shape: IslandShape, u: number, v: number): number => {
  const S = ISLAND_SYNTH
  const T = ISLAND_SYNTH_V2
  const s = seed | 0
  const x = u * shape.size
  const z = v * shape.size
  // Warp the warp: domain-warped fBm.
  const qx = x + T.warp2Metres * fbm(x / T.warp2Wavelength, z / T.warp2Wavelength, s + 101, 3)
  const qz = z + T.warp2Metres * fbm(x / T.warp2Wavelength + 5.1, z / T.warp2Wavelength, s + 103, 3)
  const wx = qx + S.warpMetres * fbm(qx / S.warpWavelength, qz / S.warpWavelength, s + 11, 3)
  const wz = qz + S.warpMetres * fbm(qx / S.warpWavelength + 17.3, qz / S.warpWavelength, s + 23, 3)
  const half = shape.size / 2
  const dx = (wx - half) / half
  const dz = (wz - half) / half
  const d = Math.sqrt(dx * dx + dz * dz)
  const sea = clamp(shape.sea, 0, 1)
  const radius = S.radiusAtNoSea + (S.radiusAtMostSea - S.radiusAtNoSea) * sea
  const coast =
    radius * (1 + S.coastDepth * fbm(wx / S.coastWavelength, wz / S.coastWavelength, s + 37, 4))
  const m = (coast - d) / coast
  if (m <= 0) return clamp(m * 2.2 - 0.02, -1, 0)
  const inland = smooth(m * 2.5)
  const rugged = clamp(shape.rugged, 0, 1)
  const dm = smooth(m * 1.15)
  const dome = T.dome * dm * (2 - dm)
  const hills =
    T.hills *
    inland *
    (0.5 + 0.5 * fbm(wx / S.hillWavelength, wz / S.hillWavelength, s + 51, S.octaves))
  const ridgeWeight = T.ridgeAtSmooth + (T.ridgeAtRugged - T.ridgeAtSmooth) * rugged
  const ridges =
    ridgeWeight *
    inland *
    ridgedTurned(wx / S.ridgeWavelength, wz / S.ridgeWavelength, s + 71, S.octaves)
  const body = clamp(dome + hills + ridges, 0, 1)
  // Redistribution: the tutorials' e^k, as a blend toward e * e.
  let e = T.gain * (body + (body * body - body) * T.redistribute)
  const fineWeight = (T.fineAtShore + (T.fineAtTop - T.fineAtShore) * clamp(e, 0, 1)) * inland
  e +=
    fineWeight *
    (0.5 + rugged) *
    (ridgedTurned(wx / T.fineWavelength, wz / T.fineWavelength, s + 131, T.fineOctaves) -
      T.fineBias)
  if (e < T.shelf) e = e <= 0 ? 0 : (e * e) / T.shelf
  return clamp(e, 0, 1)
}

/**
 * Which generator a seed course names (`island.v` in the format, DEV-499).
 * A course written before DEV-499 names none and means 1; a new one names
 * `ISLAND_SYNTH_VERSION`. Each version's function is kept as it shipped.
 */
export const ISLAND_SYNTH_VERSIONS = [1, 2] as const
export type IslandSynthVersion = (typeof ISLAND_SYNTH_VERSIONS)[number]
/** The version a NEW island is made with. */
export const ISLAND_SYNTH_VERSION: IslandSynthVersion = 2

const elevationOf = (version: IslandSynthVersion) => (version === 1 ? elevationV1 : elevationV2)

/**
 * Elevation at the point `(u, v)` of the square, both 0..1 (`u` along the
 * map's columns, `v` down its rows): -1..1, 0 the waterline. Pure. `version`
 * picks the generator and is not optional: a default here is a shared seed
 * that moves when the default does.
 */
export const islandElevation = (
  seed: number,
  shape: IslandShape,
  u: number,
  v: number,
  version: IslandSynthVersion,
): number => elevationOf(version)(seed, shape, u, v)

/**
 * The island on an `edge × edge` grid, row 0 at the top (`v = 0`), sample i
 * at `i / (edge - 1)`: elevation -1..1. Byte-identical for the same arguments.
 */
export const synthesiseIsland = (
  seed: number,
  shape: IslandShape,
  edge: number,
  version: IslandSynthVersion,
): Float32Array => {
  const f = elevationOf(version)
  const out = new Float32Array(edge * edge)
  const last = edge - 1
  for (let row = 0; row < edge; row++) {
    const v = row / last
    for (let col = 0; col < edge; col++) {
      out[row * edge + col] = f(seed, shape, col / last, v)
    }
  }
  return out
}
