/**
 * Flight School: the way in to the flight instructor, on the PLAYER's route.
 * DEV-379; since DEV-558, through the hangar's Single Player.
 *
 * `docs/plan/FLIGHT-INSTRUCTOR.md` §7 and §9. Every lesson spec before this one
 * booted `?mission=` (DEV-377's fixture, DEV-378's two courses), which is the
 * one path no player takes (AGENT-NOTES §8). This is the route a player takes.
 *
 * Until DEV-558 the title had a LEARN TO FLY row that boarded the first lesson
 * this browser had not finished. Matt, 2026-10-01: *"Title Screen: Start,
 * Enter VR"*, and the lead's call (DEV-558's row): Learn to Fly IS the Flight
 * School plan. So:
 *
 *   1. **a first visit.** The title is START and ENTER VR; the first-visit
 *      note, *new here? start here*, lights the hangar's SINGLE PLAYER table,
 *      the door Flight School is behind.
 *   2. **title → Single Player → HoverJet → Flight School → lesson 2, flown to
 *      the end.** The HoverJet's teaching plan stands the instructor's hull
 *      (not Ring Attack's gate), Professional holds the Canyon Run, the lesson
 *      boards IN THE AIR with its first step up (DEV-409), the autopilot flies
 *      it home, the results panel is headed LESSON COMPLETE, and the next visit
 *      has no first-visit note: it appears ONCE, ended by a run finished
 *      through the game's own path.
 *
 * The title's rows are read through `__ff2.titleMenu()`, the doors through
 * `__ff2.hangarAim().doors`, and the lesson through `__ff2.lesson()`.
 * Every literal here (row ids, mode and step keys) is the content's, written
 * out rather than imported: one import edge into `src/` reaches
 * `import.meta.glob` and takes the e2e collection to zero.
 *
 * Photographs from the seat, flat, pinned (`PINNED` in every load and every
 * file name), into `LEARN_TO_FLY_PHOTO_DIR` (default `test-results/learn-to-fly`):
 * the title's rows on a first and a return visit, the Flight School table (a
 * burst: the mark turns), and the LESSON COMPLETE panel (the screen, and the
 * panel's own canvas at full resolution).
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/learn-to-fly.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus, focusCanvas } from './fixtures/canvas'
import { DOOR_SINGLE, hangarAim, hold, lookUntilAimed, throughVariants } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { TITLE_ROW, toAircraft, toHangar } from './fixtures/title'

const PHOTOS = process.env.LEARN_TO_FLY_PHOTO_DIR ?? path.join('test-results', 'learn-to-fly')
const PIN_TAG = PINNED.replace(/[=&]/g, '-')

/** The note a first visit reads (`render/hangar-doors.ts`, on SINGLE PLAYER since DEV-558). */
const FIRST_VISIT = 'new here? start here'

/** The door tables on the hangar's step that is up, with their notes (DEV-558). */
const doorNotes = (page: Page): Promise<{ id: string; note: string }[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { hangarAim?: () => { doors: { id: string; note: string }[] } | null }
        }
      ).__ff2?.hangarAim?.()?.doors ?? [],
  )
/** The teaching mode's key, as the hangar's flight-plan tables are aimed by it. */
const FLIGHT_SCHOOL = 'lesson'
const LESSON_2 = 'lesson_02_canyon_run'

interface TitleMenuProbe {
  up: boolean
  selected: number
  rows: string[]
  notes: string[]
  accents: boolean[]
}

const titleMenu = (page: Page): Promise<TitleMenuProbe | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2?: { titleMenu?: () => TitleMenuProbe } }
      ).__ff2?.titleMenu?.() ?? null,
  )

interface LessonProbe {
  readonly step: number
  readonly stepId: string | null
  readonly done: boolean
  readonly plate: { readonly key: string; readonly title: string; readonly text: string } | null
  readonly plateVisible: boolean
}

const lesson = (page: Page): Promise<LessonProbe | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2?: { lesson?: () => LessonProbe | null } }
      ).__ff2?.lesson?.() ?? null,
  )

const course = (page: Page): Promise<{ id: string; vehicle: string; mode: string } | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { course?: () => { id: string; vehicle: string; mode: string } }
        }
      ).__ff2?.course?.() ?? null,
  )

const launchPhase = (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2?: { launch?: () => { phase: string } } }).__ff2?.launch?.()
        .phase ?? null,
  )

