/**
 * What the room stands on its tables, step by step, flown (DEV-142, DEV-354).
 *
 * Matt, in a headset, first playthrough: *"menu ui showing ship selection
 * should show the ships, not terrain, on the holo table."* And on 2026-09-24:
 * *"mode select - this should be a single rotating ring/gate for ring attack, a
 * single jump pad for target practice. a single orb for free flight"* and
 * *"level select - show terrain diorama, no gates."*
 *
 * The unit suite owns each picture — `holo-ship.test.ts` the aircraft,
 * `mode-mark.test.ts` the mark, `diorama-look.test.ts` the land — and
 * `level-steps.test.ts` holds `tablePicture`, the room's one branch, without a
 * room. What a unit test cannot say is what the ROOM actually puts on a table,
 * because that answer runs through `loadMissionIndex`, thirteen level JSONs,
 * unawaited GLB loads and `applyPage`. So this is the part that has to be flown.
 *
 * The claims are COUNTS and NAMES off `__ff2.stage()`, never a pixel:
 *
 *   aircraft  three ships on Anniversary (the glider, DEV-399), no island, no mark.
 *   plans     one `mode-mark` on every live table, three different kinds across
 *             the two aircraft, and NO diorama at all — the guard that goes red
 *             if a plan table grows a course again.
 *   level     the course's island and its craft, and nothing marked on it.
 *
 * Photographs go to a scratch folder for a human (`SHIP_SELECT_SHOT_DIR`), from
 * the seat, flat, pinned — the pin in every load and in every file name — and
 * the tier read back beside each one (`drawState`). Nothing here reads them.
 * The marks TURN, so their step is shot as a burst: *a thing that moves has not
 * been reviewed from one still* (orientation lesson §5c).
 */

import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import {
  aimAtCourse,
  aimAtMark,
  type Course,
  hangarAim,
  lookUntilAimed,
  throughDoors,
  throughVariants,
} from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 300_000 })

/** The pin as it goes in a file name. */
const PIN_TAG = PINNED.replace(/[=&]/g, '-')

/** Held, not tapped. Every confirm in this game is a LEVEL read once a frame. */
const hold = (page: Page, key: string, settle = 600) => keysHold(page, key, { down: 200, settle })

const view = async (page: Page) => (await hangarAim(page))?.view ?? null

/** One drawn table's census, by what it stands for. */
interface TableCensus {
  /** `userData.missionId` on a course table, else null. */
  readonly missionId: string | null
  /** Whether the pointer can take it — false on a dead plate. */
  readonly aimable: boolean
  /** `mode-mark` objects on it, by the scorer's kind. */
  readonly marks: readonly string[]
  /** Dioramas on it, island or not. */
  readonly dioramas: number
  readonly islands: number
  /** The tiny jets: cones under a diorama. */
  readonly craft: number
  /**
   * DEV-420: drawn routes under a diorama (`diorama-route`), and the colour of
   * the one drawn. Only a place carrying its difficulty draws one.
   */
  readonly routes: number
  readonly routeColour: number | null
  /** DEV-420: the table's difficulty marks, top first — shape, the course it picks, whether it is the pick. */
  readonly skiMarks: readonly { shape: string; missionId: string; picked: boolean; y: number }[]
  /** Every OTHER mesh under a diorama — a gate, a target, an orb. Must be empty. */
  readonly strays: readonly string[]
}

