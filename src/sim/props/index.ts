// src/sim/props/index.ts — the environment prop layer.
//
// `scatter` places props from a density map; `clearing` says which ground it
// must leave alone; `lod` decides how many of each chunk's props are drawn. All
// three are pure: no THREE, no clock, no Math.random.

export {
  type Clearing,
  footprintRadius,
  gameClearingRadius,
  insideAnyClearing,
  type LaunchSite,
  type OrientedBox,
} from './clearing'
export {
  initPropLod,
  PROP_LOD_DEFAULTS,
  type PropChunkState,
  type PropLodParams,
  type PropLodRuntime,
  RUNG_OFF,
  rungAt,
  rungShare,
  stepPropLod,
} from './lod'
export {
  type ScatteredProps,
  type ScatterParams,
  scatterProps,
  shuffleByChunk,
  type TerrainExtent,
} from './scatter'
