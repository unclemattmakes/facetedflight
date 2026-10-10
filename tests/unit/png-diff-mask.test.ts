// tests/unit/png-diff-mask.test.ts — `--mask=`, the derived half of DEV-182.
//
// The ledger row quotes a statistic taken over a mask that was DERIVED from a
// render rather than drawn: `?terrainLit=basic` repaints the land and touches
// nothing else, so the pixels where it differs from the default are the land.
// A derived number needs the same provenance discipline as an extracted one
// (DEV-027, CLAUDE.md), and the discipline here is that the mask's two
// properties are asserted rather than believed:
//
//   * ANY channel over the threshold keeps the whole PIXEL — the trap is an
//     RGBA image, where a per-CHANNEL index is four times the per-pixel one and
//     silently masks the wrong quarter of the frame;
//   * the threshold is strict, so the mask is a LOWER BOUND on the subject's
//     extent — a subject pixel whose masked colour coincides is missed, and the
//     row says so.
//
// Plain `{w,h,ch,data}` objects rather than PNGs: there is no encoder in this
// repo and adding one to test a comparison is not a trade it makes
// (`png-diff.mjs`'s own header on dependencies).

import { describe, expect, it } from 'vitest'
import { blobStats, maskFrom } from '../../tools/perf/png-diff.mjs'

/** `pixels` is a flat list of per-channel bytes; `ch` says how to read it. */
const image = (w: number, h: number, ch: number, pixels: number[]) => ({
  w,
  h,
  ch,
  data: Uint8Array.from(pixels),
})

