/**
 * tests/e2e/your-courses.spec.ts: CUSTOM COURSES (YOUR COURSES until DEV-558) on a
 * holotable. DEV-488.
 *
 * The route a player takes, with the pointer and a held Enter as a player
 * presses:
 *
 *   1. A course KEPT through the shelf's file route (DEV-558: the title's
 *      COURSES hub came onto the shelf; its OPEN A COURSE FILE table), which
 *      flies it at once, in the room.
 *   2. A new page: the title, then START and SINGLE PLAYER. On the place
 *      step (DEV-880: it was the aircraft step) the door stands (CUSTOM COURSES, the course's island on it). The head turns until
 *      the door is under the pointer, and Enter opens the shelf: the room's
 *      own tables put by, the course's table in their place.
 *   3. The head finds the course's table BY ITS ID. The race button, pressed
 *      four times there, moves its ghost line between your best and none and
 *      sends NOTHING: no request to the lap server's board, and no request
 *      carrying the course's id (DEV-488 follow-up; /privacy). Enter boards it. The
 *      world is not built (a new page), so this is a load, and it is waited
 *      out IN THE ROOM (DEV-465): `__ff2.loading()` names the room, the
 *      loading scene's dome never comes up, and the one table drawn is the
 *      course's. Then aboard: the course's id, and flyable (DEV-478).
 *   4. Back to the room: the shelf is still up, whole.
 *
 * Photographs, pinned (`adaptive=0&quality=high` is in every URL and every
 * file name): the aircraft step with the door at rest and aimed, the shelf,
 * the room mid-load, and the course's table close.
 *
 *   E2E_PORT=<yours> YOUR_COURSES_DIR=<dir> YOUR_COURSES_LABEL=<label> \
 *     pnpm exec playwright test tests/e2e/your-courses.spec.ts --workers 1
 *
 * `FF2_CHANNEL=release` on the dev server shows a release build's aircraft
 * step (two aircraft, the door at -45); the default is preview's (three, the
 * glider among them, the door at +45).
 *
 * Built through `src/content/player-course.ts` and `player-course-wire.ts`
 * ONLY, as `player-course-share.spec.ts` is: the loader reaches a Vite-only
 * glob (`tests/unit/e2e-import-graph.test.ts`).
 *
 * `@gpu`: a real world and a headed browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type PlayerCourse, playerCourseId } from '../../src/content/player-course'
import { courseFile } from '../../src/content/player-course-wire'
import { bootReady, missionReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { expectCourseFlyable } from './fixtures/editor-course'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { hangarAim, hold, lookUntilAimed, throughDoors } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import {
  pressShelfAction,
  pressTitleRow,
  SHELF_ACTION,
  TITLE_ROW,
  titleRowsUp,
} from './fixtures/title'

const OUT = process.env.YOUR_COURSES_DIR ?? 'perf-out/dev-488'
const LABEL = process.env.YOUR_COURSES_LABEL ?? 'run'

type V = [number, number, number]
const INT01 = JSON.parse(
  fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
) as { route: V[]; environment: string; id: string }

/** `player-course-share.spec.ts`'s course: ten points on 2016's own int_01 line. */
const COURSE: PlayerCourse = {
  v: 2,
  island: INT01.environment,
  sky: INT01.id,
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  path: { points: Array.from({ length: 10 }, (_, i) => INT01.route[i * 12] as V), gap: 400 },
  rings: [],
  start: { pos: INT01.route[0] as V, yaw: 0 },
  finish: { t: 1 },
  timeLimit: 180,
  name: ['Amber', 'Heron'],
}
const ID = playerCourseId(COURSE)

/** The shelf's names (`render/course-shelf.ts`, `SHELF_NAMES`), written out. */
const NAMES = {
  door: 'your-courses-door',
  shelf: 'your-courses-shelf',
  header: 'your-courses-header',
  back: 'your-courses-back',
} as const

const body = (page: Page) => page.locator('body')

