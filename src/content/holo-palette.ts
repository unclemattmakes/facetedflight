// src/content/holo-palette.ts — the terrain's own colours, small enough for a
// holotable (DEV-140).
//
// Matt, 2026-09-16: *"holo tables should be using the terrain's colors."*
//
// 2016's menu islands WERE the terrain's colours: `art_levelSel_*.prefab`'s
// 144 chunks wear `Faceted Terrain_miniMaps.mat` — `Marmoset/Vertex Color/
// Specular IBL`, `_Color` 0.941 neutral, emission black, no texture — a lit,
// vertex-painted, shrunken copy of the level. The holo-cyan ramp the port drew
// was a stand-in, not a port.
//
// The world colours a face by sampling 2016's colour MAP at the face's
// barycentre (`sim/terrain/faceted.ts`); the maps are 0.8–6.8 MB and
// `game/mission-shape.ts` refuses to fetch them for four 0.5 m models. So
// `tools/extract/palette.mjs` cuts each map down to a 64 x 64 box-filtered
// thumbnail — 12 KB of base64 in `content/palettes/<env>.json`, GENERATED from
// the hash-verified PNGs, checked by `pnpm extract:check` — and this file hands
// it back as the same `MapSampler` the generator samples. A fifth environment
// gets a palette by having a colour map in the manifest (rule 6).
//
// Content layer: no three, no DOM. `atob` is a JS global in every browser this
// runs in and in Node 16+, which is where the tests run.

import { createMapSampler, type ImageData8, type MapSampler } from '@/sim/terrain/image-sampler'

export interface HoloPaletteDoc {
  readonly environment: string
  readonly source: { readonly id: string; readonly path: string; readonly sha256: string }
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly filter: string
  /** `width * height * channels` bytes, base64. */
  readonly rgb: string
}

const files = import.meta.glob('../../content/palettes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, HoloPaletteDoc>

/** Every palette on disk, by environment key. */
export const paletteDocs = (): ReadonlyMap<string, HoloPaletteDoc> => {
  const out = new Map<string, HoloPaletteDoc>()
  for (const doc of Object.values(files)) out.set(doc.environment, doc)
  return out
}

/** The bytes back out of the JSON, checked against its own header. */
export const decodePalette = (doc: HoloPaletteDoc): ImageData8 => {
  const text = atob(doc.rgb)
  const data = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i)
  const expected = doc.width * doc.height * doc.channels
  if (data.length !== expected) {
    throw new Error(
      `holo-palette: ${doc.environment} decodes to ${data.length} bytes, header says ${expected}`,
    )
  }
  return { width: doc.width, height: doc.height, channels: doc.channels, data }
}

const samplers = new Map<string, MapSampler | null>()

/**
 * The environment's palette as a sampler, or null when there is none. Cached.
 *
 * `createMapSampler` and not `importUnityTexture`: the thumbnail is already
 * cut from the imported (nPOT-rescaled) texture, and it is 64 wide, which is a
 * power of two anyway. DEV-007's trap is on the SOURCE map, and the tool took it.
 */
export const paletteFor = (environment: string): MapSampler | null => {
  const hit = samplers.get(environment)
  if (hit !== undefined) return hit
  const doc = paletteDocs().get(environment) ?? null
  const sampler = doc ? createMapSampler(decodePalette(doc)) : null
  samplers.set(environment, sampler)
  return sampler
}