/** What is standing on the tables right now, drawn only. */
const onTables = async (page: Page) =>
  page.evaluate(() => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      userData: {
        missionId?: string | null
        aimable?: boolean
        kind?: string
        shape?: string
        picked?: boolean
      }
      isMesh?: boolean
      geometry?: { type: string }
      material?: { color?: { getHex: () => number } }
      position?: { y: number }
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    if (!ff) return null
    // An object under a hidden table is still in the graph. The room hides
    // spare tables rather than removing them, so "is it drawn" means walking up.
    const drawn = (o: Node): boolean => {
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    const ships: string[] = []
    const tables: {
      missionId: string | null
      aimable: boolean
      marks: string[]
      dioramas: number
      islands: number
      craft: number
      routes: number
      routeColour: number | null
      skiMarks: { shape: string; missionId: string; picked: boolean; y: number }[]
      strays: string[]
    }[] = []
    ff.stage().traverse((o) => {
      if (!drawn(o)) return
      // The OUTER group only: `holo-ship-spinner-<id>` shares the prefix.
      const ship = /^holo-ship-(?!spinner-)(.+)$/.exec(o.name)
      if (ship?.[1]) ships.push(ship[1])
      if (o.name !== 'hangar-holotable') return
      const t = {
        missionId: o.userData.missionId ?? null,
        aimable: o.userData.aimable === true,
        marks: [] as string[],
        dioramas: 0,
        islands: 0,
        craft: 0,
        routes: 0,
        routeColour: null as number | null,
        skiMarks: [] as { shape: string; missionId: string; picked: boolean; y: number }[],
        strays: [] as string[],
      }
      o.traverse((c) => {
        if (c.name === 'mode-mark') t.marks.push(String(c.userData.kind))
        if (c.name === 'difficulty-mark' && drawn(c))
          t.skiMarks.push({
            shape: String(c.userData.shape),
            missionId: String(c.userData.missionId),
            picked: c.userData.picked === true,
            y: c.position?.y ?? 0,
          })
        if (c.name === 'diorama') {
          t.dioramas++
          c.traverse((m) => {
            // DEV-420: the drawn route is a named group, counted as itself.
            if (m.name === 'diorama-route') t.routes++
            if (m.name === 'diorama-route-core') t.routeColour = m.material?.color?.getHex() ?? null
            if (!m.isMesh) return
            if (m.name.startsWith('diorama-route')) return
            if (m.name === 'diorama-island') t.islands++
            else if (m.geometry?.type === 'ConeGeometry') t.craft++
            else t.strays.push(m.name || m.geometry?.type || '?')
          })
        }
      })
      // Top of the column first, which is the order Matt named them in.
      t.skiMarks.sort((a, b) => b.y - a.y)
      tables.push(t)
    })
    return { ships: ships.sort(), tables: tables as TableCensus[] }
  })

/** The screen box around a table's model — its mark, or its diorama — for a crop. */
const modelRect = async (page: Page, missionId: string | null, markKind: string | null) =>
  page.evaluate(
    ({ missionId, markKind }) => {
      interface Vec3 {
        x: number
        y: number
        z: number
        set: (x: number, y: number, z: number) => Vec3
        project: (camera: unknown) => Vec3
      }
      interface Node {
        name: string
        visible: boolean
        parent: Node | null
        userData: { missionId?: string | null; kind?: string }
        getWorldPosition: (v: Vec3) => Vec3
        traverse: (fn: (o: Node) => void) => void
        updateWorldMatrix: (a: boolean, b: boolean) => void
      }
      const ff = (
        globalThis as unknown as {
          __ff2?: { stage: () => Node; render: { camera: { position: Vec3 } } }
        }
      ).__ff2
      if (!ff) return null
      const stage = ff.stage()
      stage.updateWorldMatrix(true, true)
      const drawn = (o: Node): boolean => {
        for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
        return true
      }
      let model: Node | null = null
      stage.traverse((o) => {
        if (!drawn(o)) return
        if (markKind !== null && o.name === 'mode-mark' && o.userData.kind === markKind) model = o
        if (
          missionId !== null &&
          o.name === 'hangar-holotable' &&
          o.userData.missionId === missionId
        )
          o.traverse((c) => {
            if (c.name === 'diorama') model = c
          })
      })
      if (!model) return null
      const Vector3 = ff.render.camera.position.constructor as new () => Vec3
      const centre = (model as Node).getWorldPosition(new Vector3())
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      // 0.3 m each way and 0.32 m up from the model plane covers the island's
      // disc, a mark's cylinder and the craft's lob.
      for (const dx of [-0.3, 0.3])
        for (const dy of [-0.04, 0.32])
          for (const dz of [-0.3, 0.3]) {
            const v = new Vector3()
              .set(centre.x + dx, centre.y + dy, centre.z + dz)
              .project(ff.render.camera)
            minX = Math.min(minX, ((v.x + 1) / 2) * innerWidth)
            maxX = Math.max(maxX, ((v.x + 1) / 2) * innerWidth)
            minY = Math.min(minY, ((1 - v.y) / 2) * innerHeight)
            maxY = Math.max(maxY, ((1 - v.y) / 2) * innerHeight)
          }
      const x = Math.max(0, Math.floor(minX))
      const y = Math.max(0, Math.floor(minY))
      return {
        x,
        y,
        width: Math.min(innerWidth, Math.ceil(maxX)) - x,
        height: Math.min(innerHeight, Math.ceil(maxY)) - y,
      }
    },
    { missionId, markKind },
  )

