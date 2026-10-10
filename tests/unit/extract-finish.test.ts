// tests/unit/extract-finish.test.ts — what ends a run, and what starts one.
//
// Three claims the extractor used to get wrong, all in the same shape: it read
// one place, the answer lived somewhere else, and "nothing there" came back
// indistinguishable from "nothing to find". The ledger entry for the countdown
// is DEV-048; the other two were found in the same session.
//
//   finish     null on all six. The gate is `Trigger_Finish_JumpSeat` inside
//              `target_jumppad.prefab`, authored INACTIVE, switched on by an
//              `m_IsActive` override on exactly one pad instance per mission.
//              `adv_02_jumpSeat` serialises 26 of them and one is live.
//
//   launchKind `elevator` on two of the six, because the SCENE contains a
//              `LaunchElevator`. Riding one is a property of the SHIP:
//              `StartLaunch()` has three call sites, all in `Input_Ship*.cs`,
//              and the JumpSeat carries none of them.
//
// Every assertion below is a measured relation rather than a remembered number
// where one is available — the gate sits on a live pad, the hull's box is the
// FBX's box times the transform, the ship's component set decides the launch.

import { describe, expect, it } from 'vitest'
import type { FinishGateConvexMesh } from '@/content/level-schema'
import { shippedLevelIds as ids, levelJson as level } from './helpers/content'

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0))

/** `_meta` is provenance the runtime types do not describe. */
type FinishMeta = {
  originPos: number[]
  meshLocalSize: number[]
  worldScale: number[]
  meshImportScale: { scale: number; globalScale: number; useFileScale: boolean; fileScale: number }
}
const meta = (g: FinishGateConvexMesh): FinishMeta => (g as unknown as { _meta: FinishMeta })._meta

describe('the gate that ends a run', () => {
  it('exists on every one of the thirteen shipped missions', () => {
    // It did not, for six of them, for the whole life of the port.
    for (const id of ids()) expect(level(id).finish, id).toBeTruthy()
  })

  it('is a sphere union on a HoverJet mission and a convex mesh on a JumpSeat one', () => {
    const byShape: Record<string, string[]> = {}
    for (const id of ids()) {
      const L = level(id)
      const shape = (L.finish as { shape: string }).shape
      const list = byShape[shape] ?? []
      list.push(L.vehicle)
      byShape[shape] = list
    }
    expect(byShape.sphereUnion?.every((v) => v === 'hoverjet')).toBe(true)
    expect(byShape.convexMesh?.every((v) => v === 'jumpseat')).toBe(true)
    expect(byShape.sphereUnion).toHaveLength(7)
    expect(byShape.convexMesh).toHaveLength(6)
  })

  it('leaves the HoverJet gate exactly as it was — 68.59 m, three spheres', () => {
    for (const id of ids()) {
      const f = level(id).finish
      if (f?.shape !== 'sphereUnion') continue
      expect(f.radius, id).toBeCloseTo(68.59, 2)
      expect(f.spheres, id).toHaveLength(3)
    }
  })
})

