// tests/unit/helpers/terrain-field.ts — a mission's own ground, for a test.
//
// NOT a `.test.ts`, so vitest does not collect it. Two specs need to ask "is this
// point above the terrain?" — `route-clearance.test.ts` and `orb-floor.test.ts` —
// and the answer depends on `worldOffset + local + envRoot`, the placement rule
// that has been wrong twice (DEV-042, DEV-047) and that `mission-shape.ts`'s own
// header calls the drift hazard. Writing it out a second time in a second spec
// is how the two would start disagreeing about where kauai is.
//
// The maps live in `public/assets`, which is gitignored and hydrated from R2
// (`pnpm assets:pull`), so `haveMaps` is false on CI and the specs that need a
// surface skip themselves there.
//
// **`importUnityTexture`, never the bare sampler.** Both Simonet maps are
// 1025x1025 with `nPOTScale: 1`; Unity rescaled them to 1024 at import and the
// generator sampled THAT. Skipping it is worth up to 30 m inland (DEV-007).

import fs from 'node:fs'
import { terrainOriginSim } from '@/game/mission-shape'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { buildHeightField, type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import { decodePngBuffer } from '../../../tools/terrain/png.mjs'
import { readJson } from './content'

export const MAPS: Record<string, string> = {
  simonet: 'public/assets/terrain/simonet/islandgroup-height.png',
  kauai: 'public/assets/terrain/kauai/kauai-height.png',
  desert: 'public/assets/terrain/desert/canyon_04-height.png',
  alpine: 'public/assets/terrain/alpine/forest_02-height.png',
}

/**
 * The WATER height map, for the environments that have an ocean.
 *
 * Both `simonet.ocean` and `kauai.ocean` are the same two source files — the
 * sheet says so — and desert and alpine have no ocean at all, which is why
 * `environmentTerrains` returns `ocean: null` for them.
 *
 * There is no sea-LEVEL constant to reach for instead. `render/water.ts` says it
 * in as many words: 116.6 is a spot value near the map origin and the wave puts
 * metres of chop through it, so the surface is a sample and never a number
 * (DEV-064).
 */
export const OCEAN_MAPS: Record<string, string> = {
  simonet: 'public/assets/terrain/simonet/water-height.png',
  kauai: 'public/assets/terrain/simonet/water-height.png',
}

export const haveMaps =
  Object.values(MAPS).every((p) => fs.existsSync(p)) &&
  Object.values(OCEAN_MAPS).every((p) => fs.existsSync(p))

/** Every shipped mission. Both callers sweep all thirteen rather than a sample. */
export const MISSIONS = [
  'int_01_hoverJet',
  'hoverJet_kauai_beg',
  'rookie_01_hoverJet',
  'rookie_02_hoverJet',
  'int_02_hoverJet',
  'adv_01_hoverJet',
  'adv_02_hoverJet',
  'rookie_01_jumpSeat',
  'rookie_02_jumpSeat',
  'int_01_jumpSeat',
  'int_02_jumpSeat',
  'adv_01_jumpSeat',
  'adv_02_jumpSeat',
] as const

/** The level JSON, read off disk. The JSON is the truth; the types lag it. */
// biome-ignore lint/suspicious/noExplicitAny: the specs read fields the Level type does not carry yet
export const loadLevelJson = (id: string): any => readJson(`content/levels/${id}.json`)

/** Decoding a 969 KB PNG per mission adds up; thirteen missions share four maps. */
const cache = new Map<string, HeightField>()

export const fieldFor = (level: { environment: string; worldOffset: number[] }): HeightField => {
  const key = `${level.environment}|${level.worldOffset.join(',')}`
  const hit = cache.get(key)
  if (hit) return hit
  const land = environmentTerrains(level.environment).land
  const img = decodePngBuffer(
    fs.readFileSync(MAPS[level.environment] as string),
    level.environment,
  ) as ImageData8
  const o = terrainOriginSim(land, level.worldOffset)
  const field = buildHeightField(importUnityTexture(img), terrainParams(land), {
    position: o.position,
    scale: o.scale,
  })
  cache.set(key, field)
  return field
}

/**
 * The environment's WATER field, or null where it has no ocean.
 *
 * Built exactly as `fieldFor` builds the land — same `importUnityTexture`, same
 * `terrainOriginSim`, which resolves the ocean's own transform and env root
 * rather than the island's (DEV-042: composing the parent chain is the only rule
 * that covers all four environments).
 */
export const oceanFieldFor = (level: {
  environment: string
  worldOffset: number[]
}): HeightField | null => {
  const ocean = environmentTerrains(level.environment).ocean
  const map = OCEAN_MAPS[level.environment]
  if (!ocean || !map) return null
  const key = `ocean|${level.environment}|${level.worldOffset.join(',')}`
  const hit = cache.get(key)
  if (hit) return hit
  const img = decodePngBuffer(fs.readFileSync(map), `${level.environment}.ocean`) as ImageData8
  const o = terrainOriginSim(ocean, level.worldOffset)
  const field = buildHeightField(importUnityTexture(img), terrainParams(ocean), {
    position: o.position,
    scale: o.scale,
  })
  cache.set(key, field)
  return field
}

/** The ground directly under a THREE-space point. The field is SIM space, which mirrors z. */
export const groundUnder = (field: HeightField, p: readonly number[]): number =>
  terrainHeightAt(field, p[0] as number, -(p[2] as number))

/** Metres of air between a THREE-space point and the ground beneath it. Negative is buried. */
export const clearance = (field: HeightField, p: readonly number[]): number =>
  (p[1] as number) - groundUnder(field, p)
