/**
 * The menus always wear Anniversary; the chosen edition is worn inside a
 * mission only. DEV-451 (and DEV-442, which is where it was found).
 *
 * Matt, 2026-09-27: *"i just played through and the first time i was in, i was
 * stuck on the "classic" mode"*, then *"our menus should only ever be
 * anniversary."* His browser had Classic stored from an earlier A/B. DEV-405
 * put Anniversary on the TITLE and flipped to the chosen edition at the press
 * that left it, so the hangar, its steps and its tables wore Classic, and the
 * only way to change it was a pause plate a mission away.
 *
 * Everything here starts where a player starts, the title, with the edition in
 * STORAGE (seeded before the page loads, as a returning player's browser holds
 * it) rather than `?edition=`, which is a development pin and not the path the
 * report took. It asks the edition the page is WEARING at each screen
 * (`__ff2.edition.current.id`), and when each flip was made (the console's
 * `edition: … (DEV-451)` lines, in order with the level select's own).
 *
 *   1. title, hangar: Anniversary, and the room offers Anniversary's steps;
 *   2. a course: Classic from the black into the loading scene, so the world
 *      is BUILT under the edition it is flown in;
 *   3. EXIT: Anniversary again in the hangar;
 *   4. the same course again is the cheap door (no load) and wears Classic;
 *   5. a flip on the pause plate, EXIT, and the same course: a world built
 *      under Classic is not boarded under Anniversary, so that board LOADS;
 *   6. DEV-452 (D35): the Classic mission is a LOOK over Anniversary's rules
 *      (its five racers on the rookie course since DEV-457, Anniversary's
 *      board), and
 *      2016's rules are `?rules=classic`, which races 2016's two there
 *      (DEV-442).
 *
 * Counts and ids of what the build did: contention-immune, nothing
 * photographed.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/menus-anniversary.spec.ts
 *
 * Tagged `@gpu` with the other specs that fly.
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import {
  aimAtCourse,
  board,
  type Course,
  hangarAim,
  hangarOn,
  hold,
  throughDoors,
} from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const ROOKIE_01: Course = {
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  rank: 'beginner',
  id: 'rookie_01_hoverJet',
}

/** A returning player's browser: the edition they chose last time, in storage. */
const storedEdition = async (page: Page, edition: string): Promise<void> => {
  await page.addInitScript((e: string) => {
    try {
      localStorage.setItem('ff2.comfort.v1', JSON.stringify({ edition: e }))
    } catch {
      // A blocked store is a first visit, and the first assertion says so.
    }
  }, edition)
}

/** The console lines this file reads, in the order the page said them. */
const watchLines = (page: Page): string[] => {
  const lines: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (/^(edition|level select|boarding|exit)/.test(t)) lines.push(t)
  })
  return lines
}

/** The edition the page is wearing now. */
const wearing = async (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.edition.current.id ?? '')

/**
 * DEV-452: the rules the page flies, and the field the world was built with.
 * `data-opponents` is set as the world's opposition loads.
 */
const flying = async (page: Page): Promise<{ rules: string; opponents: string | null }> =>
  page.evaluate(() => ({
    rules: (globalThis as unknown as Ff2GlobalMaybe).__ff2?.edition.rules?.id ?? '',
    opponents: document.body.dataset.opponents ?? null,
  }))

