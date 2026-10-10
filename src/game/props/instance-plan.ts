// src/game/props/instance-plan.ts — which instances of a scatter batch get
// drawn this frame, and where they have to sit in the buffer for that to be one
// draw call. DEV-225.
//
// A leaf on purpose, like `cells.ts` beside it: pure arithmetic, no three, no
// `import.meta`, so a unit test and an e2e spec can both reach it
// (`tests/unit/e2e-import-graph.test.ts`).
//
// ── The problem this solves, and the one it deliberately does not ─────────
//
// The scatter is ~18 `InstancedMesh`es for 5,943 instances on desert (12,085
// on alpine over 20), which is 7.42 M triangles in 18 draw calls and **88–93 %
// of the world pass** on those two environments. three's frustum culling can
// only reject a whole batch, so the only thing it can say about the scatter is
// "all of it" or "none of it"; there is no per-instance anything.
//
// **And 2016 did not draw all of it.** `FacetedTerrainObjectGenerator` keeps a
// per-CHUNK pool and `SetActive(false)`s a chunk past `LODDistance` — 1280 m on
// desert, Simonet and Kauai, 1920 on alpine's first pass, and it is on the
// generator, extracted, in `content/environments/*.json`, and until DEV-225 no
// code path read it. So the port has been drawing MORE forest than the game it
// is a port of, at every distance, for its whole life. Swept over the real
// baked placements from nine camera positions spread across each map:
//
//     env      instances   kept at R=1280      kept at R=1920
//     desert       5,943   1,395–2,685 (23–45 %)   2,444–5,469 (41–92 %)
//     alpine      12,085   3,236–9,313 (27–77 %)   6,529–11,820 (54–98 %)
//     simonet      1,240     198–560   (16–45 %)     404–1,159  (33–93 %)
//
// DEV-338 added the other half: a cheaper MESH for a distant instance. Every
// prop is still one glTF; the coarser rungs are simplified from it at load
// (`lod-geometry.ts`), each rung is its own `InstancedMesh` over the SAME source
// order, and a chunk moving between rungs is a slice `[f, 1)` of its run on the
// old mesh and `[0, f)` on the new — `packRange` below. (This header used to
// say 2016 had no prop LOD at all. Its Tree Pack did: `Tree10.prefab` carries
// a `LODGroup` with three meshes. The packs the desert and the islands drew
// from had none.)
//
// ── Why the instances are ORDERED BY CHUNK, and why that is the whole trick ─
//
// `InstancedMesh` draws instances `[0, count)`. One contiguous prefix, one
// number — there is no per-instance visibility bit and no second draw range. So
// "draw these 40 chunks and not those 24" has to become "the instances of those
// 40 chunks occupy the front of the buffer".
//
// The alternative that suggests itself first is one `InstancedMesh` per
// (chunk x palette entry), which is what `load-props.ts`'s header rejected:
// 256 chunks x 13 palette entries is 3,328 objects of ~2 instances each. DEV-118
// already measured the cheap version of that mistake — splitting `int_01`'s
// scatter into a 4x4 culling grid took the props from 8 draws to 78 and made the
// GPU *slower*, because on that frame the triangles were never the cost.
//
// Ordering by chunk ONCE at build time makes each chunk a contiguous RUN, so a
// visible set is a handful of block copies into the front of the buffer and the
// draw count never moves: 18 draws before, 18 draws after, with a third of the
// instances in them. `packVisible` returns that copy plan, and it MERGES
// adjacent runs, so a visible set that happens to be contiguous — which is most
// of them, because chunk ids are row-major and the visible set is a disc — is
// one `TypedArray.set` rather than forty.
//
// ── The order INSIDE a chunk is shuffled, and that is 2016's reveal ───────
//
// `stepPropLod` reveals `ceil(total * percent)` of a chunk per frame over
// `lodTransitionTime`, each picked at random from the pool — trees arrive a few
// at a time, scattered, over about a second, rather than a block appearing.
// With the instances in a fixed order, "reveal k at random" is "reveal the
// first k", PROVIDED the order inside the chunk is random. It is not by
// default: the bake walks the density map in texel-scan order, x outer and y
// inner, so the first k of a chunk is a STRIPE down its western edge. So the
// order within each run is shuffled here, deterministically, from the pass's
// own seed. `sim/props/lod.ts` calls this out as the reason the object pools
// could be dropped; this is where it is paid for.

import { xorshift32 } from '@/sim/math/rng'

