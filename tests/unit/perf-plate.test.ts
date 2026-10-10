// tests/unit/perf-plate.test.ts — where the perf plate sits, as a GEOMETRY claim.
//
// DEV-160, `docs/plan/VR-PERF.md` §5.5 D. `createPerfPlate` needs a canvas and
// this suite is `environment: 'node'`, so nothing here builds one. What it can
// reach is `plateOffsetX`, which is the only arithmetic in the file — and the
// only thing between "beside the HUD" and "overlapping it".
//
// **Test the geometry, not the rotation** (CLAUDE.md's orientation lesson).
// `expect(plateOffsetX(1, -1)).toBe(-0.215)` would be the implementation's own
// sum written twice: it would pass for a plate that overlapped the HUD by a
// centimetre, because it never asks what the number is the distance OF. So the
// assertions below are about the two panels' NEAR EDGES — a relationship that is
// true independently of what either constant happens to be, and false for every
// way this can go wrong.

import { describe, expect, it } from 'vitest'
import { WIDTH as HUD_W, PIXELS_PER_METRE } from '@/render/hud'
import {
  PLATE_GAP,
  PLATE_H,
  PLATE_SIDE,
  PLATE_W,
  plateOffsetX,
  plateRows,
} from '@/render/perf-plate'

/** Metres a float comparison may be out by. A tenth of a millimetre. */
const EPS = 1e-4

/** The plate's near edge, as an x in the HUD's own frame, at a given HUD scale. */
const nearEdge = (scale: number, side: -1 | 1): number => {
  const centre = plateOffsetX(scale, side)
  // The edge facing the HUD is the one on the opposite side of the plate's
  // centre from the direction it was pushed.
  return centre - side * ((PLATE_W / 2) * scale)
}

/** The HUD's own edge on that side, same frame, same scale. */
const hudEdge = (scale: number, side: -1 | 1): number => side * (HUD_W / 2) * scale

describe('the plate sits beside the HUD, not on it', () => {
  it('leaves exactly PLATE_GAP between the two near edges, at scale 1', () => {
    for (const side of [-1, 1] as const) {
      expect(Math.abs(nearEdge(1, side) - hudEdge(1, side))).toBeCloseTo(PLATE_GAP, 4)
    }
  })

  it('still leaves that gap when the HUD is scaled — DEV-129 drags this', () => {
    // Both panels take `hud.scale`, so the gap scales with them. An offset that
    // did NOT scale would overlap the HUD below 1 and open a gutter above it,
    // and the shipped presets both say `scale: 1` so nothing in the game would
    // ever show it. The lookdev Placement folder is the one thing that moves it.
    for (const scale of [0.5, 0.8, 1, 1.4, 2]) {
      const gap = Math.abs(nearEdge(scale, PLATE_SIDE) - hudEdge(scale, PLATE_SIDE))
      expect(gap, `scale ${scale}`).toBeCloseTo(PLATE_GAP * scale, 4)
    }
  })

  it('never overlaps the HUD, on either side, at any scale', () => {
    // The failure this exists for, stated as the thing it is: the plate's near
    // edge is further from the centre than the HUD's, in the same direction.
    for (const scale of [0.25, 1, 3]) {
      for (const side of [-1, 1] as const) {
        expect(Math.abs(nearEdge(scale, side)), `scale ${scale} side ${side}`).toBeGreaterThan(
          Math.abs(hudEdge(scale, side)) - EPS,
        )
        // And on the side it was asked for, rather than mirrored — an
        // orientation bug is a CLASS in this repo (four of them so far).
        expect(Math.sign(plateOffsetX(scale, side)), `scale ${scale} side ${side}`).toBe(side)
      }
    }
  })

  it('defaults to the pilot’s left', () => {
    expect(PLATE_SIDE).toBe(-1)
  })
})

describe('the canvas is a whole number of pixels at the HUD’s density', () => {
  it('is 504 x 336 — VR-PERF §5.5 D', () => {
    // Not a magic pair: it is the plate's metres at `render/hud.ts`'s own pixel
    // density, which is why the two panels' type is the same size on the retina.
    // If either constant moves, this says what the new texture will be rather
    // than going quietly non-integer and landing on a blurry half pixel.
    expect(PLATE_W * PIXELS_PER_METRE).toBe(504)
    expect(PLATE_H * PIXELS_PER_METRE).toBe(336)
  })

  it('is taller than the HUD, because it carries ten rows to the HUD’s three', () => {
    expect(PLATE_H).toBeGreaterThan(0.145)
  })
})

// ── The eleventh row ───────────────────────────────────────────────────────
//
// `boot/app.ts` appends live diagnostics to `perfPlateLines`' ten — the XR
// input line, the frame-error line. The grid divided the plate's height by the
// CONSTANT ten, so row index 10 was painted at `padY + rowH * 10.5`: drawn, and
// below the bottom edge. Matt, wearing the Frame, in the session that existed
// to read the controller mapping off that very row: *"i don't see anything
// about the buttons in the perf panel. is it out of bounds from the perf
// panel?"* It was, exactly.
//
// It is `draw` that had the bug, and `draw` needs a 2d context this suite has
// not got — which is precisely how it survived, with the only witness a human
// in a headset. So the arithmetic is exported and asserted here, and asserted
// as a RELATIONSHIP: `plateRows` is a FLOOR, and every row lands inside the
// plate. `tests/unit/perf-format.test.ts` holds the other half — that the ten
// the formatter emits are ten the grid is laid out for.
describe('the plate lays out for the lines it is GIVEN, not for ten', () => {
  it('holds the designed grid at or below the shipped row count', () => {
    // The floor half. Nine rows must not stretch to fill the plate, or the type
    // would change size every time a row went quiet.
    expect(plateRows(9)).toBe(plateRows(10))
    expect(plateRows(0)).toBe(plateRows(10))
  })

  it('grows for every extra row app.ts appends', () => {
    // THE assertion: `app.ts` concatenates up to two diagnostics onto the ten,
    // and a plate laid out for ten has nowhere to put them.
    expect(plateRows(11)).toBe(11)
    expect(plateRows(12)).toBe(12)
    expect(plateRows(15)).toBe(15)
  })

  it('keeps every row inside the plate — the property the pixels had to have', () => {
    // Not a re-derivation of `draw`: this is the containment `draw` must have,
    // written as the inequality that was FALSE for the clipped row. `padY`'s
    // fraction and the 0.5 centring are `draw`'s; the last row's centre plus
    // half a row has to land inside the height. Run against the old
    // `/ ROWS` this fails at n = 11 by more than a whole row.
    const padFrac = 0.028
    for (const n of [10, 11, 12, 15]) {
      const rowH = (1 - padFrac * 2) / plateRows(n)
      const lastRowBottom = padFrac + rowH * (n - 1 + 0.5) + rowH / 2
      expect(lastRowBottom, `row ${n - 1} of ${n} falls off the plate`).toBeLessThanOrEqual(1)
    }
  })
})
