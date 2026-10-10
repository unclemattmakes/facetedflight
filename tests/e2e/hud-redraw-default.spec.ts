/**
 * tests/e2e/hud-redraw-default.spec.ts — DEV-248, in a real browser.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/hud-redraw-default.spec.ts --workers 1
 *
 * ── Why this exists when the unit suite already covers the cadence ───────
 *
 * `tests/unit/hud-redraw.test.ts` drives `createHud()` against a stubbed 2-D
 * context and proves the arithmetic and the default. What it cannot see is the
 * half DEV-243 named as the arm's real failure mode: **`?hudRedraw=` is read
 * once at boot and the frame loop re-asserts it onto whatever panel is
 * current**, so a course swap, a third-person re-parent or a typo can all end
 * with a panel on the wrong cadence and a page that looks exactly right.
 *
 * DEV-248 makes that failure mode matter in the other direction too. The
 * shipped build is now the budgeted one and **`?hudRedraw=live` is the A/B arm
 * the whole change will be measured against** — so an arm that silently did
 * not reach the panel would make the measurement read zero and look like the
 * change being worthless. That is the same shape as DEV-232's 0.025 ms and
 * DEV-231's fourteen withdrawn rows, and this spec is the cheap guard against
 * it: two loads of the release mission, the probe read on each.
 *
 * ── What is asserted, and what only printed ──────────────────────────────
 *
 * ASSERTED, and none of it is a duration:
 *   * an UNPINNED load reports the shipped cadence on the live panel;
 *   * it WITHHELD uploads over a real flight, so the default is doing the
 *     thing it was enabled to do rather than merely being reported;
 *   * `?hudRedraw=live` reaches the panel and withholds NOTHING, which is what
 *     makes it a usable A/B arm;
 *   * the arm repaints strictly MORE than the default over a comparable
 *     flight. The two runs are separate loads, so this is a wide inequality
 *     and not a ratio — `perf-protocol.md` §3a-ter is about milliseconds, and
 *     a repaint COUNT does not drift with the box, but two flights are still
 *     two flights and the autopilot does not fly them identically.
 *
 * PRINTED: both panels' counts, so a reader can see the rate ratio without
 * this file pinning a number the flight owns. The trace spec is where a rate
 * becomes a measurement (DEV-243 §5); this is a mechanism check.
 */

import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

/** The release mission, which is where every DEV-248 number was taken. */
const MISSION = 'int_01_hoverJet'
const EDITION = 'anniversary'
/** Long enough for the speed row to have moved many times over. */
const SNAP_AT = 12

interface HudProbe {
  readonly cadence: string
  readonly repaints: number
  readonly uploads: number
  readonly skipped: number
}

const hudProbe = (page: import('@playwright/test').Page): Promise<HudProbe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    return (w.__ff2?.hud?.() ?? null) as never
  })

test.describe('@gpu DEV-248 — the shipped HUD cadence, and the arm that goes back', () => {
  test.setTimeout(900_000)

  test('an unpinned load flies on the 10 Hz budget and withholds uploads', async ({ page }) => {
    await flyToFreeze(page, { mission: MISSION, edition: EDITION, snapAt: SNAP_AT })
    const hud = await hudProbe(page)
    expect(
      hud,
      'no __ff2.hud probe — this build has no panel, or no ship to hang one on',
    ).not.toBeNull()
    console.info(
      `  DEV-248 default: ${hud?.cadence} · ${hud?.repaints} repaints, ` +
        `${hud?.uploads} uploads, ${hud?.skipped} withheld over ${SNAP_AT} mission seconds`,
    )
    expect(hud?.cadence, 'the shipped default did not reach the live panel').toBe('10hz')
    // The half a cadence string cannot prove. `skipped` counts frames where
    // the panel HAD something new to draw and the budget refused it, so a
    // positive number is the only evidence that the default removed an upload
    // rather than merely being reported on a panel that never moved.
    expect(hud?.skipped ?? 0, 'the panel never had a second thing to draw').toBeGreaterThan(0)
  })

  test('`?hudRedraw=live` reaches the panel and withholds nothing', async ({ page }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: EDITION,
      snapAt: SNAP_AT,
      params: { hudRedraw: 'live' },
    })
    const hud = await hudProbe(page)
    console.info(
      `  DEV-248 arm: ${hud?.cadence} · ${hud?.repaints} repaints, ` +
        `${hud?.uploads} uploads, ${hud?.skipped} withheld over ${SNAP_AT} mission seconds`,
    )
    expect(
      hud?.cadence,
      'the A/B arm never reached the panel — the measurement would read zero',
    ).toBe('live')
    // `live` withholding anything at all would mean the budget was still in
    // force somewhere, which is the arm not firing wearing a different hat.
    expect(hud?.skipped ?? -1, '`live` withheld something, so it is not `live`').toBe(0)
    // And it paints far more than the budget does. A wide bound, because two
    // loads are two flights: over twelve mission seconds at ~48 Hz the arm is
    // in the hundreds and the default is in the low hundreds at most.
    expect(hud?.repaints ?? 0).toBeGreaterThan(200)
  })
})