interface RoomState {
  readonly stage: string
  readonly room: boolean
  readonly door: boolean
  readonly doorAimed: boolean
  readonly doorIsland: boolean
  readonly shelf: boolean
  /** The course each drawn holotable stands for, the room's and the shelf's. */
  readonly tables: string[]
  /** The room's own step header, and the shelf's. */
  readonly roomHeader: boolean
  readonly shelfHeader: boolean
  readonly back: boolean
  readonly dome: boolean
  readonly plate: boolean
  readonly fade: string | null
  readonly probe: { place: string | null; target: string | null; focus: string | null } | null
}

/** Read the room off the scene, as `hangar-load.spec.ts` reads it. */
const roomState = (page: Page): Promise<RoomState> =>
  page.evaluate((names) => {
    type Obj = {
      name: string
      visible: boolean
      parent: Obj | null
      userData: Record<string, unknown>
      getObjectByName: (n: string) => Obj | undefined
      traverse: (f: (o: Obj) => void) => void
    }
    const w = globalThis as unknown as Ff2GlobalMaybe
    const drawn = (o: Obj | undefined): boolean => {
      for (let n: Obj | null | undefined = o; n; n = n.parent) if (!n.visible) return false
      return o !== undefined
    }
    const stage = w.__ff2?.stage()
    const room = stage?.name === 'menu' ? stage.getObjectByName('hangar') : undefined
    const tables: string[] = []
    room?.traverse((o) => {
      if (o.name === 'hangar-holotable' && drawn(o))
        tables.push(String(o.userData.missionId ?? o.userData.action))
    })
    const door = room?.getObjectByName(names.door)
    const scene = stage?.getObjectByName('loading-scene')
    return {
      stage: stage?.name ?? '',
      room: drawn(room),
      door: drawn(door),
      doorAimed: door?.userData.aimed === true,
      doorIsland: drawn(door?.getObjectByName('diorama')),
      shelf: drawn(room?.getObjectByName(names.shelf)),
      tables,
      roomHeader: drawn(room?.getObjectByName('hangar-header')),
      shelfHeader: drawn(room?.getObjectByName(names.header)),
      back: drawn(room?.getObjectByName(names.back)),
      dome: drawn(scene?.getObjectByName('loading-dome')),
      plate: drawn(scene?.getObjectByName('loading-plate')),
      fade: document.body.dataset.fade ?? null,
      probe: w.__ff2?.loading?.() ?? null,
    }
  }, NAMES)

/** Turn the seat until the door is under the pointer — right, then twice as far left. */
const lookUntilDoor = async (page: Page, steps = 32): Promise<boolean> => {
  for (const key of ['KeyD', 'KeyA'] as const) {
    for (let i = 0; i < (key === 'KeyA' ? steps * 2 : steps); i++) {
      if ((await roomState(page)).doorAimed) return true
      await page.keyboard.down(key)
      await page.waitForTimeout(80)
      await page.keyboard.up(key)
      await page.waitForTimeout(80)
    }
  }
  return (await roomState(page)).doorAimed
}

const shoot = async (page: Page, name: string, shots: string[]): Promise<void> => {
  const file = path.join(OUT, `your-courses-${PINNED.replace(/[=&]/g, '-')}-${LABEL}-${name}.png`)
  await page.locator('#viewport').screenshot({ path: file })
  shots.push(path.resolve(file))
}

/** The title with its card gone, the rows up. */
const toTheTitle = async (page: Page, url: string): Promise<void> => {
  await page.goto(url)
  await bootReady(page, 240_000)
  await firstPress(page)
  await dropFocus(page)
  await titleRowsUp(page)
}

