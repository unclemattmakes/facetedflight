/**
 * tests/e2e/hud-warm-pixels.spec.ts — DEV-250. The warm fires, and the panel
 * the player reads is byte-for-byte the panel they read without it.
 *
 *   E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/hud-warm-pixels.spec.ts --workers 1 --retries 0
 *
 * ── The two claims, and why neither is a duration ────────────────────────
 *
 * `?hudWarm=on` paints the HUD once at its FLIGHT layout under the loading
 * curtain and puts it in `warmWorld`'s draw, so the raster and the upload
 * happen while the frame is black (`docs/plan/HUD-REWORK.md` §4 candidate 1).
 * Whether that makes the release frame cheaper is a MILLISECOND, it belongs
 * to the coordinator on a quiet box, and nothing here reads a clock.
 *
 * What this spec settles is the pair of things a measurement cannot:
 *
 *  1. **The arm fires.** `warmPaints` is 1 under `on` and 0 under `off`. An
 *     arm that measured nothing would show as a small, believable delta, and
 *     `?hudWarm=` is parsed at boot with no runtime setter — there is no
 *     second chance to notice.
 *  2. **It changes no pixel at rest.** The panel's own canvas, read out of the
 *     live material at a frozen tick, must be IDENTICAL between the arms. The
 *     warm leaves a flight layout on the canvas that the first live `update()`
 *     immediately repaints to the launch banner, both under the curtain — but
 *     "immediately" rests on the warm bypassing the redraw budget, and a
 *     budget that swallowed the banner's repaint would leave the warm picture
 *     on the panel for part of the ride. That is a real regression and it is
 *     invisible in any screenshot taken after the curtain lifts.
 *
 * ── Why the CANVAS and not a screenshot of the frame ─────────────────────
 *
 * Because the panel's plates are 86 % opaque and the sea, the clouds and the
 * LOD cross-fades all keep moving under a `?snap=` (which freezes the SIM,
 * not the frame). A crop of the viewport therefore needs a quiet mask and a
 * three-shot bracket to say anything — which is what
 * `cockpit-order-pixels.spec.ts` does, and it is the right machinery when the
 * claim is about what the RENDERER drew.
 *
 * Here the claim is about what the PANEL drew, and that has an exact answer:
 * `material.map.image` is the 560 x 203 `HTMLCanvasElement` itself, and
 * `toDataURL()` is every one of its pixels with nothing else in front of
 * them. No mask, no threshold, no bracket, and a failure names the arm rather
 * than a pixel count somebody has to interpret.
 *
 * ── The tick has to match, and it is derivable ───────────────────────────
 *
 * The panel's content is a function of the frozen tick, so a pair that landed
 * on different ticks would differ for a reason that has nothing to do with the
 * arm. `missionTickOf` is `ceil(snapAt / dt)` recovered from the clock — the
 * same integer on every load whatever the launch ride did (`fixtures/freeze.ts`
 * has the measurement that made `sim().tick` the wrong key). The pair is
 * asserted equal, and a mismatch fails loudly rather than being compared
 * anyway: two arms at two ticks is the shape of a wrong answer that looks like
 * a right one.
 *
 * `?perf=1` is passed because `__ff2perf` — the surface `missionTickOf` reads
 * — exists only under it. It draws a SECOND canvas, which would muddy any
 * per-upload NUMBER and muddies nothing here: the HUD's own canvas is read
 * directly, and both arms carry the plate.
 */

import { flyToFreeze, frozenSim, missionTickOf } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

/** `rookie_01_hoverJet` is DEV-249's mission — the release frame was measured there. */
const MISSION = process.env.HUD_WARM_MISSION ?? 'rookie_01_hoverJet'
const EDITION = process.env.HUD_WARM_EDITION ?? 'anniversary'
/**
 * Far enough past the release that the panel is showing the three instrument
 * rows rather than the countdown — which is the layout the warm draws and
 * therefore the only one where a difference could exist.
 */
const SNAP_AT = Number(process.env.HUD_WARM_SNAP ?? '20')

interface Arm {
  readonly warmPaints: number
  readonly repaints: number
  readonly cadence: string
  /** The panel's own canvas, every pixel, as a PNG data URL. */
  readonly panel: string
  readonly missionTick: number
}

/**
 * The HUD's canvas, off the live material.
 *
 * `__ff2.stage()` is the scene on screen. The panel is the one object named
 * `hud`, and its `map.image` is the `HTMLCanvasElement` `createHud` made —
 * three keeps the element as the texture's source, so this is the same object
 * `draw()` writes into and not a copy of it.
 */
const panelPixels = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { stage: () => { traverse: (f: (o: unknown) => void) => void } }
    }
    let url: string | null = null
    let found = 0
    w.__ff2?.stage().traverse((o) => {
      const node = o as {
        name?: string
        material?: { map?: { image?: { toDataURL?: (t: string) => string } } }
      }
      if (node.name !== 'hud') return
      found += 1
      const image = node.material?.map?.image
      if (image && typeof image.toDataURL === 'function') url = image.toDataURL('image/png')
    })
    // More than one and the read is ambiguous; none and the panel is gone.
    // Either is a premise failure rather than a result, so it comes back null.
    return found === 1 ? url : null
  })

