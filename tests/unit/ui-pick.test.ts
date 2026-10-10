// tests/unit/ui-pick.test.ts: one ray-to-plane solve for the plates (UI-3).
//
// The pause plate, the room-code plate and the checklist plate each solved "where
// does this ray meet my z = 0" with their own epsilon (1e-6, 1e-6, `dz === 0`),
// the bench door and the TV panel with 1e-9. This file is why choosing ONE is
// safe, and it proves it rather than arguing it:
//
//   - a hit's distance is t = -oz / dz. A ray with |dz| under an epsilon and an
//     eye that is not within a hair of the plane lands more than a million times
//     the eye's distance away, outside every plate; so the epsilons can only
//     disagree about a ray from an eye a MICROMETRE off the plane, grazing it,
//     which no menu can produce.
//   - the sweep below throws 40,000 rays at plausible menu geometry (eyes 0.3 to
//     3 m out, aimed across and beyond a plate, a third of them parallel,
//     near-parallel, or pointing away) and asks all three old solves for a
//     verdict "does it land on a 1.2 m square plate": none differs.
//   - and it shows the claim is not vacuous: the one place they do differ is
//     pinned too, at an eye 1e-7 m off the plane.
//
// The oracles are the OLD inline solves, kept here as the thing the shared one is
// compared against (they are no longer in the code).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { RAY_PARALLEL_EPS, rayPlaneHit, rayToLocal, toPanelLocal } from '@/render/ui-pick'

type Solve = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
) => { x: number; y: number } | null

const oldWithEps =
  (eps: number): Solve =>
  (ox, oy, oz, dx, dy, dz) => {
    if (Math.abs(dz) < eps) return null
    const t = -oz / dz
    if (t <= 0) return null
    return { x: ox + dx * t, y: oy + dy * t }
  }
/** checklist-plate.ts as it was: exactly zero only. */
const oldChecklist: Solve = (ox, oy, oz, dx, dy, dz) => {
  if (dz === 0) return null
  const t = -oz / dz
  if (t <= 0) return null
  return { x: ox + dx * t, y: oy + dy * t }
}

const HALF = 0.6
const lands = (h: { x: number; y: number } | null): boolean =>
  h !== null && Math.abs(h.x) <= HALF && Math.abs(h.y) <= HALF

/** A deterministic LCG, so a failure is the same failure next run. */
const lcg = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('rayToLocal', () => {
  it('hits the plane in front of the eye, in local metres', () => {
    expect(rayToLocal(0, 0, 1, 0, 0, -1)).toEqual({ x: 0, y: 0 })
    expect(rayToLocal(0.1, 0.2, 2, 0, 0, -1)).toEqual({ x: 0.1, y: 0.2 })
    expect(rayToLocal(0, 0, 2, 1, 0, -2)).toEqual({ x: 1, y: 0 })
  })

  it('misses a ray pointing away from the plane and one parallel to it', () => {
    expect(rayToLocal(0, 0, 1, 0, 0, 1)).toBeNull()
    expect(rayToLocal(0, 0, 1, 0, 1, 0)).toBeNull()
    expect(rayToLocal(0, 0, 0, 0, 0, -1)).toBeNull()
  })

  it('a NaN in the depth terms is a miss, not a hit at NaN', () => {
    expect(rayToLocal(0, 0, Number.NaN, 0, 0, -1)).toBeNull()
    expect(rayToLocal(0, 0, 1, 0, 0, Number.NaN)).toBeNull()
  })

  it('the epsilon is a parameter: 1e-9 admits what the default refuses', () => {
    expect(rayToLocal(0, 0, 1e-8, 0, 0, -1e-7)).toBeNull()
    expect(rayToLocal(0, 0, 1e-8, 0, 0, -1e-7, 1e-9)).toEqual({ x: 0, y: 0 })
  })

  it('rayPlaneHit writes into the caller and allocates nothing', () => {
    const out = { x: 9, y: 9 }
    expect(rayPlaneHit(out, 0.5, 0.25, 2, 0, 0, -1)).toBe(true)
    expect(out).toEqual({ x: 0.5, y: 0.25 })
    expect(rayPlaneHit(out, 0, 0, 2, 0, 0, 1)).toBe(false)
    expect(out).toEqual({ x: 0.5, y: 0.25 })
  })
})

