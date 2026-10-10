/**
 * The title's START, and what is left of Quick Race. DEV-353; DEV-558.
 *
 * **DEV-558 took Quick Race off the title.** Matt, 2026-10-01: *"Title Screen:
 * Start, Enter VR. Clicking either should take us to the Hangar"*. Its ROUTE
 * (`startQuickRace`: one black into the loading scene, no ride, the countdown
 * by itself) is still the game's, and is taken now only by a shared lap's
 * RACE A GHOST row, which `ghost-share.spec.ts` boards through. So this file
 * pins what the title is now: START and ENTER VR and no Quick Race row; START
 * as ONE black to the hangar's first step, seen by the same per-frame recorder
 * DEV-353's route test used; and a cursor click on a row as a press of it.
 *
 * **DEV-565 put Quick Race back, as the hangar's fourth door** (Matt,
 * 2026-10-02: *"add quick race as a 4th table"*): QUICK RACE beside SINGLE
 * PLAYER on the first step. Its test below pins claims 2 to 4 of the list that
 * follows, from the ROOM; claim 5 is the title's route and stands on a ghost
 * link's run.
 *
 * What the DEV-353 version pinned, kept here for the record:
 *
 * Matt, 2026-09-24: *"want to fly within 20 seconds - add a quick race
 * option"*, and in chat: *"a random HoverJet Ring Attack course, and skip the
 * ride."* The playtest measured ~65 s from the link to the stick, 19.9 s of it
 * the launch press to control (the 15.5 s ride plus the countdown).
 *
 * What the old file pinned, with nothing pressed after the title press:
 *
 *   1. the title offers the row, and the arrow key reaches it — the keyboard is
 *      one of the title's five inputs and the one a spec can drive without a
 *      headset or a phone (the mouse is the second test, below);
 *   2. the press boards a course whose OWN fields say HoverJet and Ring Attack
 *      (`__ff2.course()`, which reads the level and the running mode), with the
 *      racers on the grid;
 *   3. the elevator never runs: the launch is never `rising`, and the ship is
 *      at the top of the shaft on every sample from the moment the mission is
 *      on screen;
 *   4. it counts down and lets go by itself, and the press-to-release time the
 *      build writes down (`data-quick-race-ms`) is under the 20 s Matt asked
 *      for. The number is logged for the row;
 *   5. the route is title -> ONE black -> the loading scene -> the cockpit, and
 *      the hangar is never on screen on the way (DEV-353 follow-up). Recorded
 *      every animation frame in the page; the transition count is the half
 *      that failed on `7d9a86e` (two blacks), because with the level already
 *      cached the second fade began while the screen was still black and no
 *      frame ever showed the room.
 *
 * Against the tree before this row, 1 fails: the title has one thing to do
 * and no rows to walk.
 *
 * Driven the way `switch-course.spec.ts` drives the hangar: keys HELD for a
 * frame or more, because every confirm is a level read once a frame and a tap
 * lands between frames.
 */

import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import {
  DOOR_QUICK_RACE,
  DOOR_SINGLE,
  hangarAim,
  hangarOn,
  hold,
  pressDoor,
} from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'
import { hangarDoors, TITLE_ROW } from './fixtures/title'

interface TitleMenuProbe {
  up: boolean
  selected: number
  rows: string[]
  rowsAt: { x: number; y: number }[] | null
}

const titleMenu = async (page: Page): Promise<TitleMenuProbe | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.titleMenu?.() ?? null)

interface ScreenFrame {
  stage: string
  hangar: boolean
  loading: boolean
  fade: number
  /** `__ff2.fade().screenFades`: transitions queued so far, one black each. */
  fades: number
}

/**
 * Record, EVERY animation frame, which stage is drawn, whether the hangar room
 * and DEV-355's loading scene are in it, and how black the fade is.
 *
 * Per frame and in the page, because the thing it exists to catch — a hangar
 * glimpsed between two fades — can last a handful of frames, which a 100 ms
 * poll from outside would step over. It reads only; it stops itself once the
 * build writes the press-to-stick time.
 */