/** Title -> the room, which opens on the aircraft every time (DEV-105). */
const intoTheRoom = async (page: Page) => {
  await page.goto(`/?xr=off&${PINNED}`)
  await firstPress(page)
  // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
  // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
  await bootReady(page, 240_000)
  // `dropFocus`, not `focusCanvas`: a click on the TITLE is a real press
  // since DEV-301, and this run has to leave the title with ENTER. See
  // `fixtures/canvas.ts` for the rule and why every other call site is safe.
  await dropFocus(page)
  await page.waitForTimeout(1_200)
  await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
  await throughDoors(page) // and SINGLE PLAYER, to the aircraft
  expect(await view(page), 'Single Player opens the aircraft').toBe('vehicles')
}

/** A shot, with the tier read back beside it — a pin is a fact only once read. */
const shoot = async (
  page: Page,
  path: string,
  clip?: { x: number; y: number; width: number; height: number },
) => {
  const state = await drawState(page)
  await page.screenshot(clip ? { path, clip } : { path })
  console.log(`[DEV-354] ${path.split('/').at(-1)} · ${drawStateLine(state)}`)
  return state
}

test('the aircraft step stands aircraft on the tables, and the plan step stands marks', async ({
  page,
}) => {
  test.setTimeout(300_000)
  await intoTheRoom(page)

  // The GLBs load on their own and the tables take them when they land, the
  // way the medals do. Poll rather than wait a fixed time.
  // Three on Anniversary since DEV-399: the glider stands beside 2016's two.
  await expect
    .poll(async () => (await onTables(page))?.ships.length ?? -1, {
      timeout: 60_000,
      message: 'every aircraft reaches its table',
    })
    .toBe(3)

  const aircraftStep = await onTables(page)
  expect(aircraftStep?.ships, 'one table each, and they are the three aircraft').toEqual([
    'glider',
    'hoverjet',
    'jumpseat',
  ])
  // It used to be 2 — both aircraft tables stood on `rookie_01_*`'s alpine
  // island, which is the same island twice (DEV-142).
  const aircraftTables = aircraftStep?.tables ?? []
  expect(
    aircraftTables.reduce((n, t) => n + t.islands, 0),
    'terrain on the aircraft step',
  ).toBe(0)
  expect(
    aircraftTables.flatMap((t) => t.marks),
    'a mark on the aircraft step',
  ).toEqual([])

  // Four frames, a quarter turn apart (27.5 deg/s, so 3.3 s each). ONE frame of
  // a turntable is one face, and the face you get is random by design.
  const dir = process.env.SHIP_SELECT_SHOT_DIR
  if (dir) {
    for (let i = 0; i < 4; i++) {
      await shoot(page, `${dir}/ship-select-aircraft-${PIN_TAG}-${i}.png`)
      await page.waitForTimeout(3_300)
    }
  }

  // ── the control ─────────────────────────────────────────────────────────
  //
  // One press down into the HoverJet's FLIGHT PLANS. They stand marks and no
  // ships, which is what stops "show ships" from having been implemented as
  // "show ships everywhere". The press needs no aiming: the resting pointer is
  // on the HoverJet (DEV-399 stands the glider to its LEFT so it stays so). On
  // Anniversary the VARIANT step is between (DEV-382); it stands the aircraft
  // too, and `variant-step.spec.ts` photographs it.
  await hold(page, 'Enter')
  await throughVariants(page)
  expect(await view(page), 'a press on an aircraft opens its flight plans').toBe('modes')
  await expect
    .poll(async () => (await onTables(page))?.tables.flatMap((t) => t.marks).length ?? -1, {
      timeout: 60_000,
      message: 'the flight-plan tables get their marks',
    })
    .toBeGreaterThan(0)
  const planStep = await onTables(page)
  expect(planStep?.ships, 'no aircraft on the flight-plan step').toEqual([])
})