describe('the JumpSeat gate', () => {
  const jumpSeatGates = (): [string, FinishGateConvexMesh][] =>
    ids()
      .map((id) => [id, level(id).finish] as const)
      .filter((e): e is [string, FinishGateConvexMesh] => e[1]?.shape === 'convexMesh')
      .map(([id, f]) => [id, f])

  it('is the same 30.345 x 5.653 x 28.860 m slab on all six', () => {
    // Same prefab, same transform scale in every mission — so a difference here
    // would mean the reader picked up something else.
    for (const [id, f] of jumpSeatGates()) {
      const size = f.half.map((h) => h * 2)
      expect(size[0], id).toBeCloseTo(30.345, 3)
      expect(size[1], id).toBeCloseTo(5.653, 3)
      expect(size[2], id).toBeCloseTo(28.86, 3)
      expect(f.mesh).toMatch(/hexTile\.fbx$/)
      expect(f.convex).toBe(true)
    }
  })

  it('gets that size from the FBX times the transform, at Unity`s own import scale', () => {
    // The arithmetic the size depends on, checked rather than believed:
    // hexTile's file AABB is 19.021 x 5.000 x 18.090 at an import scale of
    // 0.01 (a centimetre file) x globalScale 10 = 0.1, and the collider's
    // transform scale is (15.95, 11.31, 15.95). Miss the 0.1 and the gate is a
    // 303 m slab — ten times wrong, which on this geometry looks like a bug in
    // something else entirely.
    for (const [id, f] of jumpSeatGates()) {
      const m = meta(f)
      expect(m.meshImportScale.scale, id).toBeCloseTo(0.1, 9)
      expect(m.meshImportScale.fileScale * m.meshImportScale.globalScale).toBeCloseTo(0.1, 9)
      for (let a = 0; a < 3; a++) {
        // meshLocalSize is ALREADY at import scale; the transform does the rest.
        expect((m.meshLocalSize[a] as number) * Math.abs(m.worldScale[a] as number)).toBeCloseTo(
          (f.half[a] as number) * 2,
          4,
        )
      }
    }
  })

  it('is centred on the COLLIDER, not on the GameObject', () => {
    // `hexTile`'s bounds are not centred on its origin (centre y 2.53, z 0.955
    // in file units), so the two are 3.24 m apart. Emitting the GameObject's
    // position as the gate would put a 5.7 m-thick slab most of its own
    // thickness out of place — small enough to look like nothing.
    for (const [id, f] of jumpSeatGates()) {
      expect(dist(f.pos, meta(f).originPos), id).toBeCloseTo(3.24, 2)
    }
  })

  it('sits on exactly one pad, and that pad is live', () => {
    // The relation that proves the composition: the gate is a child of a pad
    // instance, so it must land inside that pad's landing volume and no other.
    // A gate composed against the wrong root would be kilometres away, and a
    // gate on a dead pad would mean the liveness override was read off the
    // wrong instance.
    for (const [id, f] of jumpSeatGates()) {
      const L = level(id)
      const inside = L.pads.filter(
        (p) => p.landing && dist(f.pos, p.pos) < (p.landing as { radius: number }).radius,
      )
      expect(inside, `${id}: pads containing the finish gate`).toHaveLength(1)
      expect(inside[0]?.live, id).toBe(true)
      expect(dist(f.pos, inside[0]?.pos ?? [0, 0, 0]), id).toBeLessThan(5)
    }
  })

  it('carries the real convex hull, in the same frame as `half`', () => {
    // A first draft compared a WORLD-space hull against `half` and failed on
    // `adv_01_jumpSeat` by 11 cm — the one mission whose pad carries a yaw, and
    // an error small enough to have been waved off as rounding on any of the
    // other five. `hull` is now local like `spheres[].center`, so the two
    // describe one box and this assertion means something.
    for (const [id, f] of jumpSeatGates()) {
      expect(f.hull, id).toHaveLength(10)
      const lo = [0, 1, 2].map((a) => Math.min(...f.hull.map((v) => v[a] as number)))
      const hi = [0, 1, 2].map((a) => Math.max(...f.hull.map((v) => v[a] as number)))
      for (let a = 0; a < 3; a++) {
        expect(((hi[a] as number) - (lo[a] as number)) / 2, `${id} axis ${a}`).toBeCloseTo(
          f.half[a] as number,
          3,
        )
        // Local means centred, because `pos` already carries the offset.
        expect(((hi[a] as number) + (lo[a] as number)) / 2, `${id} centre ${a}`).toBeCloseTo(0, 3)
      }
      // `radius` is the bounding SPHERE and must be bigger than every half
      // extent — it is a broad phase, deliberately not the gate.
      for (const h of f.half) expect(f.radius).toBeGreaterThan(h)
    }
  })
})

