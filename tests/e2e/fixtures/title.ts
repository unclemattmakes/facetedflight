/**
 * The title's rows, walked by NAME. DEV-441; since DEV-558, START and ENTER VR.
 *
 * Matt, 2026-10-01: *"Title Screen: Start, Enter VR. Clicking either should
 * take us to the Hangar, where the first set of choices are: Single Player /
 * Multiplayer / FFTV."* So the title is one page: START (id `hangar`, the row
 * that always went there), ENTER VR, and a link's row above them when a link
 * brought the page (a shared lap's RACE THIS LAP and WATCH THIS LAP, DEV-571;
 * a shared course). Everything
 * DEV-441's doors and DEV-467's hub held is a holotable in the hangar now, and
 * {@link toHangarDoor} walks there: START, then the door, aimed by turning the
 * seat (`fixtures/hangar.ts`).
 *
 * A spec still names the row it wants and this walks to it, each aimed with the
 * arrow keys while reading where the aim IS, and pressed with a held Enter:
 * what a player does. (Memory: *"name the target, compute don't search"*:
 * fixed menu slots broke five helpers five ways once already.)
 */
import { expect, type Page } from '@playwright/test'
import {
  cameraYaw,
  DOOR_MULTIPLAYER,
  DOOR_SINGLE,
  hangarAim,
  hangarOn,
  hold,
  lookUntilAimed,
  pressDoor,
  turnSeatTo,
} from './hangar'

/** `__ff2.titleMenu()`, as a spec reads it. */
export interface TitleMenuProbe {
  up: boolean
  selected: number
  rows: string[]
  rowsAt: { x: number; y: number }[] | null
  /** DEV-895: the plate's bottom edge on the glass, css px. */
  plateBottom: number | null
  notes: string[]
  accents: boolean[]
  /** The page that is up: `top`, the one page since DEV-558. */
  page: string
  heading: string
  /** Every page's row ids: `{ top: rows }` since DEV-558. */
  pages: Record<string, string[]>
  /** DEV-441b: the letter plate (in the hangar since DEV-558), or null while it is down. */
  code: {
    typed: string
    selected: number
    keys: string[]
    keysAt: { x: number; y: number }[]
    footer: string
    joining: string | null
  } | null
  /** DEV-557's ENTER VR, a row since DEV-558. */
  vr: {
    shown: boolean
    state: string
    label: string
    note: string
    aimed: boolean
    at: { x: number; y: number } | null
  }
}

/** The title's row ids a spec names. `render/title-menu.ts` owns them. */
export const TITLE_ROW = {
  /** START: the hangar's first step (DEV-558). The row's id is the hangar row's. */
  hangar: 'hangar',
  /** DEV-859: OPTIONS, under START: the same page the pause plate opens. */
  options: 'options',
  /** ENTER VR, or CONNECT VR HEADSET (DEV-557; a row since DEV-558). */
  enterVr: 'enter-vr',
  /** DEV-373: a shared lap's RACE THIS LAP (DEV-353's Quick Race id, its route; DEV-571's words). */
  quickRace: 'quick-race',
  /** DEV-571: a shared lap's WATCH THIS LAP, where the build has TV. */
  watchLap: 'watch-lap',
  /** DEV-802: THE MAKING-OF, the making-of site, just above the newsletter; absent in a headset. */
  makingOf: 'making-of',
  /** DEV-658: JOIN THE FLIGHT CLUB, the newsletter, last; absent in a headset. */
  newsletter: 'newsletter',
} as const

export const titleMenu = (page: Page): Promise<TitleMenuProbe | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2?: { titleMenu?: () => TitleMenuProbe } }
      ).__ff2?.titleMenu?.() ?? null,
  )

/** Wait for the title's rows to be up (the valley in; since DEV-557 no press is needed), and read them. */
export const titleRowsUp = async (page: Page, timeout = 60_000): Promise<TitleMenuProbe> => {
  await expect
    .poll(async () => (await titleMenu(page))?.up ?? false, {
      message: 'the title offers its rows once the valley is in',
      timeout,
    })
    .toBe(true)
  return (await titleMenu(page)) as TitleMenuProbe
}

