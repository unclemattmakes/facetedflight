/**
 * The same frame, twice — Classic beside Anniversary at one sim tick.
 *
 * docs/plan/ANNIVERSARY.md §7: every visual proposal wants a before/after that
 * differs in NOTHING but the preset. `?autopilot=1` is deterministic and
 * `?snap=<s>` freezes the sim at a mission-clock mark (WP-E), so two loads of
 * one URL that differ only in `?edition=` are the same moment under two
 * presets. This spec takes both, saves them somewhere Playwright does NOT wipe
 * (CLAUDE.md: `test-results/` is cleared at the start of every run, so an A/B
 * across two runs loses its first half), and asserts only that each frame was
 * taken at the mark it was asked for.
 *
 * It is a capture tool, not a gate: no pixel diff, no golden. The person
 * looking at the pair is the judge (hard rule 9), and what they are looking for
 * is written in each feature's DEV row.
 *
 *   AB_DIR=<dir> AB_AT=20 AB_MISSION=int_01_hoverJet \
 *     E2E_PORT=<yours> pnpm exec playwright test tests/e2e/anniversary-ab.spec.ts
 *
 * Tagged `@gpu` with the rest of the flying specs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

const AB_DIR = process.env.AB_DIR ?? 'test-results/ab'
const AB_AT = Number(process.env.AB_AT ?? '20')
const AB_MISSION = process.env.AB_MISSION ?? 'int_01_hoverJet'
/**
 * The speed-effects comfort slider for the run: `off | light | full`. It is a
 * STORED setting with no URL switch (a comfort setting is the player's, not a
 * parameter), so the spec seeds the store before the page loads, the way a
 * returning player's browser would. Unset leaves the default (`light`).
 */
const AB_SPEEDFX = process.env.AB_SPEEDFX
/** Four fixed steps of slack — the freeze lands inside one step of the mark. */
const TOLERANCE = 0.05

interface Probe {
  elapsed: number
  frozen: boolean
  edition: string
}

const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        snap: () => { at: number | null; frozen: boolean }
        edition: { current: { id: string } }
      }
    }
    return {
      elapsed: w.__ff2?.mission.elapsed ?? 0,
      frozen: w.__ff2?.snap().frozen ?? false,
      edition: w.__ff2?.edition.current.id ?? '',
    }
  })) as Probe

/** Held, not tapped — `pause.spec.ts` says why. */
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

test.describe('@measure @gpu the same frame under both presets', () => {
  test.setTimeout(300_000)

  for (const edition of ['classic', 'anniversary'] as const) {
    test(`${AB_MISSION} at ${AB_AT} s — ${edition}`, async ({ page }, testInfo) => {
      if (AB_SPEEDFX) {
        await page.addInitScript((speedFx: string) => {
          localStorage.setItem('ff2.comfort.v1', JSON.stringify({ speedFx }))
        }, AB_SPEEDFX)
      }
      await page.goto(`/?autopilot=1&xr=off&snap=${AB_AT}&edition=${edition}&mission=${AB_MISSION}`)
      await firstPress(page)
      await missionReady(page, 180_000)
      await focusCanvas(page)
      await holdKey(page, 'Enter')

      await expect
        .poll(async () => (await probe(page)).frozen, { timeout: 150_000, intervals: [250] })
        .toBe(true)
      const p = await probe(page)
      expect(p.edition).toBe(edition)
      expect(p.elapsed).toBeGreaterThanOrEqual(AB_AT)
      expect(p.elapsed).toBeLessThan(AB_AT + TOLERANCE)

      // Let the render settle on the frozen state — the particles and the
      // waves run on wall time and a frame or two after the freeze is fine.
      await page.waitForTimeout(500)
      const shot = await page.locator('#viewport').screenshot()
      const name = `${AB_MISSION}-${AB_AT}s-${edition}.png`
      await testInfo.attach(name, { body: shot, contentType: 'image/png' })
      fs.mkdirSync(AB_DIR, { recursive: true })
      const shotPath = path.join(AB_DIR, name)
      fs.writeFileSync(shotPath, shot)
      testInfo.annotations.push({ type: 'screenshot', description: shotPath })
    })
  }
})
