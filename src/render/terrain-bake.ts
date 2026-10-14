// src/render/terrain-bake.ts: the terrain's two world bakes, keyed by their inputs and kept as bytes.
// DEV-955, docs/plan/EVAL-WAVE-2026-10-13.md section C.
//
// ── What is cached, and why not the textures ─────────────────────────────
//
// A mission load runs two pure bakes on the main thread (1.33 to 1.44 s and
// 174 to 328 ms on a desktop, DEVIATIONS DEV-355): the far-shadow march
// (`sim/terrain/sun-height.ts`) and the sky-visibility horizon march
// (`sim/terrain/sky-visibility.ts`). A shipped mission has a fixed terrain and a
// fixed sun, so both are the same bytes every time.
//
// What is kept is each bake's SIM OUTPUT (`SunHeightField`, `SkyVisibilityField`),
// not the uploaded texture. The textures are built from those in tens of
// milliseconds and they carry things the bake does not own: the canopy channel
// (props, the live preset), the half-float packing, the uniforms. Keeping the
// fields means one file serves both editions, and a preset flip still works.
//
// ── The key is the INPUTS, so a stale file cannot be used ────────────────
//
// `sunBakeKey` hashes what `sunHeightSteps` reads (the height grid's bytes, its
// geometry, the exact vector it is handed). `skyBakeKey` hashes the sun key, the
// albedo grid, the softening and the march's parameters. A file is named by its
// key and carries it in its header, so a mismatch is a different file, not a
// wrong answer; a custom course, the editor and a moved sun simply never match
// and run the bake as they always did.
//
// `TERRAIN_BAKE_VERSION` is the one thing the hash cannot see: a change to the
// marching code itself. `tests/unit/terrain-bake.test.ts` regenerates every
// shipped bake and compares it to the file on disk byte for byte, which is what
// goes red when the code moves and the version was forgotten.
//
// ── Float safety ─────────────────────────────────────────────────────────
//
// The bake is IEEE arithmetic plus `Math.sqrt/hypot/exp/pow/atan` in V8's own
// software implementations, which are the same in Node and Chrome. Not assumed:
// `tests/e2e/terrain-bake.spec.ts` bakes in the browser and compares to the file.

import { sha256Hex } from '@/content/sha256'
import { runSteps, type Steps } from '@/sim/steps'
import type { HeightField } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import { SKY_VISIBILITY_DEFAULTS, type SkyVisibilityField } from '@/sim/terrain/sky-visibility'
import { type SunHeightField, sunHeightSteps } from '@/sim/terrain/sun-height'
import { albedoGrid, skyFieldSteps, strideFor } from './sky-visibility'

/** Bumped when `sunHeightSteps`, `skyVisibilitySteps` or `buildSunRadiance` change what they return. */
export const TERRAIN_BAKE_VERSION = 1

const MAGIC = 0x42544646 // 'FFTB', little endian
const KIND_SUN = 1
const KIND_SKY = 2
const KEY_BYTES = 32
const FIXED_HEADER = 16 + KEY_BYTES

export type BakeKind = 'sun' | 'sky'

/** A shipped bake's path under the asset base. Content-addressed: the key is the name. */
export const bakeAssetPath = (kind: BakeKind, key: string): string =>
  `assets/terrain-bake/${kind}-${key}.bin`

// ── hashing ───────────────────────────────────────────────────────────────

const concat = (parts: readonly ArrayBufferView[]): Uint8Array => {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at)
    at += p.byteLength
  }
  return out
}

/** SHA-256 hex. `crypto.subtle` where there is one (a page over plain HTTP has none), the pure copy otherwise: same digest. */
export const digestHex = async (bytes: Uint8Array): Promise<string> => {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return sha256Hex(bytes)
}

const f64 = (...v: number[]): Float64Array => Float64Array.from(v)

/**
 * What `sunHeightSteps(land, towardSun)` reads, as a digest. `towardSun` is the
 * vector the march is HANDED (far-shadow's `towardSunSim` of the field-frame
 * sun), so any difference in how it was derived shows up here.
 */
