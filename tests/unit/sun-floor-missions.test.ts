// Which shipped missions' suns sit under the far-shadow march's floor (DEV-495),
// and that every one of them is MARCHED (DEV-527).
//
// `sim/terrain/sun-height.ts` marches no sun lower than `MIN_SUN_HEIGHT_SIN`.
// Until DEV-527 a sun under it baked a degenerate field, lit everywhere; its
// comment said the lowest shipped sun was 4°, and nothing checked it, so
// `int_02_hoverJet`'s 0.083° sun had no far field for the life of the port
// before DEV-453 noticed. Matt's call on DEV-495 was option C: march it AT the
// floor, on its own heading. This derives the list from the level JSON, the
// extracted truth (hard rule 3), so a second mission under the floor turns this
// red and somebody reads the comment it would falsify — and decides whether
// the lift is right for that sun too.
//
// The elevation is read from `lighting.sun.direction` (where light TRAVELS,
// so `-y` is the sine the march compares), not from `elevationDeg`, because
// that is what the march is handed.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { towardSunSim } from '@/render/far-shadow'
import type { HeightField } from '@/sim/terrain/height-field'
import { buildSunHeight, MIN_SUN_HEIGHT_SIN } from '@/sim/terrain/sun-height'

const LEVELS = 'content/levels'

const suns = (): { id: string; sin: number; direction: number[] }[] =>
  fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      const level = JSON.parse(fs.readFileSync(`${LEVELS}/${f}`, 'utf8'))
      const d = level.lighting.sun.direction as number[]
      return { id: level.id as string, sin: -(d[1] as number) / Math.hypot(...d), direction: d }
    })

/** A small bumpy field: enough to show a sun is marched, with no maps (so CI runs it). */
const bumps = (): HeightField => {
  const n = 17
  const heights = new Float32Array(n * n)
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++)
      heights[z * n + x] = 0.5 + 0.4 * Math.sin(x * 0.7) * Math.cos(z * 0.5)
  }
  return {
    heights,
    vertPerSide: n,
    terrainSize: (n - 1) * 8,
    terrainHeight: 100,
    step: 8,
    originX: 0,
    originY: 0,
    originZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }
}

describe('shipped suns under the far-shadow floor', () => {
  it('reads every shipped mission', () => {
    // A sweep that found nothing would pass the assertion below vacuously.
    expect(suns().length).toBeGreaterThan(10)
  })

  it('is int_02_hoverJet alone', () => {
    const under = suns()
      .filter((s) => s.sin < MIN_SUN_HEIGHT_SIN)
      .map((s) => s.id)
    expect(under).toEqual(['int_02_hoverJet'])
  })

  it('the next lowest is 4°, which the march takes', () => {
    const above = suns()
      .filter((s) => s.sin >= MIN_SUN_HEIGHT_SIN)
      .map((s) => (Math.asin(s.sin) * 180) / Math.PI)
    expect(Math.min(...above)).toBeCloseTo(4, 2)
  })

  it('every shipped sun is marched, int_02 lifted to the floor and no other (DEV-527)', () => {
    const f = bumps()
    const lifted: string[] = []
    for (const s of suns()) {
      const sh = buildSunHeight(f, towardSunSim(s.direction))
      expect(sh.degenerate, s.id).toBe(false)
      if (sh.marchedSun.some((c, i) => c !== sh.towardSun[i])) {
        lifted.push(s.id)
        expect(sh.marchedSun[1], s.id).toBe(MIN_SUN_HEIGHT_SIN)
      }
    }
    expect(lifted).toEqual(['int_02_hoverJet'])
  })
})
