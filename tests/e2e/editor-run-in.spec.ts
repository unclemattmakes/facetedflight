/**
 * The run-in: the straight from the start pad to the line's first point,
 * judged and fixed, with real pointer events. DEV-486
 * (docs/plan/EDITOR-WAVE-3.md).
 *
 * Matt, of DEV-478's note that the straight was checked against nothing and
 * an AI racer stalled at the hairpin there: *"follow-up plz"*. So this spec
 * builds that hairpin the way a person would: in by COURSES → MAKE A COURSE,
 * three clicks on the ground (point 1 out beyond the pad, point 2 back toward
 * it, point 3 off to the side), so the line's first point lies PAST the pad and
 * the run-in doubles back onto the line. Then, as a person does:
 *
 *  · LIFT CLEAR OF THE GROUND when anything is in or near it (the fixture);
 *  · the warning is there, in the list, with its fix beside it, named for
 *    what it will do: MOVE THE PAD BEHIND POINT 1 (no aim can mend a corner
 *    at point 1);
 *  · the fix, CLICKED: the pad now stands behind point 1 on the line's own
 *    run-up, on the ground, aimed along the line, the warning gone, and the
 *    course flyable; Ctrl+Z brings the hairpin back, Ctrl+Y the fix;
 *  · then the other corner: the heading TYPED to face away, the warning back
 *    at the pad with AIM THE PAD AT POINT 1 beside it; clicked; gone.
 *
 * The drawn run-in is read off its own buffer and must run from the ship on
 * its pad to point 1.
 *
 * `EDITOR_PHOTO_DIR=<dir>` keeps the photographs there too. Tagged `@gpu`;
 * the tier is pinned (`PINNED`), because the photos are looked at.
 */

import fs from 'node:fs'
import path from 'node:path'
import { clickCanvasAt } from './fixtures/canvas'
import { collectPageErrors, openEditorFromTitle } from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import { clearOfChrome, openMenu } from './fixtures/editor-menus'
import type { Ff2Global } from './fixtures/ff2'
import { writeFreeDraft } from './fixtures/free-draft'
import { photographer } from './fixtures/photo'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-run-in')
/** int_01, the sky a new draft takes: the free draft this spec seeds stands on it. */
const INT01 = JSON.parse(
  fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
) as Parameters<typeof writeFreeDraft>[1]

type V3 = [number, number, number]
interface DeskProbe {
  points: V3[]
  selection: number | null
  valid: boolean
  warnings: string[]
  groundReady: boolean
  placeHeight: number
  start: { pos: V3; yaw: number }
  padSeat: number | null
  runIn: V3[] | null
  runInFix: 'aim' | 'move' | null
  canUndo: boolean
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const debug = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
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
  ) as Promise<T>

const screenOf = (page: Page, p: V3) =>
  debug<{ x: number; y: number } | null>(page, 'screenOf', p[0], p[1], p[2])
const groundAt = (page: Page, x: number, z: number) => debug<number>(page, 'groundAt', x, z)

const photo = photographer(OUT)

/** The heading's nose in plan: `yawForward`, restated (Playwright's loader takes no src/ value). */
const noseOf = (yaw: number): [number, number] => {
  const r = (yaw * Math.PI) / 180
  return [-Math.sin(r), -Math.cos(r)]
}