describe('how a mission starts', () => {
  it('decides the launch from the SHIP`s components, not from the scene', () => {
    for (const id of ids()) {
      const L = level(id)
      const trace = L.spawn.launchTrace
      expect(trace, id).toBeTruthy()
      if (!trace) continue
      // The scan found the call sites at all — an empty list would silently
      // turn every mission into a direct start.
      expect(trace.starterScriptsInProject.length, id).toBeGreaterThan(0)
      // And the verdict follows from the intersection, nothing else.
      expect(trace.canStartElevator, id).toBe(trace.starterScriptsOnShip.length > 0)
      expect(L.spawn.launchKind, id).toBe(trace.canStartElevator ? 'elevator' : 'direct')
      expect(!!L.spawn.launch, id).toBe(trace.canStartElevator)
    }
  })

  it('gives the JumpSeat a Trigger_EnableJumpShip instead of an elevator ride', () => {
    for (const id of ids()) {
      const L = level(id)
      if (L.vehicle !== 'jumpseat') continue
      expect(L.spawn.launchKind, id).toBe('direct')
      expect(L.spawn.launch, id).toBeNull()
      // `Trigger_EnableShip` is guarded on `Ship_HoverShip`, which the JumpSeat
      // does not have, so both of its fields describe something that cannot
      // happen — null here means impossible, not unread.
      expect(L.spawn.launchTrace?.enableShipApplies, id).toBe(false)
      expect(L.spawn.enableGravityOnLaunch ?? null, id).toBeNull()
      expect(L.spawn.enableShipDelay ?? null, id).toBeNull()
      const js = L.spawn.jumpStart
      expect(js, id).toBeTruthy()
      if (!js) continue
      expect(js.seconds, id).toBeCloseTo(js.triggerDelay + js.countdownSteps, 6)
      expect(js.seconds, id).toBeCloseTo(7.5, 6)
    }
  })

  it('still gives every HoverJet mission its elevator', () => {
    for (const id of ids()) {
      const L = level(id)
      if (L.vehicle !== 'hoverjet') continue
      expect(L.spawn.launchKind, id).toBe('elevator')
      expect(L.spawn.launch?.rise, id).toBeCloseTo(106.647, 3)
      expect(L.spawn.jumpStart ?? null, id).toBeNull()
    }
  })
})

/**
 * DEV-048: the countdown 2016 was thought never to have run.
 *
 * `Timer_Race.useCountdown` is 0 on all thirteen missions, and the port read
 * that one flag and concluded the feature was switched off — DEV-015 then
 * turned it on as a deviation. The flag gates exactly one caller. The one that
 * matters is `Trigger_EnableShip.DelayedEnable()`, which calls the public
 * `StartCountdown()` after its own `delay` and never looks at the flag.
 *
 * These pin the DISAGREEMENT rather than the conclusion, because the
 * disagreement is the finding: a single boolean is what hid it for a year.
 */
describe('the race countdown', () => {
  it('records the flag and the behaviour separately, and they disagree', () => {
    for (const id of ids()) {
      const c = level(id).timer.countdown
      expect(c, id).toBeTruthy()
      if (!c) continue
      // The flag really is off everywhere. That part of the old claim was true.
      expect(c.useCountdownFlag, id).toBe(false)
      // And `shipped` is derived, not re-read.
      expect(c.shipped, id).toBe(c.useCountdownFlag || c.startedByTrigger)
      // A trigger implies a delay, and no trigger implies none.
      expect(c.triggerDelay !== null, id).toBe(c.startedByTrigger)
    }
  })

  it('runs in seven of the thirteen — six HoverJet missions and one JumpSeat', () => {
    const running = ids().filter((id) => level(id).timer.countdown?.shipped)
    expect(running.sort()).toEqual(
      [
        'adv_01_hoverJet',
        'adv_02_hoverJet',
        'hoverJet_kauai_beg',
        'int_01_hoverJet',
        'int_01_jumpSeat',
        'int_02_hoverJet',
        'rookie_02_hoverJet',
      ].sort(),
    )
    // `rookie_01_hoverJet` is the HoverJet mission with no Trigger_EnableShip at
    // all — the case a single `useCountdown` flag could never have distinguished
    // from the other six, since the flag reads 0 on every one of them.
    expect(level('rookie_01_hoverJet').timer.countdown?.startedByTrigger).toBe(false)
    // And `int_01_jumpSeat` runs one because it places the HoverJet's entire
    // elevator shaft, trigger included, around a ship that cannot ride it.
    expect(level('int_01_jumpSeat').timer.countdown?.startedByTrigger).toBe(true)
  })

  it('keeps 2016`s own timing — four beats of one second, not the C# 0.5', () => {
    for (const id of ids()) {
      const c = level(id).timer.countdown
      if (!c) continue
      expect(c.steps, id).toBe(3)
      expect(c.stepSeconds, id).toBe(1)
      // GO fires on the beat AFTER the last number, so 3-2-1-GO is four beats.
      expect(c.seconds, id).toBe((c.steps + 1) * c.stepSeconds)
    }
  })
})
