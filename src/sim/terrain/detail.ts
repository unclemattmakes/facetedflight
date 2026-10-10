// src/sim/terrain/detail.ts — LOD −1: the nearest chunks at a finer facet.
//
// ANNIVERSARY.md §1.4 is the argument, and it is a diagnosis rather than a
// taste: *"the uniform facet size is itself the miniature tell."* A real
// landscape has a fractal spectrum — pebbles, rocks, boulders, bluffs, ridges —
// and the eye reads distance from where along that spectrum the visible detail
// sits. Faceted Flight's world has **one grain size, 8 m, at every distance**,
// so there is nothing beyond the canopy that establishes the metre and a 35 m
// gate reads as a 4 m gate. §2.1 says the same thing from the speed side: 8 m
// facets at 90 m/s and 300 m up is an edge rate of **11 a second**, slower than
// the dashes on a road at 30 m/s.
//
// The ladder the port owns only ever goes COARSER. This adds one rung below it.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
//  * **Not a second generator.** A detail chunk is `generateChunk` with a
//    `baseResolution` of 4 instead of 8 and a vertex grid built at that pitch —
//    the same diagonal bug, the same skirts, the same barycentre colour, the
//    same edge-normal stamp, the same code. That is deliberate: every 2016
//    behaviour the ledger protects is protected here by being the same
//    function, not by being reimplemented faithfully a second time.
//  * **Not a change to LOD 0 or above.** `detailBand` is the only thing that
//    can return −1 and it returns null when the ring is off, which is what
//    Classic is. The oracle sweep and the structural tests see nothing.
//  * **Not a change to collision.** `height-field.ts` samples the ORIGINAL grid
//    at `terrainSize / baseResolution + 1` and never the LOD being drawn, which
//    is why LOD has never moved the surface you hit. A finer VISUAL grid is the
//    same kind of change as a coarser one: DEV-041's *"`heightField` is NOT what
//    you see"* holds either way, and the render already disagrees with it by the
//    jitter.
//  * **Not for the ocean.** The water plate is a second `FacetedTerrain` with
//    its own density knob (`?ocean=`, DEV-023) and 8,192 m chunks; a ring of
//    those is not a detail ring, it is the whole sea. `game/terrain/detail-ring.ts`
//    is where that exclusion lives.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random`. Everything here
// is a function of its arguments, so the band, the params and the queue plan can
// all be tested headlessly — which is the point, because the thing this feature
// can most easily get wrong is *when* it asks for geometry, not what it asks
// for.

import type { FacetedTerrainParams } from './faceted'

/**
 * The tuning, as the preset carries it. `content/editions/*.json` →
 * `EditionDetailRing` → here.
 *
 * Nothing in this file has a number of its own (hard rule 3): the ring's
 * resolution, radius, jitter and queue depth are all content, and Classic's
 * copy of them is a no-op.
 */
export interface DetailRingSpec {
  /** Metres per quad inside the ring. 4 against the shipped 8. */
  readonly baseResolution: number
  /** Ring radius in metres, HORIZONTAL, to the chunk footprint. */
  readonly radius: number
  /**
   * Multiplies the terrain's own `randomOffset` for the finer grid.
   *
   * 2016 tuned the jitter against an 8 m facet — 1.3 m on Simonet, 0.8 on
   * desert and alpine — which is 10–16 % of the pitch. Carried unchanged onto a
   * 4 m grid that becomes 20–33 %, and two adjacent vertices moving 1.3 m each
   * way on a 4 m pitch is not crumpled rock, it is noise that folds triangles.
   * Halving it with the resolution keeps the RATIO 2016 chose, so the finer
   * grain reads as the same rock, smaller — which is the fractal-spectrum
   * argument in §1.4, not a new look.
   */
  readonly jitterScale: number
  /** How many detail chunks may be awaiting a worker reply at once. */
  readonly maxInFlight: number
  /**
   * Metres of reconstruction between the height map's 8-bit levels, for the
   * ring's grid ONLY (DEV-131, `sim/terrain/dequantise.ts`). Zero is the base
   * grid's own sampler, so the ring samples exactly what LOD 0 samples.
   */
  readonly smoothMetres: number
}

/**
 * The band below LOD 0, with the SAME hysteresis mechanism the LOD ladder uses.
 *
 * `FlipFlopPercent` is 0.03 on every shipped terrain and it exists because a
 * chunk sitting exactly on a boundary otherwise swaps its mesh every frame. A
 * ring boundary is a boundary like any other, and a chunk flip-flopping across
 * it is worse than one flip-flopping between LOD 0 and 1 — it is four times the
 * geometry, regenerated in a worker, every frame.
 */
export interface DetailBand {
  /** Metres. Step IN below `radius * (1 - hysteresis)`. */
  readonly radius: number
  /** `FlipFlopPercent`, the terrain's own. Step OUT above `radius * (1 + this)`. */
  readonly hysteresis: number
}

/**
 * The band, or null when there is no ring.
 *
 * Null is the Classic answer and it is also the answer for a spec whose radius
 * is zero or negative, a non-finite one, or a resolution that is not finer than
 * what the terrain already draws. **A ring that is not finer is not a ring** —
 * it would regenerate every near chunk into an identical mesh forever — and
 * that case is silent rather than wrong, which is exactly the shape of hole
 * worth refusing at the door.
 */