const toTheTitle = async (page: Page, query = ''): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}${query}`)
  await firstPress(page)
  await bootReady(page, 240_000)
  await dropFocus(page)
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.titleMenu?.()?.up ?? false,
        ),
      { message: 'the title offers its rows', timeout: 60_000 },
    )
    .toBe(true)
}

interface Plate {
  readonly open: boolean
  readonly page: string
  readonly rows: readonly string[]
  readonly selected: number
}
const plate = async (page: Page): Promise<Plate> =>
  page.evaluate(() => {
    const p = (globalThis as unknown as Ff2Global).__ff2.pausePlate()
    return { open: p.open, page: p.page, rows: p.rows.map((r) => r.id), selected: p.selected }
  })

/** Pause, pressed as a player presses it (held), until the plate is up. */
const pause = async (page: Page): Promise<void> => {
  await expect
    .poll(
      async () => {
        if (!(await plate(page)).open) await hold(page, 'Backspace', 400)
        return (await plate(page)).open
      },
      { message: 'the pause plate opens', timeout: 30_000 },
    )
    .toBe(true)
}

/** Move the plate's selection to the row named `id`, then press it. */
const pressRow = async (page: Page, id: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        const p = await plate(page)
        const want = p.rows.indexOf(id)
        if (want < 0 || p.selected === want) return p.selected === want
        await hold(page, p.selected < want ? 'ArrowDown' : 'ArrowUp', 250)
        return false
      },
      { message: `the ${id} row is selected`, timeout: 20_000 },
    )
    .toBe(true)
  await hold(page, 'Enter', 500)
}

/** EXIT from the pause plate, back to the room, and the place that holds `id`. */
const exitToCourse = async (page: Page, id: string): Promise<void> => {
  await pause(page)
  await pressRow(page, 'exit')
  // The room as the SCREEN, its fade done: the room stands on its courses
  // step all through the flight, so the view alone is true before the way
  // back has happened. Since DEV-606 the seat rests on the way back in, and a
  // sweep that started before it measured its reach from the cockpit.
  await hangarOn(page, 'courses')
  expect(await aimAtCourse(page, id), `found ${id} on its place`).toBe(true)
}

/**
 * Board what is aimed at, and wait until the pad is the screen: a load clears
 * `data-switching` at the cockpit's black; the cheap door never sets it, and
 * its one fade is over well inside the wait.
 */
const boardAimed = async (page: Page): Promise<void> => {
  await hold(page, 'Enter', 1_000)
  await switchSettled(page, 180_000)
  await page.waitForTimeout(2_000)
}

test.describe('@gpu DEV-451: the menus wear Anniversary, a mission wears the choice', () => {
  test.setTimeout(600_000)

  test('Classic stored: an Anniversary title and room, a Classic mission, and back', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    const lines = watchLines(page)
    await storedEdition(page, 'classic')
    await toTheTitle(page)
    expect(await wearing(page), 'the title').toBe('anniversary')

    // ── the room: Anniversary, and it offers Anniversary's steps ──────────
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
    await expect
      .poll(async () => (await hangarAim(page))?.view ?? null, { timeout: 60_000 })
      .toBe('doors')
    await throughDoors(page) // and SINGLE PLAYER, to the aircraft
    expect(await wearing(page), 'the hangar, with Classic chosen').toBe('anniversary')
    expect((await hangarAim(page))?.views, 'Anniversary’s steps').toContain('variants')

    // ── a course: Classic, put on at the black into the loading scene ─────
    await board(page, ROOKIE_01, 1_000)
    expect(await wearing(page), 'the mission').toBe('classic')
    const flip = lines.findIndex((l) => l.startsWith('edition: classic (a mission'))
    const built = lines.findIndex((l) => l.startsWith('level select: now flying rookie_01'))
    expect(flip, `the flip into the mission, in ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0)
    expect(flip, 'before the world was built, not after').toBeLessThan(built)
    // DEV-452 (D35): a Classic LOOK flies Anniversary's rules, so the green
    // mark races Anniversary's grid: its three slots plus 2016's two starts on
    // a course with no AI pad (DEV-457, Matt: "5 racers on rookie"; DEV-442's
    // "no other racers" was Classic's rules on that course).
    await expect.poll(async () => (await flying(page)).opponents, { timeout: 60_000 }).toBe('5')
    expect((await flying(page)).rules, 'the rules the lap is filed under').toBe('anniversary')

    // ── EXIT: the room wears Anniversary again ─────────────────────────────
    await exitToCourse(page, ROOKIE_01.id)
    expect(await wearing(page), 'the hangar after a Classic mission').toBe('anniversary')

    // ── the same course: the cheap door, no load, and Classic ──────────────
    const before = lines.length
    await boardAimed(page)
    expect(await wearing(page), 'the same course again').toBe('classic')
    expect(
      lines.slice(before).some((l) => l.startsWith('boarding:')),
      `the cheap door, in ${JSON.stringify(lines.slice(before))}`,
    ).toBe(true)
    expect(problems.list(), 'page errors').toEqual([])
  })

  test('a flip on the pause plate: the next board of that course is built under it', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    const lines = watchLines(page)
    await storedEdition(page, 'classic')
    await toTheTitle(page)
    await pressTitleRow(page, TITLE_ROW.hangar)
    await board(page, ROOKIE_01, 1_000)
    expect(await wearing(page)).toBe('classic')

    // LOOK flips it in place, and a mission wears it at once.
    // DEV-859: LOOK (the row id is still 'edition') is a row of the OPTIONS page.
    await pause(page)
    await pressRow(page, 'options')
    expect((await plate(page)).page, 'on the Options page').toBe('options')
    await pressRow(page, 'edition')
    expect((await plate(page)).page, 'still on the Options page').toBe('options')
    await expect.poll(async () => wearing(page), { timeout: 15_000 }).toBe('anniversary')
    // OPTIONS' BACK to the root, where EXIT is.
    await pressRow(page, 'back')
    expect((await plate(page)).page, 'back on the root').toBe('pause')

    // Out, and the SAME course: built under Classic, so it is built again.
    await exitToCourse(page, ROOKIE_01.id)
    const before = lines.length
    await boardAimed(page)
    expect(await wearing(page)).toBe('anniversary')
    expect(
      lines.slice(before).some((l) => l.startsWith('level select: now flying rookie_01')),
      `a load, not the cheap door, in ${JSON.stringify(lines.slice(before))}`,
    ).toBe(true)
    expect(problems.list(), 'page errors').toEqual([])
  })

  test('the 2016 reference, ?rules=classic: the rookie course races 2016’s two (DEV-442)', async ({
    page,
  }) => {
    // Classic's RULES are the development switch's since DEV-452, and they are
    // 2016's: on a course that authored no AI pad, the two ships stand where
    // 2016's recordings began, 17 m off each shoulder. They raced nobody there
    // until DEV-442.
    const problems = watchPageErrors(page)
    await toTheTitle(page, '&edition=classic&rules=classic')
    await pressTitleRow(page, TITLE_ROW.hangar)
    await board(page, ROOKIE_01, 1_000)
    expect((await flying(page)).rules).toBe('classic')
    await expect.poll(async () => (await flying(page)).opponents, { timeout: 60_000 }).toBe('2')
    expect(problems.list(), 'page errors').toEqual([])
  })
})
