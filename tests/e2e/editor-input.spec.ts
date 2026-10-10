/**
 * The course editor's hands, with real pointer events. DEV-472
 * (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
 *
 * Matt, in the editor: *"unable to use the transform gizmo - no arrows
 * highlight when i hover over them, and i can't drag to move them."* DEV-469's
 * spec moved points by clicking the ground and never touched the gizmo, which
 * is how that shipped. This spec does what a hand does, through
 * `fixtures/canvas.ts`: a HOVER, then a PRESS, a MOVE and a RELEASE on the X
 * arrow — never a call into the editor in place of the gesture.
 *
 * The cause, for the next reader (index.ts's gizmo block has it in full): on
 * Anniversary, `render/bloom.ts` moves every `toneMapped: false` object onto
 * `UI_LAYER`, and TransformControls' meshes are all `toneMapped: false`, the
 * invisible picker included; the gizmo's ray tested layer 0 only, so it hit
 * nothing. `EDITOR_EDITION=classic` runs the same spec on Classic, where
 * bloom never ran and the gizmo always worked: the separating case.
 *
 * Then the camera, Maya's and Unreal's hands (the brief's list): Shift+left
 * pans (the target moves, the distance does not), middle pans, Alt+right
 * zooms (the distance moves, the target does not), F frames the point, and the
 * near plane follows the distance. The follow-up (Matt: "right-drag fly-look
 * like UE"): a right-drag turns the view where the eye stands and hands back
 * to the orbit with no jump, W held with the right button moves the eye along
 * its view, W alone does nothing, and no context menu opens. None of it may move while the gizmo holds
 * the drag: the X drag asserts the camera stood still.
 *
 * `EDITOR_PHOTO_DIR=<dir>` adds the shoreline photographs (framed, and zoomed
 * out a little, as Matt described), named by the near plane they were taken
 * with, for the before/after in DEV-472's row.
 *
 * Tagged `@gpu`; the tier is pinned (`PINNED`), because the photos are looked at.
 */
import fs from 'node:fs'
import path from 'node:path'
import { clickCanvasAt, dragCanvas, holdCanvasButton, hoverCanvasAt } from './fixtures/canvas'
import { collectPageErrors, openEditorFromTitle } from './fixtures/editor-boot'
import { liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const EDITION = process.env.EDITOR_EDITION ?? ''
const PHOTO_DIR = process.env.EDITOR_PHOTO_DIR ?? ''

type V3 = [number, number, number]
interface DeskProbe {
  points: V3[]
  selection: number | null
  groundReady: boolean
  camera: {
    position: V3
    target: V3
    distance: number
    near: number
    far: number
    flying: boolean
    direction: V3
  }
  gizmo: { attached: boolean; axis: string | null; dragging: boolean }
}
interface GizmoDebug {
  gizmoHandle(axis: 'X' | 'Y' | 'Z'): { x: number; y: number } | null
  gizmoColour(axis: 'X' | 'Y' | 'Z'): number | null
  gizmoLayers(): { picker: number[]; ray: number }
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const debug = <K extends keyof GizmoDebug>(
  page: Page,
  name: K,
  ...args: Parameters<GizmoDebug[K]>
): Promise<ReturnType<GizmoDebug[K]>> =>
  page.evaluate(
    ([n, a]) => {
      const w = globalThis as unknown as Ff2Global
      const d = w.__ff2.editorDebug() as unknown as Record<
        string,
        (...x: unknown[]) => unknown
      > | null
      if (!d) throw new Error('no editor debug')
      return (d[n as string] as (...x: unknown[]) => unknown)(...(a as unknown[]))
    },
    [name, args] as const,
  ) as Promise<ReturnType<GizmoDebug[K]>>

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )

/** The camera has stopped moving (the orbit is damped): two reads a beat apart agree. */
const settled = async (page: Page): Promise<DeskProbe['camera']> => {
  let last = (await desk(page)).camera
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100)
    const now = (await desk(page)).camera
    if (dist(now.position, last.position) < 1e-3 && dist(now.target, last.target) < 1e-3) {
      return now
    }
    last = now
  }
  throw new Error('the camera never settled')
}

/**
 * In by the title's door, COURSES → MAKE A COURSE, as a creator comes: the
 * route that is the same before and after DEV-471 changes `?edit=1`'s boot.
 */
const openEditor = async (page: Page): Promise<void> => {
  const edition = EDITION ? `&edition=${EDITION}` : ''
  await openEditorFromTitle(page, { query: edition })
  // The panel's own rows, where DEV-473 puts them; the canvas is left of it.
  await expect(page.locator('[data-editor="controls"]')).toContainText('Shift+drag')
}

