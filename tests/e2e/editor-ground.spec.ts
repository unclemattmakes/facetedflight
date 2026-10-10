/**
 * A course over a custom island, through the editor and into the seat. DEV-489
 * (docs/plan/EDITOR-WAVE-3.md).
 *
 * The island is SYNTHETIC — `previewIsland('cone', …)`, a ridged cone — and
 * it arrives by the preview build's `?island=cone` door (`boot/app.ts`'s
 * `ISLAND_AT_BOOT`, never honoured on the release channel). That door does one
 * thing: it puts a ground on the level MAKE A COURSE already loads. Everything
 * this spec then drives is the game's own path for a player's ground — the
 * world build, the editor's ground, the playtest, the flight — which is the
 * path DEV-490's import and DEV-493's seeds feed. Real pointer events through
 * `fixtures/canvas.ts`; in by COURSES → MAKE A COURSE; the course made
 * flyable by LIFT (DEV-478's fixture).
 *
 * What it holds:
 *  · the world is the CUSTOM ground (its receipt, and the height field's peak
 *    where the cone's is), with a forest on it;
 *  · the editor's ground is that ground, the pad seated on it;
 *  · FLY builds the custom world again and the ship stands on its pad;
 *  · no page error.
 *
 * It prints the receipt — every stage's milliseconds, in the page — which is
 * DEV-489's browser measurement. Photos go to `EDITOR_PHOTO_DIR` (default
 * `test-results/editor-ground`). Tagged `@gpu`, tier pinned (`PINNED`).
 */

import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt } from './fixtures/canvas'
import { collectPageErrors, editorHold as hold, openEditorFromTitle } from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { photographer } from './fixtures/photo'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-ground')

type V3 = [number, number, number]

interface DeskProbe {
  points: V3[]
  selection: number | null
  valid: boolean
  warnings: string[]
  groundReady: boolean
  placeHeight: number
  start: { pos: V3; yaw: number }
  padSeat: number | null
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
    const d = w.__ff2.editorDebug()
    if (!d) throw new Error('no editor debug')
    return d.screenOf(x, y, z)
  }, p)

/** The world's land as the game built it: the receipt, its extent and its highest ground. */
interface World {
  receipt: Record<string, number | string> | null
  custom: boolean
  size: number
  centre: [number, number]
  peakY: number
  peakAt: [number, number]
}
const world = (page: Page): Promise<World | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const t = w.__ff2.terrain()?.terrain
    if (!t) return null
    const hf = t.heightField
    let best = 0
    for (let i = 0; i < hf.heights.length; i++)
      if ((hf.heights[i] as number) > (hf.heights[best] as number)) best = i
    const n = hf.vertPerSide
    const gx = best % n
    const gz = Math.floor(best / n)
    const p = t.group.position
    const size = t.params.terrainSize
    return {
      receipt: w.__ff2.customGround(),
      custom: t.custom !== null,
      size,
      centre: [p.x + size / 2, p.z - size / 2] as [number, number],
      peakY: (hf.heights[best] as number) * hf.terrainHeight + p.y,
      // Mesh (x, z) to THREE: the group's position, and the z mirror.
      peakAt: [p.x + gx * hf.step, p.z - gz * hf.step] as [number, number],
    }
  })

const launchPhase = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.launch().phase)

const photo = photographer(OUT)

/** The cone's summit sits at the centre of its island, `PREVIEW_PEAK` of Simonet's height. */
const expectTheCone = (w: World | null, what: string): World => {
  if (!w) throw new Error(`${what}: no world`)
  expect(w.custom, `${what}: the land is a custom ground`).toBe(true)
  expect(w.receipt?.island, `${what}: wearing Simonet`).toBe('simonet')
  // The summit is where the cone's is: the island's centre, to a couple of facets.
  expect(Math.hypot(w.peakAt[0] - w.centre[0], w.peakAt[1] - w.centre[1])).toBeLessThan(24)
  expect(Number(w.receipt?.props), `${what}: a forest on it`).toBeGreaterThan(0)
  return w
}

test.describe('@gpu a course over a custom island (DEV-489)', () => {
  test.setTimeout(900_000)

  test('the editor opens over the ground, a course is laid on it, and it flies', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    const receipts: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (/custom ground:|sun-height:|sky-visibility:|props: \d+ instances/.test(t))
        receipts.push(t)
    })

    // ── in by the title's door, over the preview cone ───────────────────
    await openEditorFromTitle(page, { query: '&island=cone' })
    const w = expectTheCone(await world(page), 'the editor')
    console.log(`[DEV-489] editor world: ${JSON.stringify(w.receipt)}`)

    // The pad is seated on the ground the editor judges by, which is the cone's.
    const fresh = await desk(page)
    expect(fresh.padSeat).not.toBeNull()
    expect(Math.abs(fresh.start.pos[1] - (fresh.padSeat as number))).toBeLessThan(0.05)
    await page.waitForTimeout(1_500)
    await photo(page, 'editor-oblique.png')

    // ── a course: a square round the summit, top-down ───────────────────
    await page.locator('[data-editor="top-down"]').click()
    await page.locator('[data-editor="height"]').fill('400')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).placeHeight).toBe(400)
    await page.waitForTimeout(1_500)
    await photo(page, 'editor-top-down.png')
    const r = 900
    const corners: V3[] = [
      [w.centre[0] - r, 400, w.centre[1] - r],
      [w.centre[0] + r, 400, w.centre[1] - r],
      [w.centre[0] + r, 400, w.centre[1] + r],
      [w.centre[0] - r, 400, w.centre[1] + r],
    ]
    for (const c of corners) {
      const at = await screenOf(page, c)
      if (!at) throw new Error(`corner ${c} is behind the eye`)
      await clickCanvasAt(page, at.x, at.y)
      await page.waitForTimeout(150)
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5) // DEV-501: the pad's, and four
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await desk(page)).selection).toBeNull()
    await liftToFlyable(page, 'a square round the cone')
    await expectFlyable(page, 'a square round the cone')
    await page.waitForTimeout(800)
    await photo(page, 'editor-course-top-down.png')

    // ── FLY: the custom world again, and the seat ───────────────────────
    const pad = (await desk(page)).start.pos
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    const flown = expectTheCone(await world(page), 'the flight')
    console.log(`[DEV-489] flight world: ${JSON.stringify(flown.receipt)}`)
    await expect.poll(async () => launchPhase(page), { timeout: 30_000 }).toBe('waiting')
    const body = await page.evaluate(() => {
      const f = (globalThis as unknown as Ff2Global).__ff2.flight()
      const p = f?.jet.body.position
      return p ? [p.x, p.y, -p.z] : null
    })
    if (!body) throw new Error('no flight')
    expect(
      Math.hypot((body[0] as number) - pad[0], (body[2] as number) - pad[2]),
      'on its pad',
    ).toBeLessThan(0.1)
    await page.waitForTimeout(2_000)
    await photo(page, 'seat-on-pad.png')

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'Enter', 150)
    await expect.poll(async () => launchPhase(page), { timeout: 20_000 }).toBe('flying')
    await page.keyboard.down('Space')
    await page.waitForTimeout(3_000)
    await photo(page, 'seat-flying.png')
    await page.keyboard.up('Space')
    await hold(page, 'v', 120) // the chase view: the ship over the island
    await page.waitForTimeout(1_500)
    await photo(page, 'chase-flying.png')

    for (const line of receipts) console.log(`[DEV-489] ${line}`)
    expect(pageErrors).toEqual([])
  })
})
