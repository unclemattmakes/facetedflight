// tests/unit/canopy.test.ts — the forest floor is darker than the field.
//
// DEV-295, wishlist #13. The claims are about the SHAPE of the field rather
// than about any texel's value, because the values are art and the shape is
// the feature: a lone prop is nearly nothing, a thicket is dark, and the
// difference between them is the whole of what Matt asked for.
//
// The one thing a unit test cannot check is the FRAME — whether the mesh-space
// positions the caller hands in are the space the grid runs over. That is what
// `buildCanopyField`'s `counted` receipt is for and what the e2e measures on a
// real world; a synthetic sweep agrees with itself by construction.

import { describe, expect, it } from 'vitest'
import { buildCanopyField, CANOPY_OFF, type CanopyProp, type CanopySpec } from '@/sim/props/canopy'

/** Alpine's own: an 8 m quad, 4,096 m across. */
const GRID = { vertPerSide: 513, step: 8, originY: 0 } as const
const SPEC: CanopySpec = { radiusScale: 1.6, saturation: 6, strength: 0.55 }

const tree = (x: number, z: number, width = 12, scale = 1, height = 14): CanopyProp => ({
  x,
  y: 0,
  z,
  scale,
  dims: { width, height },
})

/**
 * `count` trees on a lattice of `spacing`, CENTRED on (x, z).
 *
 * Centred because the first version of this helper put its first tree at the
 * corner, and the sample point 17 m from a 9.6 m canopy read zero — a test
 * that failed for its own geometry and said nothing about the code.
 */
const stand = (count: number, spacing: number, x = 2000, z = 2000): CanopyProp[] => {
  const side = Math.ceil(Math.sqrt(count))
  return Array.from({ length: count }, (_, i) => {
    const gx = (i % side) - (side - 1) / 2
    const gz = Math.floor(i / side) - (side - 1) / 2
    return tree(x + gx * spacing, z + gz * spacing)
  })
}

/** Min and max over a field, without spreading 263 k floats onto the stack. */
const range = (values: Float32Array): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** The occlusion at a mesh-space point, by nearest texel. */
const at = (
  field: { vertPerSide: number; occlusion: Float32Array },
  x: number,
  z: number,
): number => {
  const i = Math.round(z / GRID.step) * field.vertPerSide + Math.round(x / GRID.step)
  return field.occlusion[i] as number
}

