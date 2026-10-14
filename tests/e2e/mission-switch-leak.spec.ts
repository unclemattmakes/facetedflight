/**
 * A course loaded again in one page holds what it held the last time. DEV-936.
 *
 * Loading missions through the hangar grew `renderer.info.memory` on every
 * load (the lead's capture, 2026-10-13: geometries 267, 272, 276, 289 and
 * textures 98 to 101 over four `adv_01` loads with `int_01` between). Three
 * owners, named by a registry on three's own dispose listeners: the ring
 * frame's and the turn arrow's baked geometry clones, which their disposes
 * never freed, and the coast height map `build.ts` hands the sea on an ocean
 * world, which nothing freed. `tests/unit/mission-switch-leak.test.ts` holds
 * each at its owner; this holds the whole page.
 *
 * The walk is a player's: board from the room, pause, EXIT, back to the doors,
 * board again. It reads `__ff2perf.info()` (the renderer's own memory counts)
 * on the pad and in the room after each load, and asserts the SECOND switched
 * load of `int_01` equals the FIRST, in both places. The page's first load is
 * warm-up, not leak: the room builds its captions and tables the first time
 * they are walked, and the first cockpit uploads once.
 *
 * `int_01` is the course that matters, because it is an OCEAN world and so
 * carries all three owners. `adv_01` goes first and between, for two reasons:
 * a switch is then a switch to a different world, as the lead's capture had
 * it, and `?title=0` boots `int_01` itself, so boarding it first would board
 * the course already loaded, which rebuilds nothing.
 *
 * The premise is checked as well as the outcome: each load must log its own
 * `level select: now flying` line, so a press that never reloaded the world
 * cannot pass by changing nothing. (Boarding the course already loaded is
 * that case, and it is why the lead's capture saw 13 geometries jump on its
 * back-to-back `adv_01`: the same world, plus the room's diorama for it.)
 *
 *   E2E_PORT=<yours> pnpm exec playwright test mission-switch-leak
 *
 * Tagged `@gpu`.
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2Global, Ff2PerfGlobal } from './fixtures/ff2'
import { board, type Course, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { pausePlateState } from './fixtures/pause-menu'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const ADV_01_HOVERJET: Course = {
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  rank: 'advanced',
  id: 'adv_01_hoverJet',
}

interface Memory {
  readonly geometries: number
  readonly textures: number
}

/** The renderer's own counts, once the frame has settled. */
const memory = async (page: Page): Promise<Memory> => {
  await page.waitForTimeout(2_000)
  return page.evaluate(() => {
    const info = (globalThis as unknown as Ff2PerfGlobal).__ff2perf.info() as Memory
    return { geometries: info.geometries, textures: info.textures }
  })
}

const view = (page: Page): Promise<{ screen: string; view: string } | null> =>
  page.evaluate(() => {
    const aim = (globalThis as unknown as Ff2Global).__ff2.hangarAim()
    return aim ? { screen: aim.screen, view: aim.view } : null
  })

/** From the pad: pause, EXIT, and step back to the room's doors. */
const backToDoors = async (page: Page): Promise<void> => {
  await expect
    .poll(
      async () => {
        if ((await pausePlateState(page)).open) return true
        await hold(page, 'Backspace')
        return (await pausePlateState(page)).open
      },
      { message: 'the pause plate opens on the pad', timeout: 30_000 },
    )
    .toBe(true)
  // EXIT by the mouse, not the arrow keys. On a flat screen the plate's "gaze"
  // is the ship's forward (`pause-state.ts`), and a gaze on a row takes the
  // selection every frame it lands. On the pad, under load, the arrow-key walk
  // (`pressPauseRow`) lost to it for 20 s: a failed run's screencast shows the
  // arrows moving the highlight and the plate snapping back to RESUME. A cursor
  // over a row hands the plate to the cursor (`pauseCursorAim`), as a player
  // with a mouse does.
  let wiggle = 0
  await expect
    .poll(
      async () => {
        const p = await pausePlateState(page)
        const exit = p.rows.findIndex((r) => r.id === 'exit')
        if (exit >= 0 && p.selected === exit) return 'selected'
        const y = p.edges?.rowY[exit]
        if (p.edges && y !== undefined) await page.mouse.move(p.edges.x, y + (wiggle++ % 2))
        return `at ${p.selected}, want ${exit}`
      },
      { message: 'the cursor is on EXIT', timeout: 20_000 },
    )
    .toBe('selected')
  await hold(page, 'Enter')
  await expect
    .poll(async () => (await view(page))?.screen, {
      message: 'EXIT went back to the room',
      timeout: 60_000,
    })
    .toBe('menu')
  await expect
    .poll(
      async () => {
        const at = await view(page)
        if (at?.view === 'doors') return 'doors'
        await hold(page, 'Backspace')
        return at?.view
      },
      { message: 'stepped back to the doors', timeout: 30_000 },
    )
    .toBe('doors')
}

test.describe('@gpu DEV-936: a mission switch leaves nothing on the GPU', () => {
  test('a course loaded again holds what it held the first time, on the pad and in the room', async ({
    page,
  }) => {
    test.setTimeout(900_000)
    const flown: string[] = []
    page.on('console', (m) => {
      const hit = /level select: now flying (\S+)/.exec(m.text())
      if (hit?.[1]) flown.push(hit[1])
    })
    await page.goto(`/?xr=off&title=0&perf=1&${PINNED}`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)

    const load = async (course: Course): Promise<{ pad: Memory; room: Memory }> => {
      const before = flown.length
      await board(page, course)
      await switchSettled(page, 240_000)
      expect(flown.slice(before), `${course.id}: the press loaded a world`).toEqual([course.id])
      const pad = await memory(page)
      await backToDoors(page)
      const room = await memory(page)
      return { pad, room }
    }

    await load(ADV_01_HOVERJET) // warm-up: the room's first walk, the first cockpit
    const first = await load(INT_01_HOVERJET)
    await load(ADV_01_HOVERJET)
    const second = await load(INT_01_HOVERJET)

    // Positive first: a page that reported nothing would pass the equalities.
    expect(first.pad.geometries).toBeGreaterThan(0)
    expect(first.pad.textures).toBeGreaterThan(0)
    expect(second.pad, 'int_01 on the pad, second load against first').toEqual(first.pad)
    expect(second.room, 'the room after int_01, second load against first').toEqual(first.room)
  })
})
