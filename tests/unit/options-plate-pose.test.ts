// tests/unit/options-plate-pose.test.ts: DEV-882 sized the OPTIONS plates as the pause
// plate's page; DEV-897 (Matt, 2026-10-10: "make sure it's positioned the same as in
// the game") stands them where the pause plate stands.
//
// The oracle is the PAUSE plate's own geometry, not a number this file derives the way
// the code does: `render/pause.ts`'s `PANEL_DISTANCE` and `PANEL_DROP` as the cockpit
// (`game/flight.ts`) adds them to its eye, read out of that source, and the angle a row
// subtends at that distance. The relationships asserted are the ones Matt named: the
// same distance from the eye, the same height relative to the eye, the same tilt, facing
// the viewer, in a headset and flat, and a phone's fit is the pause plate's own.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { optionsPlatePose } from '@/render/hangar-options-plate'
import { OPTIONS_PLATE_DISTANCE, optionsPlatePoseAt } from '@/render/options-plate-pose'
import {
  PANEL_DISTANCE,
  PANEL_DROP,
  pausePlateOffset,
  rowBand,
  TITLE_M,
  TOP_LOCAL_Y,
} from '@/render/pause'
import { PAUSE_PHONE_SCALE, pausePhoneFit, phoneUi } from '@/render/phone-floor'
import { REPO } from './helpers/source-tree'

const readSrc = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

const DEG = Math.PI / 180
/** The angle a length `m` subtends dead ahead at `distance`, degrees. */
const subtends = (m: number, distance: number): number => (2 * Math.atan(m / 2 / distance)) / DEG

describe('the cockpit and the OPTIONS plates share one offset (DEV-897)', () => {
  it('the cockpit adds pausePlateOffset to its eye, and so does the jump seat', () => {
    expect(readSrc('src/game/flight.ts')).toContain('pausePlateOffset()')
    expect(readSrc('src/game/jumpseat-flight.ts')).toContain('pausePlateOffset()')
  })

  it('the level offset is the pause plate: PANEL_DISTANCE ahead, PANEL_DROP below', () => {
    const [x, y, z] = pausePlateOffset()
    expect([x, y, z]).toEqual([0, -PANEL_DROP, -PANEL_DISTANCE])
  })
})

describe('the OPTIONS plates stand where the pause plate does (DEV-897)', () => {
  it('in a headset: the pause plate pose, upright, whatever the chair looks along', () => {
    for (const centre of [0, -22.8 * DEG]) {
      const pose = optionsPlatePoseAt(8, 0, false, centre)
      expect(pose.position).toEqual(pausePlateOffset())
      expect(pose.scale).toBe(1)
      expect(pose.tilt).toBe(0)
    }
    expect(OPTIONS_PLATE_DISTANCE).toBe(PANEL_DISTANCE)
  })

  it('flat and level: the same pose, which is the cockpit pause plate exactly', () => {
    const pose = optionsPlatePoseAt(8, 0, true, 0)
    expect(pose.position).toEqual(pausePlateOffset())
    expect(pose.scale).toBe(1)
    expect(pose.tilt).toBe(0)
  })

  it('flat, looking down the chair’s 22.8 degrees: the cockpit pose in the VIEW’S frame', () => {
    const c = -22.8 * DEG
    const { position, tilt } = optionsPlatePoseAt(8, 0, true, c)
    expect(tilt).toBe(c)
    // The same distance from the eye as in the cockpit, and the same angle below the view line.
    expect(Math.hypot(position[1], position[2])).toBeCloseTo(
      Math.hypot(PANEL_DROP, PANEL_DISTANCE),
      12,
    )
    const belowView = Math.atan2(-position[1], -position[2]) - -c // elevation relative to the view
    expect(belowView).toBeCloseTo(Math.atan2(PANEL_DROP, PANEL_DISTANCE), 12)
    // And it faces the eye exactly as the cockpit's does: the card's normal (local +z turned
    // by the tilt) against the line to the eye makes the cockpit's angle.
    const normal = [-Math.sin(c), Math.cos(c)] as const
    const len = Math.hypot(position[1], position[2])
    const along = (-position[1] * normal[0] - position[2] * normal[1]) / len
    const [, cy, cz] = pausePlateOffset()
    const cockpit = (-cy * 0 - cz * 1) / Math.hypot(cy, cz)
    expect(along).toBeCloseTo(cockpit, 12)
  })

  it('the hangar’s own entry point agrees, on the chair’s pitch', () => {
    expect(optionsPlatePose(8, 0, false).position).toEqual(pausePlateOffset())
    const flat = optionsPlatePose(8, 0, true)
    expect(flat.position[0]).toBe(0)
    expect(flat.tilt).toBeLessThan(0) // looking down
  })

  for (const rows of [1, 3, 5, 7, 8]) {
    it(`${rows} rows: a row subtends the pause plate's angle at the same distance`, () => {
      const pause = subtends(rowBand(rows), PANEL_DISTANCE)
      for (const flat of [true, false]) {
        const { scale, position } = optionsPlatePoseAt(rows, 0, flat, 0)
        expect(subtends(rowBand(rows) * scale, -position[2]), `flat=${flat}`).toBeCloseTo(pause, 1)
      }
    })
  }

  it('keeps the title band on the eye line for any row count: the card’s top edge is fixed', () => {
    for (const rows of [1, 4, 8]) {
      const { position, scale } = optionsPlatePoseAt(rows, 0, false, 0)
      expect(position[1] + TOP_LOCAL_Y * scale, `${rows} rows`).toBeCloseTo(
        -PANEL_DROP + TOP_LOCAL_Y,
        12,
      )
    }
  })

  it('a phone uses the pause plate’s own fit, centred on the eye line (flat only)', () => {
    phoneUi.on = true
    try {
      const pose = optionsPlatePoseAt(8, 0, true, 0)
      const fit = pausePhoneFit(8, TITLE_M)
      expect(pose.scale).toBe(PAUSE_PHONE_SCALE)
      expect(pose.position).toEqual(pausePlateOffset(0, fit.lift))
      // Not in a headset, which a phone is not.
      expect(optionsPlatePoseAt(8, 0, false, 0).scale).toBe(1)
    } finally {
      phoneUi.on = false
    }
  })
})
