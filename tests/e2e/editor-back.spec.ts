/**
 * The editor's way back, and Maya's keys. DEV-569 and DEV-570
 * (docs/plan/PLAYTEST-WAVE-2026-10-02.md).
 *
 * Matt, 2026-10-02: *"need a way to get back to the main game from the
 * editor"* and *"editor needs a way to control rotation of the platform (use
 * maya hotkeys plz)"*. Driven as a person drives it, through
 * `fixtures/canvas.ts` and real keys:
 *
 *  · BACK TO HANGAR stands in the panel's header and is IN VIEW, before and
 *    after the panel is scrolled to its foot (where LEAVE EDITOR used to be,
 *    under the fold); pressed, the hangar is the screen, and MAKE A COURSE
 *    opens the same draft again, its pad as it was left;
 *  · Q, W, E and R choose the tool, the panel lights it, and the gizmo on the
 *    picked start pad follows: E its Y ring alone, R its arrows (a pad has no
 *    size, said in words), Q no handles, W the arrows again; while the right
 *    button flies the eye, E is the fly's and the tool does not change; A
 *    frames the island;
 *  · opened by a LINK (`?edit=1`), the same button reaches the hangar; and in
 *    a browser that will not keep the draft (storage throwing, as a full or
 *    blocked one does) it asks first, Escape keeps editing, and "Leave without
 *    it" leaves.
 *
 * The pad's turn and a flight from the turned pad are `editor-pad.spec.ts`'s
 * (E since DEV-570). Photographs go to `EDITOR_BACK_PHOTOS` (or
 * test-results). Tagged `@gpu`; the tier is pinned (`PINNED`).
 */

import path from 'node:path'
import { holdCanvasButton } from './fixtures/canvas'
import { collectPageErrors, editorLinkUrl, openEditorFromTitle } from './fixtures/editor-boot'
import { openMenu } from './fixtures/editor-menus'
import type { Ff2Global } from './fixtures/ff2'
import { hangarAim, hold } from './fixtures/hangar'
import { photographer } from './fixtures/photo'
import { expect, type Page, test } from './fixtures/test'
import { SHELF_ACTION, shelfProbe } from './fixtures/title'

const OUT = process.env.EDITOR_BACK_PHOTOS ?? path.join('test-results', 'editor-back')

