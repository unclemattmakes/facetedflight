/**
 * tests/e2e/fixtures/keys.ts: held, not tapped, in one place.
 *
 * Every confirm in this game is a LEVEL read once a frame, so a press that
 * lands between two frames is a press nothing saw. That note was copied into
 * `lap.spec.ts`, `pause.spec.ts` and `walkthrough.spec.ts`, and about thirty
 * specs carried their own `hold` with it. The copies did not agree on how long
 * the key stays down or how long to wait after the release, and the numbers
 * are load-bearing in a menu walk (changing one has broken five helpers
 * before), so the timing is NOT defaulted here: every caller says its own.
 *
 * The settle after the release matters on its own. A second `hold` straight
 * after the first is only an EDGE if the game has had a frame to see the key
 * up; a settle of zero is legitimate for a caller that never presses twice in
 * a row, and is written as 0 so a reader can see it was chosen.
 */
import type { Page } from '@playwright/test'

export interface HoldTiming {
  /** How long the key stays down, ms. */
  readonly down: number
  /** How long to wait after the release, ms. */
  readonly settle: number
}

/** Press `key`, keep it down for `down` ms, release it, then wait `settle` ms. */
export const hold = async (page: Page, key: string, timing: HoldTiming): Promise<void> => {
  await page.keyboard.down(key)
  await page.waitForTimeout(timing.down)
  await page.keyboard.up(key)
  if (timing.settle > 0) await page.waitForTimeout(timing.settle)
}
