// src/sim/terrain/sky-visibility.ts — how much of the sky the terrain leaves a facet.
//
// ── The problem this answers ──────────────────────────────────────────────
//
// The sky's ambient light is 2016's nine SH coefficients evaluated at the face
// NORMAL and nowhere else (`render/skyshop-ibl.ts`), so a gorge floor gets the
// same sky as a plateau with the same slope. Nothing in the tree lets terrain
// hide sky from other terrain: sun height (DEV-116) multiplies the sun only, and
// canopy (DEV-295) is zero wherever no prop stands. On the seven low-sun
// missions the probe is 75 % of the light on lit flat ground and 100 % of it in
// terrain shadow. `docs/plan/SKY-VISIBILITY.md` has the measurement and the
// argument; this is its step 1.
//
// ── What V and B are, exactly ─────────────────────────────────────────────
//
// For a texel, march the horizon in `azimuths` directions. In each vertical
// slice, weight every direction by the FACET's cosine, `max(0, n · ω)`, which
// integrates in closed form (`sliceCosine`). Its zero is the facet's own
// tangent plane, so each slice runs from that plane (below the horizon on a
// slope's outward side) to the zenith. Then:
//
//   V = the share of the UPPER hemisphere, above the horizontal and the plane,
//       that is open sky. The probe carries its own lower half, so terrain
//       below the horizon is not sky it has lost. A plane has V = 1 at any
//       tilt: the probe is already evaluated at the tilted normal.
//   B = the lit terrain the facet sees, each visible sample's band times its
//       radiance, over the facet's whole cosine hemisphere. See
//       `skyVisibilityAt` for why "whole" and not "upper": a canyon wall looks
//       mostly DOWN, at the sunlit floor.
//
// A first probe without the tangent plane (SKY-VISIBILITY §6a's first run)
// read every hillside as half-buried; a first bake weighted against the
// vertical never saw below the horizon and left mesa canyon's walls black.

// ── Sampling ──────────────────────────────────────────────────────────────
//
// `samples` distances per azimuth, GEOMETRIC from one grid step to
// `maxDistance`: near samples find the gully wall and far ones the ridge, and
// a sample at 1 km that misses a 16 m spike is a 16 m spike seen at 0.9°,
// which is cos² = 0.9998 of nothing. `sky-visibility.test.ts` holds this
// against a dense march on a rough field.
//
// `stride` computes every stride-th texel and lets the renderer's bilinear
// filter fill between. V is a landform-scale quantity. Kauai's 1025² field at
// stride 1 is four times Simonet's work for a term that does not have the
// resolution to show it.
//
// Beyond the map the field is edge-clamped, as the collision query is.
//
// ── DEV-027: what each number is OF ──────────────────────────────────────
//
// `values` are dimensionless 0..1, `[j * samplesPerSide + i]` for grid texel
// `(i·stride, j·stride)` of the HeightField they came from: the same [z][x]
// order and the same axes as `heights` and as the terrain's facet uv, so a
// facet's barycentre uv `(u, v)` is sample `(u, v) · (samplesPerSide − 1)`.
//
// SIM LAYER: no three, no DOM, no wall clock, no Math.random.

import { runSteps, type Steps } from '../steps'
import type { HeightField } from './height-field'

export interface SkyVisibilityOptions {
  /** Horizon directions, evenly spaced. */
  readonly azimuths?: number
  /** Distances marched per direction, geometric from one grid step. */
  readonly samples?: number
  /** How far a horizon is looked for, world metres. */
  readonly maxDistance?: number
  /** Compute every stride-th texel. Must divide `vertPerSide − 1`. */
  readonly stride?: number
}

export interface SkyVisibilityField {
  /** Samples per side: `(vertPerSide − 1) / stride + 1`. */
  readonly samplesPerSide: number
  /** 0..1, `[j * samplesPerSide + i]`. See the header. */
  readonly values: Float32Array
  /**
   * One-bounce light from the terrain that hides the sky, RGB per sample,
   * `[(j * samplesPerSide + i) * 3]`, per unit of sun (SKY-VISIBILITY §5b).
   * Null when no radiance was given.
   */
  readonly bounce: Float32Array | null
  /** Largest channel of `bounce` anywhere. What a texture encoder needs. */
  readonly maxBounce: number
  readonly stride: number
  readonly azimuths: number
  readonly samples: number
  readonly maxDistance: number
  readonly min: number
  readonly mean: number
}

export const SKY_VISIBILITY_DEFAULTS = {
  azimuths: 16,
  samples: 32,
  maxDistance: 1024,
  stride: 1,
} as const

/** The geometric march distances, in grid steps: 1 .. maxSteps, `count` of them. */
export const marchDistances = (maxSteps: number, count: number): Float64Array => {
  const out = new Float64Array(count)
  if (count === 1) {
    out[0] = 1
    return out
  }
  const top = Math.max(1, maxSteps)
  for (let k = 0; k < count; k++) out[k] = top ** (k / (count - 1))
  return out
}