/** Aim the title at row `id` with the arrow keys, reading the aim every step. */
export const aimTitleRow = async (page: Page, id: string): Promise<void> => {
  for (let i = 0; i < 12; i++) {
    const m = (await titleMenu(page)) as TitleMenuProbe
    const want = m.rows.indexOf(id)
    expect(want, `the title offers ${id}: ${JSON.stringify(m.rows)}`).toBeGreaterThanOrEqual(0)
    if (m.selected === want) return
    await hold(page, m.selected < want ? 'ArrowDown' : 'ArrowUp', 300)
  }
  const m = (await titleMenu(page)) as TitleMenuProbe
  expect(m.selected, `the arrow keys reached ${id}`).toBe(m.rows.indexOf(id))
}

/**
 * Press the title's row `id`, NAMED, as a player reaches it: the rows up, the
 * row aimed with the arrow keys, a held Enter. `settle` is how long to wait
 * after the press (a caller measuring what that press starts wants it short).
 * Returns the rows as they stood just before the press.
 */
export const pressTitleRow = async (
  page: Page,
  id: string,
  settle = 600,
): Promise<TitleMenuProbe> => {
  await titleRowsUp(page)
  await aimTitleRow(page, id)
  const before = (await titleMenu(page)) as TitleMenuProbe
  await hold(page, 'Enter', settle)
  return before
}

/**
 * Tap the title's row `id` with a finger, where the plate's own layout puts it
 * on the glass (`rowsAt`). DEV-619: on a phone the rows ARE the buttons (Matt,
 * 2026-10-03: *"mobile users should be able to just tap the panel start, no
 * need for an extra button."*), so this is what a player does. Returns the
 * rows as they stood before the tap.
 */
export const tapTitleRow = async (page: Page, id: string): Promise<TitleMenuProbe> => {
  const m = await titleRowsUp(page)
  const i = m.rows.indexOf(id)
  expect(i, `the title offers ${id}: ${JSON.stringify(m.rows)}`).toBeGreaterThanOrEqual(0)
  const at = m.rowsAt?.[i]
  expect(at, `the title says where ${id} is on the glass`).toBeTruthy()
  if (at) await page.touchscreen.tap(at.x, at.y)
  return m
}

/**
 * From the title to the hangar's FIRST step (DEV-558): START, then wait for
 * the room to be up on its doors.
 */
export const toHangar = async (page: Page): Promise<void> => {
  await pressTitleRow(page, TITLE_ROW.hangar)
  await hangarOn(page, 'doors')
}

/**
 * From the title to door `id` in the hangar, pressed (DEV-558): START, then
 * the first step's table. A door on Multiplayer's step (`room`, `room-code`,
 * `room-join`) goes through MULTIPLAYER first. `settle` is the wait after the
 * LAST press.
 */
export const toHangarDoor = async (page: Page, id: string, settle = 600): Promise<void> => {
  await toHangar(page)
  // DEV-565: QUICK RACE is a first-step table too.
  const first = ['single-player', 'quick-race', 'multiplayer', 'tv']
  if (!first.includes(id)) await throughMultiplayer(page)
  await pressDoor(page, id, settle)
}

/**
 * MULTIPLAYER pressed, and the seat turned back to its resting look before
 * the room choice is aimed (DEV-565).
 *
 * Since DEV-565 MULTIPLAYER stands off the resting pointer (since DEV-578 at
 * +23 degrees, the doors' own step), so the press turns the seat. Left there, the
 * walk to HOST A RACE (under the resting pointer on Multiplayer's step) stops
 * at the edge of its table, a few degrees off rest, and the room's lobby then
 * stands where the head's gaze rests on one of its rows; a still gaze sets
 * the lobby's aim every frame (`boot/app.ts`, the lobby block), so arrow
 * presses were undone. Looking back first leaves the head where it was before
 * DEV-565, as a player looks back to the middle. Before the LAST press on
 * purpose: once JOIN WITH A CODE is open, A and D are letters on its plate.
 */
export const throughMultiplayer = async (page: Page): Promise<void> => {
  const rest = await cameraYaw(page)
  await pressDoor(page, DOOR_MULTIPLAYER)
  await hangarOn(page, 'multiplayer')
  if (rest !== null) await turnSeatTo(page, rest)
}

/**
 * From the title to the aircraft step: START, then SINGLE PLAYER (DEV-558).
 * The walk every spec that used to press the HANGAR row and then looked for an
 * aircraft now takes.
 */