test.describe('@gpu the run-in (DEV-486)', () => {
  test.setTimeout(900_000)

  test('a pad past point 1 is warned, and the fix beside the warning mends it', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    const infos: string[] = []
    page.on('console', (m) => {
      if (m.text().startsWith('editor:')) infos.push(m.text())
    })

    // ── in by the title's door: COURSES, then MAKE A COURSE ─────────────
    const enter = async (): Promise<void> => {
      await openEditorFromTitle(page)
    }
    await enter()
    // DEV-501: on a draft made before the anchor. A new draft's first ring is
    // the pad's, dead ahead of it, and its run-in cannot turn; this warning
    // and its fix are for the courses made before, which keep a free point.
    // The pad stands where the desk's search put the new draft's; in again.
    await writeFreeDraft(page, INT01, (await desk(page)).start)
    await enter()
    const fresh = await desk(page)
    expect(fresh.points).toEqual([])
    const pad = fresh.start.pos

    // ── where to put the line: a way from the pad where the land goes on,
    // dry and at about the pad's own height, past point 1 (where the fix will
    // look). The pad stands on a hilltop by the sea: most ways run out over
    // the water, and the highest ground is too steep for a pad.
    const SEA = 116.6 + 1 // int_01's water (DEV-475), and a metre of waves
    let best = { u: [1, 0] as [number, number], score: Number.POSITIVE_INFINITY }
    for (let deg = 0; deg < 360; deg += 15) {
      const u: [number, number] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]
      let sum = 0
      let dry = true
      for (let d = 560; d <= 1000; d += 40) {
        const h = await groundAt(page, pad[0] + u[0] * d, pad[2] + u[1] * d)
        if (h < SEA) dry = false
        sum += h
      }
      const score = Math.abs(sum / 12 - pad[1])
      if (dry && score < best.score) best = { u, score }
    }
    const [ux, uz] = best.u
    const at = (along: number, across: number): [number, number] => [
      pad[0] + ux * along - uz * across,
      pad[2] + uz * along + ux * across,
    ]
    // Point 1 out beyond the pad, point 2 back toward it, point 3 off to the side.

    await page.locator('[data-editor="top-down"]').click()
    await page.locator('[data-editor="height"]').fill('150')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).placeHeight).toBe(150)
    await page.waitForTimeout(1_000)
    // Zoomed in over the pad, as a person would: framing the island puts ~10 m
    // in a pixel, and point 2 would then land on the pad's own handle.
    const padOnScreen = await screenOf(page, pad)
    if (!padOnScreen) throw new Error('the pad is off screen')
    await page.mouse.move(padOnScreen.x, padOnScreen.y)
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(1_500)
    // DEV-501: the seeded draft's pad stands on the sky's own start, near the
    // map's edge top-down, so point 3 goes to whichever side is on screen (the
    // hairpin is the same either way).
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    const onScreen = async ([x, z]: [number, number]): Promise<boolean> => {
      const p = await screenOf(page, [x, await groundAt(page, x, z), z])
      return !!p && clearOfChrome(p, view)
    }
    const side = (await onScreen(at(220, 420))) ? 420 : -420
    const picks = [at(520, 0), at(220, 0), at(220, side)]
    for (const [x, z] of picks) {
      const y = await groundAt(page, x, z)
      const s = await screenOf(page, [x, y, z])
      if (!s) throw new Error('a pick is behind the eye')
      await clickCanvasAt(page, s.x, s.y)
      await page.waitForTimeout(150)
      // A new point is selected and its gizmo's arrows stand over the next
      // pick (point 2 is 300 m back along the way point 1 came): let it go.
      await page.keyboard.press('Escape')
      await expect.poll(async () => (await desk(page)).selection).toBeNull()
      const padOn = await screenOf(page, pad)
      console.log(
        `[DEV-486] pick (${x.toFixed(0)}, ${z.toFixed(0)}) at px ${s.x.toFixed(0)},${s.y.toFixed(0)} ` +
          `(pad at ${padOn?.x.toFixed(0)},${padOn?.y.toFixed(0)}): ${(await desk(page)).points.length} point(s)`,
      )
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(3)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await desk(page)).selection).toBeNull()
    // Whatever of it is in or near the ground (the run-in included), lifted.
    await liftToFlyable(page, 'three points past the pad')

    // ── the warning, and its fix, named ─────────────────────────────────
    const placed = await desk(page)
    expect(placed.warnings, 'the run-in doubles back').toContain('run-in-turn')
    expect(placed.runInFix).toBe('move')
    // The fix stands beside its problem, in the problems pill's popover.
    await openMenu(page, 'problems')
    const fix = page.locator('[data-editor="run-in-fix"]')
    await expect(fix).toHaveCount(1)
    await expect(fix).toHaveText('Move the pad behind point 1')
    // The warning it stands in says where.
    await expect(
      page.locator('[data-editor="problems-pop"] .warnings li', { has: fix }),
    ).toContainText('at point 1')
    // The run-in drawn runs from the ship on its pad to point 1.
    if (!placed.runIn) throw new Error('no run-in drawn')
    const [tail, tip] = placed.runIn as [V3, V3]
    const p1 = placed.points[0] as V3
    expect(Math.hypot(tip[0] - p1[0], tip[1] - p1[1], tip[2] - p1[2])).toBeLessThan(0.01)
    expect(Math.hypot(tail[0] - pad[0], tail[2] - pad[2])).toBeLessThan(0.01)
    expect(tail[1] - pad[1], 'from the ship over its pad').toBeGreaterThan(2)
    console.log(
      `[DEV-486] pad ${pad.map((v) => v.toFixed(1))}, point 1 ${p1.map((v) => v.toFixed(1))}, ` +
        `the line toward ${best.u.map((v) => v.toFixed(2))}`,
    )
    await photo(page, 'run-in-hairpin.png')

    // ── the fix, clicked ────────────────────────────────────────────────
    await fix.click()
    await page.waitForTimeout(500)
    console.log(`[DEV-486] after the fix: ${infos.slice(-2).join(' | ')}`)
    await expect
      .poll(async () => (await desk(page)).warnings, { timeout: 10_000 })
      .not.toContain('run-in-turn')
    const moved = await desk(page)
    const m = moved.start.pos
    // Behind point 1, on the line's own run-up: further out along the way the line came in from.
    const back = (m[0] - p1[0]) * ux + (m[2] - p1[2]) * uz
    const off = Math.abs(-(m[0] - p1[0]) * uz + (m[2] - p1[2]) * ux)
    console.log(
      `[DEV-486] the pad moved ${back.toFixed(0)} m behind point 1 (${off.toFixed(1)} m off its line): ` +
        `${infos.filter((t) => t.includes('start pad')).join(' | ')}`,
    )
    expect(back, 'behind point 1').toBeGreaterThan(0)
    expect(moved.points, 'the line did not move').toEqual(placed.points)
    // Seated on what you see there, and aimed back down the line.
    expect(Math.abs(m[1] - (moved.padSeat as number))).toBeLessThan(0.05)
    const [nx, nz] = noseOf(moved.start.yaw)
    expect(nx * -ux + nz * -uz, 'aimed along the line').toBeGreaterThan(0.95)
    // ── one undo step each way ──────────────────────────────────────────
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).start.pos).toEqual(placed.start.pos)
    expect((await desk(page)).warnings).toContain('run-in-turn')
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await desk(page)).start.pos).toEqual(moved.start.pos)
    expect((await desk(page)).warnings).not.toContain('run-in-turn')
    // The new straight, lifted if it needs it, and the course flies.
    await liftToFlyable(page, 'the pad behind point 1')
    expect((await desk(page)).warnings).not.toContain('run-in-turn')
    await photo(page, 'run-in-moved.png')

    // ── the other corner: the heading typed to face away ────────────────
    const before = await desk(page)
    const facing = before.start.yaw
    const away = facing > 0 ? facing - 180 : facing + 180
    await page.locator('[data-editor="pad-yaw"]').fill(String(away))
    await page.locator('[data-editor="pad-yaw"]').press('Enter')
    await expect
      .poll(async () => (await desk(page)).warnings, { timeout: 10_000 })
      .toContain('run-in-turn')
    expect((await desk(page)).runInFix).toBe('aim')
    await expect(fix).toHaveText('Aim the pad at point 1')
    await photo(page, 'run-in-aimed-away.png')
    await fix.click()
    await expect
      .poll(async () => (await desk(page)).warnings, { timeout: 10_000 })
      .not.toContain('run-in-turn')
    const aimed = await desk(page)
    expect(aimed.start.pos, 'aiming does not move it').toEqual(before.start.pos)
    const [from, to] = aimed.runIn as [V3, V3]
    const ax0 = to[0] - from[0]
    const az0 = to[2] - from[2]
    const l = Math.hypot(ax0, az0)
    const [ax, az] = noseOf(aimed.start.yaw)
    expect((ax * ax0 + az * az0) / l, 'aimed at point 1').toBeGreaterThan(0.9999)
    await expectFlyable(page, 'the pad aimed at point 1')

    // ── photographed close: the pad, its run-in and the line ────────────
    const s = await screenOf(page, from)
    if (s) {
      await page.mouse.move(s.x, s.y)
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -240)
        await page.waitForTimeout(120)
      }
    }
    await page.waitForTimeout(1_500)
    await photo(page, 'run-in-aimed-close.png')
    expect(pageErrors).toEqual([])
  })
})
