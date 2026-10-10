/**
 * DEV-881, DEV-882 and DEV-884: the OPTIONS plates in the hangar and on the
 * title, and the room's hover, as a player on a flat screen meets them.
 *
 * The 2026-10-09 agent playtest: the title's CREDITS drew BACK and nothing else;
 * the hangar's and the title's OPTIONS plates were half the pause plate's size,
 * took no cursor clicks, and the hangar's arrow keys tipped the view instead of
 * stepping the rows; a first visit rested on the middle flight plan with its
 * note on the first; the mouse lit nothing in the room.
 *
 * Geometry is asserted as geometry (the rows' pitch against the glass), as
 * `pause-phone.spec.ts` argues for its rule, and the pause plate's own pitch,
 * about 5 percent of the glass height a row, is the bar: the page is the same
 * card at another distance (`render/options-plate-pose.ts`).
 */
import type { Page } from '@playwright/test'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2Global } from './fixtures/ff2'
import {
  hangarAim,
  hangarOn,
  hold,
  lookUntilAimed,
  pressDoor,
  throughVariants,
} from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'
import {
  aimTitleRow,
  hangarDoors,
  pressTitleRow,
  titleMenu,
  titleRowsUp,
  toAircraft,
  toHangar,
} from './fixtures/title'

/** The pause plate's row pitch is 0.0499 of the glass height (36 px of 720); the bar sits a little under. */
const MIN_PITCH_OF_GLASS = 0.045

const glassHeight = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelector('canvas')?.getBoundingClientRect().height ?? 0)

const pitchOf = (rowsAt: readonly { y: number }[]): number =>
  ((rowsAt[rowsAt.length - 1]?.y ?? 0) - (rowsAt[0]?.y ?? 0)) / Math.max(1, rowsAt.length - 1)

/** Where a door's table stands on the glass, CSS pixels (its gaze centre), or null. */
const tableOnGlass = (page: Page, door: string): Promise<{ x: number; y: number } | null> =>
  page.evaluate((id) => {
    type Mat = { elements: number[] }
    type Obj = {
      userData: Record<string, unknown>
      matrixWorld: Mat
      updateWorldMatrix: (up: boolean, down: boolean) => void
      traverse: (f: (o: Obj) => void) => void
    }
    const ff = (globalThis as unknown as Ff2Global).__ff2
    const stage = ff.stage() as unknown as Obj
    let at: [number, number, number] | null = null
    stage.traverse((o) => {
      if (o.userData.door !== id || at !== null) return
      o.updateWorldMatrix(true, false)
      const m = o.matrixWorld.elements
      // The table's gaze centre: 0.55 m above its origin, up the world's y.
      at = [m[12] ?? 0, (m[13] ?? 0) + 0.55, m[14] ?? 0]
    })
    if (at === null) return null
    const cam = ff.render.camera as unknown as {
      matrixWorldInverse: Mat
      projectionMatrix: Mat
      updateWorldMatrix: (up: boolean, down: boolean) => void
    }
    cam.updateWorldMatrix(true, false)
    const v = cam.matrixWorldInverse.elements
    const q = cam.projectionMatrix.elements
    const [x, y, z] = at as [number, number, number]
    const ex = (v[0] ?? 0) * x + (v[4] ?? 0) * y + (v[8] ?? 0) * z + (v[12] ?? 0)
    const ey = (v[1] ?? 0) * x + (v[5] ?? 0) * y + (v[9] ?? 0) * z + (v[13] ?? 0)
    const ez = (v[2] ?? 0) * x + (v[6] ?? 0) * y + (v[10] ?? 0) * z + (v[14] ?? 0)
    const cx = (q[0] ?? 0) * ex + (q[4] ?? 0) * ey + (q[8] ?? 0) * ez + (q[12] ?? 0)
    const cy = (q[1] ?? 0) * ex + (q[5] ?? 0) * ey + (q[9] ?? 0) * ez + (q[13] ?? 0)
    const cw = (q[3] ?? 0) * ex + (q[7] ?? 0) * ey + (q[11] ?? 0) * ez + (q[15] ?? 0)
    const rect = document.querySelector('canvas')?.getBoundingClientRect()
    if (!rect || cw <= 0) return null
    return {
      x: rect.left + ((cx / cw + 1) / 2) * rect.width,
      y: rect.top + ((1 - cy / cw) / 2) * rect.height,
    }
  }, door)

const hangarOptions = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.hangarOptions())

const pausePlate = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.pausePlate())

/** The camera's world yaw and local pitch, radians. */
const view = (page: Page): Promise<{ yaw: number; pitch: number }> =>
  page.evaluate(() => {
    const cam = (globalThis as unknown as Ff2Global).__ff2.render.camera
    cam.updateWorldMatrix(true, false)
    const m = cam.matrixWorld.elements
    return { yaw: Math.atan2(-(m[8] ?? 0), m[10] ?? 0), pitch: cam.rotation.x }
  })

