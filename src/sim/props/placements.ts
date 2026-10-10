// src/sim/props/placements.ts — the scatter, baked.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// `scatterProps` needs a **density map** — a World Machine PNG, 2.48 MB across
// the three of them — and the only way to get one to a browser is to serve it.
// That is a publishing act, because anything on R2 is public. Those three files
// are the ones that carried question **O13 / C-6**: which World Machine edition
// produced them, whose free tier is non-commercial. O13 was answered on
// 2026-09-14: the Anniversary Edition is not sold.
//
// Matt's question was the right one — *"the maps are content used to generate
// other data, not read at runtime, right?"* For the ten terrain height and
// colour maps the answer is no, they genuinely are read at runtime (D28). For
// the three density maps the answer is yes, and only because the scatter is
// seeded and pure: run it once, keep the answer, and the map never has to leave
// the machine that extracted it.
//
// ── What is stored, and what is derived ───────────────────────────────────
//
// **9 bytes per placement**, little-endian:
//
//   0..1  texel x   uint16
//   2..3  texel y   uint16
//   4..5  yaw       uint16   over [0, 2π)
//   6..7  scale     uint16   over [scaleMin, scaleMax]
//   8     palette   uint8    index into THIS generator's palette
//
// Everything else is recomputed at load, exactly:
//
//   wx = tx * terrainSize / width          exact — the same expression the
//   wz = ty * terrainSize / height         scatter used, from the same integer
//   y  = height(u,v) * terrainHeight - heightOffset
//   chunk = f(wx, wz, chunkSize)
//
// **`y` is not stored**, which is where most of the saving is, and it is free
// because the height map is fetched for the terrain regardless. It is also the
// trap: `heightOffset` is PER GENERATOR and alpine's two passes are -2.6 and 5,
// **7.6 m apart** against terrain whose own jitter is 0.8 m. Derive `y` with
// the wrong generator's offset and half the forest floats. That is why a blob
// hangs off a `scatter[]` ENTRY and is never flattened across an environment —
// and the same is true of `palette` (index 3 is `Tree4` under alpine gen0 and
// `Tree_Organic_03` under gen1) and of `scale` (6..20 against 1.4..5.5, so the
// wrong range renders the big pass about 4× too small).
//
// Three environments out of four have a single generator and would survive a
// flat format. Alpine is the one that would not. *A rule tested only where two
// explanations agree has not been tested* — so the round-trip test covers
// alpine's gen1 specifically.
//
// ── What quantising costs ─────────────────────────────────────────────────
//
// Positions do NOT quantise: a texel index is the exact integer the scatter
// looped on, so `wx`/`wz` reproduce bit-for-bit and `y` reproduces to whatever
// the height sampler gives. Only yaw and scale are quantised, at 2π/65536
// (0.0055°) and one 65535th of the scale span. Those are below the threshold of
// anything — a uint8 yaw would have been 1.4° and still invisible, but 2 bytes
// a placement buys an assertion that can be tight instead of tolerant, and
// `expandPlacements` is checked against `scatterProps` rather than against a
// recorded expectation.
//
// SIM LAYER: pure, THREE-free, deterministic.

import type { ScatteredProps, ScatterParams, TerrainExtent } from '@/sim/props/scatter'
import { grayscale } from '@/sim/terrain/faceted'
import type { MapSampler } from '@/sim/terrain/image-sampler'

/** Bytes per placement in the packed blob. */
export const PLACEMENT_STRIDE = 9

const TAU = Math.PI * 2
const U16 = 0xffff

/** The map dimensions the texel indices are relative to, AFTER Unity's NPOT rescale. */
export interface PlacementMapSize {
  readonly width: number
  readonly height: number
}

/**
 * Pack a scatter result into the 9-byte-per-placement form.
 *
 * Takes the scatter's own `texel`, `yaw`, `scale` and `palette`; `positions`
 * and `chunk` are deliberately dropped because they are recomputable and are
 * most of the bytes.
 */