export const detailBand = (
  spec: DetailRingSpec | null | undefined,
  params: Pick<FacetedTerrainParams, 'baseResolution'>,
  hysteresis: number,
): DetailBand | null => {
  if (!spec) return null
  if (!Number.isFinite(spec.radius) || spec.radius <= 0) return null
  if (!Number.isFinite(spec.baseResolution) || spec.baseResolution >= params.baseResolution) {
    return null
  }
  return { radius: spec.radius, hysteresis }
}

/**
 * The generator parameters for a chunk inside the ring.
 *
 * Everything except the pitch and the jitter is the terrain's own, and that is
 * load-bearing in two places:
 *
 *  * `terrainSize` unchanged means the barycentre UV — and therefore the colour
 *    every face is stamped with — is sampled from the same place in the same
 *    map. A detail chunk is the same painting at a finer weave.
 *  * `chunkSize` unchanged means the chunk BOUNDARIES do not move.
 *    `generateChunk` puts the chunk origin at `chunkX * (chunkSize /
 *    baseResolution)` grid steps, which is `chunkX * chunkSize` metres whatever
 *    the pitch. So a detail chunk occupies exactly the footprint its LOD 0 mesh
 *    did, the skirt still drops from the same edge, and the seam against a LOD 0
 *    neighbour is the seam the skirt already exists to hide.
 *
 * Throws when the pitch does not divide the chunk, because the alternative is a
 * fractional quad count that `generateChunk` would silently floor into a chunk
 * that does not reach its own edge — a gap, at the exact place the player is
 * looking. The message names both numbers, like the LOD-too-fine one next door.
 */
export const detailChunkParams = (
  params: FacetedTerrainParams,
  spec: DetailRingSpec,
): FacetedTerrainParams => {
  const quads = params.chunkSize / spec.baseResolution
  if (!Number.isInteger(quads) || quads < 1) {
    throw new Error(
      `Detail ring resolution ${spec.baseResolution} m does not divide the chunk size ` +
        `${params.chunkSize} m: ${quads} quads per chunk. The ring's baseResolution must ` +
        "be a whole divisor of chunkSize, and finer than the terrain's own " +
        `${params.baseResolution} m.`,
    )
  }
  if (!Number.isInteger(params.terrainSize / spec.baseResolution)) {
    throw new Error(
      `Detail ring resolution ${spec.baseResolution} m does not divide the terrain size ` +
        `${params.terrainSize} m, so the vertex grid would not land on the chunk edges.`,
    )
  }
  return {
    ...params,
    baseResolution: spec.baseResolution,
    randomOffset: params.randomOffset * spec.jitterScale,
  }
}

/**
 * Triangles in one chunk at a given pitch, SKIRT INCLUDED.
 *
 * `(chunkSize / resolution + 2)^2 * 2` — the `+ 2` is the skirt ring, which is
 * a fixed cost per chunk and does NOT scale with the pitch. That is why a 4 m
 * chunk is 3.77x a 4 m one rather than exactly 4x on Simonet's 256 m chunks
 * (8,712 against 2,312), and why the honest way to state the interior ratio is
 * to state the interior: 64² quads against 32², which is exactly four.
 *
 * Exported because a budget nobody can compute is a budget nobody checks, and
 * ANNIVERSARY.md §5's Measure column for this row is *"vertex count and frame
 * time on Quest"*.
 */
export const chunkTriangles = (chunkSize: number, resolution: number): number => {
  const q = chunkSize / resolution
  return (q + 2) * (q + 2) * 2
}

/** A chunk that wants to be at LOD −1, and how far away it is. */
export interface DetailCandidate {
  readonly cx: number
  readonly cy: number
  /** Horizontal metres to the chunk footprint — what `selectLod` was given. */
  readonly distance: number
}

/**
 * Which of the chunks that want detail may be asked for THIS frame.
 *
 * ── Why a cap at all ─────────────────────────────────────────────────────
 *
 * The worker is serial and a detail chunk is roughly four times the work of a
 * LOD 0 one. A ship crossing the island at 180 m/s sweeps the ring across a new
 * column of chunks every 1.4 s; without a cap, one frame can enqueue every
 * chunk that has just come into range, and the worker then spends its next
 * second producing geometry for ground the ship has already left — while the
 * ordinary LOD 1→0 regenerations the player CAN see queue behind it.
 *
 * The cap does not change throughput, which is the worker's. It changes
 * STALENESS: with a shallow queue the selection is re-made from the current
 * camera position every few chunks, so what gets built is what is near now.
 *
 * ── Nearest first ────────────────────────────────────────────────────────
 *
 * Sorted by distance ascending, because the ring's whole purpose is the ground
 * under the ship (§2.1: optic flow is v/d, and the near field dominates). Ties
 * break on chunk index so the order is deterministic and a test can state it.
 *
 * LOD ≥ 0 transitions are NOT routed through here. They are the shipped
 * behaviour, they can only ever reduce or restore what 2016 drew, and starving
 * them behind a detail queue would make the terrain coarsen late — a regression
 * caused by an addition, which is the worst kind.
 */
export const planDetailRequests = (
  candidates: readonly DetailCandidate[],
  inFlight: number,
  maxInFlight: number,
): readonly DetailCandidate[] => {
  const budget = Math.min(Math.floor(maxInFlight), Number.MAX_SAFE_INTEGER) - inFlight
  if (!(budget > 0) || candidates.length === 0) return []
  const sorted = [...candidates].sort(
    (a, b) => a.distance - b.distance || a.cx - b.cx || a.cy - b.cy,
  )
  return sorted.slice(0, budget)
}
