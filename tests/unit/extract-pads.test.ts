// tests/unit/extract-pads.test.ts — the JumpSeat landing pads, and the trap in
// their geometry.
//
// A pad's `scale` is the instance transform, and it is a MULTIPLIER rather than
// an extent: eleven pads ship at scale 1 and the largest at 18.6, while the
// volume the player has to hit runs from 28.4 m to 527 m. So reading `scale` as
// a size gives a plausible-looking number that is 28 times too small — the same
// mistake `FinishGate` documents one prefab layer down, and the reason `pads`
// carries `landing` / `refuel` / `zones` at all.
//
// ── Why every assertion here is a DISTANCE or a RATIO ────────────────────
//
// `docs/DEVIATIONS.md`, the orientation lesson: test the geometry, not the
// numbers you believed. A quaternion assertion is a belief written twice; "the
// bullseye sits inside the landing volume" is true whatever anyone believed
// about the composition, and false if the scale, the rotation, the collider
// centre or the parent chain went in wrong.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Pad, PadVolume } from '@/content/level-schema'
import { levelJson as level } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'

const LEVELS = path.join(ROOT, 'content', 'levels')

/** The six missions that carry pads, and what each places. */
const PAD_MISSIONS: [string, number][] = [
  ['rookie_01_jumpSeat', 5],
  ['rookie_02_jumpSeat', 11],
  ['int_01_jumpSeat', 7],
  ['int_02_jumpSeat', 11],
  ['adv_01_jumpSeat', 10],
  ['adv_02_jumpSeat', 13],
]

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0))

const allPads = (): Pad[] => PAD_MISSIONS.flatMap(([id]) => level(id).pads)

describe('jump pads', () => {
  it('are placed on exactly six missions, and on none of the HoverJet ones', () => {
    const withPads = fs
      .readdirSync(LEVELS)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.replace(/\.json$/, ''))
      .filter((id) => level(id).pads.length > 0)
      .sort()
    expect(withPads).toEqual(PAD_MISSIONS.map(([id]) => id).sort())
    for (const [id, n] of PAD_MISSIONS) expect(level(id).pads.length, id).toBe(n)
  })

  it('every pad carries its trigger volumes — 1 landing, 1 refuel, 17 scoring', () => {
    // A pad the game cannot detect a hit on is not content, and a reader that
    // found no interior looks exactly like a pad with no triggers. Uniform 19
    // is what says the read worked on all 57 of them, including the four dead
    // ones and the three pairs of identically-named siblings in
    // `int_02_jumpSeat` that a path-keyed lookup merged into 34 apiece.
    for (const p of allPads()) {
      expect(p.landing, p.name).toBeTruthy()
      expect(p.refuel, p.name).toBeTruthy()
      expect(p.zones.length, p.name).toBe(17)
      expect(p.zones.filter((z) => /trigger_bullseye/.test(z.path)).length).toBe(1)
      expect(p.zones.filter((z) => /trigger_mid_section/.test(z.path)).length).toBe(8)
      expect(p.zones.filter((z) => /trigger_large_section/.test(z.path)).length).toBe(8)
    }
  })

  it('the landing volume is a SPHERE, because Unity clamped the capsule away', () => {
    // r 0.951 x 29.83 = 28.4 m against h 0.5 x 21.1 = 10.6 m, so the cylinder
    // has no length at all and `height` is just `2 * radius`. A port that draws
    // a tall capsule draws something the 2016 physics never had.
    for (const p of allPads()) {
      const landing = p.landing as NonNullable<Pad['landing']>
      expect(landing.kind).toBe('capsule')
      expect(landing.axis).toBe('y')
      expect(landing.degenerateToSphere, p.name).toBe(true)
      // 3 dp, not 6: both numbers are rounded to 1e-6 on the way out, so an
      // exact-to-6dp assertion fails on rounding rather than on geometry.
      expect(landing.height).toBeCloseTo(landing.radius * 2, 3)
      // And the refuel volume is the same shape, smaller, and inside it.
      const refuel = p.refuel as NonNullable<Pad['refuel']>
      expect(refuel.radius).toBeLessThan(landing.radius)
      expect(dist(refuel.pos, landing.pos)).toBeLessThan(landing.radius)
    }
  })

  it('the transform scale understates the landing volume by a factor of 28', () => {
    // The whole point of extracting the colliders — and the first version of
    // this assertion was written the lazy way, "the radius is nowhere near the
    // scale", which passed on the big pads and failed on the eleven that are
    // placed at scale 1. Measured instead: the ratio is a single prefab
    // constant, 28.3695, because the trigger's own local scale (29.83) and its
    // collider radius (0.951) multiply the instance's. So `scale` is not a
    // wrong-looking extent, it is a right-looking one — 1 m or 18.6 m, against
    // a real hit volume of 28.4 m to 527 m. That is the shape of this trap.
    const ratios = allPads().map(
      (p) => (p.landing as NonNullable<Pad['landing']>).radius / Math.max(...p.scale.map(Math.abs)),
    )
    const first = ratios[0] ?? 0
    for (const r of ratios) expect(r).toBeCloseTo(first, 3)
    expect(first).toBeGreaterThan(25)
    // And the scales really do vary, so the constant above is not an artefact
    // of every pad being placed the same way.
    const scales = allPads().map((p) => Math.max(...p.scale.map(Math.abs)))
    expect(Math.max(...scales) / Math.min(...scales)).toBeGreaterThan(10)
  })

  it('the scoring rings sit on the pad, not somewhere else in the world', () => {
    // The composition check, and the one that catches a wrong parent chain or a
    // collider centre that was scaled but not rotated. Every zone's centre is
    // within a few landing radii of the pad origin; a pad whose interior was
    // composed against the wrong root lands kilometres away.
    for (const p of allPads()) {
      const landing = p.landing as NonNullable<Pad['landing']>
      for (const z of p.zones) {
        expect(dist(z.pos, p.pos), `${p.name} / ${z.path}`).toBeLessThan(landing.radius * 4)
      }
      // The bullseye specifically is the middle of the target, so it is inside
      // the landing volume rather than merely near it.
      const bull = p.zones.find((z) => /trigger_bullseye/.test(z.path)) as PadVolume
      expect(dist(bull.pos, landing.pos), `${p.name} bullseye`).toBeLessThan(landing.radius)
    }
  })

  it('every volume is a real volume — no zero or negative extents', () => {
    for (const p of allPads()) {
      for (const v of [p.landing, p.refuel, ...p.zones].filter(Boolean) as PadVolume[]) {
        if (v.kind === 'box')
          for (const h of v.half) expect(h, `${p.name}/${v.path}`).toBeGreaterThan(0)
        else expect(v.radius, `${p.name}/${v.path}`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps dead pads, with their volumes, rather than filtering them out', () => {
    // `rookie_02_jumpSeat` places 11 and hangs four of them under a GameObject
    // called `GameObject` with `m_IsActive: 0`. Seven are reachable. The dead
    // four are data — they say where the level designer stopped — and they must
    // never be silently dropped, or a future count disagrees with the scene.
    const r02 = level('rookie_02_jumpSeat').pads
    expect(r02.length).toBe(11)
    expect(r02.filter((p) => p.live).length).toBe(7)
    for (const p of r02.filter((x) => !x.live)) expect(p.zones.length).toBe(17)
  })
})
