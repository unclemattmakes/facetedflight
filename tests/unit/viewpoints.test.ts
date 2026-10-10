// tests/unit/viewpoints.test.ts — cameras that point where they claim to.
//
// A viewpoint aimed at where the sun used to be is worse than no viewpoint: it
// produces a plausible screenshot of the wrong thing, and you believe it.

import { describe, expect, it } from 'vitest'
import { INT01_SUN_BEARING, parseTriple, resolveViewpoint, VIEWPOINTS } from '@/boot/viewpoints'
import int01 from '../../content/levels/int_01_hoverJet.json'

describe('the sun bearing', () => {
  it("is the level's own sun, negated", () => {
    // `lighting.sun.direction` is where the light TRAVELS, so the sun is at
    // minus it. Written out in `viewpoints.ts` for readability and checked here
    // so it cannot drift from the mission it describes.
    const d = int01.lighting.sun.direction as number[]
    expect(INT01_SUN_BEARING[0]).toBeCloseTo(-(d[0] as number), 6)
    expect(INT01_SUN_BEARING[1]).toBeCloseTo(-(d[1] as number), 6)
    expect(INT01_SUN_BEARING[2]).toBeCloseTo(-(d[2] as number), 6)
  })

  it('is four degrees above the horizon, which is why aiming matters', () => {
    const up = INT01_SUN_BEARING[1]
    expect((Math.asin(up) * 180) / Math.PI).toBeCloseTo(4, 0)
  })
})

describe('the viewpoints', () => {
  const SEA_LEVEL = 116.6

  it('put every water camera ABOVE the sea', () => {
    // The first `water-glint` was at y = 40 — 76 m underwater — and came back a
    // full-frame mess of dithering. The sea is at 116.6, not at zero, because
    // the ocean is its own terrain with its own transform.
    for (const [name, vp] of Object.entries(VIEWPOINTS)) {
      if (!name.startsWith('water-')) continue
      expect(vp.eye[1], `${name} eye`).toBeGreaterThan(SEA_LEVEL)
    }
  })

  it('aims water-glint along the sun bearing and water-away against it', () => {
    // The control only controls if it actually faces the other way.
    const bearing = (name: string) => {
      const vp = VIEWPOINTS[name]
      if (!vp) throw new Error(name)
      const dx = vp.look[0] - vp.eye[0]
      const dy = vp.look[1] - vp.eye[1]
      const dz = vp.look[2] - vp.eye[2]
      const len = Math.hypot(dx, dy, dz)
      return [dx / len, dy / len, dz / len]
    }
    const dot = (a: number[]) =>
      (a[0] as number) * INT01_SUN_BEARING[0] +
      (a[1] as number) * INT01_SUN_BEARING[1] +
      (a[2] as number) * INT01_SUN_BEARING[2]
    expect(dot(bearing('water-glint'))).toBeGreaterThan(0.95)
    expect(dot(bearing('water-away'))).toBeLessThan(-0.95)
  })

  it('gives every viewpoint a note, because the note IS the point', () => {
    for (const [name, vp] of Object.entries(VIEWPOINTS)) {
      expect(vp.note.length, name).toBeGreaterThan(10)
    }
  })
})

describe('resolving', () => {
  const q = (s: string) => new URLSearchParams(s)

  it('prefers explicit coordinates over a name', () => {
    const vp = resolveViewpoint(q('cam=water-glint&eye=1,2,3&look=4,5,6'))
    expect(vp?.eye).toEqual([1, 2, 3])
    expect(vp?.note).toBe('ad hoc')
  })

  it('returns null for no camera and for an unknown name', () => {
    expect(resolveViewpoint(q(''))).toBeNull()
    expect(resolveViewpoint(q('cam=nope'))).toBeNull()
  })

  it('rejects a malformed triple rather than half-reading it', () => {
    expect(parseTriple('1,2')).toBeNull()
    expect(parseTriple('1,2,x')).toBeNull()
    expect(parseTriple('1, 2, 3')).toEqual([1, 2, 3])
  })
})