type V3 = [number, number, number]
interface DeskProbe {
  slot: string
  groundReady: boolean
  start: { pos: V3; yaw: number }
  padPicked: boolean
  tool: string
  gizmoMode: string
  gizmoAxes: { x: boolean; y: boolean; z: boolean }
  gizmo: { attached: boolean; axis: string | null; dragging: boolean }
  leave: string | null
  leaveAsking: boolean
  camera: { position: V3; target: V3; distance: number; flying: boolean }
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const photo = photographer(OUT)

/** The element's box lies wholly inside the window. */
const inView = async (page: Page, selector: string): Promise<boolean> => {
  const box = await page.locator(selector).boundingBox()
  const view = page.viewportSize() ?? { width: 1280, height: 720 }
  return (
    !!box &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= view.width &&
    box.y + box.height <= view.height
  )
}

/** The hangar is the screen and no fade is running. */
const inHangar = async (page: Page): Promise<void> => {
  await expect
    .poll(
      async () => {
        const at = await hangarAim(page)
        const fading = await page.evaluate(
          () => (globalThis as unknown as Ff2Global).__ff2.fade().busy,
        )
        return at?.screen === 'menu' && !fading ? `menu:${at.view}` : `${at?.screen ?? 'none'}`
      },
      { message: 'the hangar is the screen', timeout: 60_000 },
    )
    .toMatch(/^menu:/)
  await expect(page.locator('body')).not.toHaveAttribute('data-editor', /.+/)
  await expect(page.locator('#editor-panel')).toBeHidden()
}

const BACK = '[data-editor="leave"]'

test.describe('@gpu the editor: the way back and Maya’s keys (DEV-569, DEV-570)', () => {
  test.setTimeout(600_000)

  test('Back to hangar is always in view; Q W E R choose the tool on the pad; MAKE A COURSE brings the draft back', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)

    // ── in by the hangar's shelf, MAKE A COURSE ─────────────────────────
    await openEditorFromTitle(page)

    // ── DEV-569: the way back is in view, top and bottom of the panel ────
    await expect(page.locator(BACK)).toHaveText('Back to hangar')
    expect(await inView(page, BACK), 'in view as the editor opens').toBe(true)
    // Nothing on the panel is wider than it: no sideways scroll. The first run
    // of this spec photographed one: a picker sized to its longest name.
    const widths = await page
      .locator('#editor-panel')
      .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(
      widths.scroll,
      `the panel scrolls sideways ${JSON.stringify(widths)}`,
    ).toBeLessThanOrEqual(widths.client)
    await page.locator('#editor-panel').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(300)
    const scrolled = await page.locator('#editor-panel').evaluate((el) => el.scrollTop)
    console.log(`[DEV-569] the panel scrolled ${scrolled} px to its foot`)
    // DEV-878: the way back is in the top bar now, which never scrolls.
    expect(await inView(page, BACK), 'still in view, the panel scrolled to the foot').toBe(true)
    await photo(page, 'back-button-scrolled.png')
    // The keys: behind the corner's "?", as a person opens them.
    await openMenu(page, 'keys')
    const controls = page.locator('[data-editor="controls"]')
    for (const k of ['Q', 'W', 'E', 'R', 'F', 'A', 'T', 'Alt+drag', 'Shift+drag', 'Hold right']) {
      await expect(controls, k).toContainText(k)
    }
    await page.locator('#editor-keys').screenshot({ path: path.join(OUT, 'panel-keys.png') })
    await page.locator('[data-editor="keys-close"]').click()
    await expect(page.locator('[data-editor="keys-sheet"]')).toBeHidden()
    await page.locator('#editor-panel').evaluate((el) => {
      el.scrollTop = 0
    })

    // ── DEV-570: the pad picked, then Q W E R ───────────────────────────
    await page.locator('[data-editor="pad"]').click()
    await expect.poll(async () => (await desk(page)).padPicked).toBe(true)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('f')
    await page.waitForTimeout(1_200)
    const keyed = async (key: string): Promise<DeskProbe> => {
      await page.keyboard.press(key)
      await page.waitForTimeout(250)
      return desk(page)
    }
    let d = await keyed('e')
    expect(d.tool).toBe('rotate')
    expect(d.gizmoMode, 'E: the ring').toBe('rotate')
    expect(d.gizmoAxes, 'its Y ring alone: the heading').toEqual({ x: false, y: true, z: false })
    await expect(page.locator('[data-editor="tool-rotate"]')).toHaveClass(/\bon\b/)
    await expect(page.locator('[data-editor="tool-note"]')).toContainText('turn the start pad')
    await page.waitForTimeout(500)
    await photo(page, 'pad-rotate-gizmo.png')
    d = await keyed('r')
    expect(d.tool).toBe('scale')
    expect(d.gizmoMode, 'R on a pad: its arrows, a pad has no size').toBe('translate')
    await expect(page.locator('[data-editor="tool-note"]')).toContainText('does not scale')
    d = await keyed('q')
    expect(d.tool).toBe('select')
    expect(d.gizmo.attached, 'Q: no handles').toBe(false)
    expect(d.padPicked, 'and the pad still picked').toBe(true)
    d = await keyed('w')
    expect(d.tool).toBe('move')
    expect(d.gizmoMode).toBe('translate')
    expect(d.gizmoAxes, 'on the ground: X and Z').toEqual({ x: true, y: false, z: true })
    expect(d.gizmo.attached).toBe(true)

    // While the right button flies the eye, E is the fly's (up), not the tool.
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    const free = { x: (view.width - 324) * 0.5, y: view.height * 0.4 }
    await holdCanvasButton(page, free, 'right', async () => {
      await expect.poll(async () => (await desk(page)).camera.flying).toBe(true)
      await page.keyboard.down('e')
      await page.waitForTimeout(300)
      await page.keyboard.up('e')
    })
    expect((await desk(page)).tool, 'E while flying left the tool alone').toBe('move')

    // A frames the whole island: the eye stands back to the island's frame.
    const before = (await desk(page)).camera.distance
    await page.keyboard.press('a')
    await page.waitForTimeout(1_200)
    const framed = (await desk(page)).camera.distance
    console.log(`[DEV-570] A: the orbit ${before.toFixed(0)} m -> ${framed.toFixed(0)} m`)
    expect(framed, 'A stood back to the whole island').toBeGreaterThan(before * 2)

    // ── back to the hangar, and in again to the same draft ──────────────
    const left = await desk(page)
    await page.locator(BACK).click()
    await inHangar(page)
    expect((await desk(page)).leave, 'left at once: the draft was kept').toBe('left')
    await page.waitForTimeout(800)
    await photo(page, 'hangar-after-back.png')
    // Where the room stands now: the shelf the editor was entered from.
    const room = await hangarAim(page)
    const shelf = await shelfProbe(page)
    console.log(
      `[DEV-569] back in the hangar: view ${room?.view}, shelf ${shelf?.open ? 'open' : 'shut'}, aimed ${shelf?.aimed}`,
    )
    expect(shelf?.open, 'back at the Custom Courses shelf it was entered from').toBe(true)
    // MAKE A COURSE again, aimed as a player aims it: by turning the seat.
    for (const key of ['KeyD', 'KeyA'] as const) {
      for (let i = 0; i < (key === 'KeyA' ? 64 : 32); i++) {
        if ((await shelfProbe(page))?.aimed === SHELF_ACTION.makeCourse) break
        await page.keyboard.down(key)
        await page.waitForTimeout(80)
        await page.keyboard.up(key)
        await page.waitForTimeout(80)
      }
      if ((await shelfProbe(page))?.aimed === SHELF_ACTION.makeCourse) break
    }
    expect((await shelfProbe(page))?.aimed).toBe(SHELF_ACTION.makeCourse)
    await hold(page, 'Enter')
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', {
      timeout: 180_000,
    })
    const again = await desk(page)
    expect(again.slot, 'the same draft').toBe(left.slot)
    expect(again.start, 'its pad as it was left').toEqual(left.start)
    expect(pageErrors).toEqual([])
  })

  test('from a link (?edit=1): Back to hangar; a browser that will not keep the draft is asked first', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto(editorLinkUrl())
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', {
      timeout: 240_000,
    })
    await expect.poll(async () => (await desk(page)).groundReady, { timeout: 120_000 }).toBe(true)
    expect(await inView(page, BACK)).toBe(true)

    // Storage that throws on a write, as a full or blocked one does: the page
    // is the one a player has, only its browser's storage refuses.
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
    })
    await page.locator(BACK).click()
    const dialog = page.locator('[data-editor="leave-dialog"]')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('would not keep your draft')
    expect((await desk(page)).leaveAsking).toBe(true)
    await photo(page, 'leave-asks.png')
    // Escape is "keep editing".
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing')
    // Asked again, and left without it.
    await page.locator(BACK).click()
    await expect(dialog).toBeVisible()
    await page.locator('[data-editor="leave-anyway"]').click()
    await inHangar(page)
    expect((await desk(page)).leave).toBe('left-unkept')
    await page.waitForTimeout(800)
    await photo(page, 'hangar-after-link.png')
    expect(pageErrors).toEqual([])
  })
})
