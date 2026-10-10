/**
 * A course whose imported map this browser lost: the panel offers "New
 * island…" and "Open a map file…", and the file picked again is taken only if
 * it is the same bytes. DEV-499 (Matt, on DEV-490's call 3: *"should offer the
 * choice of 'new' or 'open'"*).
 *
 * The map is imported through the dialog's own picker, as in
 * `editor-island.spec.ts`. Then the browser loses it the way a person's does
 * when site data is cleared, but only the map: its record is deleted from the
 * library's `maps` store, and the draft (localStorage) stays. `?edit=1`
 * reopens the draft, the panel says the map is gone and shows both buttons;
 * "New island…" opens the import dialog; "Open a map file…" goes through the
 * browser's file chooser, refuses a mirrored copy as a different map, and
 * takes the right one, after which the world is built over it.
 *
 * Photos go to `EDITOR_PHOTO_DIR` (default `test-results/editor-island-reopen`).
 * Tagged `@gpu`, tier pinned (`PINNED`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { heightmapSha } from '../../src/content/island-map'
import { COURSE_LIBRARY_DB } from '../../src/game/course-library'
import { missionReady } from './fixtures/boot'
import {
  collectPageErrors,
  openEditor,
  openEditorFromTitle,
  waitForEditor,
} from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { islandPng } from './fixtures/island-map'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-island-reopen')

interface DeskProbe {
  groundReady: boolean
  ground: string
  worldGround: string
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const customLand = (page: Page): Promise<boolean | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const t = w.__ff2.terrain()?.terrain
    return t ? t.custom !== null : null
  })

/** Lose ONE map from the library, as clearing it from the browser would. */
const loseMap = (page: Page, sha: string): Promise<void> =>
  page.evaluate(
    ([db, sha]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db.name, db.version)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const tx = open.result.transaction(db.maps, 'readwrite')
          tx.objectStore(db.maps).delete(sha)
          tx.oncomplete = () => {
            open.result.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    [COURSE_LIBRARY_DB, sha] as const,
  )

test.describe('@gpu a course whose map was cleared: New island… or Open a map file… (DEV-499)', () => {
  test.setTimeout(600_000)

  test('the same file brings the island back; another map is refused by name', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })
    const mapFile = path.join(OUT, 'island.png')
    const otherFile = path.join(OUT, 'island-mirrored.png')
    const mapBytes = islandPng()
    fs.writeFileSync(mapFile, mapBytes)
    fs.writeFileSync(otherFile, islandPng(true))
    const sha = await heightmapSha(new Uint8Array(mapBytes))

    // ── a course on the imported map ────────────────────────────────────
    await openEditorFromTitle(page)
    await page.locator('[data-editor="island-map"]').click()
    const dialog = page.locator('#island-dialog')
    await page.locator('[data-editor="island-file"]').setInputFiles(mapFile)
    await expect(dialog).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    await page.locator('[data-editor="island-use"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'switching', {
      timeout: 30_000,
    })
    await expect
      .poll(async () => (await desk(page)).worldGround, { timeout: 60_000 })
      .toContain(sha)
    await missionReady(page)
    await waitForEditor(page)
    const lostRow = page.locator('[data-editor="island-reopen"]')
    await expect(lostRow, 'no offer while the map is here').toBeHidden()

    // ── the browser loses the map; the draft opens without it ───────────
    await loseMap(page, sha)
    await openEditor(page)
    const trouble = page.locator('[data-editor="island-trouble"]')
    await expect(trouble).toContainText('its heightmap is not here', { timeout: 60_000 })
    await expect(lostRow).toBeVisible()
    await expect(page.locator('[data-editor="island-lost-new"]')).toBeVisible()
    expect((await desk(page)).ground).toContain(sha)
    expect((await desk(page)).worldGround, 'the sky’s own island under it').toBe('')
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, 'map-lost-panel.png') })

    // ── New island… opens the import dialog (and Cancel leaves the draft) ─
    await page.locator('[data-editor="island-lost-new"]').click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('NEW ISLAND FROM A HEIGHTMAP')
    await page.locator('[data-editor="island-cancel"]').click()
    await expect(dialog).toHaveCount(0)
    expect((await desk(page)).ground).toContain(sha)

    // ── Open a map file…: a different map is refused by name ────────────
    let chooser = page.waitForEvent('filechooser')
    await lostRow.click()
    await (await chooser).setFiles(otherFile)
    await expect(trouble).toContainText('different map', { timeout: 20_000 })
    await expect(lostRow).toBeVisible()
    expect((await desk(page)).worldGround).toBe('')

    // ── … and the same file brings the island back ──────────────────────
    chooser = page.waitForEvent('filechooser')
    await lostRow.click()
    await (await chooser).setFiles(mapFile)
    await expect
      .poll(async () => (await desk(page)).worldGround, { timeout: 60_000 })
      .toContain(sha)
    await expect.poll(async () => customLand(page), { timeout: 240_000 }).toBe(true)
    await waitForEditor(page)
    await expect(trouble).toHaveText('')
    await expect(lostRow).toBeHidden()
    await page.waitForTimeout(1_200)
    await page.screenshot({ path: path.join(OUT, 'map-reopened.png') })

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
