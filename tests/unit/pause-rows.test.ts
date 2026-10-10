// tests/unit/pause-rows.test.ts — the pause plate holds more than three rows
// now, and the three-row plate is unchanged to the last bit.
//
// Companion to `pause-menu.test.ts`, which pins the two- and three-row cases
// that shipped and must go on passing untouched. This file is about what the
// comfort menu needed: a page of SEVEN rows on the same plate, at the same
// place, without `game/flight.ts` — which nobody owns this session — having to
// know anything about it.
//
// The design under test, in one sentence: **the panel's TOP EDGE is pinned and
// it grows downward.** `flight.ts` places this panel's ORIGIN at
// `EYE.y - PANEL_DROP`, so a panel that grew symmetrically would push its top
// edge up past the eye line, and "a ray along the eye line lands in the title
// band" — the property that makes the stick usable on a flat screen — would
// quietly stop holding somewhere around four rows. Nothing would look wrong.
// You would find out when the top row selected itself and would not let go.

import { describe, expect, it } from 'vitest'
import {
  FOOT_M,
  FOOT_SLIM_M,
  PANEL_DROP,
  panelHeight,
  pickLocal,
  rowBand,
  rowCentreLocalY,
  rowTop,
} from '@/render/pause'

/** The distance `flight.ts` hangs the plate at. Its own line, quoted. */
const PANEL_Z = 0.86

const rayAt = (y: number, count: number) => pickLocal(0, y, 1, 0, 0, -1, count)

const degreesAt = (metres: number) => (Math.atan2(metres, PANEL_Z) * 180) / Math.PI

describe('the three-row plate is exactly what shipped', () => {
  it('is still 0.42 m tall, with a 0.26 title band and 0.2 rows', () => {
    // The refactor converted two fractions of a fixed height into metres. These
    // numbers are the originals, and they are asserted rather than trusted
    // because "nearly identical" in a hit test is the bug that renders
    // perfectly and plays wrong.
    // DEV-861: a plate that keeps the footer band is still 0.42 m; every other
    // plate closes up under its last row by the band the choose hint left empty.
    expect(panelHeight(3, undefined, FOOT_M)).toBeCloseTo(0.42, 12)
    expect(panelHeight(3)).toBeCloseTo(0.42 - FOOT_M + FOOT_SLIM_M, 12)
    expect(panelHeight(3)).toBeLessThan(panelHeight(3, undefined, FOOT_M))
    expect(rowTop(0, 3, undefined, FOOT_M)).toBeCloseTo(0.26, 12)
    expect(rowTop(1, 3, undefined, FOOT_M) - rowTop(0, 3, undefined, FOOT_M)).toBeCloseTo(0.2, 12)
    expect(rowCentreLocalY(0)).toBeCloseTo(0.0588, 12)
  })

  it('needs NO offset at three rows, which is why flight.ts is untouched', () => {
    // `buildGeometry` translates the plane by `0.21 - height/2`. At three rows
    // that is exactly zero — the plate is where it always was, and the placement
    // line in `game/flight.ts` did not have to change.
    expect(0.21 - panelHeight(3, undefined, FOOT_M) / 2).toBeCloseTo(0, 12)
  })
})

describe('the top edge is pinned, for every row count', () => {
  it('puts the first row in the same place whatever else is on the plate', () => {
    // Four rows must not shove RESUME upward. The pause menu is muscle memory
    // after the third run.
    for (const count of [1, 2, 3, 4, 5]) {
      expect(rowCentreLocalY(0, count), `${count} rows`).toBeCloseTo(rowCentreLocalY(0, 3), 12)
    }
  })

  it('keeps the title band a constant number of METRES, not a fraction', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(rowTop(0, count) * panelHeight(count), `${count} rows`).toBeCloseTo(0.1092, 12)
    }
  })

  it('selects nothing along the eye line, at every row count', () => {
    // `PANEL_DROP`'s whole reason for existing, checked across the range rather
    // than at the one count it was originally measured at. The gaze on a flat
    // screen is the ship's forward, and a paused sim is a frozen ship: a row on
    // the eye line is re-selected every frame and the stick can never move off.
    for (let count = 1; count <= 8; count++) {
      expect(rayAt(PANEL_DROP, count), `${count} rows`).toBe(-1)
    }
  })

  it('grows DOWNWARD, and stops growing once the rows start shrinking', () => {
    let previous = 0
    for (let count = 1; count <= 8; count++) {
      const height = panelHeight(count)
      expect(height, `${count} rows`).toBeGreaterThanOrEqual(previous - 1e-12)
      previous = height
    }
    // Past the shrink threshold the rows share a FIXED total, so the plate stops
    // getting bigger — six rows, seven and eight are all the same height. That
    // is the property that bounds how far down you ever have to look, and it is
    // worth stating rather than discovering.
    expect(panelHeight(8)).toBeCloseTo(panelHeight(6), 9)
    // The bottom edge of a seven-row plate, measured from the eye line.
    const bottom = PANEL_DROP + (panelHeight(7) - 0.21)
    expect(degreesAt(bottom)).toBeLessThan(40)
  })
})

