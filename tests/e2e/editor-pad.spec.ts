/**
 * The start pad, with real pointer events. DEV-475
 * (docs/plan/EDITOR-PLAYTEST-2026-09-27.md, Matt's answer 1).
 *
 * Matt: *"a visible hover-pad marker dragged anywhere on the island and aimed;
 * the ship starts on it and lifts off, the racers on slots beside it."* So
 * this spec does what a hand does, through `fixtures/canvas.ts`: a click on
 * the pad's handle picks it, its X and Z arrows are DRAGGED (hover, press,
 * move, release), E turns the gizmo to its Y ring (R did until DEV-570) and
 * the ring is dragged, never a call into the editor in place of a gesture. Then FLY, and the ship
 * the GAME spawns is measured against what the editor drew:
 *
 *  · WHERE: the body stands over the pad's foot, a lift's stand-up above it;
 *  · WHICH WAY, as GEOMETRY, twice: the body's thrust axis against the
 *    arrow the editor drew (its world matrix, not the yaw it was built from),
 *    and, after GO with the throttle held, the way the ship actually WENT;
 *  · the racers stand on the starts the editor drew beside the pad.
 *
 * DEV-501: the draft is ANCHORED, so the same drags are also the anchor's
 * e2e: the first point (ring 1) follows the pad through the X and Z drags by
 * exactly the pad's move, and through the aim it swings to one gap straight
 * ahead of the new heading — measured as geometry against the arrow the
 * editor drew. Photographed top-down before and after the turn.
 *
 * And a v1 link, made by the v1 build (`tests/unit/fixtures/player-course-v1.json`),
 * opens as its v2 self: the link is read and listed under the v2 id.
 *
 * `EDITOR_PHOTO_DIR=<dir>` keeps the photographs there too: the pad in the
 * editor with the racers' pads beside it, the ship on its pad in the
 * countdown, and at GO. Tagged `@gpu`; the tier is pinned (`PINNED`), because
 * the photos are looked at.
 */

import fs from 'node:fs'
import path from 'node:path'
import { playerCourseId } from '../../src/content/player-course'
import { readCourseToken } from '../../src/content/player-course-wire'
import { bootReady, missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt, dragCanvas, hoverCanvasAt } from './fixtures/canvas'
import { collectPageErrors, editorHold as hold, openEditorFromTitle } from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { photographer } from './fixtures/photo'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-pad')
const INT01_ROUTE = (
  JSON.parse(fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8')) as {
    route: [number, number, number][]
  }
).route
// DEV-501: the first from route[30] (692 m out) on, past ring 1, which is
// anchored one gap (497 m on int_01) ahead of the pad; route[20] (393 m) sits
// BEHIND it, and a line clicked back behind its own first ring doubles over the
// pad. route[30] itself is over the sea, where a click places nothing, so the
// first pick walks on along the route to the first place a click lands on land.
const FIRST_PICKS = [30, 34, 38, 42, 46, 50] as const
const ROUTE_PICKS = [60, 100, 140] as const
/** DEV-475's v1 fixture: courses as the v1 build wrote them. Read, not imported (Playwright's loader). */
const V1 = JSON.parse(
  fs.readFileSync(path.join('tests', 'unit', 'fixtures', 'player-course-v1.json'), 'utf8'),
) as { courses: { token: string; id: string }[] }

