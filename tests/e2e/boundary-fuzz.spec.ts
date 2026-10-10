/**
 * The out-of-bounds static, photographed at three marks of the countdown.
 *
 * A capture tool in `anniversary-ab.spec.ts`'s mould, not a gate: it saves
 * frames somewhere Playwright does NOT wipe and asserts only that each frame
 * was taken at the progress it was asked for. The person looking at them is
 * the judge (hard rule 9); DEV-127's row says what to look for — the static
 * comes in from the corners, the centre and the RETURN banner stay readable
 * until the final second.
 *
 * It runs ONLY when `FUZZ_DIR` is set, because it costs a launch, a flight and
 * a 13 s countdown, and the assertion that the term is live already rides on
 * `fade.spec.ts`'s boundary death.
 *
 *   FUZZ_DIR=<dir> FUZZ_AT=0.25,0.75,0.95 E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/boundary-fuzz.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

const FUZZ_DIR = process.env.FUZZ_DIR
const FUZZ_AT = (process.env.FUZZ_AT ?? '0.25,0.75,0.95').split(',').map(Number)
const FUZZ_EDITION = process.env.FUZZ_EDITION ?? 'anniversary'

interface BoundaryProbe {
  phase: string
  outsideFor: number
  progress: number
  fuzz: number
}

const boundaryOf = async (page: Page): Promise<BoundaryProbe | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.boundary() ?? null)

const elapsedOf = async (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0)

test.describe('@gpu the out-of-bounds static at three marks', () => {
  test.skip(!FUZZ_DIR, 'set FUZZ_DIR to capture the frames')
  test.setTimeout(300_000)

  test(`int_01_hoverJet, ${FUZZ_EDITION}, at ${FUZZ_AT.join(' / ')} of the countdown`, async ({
    page,
  }, testInfo) => {
    await page.goto(
      `/?mission=int_01_hoverJet&xr=off&title=0&menu=0&autopilot=1&edition=${FUZZ_EDITION}`,
    )
    await firstPress(page)
    await missionReady(page, 180_000)
    await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
    await focusCanvas(page)
    await expect
      .poll(async () => elapsedOf(page), { timeout: 120_000, intervals: [500] })
      .toBeGreaterThan(3)

    // 12 km out, as `fade.spec.ts` does and for the same reason: the autopilot
    // cannot fly back inside the 13 s and cancel the clock.
    await page.evaluate(() => {
      const jet = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.flight()
      if (jet) jet.jet.body.position.x += 12_000
    })

    const dir = FUZZ_DIR as string
    fs.mkdirSync(dir, { recursive: true })
    for (const mark of FUZZ_AT) {
      await expect
        .poll(async () => (await boundaryOf(page))?.progress ?? 0, {
          timeout: 30_000,
          intervals: [50],
        })
        .toBeGreaterThanOrEqual(mark)
      const b = await boundaryOf(page)
      expect(b?.phase).toBe('warning')
      // Taken inside a tenth of the countdown of the mark: the poll's 50 ms is
      // 0.004 of a 13 s clock, and the screenshot itself is the slow part.
      expect(b?.progress ?? 0).toBeLessThan(mark + 0.1)
      const shot = await page.locator('#viewport').screenshot()
      const name = `int_01-${FUZZ_EDITION}-fuzz-${Math.round(mark * 100)}pct.png`
      const shotPath = path.join(dir, name)
      fs.writeFileSync(shotPath, shot)
      await testInfo.attach(name, { body: shot, contentType: 'image/png' })
      testInfo.annotations.push({
        type: 'screenshot',
        description: `${shotPath} — progress ${(b?.progress ?? 0).toFixed(3)}, fuzz ${(b?.fuzz ?? 0).toFixed(3)}`,
      })
    }
  })
})
