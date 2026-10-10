// tests/unit/pause-menu.test.ts — you hit what you are looking at.
//
// The failure mode of a world-space menu is that the row you SEE highlighted
// and the row your ray actually lands in drift apart — and it is invisible in a
// screenshot, because the panel renders perfectly either way. You find out when
// somebody in a headset aims at RESUME and gets RESTART.
//
// `pause.ts` has two coordinate conventions in one file and they disagree about
// which way is up: the painter measures DOWN from the top edge in canvas pixels,
// the hit test works in plane space where +y is UP from the middle. `rowTop` is
// shared between them so they cannot drift, and these tests aim a ray at each
// row's painted centre and check it comes back.
//
// `pickLocal` is exported, and works in panel-local space, precisely so this
// needs no DOM: the suite is `environment: 'node'` on purpose.

import { describe, expect, it } from 'vitest'
import { PANEL_DROP, pickLocal, rowCentreLocalY, rowTop } from '@/render/pause'

/** Two rows is what ships today; three is what 2016 had. Both must work. */
const COUNTS = [2, 3] as const

/** A ray from 1 m in front of the panel, aimed at (x, y) on its face. */
const rayAt = (x: number, y: number, count: number) => pickLocal(x, y, 1, 0, 0, -1, count)

describe('the pause menu hit test', () => {
  it('returns the row you are looking at, for every row', () => {
    // The round trip through both conventions. If the up/down flip is wrong
    // this reports row 1 for row 0 and vice versa — which is exactly the bug
    // that renders correctly and plays wrong.
    for (const count of COUNTS) {
      for (let i = 0; i < count; i++) {
        expect(rayAt(0, rowCentreLocalY(i), count), `row ${i} of ${count}`).toBe(i)
      }
    }
  })

  it('gives the TOP row the FIRST option, not the last', () => {
    // Said on its own because it is the assertion above's whole point, and
    // because a test that loops can be read as passing for the wrong reason.
    // Row 0 is painted nearest the title, so its centre is the highest y.
    expect(rowCentreLocalY(0)).toBeGreaterThan(rowCentreLocalY(1))
  })

  it('misses the title, which is above every row', () => {
    // `TITLE_BAND` exists so "- PAUSE -" is not a button. A ray through it must
    // select nothing rather than the nearest row.
    const aboveFirstRow = rowCentreLocalY(0) + (rowCentreLocalY(0) - rowCentreLocalY(1))
    expect(rayAt(0, aboveFirstRow, 2)).toBe(-1)
  })

  it('misses below the last row, and misses a row that is not offered', () => {
    // With two options, row 2's band is empty space. Looking there must not
    // return 2 and let the caller index past the end of its own list.
    expect(rayAt(0, rowCentreLocalY(2), 2)).toBe(-1)
    expect(rayAt(0, rowCentreLocalY(2), 3)).toBe(2)
  })

  it('misses off the side of the panel', () => {
    // The panel is 0.56 m wide, so 0.4 m from the centre is past its edge. A
    // player looking at the cockpit beside the menu is not choosing anything.
    expect(rayAt(0.4, rowCentreLocalY(0), 2)).toBe(-1)
    expect(rayAt(-0.4, rowCentreLocalY(0), 2)).toBe(-1)
  })

  it('misses when the panel is BEHIND you', () => {
    // Same ray, reversed. Without the `t <= 0` guard the plane intersection is
    // still perfectly well defined and the menu would be operable over your
    // shoulder — which is not a thing you would ever think to check by hand.
    expect(rayAt(0, rowCentreLocalY(0), 2)).toBe(0)
    expect(pickLocal(0, rowCentreLocalY(0), 1, 0, 0, 1, 2)).toBe(-1)
  })

  it('misses a ray running parallel to the panel', () => {
    // Never hits, rather than dividing by zero and landing somewhere.
    expect(pickLocal(0, 0, 1, 1, 0, 0, 2)).toBe(-1)
  })

  it('does not need a normalised direction', () => {
    // The caller hands over `camera.getWorldDirection`, which is normalised —
    // but the maths does not depend on it, and a future caller passing a
    // velocity or an un-normalised difference must not silently mis-aim.
    const y = rowCentreLocalY(1)
    expect(pickLocal(0, y, 1, 0, 0, -1, 2)).toBe(1)
    expect(pickLocal(0, y, 1, 0, 0, -37, 2)).toBe(1)
  })

  it('picks the row from an OFF-AXIS eye, not just from dead ahead', () => {
    // The real case: the head is not at the panel's centre. Aim from 0.3 m to
    // one side and below, at row 1's centre, and it must still be row 1.
    const eyeX = 0.3
    const eyeY = -0.25
    const eyeZ = 1
    const target = rowCentreLocalY(1)
    expect(pickLocal(eyeX, eyeY, eyeZ, -eyeX, target - eyeY, -eyeZ, 2)).toBe(1)
  })

  it('selects NOTHING along the eye line, which is what makes a stick usable', () => {
    // The constraint `PANEL_DROP` exists to satisfy, and the one place my own
    // arithmetic could be wrong with nothing to catch it (DEV-027: a number you
    // derived has no provenance machinery).
    //
    // The gaze on a flat screen is the ship's forward, and a paused sim is a
    // frozen ship — so a row sitting on the eye line would be re-selected every
    // frame and the stick could never move off it. The panel hangs `PANEL_DROP`
    // below the eye, so a horizontal ray from eye height crosses the panel
    // `PANEL_DROP` ABOVE its centre, which must land in the title band.
    for (const count of COUNTS) {
      expect(pickLocal(0, PANEL_DROP, 1, 0, 0, -1, count), `eye line, ${count} rows`).toBe(-1)
    }
    // And the first row is a deliberate look DOWN from there, not a twitch: at
    // 0.86 m, at least 3 degrees below the eye line.
    const toFirstRow = PANEL_DROP - rowCentreLocalY(0)
    expect((Math.atan2(toFirstRow, 0.86) * 180) / Math.PI).toBeGreaterThan(3)
  })

  it('lays the rows out in order, with no gaps and no overlap', () => {
    // The property the painter relies on. A gap is a dead band you cannot
    // select from; an overlap means the first matching row always wins and the
    // second is unreachable.
    for (let i = 1; i < 4; i++) {
      const band = rowTop(i) - rowTop(i - 1)
      expect(band).toBeCloseTo(rowTop(1) - rowTop(0), 12)
    }
    expect(rowTop(0)).toBeGreaterThan(0)
  })
})
