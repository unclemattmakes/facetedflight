/**
 * A course on an island imported from a heightmap, from the picker to the
 * seat and back out of a file. DEV-490 (docs/plan/EDITOR-WAVE-3.md, T1.5).
 *
 * The map is MADE here — a 16-bit greyscale PNG of a ridged island, written
 * with `node:zlib` — and handed to the dialog's own file input with
 * `setInputFiles`, the way a person picks one. Everything after that is the
 * game's own path: the browser decoder, the dialog's diorama, the world
 * built once over the map, the pad found on dry land, the playtest, the
 * `.ffcourse` with the map inside, the library's copy that `?edit=1` reopens
 * the draft over, and the file opened from the title flying the same id.
 * Real pointer events through `fixtures/canvas.ts`; in by COURSES → MAKE A
 * COURSE; the course made flyable by LIFT (DEV-478's fixture).
 *
 * Photos go to `EDITOR_PHOTO_DIR` (default `test-results/editor-island`).
 * Tagged `@gpu`, tier pinned (`PINNED`).
 */

import fs from 'node:fs'
import path from 'node:path'
import { heightmapSha } from '../../src/content/island-map'
import { islandPeakHeight, playerCourseId } from '../../src/content/player-course'
import { NO_LINK_FOR_A_MAP, readCourseFile } from '../../src/content/player-course-wire'
import { bootReady, missionReady, switchGone, switchSettled } from './fixtures/boot'
import { clickCanvasAt, dropFocus } from './fixtures/canvas'
import {
  collectPageErrors,
  editorHold as hold,
  openEditor,
  openEditorFromTitle,
  waitForEditor,
} from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import { openMenu } from './fixtures/editor-menus'
import type { Ff2Global } from './fixtures/ff2'
import { islandPng } from './fixtures/island-map'
import { firstPress } from './fixtures/landing'
import { photographer } from './fixtures/photo'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressShelfAction, SHELF_ACTION, titleRowsUp } from './fixtures/title'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-island')

type V3 = [number, number, number]

interface DeskProbe {
  points: V3[]
  selection: number | null
  valid: boolean
  groundReady: boolean
  placeHeight: number
  courseId: string | null
  slot: string
  ground: string
  worldGround: string
  pad: V3
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const screenOf = (page: Page, p: V3): Promise<{ x: number; y: number } | null> =>
  page.evaluate(([x, y, z]) => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null
  }, p)

/** The land the game built: whether it is a custom ground, its centre and size. */
const world = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const t = w.__ff2.terrain()?.terrain
    if (!t) return null
    const size = t.params.terrainSize
    const p = t.group.position
    return {
      custom: t.custom !== null,
      size,
      centre: [p.x + size / 2, p.z - size / 2] as [number, number],
      receipt: w.__ff2.customGround(),
    }
  })

const launchPhase = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.launch().phase)

const photo = photographer(OUT)

