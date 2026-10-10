/**
 * tests/e2e/loading-scene-photos.spec.ts — what you stand in while a course
 * loads, photographed. DEV-355.
 *
 * The loading scene is up for as long as the build runs, which since DEV-355
 * hands the thread back between slices — so the page keeps drawing, and a
 * screenshot taken mid-load is a picture of a live frame rather than a spec
 * waiting on a frozen one. That is itself half the claim: if the build still
 * held the thread, the shots below would time out or come back identical.
 *
 * Three frames, flat, pinned: the scene once it has faded in, the same moment a
 * second later (the bar and the turning mark have moved, nothing else has), and
 * the seat turned with the stick's keyboard twin — the plate must move across
 * the frame, because it is WORLD-locked and the view is what turned.
 *
 * On the CLASSIC look since DEV-465: a course picked in the room on
 * Anniversary is waited out in the room itself (`hangar-load.spec.ts`
 * photographs that), and the loading scene is the route a Classic look takes,
 * because its flip needs a black (`boot/load-place.ts`).
 *
 *   E2E_PORT=<yours> LOADING_PHOTO_DIR=<dir> \
 *     pnpm exec playwright test tests/e2e/loading-scene-photos.spec.ts --workers 1
 *
 * `@gpu`: a real world and a headed browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const OUT = process.env.LOADING_PHOTO_DIR ?? 'perf-out/dev-355/photos'

interface LoadingProbe {
  readonly shown: boolean
  readonly fade: string | null
  /** The plate's centre on the canvas, 0..1 across. Null when it is off the frame. */
  readonly plateX: number | null
}

/** Read the loading scene out of the live stage, by name. */
const probe = (page: Page): Promise<LoadingProbe> =>
  page.evaluate(() => {
    interface Obj {
      visible: boolean
      getObjectByName: (n: string) => Obj | undefined
      getWorldPosition: (v: unknown) => { project: (c: unknown) => { x: number; z: number } }
    }
    const ff = (
      globalThis as unknown as {
        __ff2?: {
          stage: () => Obj
          render: { camera: { position: { constructor: new () => unknown } } }
        }
      }
    ).__ff2
    const scene = ff?.stage().getObjectByName('loading-scene')
    const plate = scene?.getObjectByName('loading-plate')
    let plateX: number | null = null
    if (ff && plate && scene?.visible) {
      const Vector3 = ff.render.camera.position.constructor
      const p = plate.getWorldPosition(new Vector3()).project(ff.render.camera)
      plateX = p.z < 1 && Math.abs(p.x) <= 1 ? (p.x + 1) / 2 : null
    }
    return {
      shown: scene?.visible === true,
      fade: document.body.dataset.fade ?? null,
      plateX,
    }
  })

test.describe('@measure @gpu DEV-355: the loading scene, photographed', () => {
  test.setTimeout(300_000)

  test('int_01_hoverJet from the room: the scene, a second later, and turned', async ({ page }) => {
    // Classic: the look whose boarding still goes through the scene (DEV-465).
    await page.goto(`/?xr=off&${PINNED}&edition=classic`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await page.waitForTimeout(1_500)
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    const pinned = await drawState(page)

    fs.mkdirSync(OUT, { recursive: true })
    const shoot = async (name: string): Promise<string> => {
      const file = path.join(
        OUT,
        `loading-scene-int_01-${PINNED.replace(/[=&]/g, '-')}-${name}.png`,
      )
      await page.locator('#viewport').screenshot({ path: file })
      return file
    }

    // The walk ends in the press that starts the load. Not awaited: the
    // pictures are taken while it runs, and `board` returns when it is done.
    const boarding = board(page, INT_01_HOVERJET, 0)

    // Up, and faded in: the fade reports `idle` once the loading scene's own
    // fade-in has finished.
    await expect
      .poll(
        async () => {
          const p = await probe(page)
          return p.shown && p.fade === 'idle'
        },
        { timeout: 120_000, intervals: [50] },
      )
      .toBe(true)
    const first = await probe(page)
    const shots = [await shoot('1-up')]
    await page.waitForTimeout(1_000)
    shots.push(await shoot('2-a-second-later'))

    // Turn the seat. The plate is world-locked, so it must move ACROSS the
    // frame; a head-locked plate would sit still while the ground turned.
    const before = await probe(page)
    for (let i = 0; i < 4; i++) {
      await page.keyboard.down('KeyD')
      await page.waitForTimeout(80)
      await page.keyboard.up('KeyD')
      await page.waitForTimeout(80)
    }
    const after = await probe(page)
    const stillUp = after.shown
    if (stillUp) shots.push(await shoot('3-turned'))

    await boarding
    // The mission is in, and the loading scene goes down at the black of the
    // fade into the cockpit — a beat AFTER `board` returns, so polled.
    await expect
      .poll(async () => (await probe(page)).shown, {
        timeout: 30_000,
        message: 'the loading scene is gone once you are aboard',
      })
      .toBe(false)
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held for every shot').toEqual([])

    console.info(
      [
        `\nDEV-355 — the loading scene, ${PINNED}`,
        `  shown ${first.shown}, plate at ${first.plateX?.toFixed(3) ?? 'off-frame'} across`,
        stillUp
          ? `  turned: plate ${before.plateX?.toFixed(3) ?? 'off'} -> ${after.plateX?.toFixed(3) ?? 'off-frame'}`
          : '  the load finished before the turn: no turned shot this run',
        ...shots.map((s) => `  ${path.resolve(s)}`),
        '',
      ].join('\n'),
    )
    // World-locked, asserted as a relationship: the turn moved it.
    if (stillUp && before.plateX !== null) {
      expect(after.plateX, 'the plate moved across the frame when the seat turned').not.toBe(
        before.plateX,
      )
    }
  })
})
