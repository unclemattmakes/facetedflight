/**
 * A player course by LINK and by FILE, on the routes a player takes. DEV-467.
 *
 * `docs/plan/EDITOR-DISPATCH.md`, DEV-467's gates:
 *
 *   1. **Link.** A course built in code, its `#c=` link opened: the title
 *      opens aimed at its row (DEV-558: on the title itself, above START),
 *      one press flies it (the
 *      fragment gone from the bar), the autopilot finishes it, and a LOCAL
 *      best is kept under the course's id — the lap server is never asked
 *      (Share is not offered: `__ff2.share()`). Then the results panel's own
 *      two buttons: G asks, G copies the LINK (the clipboard holds it, and it
 *      decodes to the same id), and G then R saves the FILE (a real download,
 *      which reads back to the same id).
 *   2. **File.** That saved file, loaded through OPEN A COURSE FILE (the
 *      Custom Courses shelf's table since DEV-558: the picker the press opens,
 *      answered with Playwright's `filechooser`), flies the same id; and after
 *      a reload the shelf still stands it (IndexedDB).
 *   3. **Refusal.** A garbage fragment is a refusal said in the link's row on
 *      the title, START aimed, the title up and working, no page error.
 *
 * Built through `src/content/player-course.ts` and `player-course-wire.ts`
 * ONLY. Never `load-player-course.ts`: it reaches `load-level.ts`'s Vite-only
 * glob, and one such edge takes the whole Playwright collection to zero
 * (`tests/unit/e2e-import-graph.test.ts`).
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/player-course-share.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type PlayerCourse, playerCourseId } from '../../src/content/player-course'
import {
  courseFile,
  courseFragment,
  courseTokenIn,
  readCourseFile,
  readCourseToken,
} from '../../src/content/player-course-wire'
import { bootReady, missionReady, switchSettled } from './fixtures/boot'
import { dropFocus, focusCanvas } from './fixtures/canvas'
import { expectCourseFlyable } from './fixtures/editor-course'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { hold } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import {
  aimTitleRow,
  pressShelfAction,
  pressTitleRow,
  SHELF_ACTION,
  shelfProbe,
  TITLE_ROW,
  titleMenu,
  titleRowsUp,
  toCustomCourses,
} from './fixtures/title'

const OUT = path.join('test-results', 'player-course-share')
/** The file test 1 saves and test 2 loads (test 2 builds its own when run alone). */
const SAVED = path.join(OUT, 'saved.ffcourse')

type V = [number, number, number]
const INT01 = JSON.parse(
  fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
) as { route: V[]; environment: string; id: string }

/**
 * A STRAIGHT course, flown by the player's own keys (DEV-601). Since DEV-601 a
 * lap the autopilot flew earns no medal and keeps no best, so this is the one
 * spec where a run the PLAYER flew is followed to a medal and a stored best,
 * end to end. Straight so that holding the throttle is the whole of the flying:
 * three points, 300 m apart, along the heading int_01's own line leaves its
 * first point on, at that point's height, and the pad aimed down it. Rings
 * every 300 m. (Five points ran 1.2 km and the third ring, at 900 m, met the
 * ground; the first 600 m is clear.)
 */
const P0 = INT01.route[0] as V
const P1 = INT01.route[12] as V
const RUN = Math.hypot(P1[0] - P0[0], P1[2] - P0[2])
const UX = (P1[0] - P0[0]) / RUN
const UZ = (P1[2] - P0[2]) / RUN
/** `yawForward`'s inverse: the nose is (-sin yaw, 0, -cos yaw). Degrees, to a tenth. */
const YAW = Math.round(((Math.atan2(-UX, -UZ) * 180) / Math.PI) * 10) / 10
const COURSE: PlayerCourse = {
  v: 2,
  island: INT01.environment,
  sky: INT01.id,
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  path: {
    points: [0, 300, 600].map((d) => [P0[0] + UX * d, P0[1], P0[2] + UZ * d] as V),
    gap: 300,
  },
  rings: [],
  // DEV-475: the pad at the line's first point, aimed down the line.
  start: { pos: P0, yaw: YAW },
  finish: { t: 1 },
  timeLimit: 180,
  name: ['Amber', 'Heron'],
}
const ID = playerCourseId(COURSE)
/** The rows' ids (`render/title-menu.ts`), written out. */
const ROW = {
  refused: 'course-refused',
  course: (id: string) => `course:${id}`,
} as const
/** `ghostKey` for this course's lap, standard jet, Anniversary (`game/ghost-store.ts`). */
const LAP_KEY = `ff2.ghost.${ID}.ringAttack.anniversary.v1`