export const sunBakeKey = (
  land: HeightField,
  towardSun: readonly [number, number, number],
): Promise<string> =>
  digestHex(
    concat([
      f64(
        TERRAIN_BAKE_VERSION,
        KIND_SUN,
        land.vertPerSide,
        land.step,
        land.terrainSize,
        land.terrainHeight,
        land.originX,
        land.originY,
        land.originZ,
        land.scaleX,
        land.scaleY,
        land.scaleZ,
        towardSun[0],
        towardSun[1],
        towardSun[2],
      ),
      land.heights,
    ]),
  )

/** What `skyFieldSteps` reads beyond the land and the sun field. */
export const skyBakeKey = (
  sunKey: string,
  albedo: Float32Array,
  softMetres: number,
): Promise<string> =>
  digestHex(
    concat([
      new TextEncoder().encode(sunKey),
      f64(
        TERRAIN_BAKE_VERSION,
        KIND_SKY,
        softMetres,
        SKY_VISIBILITY_DEFAULTS.azimuths,
        SKY_VISIBILITY_DEFAULTS.samples,
        SKY_VISIBILITY_DEFAULTS.maxDistance,
      ),
      albedo,
    ]),
  )

// ── bytes ─────────────────────────────────────────────────────────────────

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const header = (kind: number, key: string, scalars: Float64Array): Uint8Array => {
  const out = new Uint8Array(FIXED_HEADER + scalars.byteLength)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, TERRAIN_BAKE_VERSION, true)
  dv.setUint32(8, kind, true)
  dv.setUint32(12, scalars.length, true)
  out.set(hexToBytes(key), 16)
  out.set(new Uint8Array(scalars.buffer, scalars.byteOffset, scalars.byteLength), FIXED_HEADER)
  return out
}

/** The scalar fields of a SunHeightField, in file order. Every key of the type that is not an array is here. */
const SUN_SCALARS = [
  'vertPerSide',
  'step',
  'terrainSize',
  'originX',
  'originY',
  'originZ',
  'scaleX',
  'scaleY',
  'scaleZ',
  'maxDepth',
  'minTop',
  'maxTop',
  'steps',
] as const

const SKY_SCALARS = [
  'samplesPerSide',
  'stride',
  'azimuths',
  'samples',
  'maxDistance',
  'min',
  'mean',
  'maxBounce',
] as const

/** Exported for the test that proves the lists above cover the types. */
export const BAKE_SCALAR_KEYS = { sun: SUN_SCALARS, sky: SKY_SCALARS } as const

const sunScalars = (f: SunHeightField): Float64Array => {
  const out: number[] = SUN_SCALARS.map((k) => f[k])
  out.push(...f.towardSun, ...f.marchedSun, f.degenerate ? 1 : 0)
  return Float64Array.from(out)
}
const SUN_SCALAR_COUNT = SUN_SCALARS.length + 7

const skyScalars = (f: SkyVisibilityField): Float64Array =>
  Float64Array.from([...SKY_SCALARS.map((k) => f[k]), f.bounce ? 1 : 0])
const SKY_SCALAR_COUNT = SKY_SCALARS.length + 1

export const encodeSunBake = (key: string, f: SunHeightField): Uint8Array =>
  concat([header(KIND_SUN, key, sunScalars(f)), f.tops, f.depths])

export const encodeSkyBake = (key: string, f: SkyVisibilityField): Uint8Array =>
  concat([header(KIND_SKY, key, skyScalars(f)), f.values, ...(f.bounce ? [f.bounce] : [])])

const keyMatches = (bytes: Uint8Array, key: string): boolean => {
  const want = hexToBytes(key)
  for (let i = 0; i < KEY_BYTES; i++) if (bytes[16 + i] !== want[i]) return false
  return true
}

/** Float32 views need 4-aligned offsets; a fetched ArrayBuffer is, a sliced Uint8Array may not be. */
const f32At = (bytes: Uint8Array, at: number, count: number): Float32Array => {
  const aligned = (bytes.byteOffset + at) % 4 === 0
  if (aligned) return new Float32Array(bytes.buffer, bytes.byteOffset + at, count)
  return new Float32Array(bytes.slice(at, at + count * 4).buffer)
}