export const encodePlacements = (props: ScatteredProps, params: ScatterParams): Uint8Array => {
  const span = params.scaleMax - params.scaleMin
  const out = new Uint8Array(props.count * PLACEMENT_STRIDE)
  const view = new DataView(out.buffer)

  for (let i = 0; i < props.count; i++) {
    const o = i * PLACEMENT_STRIDE
    view.setUint16(o, props.texel[i * 2] ?? 0, true)
    view.setUint16(o + 2, props.texel[i * 2 + 1] ?? 0, true)

    // `% TAU` first: a yaw of exactly TAU must wrap to 0, not round to 65536
    // and overflow the field to 0 by accident. Same answer, stated on purpose.
    const yaw = (((props.yaw[i] ?? 0) % TAU) + TAU) % TAU
    view.setUint16(o + 4, Math.round((yaw / TAU) * U16), true)

    // A zero span means every scale is `scaleMin`; dividing by it would write
    // NaN, which `setUint16` silently stores as 0 — correct here by luck, and
    // luck is not a reason.
    const t = span === 0 ? 0 : ((props.scale[i] ?? params.scaleMin) - params.scaleMin) / span
    view.setUint16(o + 6, Math.round(Math.min(1, Math.max(0, t)) * U16), true)

    out[o + 8] = props.palette[i] ?? 0
  }
  return out
}

/**
 * Expand a packed blob back into the same shape `scatterProps` returns.
 *
 * `heightMap`, `terrain` and `params` must be the ones belonging to the
 * generator this blob was baked from — see the header on why that matters.
 */
export const expandPlacements = (
  bytes: Uint8Array,
  map: PlacementMapSize,
  heightMap: MapSampler,
  terrain: TerrainExtent,
  params: ScatterParams,
): ScatteredProps => {
  if (bytes.length % PLACEMENT_STRIDE !== 0) {
    throw new Error(
      `placements blob is ${bytes.length} bytes, not a multiple of ${PLACEMENT_STRIDE}`,
    )
  }
  const count = bytes.length / PLACEMENT_STRIDE
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const chunkPerSide = Math.max(1, Math.round(terrain.terrainSize / terrain.chunkSize))
  const span = params.scaleMax - params.scaleMin
  const rgb = { r: 0, g: 0, b: 0 }

  const positions = new Float32Array(count * 3)
  const yaw = new Float32Array(count)
  const scale = new Float32Array(count)
  const palette = new Uint8Array(count)
  const chunk = new Uint16Array(count)
  const texel = new Uint16Array(count * 2)

  for (let i = 0; i < count; i++) {
    const o = i * PLACEMENT_STRIDE
    const tx = view.getUint16(o, true)
    const ty = view.getUint16(o + 2, true)

    const u = tx / map.width
    const v = ty / map.height
    heightMap.sample(u, v, rgb)
    const h = grayscale(rgb.r, rgb.g, rgb.b) * terrain.terrainHeight

    const wx = (tx * terrain.terrainSize) / map.width
    const wz = (ty * terrain.terrainSize) / map.height

    positions[i * 3] = wx
    positions[i * 3 + 1] = h - params.heightOffset
    positions[i * 3 + 2] = wz

    yaw[i] = (view.getUint16(o + 4, true) / U16) * TAU
    scale[i] = params.scaleMin + (view.getUint16(o + 6, true) / U16) * span
    palette[i] = bytes[o + 8] ?? 0

    const cx = Math.min(chunkPerSide - 1, Math.floor(wx / terrain.chunkSize))
    const cz = Math.min(chunkPerSide - 1, Math.floor(wz / terrain.chunkSize))
    chunk[i] = cz * chunkPerSide + cx

    texel[i * 2] = tx
    texel[i * 2 + 1] = ty
  }

  return { count, positions, yaw, scale, palette, chunk, texel, chunkPerSide }
}

/** base64 → bytes, without assuming `Buffer` (the sim layer runs in a browser too). */
export const decodeBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** bytes → base64, the form the environment JSON carries. */
export const encodeBase64 = (bytes: Uint8Array): string => {
  let bin = ''
  // Chunked: `String.fromCharCode(...huge)` blows the argument limit somewhere
  // north of 100k entries, and 20,609 placements is 185 KB.
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
  }
  return btoa(bin)
}
