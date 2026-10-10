// src/sim/props/lod.ts — the prop reveal, ported as POLICY not as mechanism.
//
// ── Is the 2016 technique worth keeping? Yes, three quarters of it ────────
//
// `FacetedTerrainObjectGenerator`'s runtime half (lines 88-259) does four
// things. Three are good ideas that survive the move to three.js, and one is a
// Unity workaround that does not.
//
//   1. HYSTERESIS. A chunk turns ON at `LODDistance * (1 - FlipFlopPercent)`
//      and OFF at `LODDistance * (1 + FlipFlopPercent)`, 0.03 everywhere. A
//      chunk parked exactly on the boundary would otherwise toggle every frame.
//      KEEP — universal, and the terrain LOD already does the same.
//
//   2. HORIZONTAL DISTANCE. `deltaToChunk.y = 0.0f`. Altitude is deliberately
//      ignored, which for a flying game is the whole point: climbing to 400 m
//      must not cull the forest you are looking down at. KEEP, and it is why
//      `horizontalDistance` already exists in the terrain LOD.
//
//   3. THE STAGGERED REVEAL. `Update()` flips `ceil(total * percent)` objects
//      per frame over `LODTransitionTime`, each picked at random from the pool.
//      Trees do not fade and do not pop as a block — they arrive a few at a
//      time, scattered, over about a second. KEEP: this is the look.
//
//   4. THE OBJECT POOLS. Two `List<GameObject>` per chunk, shuffled between by
//      `SetActive`, because 2016 had one GameObject per tree and toggling 1,000
//      of them in a frame is a hitch. DROP. An `InstancedMesh` draws a chunk in
//      one call and reveals a prefix of its buffer by setting `.count`, so the
//      pools solve a problem we do not have.
//
// Dropping (4) is what makes (3) cheap: `shuffleByChunk` in `scatter.ts` puts
// the instances in random order ONCE, so "reveal ceil(total * percent) at
// random" becomes "set count to ceil(total * percent)". Same distribution, no
// per-frame bookkeeping, and the randomness lives in the buffer layout.
//
// ── The 30 Hz check is kept, and it is not a micro-optimisation ───────────
//
// 2016 ran the distance scan in a coroutine at `WaitForSeconds(1/30)` while the
// transition ran every frame. Keeping that split matters more in VR than it did
// on a monitor: the scan is O(chunks) trigonometry that cannot change
// meaningfully inside 33 ms at flying speed, and a 72-90 Hz headset has a much
// smaller frame budget to protect. `scanIntervalSeconds` carries it.
//
// ── RUNGS: the same reveal between two meshes, not only in and out. DEV-338 ─
//
// Matt, 2026-09-24: *"create lods or whatever else you think needs to happen to
// smooth out the current method of either showing a prop or not at all."* The
// scatter was the whole worn VR gap (DEV-263: 8–18 % of frames at 90 Hz with it
// drawn, 96–98 % without), and every prop inside `LODDistance` was drawn at
// full detail — a 1,520-triangle bush 1,200 m away, a handful of pixels.
//
// So a chunk now sits on a RUNG: 0 is the full mesh, higher rungs are coarser
// ones, and OFF is 2016's hidden. Changing rung is **2016's own staggered
// reveal, run between two meshes**: over `transitionSeconds` a shuffled
// `ceil(total * percent)` of the chunk leaves the old rung for the new one, so
// a forest coarsens a few trees at a time and never as a block. Entering from
// OFF and leaving to OFF are the two cases 2016 already had, and they produce
// exactly the numbers they did before rungs existed — with no `rungEdges` there
// is one rung and this file is DEV-225's, which is what Classic runs.
//
// The rung edges are measured to the chunk's NEAREST point, not its centre.
// A 256 m chunk's centre can be 181 m further off than its nearest tree, and a
// rung picked on the centre would draw that tree coarser than its own distance
// calls for. The nearest point makes every edge a promise — no instance on
// rung k is closer than `rungEdges[k - 1]` — at the price of keeping a few more
// far trees fine. The OUTER edge stays on the centre, because it is 2016's
// number measured 2016's way, and moving it would move Classic.
//
// SIM LAYER: pure. No THREE, no clock of its own — `dt` is passed in. The
// caller owns the state array; this returns what changed.

import { horizontalDistance } from '@/sim/terrain/lod'

