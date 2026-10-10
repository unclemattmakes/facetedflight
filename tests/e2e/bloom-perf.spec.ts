/**
 * What the bloom costs, on this monitor, at the canvas's own size.
 *
 * ANNIVERSARY.md §5 gives V2 a **Measure** column and §7 says frame time is how
 * we will know it worked. DEV-091's row needs two numbers a person can argue
 * with — the frame time and the draw calls — and a number nobody can reproduce
 * is the thing DEV-027 is a whole lesson about. So this is the recipe, kept,
 * rather than a figure typed into a row once.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/bloom-perf.spec.ts
 *
 * ── Why it flies to a `?snap=` mark and STOPS there ──────────────────────
 *
 * The first version of this measured Anniversary against Classic on two
 * separate flights and asserted that the bloom's draw calls were the difference.
 * Both halves of that were wrong, and the second one failed loudly, which is the
 * only reason the first was noticed:
 *
 *  * `renderer.info.render.calls` is a property of the FRAME, not of the build.
 *    Twenty seconds apart on one flight it read 174 and then 145, because the
 *    ship had flown somewhere with fewer chunks in view. A delta between two
 *    moments measures the moment.
 *  * Anniversary-against-Classic is the whole PRESET's cost — the detail ring,
 *    the props, the shadows — and the triangle counts differ by more than a
 *    million. Attributing that to the bloom would have been a made-up number in
 *    a ledger row.
 *
 * So: `?snap=<s>` freezes the sim and keeps rendering (the same switch
 * `anniversary-ab.spec.ts` takes its same-tick pair with), and the bloom is then
 * flipped ON and OFF **on that one frozen frame**, through `editionState.set` —
 * the same path the Edition page takes. One frame, one flag, an exact delta. It
 * also exercises the dispose the row promises: the composer is dropped on the
 * way out and rebuilt on the way back in, mid-flight, with the frame still
 * arriving.
 *
 * It is a CAPTURE TOOL, not a gate, the way `anniversary-ab.spec.ts` is: it
 * prints. There is no frame-time threshold here on purpose — a CI box, a laptop
 * on battery and Matt's desktop are three different machines, and the budget
 * that matters belongs to the Quest pass (§7).
 *
 * Tagged `@gpu` with the rest of the flying specs.
 */

import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

const MISSION = process.env.BLOOM_PERF_MISSION ?? 'int_01_hoverJet'
/** Mission seconds. 40 is `anniversary-ab.spec.ts`'s gate-pass frame. */
const SNAP_AT = Number(process.env.BLOOM_PERF_AT ?? '40')

interface Sample {
  readonly edition: string
  /** Milliseconds, over `boot/perf-recorder.ts`'s own 3 s window. */
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly frames: number
  /** `renderer.info.render` for the LAST frame drawn. */
  readonly calls: number
  readonly triangles: number
}

const read = async (page: import('@playwright/test').Page): Promise<Sample> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        perf: { stats: () => { p50Ms: number; p95Ms: number; maxMs: number; frames: number } }
        edition: { current: { id: string } }
        render: { renderer: { info: { render: { calls: number; triangles: number } } } }
      }
    }
    const s = w.__ff2?.perf.stats()
    const info = w.__ff2?.render.renderer.info.render
    return {
      edition: w.__ff2?.edition.current.id ?? '',
      // `FrameStats` is already in milliseconds (`boot/perf-recorder.ts`).
      p50: s?.p50Ms ?? 0,
      p95: s?.p95Ms ?? 0,
      max: s?.maxMs ?? 0,
      frames: s?.frames ?? 0,
      calls: info?.calls ?? 0,
      triangles: info?.triangles ?? 0,
    }
  })) as Sample

/**
 * Fly to the mark under the autopilot, then let the sim freeze there.
 *
 * `tests/e2e/fixtures/freeze.ts`, shared with `render-census.spec.ts` and
 * VR-PERF §5.9 H2's baseline gate: the same eight lines lived in two files
 * with their timeouts already diverged.
 */