/* ══════ the plan step stands ONE mark; the level step the LAND (DEV-354) ══════ */

/**
 * What each aircraft's plan arc must stand, by the scorer's kind — and, since
 * DEV-379 listed the canyon lessons, Flight School's `instructor`: the plan
 * that TEACHES stands the instructor's hull rather than Ring Attack's gate.
 */
const PLAN_STEPS = [
  { vehicle: 'hoverjet', kinds: ['instructor', 'orb', 'ring'] },
  { vehicle: 'jumpseat', kinds: ['padZone'] },
] as const

/**
 * One level step per aircraft. `other` is a second course on the SAME place,
 * where the place carries its difficulty (DEV-420): looking at its mark must
 * pick it and redraw the route.
 */
const LEVEL_STEPS: readonly (Course & {
  readonly other?: string
  /** The marks' shapes down the column, top first (the ski-map set, DEV-420). */
  readonly shapes?: readonly string[]
})[] = [
  {
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    rank: 'intermediate',
    id: 'int_01_hoverJet',
    other: 'adv_02_hoverJet',
    shapes: ['circle', 'diamond'],
  },
  // DEV-874: the JumpSeat walks plan -> place with difficulty marks like the
  // HoverJet's: alpine holds its beginner and intermediate courses.
  {
    vehicle: 'jumpseat',
    mode: 'targetPractice',
    rank: 'beginner',
    id: 'rookie_01_jumpSeat',
    other: 'int_02_jumpSeat',
    shapes: ['square', 'circle'],
  },
]

