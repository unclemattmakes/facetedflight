/**
 * A water level in the desert canyon, from the editor's switch to a flight
 * over it. DEV-500.
 *
 * The desert has no sea; a course's water brings one — the shipped sea plate,
 * borrowed and lifted to the level (`game/terrain/course-water.ts`). In by
 * `?edit=1&mission=adv_01_hoverJet`: the Base picker lists one island's bases,
 * so the canyon is reached the way a player's link to it reaches it, and
 * nothing in the game takes another path. A course round the pad (real
 * clicks, `fixtures/canvas.ts`), made flyable by LIFT (DEV-478's fixture);
 * then Water on, the world built with it, the level dragged and previewed on
 * the plate, the ground checks judging against it, and FLY: the flight's world
 * has the sea, its collision surface at the level, photographed.
 *
 * The cost: `renderer.info.render.calls` and triangles in the seat, the
 * median over 60 frames with the sea shown and hidden (the harness hides the
 * group to MEASURE it, as `ambient-traffic.spec.ts` does; the game never
 * does), printed for DEV-500's row.
 *
 * Photos go to `EDITOR_PHOTO_DIR` (default `test-results/editor-water`).
 * Tagged `@gpu`, tier pinned (`PINNED`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt } from './fixtures/canvas'
import {
  collectPageErrors,
  editorHold as hold,
  openEditor,
  waitForEditor,
} from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-water')

type V3 = [number, number, number]

/** Imported by URL in the page: the module the game runs (see `fixtures/editor-course.ts`). */
const HEIGHT_FIELD_URL = '/src/sim/terrain/height-field.ts'

interface DeskProbe {
  points: V3[]
  groundReady: boolean
  pad: V3
  gap: number // DEV-501
  start: { pos: V3; yaw: number } // DEV-501
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

/** The sea the game built: its key, the plate's y, and its COLLISION height at (x, z). */
const sea = (page: Page, at: V3) =>
  page.evaluate(
    async ([x, z, url]) => {
      const hf = (await import(/* @vite-ignore */ url)) as {
        terrainHeightAt(f: unknown, x: number, z: number): number
      }
      const w = globalThis as unknown as Ff2Global
      const o = w.__ff2.terrain()?.ocean
      if (!o) return null
      // The height field is in SIM space: three's z mirrored.
      return {
        key: o.key,
        y: o.group.position.y,
        collide: hf.terrainHeightAt(o.heightField, x, -z),
      }
    },
    [at[0], at[2], HEIGHT_FIELD_URL] as const,
  )

const readoutY = async (page: Page): Promise<number> => {
  const text = (await page.locator('[data-editor="water-readout"]').textContent()) ?? ''
  const m = /(-?\d+) m/.exec(text)
  if (!m) throw new Error(`no level in "${text}"`)
  return Number(m[1])
}

/** `renderer.info.render.calls` and triangles over `frames` frames, median. */
const census = (page: Page, frames: number) =>
  page.evaluate(async (n) => {
    const w = globalThis as unknown as Ff2Global
    const calls: number[] = []
    const tris: number[] = []
    const dt: number[] = []
    let last = performance.now()
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      const now = performance.now()
      dt.push(now - last)
      last = now
      calls.push(w.__ff2.render.renderer.info.render.calls)
      tris.push(w.__ff2.render.renderer.info.render.triangles)
    }
    const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
    return { calls: mid(calls), tris: mid(tris), ms: mid(dt) }
  }, frames)

const showSea = (page: Page, on: boolean): Promise<void> =>
  page.evaluate((v) => {
    const w = globalThis as unknown as Ff2Global
    const o = w.__ff2.terrain()?.ocean
    if (o) o.group.visible = v
  }, on)

