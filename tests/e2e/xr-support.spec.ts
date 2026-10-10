/**
 * tests/e2e/xr-support.spec.ts — `src/boot/xr-support.ts` under a real browser.
 *
 * The module is deliberately DOM-only (no three.js, no canvas), so the cheap
 * way to test it is to import it straight from the dev server inside the page
 * and call it. That is why these specs need the Vite dev server rather than a
 * built bundle: the module is fetched by its source path.
 *
 * Safe headless and on a GPU-less CI box.
 */

import { installFakeXr, installNoXr } from './fixtures/fake-xr'
import { expect, type Page, test } from './fixtures/test'

const MODULE_PATH = '/src/boot/xr-support.ts'

interface Report {
  secureContext: boolean
  hasXrApi: boolean
  immersiveVr: boolean
  blocker: string
  advice: string
  emulated: boolean
  error?: string
}

/** Import the helper inside the page and run it against whatever XR is there. */
const inspect = (page: Page): Promise<Report> =>
  page.evaluate(async (path) => {
    const mod = await import(/* @vite-ignore */ path)
    return (await mod.inspectXrSupport()) as Report
  }, MODULE_PATH)

test.describe('xr-support diagnostics', () => {
  test('reports the browser’s own WebXR honestly, and does not claim emulation', async ({
    page,
  }, testInfo) => {
    await page.goto('/')
    const report = await inspect(page)

    // Runs over https via basic-ssl, so this must hold or nothing else can.
    expect(report.secureContext).toBe(true)

    if (report.hasXrApi) {
      // A native `navigator.xr` stringifies as [object XRSystem]; the
      // emulation heuristic must not fire on it.
      expect(report.emulated).toBe(false)
      // No headset runtime on a test box, so: false or a rejection. Both are
      // non-fatal states, never 'no-webxr-api'.
      expect(['no-active-runtime', 'query-rejected', 'none']).toContain(report.blocker)
      testInfo.annotations.push({
        type: 'native-webxr',
        description: `navigator.xr present; blocker=${report.blocker}`,
      })
    } else {
      expect(report.blocker).toBe('no-webxr-api')
      expect(report.advice).toContain('Firefox')
      testInfo.annotations.push({
        type: 'native-webxr',
        description: 'this browser build exposes no navigator.xr',
      })
    }
  })

  test('with no navigator.xr, names the missing API rather than blaming the headset', async ({
    page,
  }) => {
    await page.addInitScript(installNoXr)
    await page.goto('/')
    const report = await inspect(page)

    expect(report.hasXrApi).toBe(false)
    expect(report.immersiveVr).toBe(false)
    expect(report.blocker).toBe('no-webxr-api')
    expect(report.emulated).toBe(false)
  })

  test('with the test double installed, reports support AND flags it as emulated', async ({
    page,
  }) => {
    await page.addInitScript(installFakeXr, { supported: true })
    await page.goto('/')
    const report = await inspect(page)

    expect(report.immersiveVr).toBe(true)
    expect(report.blocker).toBe('none')
    // The whole point: an emulated runtime must never be reported as a headset
    // in the room.
    expect(report.emulated).toBe(true)
    expect(report.advice).toContain('emulated')
  })

  test('a rejecting query is reported as query-rejected, not as a missing API', async ({
    page,
  }) => {
    await page.addInitScript(installFakeXr, { rejectQuery: true })
    await page.goto('/')
    const report = await inspect(page)

    expect(report.hasXrApi).toBe(true)
    expect(report.immersiveVr).toBe(false)
    expect(report.blocker).toBe('query-rejected')
    expect(report.error).toContain('fake-xr')
  })

  test('the shared session init asks for nothing it cannot live without', async ({ page }) => {
    await page.goto('/')
    const init = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)
      return mod.XR_SESSION_INIT as { requiredFeatures?: string[]; optionalFeatures?: string[] }
    }, MODULE_PATH)

    // A requiredFeatures entry the runtime does not implement fails the whole
    // session (research doc 09 §3.8.3). FF2 asks for nothing required.
    expect(init.requiredFeatures).toBeUndefined()
    expect(init.optionalFeatures).toContain('local-floor')
  })
})
