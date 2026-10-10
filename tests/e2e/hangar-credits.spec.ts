/**
 * DEV-857 (Matt, 2026-10-08): the hangar's OPTIONS table opens the pause
 * plate's own OPTIONS page, and BACK returns to the hangar. The credits are a
 * row of that page, rolled in the plate's body.
 *
 * Before it, DEV-832 made OPTIONS a step holding one CREDITS table, and
 * DEV-620 before that stood the credits 80 degrees off the left end. The first
 * step's five tables are centred on the eye now (DEV-858), OPTIONS in frame.
 *
 * Walked as a player walks it: the seat turned to the table, a held Enter, the
 * arrow keys down the page, B (Backspace) to back out one page and then out.
 */
import type { Page } from '@playwright/test'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { hangarAim, hold, pressDoor } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'
import { hangarDoors, toHangar } from './fixtures/title'

type PlateProbe = {
  page: string
  rows: { id: string }[]
  selected: number
  rolled: number | null
}

const plateOf = (page: Page): Promise<PlateProbe> =>
  page.evaluate(() =>
    (globalThis as unknown as { __ff2: { pausePlate: () => PlateProbe } }).__ff2.pausePlate(),
  )

/** Is the hangar's OPTIONS plate drawn in the room? Read off the scene by its name. */
const plateUp = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    type Obj = {
      name: string
      visible: boolean
      traverse: (f: (o: Obj) => void) => void
    }
    const stage = (globalThis as unknown as { __ff2: { stage: () => Obj } }).__ff2.stage()
    let up = false
    stage.traverse((o) => {
      if (o.name === 'hangar-options-plate' && o.visible) up = true
    })
    return up
  })

test.describe('@gpu the hangar OPTIONS table (DEV-857)', () => {
  test.setTimeout(240_000)

  test('OPTIONS is in frame with the other four, opens the pause OPTIONS page, CREDITS rolls, BACK returns', async ({
    page,
  }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    // The splash is gone before the first press, as `toTheTitleRows` does it (DEV-872): a
    // press made inside its hold is swallowed as the skip, and the START that follows then
    // lands on a title that never left.
    await bootReady(page, 240_000)
    await firstPress(page)
    await dropFocus(page)
    await toHangar(page)
    const doors = await hangarDoors(page)
    expect(doors[0], 'OPTIONS is the first table').toBe('options')
    // At rest the pointer is on the home table, FLY (id single-player).
    expect((await hangarAim(page))?.aimName).toBe('single-player')

    await pressDoor(page, 'options')
    await expect.poll(() => plateUp(page), { message: 'the plate stands in the hangar' }).toBe(true)
    // The room did not descend a step: the plate is over the first step.
    expect((await hangarAim(page))?.view).toBe('doors')
    const options = await plateOf(page)
    expect(options.page, 'the pause plate OPTIONS page').toBe('options')
    // DEV-859: the first page holds the settings and the doors; CREDITS is on MORE.
    const ids = options.rows.map((r) => r.id)
    for (const id of ['comfort', 'controls', 'more', 'back'])
      expect(ids, `the OPTIONS page has ${id}`).toContain(id)

    // One short tap per row, reading the aim between: a held key steps more than
    // one row, and the gaze can re-aim the plate, so step toward the row, not by count.
    const aimAtRow = async (id: string): Promise<void> => {
      for (let i = 0; i < 24; i++) {
        const now = await plateOf(page)
        const want = now.rows.findIndex((r) => r.id === id)
        if (now.selected === want) return
        const key = now.selected < want ? 'ArrowDown' : 'ArrowUp'
        await page.keyboard.down(key)
        await page.waitForTimeout(40)
        await page.keyboard.up(key)
        await page.waitForTimeout(250)
      }
    }
    await aimAtRow('more')
    await hold(page, 'Enter')
    await expect.poll(async () => (await plateOf(page)).page).toBe('more')
    await aimAtRow('credits')
    await hold(page, 'Enter')
    await expect.poll(async () => (await plateOf(page)).page).toBe('credits')
    await page.screenshot({ path: 'test-results/hangar-options-credits.png' })
    const rolled = (await plateOf(page)).rolled
    await page.waitForTimeout(1_000)
    expect((await plateOf(page)).rolled, 'and it rolls').not.toBe(rolled)

    // B goes back a page at a time (credits, MORE, OPTIONS), then out to the hangar.
    await hold(page, 'Backspace')
    await expect.poll(async () => (await plateOf(page)).page).toBe('more')
    await hold(page, 'Backspace')
    await expect.poll(async () => (await plateOf(page)).page).toBe('options')
    expect(await plateUp(page), 'still up on the OPTIONS page').toBe(true)
    await hold(page, 'Backspace')
    await expect.poll(() => plateUp(page), { message: 'the plate goes' }).toBe(false)
    expect((await hangarAim(page))?.view, 'back on the first step').toBe('doors')
    expect((await hangarAim(page))?.aimName).not.toBeNull()
  })
})
