// src/game/props/sea-line.ts : how low a scattered prop's base may stand. DEV-862.
//
// Matt, 2026-10-08: *"we have palm trees spawning below the water-line on
// simonet and possibly kauai. make sure no trees are spawned below the wave
// height + ocean surface."*
//
// The scatter is baked from a density map and a STUB height map
// (`tools/assets/bake-placements.mjs`), so a placement knows nothing about the
// sea: a texel of palm density over the seabed is a palm on the seabed, 138 m
// under Simonet's water. 2016 never drew these passes on either island
// (`shipped2016.bakedObjects` is 0), so the defect is Anniversary's, and it is
// the loader, which is the first place the land's height and the sea's both
// exist, that has to ask.
//
// ── The floor ────────────────────────────────────────────────────────────
//
// The sea's REST surface at the placement (the ocean's collision field, which
// is the plate before the whole-plate bob and the per-vertex wave move it) plus
// `highWater`: the most the drawn sea ever stands over rest anywhere,
// `LoadedTerrain.highWater` (3.459 + 4 m on Simonet). A base under that is in
// the sea for part of every wave, which is Matt's sentence. The band between
// "rest" and "high water" holds 6 of Simonet's 1,240 placements; 563 are under
// the sea at rest, about 480 of them 60 m or more down on the seabed, so the
// choice of line barely moves the count and the strict one costs nothing. (The
// same 569 under high water with 2016's diagonal or the fixed one, snapped or
// raw: the facet is not the cause, the bake is.)
//
// ── Frames ───────────────────────────────────────────────────────────────
//
// `loadProps` works in the land's MESH frame: x and z run 0..terrainSize from
// the terrain's corner (DEV-042) and y is height above the terrain's origin.
// A `HeightField` is in SIM space, whose origin is the terrain transform
// (`originX/Y/Z`, `scaleX/Y/Z`). So a mesh point is `origin + mesh * scale` in
// sim space, and the floor goes back by the inverse. Both fields are in the
// same sim frame whatever the level's `worldOffset`, which moves them together.
//
// THREE-free and DOM-free; sits in `game/` only because it composes two
// loaded terrains.

import { type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'

/**
 * The lowest y a prop's base may have at mesh-frame (x, z) of `land`, in
 * `land`'s mesh frame: `sea`'s rest surface there plus `highWater` metres.
 *
 * @param land      the island's collision field (its frame is the answer's)
 * @param sea       the ocean's collision field, at rest
 * @param highWater `LoadedTerrain.highWater` of the ocean: bob plus wave ceiling
 */
export const seaLineFor =
  (land: HeightField, sea: HeightField, highWater: number) =>
  (x: number, z: number): number => {
    const simY = terrainHeightAt(
      sea,
      land.originX + x * (land.scaleX || 1),
      land.originZ + z * (land.scaleZ || 1),
    )
    return (simY + highWater - land.originY) / (land.scaleY || 1)
  }