test.describe('@gpu the OPTIONS plates and the room hover (DEV-881, 882, 884)', () => {
  test.setTimeout(300_000)

  test('the title: pause-plate size, cursor hover and click, arrow steps, and a CREDITS that rolls', async ({
    page,
  }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await dropFocus(page)
    await pressTitleRow(page, 'options')
    const opened = await titleRowsUp(page)
    expect(opened.rows, 'the OPTIONS page is on the title').toContain('more')
    const glass = await glassHeight(page)
    expect(pitchOf(opened.rowsAt ?? []) / glass, 'rows are the pause plate size').toBeGreaterThan(
      MIN_PITCH_OF_GLASS,
    )

    // The arrow keys step the rows (the plate is centred on the view, so the gaze must not hold the aim).
    await aimTitleRow(page, 'comfort')
    expect((await titleMenu(page))?.selected).toBe(opened.rows.indexOf('comfort'))

    // A free cursor over a row aims it; a click on that row presses it.
    const more = opened.rows.indexOf('more')
    const at = (await titleMenu(page))?.rowsAt?.[more]
    expect(at, 'the plate says where MORE is').toBeTruthy()
    if (at) {
      await page.mouse.move(at.x - 20, at.y)
      await page.mouse.move(at.x, at.y)
      await expect.poll(async () => (await titleMenu(page))?.selected).toBe(more)
      await page.mouse.click(at.x, at.y)
    }
    await expect.poll(async () => (await titleMenu(page))?.rows).toContain('credits')

    // CREDITS: the roll, 2016's credits first, over its one BACK row.
    await aimTitleRow(page, 'credits')
    await hold(page, 'Enter')
    await expect.poll(async () => (await titleMenu(page))?.rows).toEqual(['back'])
    const rolled = (await pausePlate(page)).rolled
    expect(rolled, 'the roll is built').not.toBeNull()
    await page.waitForTimeout(1_200)
    expect((await pausePlate(page)).rolled, 'and it rolls').not.toBe(rolled)

    // BACK, back, back: out to the title's own rows.
    for (let i = 0; i < 3; i++) await hold(page, 'Backspace')
    await expect.poll(async () => (await titleMenu(page))?.rows).toContain('hangar')
  })

  test('the hangar: pause-plate size, hover and click on rows, arrows step and do not tip the view', async ({
    page,
  }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await dropFocus(page)
    await toHangar(page)
    expect(await hangarDoors(page)).toContain('options')
    await pressDoor(page, 'options')
    await expect.poll(async () => (await hangarOptions(page)).up).toBe(true)
    await page.waitForTimeout(500)
    const first = await hangarOptions(page)
    const glass = await glassHeight(page)
    expect(pitchOf(first.rowsAt ?? []) / glass, 'rows are the pause plate size').toBeGreaterThan(
      MIN_PITCH_OF_GLASS,
    )
    expect(first.selected, 'the page opens on its first row').toBe(0)

    // The arrow keys step the rows and leave the view where it was.
    const before = await view(page)
    await hold(page, 'ArrowDown', 300)
    await hold(page, 'ArrowDown', 300)
    const after = await view(page)
    expect((await hangarOptions(page)).selected, 'two rows down').toBe(2)
    expect(Math.abs(after.pitch - before.pitch), 'the view did not tip').toBeLessThan(1e-6)
    expect(Math.abs(after.yaw - before.yaw), 'the view did not turn').toBeLessThan(1e-6)

    // A free cursor aims a row; a click presses it (MORE, the page's seventh row).
    const rows = (await hangarOptions(page)).rowsAt ?? []
    const more = 6
    const target = rows[more]
    expect(target, 'the plate says where MORE is').toBeTruthy()
    if (target) {
      await page.mouse.move(target.x - 30, target.y)
      await page.mouse.move(target.x, target.y)
      await expect.poll(async () => (await hangarOptions(page)).selected).toBe(more)
      await page.mouse.click(target.x, target.y)
    }
    await expect.poll(async () => (await pausePlate(page)).page).toBe('more')

    // Back out of the plate.
    for (let i = 0; i < 2; i++) await hold(page, 'Backspace')
    await expect.poll(async () => (await hangarOptions(page)).up).toBe(false)
    expect((await hangarAim(page))?.view).toBe('doors')
  })

  test('the room hover: a free cursor lights the table under it, and a turn hands the aim back to the nose', async ({
    page,
  }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await dropFocus(page)
    await toHangar(page)
    // At rest SINGLE PLAYER is under the nose.
    expect((await hangarAim(page))?.aimName, 'rest: SINGLE PLAYER under the pointer').toBe(
      'single-player',
    )
    // Park the cursor over MULTIPLAYER, a table the nose is not on: it is the aimed one.
    const over = await tableOnGlass(page, 'multiplayer')
    expect(over, 'MULTIPLAYER is in the frame').toBeTruthy()
    if (over) {
      await page.mouse.move(over.x - 25, over.y + 5)
      await page.mouse.move(over.x, over.y)
    }
    await expect
      .poll(async () => (await hangarAim(page))?.aimName, { message: 'the cursor aims the table' })
      .toBe('multiplayer')
    // A turn of the view (the A and D keys) hands the aim back to the nose.
    await hold(page, 'KeyD', 400)
    await expect
      .poll(async () => (await hangarAim(page))?.aimName, { message: 'the nose aims again' })
      .not.toBe('multiplayer')
  })

  test('a first visit rests on Flight School at the flight plan step', async ({ page }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await dropFocus(page)
    await toAircraft(page)
    expect(await lookUntilAimed(page, 'hoverjet'), 'found the HoverJet').toBe(true)
    await hold(page, 'Enter')
    await throughVariants(page)
    await hangarOn(page, 'modes')
    // The seat starts the step on its first table, not the middle one (Ring Attack).
    await expect
      .poll(async () => (await hangarAim(page))?.aimName, { message: 'resting on Flight School' })
      .toBe('lesson')
  })
})