test.describe('the plan step stands one mark, the level step the land (DEV-354)', () => {
  // Device scale 2 is a HiDPI display, not a different build: the game renders
  // at `min(devicePixelRatio, cap)` for any player, and the pinned high tier's
  // cap is 2 — so a crop carries twice the pixels a 1x shot would.
  test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })

  for (const step of PLAN_STEPS) {
    test(`${step.vehicle}: every flight-plan table stands ONE mark and no course`, async ({
      page,
    }) => {
      test.setTimeout(300_000)
      await intoTheRoom(page)
      expect(await lookUntilAimed(page, step.vehicle), `found the ${step.vehicle}`).toBe(true)
      await hold(page, 'Enter')
      // DEV-382's variant step, where the room has it: standard, at rest.
      await throughVariants(page)
      expect(await view(page), 'a press on an aircraft opens its flight plans').toBe('modes')

      // Every live plan table has its mark: the gate and the orb are GLBs that
      // land on their own, and the pad is one level JSON away.
      const live = async () => (await onTables(page))?.tables.filter((t) => t.aimable) ?? []
      await expect
        .poll(async () => (await live()).map((t) => t.marks.length).join(','), {
          timeout: 60_000,
          message: `${step.vehicle}: a mark on every plan table`,
        })
        .toBe(step.kinds.map(() => 1).join(','))
      // Face the plans square, from the resting bearing: since DEV-419 the plan
      // arc is the aircraft's own row, so from rest the HoverJet's three stand
      // Flight School, Ring Attack (under the pointer), Free Flight. The
      // HoverJet sits on the resting bearing, so its press needed no turn; the
      // JumpSeat is 30 degrees right of it, and its one plan, Target Practice,
      // stands ON the resting bearing — so aiming at that plan turns back.
      if (step.vehicle === 'jumpseat') {
        expect(await lookUntilAimed(page, 'targetPractice'), 'found Target Practice').toBe(true)
      }
      await page.waitForTimeout(1_000)

      const dir = process.env.SHIP_SELECT_SHOT_DIR
      if (dir) {
        // A burst, because the marks turn: four frames 0.8 s apart is 22 deg a
        // frame, so a gate seen edge-on in one is face-on two frames later.
        const states: Awaited<ReturnType<typeof drawState>>[] = []
        for (let i = 0; i < 4; i++) {
          states.push(await shoot(page, `${dir}/${step.vehicle}-plans-${PIN_TAG}-${i}.png`))
          await page.waitForTimeout(800)
        }
        for (const kind of step.kinds) {
          const rect = await modelRect(page, null, kind)
          if (rect && rect.width > 0 && rect.height > 0) {
            await shoot(page, `${dir}/${step.vehicle}-plan-${kind}-${PIN_TAG}.png`, rect)
          }
        }
        // The pin HELD across the burst, or these are pictures of two builds.
        const first = states[0] as (typeof states)[number]
        for (const s of states.slice(1)) {
          expect(drawStateDiff(first, s), 'the tier moved').toEqual([])
        }
      }

      // ── the claim ──────────────────────────────────────────────────────────
      const tables = await live()
      expect(tables.length, 'the premise: live plan tables').toBe(step.kinds.length)
      for (const t of tables) {
        expect(t.marks, 'more than one mark on a plan table').toHaveLength(1)
        // THE guard: a plan table that grows a course again has a diorama.
        expect(t.dioramas, 'a plan table grew a course').toBe(0)
        expect(t.islands, 'a plan table stands terrain').toBe(0)
        expect(t.craft, 'a plan table flies a craft').toBe(0)
      }
      expect(
        tables.flatMap((t) => t.marks).sort(),
        `${step.vehicle}: the plans stand the wrong marks`,
      ).toEqual([...step.kinds])
      // And no mark anywhere else in the room: the dead plates stand nothing.
      const all = (await onTables(page))?.tables ?? []
      expect(all.flatMap((t) => t.marks)).toHaveLength(step.kinds.length)
    })
  }

  for (const course of LEVEL_STEPS) {
    test(`${course.vehicle}: the level step stands ${course.id}'s land and nothing marked on it`, async ({
      page,
    }) => {
      test.setTimeout(300_000)
      await intoTheRoom(page)
      // The room's own steps, asked before each: DEV-382's variant step is
      // Anniversary's, and DEV-420's Ring Attack walks no rank step — which the
      // room knows once the plan is open.
      for (const [at, want] of [
        ['vehicles', course.vehicle],
        ['variants', course.variant ?? 'standard'],
        ['modes', course.mode],
        ['ranks', course.rank],
      ] as const) {
        if (!((await hangarAim(page))?.views ?? []).includes(at)) continue
        expect(await view(page), `${course.id}: on the ${at} step`).toBe(at)
        expect(await lookUntilAimed(page, want), `${course.id}: found ${want}`).toBe(true)
        await hold(page, 'Enter')
      }
      expect(await view(page), `${course.id}: on the courses step`).toBe('courses')
      expect(await aimAtCourse(page, course.id), `${course.id}: its table is here`).toBe(true)

      const mine = async () =>
        (await onTables(page))?.tables.find((t) => t.missionId === course.id) ?? null
      await expect
        .poll(async () => (await mine())?.islands ?? -1, {
          timeout: 60_000,
          message: `${course.id}: its island arrives`,
        })
        .toBe(1)
      await page.waitForTimeout(2_000)

      const dir = process.env.SHIP_SELECT_SHOT_DIR
      if (dir) {
        await shoot(page, `${dir}/${course.vehicle}-level-${course.id}-${PIN_TAG}.png`)
        const rect = await modelRect(page, course.id, null)
        if (rect && rect.width > 0 && rect.height > 0) {
          await shoot(
            page,
            `${dir}/${course.vehicle}-level-${course.id}-table-${PIN_TAG}.png`,
            rect,
          )
        }
      }

      // ── the claim ──────────────────────────────────────────────────────────
      const table = (await mine()) as TableCensus
      expect(table.dioramas, 'the land').toBe(1)
      expect(table.islands, 'the island').toBe(1)
      expect(table.craft, 'the craft over it').toBeGreaterThan(0)
      expect(table.strays, 'a gate, a target or an orb on a level table').toEqual([])
      expect(table.marks, 'a flight-plan mark on a level table').toEqual([])
      // And on every other table on this step.
      const all = (await onTables(page))?.tables ?? []
      expect(all.flatMap((t) => t.strays)).toEqual([])
      expect(all.flatMap((t) => t.marks)).toEqual([])

      if (course.other === undefined) {
        // 2016's walk: no difficulty marks and no drawn route, anywhere.
        expect(all.flatMap((t) => t.skiMarks)).toEqual([])
        expect(
          all.reduce((n, t) => n + t.routes, 0),
          'a route on a rank-walked place',
        ).toBe(0)
        return
      }

      // ── DEV-420: the place carries its difficulty ─────────────────────────
      //
      // Its column: one mark per course there, top first in the rank order,
      // the course we came for picked, and ONE route drawn — the pick's.
      const other = course.other
      const column = table.skiMarks.map((m) => m.missionId)
      expect(column, `${course.id}'s place stands both its courses`).toEqual([course.id, other])
      expect(
        table.skiMarks.map((m) => m.shape),
        'the ski-map marks, top first',
      ).toEqual(course.shapes ?? ['circle', 'diamond'])
      expect(table.skiMarks.find((m) => m.picked)?.missionId, 'the pick').toBe(course.id)
      expect(table.routes, 'one route drawn: the pick').toBe(1)
      const before = table.routeColour
      expect(before, 'the route has a colour').not.toBeNull()
      // Every live place stands marks; a dead one (Kauai) stands none.
      for (const t of all) {
        if (t.aimable) expect(t.skiMarks.length, 'a live place with no marks').toBeGreaterThan(0)
        else expect(t.skiMarks, 'marks on a dead plate').toEqual([])
      }

      // LOOK at the other mark: it becomes the pick, and the island redraws.
      expect(await aimAtMark(page, other), `looked at ${other}'s mark`).toBe(true)
      const at = await hangarAim(page)
      expect(at?.aimName, 'the aim is the course the mark picks').toBe(other)
      expect(at?.mark, 'and it is on the mark').toBe(true)
      const picked = async () =>
        (await onTables(page))?.tables.find((t) => t.skiMarks.some((m) => m.missionId === other)) ??
        null
      await expect
        .poll(async () => (await picked())?.missionId ?? null, {
          timeout: 10_000,
          message: 'the table picked the course its mark was looked at',
        })
        .toBe(other)
      const after = (await picked()) as TableCensus
      expect(after.skiMarks.find((m) => m.picked)?.missionId).toBe(other)
      expect(after.routes, 'still one route').toBe(1)
      expect(after.routeColour, 'a different colour: the black run').not.toBe(before)
      if (dir) {
        await page.waitForTimeout(800)
        await shoot(page, `${dir}/${course.vehicle}-level-${other}-picked-${PIN_TAG}.png`)
        const rect = await modelRect(page, other, null)
        if (rect && rect.width > 0 && rect.height > 0) {
          await shoot(
            page,
            `${dir}/${course.vehicle}-level-${other}-picked-table-${PIN_TAG}.png`,
            rect,
          )
        }
      }

      // And the pick STAYS when you look away (it is a pick, not a hover).
      // DEV-626: the marks are a ROW along the table's front now, so a level
      // sweep at their height crosses the neighbours and, looking being
      // picking, picks them. A player turning away lifts their eyes off the
      // row first; so does this (KeyW raises the view, `menu-screen.spec.ts`).
      for (let i = 0; i < 10; i++) {
        await page.keyboard.down('KeyW')
        await page.waitForTimeout(45)
        await page.keyboard.up('KeyW')
        await page.waitForTimeout(60)
      }
      expect(await lookUntilAimed(page, 'nothing-is-called-this', 3)).toBe(false)
      expect((await picked())?.skiMarks.find((m) => m.picked)?.missionId).toBe(other)
    })
  }
})