test.describe('@gpu a course on an imported heightmap (DEV-490)', () => {
  test.setTimeout(900_000)

  test('picked, previewed, built once, flown, saved, and loaded back with the same id', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })
    const mapFile = path.join(OUT, 'island.png')
    const mapBytes = islandPng()
    fs.writeFileSync(mapFile, mapBytes)
    const sha = await heightmapSha(new Uint8Array(mapBytes))

    await openEditorFromTitle(page)

    // ── the dialog: the picker, the rights, the diorama ─────────────────
    await page.locator('[data-editor="island-map"]').click()
    const dialog = page.locator('#island-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('rights')
    await page.locator('[data-editor="island-file"]').setInputFiles(mapFile)
    await expect(dialog).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    await expect(dialog).toHaveAttribute('data-map', '257x257')
    await expect(dialog).toHaveAttribute('data-bits', '16')
    // DEV-499: the height is the island's own, not a typed 400; DEV-534: its measured summit.
    await expect(dialog).toHaveAttribute('data-preview', `4096:${islandPeakHeight('simonet')}:0.05`)
    await page.waitForTimeout(1_200)
    await photo(page, 'dialog-preview.png')
    await page.locator('[data-editor="island-use"]').click()
    await expect(dialog).toHaveCount(0)
    // The switch runs behind a fade: wait for it to BEGIN, so what follows reads the new world.
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'switching', {
      timeout: 30_000,
    })

    // ── the world, built once over the map; the pad on dry land ─────────
    await expect
      .poll(async () => (await desk(page)).worldGround, { timeout: 60_000 })
      .toContain(sha)
    await missionReady(page)
    await waitForEditor(page)
    const made = await desk(page)
    expect(made.ground).toBe(made.worldGround)
    const w = await world(page)
    expect(w?.custom, 'the land is the imported ground').toBe(true)
    expect(w?.size).toBe(4096)
    console.log(`[DEV-490] editor world: ${JSON.stringify(w?.receipt)}`)
    // Dry: the sea stands near 116.6 m here (islandWaterline's reading); padSpot refuses water.
    await expect
      .poll(async () => (await desk(page)).pad[1], { timeout: 20_000 })
      .toBeGreaterThan(116.6)
    const pad = (await desk(page)).pad
    console.log(`[DEV-490] the pad stands at ${pad.map((v) => v.toFixed(1)).join(', ')}`)
    await page.waitForTimeout(1_500)
    await photo(page, 'editor-oblique.png')

    // ── a course round it ───────────────────────────────────────────────
    if (!w) throw new Error('no world')
    await page.locator('[data-editor="top-down"]').click()
    await page.locator('[data-editor="height"]').fill('300')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).placeHeight).toBe(300)
    await page.waitForTimeout(1_500)
    const r = 700
    const corners: V3[] = [
      [w.centre[0] - r, 300, w.centre[1] - r * 0.6],
      [w.centre[0] + r, 300, w.centre[1] - r * 0.6],
      [w.centre[0] + r, 300, w.centre[1] + r * 0.6],
      [w.centre[0] - r, 300, w.centre[1] + r * 0.6],
    ]
    // A click that lands on the pad picks the pad instead of adding a point
    // (DEV-475): drop it and click 200 m further out.
    for (const c of corners) {
      for (let tries = 0; tries < 3; tries++) {
        const before = (await desk(page)).points.length
        const at = await screenOf(page, [
          c[0] + tries * 200 * Math.sign(c[0] - w.centre[0]),
          c[1],
          c[2],
        ])
        if (!at) throw new Error('a corner is behind the eye')
        await clickCanvasAt(page, at.x, at.y)
        await page.waitForTimeout(200)
        if ((await desk(page)).points.length > before) break
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      }
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5) // DEV-501: the pad's, and four
    await page.keyboard.press('Escape')
    await liftToFlyable(page, 'a loop round the imported island')
    await expectFlyable(page, 'a loop round the imported island')
    await page.waitForTimeout(800)
    await photo(page, 'editor-course-top-down.png')
    const laid = await desk(page)

    // ── Copy link says it cannot, and offers the file ───────────────────
    await openMenu(page, 'share')
    await page.locator('[data-editor="copy-link"]').click()
    await expect(page.locator('[data-editor="shared"]')).toContainText(NO_LINK_FOR_A_MAP)

    // ── FLY: the same island, the ship on its pad ───────────────────────
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    expect((await world(page))?.custom, 'the flight is over the imported ground').toBe(true)
    await expect.poll(async () => launchPhase(page), { timeout: 30_000 }).toBe('waiting')
    await page.waitForTimeout(1_500)
    await photo(page, 'seat-on-pad.png')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'Enter', 150)
    await expect.poll(async () => launchPhase(page), { timeout: 20_000 }).toBe('flying')
    await page.keyboard.down('Space')
    await page.waitForTimeout(3_000)
    await page.keyboard.up('Space')
    await hold(page, 'v', 120)
    await page.waitForTimeout(1_500)
    await photo(page, 'chase-flying.png')
    // Back to the editor, by the pause plate's bottom row.
    await hold(page, 'Backspace')
    for (let i = 0; i < 10; i++) await hold(page, 'ArrowDown', 120)
    await hold(page, 'Enter', 300)
    await waitForEditor(page)
    expect((await desk(page)).courseId).toBe(laid.courseId)

    // ── Save file: the map rides inside it ──────────────────────────────
    const download = page.waitForEvent('download')
    await openMenu(page, 'share')
    await page.locator('[data-editor="save-file"]').click()
    const saved = await download
    const file = path.join(OUT, 'island.ffcourse')
    await saved.saveAs(file)
    const fromFile = await readCourseFile(new Uint8Array(fs.readFileSync(file)))
    expect(fromFile.ok && playerCourseId(fromFile.course), 'the file is the course').toBe(
      laid.courseId,
    )
    expect(fromFile.ok && fromFile.map?.length, 'with the map inside').toBe(mapBytes.length)

    // ── a reload reopens the draft over its own island (the library's map) ─
    await openEditor(page)
    await expect
      .poll(async () => (await desk(page)).worldGround, { timeout: 60_000 })
      .toContain(sha)
    // The land under it is the imported ground once the desk's own switch lands.
    await expect.poll(async () => (await world(page))?.custom, { timeout: 240_000 }).toBe(true)
    await waitForEditor(page)
    expect((await desk(page)).courseId).toBe(laid.courseId)

    // ── and the file, opened from the title, flies the same id ──────────
    await page.goto(`/?xr=off&audio=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await dropFocus(page)
    await titleRowsUp(page)
    const chooser = page.waitForEvent('filechooser')
    await pressShelfAction(page, SHELF_ACTION.openCourseFile, 0)
    await (await chooser).setFiles(file)
    await expect(page.locator('body')).toHaveAttribute(
      'data-player-course',
      laid.courseId as string,
      { timeout: 60_000 },
    )
    await switchSettled(page, 240_000)
    expect((await world(page))?.custom, 'the file flies over its own island').toBe(true)

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
