/**
 * The course editor's panel, driven as a person drives it. DEV-473
 * (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
 *
 * Matt could not tell what the Finish slider did or what "point 4 height"
 * meant, and wanted the ring gap on a slider. Every one of those is a GESTURE
 * here, with real pointer events on the real controls, never a call into the
 * editor in place of one (the brief's ground rule: the e2e that shipped
 * DEV-469 moved points without dragging the gizmo, which is how a broken gizmo
 * got past it):
 *
 *  · the RING GAP slider, pressed on its thumb, dragged and let go: the gap
 *    and the ring count change, the rings the world draws follow, and the drag
 *    is ONE undo step;
 *  · the FINISH slider, dragged: the finish moves while the mouse is still
 *    down (live), the labelled hoop stands ON the drawn line, the game's own
 *    gate follows it with the rebuilt rings, and one Ctrl+Z puts it back;
 *  · a point picked on the canvas, and its height typed as the sentence reads:
 *    the point stands that far above the ground, and the height a NEW point
 *    gets is untouched;
 *  · every control on the panel carries a tooltip (except the Start slider,
 *    which DEV-475 replaces with a pad).
 *
 * In by the title's own door (COURSES → MAKE A COURSE), which is the path a
 * creator takes. Photographs of the panel and of the hoop go to
 * `EDITOR_PANEL_PHOTOS` (or test-results). The tier is pinned in the URL
 * (`fixtures/quality-pin.ts`). Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { clickCanvasAt } from './fixtures/canvas'
import { collectPageErrors, openEditorFromTitle } from './fixtures/editor-boot'
import { liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PANEL_PHOTOS ?? path.join('test-results', 'editor-panel')
/** 2016's own racing line on int_01 (THREE space); the spec clicks four places on it. */
const INT01_ROUTE = (
  JSON.parse(fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8')) as {
    route: [number, number, number][]
  }
).route
const ROUTE_PICKS = [20, 60, 100, 140] as const

type V3 = [number, number, number]

interface DeskProbe {
  points: V3[]
  selection: number | null
  gap: number
  rings: number | null
  drawnRings: number
  valid: boolean
  groundReady: boolean
  placeHeight: number
  finish: number
  finishMarker: V3 | null
  finishGate: V3 | null
  lineLength: number | null
  undoDepth: number
}

const desk = async (page: Page): Promise<DeskProbe> => {
  const e = (await page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.editor()
  })) as { editing: boolean; desk: DeskProbe | null }
  if (!e.desk) throw new Error('the desk has not loaded')
  return e.desk
}

const screenOf = (page: Page, p: V3): Promise<{ x: number; y: number } | null> =>
  page.evaluate(([x, y, z]) => {
    const w = globalThis as unknown as Ff2Global
    return (w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null) as { x: number; y: number } | null
  }, p)

const lineSamples = (page: Page): Promise<V3[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return (w.__ff2.editorDebug()?.lineSamples() ?? []) as V3[]
  })

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )

/**
 * Where a range's thumb is drawn, CSS pixels: the track less one thumb, as
 * Chrome lays a default range out. A press that lands a little off the thumb
 * still moves it (a press on the track jumps it there), so this only has to
 * be near.
 */
const thumbAt = async (
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; box: { x: number; width: number } }> => {
  // DEV-569/570: the panel grew a header and a tool row, so a press on a
  // panel button lower down (Top-down) scrolls it, and the slider is no longer
  // on screen where this used to find it. Scroll it into view as a person
  // scrolls to it, then make sure the press lands ON it (the sticky header
  // covers the panel's top edge).
  await page.locator(selector).scrollIntoViewIfNeeded()
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const frac = await page.locator(selector).evaluate((el) => {
    const i = el as HTMLInputElement
    const min = Number.parseFloat(i.min)
    const max = Number.parseFloat(i.max)
    return (Number.parseFloat(i.value) - min) / (max - min)
  })
  const thumb = 16
  const at = {
    x: box.x + thumb / 2 + frac * (box.width - thumb),
    y: box.y + box.height / 2,
    box: { x: box.x, width: box.width },
  }
  const onIt = await page.evaluate(
    ([sel, x, y]) =>
      document.elementFromPoint(x as number, y as number) === document.querySelector(sel as string),
    [selector, at.x, at.y] as const,
  )
  expect(onIt, `${selector}'s thumb is uncovered where it is pressed`).toBe(true)
  return at
}