const body = (page: Page) => page.locator('body')

const aboard = (page: Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.course?.().id ?? null)

const shareProbe = (page: Page): Promise<{ offered: boolean; posts: number } | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.share?.() ?? null)

/** The title with its card gone, the rows up. */
const toTheTitle = async (page: Page, url: string): Promise<void> => {
  await page.goto(url)
  await bootReady(page, 240_000)
  await firstPress(page)
  await dropFocus(page)
  await titleRowsUp(page)
}

/** Aboard the course, the world built and the fade done. */
const boarded = async (page: Page): Promise<void> => {
  await expect(body(page)).toHaveAttribute('data-player-course', ID, { timeout: 30_000 })
  await switchSettled(page, 240_000)
  await missionReady(page)
  expect(await aboard(page)).toBe(ID)
}

test.describe('DEV-467 — player courses by link and by file @gpu', () => {
  test.setTimeout(600_000)

  test('link: open it, fly it, keep a local best; COPY LINK and SAVE FILE on the panel', async ({
    page,
    context,
  }) => {
    fs.mkdirSync(OUT, { recursive: true })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const problems = watchPageErrors(page)
    const fragment = await courseFragment(COURSE)
    console.log(`[DEV-467] the link's fragment is ${fragment.length} characters`)

    await toTheTitle(page, `/?xr=off&${PINNED}${fragment}`)
    await expect(body(page)).toHaveAttribute('data-course-link', ID, { timeout: 60_000 })
    // The title opens aimed at the course the link sent: its own row, first
    // (DEV-558; YOUR COURSES' list until then).
    await expect
      .poll(async () => {
        const m = await titleMenu(page)
        return m ? `${m.page} ${m.rows[m.selected]}` : null
      })
      .toBe(`top ${ROW.course(ID)}`)

    await pressTitleRow(page, ROW.course(ID), 0)
    await boarded(page)
    // The fragment is cleared at the press: a reload does not fly it again.
    expect(await page.evaluate(() => location.hash)).toBe('')
    // DEV-478: judged as the editor judges it, over the ground this world
    // built: nothing of it in the hill the racers would fly into.
    await expectCourseFlyable(page, COURSE, INT01.id, 'a straight line off int_01’s start')

    // Flown home by the player's KEYS: Enter to lift off the pad (the launch is
    // its own press; Space is the throttle), then the throttle held, nothing
    // else. No autopilot (DEV-601: it would earn no medal and keep no best).
    await focusCanvas(page)
    await hold(page, 'Enter', 300)
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.launch().phase ?? null,
          ),
        { message: 'Enter lifted off the pad', timeout: 15_000 },
      )
      .not.toBe('waiting')
    await page.keyboard.down('Space')
    await expect(body(page)).toHaveAttribute('data-finished', 'true', { timeout: 300_000 })
    await page.keyboard.up('Space')
    // A real medal and a stored best, from a run the player flew: the write
    // path every autopilot spec stopped exercising when DEV-601 landed.
    await expect(body(page)).not.toHaveAttribute('data-medal', 'none')
    await expect(body(page)).toHaveAttribute('data-best', /\d+/)
    const scored = await body(page).getAttribute('data-final-score')
    expect(await body(page).getAttribute('data-best'), 'the best is this run').toBe(scored)
    // The lap is kept on this device, under the course's own id.
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k) !== null, LAP_KEY), {
        message: `a local lap under ${LAP_KEY}`,
      })
      .toBe(true)
    // …and never offered to the lap server.
    await page.waitForTimeout(1_000)
    expect(await shareProbe(page)).toMatchObject({ offered: false, posts: 0 })

    // COPY LINK: G asks, G copies.
    await hold(page, 'KeyG', 400)
    await expect(body(page)).toHaveAttribute('data-course-share', 'picking')
    await hold(page, 'KeyG', 400)
    await expect(body(page)).toHaveAttribute('data-course-share', 'copied', { timeout: 10_000 })
    const link = (await body(page).getAttribute('data-course-share-link')) as string
    console.log(`[DEV-467] the copied link is ${link.length} characters`)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)
    const back = await readCourseToken(courseTokenIn(new URL(link).hash) as string)
    expect(back.ok && playerCourseId(back.course)).toBe(ID)
    expect(new URL(link).search, 'a shared link carries no switches').toBe('')

    // SAVE FILE: G asks, R saves.
    await hold(page, 'KeyG', 400)
    await expect(body(page)).toHaveAttribute('data-course-share', 'picking')
    const download = page.waitForEvent('download')
    await hold(page, 'KeyR', 400)
    const saved = await download
    expect(saved.suggestedFilename()).toBe('amber-heron.ffcourse')
    await saved.saveAs(SAVED)
    await expect(body(page)).toHaveAttribute('data-course-share', 'saved')
    const read = await readCourseFile(new Uint8Array(fs.readFileSync(SAVED)))
    expect(read.ok && playerCourseId(read.course)).toBe(ID)
    // R was the save, not "race this lap": still on the panel.
    await expect(body(page)).toHaveAttribute('data-finished', 'true')

    expect(problems.list()).toEqual([])
  })

  test('file: OPEN A COURSE FILE flies the same id, and the Custom Courses shelf keeps it across a reload', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    const bytes = fs.existsSync(SAVED)
      ? fs.readFileSync(SAVED)
      : Buffer.from(await courseFile(COURSE))
    await toTheTitle(page, `/?xr=off&${PINNED}`)
    const chooser = page.waitForEvent('filechooser')
    await pressShelfAction(page, SHELF_ACTION.openCourseFile, 0)
    await (await chooser).setFiles({
      name: 'amber-heron.ffcourse',
      mimeType: 'application/octet-stream',
      buffer: bytes,
    })
    await expect(body(page)).toHaveAttribute('data-course-file', 'read', { timeout: 10_000 })
    await boarded(page)

    // A new page: the course is on the list, from IndexedDB.
    await toTheTitle(page, `/?xr=off&${PINNED}`)
    await expect(body(page)).toHaveAttribute('data-course-library', /^[1-9]/, { timeout: 30_000 })
    await toCustomCourses(page)
    expect((await shelfProbe(page))?.tables, 'the Custom Courses shelf stands it').toContain(ID)
    expect(problems.list()).toEqual([])
  })

  test('refusal: a garbage fragment is said in its row on the title, and the title still works', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await toTheTitle(page, `/?xr=off&${PINNED}#c=ffc1.not-a-course!!`)
    await expect(body(page)).toHaveAttribute('data-course-link', 'refused', { timeout: 30_000 })
    await expect
      .poll(async () => {
        const m = await titleMenu(page)
        return m ? `${m.page} ${m.rows[m.selected]}` : null
      })
      .toBe(`top ${TITLE_ROW.hangar}`)
    const m = await titleMenu(page)
    expect(m?.rows[0], 'the refusal stands where the link’s row would').toBe(ROW.refused)
    expect(m?.notes[0]).toMatch(/damaged|not a course/)
    // Pressing the refusal does nothing; the title is still up and answering.
    await aimTitleRow(page, ROW.refused)
    await hold(page, 'Enter', 600)
    expect((await titleMenu(page))?.up).toBe(true)
    // And START still goes to the hangar.
    await pressTitleRow(page, TITLE_ROW.hangar, 300)
    await expect.poll(async () => (await titleMenu(page))?.up).toBe(false)
    expect(problems.list()).toEqual([])
  })
})