describe('one epsilon for every plate', () => {
  it('no verdict differs across the three old solves, for rays at menu geometry', () => {
    const rnd = lcg(20261006)
    const solves = [oldWithEps(1e-6), oldWithEps(1e-9), oldChecklist, rayToLocal]
    let landed = 0
    let disagreements = 0
    for (let i = 0; i < 40_000; i++) {
      // The eye: 0.3 to 3 m out from the plane, a little off its axis.
      const oz = 0.3 + rnd() * 2.7
      const ox = (rnd() - 0.5) * 0.6
      const oy = (rnd() - 0.5) * 0.6
      // Aimed at a point on, or well beyond, a plate's extent.
      const tx = (rnd() - 0.5) * 3
      const ty = (rnd() - 0.5) * 3
      let dx = tx - ox
      let dy = ty - oy
      let dz = -oz
      const kind = i % 6
      if (kind === 1) dz = 0
      else if (kind === 2) dz = (rnd() < 0.5 ? -1 : 1) * 1e-7
      else if (kind === 3) dz = (rnd() < 0.5 ? -1 : 1) * 1e-12
      else if (kind === 4)
        dz = -dz // pointing away
      else if (kind === 5) {
        // a non-unit direction, as a world ray scaled by the plate's own scale
        dx *= 37
        dy *= 37
        dz *= 37
      }
      const verdicts = solves.map((s) => lands(s(ox, oy, oz, dx, dy, dz)))
      if (verdicts.some((v) => v !== verdicts[0])) disagreements++
      if (verdicts[0]) landed++
    }
    expect(disagreements).toBe(0)
    // The sweep is not vacuous: a good share of the rays do land on the plate.
    expect(landed).toBeGreaterThan(2000)
  })

  it('and they DO differ where the argument says: an eye a hair off the plane, grazing it', () => {
    // 1e-7 m off the plane, dz = -1e-7: a hit at t = 1, inside the plate, for 1e-9
    // and `dz === 0`, a miss for 1e-6. The only place the choice is visible.
    const args = [0, 0, 1e-7, 0.1, 0, -1e-7] as const
    expect(oldWithEps(1e-6)(...args)).toBeNull()
    expect(oldWithEps(1e-9)(...args)).not.toBeNull()
    expect(RAY_PARALLEL_EPS).toBe(1e-6)
  })
})

describe('toPanelLocal', () => {
  it('carries a world ray into the plate and refreshes a stale matrix', () => {
    const plate = new THREE.Object3D()
    plate.position.set(0, 0, -2)
    plate.rotation.set(0, 0, 0)
    // Never rendered: matrixWorld is stale (identity) until toPanelLocal refreshes it.
    const o = new THREE.Vector3()
    const d = new THREE.Vector3()
    toPanelLocal(plate, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), o, d)
    expect(o.z).toBeCloseTo(2, 12)
    expect(d.z).toBeCloseTo(-1, 12)
    expect(rayToLocal(o.x, o.y, o.z, d.x, d.y, d.z)).toEqual({ x: 0, y: 0 })
  })

  it('writes a UNIT direction, whatever the plate scale and the ray length', () => {
    const plate = new THREE.Object3D()
    plate.position.set(0, 0, -2)
    plate.scale.setScalar(1.6)
    const o = new THREE.Vector3()
    const d = new THREE.Vector3()
    toPanelLocal(plate, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -37), o, d)
    expect(d.length()).toBeCloseTo(1, 12)
    // The eye is 2 world metres out: 2 / 1.6 plate units.
    expect(o.z).toBeCloseTo(2 / 1.6, 12)
  })
})