/** The x a range's thumb sits at for fraction `f` of its travel. */
const trackX = (box: { x: number; width: number }, f: number): number =>
  box.x + 8 + f * (box.width - 16)

test.describe('@gpu the course editor panel', () => {
  test.setTimeout(600_000)

  test('the gap slides, the finish moves where you can see it, and a height reads as a sentence', async ({
    page,
  }) => {
    fs.mkdirSync(OUT, { recursive: true })
    const pageErrors = collectPageErrors(page)

    // ── in by the title's door ─────────────────────────────────────────────
    await openEditorFromTitle(page)

    // ── four points on the ground, top-down ──────────────────────────────
    await page.locator('[data-editor="top-down"]').click()
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    for (const i of ROUTE_PICKS) {
      const at = await screenOf(page, INT01_ROUTE[i] as V3)
      expect(at, `route[${i}] projects`).not.toBeNull()
      const { x, y } = at as { x: number; y: number }
      expect(
        x > 0 && x < view.width - 320 && y > 0 && y < view.height,
        `route[${i}] on screen`,
      ).toBe(true)
      await clickCanvasAt(page, x, y)
      await page.waitForTimeout(150)
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5) // DEV-501: the pad's, and four
    // DEV-478: four points 150 m up sag through a hill; lift them clear, pressed.
    await liftToFlyable(page, 'four points 150 m over int_01')
    const made = await desk(page)
    expect(made.valid, 'the four-point course validates').toBe(true)
    await expect
      .poll(async () => (await desk(page)).drawnRings, { timeout: 30_000 })
      .toBe(made.rings)
    // Deselect (Escape), so the height a NEW point gets is what the panel shows.
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await desk(page)).selection).toBeNull()

    // ── every control says what it does ───────────────────────────────────
    const untitled = await page.evaluate(() =>
      // DEV-878: the top bar, the tool strip, the corner and the sheet are controls too.
      [
        ...document.querySelectorAll(
          '#editor-panel [data-editor], #editor-topbar [data-editor], #editor-tools [data-editor], #editor-view [data-editor], #editor-keys [data-editor]',
        ),
      ]
        .filter((el) => /^(BUTTON|INPUT|SELECT)$/.test(el.tagName))
        .map((el) => ({
          name: (el as HTMLElement).dataset.editor ?? '',
          title: (el as HTMLElement).title,
        }))
        .filter((c) => c.name !== 'start' && c.title.trim() === '')
        .map((c) => c.name),
    )
    expect(untitled, 'every control has a tooltip').toEqual([])
    await expect(page.locator('#editor-panel')).toContainText('New points are placed')
    await expect(page.locator('#editor-panel')).toContainText('Finish: how far along the line')
    await page.locator('#editor-panel').screenshot({ path: path.join(OUT, 'panel-at-rest.png') })

    // ── the RING GAP, dragged with the mouse ──────────────────────────────
    const beforeGap = await desk(page)
    console.log(
      `[DEV-570] the panel stands scrolled ${await page
        .locator('#editor-panel')
        .evaluate((el) => el.scrollTop)} px before the gap drag`,
    )
    const g = await thumbAt(page, '[data-editor="gap-slider"]')
    await page.mouse.move(g.x, g.y)
    await page.mouse.down()
    await page.mouse.move(trackX(g.box, 0.95), g.y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => (await desk(page)).gap).toBeGreaterThan(beforeGap.gap + 200)
    const gapped = await desk(page)
    expect(gapped.rings, 'a wider gap makes fewer rings').not.toBeNull()
    expect(gapped.rings as number).toBeLessThan(beforeGap.rings as number)
    expect(gapped.undoDepth, 'the drag is ONE undo step').toBe(beforeGap.undoDepth + 1)
    // The field beside it shows the same number, and the world redraws the rings.
    await expect(page.locator('[data-editor="gap"]')).toHaveValue(String(gapped.gap))
    await expect(page.locator('[data-editor="gap-readout"]')).toContainText(`${gapped.rings} ring`)
    await expect
      .poll(async () => (await desk(page)).drawnRings, { timeout: 30_000 })
      .toBe(gapped.rings)
    // And back to where it was, by typing, which is the other way in.
    await page.locator('[data-editor="gap"]').fill(String(beforeGap.gap))
    await page.locator('[data-editor="gap"]').press('Enter')
    await expect.poll(async () => (await desk(page)).rings).toBe(beforeGap.rings)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // ── the FINISH, dragged: live, on the line, and one undo ──────────────
    const atEnd = await desk(page)
    expect(atEnd.finish).toBe(1)
    expect(atEnd.finishMarker, 'the hoop is drawn at the finish').not.toBeNull()
    await expect.poll(async () => (await desk(page)).finishGate, { timeout: 30_000 }).not.toBeNull()
    const gateAtEnd = (await desk(page)).finishGate as V3
    const f = await thumbAt(page, '[data-editor="finish"]')
    await page.mouse.move(f.x, f.y)
    await page.mouse.down()
    await page.mouse.move(trackX(f.box, 0.75), f.y, { steps: 10 })
    // Still held: the finish has moved already, and so has the hoop.
    const mid = await desk(page)
    expect(mid.finish, 'the finish moves while the slider is held').toBeLessThan(0.85)
    expect(dist(mid.finishMarker as V3, atEnd.finishMarker as V3)).toBeGreaterThan(100)
    await page.mouse.move(trackX(f.box, 0.55), f.y, { steps: 10 })
    await page.mouse.up()
    const moved = await desk(page)
    expect(moved.finish).toBeGreaterThan(0.45)
    expect(moved.finish).toBeLessThan(0.65)
    expect(moved.undoDepth, 'the finish drag is ONE undo step').toBe(atEnd.undoDepth + 1)
    // The hoop stands ON the drawn line (the samples are the format's own curve).
    const samples = await lineSamples(page)
    const onLine = Math.min(...samples.map((s) => dist(s, moved.finishMarker as V3)))
    expect(onLine, 'the hoop is on the line').toBeLessThan(15)
    // The readout says the share and the distance.
    await expect(page.locator('[data-editor="finish-readout"]')).toContainText(
      `${Math.round(moved.finish * 100)} %`,
    )
    // The game's own gate follows, with the rebuilt rings, into the hoop.
    await expect
      .poll(
        async () => {
          const d = await desk(page)
          return d.finishGate && d.finishMarker ? dist(d.finishGate, d.finishMarker) : Infinity
        },
        { timeout: 30_000 },
      )
      .toBeLessThan(80)
    expect(dist((await desk(page)).finishGate as V3, gateAtEnd)).toBeGreaterThan(200)
    // Photographs: the hoop over the island, and the panel as it reads now.
    await page.screenshot({ path: path.join(OUT, 'finish-hoop.png') })
    await page.locator('#editor-panel').screenshot({ path: path.join(OUT, 'panel-finish.png') })
    // One Ctrl+Z, straight after the drag (the slider gave the keys back), puts it back.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).finish).toBe(1)

    // ── a picked point's height, typed as the sentence reads ──────────────
    const third = (await desk(page)).points[2] as V3
    const handle = await screenOf(page, third)
    expect(handle).not.toBeNull()
    await clickCanvasAt(page, (handle as { x: number }).x, (handle as { y: number }).y)
    await expect.poll(async () => (await desk(page)).selection).toBe(2)
    const row = page.locator('[data-editor="point-height-row"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Selected point 3:')
    await expect(row).toContainText('m above ground')
    const placeBefore = (await desk(page)).placeHeight
    const typed = 180
    await page.locator('[data-editor="point-height"]').fill(String(typed))
    await page.locator('[data-editor="point-height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).points[2]?.[1] ?? 0).not.toBe(third[1])
    await expect(page.locator('[data-editor="point-height"]')).toHaveValue(String(typed))
    const raised = await desk(page)
    // Only the height moved, and the new-point height is its own.
    expect((raised.points[2] as V3)[0]).toBe(third[0])
    expect((raised.points[2] as V3)[2]).toBe(third[2])
    expect(raised.placeHeight).toBe(placeBefore)
    await page.locator('#editor-panel').screenshot({ path: path.join(OUT, 'panel-selected.png') })
    // A focused field keeps its keys; let go of it, as a person clicks away.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(row).toBeHidden()

    // ── DEV-478: the course as this spec leaves it is still flyable ───────
    // (a point typed down to 180 m can put the line back in the hill; the
    // spec presses Lift if so, and holds the result to the same judgement).
    await liftToFlyable(page, 'the course after the height was typed')

    // ── every program linked (the hoop and its label are new materials) ───
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the editor frame drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(
      sweep.failed.map((x) => `#${x.id} ${x.type}`),
      'every program three holds linked',
    ).toEqual([])

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