test.describe('@gpu a water level in the desert canyon (DEV-500)', () => {
  test.setTimeout(600_000)

  test('switched on, built, dragged, judged, flown over and photographed', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })

    await openEditor(page, { mission: 'adv_01_hoverJet' })
    expect(await sea(page, [0, 0, 0]), 'the canyon has no sea of its own').toBeNull()
    await expect(page.locator('[data-editor="water-readout"]')).toContainText('No water')

    // ── a course round the pad ──────────────────────────────────────────
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(1_500)
    // DEV-501: ring 1 is the pad's, one gap ahead of it. The canyon pad's own
    // heading faces the mesa, and a new draft is turned (only) until ring 1
    // clears it (`anchorHeading`), so the course below needs no hand on the pad.
    {
      const d0 = await desk(page)
      console.log(`[DEV-501] the canyon pad faces ${d0.start.yaw}° (gap ${d0.gap} m)`)
    }
    // DEV-501 follow-up (Matt): the panel says the desk turned the pad.
    await expect(page.locator('[data-editor="pad-turn-note"]')).toHaveText(
      /^The pad turned \d+° so ring 1 clears the ground\.$/,
    )
    const pad = (await desk(page)).pad
    const r = 500
    const y = pad[1] + 150
    const corners: V3[] = [
      [pad[0] - r, y, pad[2] - r],
      [pad[0] + r, y, pad[2] - r],
      [pad[0] + r, y, pad[2] + r],
      [pad[0] - r, y, pad[2] + r],
    ]
    // A click on the pad or a point picks it instead of adding one (DEV-475):
    // drop the pick and click 150 m further out, as editor-island.spec does.
    for (const c of corners) {
      for (let tries = 0; tries < 4; tries++) {
        const before = (await desk(page)).points.length
        const out = tries * 150
        const at = await screenOf(page, [
          c[0] + out * Math.sign(c[0] - pad[0]),
          c[1],
          c[2] + out * Math.sign(c[2] - pad[2]),
        ])
        if (!at) throw new Error('a corner is off the screen')
        await clickCanvasAt(page, at.x, at.y)
        await page.waitForTimeout(250)
        if ((await desk(page)).points.length > before) break
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      }
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5) // DEV-501: the pad's, and four
    await page.keyboard.press('Escape')
    await liftToFlyable(page, 'a loop round the canyon pad')

    // ── Water on: the world is built again, with a sea in it ────────────
    await page.locator('[data-editor="water"]').check()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'switching', {
      timeout: 30_000,
    })
    await missionReady(page)
    await waitForEditor(page)
    await expect
      .poll(async () => (await sea(page, pad))?.key, { timeout: 60_000 })
      .toMatch(/\.ocean$/)
    const first = await readoutY(page)
    console.log(`[DEV-500] water on: it stands at ${first} m (the pad at ${pad[1].toFixed(1)} m)`)
    expect(first, 'under the pad').toBeLessThan(pad[1])
    await expectFlyable(page, 'the course over its water')
    await page.waitForTimeout(1_000)
    await page.screenshot({ path: path.join(OUT, 'editor-water-on.png') })

    // ── the level dragged: the plate moves at once, the world is not rebuilt ─
    const before = await sea(page, pad)
    // Up, and still under the pad (the first level stands at most 20 m under it).
    const raised = first + 10
    await page.locator('[data-editor="water-level"]').fill(String(raised))
    await expect.poll(async () => readoutY(page)).toBe(raised)
    await expect
      .poll(async () => ((await sea(page, pad))?.y ?? 0) - (before?.y ?? 0), { timeout: 5_000 })
      .toBeGreaterThan(8)
    expect(await page.locator('body').getAttribute('data-editor')).toBe('editing')
    // Lifted to a line above the pad, the checks bury what is under it.
    await page.locator('[data-editor="water-level"]').fill(String(Math.ceil(y + 60)))
    await expect(page.locator('[data-editor="refusal"]')).not.toBeEmpty({ timeout: 10_000 })
    await page.locator('[data-editor="water-level"]').fill(String(raised))
    await expectFlyable(page, 'back under the pad')

    // ── FLY: the flight's world has the sea at the level, as a crash surface ─
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    const flown = await sea(page, pad)
    expect(flown?.key, 'the flight has a sea').toMatch(/\.ocean$/)
    // The collision surface stands at the level, to within the plate's own
    // map (±1.2 m) and its facets.
    expect(
      Math.abs((flown?.collide ?? Number.NaN) - raised),
      'collision at the level',
    ).toBeLessThan(6)
    await page.waitForTimeout(1_500)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'Enter', 150)
    await page.keyboard.down('Space')
    await page.waitForTimeout(2_500)
    await page.keyboard.up('Space')
    await hold(page, 'v', 120)
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: path.join(OUT, 'flight-over-the-water.png') })

    // ── the cost, in the seat's frame ───────────────────────────────────
    await hold(page, 'v', 120)
    await page.waitForTimeout(800)
    const withSea = await census(page, 60)
    await showSea(page, false)
    const without = await census(page, 60)
    await showSea(page, true)
    console.log(
      `[DEV-500] the sea over the canyon, seat view: +${withSea.calls - without.calls} draw calls, ` +
        `+${withSea.tris - without.tris} triangles (with ${withSea.calls} / ${withSea.tris}, ` +
        `without ${without.calls} / ${without.tris}); median frame ${withSea.ms.toFixed(2)} ms ` +
        `vs ${without.ms.toFixed(2)} ms`,
    )
    expect(withSea.calls).toBeGreaterThan(without.calls)

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