describe('maskFrom', () => {
  it('keeps a pixel when ANY channel moves past 24, and drops it otherwise', () => {
    // Four RGB pixels: one moves on red, one on blue only, one not at all, one
    // by exactly 24 — the boundary.
    const a = image(2, 2, 3, [0, 0, 0, 10, 10, 10, 40, 40, 40, 100, 100, 100])
    const m = image(2, 2, 3, [90, 0, 0, 10, 10, 90, 41, 39, 40, 124, 100, 100])
    const got = maskFrom(a, m)
    expect(Array.from(got?.keep ?? [])).toEqual([1, 1, 0, 0])
    expect(got?.share).toBeCloseTo(0.5, 12)
  })

  it('indexes by PIXEL, not by channel, on an RGBA image', () => {
    // The whole trap in one case. Four RGBA pixels where only the LAST one
    // moves; a per-channel index would mark pixel 3 of a 4-pixel frame from
    // channel 12 and, worse, would read alpha as colour.
    const a = image(2, 2, 4, [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
    const m = image(2, 2, 4, [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 90, 0, 0, 255])
    expect(Array.from(maskFrom(a, m)?.keep ?? [])).toEqual([0, 0, 0, 1])
  })

  it('ignores the ALPHA channel, which is never the subject', () => {
    // An RGBA pair identical in colour and wildly different in alpha must mask
    // nothing: `--mask=` is pointed at a build that repaints a SURFACE.
    const a = image(1, 2, 4, [10, 20, 30, 255, 10, 20, 30, 255])
    const m = image(1, 2, 4, [10, 20, 30, 0, 10, 20, 30, 0])
    expect(Array.from(maskFrom(a, m)?.keep ?? [])).toEqual([0, 0])
  })

  it('refuses a mask of a different size rather than reading past the end', () => {
    expect(maskFrom(image(2, 1, 3, [0, 0, 0, 0, 0, 0]), image(1, 1, 3, [0, 0, 0]))).toBeNull()
  })

  it('reports the share, which is the check that the mask found the subject', () => {
    // A mask that comes back at 3 % or 99 % of the frame is a mask pointed at
    // the wrong render, and the share is how the operator sees that. DEV-182's
    // five stands ran 49.1 % to 91.3 %.
    const a = image(4, 1, 3, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const m = image(4, 1, 3, [99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(maskFrom(a, m)?.share).toBeCloseTo(0.25, 12)
  })
})

// ── blobStats — DEV-245, the statistic that tells a seam from scattered noise ─
//
// Added with the seat-level rung frames, where the whole question is whether a
// difference is big enough for a player to SEE. A mean and a moved share cannot
// answer it: the first pair below has the same moved share in both arms and the
// opposite finding, and only `largestShare` separates them. That is DEV-241's
// lesson in a second form, and ART_DIRECTION's — *too small, too dark, too fast
// or off-screen has not been reviewed, it has been rendered.*
describe('blobStats', () => {
  /** A mask from a picture of it: `#` is a moved pixel, `.` is not. */
  const mask = (rows: readonly string[]) => ({
    keep: Uint8Array.from([...rows.join('')].map((c) => (c === '#' ? 1 : 0))),
    w: (rows[0] as string).length,
    h: rows.length,
  })

  it('separates ONE region from the SAME number of scattered pixels', () => {
    // The pair this exists for. Eight moved pixels either way, so the mean and
    // the share are identical; one is a 4x2 block and the other is a chequer.
    const block = mask(['####....', '####....', '........', '........'])
    const noise = mask(['#.#.#.#.', '........', '.#.#.#.#', '........'])
    const a = blobStats(block.keep, block.w, block.h, 0)
    const b = blobStats(noise.keep, noise.w, noise.h, 0)
    expect(a?.moved).toBe(8)
    expect(b?.moved).toBe(8)
    expect(a?.movedShare).toBeCloseTo(b?.movedShare ?? -1, 12)
    // ...and the spatial statistic is eight times apart.
    expect(a?.largest).toBe(8)
    expect(b?.largest).toBe(1)
    expect(a?.components).toBe(1)
    expect(b?.components).toBe(8)
  })

  it('is 4-connected, so a diagonal chain is not one region', () => {
    // 8-connectivity would call this a single five-pixel region, which is the
    // scattered case wearing a seam's statistic.
    const m = mask(['#....', '.#...', '..#..', '...#.', '....#'])
    const got = blobStats(m.keep, m.w, m.h, 0)
    expect(got?.largest).toBe(1)
    expect(got?.components).toBe(5)
  })

  it('does not wrap a row into the one above it', () => {
    // The trap in the flat index: `p - 1` at x === 0 is the LAST pixel of the
    // previous row. Two bars at opposite edges of adjacent rows are TWO
    // regions, and a wrapping walk reports one region of four pixels.
    const m = mask(['##..', '..##'])
    const got = blobStats(m.keep, m.w, m.h, 0)
    expect(got?.components).toBe(2)
    expect(got?.largest).toBe(2)
  })

  it('counts a region once, however many of its pixels the walk reaches first', () => {
    // A U: the walk starts at the top of the left arm and must not find the
    // right arm again when it gets there.
    const m = mask(['#..#', '#..#', '####'])
    const got = blobStats(m.keep, m.w, m.h, 0)
    expect(got?.components).toBe(1)
    expect(got?.largest).toBe(8)
  })

  it('applies minShare to the COUNT and never to the largest', () => {
    // Sixteen pixels: one region of five and one of one. At minShare 0.25 only
    // the big one is a region, and `largest` is unchanged — it has no
    // threshold, which is what makes it comparable against a control's.
    const m = mask(['##..', '##..', '.#..', '...#'])
    expect(blobStats(m.keep, m.w, m.h, 0)?.components).toBe(2)
    expect(blobStats(m.keep, m.w, m.h, 0.25)?.components).toBe(1)
    expect(blobStats(m.keep, m.w, m.h, 0.25)?.largest).toBe(5)
  })

  it('refuses a mask whose length is not w * h rather than reading past the end', () => {
    expect(blobStats(new Uint8Array(3), 2, 2)).toBeNull()
  })

  it('reports nothing moved for an empty mask', () => {
    const got = blobStats(new Uint8Array(9), 3, 3)
    expect(got?.moved).toBe(0)
    expect(got?.largest).toBe(0)
    expect(got?.components).toBe(0)
  })
})