const readHeader = (
  bytes: Uint8Array,
  kind: number,
  key: string,
  scalarCount: number,
): Float64Array | null => {
  if (bytes.byteLength < FIXED_HEADER + scalarCount * 8) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== MAGIC) return null
  if (dv.getUint32(4, true) !== TERRAIN_BAKE_VERSION) return null
  if (dv.getUint32(8, true) !== kind) return null
  if (dv.getUint32(12, true) !== scalarCount) return null
  if (!keyMatches(bytes, key)) return null
  const out = new Float64Array(scalarCount)
  for (let i = 0; i < scalarCount; i++) out[i] = dv.getFloat64(FIXED_HEADER + i * 8, true)
  return out
}

/**
 * The SunHeightField in `bytes`, or null for anything that is not exactly the
 * file `encodeSunBake(key, ...)` wrote for a field of this land's size: wrong
 * magic or version, another key, a short or long body. A static host answering
 * a missing path with its HTML shell (200) lands here too.
 */
export const decodeSunBake = (
  bytes: Uint8Array,
  key: string,
  land: HeightField,
): SunHeightField | null => {
  const s = readHeader(bytes, KIND_SUN, key, SUN_SCALAR_COUNT)
  if (!s) return null
  const n = s[0] as number
  if (n !== land.vertPerSide) return null
  const body = FIXED_HEADER + SUN_SCALAR_COUNT * 8
  if (bytes.byteLength !== body + n * n * 8) return null
  const sc = SUN_SCALARS.length
  const out: Record<string, unknown> = {}
  SUN_SCALARS.forEach((k, i) => {
    out[k] = s[i]
  })
  out.towardSun = [s[sc], s[sc + 1], s[sc + 2]]
  out.marchedSun = [s[sc + 3], s[sc + 4], s[sc + 5]]
  out.degenerate = s[sc + 6] === 1
  out.tops = f32At(bytes, body, n * n)
  out.depths = f32At(bytes, body + n * n * 4, n * n)
  return out as unknown as SunHeightField
}

export const decodeSkyBake = (
  bytes: Uint8Array,
  key: string,
  land: HeightField,
): SkyVisibilityField | null => {
  const s = readHeader(bytes, KIND_SKY, key, SKY_SCALAR_COUNT)
  if (!s) return null
  const m = s[0] as number
  if (m !== (land.vertPerSide - 1) / strideFor(land.vertPerSide) + 1) return null
  const hasBounce = s[SKY_SCALARS.length] === 1
  const body = FIXED_HEADER + SKY_SCALAR_COUNT * 8
  if (bytes.byteLength !== body + m * m * 4 * (hasBounce ? 4 : 1)) return null
  const out: Record<string, unknown> = {}
  SKY_SCALARS.forEach((k, i) => {
    out[k] = s[i]
  })
  out.values = f32At(bytes, body, m * m)
  out.bounce = hasBounce ? f32At(bytes, body + m * m * 4, m * m * 3) : null
  return out as unknown as SkyVisibilityField
}

/**
 * `steps`, counting each row it yields into `tally`: the receipt that says how
 * much of a march a load actually ran (zero for a baked field).
 */
export function* countRows<T>(steps: Steps<T>, tally: { rows: number }): Steps<T> {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
    tally.rows++
    yield next.value
  }
}

// ── the content-time bake ─────────────────────────────────────────────────

export interface TerrainBake {
  readonly sunKey: string
  readonly sun: SunHeightField
  readonly skyKey: string
  readonly sky: SkyVisibilityField
}

/**
 * Both bakes for one land and sun, by the same generators the loader runs
 * (`sunHeightSteps`, `skyFieldSteps`). `towardSun` is the vector the loader hands
 * `sunHeightSteps`; `albedo` the grid the loader hands `skyFieldSteps`.
 */
export const bakeTerrain = async (
  land: HeightField,
  colorMap: MapSampler,
  towardSun: readonly [number, number, number],
  softMetres: number,
): Promise<TerrainBake> => {
  const sunKey = await sunBakeKey(land, towardSun)
  const sun = runSteps(sunHeightSteps(land, towardSun))
  const albedo = albedoGrid(land, colorMap)
  const skyKey = await skyBakeKey(sunKey, albedo, softMetres)
  const sky = runSteps(skyFieldSteps(land, albedo, sun, softMetres))
  return { sunKey, sun, skyKey, sky }
}