export interface PropLodParams {
  /** `LODDistance`. Alpine 1280 and 1920, desert 1280, islands 1280. */
  readonly lodDistance: number
  /** `LODTransitionTime`, seconds. 1.0 on every shipped generator. */
  readonly transitionSeconds: number
  /** `FlipFlopPercent`. 0.03 on every shipped generator. */
  readonly hysteresis: number
  /** 2016's coroutine cadence. `1 / 30`. */
  readonly scanIntervalSeconds: number
  /**
   * Where each coarser rung BEGINS, metres to the chunk's nearest point,
   * ascending — DEV-338. `rungEdges[k]` is the edge between rung `k` and rung
   * `k + 1`, so `n` edges make `n + 1` rungs, the last of which runs out to
   * `lodDistance`. Absent or empty is one rung: 2016's reveal and nothing else.
   * The same `hysteresis` applies at every edge.
   */
  readonly rungEdges?: readonly number[]
}

export const PROP_LOD_DEFAULTS: Pick<PropLodParams, 'scanIntervalSeconds'> = {
  scanIntervalSeconds: 1 / 30,
}

/**
 * The rung of a hidden chunk. A sentinel rather than a count of rungs, so that
 * "hidden" does not change meaning when a preset adds a rung.
 */
export const RUNG_OFF = -1

/** Per-chunk reveal state. Mutated in place by `stepPropLod`. */
export interface PropChunkState {
  /** How many props this chunk holds in total. */
  total: number
  /** Chunk centre, world metres. Altitude is not stored — it is not used. */
  centreX: number
  centreZ: number
  /** Half the chunk's side, metres: what turns the centre into a nearest point. */
  halfSize: number
  /** How many are currently drawn, across every rung. */
  revealed: number
  /** Where `revealed` is heading. */
  targetRevealed: number
  /**
   * The rung the chunk is on, or is moving TO while `transitioning`.
   * {@link RUNG_OFF} when hidden or on its way to hidden.
   */
  rung: number
  /** The rung it is leaving. Equal to `rung` while idle. */
  fromRung: number
  /** How many of `total` have arrived on `rung` so far. `total` while idle. */
  moved: number
  /** Seconds into the current transition, or 0 when idle. */
  timer: number
  /** True while a transition is running. */
  transitioning: boolean
}

export interface PropLodRuntime {
  chunks: PropChunkState[]
  /** Seconds since the last distance scan. */
  sinceScan: number
}

/** The chunk inputs `initPropLod` takes. `halfSize` absent is a point chunk. */
export interface PropLodChunkInput {
  readonly total: number
  readonly centreX: number
  readonly centreZ: number
  readonly halfSize?: number
}

/** Horizontal distance to the nearest point of a square chunk. */
const nearestDistance = (x: number, z: number, c: PropChunkState): number =>
  Math.hypot(
    Math.max(Math.abs(x - c.centreX) - c.halfSize, 0),
    Math.max(Math.abs(z - c.centreZ) - c.halfSize, 0),
  )

/** The rung a distance falls on, no hysteresis: the first edge it is inside. */
export const rungAt = (edges: readonly number[], d: number): number => {
  for (let k = 0; k < edges.length; k++) if (d < (edges[k] as number)) return k
  return edges.length
}

/**
 * The rung a SHOWN chunk should be on, with the hysteresis at every edge. It
 * moves out only once past `edge * (1 + h)` and back in only once inside
 * `edge * (1 - h)`, so a chunk parked on an edge does not trade meshes every
 * scan — the same dead band 2016 put on its one edge.
 */
const rungWithHysteresis = (
  edges: readonly number[],
  current: number,
  d: number,
  h: number,
): number => {
  const outward = rungAt(edges, d / (1 + h))
  if (outward > current) return outward
  const inward = rungAt(edges, d / (1 - h))
  if (inward < current) return inward
  return current
}

/** How many a rung assignment draws: every rung but OFF draws the chunk. */
const drawnOn = (c: PropChunkState): number => {
  if (!c.transitioning) return c.rung === RUNG_OFF ? 0 : c.total
  if (c.fromRung === RUNG_OFF) return c.moved
  if (c.rung === RUNG_OFF) return c.total - c.moved
  return c.total
}

/** Build the runtime state. Chunks start at their steady-state visibility. */
export const initPropLod = (
  chunks: readonly PropLodChunkInput[],
  cameraX: number,
  cameraZ: number,
  params: PropLodParams,
): PropLodRuntime => {
  const onAt = params.lodDistance * (1 - params.hysteresis)
  const edges = params.rungEdges ?? []
  return {
    sinceScan: 0,
    chunks: chunks.map((c) => {
      const state: PropChunkState = {
        total: c.total,
        centreX: c.centreX,
        centreZ: c.centreZ,
        halfSize: c.halfSize ?? 0,
        revealed: 0,
        targetRevealed: 0,
        rung: RUNG_OFF,
        fromRung: RUNG_OFF,
        moved: c.total,
        timer: 0,
        transitioning: false,
      }
      // 2016's Start() hides anything beyond the OUTER edge, which leaves a
      // chunk inside the dead band visible on load. Matched deliberately: the
      // band is 3% and the alternative is a visible difference at spawn.
      const visible = horizontalDistance(cameraX, cameraZ, c.centreX, c.centreZ) <= onAt
      if (visible) {
        state.rung = rungAt(edges, nearestDistance(cameraX, cameraZ, state))
        state.fromRung = state.rung
        state.revealed = c.total
        state.targetRevealed = c.total
      }
      return state
    }),
  }
}

