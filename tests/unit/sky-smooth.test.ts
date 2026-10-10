// tests/unit/sky-smooth.test.ts — the smooth sky is the SAME sky, interpolated.
//
// DEV-320, wishlist #22a: *"toggle the faceted sky."* `render.smoothSky` re-bakes
// the dome with one colour per VERTEX instead of per face. What this holds is
// the geometry of that claim rather than any colour value:
//
//   * FACETED: every face's three vertices carry one colour — the dome is flat
//     polygons, ART_DIRECTION pillar 2.
//   * SMOOTH: every copy of a shared vertex carries one colour, so adjacent
//     faces meet without a step — and the faces are not flat any more.
//   * BOTH: the same mesh (so the draw order, the layer and the census cannot
//     move), the same sun cap, and the same sky on average — the ±6 % cell
//     variation averages out, which is the premise of re-prefiltering the
//     environment from whichever dome is drawn.
//
// What it cannot see is the PICTURE — whether the flag reaches a mission, and
// whether the world is still drawn around it. DEV-307 went dead once under a
// green unit test; `tests/e2e/smooth-sky.spec.ts` photographs both.

import { describe, expect, it } from 'vitest'
import { SKY_TUNING, SUN_CAP_TRIANGLES, skyBaker } from '@/render/sky'
import int01 from '../../content/levels/int_01_hoverJet.json'

const sun = int01.lighting.sun
const baker = skyBaker({
  sunDirection: sun.direction as [number, number, number],
  sunColor: sun.colorLinear as [number, number, number],
  horizonColor: [int01.fog.color[0], int01.fog.color[1], int01.fog.color[2]] as [
    number,
    number,
    number,
  ],
  skySh: int01.lighting.sky.sh,
})

const faceted = baker.bake({ ...SKY_TUNING, smooth: false })
const smooth = baker.bake({ ...SKY_TUNING, smooth: true })

const array = (g: typeof faceted, name: string): Float32Array =>
  g.getAttribute(name).array as Float32Array

/** Vertices that belong to the dome proper; the sun cap follows them. */
const domeVertices = (g: typeof faceted): number =>
  array(g, 'position').length / 3 - SUN_CAP_TRIANGLES * 3

const colourAt = (c: Float32Array, v: number): string =>
  `${c[v * 3]},${c[v * 3 + 1]},${c[v * 3 + 2]}`

describe('the smooth sky (DEV-320)', () => {
  it('is baked from the mission’s own sky, not the fallback gradient', () => {
    // The premise of every assertion below being about the SHIPPED sky.
    expect(baker.usedExtractedSky).toBe(true)
  })

  it('keeps the mesh: same vertex count, same positions', () => {
    expect(array(smooth, 'position')).toEqual(array(faceted, 'position'))
  })

  it('faceted: every dome face is one colour', () => {
    const c = array(faceted, 'color')
    const n = domeVertices(faceted)
    expect(n).toBeGreaterThan(0)
    for (let v = 0; v < n; v += 3) {
      expect(colourAt(c, v + 1)).toBe(colourAt(c, v))
      expect(colourAt(c, v + 2)).toBe(colourAt(c, v))
    }
  })

  it('smooth: every copy of a shared vertex is one colour, and the faces are not flat', () => {
    const p = array(smooth, 'position')
    const c = array(smooth, 'color')
    const n = domeVertices(smooth)
    const seen = new Map<string, string>()
    let shared = 0
    for (let v = 0; v < n; v++) {
      const key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`
      const colour = colourAt(c, v)
      const before = seen.get(key)
      if (before === undefined) seen.set(key, colour)
      else {
        shared++
        expect(colour).toBe(before)
      }
    }
    // An icosphere shares every vertex between five or six faces, so almost
    // every copy has a twin. Zero would mean the key never matched and the
    // loop above asserted nothing.
    expect(shared).toBeGreaterThan(n / 2)

    let flat = 0
    for (let v = 0; v < n; v += 3) {
      if (colourAt(c, v) === colourAt(c, v + 1) && colourAt(c, v) === colourAt(c, v + 2)) flat++
    }
    expect(flat / (n / 3)).toBeLessThan(0.01)
  })

  it('does not touch the sun cap', () => {
    const n = domeVertices(faceted)
    expect(array(smooth, 'color').subarray(n * 3)).toEqual(array(faceted, 'color').subarray(n * 3))
  })

  it('is the same sky on average, so the prefilter that lights the world barely moves', () => {
    const mean = (g: typeof faceted): [number, number, number] => {
      const c = array(g, 'color')
      const n = domeVertices(g)
      const sum = [0, 0, 0]
      for (let v = 0; v < n; v++) {
        for (let k = 0; k < 3; k++) sum[k] = (sum[k] as number) + (c[v * 3 + k] as number)
      }
      return sum.map((s) => s / n) as [number, number, number]
    }
    const a = mean(faceted)
    const b = mean(smooth)
    for (let k = 0; k < 3; k++) {
      expect(Math.abs((b[k] as number) / (a[k] as number) - 1)).toBeLessThan(0.01)
    }
  })
})