describe('the canopy sweep', () => {
  it('darkens a thicket far more than the lone tree at its centre', () => {
    // THE claim, and it is the report: "the grass under thick forests is the
    // same color as an open field." A term that answered "distance to the
    // nearest prop" would give these two the same number, because the middle
    // of a thicket and a lone tree are both zero metres from a tree.
    const lone = buildCanopyField(GRID, [tree(2000, 2000)], SPEC)
    // Five by five on a 6 m lattice: a stand about 24 m across, which at a 12 m
    // canopy is Matt's "thick forest" and not a hedge.
    const dense = buildCanopyField(GRID, stand(25, 6), SPEC)

    const loneCentre = at(lone, 2000, 2000)
    const denseCentre = at(dense, 2000, 2000)
    expect(loneCentre).toBeGreaterThan(0)
    expect(denseCentre).toBeGreaterThan(loneCentre * 2.5)
    // And the field 200 m away is untouched by either — the term is LOCAL, or
    // it is a tint on the whole island.
    expect(at(dense, 2200, 2000)).toBe(0)
  })

  it('never saturates flat, so more trees always count for something', () => {
    // The first draft was `min(1, density / k)`, which plateaus — and a plateau
    // across a forest is a contour line nobody authored, visible exactly where
    // the stand thickens. Beer-Lambert approaches the limit without reaching
    // it, so this walk must be strictly increasing all the way up.
    //
    // The walk has to add trees INSIDE the kernel's radius, which is a fact
    // this test learned the hard way: nine, 25 and 49 trees on a 6 m lattice
    // all read the same at the centre, because only the inner 3x3 are within a
    // 9.6 m canopy of it. That is the term being LOCAL and is correct — so the
    // measure here is the field's MEAN, where every added tree counts.
    let previous = -1
    for (let count = 1; count <= 60; count += 1) {
      const mean = buildCanopyField(GRID, stand(count, 3), SPEC).meanOcclusion
      expect(mean, `at ${count} props`).toBeGreaterThan(previous)
      previous = mean
    }
    // And the darkest texel is still inside the preset's ceiling, because
    // `strength` is a hard limit and not a target.
    expect(range(buildCanopyField(GRID, stand(60, 3), SPEC).occlusion).max).toBeLessThanOrEqual(
      SPEC.strength,
    )
  })

  it('stays inside 0..strength everywhere, at any density', () => {
    // 400 canopies inside 40 m: far denser than any real forest, which is the
    // point — `strength` is the preset's ceiling and nothing may go over it,
    // however the exponential is fed.
    const props = stand(400, 2)
    const { min, max } = range(buildCanopyField(GRID, props, SPEC).occlusion)
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(SPEC.strength)
    expect(max).toBeGreaterThan(SPEC.strength * 0.9)
  })

  it('falls off with distance from a single canopy and ends AT its rim', () => {
    // A radius that ended "near" the rim rather than at it would leave the
    // kernel's last ring writing a value the loop bounds had already decided
    // was outside — the class of bug where a term is right in the middle and
    // wrong at the edge, which is where every edge in a forest is.
    const width = 40
    const field = buildCanopyField(GRID, [tree(2000, 2000, width)], SPEC)
    const radius = (width / 2) * SPEC.radiusScale
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d < radius; d += GRID.step) {
      const v = at(field, 2000 + d, 2000)
      expect(v, `at ${d} m`).toBeLessThanOrEqual(previous)
      previous = v
    }
    // Past the rim, nothing — and the rim is derived from the spec here rather
    // than typed, so a `radiusScale` change moves the test with the code.
    expect(at(field, 2000 + radius + GRID.step, 2000)).toBe(0)
    expect(at(field, 2000, 2000)).toBeGreaterThan(0)
  })

  it('counts a prop whose canopy is smaller than a texel', () => {
    // 8 m texels and a 1 m shrub: the loop bounds cross over and the kernel
    // covers no grid point at all. A forest of those must not read as an empty
    // field — the failure mode is silent, because everything else still works.
    const shrub = tree(2000, 2000, 1)
    const field = buildCanopyField(GRID, [shrub], SPEC)
    expect(field.counted).toBe(1)
    expect(at(field, 2000, 2000)).toBeGreaterThan(0)
    // And it is worth far LESS than a canopy that really covers the texel.
    // THIS is the assertion that found the one real bug in the sweep: with a
    // kernel that peaked at 1 whatever its radius, a 0.8 m shrub landing on a
    // grid point wrote exactly what a 9.6 m canopy wrote, to the last decimal
    // place. Area, not peak.
    const full = at(buildCanopyField(GRID, [tree(2000, 2000)], SPEC), 2000, 2000)
    expect(at(field, 2000, 2000)).toBeLessThan(full / 10)
  })

  it('gives a big canopy the same coverage overhead and a WIDER reach', () => {
    // Counter-intuitive and correct: a texel cannot be more than covered by
    // one canopy, so a 40 m oak and a 12 m tree read the same directly under
    // them — the oak covers more TEXELS, not more sky per texel. Written as a
    // test because a reader meeting it in the field would call it a bug.
    const small = buildCanopyField(GRID, [tree(2000, 2000, 12)], SPEC)
    const oak = buildCanopyField(GRID, [tree(2000, 2000, 40)], SPEC)
    expect(at(oak, 2000, 2000)).toBeCloseTo(at(small, 2000, 2000), 2)
    const lit = (f: { occlusion: Float32Array }): number =>
      f.occlusion.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)
    expect(lit(oak)).toBeGreaterThan(lit(small) * 5)
  })

  it('reports what it swept, because the FRAME is the thing it cannot check', () => {
    const on = [tree(2000, 2000), tree(2008, 2000)]
    const off = [tree(-500, 2000), tree(2000, 99_999)]
    const field = buildCanopyField(GRID, [...on, ...off], SPEC)
    expect(field.counted).toBe(2)
    expect(field.offGrid).toBe(2)
    expect(field.maxDensity).toBeGreaterThan(0)
    expect(field.meanOcclusion).toBeGreaterThan(0)
  })

  it('is exactly the current image at strength 0, and cheap to detect', () => {
    // Every Anniversary number's shape: 0 is the build before the feature. The
    // caller skips the upload entirely on a zero field, so this has to be an
    // exact zero and not a small number.
    const props = Array.from({ length: 50 }, (_, i) => tree(2000 + i * 4, 2000))
    const field = buildCanopyField(GRID, props, { ...SPEC, strength: 0 })
    expect(field.occlusion.every((v) => v === 0)).toBe(true)
    expect(field.meanOcclusion).toBe(0)
    // The density was still measured, so the console line can say what WOULD
    // have happened — the difference between "off" and "nothing to shade".
    expect(field.maxDensity).toBeGreaterThan(0)
    expect(buildCanopyField(GRID, props, CANOPY_OFF).meanOcclusion).toBe(0)
  })

  it('scales a prop s canopy with its instance scale', () => {
    // `dims` is at scale 1 and the instance carries the rest, which is the one
    // multiplication a reader would drop. A half-size tree must reach less far
    // than a full one — asserted as a REACH rather than as a value.
    const big = buildCanopyField(GRID, [tree(2000, 2000, 20, 2)], SPEC)
    const small = buildCanopyField(GRID, [tree(2000, 2000, 20, 0.5)], SPEC)
    const reach = (f: { vertPerSide: number; occlusion: Float32Array }): number => {
      let last = 0
      for (let d = 0; d < 400; d += GRID.step) if (at(f, 2000 + d, 2000) > 0) last = d
      return last
    }
    expect(reach(big)).toBeGreaterThan(reach(small))
    expect(reach(big) / reach(small)).toBeGreaterThan(2)
  })

  it('is deterministic — the same forest twice is the same field', () => {
    const props = Array.from({ length: 200 }, (_, i) => tree(1000 + i * 7, 1000 + (i % 13) * 11))
    const a = buildCanopyField(GRID, props, SPEC)
    const b = buildCanopyField(GRID, props, SPEC)
    expect(Array.from(a.occlusion)).toEqual(Array.from(b.occlusion))
  })
})