/**
 * The share of a chunk one rung draws right now, as `[from, to)` COUNTS into
 * the chunk's shuffled run — DEV-338.
 *
 * The arriving rung takes the FRONT of the run and the leaving rung the rest,
 * so the two are complementary for any `moved` and no prop is ever on both or
 * on neither. A chunk on its way to OFF draws the front of its old rung and
 * shrinks it, which is DEV-225's hide exactly.
 */
export const rungShare = (c: PropChunkState, rung: number): readonly [number, number] => {
  if (!c.transitioning) return c.rung === rung ? [0, c.total] : [0, 0]
  if (c.rung === RUNG_OFF) return c.fromRung === rung ? [0, c.total - c.moved] : [0, 0]
  if (c.rung === rung) return [0, c.moved]
  if (c.fromRung === rung) return [c.moved, c.total]
  return [0, 0]
}

/**
 * Advance one frame.
 *
 * Returns the indices of chunks whose drawn split changed — how many are drawn,
 * or which rung draws them — so the renderer can touch only those
 * `InstancedMesh.count`s instead of walking every chunk.
 */
export const stepPropLod = (
  rt: PropLodRuntime,
  cameraX: number,
  cameraZ: number,
  params: PropLodParams,
  dt: number,
  out: number[] = [],
): number[] => {
  out.length = 0
  const edges = params.rungEdges ?? []

  // ── the slow scan ──────────────────────────────────────────────────────
  rt.sinceScan += dt
  if (rt.sinceScan >= params.scanIntervalSeconds) {
    rt.sinceScan = 0
    const onAt = params.lodDistance * (1 - params.hysteresis)
    const offAt = params.lodDistance * (1 + params.hysteresis)
    for (const c of rt.chunks) {
      // "Only consider idle chunks, otherwise things get complicated" — 2016's
      // own comment, and it is right: retargeting mid-transition makes the
      // reveal reversible and the timer meaningless.
      if (c.transitioning || c.total === 0) continue
      const d = horizontalDistance(cameraX, cameraZ, c.centreX, c.centreZ)
      let want = c.rung
      if (c.rung === RUNG_OFF) {
        if (d < onAt) want = rungAt(edges, nearestDistance(cameraX, cameraZ, c))
      } else if (d > offAt) {
        want = RUNG_OFF
      } else if (edges.length > 0) {
        want = rungWithHysteresis(
          edges,
          c.rung,
          nearestDistance(cameraX, cameraZ, c),
          params.hysteresis,
        )
      } else {
        // No edges is one rung. A chunk left on a coarser one by a preset that
        // HAD edges — a live flip, `?feature=props.meshLod:off` — walks back to
        // the full mesh by the same staggered swap rather than staying coarse.
        want = 0
      }
      if (want === c.rung) continue
      c.fromRung = c.rung
      c.rung = want
      c.moved = 0
      c.targetRevealed = want === RUNG_OFF ? 0 : c.total
      c.transitioning = true
      c.timer = 0
    }
  }

  // ── the per-frame reveal ───────────────────────────────────────────────
  for (let i = 0; i < rt.chunks.length; i++) {
    const c = rt.chunks[i]
    if (c === undefined || !c.transitioning) continue

    c.timer += dt
    const before = c.moved

    if (c.timer >= params.transitionSeconds || params.transitionSeconds <= 0) {
      c.moved = c.total
      c.transitioning = false
      c.fromRung = c.rung
      c.timer = 0
    } else {
      // `Mathf.CeilToInt(totalObjects * percent)` — the count of objects that
      // should be in the TARGET pool by now. Revealing: that is the count
      // shown. Hiding: it is the count hidden, so the shown count is the
      // complement. Changing rung: it is the count on the new mesh.
      const percent = c.timer / params.transitionSeconds
      c.moved = Math.min(c.total, Math.max(0, Math.ceil(c.total * percent)))
    }
    c.revealed = drawnOn(c)

    // `!transitioning` too: a transition that ends in the frame it moved its
    // last prop still has to report, and one that ends having ALREADY moved
    // them all changed which rung the idle chunk answers to.
    if (c.moved !== before || !c.transitioning) out.push(i)
  }

  return out
}