test.describe('@gpu the course editor’s hands (DEV-472)', () => {
  test.setTimeout(600_000)

  test('a hovered arrow lights, a drag moves the point along it, and the camera takes Maya’s hands', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    await openEditor(page)
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    // The free viewport is left of the panel (300 px and its margin).
    const free = { width: view.width - 324, height: view.height }

    // ── a point, by clicking the ground: the new point is selected ──────
    await clickCanvasAt(page, free.width * 0.45, free.height * 0.55)
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(2) // DEV-501: the pad's, and this
    await expect.poll(async () => (await desk(page)).gizmo.attached).toBe(true)
    // Let the gizmo draw (its meshes are placed when the frame renders).
    await page.waitForTimeout(500)
    const layers = await debug(page, 'gizmoLayers')
    console.log(`[DEV-472] gizmo picker layer masks ${layers.picker}, its ray's ${layers.ray}`)

    // ── HOVER: the X arrow lights ───────────────────────────────────────
    const red = await debug(page, 'gizmoColour', 'X')
    expect(red, 'the X arrow is drawn red at rest').toBe(0xff0000)
    const handle = await debug(page, 'gizmoHandle', 'X')
    expect(handle, 'the X arrow is on screen').not.toBeNull()
    const at = handle as { x: number; y: number }
    expect(at.x > 0 && at.x < free.width && at.y > 0 && at.y < free.height).toBe(true)
    await hoverCanvasAt(page, at.x, at.y)
    await expect
      .poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000, message: 'hover picks X' })
      .toBe('X')
    await expect
      .poll(async () => debug(page, 'gizmoColour', 'X'), { message: 'the hovered arrow lights' })
      .toBe(0xffff00)

    // ── PRESS, MOVE, RELEASE: the point moves along X, and only X ──────
    const before = await desk(page)
    const p0 = before.points[1] as V3
    const camera0 = await settled(page)
    await dragCanvas(page, at, { x: at.x + 80, y: at.y }, { steps: 16 })
    await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    const after = await desk(page)
    expect(after.points.length, 'a drag of the gizmo adds no point').toBe(2)
    const p1 = after.points[1] as V3
    console.log(
      `[DEV-472] X drag moved the point ${p0.map((v) => v.toFixed(1))} -> ${p1.map((v) => v.toFixed(1))}`,
    )
    // Viewed from the south, screen-right is +x: the point went east.
    expect(p1[0] - p0[0], 'the point moved along +X').toBeGreaterThan(5)
    expect(Math.abs(p1[1] - p0[1]), 'and not in Y').toBeLessThan(1e-6)
    expect(Math.abs(p1[2] - p0[2]), 'and not in Z').toBeLessThan(1e-6)
    // The orbit did not take the drag.
    const camera1 = await settled(page)
    expect(dist(camera1.position, camera0.position), 'the camera stood still').toBeLessThan(1e-3)
    expect(dist(camera1.target, camera0.target)).toBeLessThan(1e-3)

    // Somewhere clear of the point and its gizmo, for the camera's drags.
    const clear = { x: free.width * 0.2, y: free.height * 0.8 }

    // ── Shift+left: a pan. The target moves; the distance does not ──────
    await dragCanvas(page, clear, { x: clear.x + 150, y: clear.y - 60 }, { modifiers: ['Shift'] })
    const panned = await settled(page)
    expect(dist(panned.target, camera1.target), 'Shift+drag moved the target').toBeGreaterThan(1)
    expect(Math.abs(panned.distance - camera1.distance) / camera1.distance).toBeLessThan(0.005)
    expect((await desk(page)).points.length, 'a Shift+drag places nothing').toBe(2)

    // ── middle: a pan too ────────────────────────────────────────────────
    await dragCanvas(page, clear, { x: clear.x - 120, y: clear.y - 40 }, { button: 'middle' })
    const panned2 = await settled(page)
    expect(dist(panned2.target, panned.target), 'middle-drag moved the target').toBeGreaterThan(1)
    expect(Math.abs(panned2.distance - panned.distance) / panned.distance).toBeLessThan(0.005)

    // ── Alt+right: a zoom. The distance moves; the target does not ──────
    await dragCanvas(
      page,
      clear,
      { x: clear.x, y: clear.y - 120 },
      {
        button: 'right',
        modifiers: ['Alt'],
      },
    )
    const zoomed = await settled(page)
    expect(
      Math.abs(zoomed.distance - panned2.distance) / panned2.distance,
      'Alt+right-drag zoomed',
    ).toBeGreaterThan(0.02)
    expect(dist(zoomed.target, panned2.target), 'and did not pan').toBeLessThan(1e-3)
    expect((await desk(page)).points.length, 'an Alt+drag places nothing').toBe(2)

    // ── F: the selected point, framed ────────────────────────────────────
    await page.keyboard.press('f')
    const framed = await settled(page)
    expect(dist(framed.target, p1), 'F centres the selected point').toBeLessThan(0.01)
    expect(framed.distance).toBeLessThan(zoomed.distance)

    // ── the near plane follows the distance (policy.ts's fraction) ───────
    // (The camera rewrites its projection when the plane moves by 1 %.)
    for (const c of [framed, zoomed]) {
      const want = Math.max(0.08, c.distance * 0.005)
      expect(Math.abs(c.near - want) / want, `near at ${c.distance.toFixed(0)} m`).toBeLessThan(
        0.011,
      )
    }

    // ── right: FLY (the follow-up; Unreal's viewport) ───────────────────
    //
    // The browser's context menu is watched from the window, after the
    // canvas has had the event: the harness observes, the game is the same.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __menus: { opened: number } }
      w.__menus = { opened: 0 }
      globalThis.addEventListener('contextmenu', (e) => {
        if (!e.defaultPrevented) w.__menus.opened += 1
      })
    })
    const menus = (): Promise<number> =>
      page.evaluate(() => (globalThis as unknown as { __menus: { opened: number } }).__menus.opened)
    // A right-drag LOOKS: the view turns, the eye stays where it is.
    const look0 = await settled(page)
    await dragCanvas(page, clear, { x: clear.x + 100, y: clear.y - 40 }, { button: 'right' })
    const look1 = await settled(page)
    const turn =
      Math.acos(
        Math.min(
          1,
          look0.direction.reduce((s, v, i) => s + v * (look1.direction[i] as number), 0),
        ),
      ) *
      (180 / Math.PI)
    console.log(`[DEV-472] a 100 x 40 px right-drag turned the view ${turn.toFixed(1)} degrees`)
    expect(turn, 'the right-drag turned the view').toBeGreaterThan(10)
    expect(dist(look1.position, look0.position), 'and the eye stayed put').toBeLessThan(1e-3)
    // No jump into the orbit: its new target lies straight ahead of the eye,
    // at the distance the orbit had.
    const ahead = look1.target.map((t, i) => (t - (look1.position[i] as number)) / look1.distance)
    expect(
      dist(ahead, look1.direction),
      'the orbit takes over looking where the fly looked',
    ).toBeLessThan(1e-3)
    expect(Math.abs(look1.distance - look0.distance) / look0.distance).toBeLessThan(1e-3)
    expect(look1.flying).toBe(false)

    // W held while right is held moves the eye forward, along the view.
    let midFly = false
    await holdCanvasButton(page, clear, 'right', async () => {
      await page.waitForTimeout(100)
      midFly = (await desk(page)).camera.flying
      await page.keyboard.down('KeyW')
      await page.waitForTimeout(600)
      await page.keyboard.up('KeyW')
    })
    expect(midFly, 'holding right is flying').toBe(true)
    const flown = await settled(page)
    const moved = flown.position.map((p, i) => p - (look1.position[i] as number))
    const along = moved.reduce((s, v, i) => s + v * (look1.direction[i] as number), 0)
    console.log(`[DEV-472] W for 0.6 s moved the eye ${along.toFixed(1)} m along its view`)
    expect(along, 'W moved the eye forward').toBeGreaterThan(5)
    expect(Math.hypot(...moved) - along, 'and only forward').toBeLessThan(0.05 * along + 0.5)
    // W alone, without the button, is not the fly's.
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(300)
    await page.keyboard.up('KeyW')
    expect(
      dist((await settled(page)).position, flown.position),
      'W alone moves nothing',
    ).toBeLessThan(1e-3)
    expect(await menus(), 'no context menu opened over the canvas').toBe(0)
    // DEV-478: every editor spec's course is flyable. DEV-501: a new draft's
    // first point is the pad's, so the one click made a COURSE (it was one
    // point, nothing to judge, before): Lift it clear, as a person would.
    await liftToFlyable(page, 'the pad’s point and the one clicked')

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })

  test('the shoreline from the framed island and zoomed out a little (photographs)', async ({
    page,
  }) => {
    test.skip(!PHOTO_DIR, 'EDITOR_PHOTO_DIR names where the photographs go')
    fs.mkdirSync(PHOTO_DIR, { recursive: true })
    await openEditor(page)
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    const centre = { x: (view.width - 324) / 2, y: view.height / 2 }
    // The panel's Frame island, as the editor opens; then the wheel, out.
    await page.locator('[data-editor="frame"]').click()
    const shots: { name: string; distance: number; near: number }[] = []
    for (const [name, ticks] of [
      ['framed', 0],
      ['out-a-little', 3],
    ] as const) {
      await page.mouse.move(centre.x, centre.y)
      for (let i = 0; i < ticks; i++) {
        await page.mouse.wheel(0, 120)
        await page.waitForTimeout(80)
      }
      const cam = await settled(page)
      // Two frames a beat apart: the sea moves, and a shore that fights
      // flickers between them.
      for (const beat of [0, 1]) {
        const file = `${name}-near${cam.near.toFixed(2)}-d${cam.distance.toFixed(0)}-${beat}.png`
        await page.screenshot({ path: path.join(PHOTO_DIR, file) })
        await page.waitForTimeout(250)
      }
      shots.push({ name, distance: cam.distance, near: cam.near })
    }
    fs.writeFileSync(path.join(PHOTO_DIR, 'shots.json'), JSON.stringify(shots, null, 2))
  })
})
