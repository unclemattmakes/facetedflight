// src/game/cloud-pool.ts: which cloud shape each placement draws, planned.
//
// DEV-785. Matt, 2026-10-07 ("Variant pool"): the sky is instanced, one
// `InstancedMesh` per member of a POOL of unique shapes, and the level's
// placements are distributed over the pool.
//
// `game/clouds.ts`'s old header argued against instancing, and the argument was
// right about the naive version: three shapes drawn nineteen times read as the
// same cloud three times over. The pool is the answer to that argument, not a
// reversal of it: there are as many distinct geometries as the pool allows, and
// a placement only SHARES one when the sky has more clouds than the pool has
// members.
//
// This file is the plan and nothing else: pure, three-free, deterministic. It
// takes the placements and the pool size and says, for every placement, which
// member it draws, in which slot of that member's instance buffer, and how far
// its tint is from the authored colour. Everything is a function of the
// placement list, so two loads of one level build one sky, and nothing reads a
// clock or `Math.random`.
//
// ── Allocation: by demand, not an even split ─────────────────────────────
//
// A sky of 3 shapes x 4 seeds would waste most of its pool on `int_01`, where
// seventeen of nineteen clouds are one shape and the other two appear once
// each. So the pool is shared out by what the placements ask for:
//
//   1. every shape that appears gets one member (a shape never goes missing);
//   2. a member is never created that no placement would draw, so a shape with
//      two placements has at most two members;
//   3. the rest of the pool goes, one member at a time, to the shape whose
//      placements-per-member is highest (ties: the shape that appeared first).
//
// When the pool is at least as big as the sky, every placement owns its member
// and nothing is shared: that is exactly what the port drew before the pool
// existed, geometry for geometry.
//
// ── Ownership keeps the old geometry ─────────────────────────────────────
//
// A member's `ownerIndex` is the placement it was first made for, and the
// renderer seeds its blob from THAT placement's `i`, which is the seed the old
// per-placement mesh used. So a placement that owns a member gets the cloud it
// always had, and only the placements that have to share change geometry.
// Sharers take a member round-robin by their rank within the shape.
//
// ── Tint ─────────────────────────────────────────────────────────────────
//
// An owner is the authored colour. A sharer gets a deterministic offset in
// -1..1 (`tintOf`), which the caller scales by the edition's `tintSpread`: a
// cloud that repeats a neighbour's silhouette is a slightly different value,
// which is most of what the eye uses to decide two things are the same one.

import { type CloudShape, cloudShape } from '@/sim/clouds'
import { fnv1a32 } from '@/sim/math/hash'

/** The slice of a level's `CloudPlacement` the plan reads. */
export interface PoolPlacement {
  readonly i: number
  readonly shape: string | null
}

export interface CloudPoolMember {
  /** The shape the member's blob is generated from (`cloudShape(...)`'s answer). */
  readonly shape: CloudShape
  /** Index INTO THE PLACEMENT ARRAY of the placement this member was made for. */
  readonly ownerIndex: number
  /** Indices into the placement array drawn by this member, in slot order; the owner is slot 0. */
  readonly users: readonly number[]
}

export interface CloudPoolPlan {
  readonly members: readonly CloudPoolMember[]
  /** Per placement (array index): which member draws it. */
  readonly memberOf: readonly number[]
  /** Per placement: its slot in that member's instance buffer. */
  readonly slotOf: readonly number[]
  /**
   * Per placement: a tint offset in -1..1, exactly 0 for an owner.
   * The caller multiplies by the edition's spread, so a spread of 0 is no tint.
   */
  readonly tintOf: readonly number[]
}

/** `fnv1a32`'s range, which is what maps its answer onto 0..1. */
const HASH_RANGE = 0xffffffff

/**
 * Plan the pool.
 *
 * `poolSize` is the edition's tuning value: the TOTAL number of unique
 * geometries the sky may build. Fewer than the number of shapes present is
 * raised to it, because rule 1 (a shape never goes missing) comes first.
 */
export const planCloudPool = (
  placements: readonly PoolPlacement[],
  poolSize: number,
): CloudPoolPlan => {
  // Group by the shape the generator will actually use: two names that both
  // fall back to the workhorse are one shape.
  const groups: { shape: CloudShape; indices: number[] }[] = []
  const groupOf = new Map<CloudShape, number>()
  placements.forEach((placement, index) => {
    const shape = cloudShape(placement.shape)
    let g = groupOf.get(shape)
    if (g === undefined) {
      g = groups.length
      groupOf.set(shape, g)
      groups.push({ shape, indices: [] })
    }
    ;(groups[g] as { indices: number[] }).indices.push(index)
  })

  // ── how many members each shape gets ─────────────────────────────────
  const alloc = groups.map(() => 1)
  const wanted = Math.max(
    groups.length,
    Math.min(Number.isFinite(poolSize) ? Math.floor(poolSize) : 0, placements.length),
  )
  let spare = wanted - groups.length
  while (spare > 0) {
    let best = -1
    let bestLoad = -1
    for (let g = 0; g < groups.length; g++) {
      const n = (groups[g] as { indices: number[] }).indices.length
      const a = alloc[g] as number
      if (a >= n) continue
      const load = n / a
      if (load > bestLoad) {
        bestLoad = load
        best = g
      }
    }
    if (best < 0) break
    alloc[best] = (alloc[best] as number) + 1
    spare--
  }

  // ── which member each placement draws ────────────────────────────────
  const members: { shape: CloudShape; ownerIndex: number; users: number[] }[] = []
  const memberOf = new Array<number>(placements.length).fill(0)
  const slotOf = new Array<number>(placements.length).fill(0)
  const tintOf = new Array<number>(placements.length).fill(0)
  groups.forEach((group, g) => {
    const count = alloc[g] as number
    const first = members.length
    group.indices.forEach((placementIndex, rank) => {
      const m = rank < count ? members.length : first + (rank % count)
      if (rank < count) {
        members.push({ shape: group.shape, ownerIndex: placementIndex, users: [] })
      }
      const member = members[m] as { users: number[] }
      memberOf[placementIndex] = m
      slotOf[placementIndex] = member.users.length
      member.users.push(placementIndex)
      if (rank >= count) {
        const hash = fnv1a32(`cloud-tint:${(placements[placementIndex] as PoolPlacement).i}`)
        tintOf[placementIndex] = (hash / HASH_RANGE) * 2 - 1
      }
    })
  })
  return { members, memberOf, slotOf, tintOf }
}
