// tests/unit/phone-floor.test.ts: DEV-894's floor, pinned.
//
// The floor is the thing somebody has to edit on purpose, so its VALUE is asserted
// here once, and the e2e sweep's own copies (a spec imports nothing from src by
// value) are read as text and compared to it.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANEL_DROP, panelHeight, TITLE_M, TOP_LOCAL_Y } from '@/render/pause'
import {
  PAUSE_PHONE_SCALE,
  PHONE_MIN_BODY_TEXT_PX,
  PHONE_MIN_SMALL_TEXT_PX,
  PHONE_MIN_TAP_PX,
  pausePhoneFit,
  phonePlateBoost,
} from '@/render/phone-floor'
import { REPO } from './helpers/repo-root'

describe('the phone floor (DEV-894)', () => {
  it('pins the three numbers', () => {
    expect(PHONE_MIN_BODY_TEXT_PX).toBe(12)
    expect(PHONE_MIN_SMALL_TEXT_PX).toBe(9)
    expect(PHONE_MIN_TAP_PX).toBe(32)
  })

  it('the e2e sweep measures against the same numbers', () => {
    const spec = fs.readFileSync(path.join(REPO, 'tests/e2e/phone-plates.spec.ts'), 'utf8')
    const read = (name: string): number =>
      Number(new RegExp(`const ${name} = (\\d+)`).exec(spec)?.[1])
    expect(read('MIN_BODY_TEXT_PX')).toBe(PHONE_MIN_BODY_TEXT_PX)
    expect(read('MIN_SMALL_TEXT_PX')).toBe(PHONE_MIN_SMALL_TEXT_PX)
    expect(read('MIN_TAP_PX')).toBe(PHONE_MIN_TAP_PX)
  })

  it('a plate under the floor is lifted to it, never shrunk, and a capped one stops at the cap', () => {
    expect(phonePlateBoost(7.3, 12)).toBeCloseTo(12 / 7.3, 9)
    expect(phonePlateBoost(13, 12)).toBe(1)
    expect(phonePlateBoost(1, 12)).toBe(2.4)
    expect(phonePlateBoost(1, 12, 5)).toBe(5)
  })

  it("the pause plate's phone scale lifts what the Pixel 7 sweep measured over the floor", () => {
    // Measured at scale 1 on 915 x 412 (the sweep's first run): body 7.3 px, notes 5.2, rows 20.5 apart.
    expect(7.3 * PAUSE_PHONE_SCALE).toBeGreaterThanOrEqual(PHONE_MIN_BODY_TEXT_PX)
    expect(5.2 * PAUSE_PHONE_SCALE).toBeGreaterThanOrEqual(PHONE_MIN_SMALL_TEXT_PX)
    expect(20.5 * PAUSE_PHONE_SCALE).toBeGreaterThanOrEqual(PHONE_MIN_TAP_PX)
  })

  it("the pause fit centres the plate's middle on the eye line, for any row count", () => {
    for (const rows of [3, 4, 8]) {
      const { scale, lift } = pausePhoneFit(rows)
      // The plate's origin hangs PANEL_DROP below the eye; the lift moves it up by `lift`.
      const originY = -PANEL_DROP + lift
      const middle = originY + (TOP_LOCAL_Y - panelHeight(rows, TITLE_M) / 2) * scale
      expect(middle, `${rows} rows`).toBeCloseTo(0, 9)
    }
  })
})
