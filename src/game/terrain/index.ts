// src/game/terrain/ — the runtime faceted-terrain generator (M0.6).
//
// This is the reimplementation of the 2016 `FacetedTerrain.cs`, and it is
// FORCED, not chosen: the 2016 baked chunks are 7.15 GB of Unity binary
// `.asset` and unshippable at any fidelity (DECISIONS D3 / D8). Because we own
// the generator anyway, procedural worlds, endless mode and a level editor
// become near-free later instead of a rewrite.
//
// Two rules for whoever writes the body of this module:
//
//  1. **The core is shared with the Node bake.** `tools/` bakes reference
//     hashes with the same code this ships; if they diverge, the geometry
//     golden test is measuring nothing.
//  2. **Reproduce the bugs.** The adaptive quad diagonal uses `.y` where it
//     means `.z`. That is a 2016 bug and it is in the silhouette. Fixing it
//     produces a terrain that is *almost* right — the most expensive kind of
//     wrong. Log it in `docs/DEVIATIONS.md` if it is ever changed.
//
// The generator runs in a PLAIN Worker with transferable `ArrayBuffer`s — not
// `SharedArrayBuffer`, so no COOP/COEP headers anywhere (PORT_PLAN §2.4).

export interface TerrainChunkSpec {
  /** Chunk index in the grid. Simonet is 16×16; Desert is 8×8. */
  cx: number
  cz: number
  /** Quads per side. Simonet 256, Desert 512. */
  quadPerSide: number
  /** World size of one chunk, metres. */
  chunkSize: number
  seed: number
}

/** Skirt column count is `quadPerSide + 2` — asserted by the geometry golden test. */
export const skirtColumns = (quadPerSide: number): number => quadPerSide + 2

export const chunkVertexCount = (quadPerSide: number): number => {
  // Split verts: every quad contributes two independent flat-shaded triangles,
  // so vertices are NOT shared. 6 per quad.
  return quadPerSide * quadPerSide * 6
}
