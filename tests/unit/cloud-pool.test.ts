// tests/unit/cloud-pool.test.ts: DEV-785, the cloud variant pool's plan.
//
// Matt, 2026-10-07 ("Variant pool"): the sky is instanced over a pool of unique
// shapes. This file holds the PLAN (`game/cloud-pool.ts`): which member each
// placement draws, in which slot, and how far its tint is from the authored
// colour. `clouds.test.ts` and `cloud-look.test.ts` hold what loadClouds builds
// from it. What is worth asserting here, and against what:
//
//  1. Determinism and coverage: the same placements give the same plan, and
//     every placement is drawn by exactly one member in exactly one slot.
//  2. The allocation follows demand: `int_01`'s seventeen of nineteen clouds
//     are one shape, and an even 4 + 4 + 4 split would give the other two shapes
//     three members that nothing draws.
//  3. A pool at least as big as the sky shares nothing, which is what the port
//     drew before the pool existed; and a placement that owns its member is the
//     one the old per-placement seed belonged to.
//  4. The tint is deterministic, in range, and exactly zero for an owner.

import { describe, expect, it } from 'vitest'
import { type PoolPlacement, planCloudPool } from '@/game/cloud-pool'
import { cloudShape } from '@/sim/clouds'
import adv01 from '../../content/levels/adv_01_jumpSeat.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'

const INT01 = int01.clouds as unknown as PoolPlacement[]
const INT02 = int02.clouds as unknown as PoolPlacement[]
const ADV01 = adv01.clouds as unknown as PoolPlacement[]
const POOL = 12

describe('the plan is deterministic and covers every placement', () => {
  it('gives the same plan twice', () => {
    expect(planCloudPool(INT01, POOL)).toEqual(planCloudPool(INT01, POOL))
  })

  it('draws every placement through exactly one member and one slot', () => {
    for (const level of [INT01, INT02, ADV01]) {
      const plan = planCloudPool(level, POOL)
      const seen = new Set<number>()
      plan.members.forEach((member, m) => {
        member.users.forEach((placementIndex, slot) => {
          expect(seen.has(placementIndex), `placement ${placementIndex} drawn twice`).toBe(false)
          seen.add(placementIndex)
          expect(plan.memberOf[placementIndex]).toBe(m)
          expect(plan.slotOf[placementIndex]).toBe(slot)
        })
      })
      expect(seen.size).toBe(level.length)
      expect(plan.memberOf.length).toBe(level.length)
    }
  })

  it('never makes a member nobody draws, and keeps a member to one shape', () => {
    const plan = planCloudPool(INT01, POOL)
    for (const member of plan.members) {
      expect(member.users.length).toBeGreaterThan(0)
      expect(member.users[0], 'the owner is slot 0').toBe(member.ownerIndex)
      for (const placementIndex of member.users) {
        expect(cloudShape((INT01[placementIndex] as PoolPlacement).shape)).toBe(member.shape)
      }
    }
  })
})

describe('the pool is shared out by demand', () => {
  it('gives int_01 ten members to its seventeen of one shape and one each to the others', () => {
    const plan = planCloudPool(INT01, POOL)
    expect(plan.members.length).toBe(POOL)
    const perShape = new Map<string | null, number>()
    for (const member of plan.members) {
      const key = (INT01[member.ownerIndex] as PoolPlacement).shape
      perShape.set(key, (perShape.get(key) ?? 0) + 1)
    }
    expect(perShape.get('02')).toBe(POOL - 2)
    expect(perShape.get('01')).toBe(1)
    expect(perShape.get('03')).toBe(1)
  })

  it('spreads a shape over its members within one cloud of even', () => {
    const plan = planCloudPool(INT01, POOL)
    const loads = plan.members
      .filter((m) => (INT01[m.ownerIndex] as PoolPlacement).shape === '02')
      .map((m) => m.users.length)
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1)
    expect(loads.reduce((a, b) => a + b, 0)).toBe(17)
  })

  it('never lets a shape go missing, even from a pool smaller than the shape count', () => {
    const plan = planCloudPool(INT01, 1)
    expect(plan.members.length).toBe(3)
    expect(new Set(plan.members.map((m) => m.shape)).size).toBe(3)
  })

  it('treats a shape the generator does not know as the workhorse', () => {
    const plan = planCloudPool(
      [
        { i: 0, shape: '02' },
        { i: 1, shape: 'nonsense' },
        { i: 2, shape: null },
      ],
      POOL,
    )
    expect(new Set(plan.members.map((m) => m.shape)).size).toBe(1)
    expect(plan.members.length).toBe(3)
  })

  it('treats a degenerate pool size as one member per shape', () => {
    for (const size of [0, -3, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(planCloudPool(INT01, size).members.length).toBe(3)
    }
  })

  it('makes an empty sky from no placements', () => {
    const plan = planCloudPool([], POOL)
    expect(plan.members).toEqual([])
    expect(plan.memberOf).toEqual([])
  })
})

describe('a pool as big as the sky shares nothing', () => {
  it('gives every placement of a small sky its own member, with no tint', () => {
    for (const level of [INT02, ADV01]) {
      const plan = planCloudPool(level, POOL)
      expect(plan.members.length).toBe(level.length)
      level.forEach((_, index) => {
        expect(plan.members[plan.memberOf[index] as number]?.ownerIndex).toBe(index)
        expect(plan.slotOf[index]).toBe(0)
        expect(plan.tintOf[index]).toBe(0)
      })
    }
  })

  it('makes twelve distinct owners of int_01, each at slot 0 with no tint', () => {
    // The owners are the placements whose old per-placement seed the member
    // keeps, so everything that does not have to share is the cloud it was.
    const plan = planCloudPool(INT01, POOL)
    const owners = new Set(plan.members.map((m) => m.ownerIndex))
    expect(owners.size).toBe(POOL)
    for (const owner of owners) {
      expect(plan.tintOf[owner]).toBe(0)
      expect(plan.slotOf[owner]).toBe(0)
    }
  })
})

describe('the tint', () => {
  it('is zero for an owner and a deterministic value in range for a sharer', () => {
    const plan = planCloudPool(INT01, POOL)
    const owners = new Set(plan.members.map((m) => m.ownerIndex))
    let sharers = 0
    INT01.forEach((_, index) => {
      const tint = plan.tintOf[index] as number
      if (owners.has(index)) {
        expect(tint).toBe(0)
        return
      }
      sharers++
      expect(tint).toBeGreaterThanOrEqual(-1)
      expect(tint).toBeLessThanOrEqual(1)
      expect(tint, `placement ${index} has no tint, so it repeats its neighbour exactly`).not.toBe(
        0,
      )
    })
    expect(sharers).toBe(INT01.length - POOL)
    // Different sharers differ, or the tint hides nothing.
    const values = INT01.map((_, i) => plan.tintOf[i] as number).filter((t) => t !== 0)
    expect(new Set(values).size).toBe(values.length)
  })
})
