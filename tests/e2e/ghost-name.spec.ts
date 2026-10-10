/**
 * The ghost, named where it happens. DEV-856.
 *
 * A first-time player never finds the ghost, because nothing names it. So:
 *
 *   1. The first Ring Attack lap finishes and is saved as the player's ghost:
 *      the YOUR LAP plate's keep row reads SAVED AS YOUR GHOST, with a line
 *      that it flies with them next time on this course. (Photographed.)
 *   2. The next run of that course: a label floats over the ghost ship,
 *      YOUR GHOST and its lap time. Fades with distance, and is a world
 *      sprite on layer 0 (both eyes; never the WebXR eye layers 1 and 2).
 *      (Photographed.)
 *
 * Flown the way a player does, from the title through the hangar
 * (`fixtures/hangar.ts`), the autopilot flying lap one; the second half is a
 * reload behind a chase view so the ghost is on screen.
 *
 *   GHOST_NAME_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/ghost-name.spec.ts
 *
 * Tagged `@gpu`. Pinned `adaptive=0&quality=high`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady, missionReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const OUT = process.env.GHOST_NAME_DIR ?? path.join('test-results-ghost')
const PIN_TAG = PINNED.replace(/[=&]/g, '')

interface Tag {
  text: string
  visible: boolean
  opacity: number
}
interface LapsReport {
  run: { tick: number; clock: number }
  last: { seconds: number | null } | null
  ghost: { seconds: number | null; visible: boolean; tag: Tag | null } | null
  stored: { seconds: number } | null
}
const laps = async (page: Page): Promise<LapsReport | null> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { laps: () => LapsReport | null } }).__ff2.laps() ?? null,
  )

interface AskRow {
  readonly id: string
  readonly label: string
  readonly value?: string
  readonly note?: string
}
const askRows = async (page: Page): Promise<readonly AskRow[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { share: () => { ask: { rows: readonly AskRow[] } | null } }
        }
      ).__ff2.share().ask?.rows ?? [],
  )

const shoot = async (page: Page, name: string): Promise<void> => {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-${PIN_TAG}.png`)
  fs.writeFileSync(file, await page.locator('#viewport').screenshot())
  console.info(`ghost-name: ${file}`)
}

test.describe('@gpu the ghost, named where it happens (DEV-856)', () => {
  test.setTimeout(900_000)

  test('a saved first lap says so; the next run labels the ghost', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.goto(`/?xr=off&${PINNED}&edition=anniversary`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __ff2?: { titleMenu?: () => { up: boolean } | null }
                }
              ).__ff2?.titleMenu?.()?.up ?? false,
          ),
        { timeout: 60_000 },
      )
      .toBe(true)
    await pressTitleRow(page, TITLE_ROW.hangar)
    await board(page, INT_01_HOVERJET, 1_000)
    expect((await laps(page))?.ghost, 'a fresh browser has no ghost to name').toBeNull()

    // ── lap one, by the autopilot (which keeps nothing unasked, DEV-601) ──
    await hold(page, 'KeyP', 300)
    await page.waitForSelector('body[data-finished="true"]', { timeout: 240_000 })
    await expect
      .poll(async () => (await askRows(page)).length, { message: 'the plate is up' })
      .toBeGreaterThan(1)
    const before = (await askRows(page)).find((r) => r.id === 'lap-keep')
    expect(before?.label, 'unasked, it is still a question').toBe('Save as your ghost?')
    // Walk to the row and say yes, the way a player does.
    for (let i = 0; i < 8; i++) {
      const aim = await page.evaluate(
        () =>
          (
            globalThis as unknown as { __ff2: { share: () => { ask: { aim: string | null } } } }
          ).__ff2.share().ask.aim,
      )
      if (aim === 'lap-keep') break
      const rows = await askRows(page)
      const want = rows.findIndex((r) => r.id === 'lap-keep')
      const now = rows.findIndex((r) => r.id === aim)
      await hold(page, want < now ? 'ArrowUp' : 'ArrowDown', 250)
    }
    await hold(page, 'Enter')
    await expect
      .poll(async () => (await askRows(page)).find((r) => r.id === 'lap-keep')?.label)
      .toBe('Saved as your ghost')
    const saved = (await askRows(page)).find((r) => r.id === 'lap-keep')
    expect(saved?.value).toBe('Yes') // the note is in the unit test: the probe carries no notes
    await page.waitForTimeout(3_600)
    await shoot(page, 'results-saved-as-your-ghost')
    const lapSeconds = (await laps(page))?.stored?.seconds ?? null
    expect(lapSeconds).not.toBeNull()

    // ── the next run: the ghost carries its name ─────────────────────────
    //
    // An idle ship is left 300 m behind in a second and the tag, which fades out
    // past 300 m, would be gone before a frame could be taken.
    await page.goto(`/?mission=int_01_hoverJet&menu=0&ride=0&xr=off&edition=anniversary&${PINNED}`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await missionReady(page, 240_000)
    const aboard = await laps(page)
    expect(aboard?.ghost?.tag?.text).toBe(`YOUR GHOST ${(lapSeconds as number).toFixed(1)}`)
    await hold(page, 'Enter', 0)
    await expect
      .poll(async () => (await laps(page))?.run.tick ?? -1, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(0)
    // A beat behind the ghost, which flew this same line: the autopilot takes
    // over a moment after GO, so the ghost stays ahead and in view instead of
    // flying exactly where the ship is.
    await page.waitForTimeout(600)
    await hold(page, 'KeyP', 300)
    let shots = 0
    for (let i = 0; i < 200 && shots < 3; i++) {
      await page.waitForTimeout(120)
      const t = (await laps(page))?.ghost?.tag ?? null
      if (t?.visible && t.opacity > 0.5) {
        await shoot(page, `flight-ghost-label-${shots}`)
        shots += 1
        await page.waitForTimeout(600)
      }
    }
    expect(shots, 'the tag is drawn while the ghost is in view').toBeGreaterThan(0)
    expect(problems.list(), 'page errors').toEqual([])
  })
})
