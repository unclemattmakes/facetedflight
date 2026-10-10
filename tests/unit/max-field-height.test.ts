// tests/unit/max-field-height.test.ts — the sea's ceiling, and why it is not
// the render group's y.
//
// DEV-167 / W6. `sim/terrain/height-field.ts`'s `maxFieldHeight` is what
// decides which of the ocean's two shader variants a frame draws with: the
// cheap single-sided one is only equivalent to the two-sided one when EVERY
// visible piece of surface is below the eye, so the test has to be against the
// plate's ceiling and not against the one sample under the ship.
//
// ── What this file proves, and what proved the rest ──────────────────────
//
// These are the arithmetic: the maximum, the scale, and the origin. They run
// on a synthetic map so they run in CI, where `public/assets` does not exist.
//
// The claim they CANNOT make is the one that mattered. The first pass of the
// variant switch asked the render group's `position.y` for the sea level —
// which on Simonet is near the origin while the sea is at ~116 m — and put the
// cheap shader on a frame taken **55 m under the water**. No unit test caught
// that and none of these would have. Six screenshots against their own noise
// floor did (`tools/perf/png-diff.mjs`, the DEV row). The lesson is CLAUDE.md's
// and it is worth restating: a number you compute yourself needs saying what it
// is the height OF, and then checking against something outside the port.

import { describe, expect, it } from 'vitest'
import { buildHeightField, maxFieldHeight } from '@/sim/terrain/height-field'

/** A small square terrain, so a 1,025-sample-per-side plate is not built three times. */
const PARAMS = {
  terrainSize: 64,
  baseResolution: 8,
  terrainHeight: 512,
} as unknown as Parameters<typeof buildHeightField>[1]

/** A map that reads `v` everywhere. */
const flat = (v: number) =>
  ({
    sample: (_u: number, _v: number, rgb: { r: number; g: number; b: number }) => {
      rgb.r = v
      rgb.g = v
      rgb.b = v
    },
  }) as unknown as Parameters<typeof buildHeightField>[0]

describe('maxFieldHeight — the sea has a ceiling and it is not the group', () => {
  it('is the top of the map, measured from the transform, not from zero', () => {
    const white = buildHeightField(flat(1), PARAMS, { position: [0, 100, 0], scale: [1, 1, 1] })
    expect(maxFieldHeight(white)).toBeCloseTo(100 + 512, 3)
    const black = buildHeightField(flat(0), PARAMS, { position: [0, 100, 0], scale: [1, 1, 1] })
    expect(maxFieldHeight(black)).toBeCloseTo(100, 3)
  })

  it('scales with the transform, because the ocean plate is scaled 8x', () => {
    const field = buildHeightField(flat(0.5), PARAMS, { position: [0, 10, 0], scale: [8, 3, 8] })
    expect(maxFieldHeight(field)).toBeCloseTo(10 + 0.5 * 512 * 3, 3)
  })

  it('takes the MAXIMUM, which is the whole point', () => {
    // One bright sample among eighty-one. A mean, a corner read or a sample
    // under the ship would all miss it — and the sea would then draw
    // single-sided under its own crest, which is the bug this exists to stop.
    let call = 0
    const oneSpike = {
      sample: (_u: number, _v: number, rgb: { r: number; g: number; b: number }) => {
        const v = call++ === 7 ? 1 : 0.1
        rgb.r = v
        rgb.g = v
        rgb.b = v
      },
    } as unknown as Parameters<typeof buildHeightField>[0]
    const field = buildHeightField(oneSpike, PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
    expect(maxFieldHeight(field)).toBeCloseTo(512, 3)
  })

  it('is far above what a group placed at the origin would report', () => {
    // The shape of the bug, written as a test: a plate whose GROUP sits at 0
    // and whose SURFACE is 116 m up. Anything reading the group's y gets 0 and
    // calls a submarine view "above the water".
    const field = buildHeightField(flat(116.6 / 512), PARAMS, {
      position: [0, 0, 0],
      scale: [1, 1, 1],
    })
    expect(maxFieldHeight(field)).toBeCloseTo(116.6, 2)
    expect(maxFieldHeight(field)).toBeGreaterThan(100)
  })
})
