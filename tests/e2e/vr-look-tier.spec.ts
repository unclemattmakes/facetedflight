/**
 * tests/e2e/vr-look-tier.spec.ts: on AUTO, a headset wearing Anniversary is
 * handed `low`'s eye size at session start, and nothing else of `low`. DEV-931,
 * lever 1 of `docs/plan/ANNIVERSARY-VR-FRAMERATE.md`.
 *
 * The headset is IWER (`fixtures/emulated-xr.ts`): the page takes its real
 * ENTER VR path. IWER sizes its canvas from the window and ignores the scale it
 * is given, so the pixels cannot be the oracle here; what three was TOLD can.
 * The spec wraps `renderer.xr.setFramebufferScaleFactor` from outside after
 * boot, to record the calls and pass them through. It observes only: the game
 * calls the same function it always calls, at the same moment
 * (`applyBeforeSession`, just before `requestSession`).
 *
 * Three arms, each one load with nothing stored (so the tier and the look are
 * both AUTO), `adaptive=0` and no `quality=` pin, because a pin is a choice and
 * AUTO is what is under test:
 *
 *   `edition=anniversary`               0.7 (`low`'s), the report says `low`
 *   no look pin (AUTO: Classic in VR)   0.75 (`medium`'s)
 *   `edition=anniversary&vrLookTier=0`  0.75: the off pin
 *
 * and in every arm the CONTEXT is still multisampled: AUTO keeps the flat tier
 * at `high`, which is the half of `low` this lever does not take (the header of
 * `VR_AUTO_QUALITY_ANNIVERSARY` says why it cannot).
 *
 * Tagged `@gpu`.
 */
import type { Page } from '@playwright/test'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import { enterVr, loadSettled } from './fixtures/landing'
import { expect, test } from './fixtures/test'

interface Reading {
  readonly calls: number[]
  readonly tier: string
  readonly framebufferScale: number
  readonly antialias: boolean
}

type Ff2Xr = {
  __ff2?: {
    render: {
      renderer: {
        xr: { isPresenting: boolean; setFramebufferScaleFactor: (v: number) => void }
        getContext: () => WebGLRenderingContext
      }
      quality: { report: { quality: string; framebufferScale: number } }
    }
  }
  __vrScaleCalls?: number[]
}

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2Xr).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

const arm = async (page: Page, query: string): Promise<Reading> => {
  await installEmulatedXr(page, { fovyDeg: 90 })
  await page.goto(`/?title=0&adaptive=0${query}`)
  await loadSettled(page, 240_000)
  expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
  await page.evaluate(() => {
    const g = globalThis as unknown as Ff2Xr
    const xr = g.__ff2?.render.renderer.xr
    if (!xr) throw new Error('no __ff2.render.renderer.xr')
    const calls: number[] = []
    g.__vrScaleCalls = calls
    const through = xr.setFramebufferScaleFactor.bind(xr)
    xr.setFramebufferScaleFactor = (v: number) => {
      calls.push(v)
      through(v)
    }
  })
  await enterVr(page)
  await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
  return page.evaluate(() => {
    const g = globalThis as unknown as Ff2Xr
    const render = g.__ff2?.render
    if (!render) throw new Error('no __ff2.render')
    return {
      calls: [...(g.__vrScaleCalls ?? [])],
      tier: render.quality.report.quality,
      framebufferScale: render.quality.report.framebufferScale,
      antialias: render.renderer.getContext().getContextAttributes()?.antialias === true,
    }
  })
}

test.describe('@gpu AUTO in a headset: the eye follows the look (DEV-931)', () => {
  test.setTimeout(420_000)
  // 800 x 720 an eye: IWER sizes the canvas from the window.
  test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

  const cases = [
    { name: 'Anniversary', query: '&edition=anniversary', scale: 0.7, tier: 'low' },
    { name: 'AUTO look (Classic in a headset)', query: '', scale: 0.75, tier: 'medium' },
    {
      name: 'Anniversary with ?vrLookTier=0',
      query: '&edition=anniversary&vrLookTier=0',
      scale: 0.75,
      tier: 'medium',
    },
  ] as const

  for (const c of cases) {
    test(c.name, async ({ page }) => {
      const read = await arm(page, c.query)
      console.info(`VR-LOOK-TIER ${c.name}: ${JSON.stringify(read)}`)
      // Positive first: the session start pushed a scale at all.
      expect(read.calls.length, 'ENTER VR handed three a scale').toBeGreaterThan(0)
      expect(read.calls.at(-1), 'the scale the session was built at').toBeCloseTo(c.scale, 9)
      expect(read.framebufferScale, 'the report agrees').toBeCloseTo(c.scale, 9)
      expect(read.tier, 'the tier in force').toBe(c.tier)
      expect(read.antialias, 'the context is still multisampled: the flat tier is high').toBe(true)
    })
  }
})