export const toAircraft = async (page: Page): Promise<void> => {
  await toHangar(page)
  await pressDoor(page, DOOR_SINGLE)
  await hangarOn(page, 'vehicles')
}

/**
 * DEV-880: from the title to the PLACE step: the aircraft, its variant where the
 * room asks, then Ring Attack, whose tables are locations (DEV-420). The step the
 * Custom Courses door stands on since it left the aircraft step.
 */
export const toPlaces = async (page: Page): Promise<void> => {
  await toAircraft(page)
  for (const [view, want] of [
    ['vehicles', 'hoverjet'],
    ['variants', 'standard'],
    ['modes', 'ringAttack'],
  ] as const) {
    if (!((await hangarAim(page))?.views ?? []).includes(view)) continue
    expect(await lookUntilAimed(page, want), `found ${want} on the ${view} step`).toBe(true)
    await hold(page, 'Enter')
  }
  await hangarOn(page, 'courses')
}

/**
 * DEV-558: the Custom Courses shelf (DEV-488) from the title: START, SINGLE
 * PLAYER, the aircraft and Ring Attack to the places (DEV-880: it stood on the
 * aircraft step), then the shelf's door, opened. The title's COURSES hub (open
 * a file, make a course) stands on it now.
 */
export const toCustomCourses = async (page: Page): Promise<void> => {
  await toPlaces(page)
  await expect
    .poll(async () => (await shelfProbe(page))?.door.up ?? false, {
      message: 'the Custom Courses door stands on the place step',
    })
    .toBe(true)
  for (const key of ['KeyD', 'KeyA'] as const) {
    for (let i = 0; i < (key === 'KeyA' ? 64 : 32); i++) {
      if ((await shelfProbe(page))?.door.aimed) break
      await page.keyboard.down(key)
      await page.waitForTimeout(80)
      await page.keyboard.up(key)
      await page.waitForTimeout(80)
    }
    if ((await shelfProbe(page))?.door.aimed) break
  }
  expect((await shelfProbe(page))?.door.aimed, 'aimed at the Custom Courses door').toBe(true)
  await hold(page, 'Enter')
  await expect.poll(async () => (await shelfProbe(page))?.open ?? false).toBe(true)
}

/** `__ff2.courseShelf()`, the shelf's probe (DEV-488). */
export interface ShelfProbe {
  door: { up: boolean; bearing: number | null; aimed: boolean }
  open: boolean
  page: number
  pageCount: number
  tables: string[]
  aimed: string | null
  focus: string | null
}

export const shelfProbe = (page: Page): Promise<ShelfProbe | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2?: { courseShelf?: () => ShelfProbe } }
      ).__ff2?.courseShelf?.() ?? null,
  )

/** The Custom Courses shelf's action tables (DEV-558: the title's COURSES hub, moved). */
export const SHELF_ACTION = {
  makeCourse: 'make-course',
  openCourseFile: 'open-course-file',
} as const

/**
 * DEV-558: press the shelf's action table `id` (`make-course`,
 * `open-course-file`), from the title: through to the shelf, then turn the
 * seat until the table is aimed, then a held Enter. `settle` is the wait after
 * that press.
 */
export const pressShelfAction = async (page: Page, id: string, settle = 600): Promise<void> => {
  await toCustomCourses(page)
  let found = false
  for (const key of ['KeyD', 'KeyA'] as const) {
    for (let i = 0; i < (key === 'KeyA' ? 64 : 32); i++) {
      if ((await shelfProbe(page))?.aimed === id) {
        found = true
        break
      }
      await page.keyboard.down(key)
      await page.waitForTimeout(80)
      await page.keyboard.up(key)
      await page.waitForTimeout(80)
    }
    if (found) break
  }
  expect((await shelfProbe(page))?.aimed, `aimed at the shelf's ${id} table`).toBe(id)
  await hold(page, 'Enter', settle)
}

/** The room's door step is up, its tables read (`__ff2.hangarAim().doors`). */
export const hangarDoors = async (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { hangarAim?: () => { doors: { id: string }[] } | null }
        }
      ).__ff2
        ?.hangarAim?.()
        ?.doors.map((d) => d.id) ?? [],
  )

export { hangarAim, lookUntilAimed }