/** Share of the cosine-weighted upper hemisphere above elevation atan(t), one slice. */
export const sliceWeight = (tan: number): number => (tan <= 0 ? 1 : 1 / (1 + tan * tan))

/**
 * The field's height at fractional grid coordinates, METRES, edge-clamped.
 * Bilinear, as `terrainHeightAt` interpolates it.
 */
const heightAtGrid = (
  heights: Float32Array,
  n: number,
  metresPerUnit: number,
  gx: number,
  gz: number,
): number => {
  const x = gx <= 0 ? 0 : gx >= n - 1 ? n - 1 : gx
  const z = gz <= 0 ? 0 : gz >= n - 1 ? n - 1 : gz
  const x0 = Math.min(Math.floor(x), n - 2)
  const z0 = Math.min(Math.floor(z), n - 2)
  const fx = x - x0
  const fz = z - z0
  const i = z0 * n + x0
  const h00 = heights[i] as number
  const h10 = heights[i + 1] as number
  const h01 = heights[i + n] as number
  const h11 = heights[i + n + 1] as number
  const a = h00 + (h10 - h00) * fx
  const b = h01 + (h11 - h01) * fx
  return (a + (b - a) * fz) * metresPerUnit
}

/** RGB of a per-texel grid at fractional grid coordinates, edge-clamped, into `out`. */
const rgbAtGrid = (
  grid: Float32Array,
  n: number,
  gx: number,
  gz: number,
  out: Float64Array,
): void => {
  const x = gx <= 0 ? 0 : gx >= n - 1 ? n - 1 : gx
  const z = gz <= 0 ? 0 : gz >= n - 1 ? n - 1 : gz
  const x0 = Math.min(Math.floor(x), n - 2)
  const z0 = Math.min(Math.floor(z), n - 2)
  const fx = x - x0
  const fz = z - z0
  const i = (z0 * n + x0) * 3
  const j = i + n * 3
  for (let c = 0; c < 3; c++) {
    const p = grid[i + c] as number
    const q = grid[i + 3 + c] as number
    const r = grid[j + c] as number
    const s = grid[j + 3 + c] as number
    const a = p + (q - p) * fx
    const b = r + (s - r) * fx
    out[c] = a + (b - a) * fz
  }
}

// Volatile, valid only inside one synchronous call (trap 19).
const _rgb = new Float64Array(3)
const _bounce = new Float64Array(3)

/**
 * The cosine-weighted solid angle, about a unit normal with horizontal
 * component `a` along the slice and vertical component `ny`, of one azimuth
 * slice between elevations e1 and e2 (radians), per radian of azimuth:
 * `∫ (a·cos ε + ny·sin ε) · cos ε dε`. Its integrand is zero exactly at the
 * facet's own plane, so between the plane and the zenith it is never negative.
 */
export const sliceCosine = (a: number, ny: number, e1: number, e2: number): number => {
  const g = (e: number) => a * (e / 2 + Math.sin(2 * e) / 4) + (ny * Math.sin(e) ** 2) / 2
  return g(e2) - g(e1)
}

const HALF_PI = Math.PI / 2

/**
 * V at one grid texel, with the given march, and, when `radiance` is given,
 * the one-bounce light from the terrain the facet sees, written to
 * `bounceOut[0..2]` (RGB), with `bounceOut[3]` (if present) the share of the
 * facet's whole cosine hemisphere that is open sky. Exported for the test,
 * which holds it against a dense march; `buildSkyVisibility` is this over the
 * grid.
 *
 * ── Weighted by the FACET's normal, not by the vertical ──────────────────
 *
 * Each direction counts `max(0, n · ω)`, integrated per slice in closed form
 * (`sliceCosine`), so the facet's hemisphere runs from its own plane (which
 * dips BELOW the horizon on the outward side of a slope) up to the zenith.
 * The first cut weighted against the vertical and never counted a direction
 * below the horizon. That is harmless on a valley floor and blind on a canyon
 * WALL, which looks mostly down, at the sunlit floor: mesa canyon's darkest
 * walls did not move by a level (DEV-333's first photographs).
 *
 * ── V: the SKY above the horizon that terrain hides ─────────────────────
 *
 * Over the upper hemisphere only, `[max(plane, 0), zenith]`: the probe
 * already carries its own lower half (the sky map's ground), so terrain below
 * the horizon is not sky it has lost. A plane at any tilt has V = 1; a horizon
 * below the plane (a convex top) is its slice fully open and no more.
 *
 * ── The bounce (SKY-VISIBILITY §5b) ──────────────────────────────────────
 *
 * In each slice, a sample is VISIBLE when its elevation beats every nearer
 * sample's, starting from the facet's own plane, above or below the horizon.
 * It covers the band from the previous maximum up to itself, filled with that
 * texel's `radiance`. Normalised by the facet's whole cosine hemisphere, so
 * uniform radiance c everywhere it looks gives exactly c times the share of
 * that hemisphere that is terrain.
 */