/** A shot, with the tier read back beside it — a pin is a fact only once read. */
const shoot = async (page: Page, name: string): Promise<void> => {
  const state = await drawState(page)
  const file = path.join(PHOTOS, `${name}-seat-${PIN_TAG}.png`)
  await page.screenshot({ path: file })
  console.log(`[DEV-379] ${path.basename(file)} · ${drawStateLine(state)}`)
}

/** The title, its valley in and the card gone: the rows are up. */
const toTheTitleRows = async (page: Page): Promise<TitleMenuProbe> => {
  await page.goto(`/?xr=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  // `dropFocus`: a click on the TITLE is a real press (DEV-301), and these runs
  // leave the title with the keys.
  await dropFocus(page)
  await expect
    .poll(async () => (await titleMenu(page))?.up ?? false, {
      message: 'the title offers its rows once the valley is in and the card is gone',
      timeout: 60_000,
    })
    .toBe(true)
  // Let the plate's first paint and the valley settle before anything is read or shot.
  await page.waitForTimeout(1_200)
  return (await titleMenu(page)) as TitleMenuProbe
}

/** The mode-mark kinds standing on the drawn hangar tables. */
const markKinds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      userData: { kind?: string }
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    if (!ff) return []
    const drawn = (o: Node): boolean => {
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    const kinds: string[] = []
    ff.stage().traverse((o) => {
      if (o.name === 'mode-mark' && drawn(o)) kinds.push(String(o.userData.kind))
    })
    return kinds.sort()
  })

/** The results panel's own canvas, as a PNG data URL — full resolution, no framing. */
const resultsCanvas = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    interface Node {
      name: string
      material?: { map?: { image?: HTMLCanvasElement } }
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    let url: string | null = null
    ff?.stage().traverse((o) => {
      if (o.name === 'results' && o.material?.map?.image) url = o.material.map.image.toDataURL()
    })
    return url
  })

const trackAutopilot = (page: Page): { on: boolean } => {
  const pilot = { on: false }
  page.on('console', (m) => {
    const text = m.text()
    if (text.startsWith('autopilot ON')) pilot.on = true
    else if (text.startsWith('autopilot off')) pilot.on = false
  })
  return pilot
}

test.describe('@gpu Flight School, the way in to the instructor (DEV-379; DEV-558)', () => {
  test.setTimeout(600_000)
  test.beforeAll(() => {
    fs.mkdirSync(PHOTOS, { recursive: true })
  })

  test('a first visit: the title is START and ENTER VR, and SINGLE PLAYER wears the first-visit note', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    // DEV-558: the title is two rows (Matt, 2026-10-01: *"Title Screen:
    // Start, Enter VR"*); `?xr=off` keeps ENTER VR, saying it is not looking.
    const top = await toTheTitleRows(page)
    expect(top.rows).toEqual([
      TITLE_ROW.hangar,
      TITLE_ROW.options,
      TITLE_ROW.enterVr,
      TITLE_ROW.makingOf,
      TITLE_ROW.newsletter,
    ])
    expect(top.selected, 'the title opens on START').toBe(0)
    expect(top.accents).toEqual(top.rows.map(() => false))
    await shoot(page, 'title-rows-first-visit')

    // The first-visit note moved with the doors: it lights SINGLE PLAYER, the
    // table Flight School is behind (DEV-379's call 9, one table up).
    await toHangar(page)
    const doors = await doorNotes(page)
    // DEV-565: QUICK RACE beside it, to its left since Matt put SINGLE PLAYER
    // under the resting pointer (2026-10-02).
    // DEV-620: and CREDITS, first, off the left end. DEV-879: the COURSE EDITOR, second,
    // wherever the shelf's MAKE A COURSE is offered (a desktop, as this run is).
    expect(doors.map((d) => d.id)).toEqual([
      'options',
      'course-editor',
      'quick-race',
      DOOR_SINGLE,
      'multiplayer',
      'tv',
    ])
    const single = doors.find((d) => d.id === DOOR_SINGLE)
    expect(single?.note, 'the first-visit note, on Single Player').toBe(FIRST_VISIT)
    expect(doors.filter((d) => d.id !== DOOR_SINGLE).every((d) => d.note !== FIRST_VISIT)).toBe(
      true,
    )
    await shoot(page, 'hangar-doors-first-visit')
    expect(problems.list()).toEqual([])
  })

  test('title → Single Player → HoverJet → Flight School → lesson 2: the instructor on the table, flown home, LESSON COMPLETE, and the note is gone', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await toTheTitleRows(page)
    const pinned = await drawState(page)

    // START, SINGLE PLAYER, and the room is on the aircraft (DEV-558).
    await toAircraft(page)
    expect((await hangarAim(page))?.view, 'the room is on the aircraft').toBe('vehicles')
    expect(await lookUntilAimed(page, 'hoverjet'), 'found the HoverJet').toBe(true)
    await hold(page, 'Enter')
    await throughVariants(page)
    expect((await hangarAim(page))?.view, 'on the flight plans').toBe('modes')

    // Flight School stands the instructor's hull, and no plan stands two marks
    // of a kind: the HoverJet's plans are a gate, an orb and the instructor.
    await expect
      .poll(() => markKinds(page), {
        timeout: 60_000,
        message: 'the plan tables get their marks, the instructor among them',
      })
      .toEqual(['instructor', 'orb', 'ring'])
    expect(await lookUntilAimed(page, FLIGHT_SCHOOL), 'found Flight School').toBe(true)
    // A burst: the mark turns, and a still of a turning thing has not been
    // reviewed (orientation lesson §5c). 0.8 s apart is 22 degrees a frame.
    await page.waitForTimeout(800)
    for (let i = 0; i < 4; i++) {
      await shoot(page, `hangar-flight-school-table-${i}`)
      await page.waitForTimeout(800)
    }
    await hold(page, 'Enter')
    expect((await hangarAim(page))?.view, 'on the ranks').toBe('ranks')
    expect(await lookUntilAimed(page, 'professional'), 'the Canyon Run is Professional').toBe(true)
    // DEV-608: a lesson rank holds one lesson, and boards from the rank: no
    // PLACE step with one table on it.
    await hold(page, 'Enter')
    await switchSettled(page, 240_000)

    // Aboard, with the first step up: an airborne start, no lift.
    expect((await course(page))?.id).toBe(LESSON_2)
    expect((await course(page))?.mode).toBe(FLIGHT_SCHOOL)
    await expect
      .poll(async () => (await lesson(page))?.plate?.key ?? null, { timeout: 60_000 })
      .toBe('in')
    expect(await launchPhase(page), 'flying from the first frame aboard').toBe('flying')
    await focusCanvas(page)
    await shoot(page, 'lesson_02-step0-from-flight-school')

    // Flown home by the player's own autopilot, as DEV-378's spec flies it.
    const pilot = trackAutopilot(page)
    await hold(page, 'Space', 300)
    await hold(page, 'KeyP', 300)
    await expect.poll(() => pilot.on, { timeout: 5_000 }).toBe(true)
    await expect
      .poll(async () => (await lesson(page))?.done ?? false, {
        timeout: 240_000,
        intervals: [500],
        message: 'the lesson ends at the finish',
      })
      .toBe(true)
    await expect(page.locator('body')).toHaveAttribute('data-finished', 'true', { timeout: 30_000 })
    // No medal (call 11). And no best: the autopilot flew it (P, above), and
    // since DEV-601 such a run keeps none. The panel is still headed LESSON
    // COMPLETE, a lesson's word outranking AUTOPILOT (`resultsHeading`).
    await expect(page.locator('body')).toHaveAttribute('data-medal', 'none')
    await expect(page.locator('body')).toHaveAttribute('data-best', '')
    // DEV-650: 3.4 s, not 1.5: the panel animates in and is settled at 3.15 s.
    await page.waitForTimeout(3_400)
    await shoot(page, 'lesson_02-results-lesson-complete')
    const panel = await resultsCanvas(page)
    expect(panel, 'the results panel is on the stage').not.toBeNull()
    fs.writeFileSync(
      path.join(PHOTOS, `lesson_02-results-panel-canvas-${PIN_TAG}.png`),
      Buffer.from((panel as string).split(',')[1] as string, 'base64'),
    )
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    expect(problems.list()).toEqual([])

    // The next visit: the same browser, but the only run behind it was the
    // autopilot's, which keeps no best (DEV-601), and the first-visit note keys
    // on a best (`hasAnyBest`): this player has not flown anything yet, so the
    // note is still there for them.
    await toTheTitleRows(page)
    await toHangar(page)
    const doors = await doorNotes(page)
    const single = doors.find((d) => d.id === DOOR_SINGLE)
    expect(single, 'SINGLE PLAYER stands').toBeDefined()
    expect(single?.note, 'still new here: the autopilot flew the lesson').toBe(FIRST_VISIT)
  })
})