/** One chunk's contiguous run inside a batch's instance buffer. */
export interface ChunkRun {
  /** The chunk id the run holds, as `expandPlacements` numbers them. */
  readonly chunk: number
  /** First instance slot of the run, in the SOURCE order. */
  readonly start: number
  /** How many instances the run holds. */
  readonly count: number
}

/** A batch's instance layout: the source order, and where each chunk sits in it. */
export interface InstanceLayout {
  /**
   * Placement indices in the order they are written to the buffer — grouped by
   * chunk, shuffled within each chunk.
   */
  readonly order: readonly number[]
  /** The runs, in ascending chunk id. Never empty runs. */
  readonly runs: readonly ChunkRun[]
}

// The generator is `sim/math/rng.ts`'s `xorshift32`. It is deliberately NOT the
// stream `sim/terrain/faceted.ts` uses: this picks a draw ORDER and nothing
// else, so it can never move a prop, and each constructor call is its own
// stream, so a change to terrain's generator cannot re-roll the world.

/**
 * Group a batch's placements by chunk and shuffle inside each group.
 *
 * `indices` is the batch's placement indices in bake order; `chunkOf` reads the
 * chunk id of a placement (`ScatteredProps.chunk`). The result's `order` is a
 * permutation of `indices` — same multiset, never a subset — which is the
 * property the test asserts, because a layout that quietly dropped a prop would
 * look exactly like a layout that is working.
 */
export const layoutByChunk = (
  indices: readonly number[],
  chunkOf: (placement: number) => number,
  seed: number,
): InstanceLayout => {
  const byChunk = new Map<number, number[]>()
  for (const i of indices) {
    const c = chunkOf(i)
    const list = byChunk.get(c)
    if (list) list.push(i)
    else byChunk.set(c, [i])
  }
  const chunks = [...byChunk.keys()].sort((a, b) => a - b)
  const order: number[] = []
  const runs: ChunkRun[] = []
  const rnd = xorshift32(seed)
  for (const chunk of chunks) {
    const list = byChunk.get(chunk) as number[]
    // Fisher-Yates, downward, so the draw is uniform over permutations.
    for (let k = list.length - 1; k > 0; k--) {
      const j = Math.floor(rnd() * (k + 1))
      const tmp = list[k] as number
      list[k] = list[j] as number
      list[j] = tmp
    }
    runs.push({ chunk, start: order.length, count: list.length })
    for (const i of list) order.push(i)
  }
  return { order, runs }
}

/** One block copy from the source buffer into the drawn prefix. */
export interface CopySpan {
  /** First instance slot in the SOURCE order. */
  readonly src: number
  /** Where it lands in the drawn prefix. */
  readonly dst: number
  readonly count: number
}

/** What to draw, and what to copy to make it drawable in one call. */
export interface DrawPlan {
  /** `InstancedMesh.count` — the size of the drawn prefix. */
  readonly count: number
  /**
   * The copies, in destination order, adjacent runs already merged.
   *
   * EMPTY when `count` is 0, and empty is not "nothing to do": the caller still
   * has to set `count` to 0, which is what stops the batch drawing at all.
   */
  readonly spans: readonly CopySpan[]
}

/**
 * How many of a run's instances a reveal FRACTION shows.
 *
 * Exact at both ends — 0 shows none and 1 shows all of them, for any count —
 * and `ceil` in between, which is 2016's own `Mathf.CeilToInt(totalObjects *
 * percent)`. The ends have to be exact rather than nearly: a `floor` would
 * leave a fully revealed chunk one prop short for ever, and a chunk whose
 * fraction has rounded to 0.999 would flicker its last tree.
 *
 * A fraction is the unit rather than a count because the reveal state is per
 * CHUNK and a chunk is spread over every palette entry of its pass — 2016 had
 * one pool per chunk holding trees and bushes together. Per batch the same
 * chunk holds a different number of instances, so the thing that transfers is
 * the proportion, not the count.
 */
export const revealedShare = (runCount: number, fraction: number): number => {
  if (!(fraction > 0)) return 0
  if (fraction >= 1) return runCount
  return Math.min(runCount, Math.ceil(runCount * fraction))
}

/**
 * The copy plan for one batch, given how much of each chunk shows.
 *
 * `revealOf` is the chunk's reveal fraction: 0 hides it, 1 shows all of it, and
 * anything between is 2016's staggered reveal mid-transition. A chunk the
 * caller knows nothing about — `undefined` — is treated as FULLY VISIBLE rather
 * than hidden. The safe default is the frame the port drew before this module
 * existed, so a hole in the state costs frame time rather than deleting a
 * forest with nothing on screen to say so.
 *
 * Adjacent spans are merged: `[0,40)` then `[40,12)` becomes `[0,52)`. Chunk
 * ids are row-major and the visible set is a disc, so the merged plan is a
 * handful of whole rows rather than one copy per chunk. That merge is the part
 * with an off-by-one in it, which is why this returns a PLAN — a value a test
 * can read — instead of doing the copying itself.
 */