// ── the CEILING, which is what lets a prop be shaded without going flat ───
//
// DEV-296. The ground is at the bottom of whatever is over it and needs no
// height; a prop stands IN the thing shading it, so its own fragments have to
// climb out. `ceiling` is the world y they climb to.
//
// Every claim here is about the RELATIONSHIP between a placement's own numbers
// and the texel it lands on, because the absolute heights are the mission's.

describe('the canopy ceiling', () => {
  const ceilingAt = (
    field: { vertPerSide: number; ceiling: Float32Array },
    x: number,
    z: number,
  ): number =>
    field.ceiling[
      Math.round(z / GRID.step) * field.vertPerSide + Math.round(x / GRID.step)
    ] as number

  it('is the placement height plus the canopy, in WORLD y', () => {
    // The grid's `originY` is the one offset between the mesh frame the
    // placements arrive in and the world height the shader compares against —
    // the same offset `buildPropColliders` adds, for the same reason. Dropping
    // it puts every ceiling at sea level and shades every prop to its tip.
    const withOrigin = { ...GRID, originY: 120 }
    const t = { x: 2000, y: 35, z: 2000, scale: 1, dims: { width: 12, height: 14 } }
    expect(ceilingAt(buildCanopyField(GRID, [t], SPEC), 2000, 2000)).toBeCloseTo(35 + 14, 3)
    expect(ceilingAt(buildCanopyField(withOrigin, [t], SPEC), 2000, 2000)).toBeCloseTo(
      120 + 35 + 14,
      3,
    )
  })

  it('scales the canopy with the instance, like the radius does', () => {
    const half = { x: 2000, y: 0, z: 2000, scale: 0.5, dims: { width: 12, height: 20 } }
    const full = { ...half, scale: 2 }
    expect(ceilingAt(buildCanopyField(GRID, [half], SPEC), 2000, 2000)).toBeCloseTo(10, 3)
    expect(ceilingAt(buildCanopyField(GRID, [full], SPEC), 2000, 2000)).toBeCloseTo(40, 3)
  })

  it('takes the MAX over everything covering a texel, not the nearest or the mean', () => {
    // The highest canopy over you is the one you have to clear. A mean would
    // let a tall tree among short ones be shaded by its own neighbours above
    // its own crown, and a nearest-prop rule would flicker between them.
    const short = { x: 2000, y: 0, z: 2000, scale: 1, dims: { width: 12, height: 6 } }
    const tall = { x: 2006, y: 0, z: 2000, scale: 1, dims: { width: 12, height: 30 } }
    const both = buildCanopyField(GRID, [short, tall], SPEC)
    expect(ceilingAt(both, 2000, 2000)).toBeCloseTo(30, 3)
    // And the tallest tree in a stand lights its own crown for free: the
    // ceiling at its texel IS its own top, so its tip ramps to fully lit.
    expect(ceilingAt(both, 2006, 2000)).toBeCloseTo(30, 3)
  })

  it('stays zero where nothing is overhead, which is where occlusion is zero too', () => {
    // Meaningless there and safely so — the shader multiplies the two — but a
    // ceiling left at some stale height under an unoccluded texel would be a
    // trap for anyone who later reads it on its own.
    const field = buildCanopyField(GRID, [tree(2000, 2000)], SPEC)
    expect(at(field, 2400, 2000)).toBe(0)
    expect(ceilingAt(field, 2400, 2000)).toBe(0)
  })

  it('reaches every texel the occlusion does, and no others', () => {
    // The two are written in the same loop and must not drift apart: a texel
    // with occlusion and no ceiling would shade a prop to its tip, and one
    // with a ceiling and no occlusion is a number nothing reads.
    const field = buildCanopyField(GRID, stand(25, 6), SPEC)
    let mismatched = 0
    for (let i = 0; i < field.occlusion.length; i++) {
      const lit = (field.occlusion[i] as number) > 0
      const capped = (field.ceiling[i] as number) > 0
      if (lit !== capped) mismatched++
    }
    expect(mismatched).toBe(0)
  })

  it('reports the mean canopy height it swept, for the fade constant to be judged against', () => {
    // `render/far-shadow.ts`'s CANOPY_FADE_METRES is quoted against these:
    // alpine 21.9 m, desert 6.8. A receipt rather than a guess is the whole
    // reason that constant could be defended instead of argued about.
    const field = buildCanopyField(
      GRID,
      [tree(2000, 2000, 12, 1, 10), tree(2100, 2000, 12, 2, 10)],
      SPEC,
    )
    expect(field.meanCanopyMetres).toBeCloseTo((10 + 20) / 2, 6)
  })
})