export const skyVisibilityAt = (
  field: HeightField,
  gx: number,
  gz: number,
  distances: Float64Array,
  azimuths: number,
  radiance: Float32Array | null = null,
  bounceOut: Float64Array | null = null,
): number => {
  const n = field.vertPerSide
  const metresPerUnit = field.terrainHeight * (field.scaleY || 1)
  const horizontal = field.step * (field.scaleX || 1)
  const h = field.heights
  const here = heightAtGrid(h, n, metresPerUnit, gx, gz)
  // The plane's own gradient, central differences where there is room: the
  // same slope the face normal carries, to first order.
  const xl = Math.max(0, gx - 1)
  const xr = Math.min(n - 1, gx + 1)
  const zl = Math.max(0, gz - 1)
  const zr = Math.min(n - 1, gz + 1)
  const gradX =
    (heightAtGrid(h, n, metresPerUnit, xr, gz) - heightAtGrid(h, n, metresPerUnit, xl, gz)) /
    ((xr - xl) * horizontal)
  const gradZ =
    (heightAtGrid(h, n, metresPerUnit, gx, zr) - heightAtGrid(h, n, metresPerUnit, gx, zl)) /
    ((zr - zl) * horizontal)
  // Normal of y = f(x, z): (−∂f/∂x, 1, −∂f/∂z) / len.
  const len = Math.sqrt(gradX * gradX + 1 + gradZ * gradZ)
  const ny = 1 / len
  const withBounce = radiance !== null
  if (withBounce) _bounce.fill(0)
  let seenUpper = 0
  let openUpper = 0
  let open = 0
  let skyAll = 0
  for (let a = 0; a < azimuths; a++) {
    const phi = (2 * Math.PI * a) / azimuths
    const ux = Math.cos(phi)
    const uz = Math.sin(phi)
    const tanT = gradX * ux + gradZ * uz
    // The normal's horizontal component along this slice.
    const along = -tanT / len
    const plane = Math.atan(tanT)
    let tanH = Number.NEGATIVE_INFINITY
    // Visibility's running maximum starts at the facet's own plane: terrain
    // below it is not in this facet's hemisphere. Kept as a TANGENT so the
    // common case (not visible) costs a compare and no atan.
    let runningTan = tanT
    let running = plane
    for (let k = 0; k < distances.length; k++) {
      const d = distances[k] as number
      const sx = gx + d * ux
      const sz = gz + d * uz
      const rise = heightAtGrid(h, n, metresPerUnit, sx, sz) - here
      const t = rise / (d * horizontal)
      if (t > tanH) tanH = t
      if (withBounce && t > runningTan) {
        const e = Math.atan(t)
        const band = sliceCosine(along, ny, running, e)
        runningTan = t
        running = e
        if (band > 0) {
          rgbAtGrid(radiance, n, sx, sz, _rgb)
          _bounce[0] = (_bounce[0] as number) + band * (_rgb[0] as number)
          _bounce[1] = (_bounce[1] as number) + band * (_rgb[1] as number)
          _bounce[2] = (_bounce[2] as number) + band * (_rgb[2] as number)
        }
      }
    }
    const horizon = Math.max(Math.atan(tanH), plane)
    open += sliceCosine(along, ny, plane, HALF_PI)
    skyAll += sliceCosine(along, ny, horizon, HALF_PI)
    const upperFloor = Math.max(plane, 0)
    openUpper += sliceCosine(along, ny, upperFloor, HALF_PI)
    seenUpper += sliceCosine(along, ny, Math.max(horizon, upperFloor), HALF_PI)
  }
  if (bounceOut) {
    if (withBounce) {
      bounceOut[0] = (_bounce[0] as number) / open
      bounceOut[1] = (_bounce[1] as number) / open
      bounceOut[2] = (_bounce[2] as number) / open
    }
    if (bounceOut.length > 3) bounceOut[3] = skyAll / open
  }
  if (!(openUpper > 0)) return 1
  const v = seenUpper / openUpper
  return v >= 1 ? 1 : v
}

/**
 * The light each texel sends back up per unit of sun, RGB:
 * `albedo · max(0, n · toSun) · sunLit`. The receiver's shader multiplies by
 * the sun's own colour and its own `BRDF_Lambert`, so this is the quantity the
 * direct term computes for that texel, less the receiver.
 *
 * `albedo` is RGB per grid texel, `[(z * n + x) * 3]`, the colour map RAW as
 * the facets use it (DEV-014). `sunLit` is 0..1 per texel, or null for all lit.
 * `towardSun` is a unit vector in SIM space, as `buildSunHeight` takes it.
 */