const freeze = (page: import('@playwright/test').Page, edition: string): Promise<void> =>
  flyToFreeze(page, { mission: MISSION, edition, snapAt: SNAP_AT })

/**
 * Flip ONLY the bloom on the live preset, without leaving the frozen frame.
 *
 * `editionState.set` is the Edition page's own path, so this is the flip a
 * player makes rather than a back door — and `render/bloom.ts` drops the
 * composer on that subscription, which is the dispose the row promises.
 */
const setBloomEnabled = async (
  page: import('@playwright/test').Page,
  enabled: boolean,
): Promise<Sample> => {
  await page.evaluate((on: boolean) => {
    const w = globalThis as unknown as {
      __ff2?: {
        edition: {
          current: { render: { bloom: { enabled: boolean } } }
          setPreset: (e: unknown) => void
        }
      }
    }
    const e = w.__ff2?.edition.current
    if (!e) return
    w.__ff2?.edition.setPreset({
      ...e,
      render: { ...e.render, bloom: { ...e.render.bloom, enabled: on } },
    })
  }, enabled)
  await page.waitForTimeout(5000)
  return read(page)
}

const row = (label: string, s: Sample): string =>
  `  ${label.padEnd(24)} p50 ${s.p50.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms` +
  `  max ${s.max.toFixed(2)} ms  over ${String(s.frames).padStart(4)} frames` +
  `  draws ${String(s.calls).padStart(4)}  tris ${s.triangles}`

test.describe('@measure @gpu what the bloom costs: DEV-091', () => {
  test.setTimeout(600_000)

  test(`${MISSION} at ${SNAP_AT} s: one frozen frame, one flag`, async ({ page }) => {
    await freeze(page, 'anniversary')
    const on = await read(page)
    const off = await setBloomEnabled(page, false)
    const again = await setBloomEnabled(page, true)

    // Classic on the same frozen frame, for the preset-level context the row
    // also wants. It is a different flight and a different scene cost — that is
    // the whole preset, not this row.
    await freeze(page, 'classic')
    const classic = await read(page)

    for (const [label, s] of [
      ['bloom on', on],
      ['bloom off', off],
      ['on again', again],
      ['classic', classic],
    ] as const) {
      // A window with no frames in it is a measurement of nothing, and it would
      // print as a very fast game. FIVE, not a number near the typical count:
      // the first run of this asked for more than 30 and got exactly 30 once —
      // the window after a composer teardown can be short — and a capture tool
      // that goes red on its own subject's hitch is a capture tool nobody runs.
      // The count is PRINTED, so a thin window is visible rather than asserted.
      expect(s.frames, `${label} frames`).toBeGreaterThan(5)
      expect(s.calls, `${label} draw calls`).toBeGreaterThan(0)
    }
    expect(on.edition).toBe('anniversary')
    expect(classic.edition).toBe('classic')
    // The real assertions, and both are about ONE frozen frame, so a draw count
    // is comparable at all. Without them a regression that quietly disabled the
    // bloom would report a delightful saving and nobody would look.
    expect(
      on.calls - off.calls,
      'the composer adds passes, so bloom ON must draw more calls than bloom OFF',
    ).toBeGreaterThan(0)
    expect(again.calls, 'and the composer comes back after a dispose, on the same frame').toBe(
      on.calls,
    )

    console.info(
      `\nDEV-091 bloom cost — ${MISSION}, frozen at ${SNAP_AT} s, canvas size:\n` +
        `${row('anniversary, bloom on', on)}\n` +
        `${row('anniversary, bloom off', off)}\n` +
        `${row('anniversary, on again', again)}\n` +
        `${row('classic (other flight)', classic)}\n` +
        `  THE BLOOM'S OWN DELTA, one frozen frame, one flag:` +
        `  p50 ${(on.p50 - off.p50).toFixed(2)} ms` +
        `  p95 ${(on.p95 - off.p95).toFixed(2)} ms` +
        `  draws +${on.calls - off.calls}\n`,
    )
  })
})