const recordScreens = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    type Named = { visible: boolean }
    type Stage = { name?: string; getObjectByName: (n: string) => Named | undefined }
    const w = globalThis as unknown as {
      __ff2?: { stage: () => Stage; fade: () => { amount: number; screenFades?: number } }
      __qrFrames?: unknown[]
    }
    const frames: unknown[] = []
    w.__qrFrames = frames
    const start = performance.now()
    const sample = (): void => {
      const app = w.__ff2
      if (!app) return
      const stage = app.stage()
      frames.push({
        stage: stage.name ?? '',
        hangar: stage.getObjectByName('hangar')?.visible ?? false,
        loading: stage.getObjectByName('loading-scene')?.visible ?? false,
        fade: app.fade().amount,
        fades: app.fade().screenFades ?? Number.NaN,
      })
    }
    // Sample 0 NOW, before the caller presses anything. The game's own frame
    // callback runs ahead of this one in every frame, so the first rAF sample
    // is already AFTER the press's frame and would count its fade as history.
    sample()
    const tick = (): void => {
      sample()
      if (!document.body.dataset.quickRaceMs && performance.now() - start < 120_000) {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)
  })
}

const readScreens = async (page: Page): Promise<ScreenFrame[]> =>
  page.evaluate(
    () =>
      ((globalThis as unknown as { __qrFrames?: ScreenFrame[] }).__qrFrames ?? []) as ScreenFrame[],
  )

/** The title is up, its valley is in, and the card is out of the way. */
const toTheTitleRows = async (page: Page): Promise<TitleMenuProbe> => {
  await page.goto('/?xr=off')
  await bootReady(page)
  // The player's own first move: Start takes the card away. The rows wait for
  // it — they hang where the card's buttons are.
  await firstPress(page)
  await dropFocus(page)
  await expect
    .poll(async () => (await titleMenu(page))?.up ?? false, {
      message: 'the title offers its rows once the valley is in and the card is gone',
      timeout: 30_000,
    })
    .toBe(true)
  const menu = await titleMenu(page)
  if (!menu) throw new Error('no title menu')
  return menu
}