test.describe('@gpu DEV-488: CUSTOM COURSES on a holotable', () => {
  test.setTimeout(600_000)

  test('a course kept through the shelf’s file route stands on the shelf, and boards in the room', async ({
    page,
  }) => {
    fs.mkdirSync(OUT, { recursive: true })
    const problems = watchPageErrors(page)
    const logs: string[] = []
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
    // Every request the page makes, and those to the lap server's board.
    const requests: string[] = []
    const boardRequests: string[] = []
    page.on('request', (r) => {
      requests.push(r.url())
      if (r.url().includes('/api/board/')) boardRequests.push(r.url())
    })
    const shots: string[] = []

    // ── 1. keep it: OPEN A COURSE FILE, which flies it (DEV-467; DEV-558) ─
    await toTheTitle(page, `/?xr=off&${PINNED}`)
    const chooser = page.waitForEvent('filechooser')
    await pressShelfAction(page, SHELF_ACTION.openCourseFile, 0)
    await (await chooser).setFiles({
      name: 'amber-heron.ffcourse',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(await courseFile(COURSE)),
    })
    await expect(body(page)).toHaveAttribute('data-player-course', ID, { timeout: 60_000 })
    await switchSettled(page, 240_000)

    // ── 2. a new page: the title, then the hangar ────────────────────────
    await toTheTitle(page, `/?xr=off&${PINNED}`)
    await expect(body(page)).toHaveAttribute('data-course-library', /^[1-9]/, { timeout: 30_000 })
    await pressTitleRow(page, TITLE_ROW.hangar)
    await expect(body(page)).toHaveAttribute('data-fade', 'idle', { timeout: 60_000 })
    await throughDoors(page) // DEV-558: SINGLE PLAYER, to the aircraft
    // DEV-880: the door stands on the PLACE step: the aircraft, then Ring Attack.
    for (const [view, want] of [
      ['vehicles', 'hoverjet'],
      ['variants', 'standard'],
      ['modes', 'ringAttack'],
    ] as const) {
      if (!((await hangarAim(page))?.views ?? []).includes(view)) continue
      expect(await lookUntilAimed(page, want), `found ${want} on the ${view} step`).toBe(true)
      await hold(page, 'Enter')
    }
    await expect
      .poll(async () => (await roomState(page)).door, {
        message: 'the door stands',
        timeout: 30_000,
      })
      .toBe(true)
    expect((await hangarAim(page))?.view, 'on the place step').toBe('courses')
    // Its island, once the height map lands.
    await expect
      .poll(async () => (await roomState(page)).doorIsland, { timeout: 30_000 })
      .toBe(true)
    await page.waitForTimeout(800)
    await shoot(page, '1-place-step-at-rest', shots)

    expect(await lookUntilDoor(page), 'the head finds the door').toBe(true)
    await page.waitForTimeout(500)
    await shoot(page, '2-door-aimed', shots)
    await hold(page, 'Enter', 800)
    const open = await roomState(page)
    expect(open.shelf, 'the press opened the shelf').toBe(true)
    // DEV-558: the COURSES hub's two actions first, then the course.
    expect(open.tables, 'the room’s tables are put by, the shelf stands').toEqual([
      SHELF_ACTION.makeCourse,
      SHELF_ACTION.openCourseFile,
      ID,
    ])
    expect(open.roomHeader, 'the room’s header is down').toBe(false)
    expect(open.shelfHeader, 'the shelf’s is up').toBe(true)
    expect(open.back, 'and its way back').toBe(true)
    expect(open.probe?.focus ?? null, 'the app sees no load').toBeNull()
    await page.waitForTimeout(1_500)
    await shoot(page, '3-shelf', shots)

    // ── 3. find it BY ITS ID, and board it: the room route (DEV-465) ─────
    expect(await lookUntilAimed(page, ID), 'the head finds the course’s table').toBe(true)
    await page.waitForTimeout(500)
    await shoot(page, '4-course-table-aimed', shots)

    // ── DEV-488 follow-up: the race button on a shelf course asks nothing ─
    //
    // On a course card the race button moves the ghost line (DEV-373), and a
    // board pick used to fetch `/api/board/<id>/…`. A player course's id is a
    // hash of the course, and /privacy promises nothing about a player course
    // leaves the device. So: four presses on the aimed course, and not one
    // request to the board, nor any request that carries the course's id.
    const pressLines = (): string[] => logs.filter((l) => l.includes(`ghost line: ${ID} in the`))
    const beforePresses = pressLines().length
    for (let i = 0; i < 4; i++) {
      expect((await hangarAim(page))?.aimName, 'still aimed at the course').toBe(ID)
      await hold(page, 'KeyR', 400)
    }
    const picks = pressLines()
      .slice(beforePresses)
      .map((l) => l.split(': ').at(-1))
    expect(picks.length, 'the premise: each press moved the course’s ghost line').toBe(4)
    expect(picks, 'no pick names the board').toEqual(['none', 'best', 'none', 'best'])
    await page.waitForTimeout(1_000)
    expect(boardRequests, 'no request to the lap server’s board').toEqual([])
    expect(
      requests.filter((u) => u.includes(ID)),
      'no request carries the course’s id',
    ).toEqual([])

    let domeSeen = false
    let seenInRoom: RoomState | null = null
    await hold(page, 'Enter', 0)
    await expect
      .poll(
        async () => {
          const s = await roomState(page)
          domeSeen ||= s.dome
          if (s.plate && s.fade === 'idle' && seenInRoom === null) seenInRoom = s
          return seenInRoom !== null
        },
        { timeout: 120_000, intervals: [50], message: 'the plate stood' },
      )
      .toBe(true)
    await shoot(page, '5-mid-load-in-the-room', shots)
    const mid = seenInRoom as unknown as RoomState
    await switchSettled(page, 240_000)
    await missionReady(page)
    await expect(body(page)).toHaveAttribute('data-player-course', ID)
    const aboard = await page.evaluate(
      () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.course?.().id ?? null,
    )
    await expectCourseFlyable(page, COURSE, INT01.id, 'ten points on 2016’s int_01 line')

    // ── 4. back to the room: the shelf, whole ────────────────────────────
    await hold(page, 'Backspace')
    for (let i = 0; i < 8; i++) await hold(page, 'ArrowDown', 150)
    await hold(page, 'Enter', 2_500)
    await expect(body(page)).toHaveAttribute('data-fade', 'idle', { timeout: 60_000 })
    const back = await roomState(page)

    const report = {
      label: LABEL,
      id: ID,
      open,
      mid,
      domeSeenWhileLoading: domeSeen,
      aboard,
      back: { stage: back.stage, tables: back.tables, shelf: back.shelf, probe: back.probe },
      shots,
    }
    fs.writeFileSync(
      path.join(OUT, `your-courses-${PINNED.replace(/[=&]/g, '-')}-${LABEL}.json`),
      JSON.stringify(report, null, 1),
    )
    console.info(
      [
        `\nDEV-488: CUSTOM COURSES, ${PINNED}, ${LABEL}`,
        `  shelf open: tables [${open.tables.join(', ')}]; room header ${open.roomHeader}; shelf header ${open.shelfHeader}`,
        `  mid-load: stage ${mid.stage}, room ${mid.room}, dome ${mid.dome}, tables [${mid.tables.join(', ')}], ` +
          `shelf header ${mid.shelfHeader}, back ${mid.back}`,
        `  __ff2.loading(): ${JSON.stringify(mid.probe)}; dome ever up: ${domeSeen}`,
        `  aboard ${aboard}; back in the room: ${back.stage}, tables [${back.tables.join(', ')}], shelf ${back.shelf}`,
        ...shots.map((s) => `  ${s}`),
        '',
      ].join('\n'),
    )

    // ── the claims: the ROOM route, not the loading scene ────────────────
    expect(mid.probe, '__ff2.loading() names the room, and the course').toEqual({
      place: 'room',
      target: ID,
      focus: ID,
    })
    expect(mid.room, 'the room stayed up').toBe(true)
    expect(domeSeen, 'the loading scene never came up').toBe(false)
    expect(mid.tables, 'every table but the pressed course’s is put by').toEqual([ID])
    expect(mid.shelfHeader, 'the shelf’s header is down').toBe(false)
    expect(mid.back, 'and its plate').toBe(false)
    expect(aboard, 'aboard the course the table stood for').toBe(ID)
    expect(back.stage, 'back in the room').toBe('menu')
    expect(back.shelf, 'the shelf still up').toBe(true)
    expect(back.tables, 'and whole').toEqual([
      SHELF_ACTION.makeCourse,
      SHELF_ACTION.openCourseFile,
      ID,
    ])
    expect(back.probe?.focus ?? null, 'nothing focused').toBeNull()
    expect(
      logs.filter((l) => /^error: .*(shader|program|WebGL)/i.test(l)),
      'no shader errors',
    ).toEqual([])
    expect(problems.list()).toEqual([])
  })
})