describe('the rows tile the plate, at every count', () => {
  it('hits every row at its painted centre, 1 through 8', () => {
    // The round trip through both coordinate conventions — the painter measures
    // DOWN from the top in pixels, the hit test works +y UP from the origin —
    // for every page size the menu can be asked for.
    for (let count = 1; count <= 8; count++) {
      for (let i = 0; i < count; i++) {
        expect(rayAt(rowCentreLocalY(i, count), count), `row ${i} of ${count}`).toBe(i)
      }
    }
  })

  it('leaves no gap and no overlap between neighbours', () => {
    // A gap is a dead band you cannot select from; an overlap means the first
    // matching row always wins and the second is unreachable. Checked at the
    // BOUNDARY, which is the only place either can happen.
    for (const count of [3, 7]) {
      const band = rowBand(count)
      for (let i = 1; i < count; i++) {
        const boundary = rowCentreLocalY(i, count) + band / 2
        // A hair below the boundary is row i; a hair above is row i−1.
        expect(rayAt(boundary - 1e-6, count), `below ${i} of ${count}`).toBe(i)
        expect(rayAt(boundary + 1e-6, count), `above ${i} of ${count}`).toBe(i - 1)
      }
    }
  })

  it('misses a row that is not offered', () => {
    expect(rayAt(rowCentreLocalY(5, 7), 4)).toBe(-1)
    expect(rayAt(rowCentreLocalY(5, 7), 7)).toBe(5)
  })
})

describe('the shrink rule, and the trade it makes', () => {
  it('shrinks nothing at five rows or fewer', () => {
    // The pause menu gains one row (COMFORT) and must not get smaller targets
    // for it.
    for (const count of [1, 2, 3, 4, 5]) {
      expect(rowBand(count), `${count} rows`).toBeCloseTo(rowBand(3), 12)
    }
    expect(rowBand(6)).toBeLessThan(rowBand(5))
  })

  it('keeps a seven-row page above 4 degrees a row', () => {
    // `pause.ts` was sized so a row subtends about 6 degrees, on the stated
    // ground that "a head can hold 6 degrees comfortably and cannot reliably
    // hold 3". Seven rows come out at 4.6, which is a real trade and is written
    // down as one: the alternative was a 42-degree list whose bottom row you
    // cannot see without leaning.
    const degrees = degreesAt(rowBand(7) / 2) * 2
    expect(degrees).toBeGreaterThan(4)
    expect(degrees).toBeLessThan(6)
  })

  it('keeps the bottom row of a seven-row page inside a comfortable look down', () => {
    // 31 degrees. Further than anything else in the cockpit, and still a glance
    // rather than a neck bend — and the stick reaches it without looking at all.
    // "Can you hit the bottom row with your head" is an XR-checklist line; this
    // only pins the arithmetic it rests on.
    const drop = PANEL_DROP - rowCentreLocalY(6, 7)
    expect(degreesAt(drop)).toBeLessThan(35)
    expect(degreesAt(drop)).toBeGreaterThan(20)
  })

  it('is defined for degenerate counts rather than dividing by zero', () => {
    expect(Number.isFinite(panelHeight(0))).toBe(true)
    expect(Number.isFinite(rowBand(0))).toBe(true)
    expect(rayAt(0, 0)).toBe(-1)
  })
})