type V3 = [number, number, number]
interface DeskProbe {
  points: V3[]
  anchored: boolean // DEV-501
  gap: number
  selection: number | null
  valid: boolean
  warnings: string[]
  courseId: string | null
  groundReady: boolean
  placeHeight: number
  start: { pos: V3; yaw: number }
  padPicked: boolean
  padRotate: boolean
  gizmoMode: string
  gizmo: { attached: boolean; axis: string | null; dragging: boolean }
  pads: { role: string; foot: V3 }[]
  padDressed: boolean
  startArrow: { tail: V3; tip: V3 } | null
  padSeat: number | null
  slots: { kind: string; pos: V3; foot: V3 }[]
}
interface Debug {
  screenOf(x: number, y: number, z: number): { x: number; y: number } | null
  gizmoHandle(axis: 'X' | 'Y' | 'Z'): { x: number; y: number } | null
  gizmoRing(): { x: number; y: number } | null
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const debug = <K extends keyof Debug>(
  page: Page,
  name: K,
  ...args: Parameters<Debug[K]>
): Promise<ReturnType<Debug[K]>> =>
  page.evaluate(
    ([n, a]) => {
      const w = globalThis as unknown as Ff2Global
      const d = w.__ff2.editorDebug() as unknown as Record<
        string,
        (...x: unknown[]) => unknown
      > | null
      if (!d) throw new Error('no editor debug')
      return (d[n as string] as (...x: unknown[]) => unknown)(...(a as unknown[]))
    },
    [name, args] as const,
  ) as Promise<ReturnType<Debug[K]>>

/** The ship as the GAME holds it, in THREE space: its position, and its nose (sim +Z, mirrored). */
const ship = (page: Page): Promise<{ pos: V3; nose: V3 } | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const b = w.__ff2.flight()?.jet.body
    if (!b) return null
    const { x, y, z, w: qw } = b.orientation
    // The sim is UNITY space and the flight model thrusts along body +Z:
    // (0, 0, 1) turned by the body's quaternion, then the z mirror into three.
    const nx = 2 * (x * z + qw * y)
    const ny = 2 * (y * z - qw * x)
    const nz = 1 - 2 * (x * x + y * y)
    return {
      pos: [b.position.x, b.position.y, -b.position.z] as [number, number, number],
      nose: [nx, ny, -nz] as [number, number, number],
    }
  })

const launchPhase = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.launch().phase)

const flat = (v: readonly number[]): [number, number] => {
  const l = Math.hypot(v[0] as number, v[2] as number) || 1
  return [(v[0] as number) / l, (v[2] as number) / l]
}

const photo = photographer(OUT)