test.describe('@gpu the title’s START, and Quick Race’s route (DEV-353; DEV-558)', () => {
  test.setTimeout(240_000)

  test('the title is START and ENTER VR, with no Quick Race row', async ({ page }) => {
    // DEV-558: Matt, 2026-10-01, *"Title Screen: Start, Enter VR"*. Quick
    // Race left the menus; its route is a shared lap's RACE THIS LAP alone
    // (`ghost-share.spec.ts` boards through it), which needs a link.
    const top = await toTheTitleRows(page)
    expect(top.rows).toEqual([
      TITLE_ROW.hangar,
      TITLE_ROW.options,
      TITLE_ROW.enterVr,
      TITLE_ROW.makingOf,
      TITLE_ROW.newsletter,
    ])
    expect(top.rows).not.toContain(TITLE_ROW.quickRace)
    expect(top.selected, 'the title opens on START').toBe(0)
  })

  test('START is ONE black to the hangar’s first step, and the recorder sees the hangar', async ({
    page,
  }) => {
    // The loud counterpart DEV-353's route test kept, on the route that goes
    // to the room. A probe that reports "no hangar" must be shown able to
    // report one, or a renamed object or a wrong stage name would turn every
    // such assertion into `0 === 0` for ever.
    await toTheTitleRows(page)
    await recordScreens(page)
    await hold(page, 'Enter', 0)
    // Waited for, not slept: the room's first un-black frame came 2.3 s after
    // the press on 2026-09-27 (its build sits at the black for about 1.6 s).
    const seen = async () =>
      (await readScreens(page)).filter((f) => f.stage === 'menu' && f.hangar && f.fade < 1).length
    await expect
      .poll(seen, { message: 'START shows the hangar', timeout: 15_000 })
      .toBeGreaterThan(0)
    const frames = await readScreens(page)
    expect((frames.at(-1)?.fades ?? 0) - (frames[0]?.fades ?? 0), 'ONE black').toBe(1)
    // And it lands on the first step, the doors (DEV-558).
    await expect.poll(async () => (await hangarAim(page))?.view).toBe('doors')
  })

  test('DEV-565: the hangar’s QUICK RACE table boards a HoverJet Ring Attack race, no ride, by itself', async ({
    page,
  }) => {
    // Matt, 2026-10-02: *"add quick race as a 4th table"*. The route is
    // DEV-353's, taken from the ROOM: the course drawn by its own fields, the
    // racers on the grid, the ship at the top of the shaft from the first
    // sample, and the countdown let go with nothing else pressed, under
    // Matt's 20 seconds from the press.
    await toTheTitleRows(page)
    await hold(page, 'Enter', 0)
    await hangarOn(page, 'doors')
    const doors = await hangarDoors(page)
    // QUICK RACE stands immediately left of SINGLE PLAYER, wherever the row
    // starts (OPTIONS and, on a desktop, the Course Editor come first: DEV-879).
    const quick = doors.indexOf(DOOR_QUICK_RACE)
    expect(quick, 'QUICK RACE is a door').toBeGreaterThanOrEqual(0)
    expect(doors[quick + 1], 'QUICK RACE stands beside SINGLE PLAYER, to its left').toBe(
      DOOR_SINGLE,
    )
    const pressedAt = Date.now()
    await pressDoor(page, DOOR_QUICK_RACE, 0)
    await expect(page.locator('body')).toHaveAttribute('data-quick-race', /\S+/, {
      timeout: 15_000,
    })
    const picked = await page.getAttribute('body', 'data-quick-race')

    const phases = new Set<string>()
    let minRise = Number.POSITIVE_INFINITY
    let maxRise = Number.NEGATIVE_INFINITY
    let course: { id: string; vehicle: string; mode: string } | null = null
    let racers = 0
    let released = false
    while (Date.now() - pressedAt < 120_000) {
      const s = await page.evaluate(() => {
        const app = (globalThis as unknown as Ff2GlobalMaybe).__ff2
        if (!app) return null
        return {
          // The world being replaced still answers until the swap's black;
          // `data-switching` is set at the press and cleared once aboard.
          aboard:
            document.body.dataset.switching === undefined &&
            document.body.dataset.terrainReady === 'true' &&
            app.stage().name === 'mission',
          launch: app.launch(),
          course: app.course(),
          racers: app.racers()?.ships.length ?? 0,
          ms: document.body.dataset.quickRaceMs ?? null,
        }
      })
      if (s?.aboard && s.course.id === picked) {
        phases.add(s.launch.phase)
        minRise = Math.min(minRise, s.launch.rise)
        maxRise = Math.max(maxRise, s.launch.rise)
        course = s.course
        racers = s.racers
      }
      if (s?.ms) {
        released = true
        break
      }
      await page.waitForTimeout(100)
    }
    const buildMs = Number(await page.getAttribute('body', 'data-quick-race-ms'))
    console.info(
      `quick-race (hangar): ${picked}, stick in hand ${(buildMs / 1000).toFixed(1)} s after ` +
        `the press; phases ${[...phases].join(' > ')}; rise ${minRise.toFixed(3)}..` +
        `${maxRise.toFixed(3)} m; ${racers} racers`,
    )
    expect(course?.id, 'the course flown is the course drawn').toBe(picked)
    expect(course?.vehicle).toBe('hoverjet')
    expect(course?.mode).toBe('ringAttack')
    expect(racers, 'the racers are on the grid').toBeGreaterThan(0)
    expect([...phases], 'the ride never ran').not.toContain('rising')
    expect(phases.has('countdown'), 'it counted down').toBe(true)
    expect(minRise, 'the ship was at the top of the shaft from the first sample').toBeGreaterThan(
      50,
    )
    expect(maxRise - minRise, 'and never moved on the platform').toBeLessThan(1e-6)
    expect(released, 'the ship was released with nothing else pressed').toBe(true)
    expect(buildMs, 'stick in hand under 20 s from the press').toBeLessThan(20_000)
  })

  test('a mouse click on a row is a press of that row', async ({ page }) => {
    // The title's mouse is a cursor (DEV-301), so a click aims a ray from where
    // it lands, through the plate's own hit test. Found by the plate's layout
    // (`__ff2.titleMenu().rowsAt`), not by a coordinate somebody measured once.
    const menu = await toTheTitleRows(page)
    const at = menu.rowsAt?.[0]
    expect(menu.rows[0]).toBe(TITLE_ROW.hangar)
    expect(at, 'START is on screen').toBeDefined()
    if (!at) return
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await hangarAim(page))?.view, { timeout: 15_000 }).toBe('doors')
  })
})