export const packVisible = (
  runs: readonly ChunkRun[],
  revealOf: (chunk: number) => number | undefined,
): DrawPlan =>
  packRange(runs, (chunk) => {
    const fraction = revealOf(chunk)
    return fraction === undefined ? undefined : [0, fraction]
  })

/**
 * The copy plan for one batch when a chunk may show a SLICE of its run rather
 * than a prefix — DEV-338's rungs.
 *
 * `rangeOf` gives `[from, to)` as fractions of the chunk; `packVisible` is this
 * with `from` 0. Both ends go through `revealedShare`, so two rungs handed
 * `[0, f)` and `[f, 1)` split every run at the SAME slot whatever its count —
 * complementary per batch, not only per chunk, which is the property that
 * keeps a prop from being drawn twice or not at all mid-swap. `undefined` is
 * the whole run, for the reason `packVisible` gives.
 */
export const packRange = (
  runs: readonly ChunkRun[],
  rangeOf: (chunk: number) => readonly [number, number] | undefined,
): DrawPlan => {
  const spans: CopySpan[] = []
  let dst = 0
  for (const run of runs) {
    const range = rangeOf(run.chunk)
    const lo = range === undefined ? 0 : revealedShare(run.count, range[0])
    const hi = range === undefined ? run.count : revealedShare(run.count, range[1])
    const show = hi - lo
    if (show <= 0) continue
    const src = run.start + lo
    const last = spans[spans.length - 1]
    // Mergeable only when BOTH sides abut: the sources have to be contiguous in
    // the source order as well as the destinations. A partly revealed chunk
    // breaks the source side — it stops short of its own run — and must not
    // merge, or the next chunk's copy would start from the middle of it. A
    // slice that starts part-way in breaks it from the other end.
    if (last !== undefined && last.src + last.count === src && last.dst + last.count === dst) {
      spans[spans.length - 1] = { src: last.src, dst: last.dst, count: last.count + show }
    } else {
      spans.push({ src, dst, count: show })
    }
    dst += show
  }
  return { count: dst, spans }
}

/** A chunk of one scatter PASS: every batch's share of it, summed. */
export interface PassChunk {
  readonly chunk: number
  /** Total instances the pass puts in this chunk, across all its batches. */
  readonly total: number
  /** Chunk centre in the pass's own MESH frame, metres. */
  readonly centreX: number
  readonly centreZ: number
  /** Half the chunk's side, metres — for the rungs' nearest-point distance (DEV-338). */
  readonly halfSize: number
}

/**
 * The chunks one scatter PASS occupies, for `initPropLod` / `stepPropLod`.
 *
 * Per pass and not per batch, because the reveal is per chunk and a chunk holds
 * every palette entry at once: run one timer per batch and a chunk's trees
 * would arrive on a different second from its bushes.
 *
 * `expandPlacements` numbers chunks `cz * chunkPerSide + cx` over a grid of
 * `chunkSize` metres from the terrain's CORNER — a `FacetedTerrain`'s transform
 * is the map's corner and there is no centre convention (DEV-042) — so a
 * chunk's centre is `(cx + 0.5) * chunkSize`. Only OCCUPIED chunks are
 * returned: `stepPropLod` walks everything it is handed at 30 Hz, and Simonet's
 * scatter reaches 84 chunks of 256.
 */
export const passChunks = (
  runsPerBatch: readonly (readonly ChunkRun[])[],
  chunkPerSide: number,
  chunkSize: number,
): PassChunk[] => {
  const totals = new Map<number, number>()
  for (const runs of runsPerBatch) {
    for (const run of runs) totals.set(run.chunk, (totals.get(run.chunk) ?? 0) + run.count)
  }
  return [...totals.keys()]
    .sort((a, b) => a - b)
    .map((chunk) => {
      const cx = chunk % chunkPerSide
      const cz = Math.floor(chunk / chunkPerSide)
      return {
        chunk,
        total: totals.get(chunk) as number,
        centreX: (cx + 0.5) * chunkSize,
        centreZ: (cz + 0.5) * chunkSize,
        halfSize: chunkSize / 2,
      }
    })
}