test.describe('@gpu the start pad (DEV-475)', () => {
  test.setTimeout(900_000)

  test('drag the pad, aim it, fly: the ship starts where it was put, facing where it was aimed', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)

    // ── in by the title's door: COURSES, then MAKE A COURSE ─────────────
    await openEditorFromTitle(page)

    // A new draft has a pad from the start, seated on the ground it found.
    const fresh = await desk(page)
    // DEV-501: a new draft's one point is the pad's.
    expect(fresh.points.length).toBe(1)
    expect(fresh.anchored).toBe(true)
    expect(fresh.pads[0]?.role, 'the player’s pad is drawn').toBe('player')
    expect(fresh.padSeat).not.toBeNull()
    expect(Math.abs(fresh.start.pos[1] - (fresh.padSeat as number))).toBeLessThan(0.05)
    expect(fresh.warnings.filter((w) => w.startsWith('pad-') || w.startsWith('slot-'))).toEqual([])
    // The Start slider is gone; the pad's controls stand where it was.
    await expect(page.locator('[data-editor="start"]')).toHaveCount(0)
    await expect(page.locator('[data-editor="pad"]')).toBeVisible()
    await expect(page.locator('[data-editor="pad-yaw"]')).toBeVisible()
    await expect.poll(async () => (await desk(page)).padDressed, { timeout: 30_000 }).toBe(true)

    // ── a course: four points on 2016's own line, top-down ──────────────
    await page.locator('[data-editor="top-down"]').click()
    await page.locator('[data-editor="height"]').fill('150')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).placeHeight).toBe(150)
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    const free = { width: view.width - 324, height: view.height }
    // The top-down camera settles before the picks are projected (DEV-501: the
    // first pick of a run was lost to a camera still moving).
    await page.waitForTimeout(1_500)
    for (const i of FIRST_PICKS) {
      const [wx, wy, wz] = INT01_ROUTE[i] as V3
      const at = await debug(page, 'screenOf', wx, wy, wz)
      if (!at) throw new Error(`route[${i}] is behind the eye`)
      await clickCanvasAt(page, at.x, at.y)
      await page.waitForTimeout(150)
      await page.keyboard.press('Escape')
      await expect.poll(async () => (await desk(page)).selection).toBeNull()
      const n = (await desk(page)).points.length
      console.log(
        `[DEV-501] route[${i}] at px ${at.x.toFixed(0)},${at.y.toFixed(0)}: ${n} point(s)`,
      )
      if (n === 2) break
    }
    for (const i of ROUTE_PICKS) {
      const [wx, wy, wz] = INT01_ROUTE[i] as V3
      const at = await debug(page, 'screenOf', wx, wy, wz)
      if (!at) throw new Error(`route[${i}] is behind the eye`)
      await clickCanvasAt(page, at.x, at.y)
      await page.waitForTimeout(150)
      // Let the new point go, so its gizmo's arrows are not over the next pick.
      await page.keyboard.press('Escape')
      await expect.poll(async () => (await desk(page)).selection).toBeNull()
      console.log(
        `[DEV-501] route[${i}] at px ${at.x.toFixed(0)},${at.y.toFixed(0)}: ${(await desk(page)).points.length} point(s)`,
      )
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await desk(page)).selection).toBeNull()
    // DEV-478: these four points sag through a hill between the middle two
    // (the racers dove into it, Matt watched). LIFT CLEAR OF THE GROUND,
    // pressed, before the pad is touched: the racers fly a course, not a hill.
    await liftToFlyable(page, 'four points 150 m over int_01')
    const lifted = (await desk(page)).points.length

    // ── PICK the pad by its handle ──────────────────────────────────────
    const before = await desk(page)
    const onPad = await debug(page, 'screenOf', ...before.start.pos)
    if (!onPad) throw new Error('the pad is off screen')
    expect(onPad.x > 0 && onPad.x < free.width && onPad.y > 0 && onPad.y < free.height).toBe(true)
    await clickCanvasAt(page, onPad.x, onPad.y)
    await expect.poll(async () => (await desk(page)).padPicked).toBe(true)
    expect((await desk(page)).gizmoMode).toBe('translate')
    // F frames the picked pad (still top-down), so a drag is tens of metres,
    // not the island's width: the pad stays on the dry ground it was found on.
    await page.keyboard.press('f')
    await page.waitForTimeout(1_500)

    // ── DRAG its X arrow, then its Z arrow: it moves, and sits on the ground
    const drag = async (axis: 'X' | 'Z', by: { x: number; y: number }): Promise<void> => {
      const h = await debug(page, 'gizmoHandle', axis)
      if (!h) throw new Error(`no ${axis} arrow`)
      await hoverCanvasAt(page, h.x, h.y)
      await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe(axis)
      await dragCanvas(page, h, { x: h.x + by.x, y: h.y + by.y }, { steps: 16 })
      await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    }
    const p0 = (await desk(page)).start.pos
    const ring0 = (await desk(page)).points[0] as V3 // DEV-501: the anchored point, before
    await drag('X', { x: 12, y: 0 })
    const p1 = (await desk(page)).start.pos
    expect(Math.abs(p1[0] - p0[0]), 'the pad moved along X').toBeGreaterThan(1)
    expect(Math.abs(p1[2] - p0[2]), 'and not along Z').toBeLessThan(1e-6)
    await drag('Z', { x: 0, y: 12 })
    const p2 = (await desk(page)).start.pos
    expect(Math.abs(p2[2] - p1[2]), 'the pad moved along Z').toBeGreaterThan(1)
    expect(Math.abs(p2[0] - p1[0]), 'and not along X').toBeLessThan(1e-6)
    const moved = await desk(page)
    expect(moved.points.length, 'a drag of the pad adds no point').toBe(lifted)
    // DEV-501: ring 1 came with it, by exactly the pad's move in plan, and it
    // stands the anchor's height over the pad's (re-seated) foot.
    const ring1 = moved.points[0] as V3
    expect(Math.abs(ring1[0] - ring0[0] - (p2[0] - p0[0])), 'ring 1 followed in X').toBeLessThan(
      0.15,
    )
    expect(Math.abs(ring1[2] - ring0[2] - (p2[2] - p0[2])), 'ring 1 followed in Z').toBeLessThan(
      0.15,
    )
    expect(Math.abs(ring1[1] - p2[1] - 27), 'h over the foot').toBeLessThan(0.15)
    expect(
      Math.abs(moved.start.pos[1] - (moved.padSeat as number)),
      'Y is the ground',
    ).toBeLessThan(0.05)
    console.log(
      `[DEV-475] the pad dragged ${p0.map((v) => v.toFixed(1))} -> ${p2.map((v) => v.toFixed(1))}; ` +
        `its warnings: ${moved.warnings.filter((w) => w.startsWith('pad-') || w.startsWith('slot-')).join(', ') || 'none'}`,
    )
    await photo(page, 'pad-top-down.png') // DEV-501: the "before" of the turn, top-down

    // ── AIM it: E (Maya's rotate, DEV-570; R until then), then drag the Y ring
    await page.keyboard.press('e')
    await expect.poll(async () => (await desk(page)).gizmoMode).toBe('rotate')
    await page.waitForTimeout(500)
    const yaw0 = (await desk(page)).start.yaw
    const ring = await debug(page, 'gizmoRing')
    if (!ring) throw new Error('no Y ring')
    await hoverCanvasAt(page, ring.x, ring.y)
    await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe('Y')
    await dragCanvas(page, ring, { x: ring.x, y: ring.y - 40 }, { steps: 20 })
    await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    const aimed = await desk(page)
    const turned = Math.abs(((aimed.start.yaw - yaw0 + 540) % 360) - 180)
    console.log(
      `[DEV-475] the ring turned the pad ${yaw0.toFixed(1)} -> ${aimed.start.yaw.toFixed(1)}`,
    )
    expect(turned, 'the ring turned the pad').toBeGreaterThan(10)
    expect(aimed.start.pos, 'aiming does not move it').toEqual(moved.start.pos)
    // DEV-501: ring 1 swung with the heading — one gap from the pad in plan,
    // straight along the arrow the editor drew (not merely the yaw it stored),
    // and a metre further along that arrow is a metre further from the pad.
    {
      const r = aimed.points[0] as V3
      const pad = aimed.start.pos
      const a = aimed.startArrow
      if (!a) throw new Error('no arrow drawn')
      const f = flat([a.tip[0] - a.tail[0], 0, a.tip[2] - a.tail[2]])
      const planOf = (x: number, z: number): number => Math.hypot(x - pad[0], z - pad[2])
      expect(Math.abs(planOf(r[0], r[2]) - aimed.gap), 'one gap from the pad').toBeLessThan(0.2)
      const u = flat([r[0] - pad[0], 0, r[2] - pad[2]])
      expect(u[0] * f[0] + u[1] * f[1], 'straight ahead of the arrow').toBeGreaterThan(0.9999)
      const past = planOf(r[0] + f[0], r[2] + f[1]) - planOf(r[0], r[2])
      expect(past, 'a metre on is a metre further').toBeGreaterThan(0.99)
      const swung = Math.hypot(r[0] - ring1[0], r[2] - ring1[2])
      console.log(
        `[DEV-501] ring 1 swung ${swung.toFixed(1)} m with the ${turned.toFixed(1)}° turn (gap ${aimed.gap} m)`,
      )
      expect(swung, 'ring 1 moved with the turn').toBeGreaterThan(20)
      // Photographed top-down, drawn out to show pad and ring 1 together: after
      // the turn, then before it (one undo), and the turn put back (redo).
      const onPad = await debug(page, 'screenOf', ...pad)
      if (onPad) {
        await page.mouse.move(onPad.x, onPad.y)
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel(0, 240)
          await page.waitForTimeout(120)
        }
      }
      await page.waitForTimeout(1_500)
      await photo(page, 'anchor-top-down-aimed.png')
      await page.keyboard.press('Control+z')
      await expect.poll(async () => (await desk(page)).start.yaw).toBe(yaw0)
      await page.waitForTimeout(500)
      await photo(page, 'anchor-top-down-before.png')
      await page.keyboard.press('Control+y')
      await expect.poll(async () => (await desk(page)).start.yaw).toBe(aimed.start.yaw)
      expect((await desk(page)).points[0]).toEqual(r)
    }
    // The turn may have swung the line's first stretch over a hill: Lift, as a
    // person would (it raises the rest of the line; ring 1 is the pad's).
    await liftToFlyable(page, 'the pad moved and aimed')
    // The heading the editor DREW: the arrow's own world matrix, tail to tip.
    const arrow = aimed.startArrow
    if (!arrow) throw new Error('no arrow drawn')
    const drawn = flat([arrow.tip[0] - arrow.tail[0], 0, arrow.tip[2] - arrow.tail[2]])
    const afterLift = await desk(page) // DEV-501: after the Lift above
    expect(afterLift.valid, `the course flies (warnings: ${afterLift.warnings})`).toBe(true)
    await expectFlyable(page, 'the course, its pad moved and aimed')
    // Five racers beside it: 2016's two pads and the preset's three slots.
    expect(aimed.slots.length).toBe(5)
    expect(aimed.pads.length).toBe(1 + aimed.slots.length)

    // ── photograph it: out of top-down, framed on the pad ───────────────
    await page.keyboard.press('t')
    await page.keyboard.press('f')
    await page.waitForTimeout(1_500)
    const padOnScreen = await debug(page, 'screenOf', ...aimed.start.pos)
    if (padOnScreen) {
      await page.mouse.move(padOnScreen.x, padOnScreen.y)
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -240)
        await page.waitForTimeout(120)
      }
    }
    await page.waitForTimeout(1_500)
    await photo(page, 'pad-in-editor.png')

    // ── FLY ─────────────────────────────────────────────────────────────
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    await expect.poll(async () => launchPhase(page), { timeout: 30_000 }).toBe('waiting')

    // WHERE: over the pad's foot, the lift's stand-up above it (2.2 m on every sky).
    const held = await ship(page)
    if (!held) throw new Error('no flight')
    const foot = aimed.start.pos
    console.log(
      `[DEV-475] ship ${held.pos.map((v) => v.toFixed(2))} over the pad ${foot.map((v) => v.toFixed(2))}`,
    )
    // The course is stored to 10 cm, so the ship stands on the quantised pad.
    expect(Math.abs(held.pos[0] - foot[0])).toBeLessThan(0.1)
    expect(Math.abs(held.pos[2] - foot[2])).toBeLessThan(0.1)
    expect(held.pos[1] - foot[1]).toBeGreaterThan(2.2 - 0.1)
    expect(held.pos[1] - foot[1]).toBeLessThan(2.2 + 0.1)
    // WHICH WAY: the body's thrust axis is the arrow the editor drew.
    const nose = flat(held.nose)
    expect(nose[0] * drawn[0] + nose[1] * drawn[1], 'the nose is the arrow').toBeGreaterThan(0.999)

    // The racers stand on the starts the editor drew beside the pad.
    const starts = await page.evaluate(
      () => (globalThis as unknown as Ff2Global).__ff2.racers()?.starts.map((s) => s.pos) ?? null,
    )
    expect(starts?.length).toBe(aimed.slots.length)
    starts?.forEach((s, i) => {
      const want = aimed.slots[i]?.pos as V3
      const [sx = 0, , sz = 0] = s
      expect(Math.hypot(sx - want[0], sz - want[2]), `racer ${i + 1}`).toBeLessThan(0.1)
    })

    // ── the countdown on the pad, GO, and the way it went ───────────────
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'v', 120) // the chase view, to see the ship on its pad
    await hold(page, 'Enter', 150)
    await expect.poll(async () => launchPhase(page), { timeout: 10_000 }).toBe('countdown')
    // Past the switch's fade in, still inside the 3-2-1 (four beats).
    await page.waitForTimeout(2_200)
    await photo(page, 'ship-on-pad-countdown.png')
    const stillHeld = await ship(page)
    expect(stillHeld?.pos, 'held on the pad through the countdown').toEqual(held.pos)
    await expect.poll(async () => launchPhase(page), { timeout: 15_000 }).toBe('flying')
    await photo(page, 'ship-at-go.png')
    const atGo = (await ship(page)) as { pos: V3 }
    await page.keyboard.down('Space')
    await page.waitForTimeout(2_500)
    await page.keyboard.up('Space')
    const away = (await ship(page)) as { pos: V3 }
    const went = [away.pos[0] - atGo.pos[0], 0, away.pos[2] - atGo.pos[2]]
    const travelled = Math.hypot(went[0] as number, went[2] as number)
    const dir = flat(went)
    console.log(
      `[DEV-475] after GO, throttle held: ${travelled.toFixed(1)} m, along the arrow ${(dir[0] * drawn[0] + dir[1] * drawn[1]).toFixed(4)}`,
    )
    expect(travelled, 'it lifted off and flew').toBeGreaterThan(20)
    expect(dir[0] * drawn[0] + dir[1] * drawn[1], 'the way it went is the arrow').toBeGreaterThan(
      0.95,
    )
    await photo(page, 'ship-away.png')
    expect(pageErrors).toEqual([])
  })

  test('a v1 link from the v1 build opens as its v2 self', async ({ page }) => {
    const f = V1.courses[1]
    if (!f) throw new Error('fixture')
    const read = await readCourseToken(f.token)
    if (!read.ok) throw new Error('the fixture reads')
    const v2id = playerCourseId(read.course)
    expect(v2id).not.toBe(f.id)
    await page.goto(`/?xr=off&audio=off&${PINNED}#c=${f.token}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await expect(page.locator('body')).toHaveAttribute('data-course-link', v2id, {
      timeout: 60_000,
    })
    await expect
      .poll(async () => Number(await page.locator('body').getAttribute('data-course-library')))
      .toBeGreaterThan(0)
  })
})
