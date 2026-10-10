/**
 * tests/e2e/iwer-flat-frame.spec.ts — with an emulated headset attached, the
 * flat Anniversary frame is still a frame (DEV-330).
 *
 * ── What was wrong ───────────────────────────────────────────────────────
 *
 * Under IWER the flat Anniversary title rendered BLACK except for the bloom's
 * glow and the HUD (mean 24.6 of 255, against 138.2 without IWER). Classic was
 * fine, and so was Anniversary with bloom off. It was not the session warm-up
 * and not the app's reaction to a headset: with IWER reporting NO headset it
 * was still black. It was IWER's USER AGENT. The emulated Quest 3 says
 * `OculusBrowser`, three reads that as "invalidate a multisampled target's
 * colour after resolving it", and `UnrealBloomPass` composites the glow back
 * into that discarded colour. The same thing would happen to a visitor in a
 * Quest's 2D browser.
 *
 * Two fixes, and this spec holds both:
 *   · the GAME: `render/bloom.ts`'s `bloomSamplesFor` turns MSAA off on
 *     exactly the user agents three invalidates for (the Quest arm below);
 *   · the HARNESS: `fixtures/emulated-xr.ts` now keeps the browser's own UA by
 *     default, because the target is the Steam Frame on desktop Chrome, and a
 *     Quest UA put every emulated run on the Quest path (the default arm).
 *
 * ── The measurement ──────────────────────────────────────────────────────
 *
 * Mean brightness of the whole title frame, against a control load with no
 * IWER at all, taken in the same run. Black read 0.18x the control; a working
 * frame reads ~1.0x. The bound is 0.6x. Positive first: draw calls > 0.
 *
 * `@gpu`, and pinned (DEV-245).
 */

import { decodePng } from '../../tools/perf/png-diff.mjs'
import { installEmulatedXr } from './fixtures/emulated-xr'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

/** A working frame's brightness over the control's must stay above this. */
const RATIO_FLOOR = 0.6

const titleBrightness = async (page: Page, query: string): Promise<number> => {
  await page.goto(`/?edition=anniversary&${query}${PINNED}`)
  await firstPress(page)
  await expect(page.locator('body')).toHaveAttribute('data-title-ready', 'true', {
    timeout: 240_000,
  })
  await page.waitForTimeout(3_000)
  const calls = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { render: { calls: number } } } } }
        }
      ).__ff2.render.renderer.info.render.calls,
  )
  expect(calls, 'the frame drew something').toBeGreaterThan(0)
  const img = decodePng(await page.locator('#viewport').screenshot()) as {
    w: number
    h: number
    ch: number
    data: Uint8Array
  }
  let sum = 0
  for (let p = 0; p < img.w * img.h; p++) {
    const i = p * img.ch
    sum += ((img.data[i] as number) + (img.data[i + 1] as number) + (img.data[i + 2] as number)) / 3
  }
  return sum / (img.w * img.h)
}

test.describe('@gpu the flat Anniversary frame under an emulated headset (DEV-330)', () => {
  test.setTimeout(420_000)

  test('is a frame, with the browser’s own UA and with a Quest’s', async ({ browser }) => {
    const load = async (iwer: 'none' | 'desktop' | 'quest'): Promise<number> => {
      const page = await browser.newPage()
      try {
        if (iwer !== 'none') await installEmulatedXr(page, { questUserAgent: iwer === 'quest' })
        return await titleBrightness(page, iwer === 'none' ? 'xr=off&' : '')
      } finally {
        await page.close()
      }
    }
    const control = await load('none')
    const desktop = await load('desktop')
    const quest = await load('quest')
    console.info(
      `iwer-flat-frame: control ${control.toFixed(1)} · IWER desktop UA ${desktop.toFixed(1)} · ` +
        `IWER Quest UA ${quest.toFixed(1)}`,
    )
    expect(control, 'the control frame has light in it').toBeGreaterThan(40)
    expect(desktop / control, 'IWER with the browser’s UA').toBeGreaterThan(RATIO_FLOOR)
    expect(quest / control, 'IWER with a Quest UA — the bloom guard').toBeGreaterThan(RATIO_FLOOR)
  })
})