const readArm = async (page: Page, hudWarm: string): Promise<Arm> => {
  await flyToFreeze(page, {
    mission: MISSION,
    edition: EDITION,
    snapAt: SNAP_AT,
    // `adaptive=0&quality=high` on BOTH arms, and it is not decoration.
    // `render/quality.ts` measures the frame and drops a tier when the CPU is
    // starved, so on a contended box the build RECONFIGURES ITSELF mid-run and
    // what comes back describes a different build than the one under test
    // (`docs/testing/perf-protocol.md` §3a-quater; it cost this project a
    // whole worn flight on 2026-09-17). Nothing here is a duration, and that
    // is not enough on its own: a tier flip changes render scale and draw
    // counts, so an unpinned pair can differ for a reason that is about the
    // box rather than about the arm.
    params: { perf: '1', adaptive: '0', quality: 'high', hudWarm },
  })
  const report = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { hud: () => { warmPaints: number; repaints: number; cadence: string } | null }
    }
    return w.__ff2?.hud() ?? null
  })
  const sim = await frozenSim(page)
  const panel = await panelPixels(page)
  expect(
    report,
    `?hudWarm=${hudWarm}: __ff2.hud() answered nothing — no flight panel`,
  ).not.toBeNull()
  expect(sim, `?hudWarm=${hudWarm}: __ff2perf is absent — was ?perf=1 dropped?`).not.toBeNull()
  expect(
    panel,
    `?hudWarm=${hudWarm}: could not read exactly one panel canvas off the stage`,
  ).not.toBeNull()
  const r = report as NonNullable<typeof report>
  return {
    warmPaints: r.warmPaints,
    repaints: r.repaints,
    cadence: r.cadence,
    panel: panel as string,
    missionTick: missionTickOf(sim as NonNullable<typeof sim>),
  }
}

test.describe('@gpu DEV-250 — the warm fires and moves no pixel', () => {
  test.describe.configure({ mode: 'serial', timeout: 900_000 })

  test('?hudWarm=on warms once, and the panel is identical to ?hudWarm=off', async ({ page }) => {
    const off = await readArm(page, 'off')
    const on = await readArm(page, 'on')

    console.info(
      `\nDEV-250 ${MISSION} ${EDITION} @ snap ${SNAP_AT}\n` +
        `  off: warmPaints ${off.warmPaints} · ${off.repaints} repaints · ${off.cadence} · ` +
        `mission tick ${off.missionTick} · panel ${off.panel.length} B of data URL\n` +
        `  on : warmPaints ${on.warmPaints} · ${on.repaints} repaints · ${on.cadence} · ` +
        `mission tick ${on.missionTick} · panel ${on.panel.length} B of data URL`,
    )

    // ── the arm fired, and only on one side ───────────────────────────
    expect(
      off.warmPaints,
      'the CONTROL warmed the panel. `?hudWarm=off` must be the shipped path exactly.',
    ).toBe(0)
    expect(
      on.warmPaints,
      'THE ARM MEASURED NOTHING. `?hudWarm=on` did not reach `Hud.warm`, so any A/B taken\n' +
        'against it is two runs of the same build. Look for the console line\n' +
        '"hud: warm on (DEV-250)" and for "hud warmed at its flight layout" beside the\n' +
        'warm-up’s own line — the second is the one that says the PAINT happened.',
    ).toBe(1)

    // ── the pair is comparable ────────────────────────────────────────
    expect(
      on.missionTick,
      'the two arms froze on different mission ticks, so the panels below are showing\n' +
        'different readings and the comparison means nothing. `?snap=` fires on the first\n' +
        'fixed step at or past the mark and `boot/app.ts` lets a frame overshoot by one;\n' +
        're-run, and if it persists read fixtures/freeze.ts’s missionTickOf block.',
    ).toBe(off.missionTick)

    // ── and it moved no pixel ─────────────────────────────────────────
    //
    // Exact equality, not a threshold: this is the panel's own canvas with
    // nothing in front of it, both arms at the same tick, so anything but
    // identity is the warm having left something behind.
    expect(
      on.panel === off.panel,
      'THE WARM CHANGED THE PANEL. Every pixel of the 560 x 203 canvas is in this\n' +
        'comparison and the two arms are at the same mission tick, so the difference is\n' +
        'the warm. The likeliest cause is the first live `update()` having been\n' +
        'swallowed: `Hud.warm` must not pace the redraw budget and must not advance the\n' +
        'signature — tests/unit/hud-warm.test.ts has both as unit assertions.',
    ).toBe(true)

    // The panel really did repaint during the run, or "identical" is a fact
    // about two blank canvases. A frozen sim stops the signature moving, so
    // this counts the ride and the flight up to the mark.
    expect(
      off.repaints,
      'the panel never repainted, so the comparison above is between two pictures\n' +
        'nothing drew. Check the autopilot reached the flight at all.',
    ).toBeGreaterThan(1)
  })
})