export const buildSunRadiance = (
  field: HeightField,
  towardSun: readonly [number, number, number],
  albedo: Float32Array,
  sunLit: Float32Array | null,
): Float32Array => {
  const n = field.vertPerSide
  if (albedo.length !== n * n * 3) {
    throw new Error(`sky-visibility: albedo has ${albedo.length} values, want ${n * n * 3}`)
  }
  const metresPerUnit = field.terrainHeight * (field.scaleY || 1)
  const horizontal = field.step * (field.scaleX || 1)
  const h = field.heights
  const out = new Float32Array(n * n * 3)
  const [sx, sy, sz] = towardSun
  for (let z = 0; z < n; z++) {
    const zl = Math.max(0, z - 1)
    const zr = Math.min(n - 1, z + 1)
    for (let x = 0; x < n; x++) {
      const xl = Math.max(0, x - 1)
      const xr = Math.min(n - 1, x + 1)
      const dx =
        (((h[z * n + xr] as number) - (h[z * n + xl] as number)) * metresPerUnit) /
        ((xr - xl) * horizontal)
      const dz =
        (((h[zr * n + x] as number) - (h[zl * n + x] as number)) * metresPerUnit) /
        ((zr - zl) * horizontal)
      // Normal of y = f(x, z): (−∂f/∂x, 1, −∂f/∂z), normalised.
      const ndotl = (-dx * sx + sy - dz * sz) / Math.sqrt(dx * dx + 1 + dz * dz)
      const i = z * n + x
      const k = (ndotl > 0 ? ndotl : 0) * (sunLit ? (sunLit[i] as number) : 1)
      out[i * 3] = (albedo[i * 3] as number) * k
      out[i * 3 + 1] = (albedo[i * 3 + 1] as number) * k
      out[i * 3 + 2] = (albedo[i * 3 + 2] as number) * k
    }
  }
  return out
}

/** Bake V (and, given `radiance`, the bounce) over the field. Pure. */
export const buildSkyVisibility = (
  field: HeightField,
  options: SkyVisibilityOptions = {},
  radiance: Float32Array | null = null,
): SkyVisibilityField => runSteps(skyVisibilitySteps(field, options, radiance))

/**
 * `buildSkyVisibility`, able to stop after every row of samples (DEV-355).
 *
 * The one body both paths run, as `sim/steps.ts` describes: the bake was 44 %
 * of a 3.4 s task on `int_01`, and a row of it is a few milliseconds.
 */
export function* skyVisibilitySteps(
  field: HeightField,
  options: SkyVisibilityOptions = {},
  radiance: Float32Array | null = null,
): Steps<SkyVisibilityField> {
  const azimuths = options.azimuths ?? SKY_VISIBILITY_DEFAULTS.azimuths
  const samples = options.samples ?? SKY_VISIBILITY_DEFAULTS.samples
  const maxDistance = options.maxDistance ?? SKY_VISIBILITY_DEFAULTS.maxDistance
  const stride = options.stride ?? SKY_VISIBILITY_DEFAULTS.stride
  const n = field.vertPerSide
  if (field.analytic) {
    throw new Error('sky-visibility: a closed-form surface has no grid to march')
  }
  if (!Number.isInteger(stride) || stride < 1 || (n - 1) % stride !== 0) {
    throw new Error(`sky-visibility: stride ${stride} does not divide ${n - 1}`)
  }
  if (radiance !== null && radiance.length !== n * n * 3) {
    throw new Error(`sky-visibility: radiance has ${radiance.length} values, want ${n * n * 3}`)
  }
  const m = (n - 1) / stride + 1
  const distances = marchDistances(maxDistance / (field.step * (field.scaleX || 1)), samples)
  const values = new Float32Array(m * m)
  const bounce = radiance !== null ? new Float32Array(m * m * 3) : null
  const one = new Float64Array(3)
  let min = 1
  let sum = 0
  let maxBounce = 0
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const v = skyVisibilityAt(field, i * stride, j * stride, distances, azimuths, radiance, one)
      const t = j * m + i
      values[t] = v
      if (v < min) min = v
      sum += v
      if (bounce) {
        bounce[t * 3] = one[0] as number
        bounce[t * 3 + 1] = one[1] as number
        bounce[t * 3 + 2] = one[2] as number
        maxBounce = Math.max(maxBounce, one[0] as number, one[1] as number, one[2] as number)
      }
    }
    yield (j + 1) / m
  }
  return {
    samplesPerSide: m,
    values,
    bounce,
    stride,
    azimuths,
    samples,
    maxDistance,
    min,
    mean: sum / (m * m),
    maxBounce,
  }
}
