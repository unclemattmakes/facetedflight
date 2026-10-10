/**
 * The forest follows the line: a course through alpine's trees, from the
 * editor's desk into the seat. DEV-502 (docs/plan/EDITOR-PROPS.md).
 *
 * Matt, 2026-09-28: *"let's add clearing along the line"*. In by
 * `?edit=1&mission=int_02_hoverJet` — alpine, the densest forest, where
 * every scatter prop collides (DEV-214) — a course laid round the pad with
 * real clicks (`fixtures/canvas.ts`) and made flyable by LIFT (DEV-478's
 * fixture). What it holds:
 *
 *  · when the course settles, the world's forest is cleared along its FLOWN
 *    line: scatter props are masked, and every masked prop is neither drawn
 *    (a zero matrix) nor solid (its collider out) — DEV-136's rule;
 *  · an undo takes the last point off the line and the trees its stretch
 *    took come back (`shown`); a redo takes them again (`hidden`);
 *  · FLY builds the course's own world with the same clearing, and a probe
 *    sweeps the HoverJet's hull along the flown line: of the props masked,
 *    some stood IN the line (the sample that says the clearing had work to
 *    do), and no sample of the sweep touches a prop.
 *
 * It prints what the live mask cost per edit (`[DEV-502]` lines), the row's
 * measurement. Photos go to `EDITOR_PHOTO_DIR` (default
 * `test-results/editor-corridor`): the desk top-down before the course, after
 * it, and after the undo. Tagged `@gpu`, tier pinned (`PINNED`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt } from './fixtures/canvas'
import { collectPageErrors, openEditor } from './fixtures/editor-boot'
import { liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-corridor')

type V3 = [number, number, number]

interface Receipt {
  level: string
  clearings: number
  masked: number
  hidden: number
  shown: number
  scatter: number
  ms: number
}

interface DeskProbe {
  points: V3[]
  selection: number | null
  undoDepth: number
  groundReady: boolean
  valid: boolean
  pad: V3
  courseId: string | null
  lineClearing: Receipt | null
}

interface WorldClearing {
  receipt: Receipt | null
  scatter: number
  masked: number
  maskedDrawn: number
  maskedSolid: number
  colliders: boolean
  inLine: number
  sweep: { samples: number; touching: number } | null
  low: { samples: number; touching: number; touchingUncleared: number; inLine: number } | null
  forest: [number, number][]
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const world = (page: Page, sweepMetres = 0): Promise<WorldClearing | null> =>
  page.evaluate(
    (m) => (globalThis as unknown as Ff2Global).__ff2.lineClearing(m),
    sweepMetres,
  ) as Promise<WorldClearing | null>

/** The probe without its forest list, for the log. */
const shown = (w: WorldClearing | null): string =>
  JSON.stringify(w ? { ...w, forest: w.forest.length } : null)

const screenOf = (page: Page, p: V3): Promise<{ x: number; y: number } | null> =>
  page.evaluate(([x, y, z]) => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editorDebug()
    if (!d) throw new Error('no editor debug')
    return d.screenOf(x, y, z)
  }, p)

/** Every masked prop hidden and out of the collision world: what is drawn is what is solid. */
const expectMaskedGone = (w: WorldClearing | null, what: string): void => {
  expect(w, `${what}: a forest`).not.toBeNull()
  const c = w as WorldClearing
  expect(c.colliders, `${what}: the forest collides`).toBe(true)
  expect(c.masked, `${what}: some trees cleared`).toBeGreaterThan(0)
  expect(c.maskedDrawn, `${what}: no cleared tree drawn`).toBe(0)
  expect(c.maskedSolid, `${what}: no cleared tree solid`).toBe(0)
}

test.describe('@gpu the forest follows the line on alpine (DEV-502)', () => {
  test.setTimeout(600_000)

  test('laid, cleared, undone, redone, flown through and photographed', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })

    await openEditor(page, { mission: 'int_02_hoverJet' })
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(1_500)
    // In a little from the whole island, over its middle, so a tree is a
    // few pixels: the wheel, over the canvas, as a person turns it.
    const zoom = async (ticks: number): Promise<void> => {
      await page.mouse.move(480, 360)
      for (let i = 0; i < Math.abs(ticks); i++) {
        await page.mouse.wheel(0, ticks > 0 ? -240 : 240)
        await page.waitForTimeout(400)
      }
      await page.waitForTimeout(1_500)
    }
    await zoom(3)
    const untouched = await world(page)
    console.log(`[DEV-502] alpine before the course: ${shown(untouched)}`)
    await page.screenshot({ path: path.join(OUT, 'desk-before.png') })

    // ── a course along the island's ring of forest ──────────────────────
    // Alpine's trees stand in a band round the central massif. The course
    // follows that band for a third of its circumference, so the cut runs
    // through the trees along a curve (the radius is the band's, read off
    // the world's own scatter: the densest 100 m annulus round the middle).
    const pad = (await desk(page)).pad
    const centre = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      const t = w.__ff2.terrain()?.terrain
      if (!t) throw new Error('no terrain')
      const p = t.group.position
      return [p.x + t.params.terrainSize / 2, p.z - t.params.terrainSize / 2] as [number, number]
    })
    // The band's own middle: the forest's centroid within the island's
    // inner half (the massif it rings is not the map's centre).
    const inner = (untouched?.forest ?? []).filter(
      ([x, z]) => Math.hypot(x - centre[0], z - centre[1]) < 1500,
    )
    const mid: [number, number] = [
      inner.reduce((t, p) => t + p[0], 0) / Math.max(1, inner.length),
      inner.reduce((t, p) => t + p[1], 0) / Math.max(1, inner.length),
    ]
    centre[0] = mid[0]
    centre[1] = mid[1]
    // Along each bearing from that middle, the radius where the trees stand
    // thickest (the most within 120 m): the band, however round it is. Inside
    // 700 m of it, because the desk draws the forest as a flight does, by
    // 2016's per-chunk reveal round the eye (DEV-225), and from the desk's
    // height that reveal reaches only so far across the ground.
    const forest = untouched?.forest ?? []
    const phi0 = Math.atan2(pad[2] - centre[1], pad[0] - centre[0])
    const y = pad[1] + 150
    const onBand = (deg: number): V3 => {
      const phi = phi0 + (deg * Math.PI) / 180
      let best = 800
      let most = -1
      for (let r = 300; r <= 700; r += 25) {
        const x = centre[0] + r * Math.cos(phi)
        const z = centre[1] + r * Math.sin(phi)
        let n = 0
        for (const [fx, fz] of forest) if (Math.hypot(fx - x, fz - z) < 120) n++
        if (n > most) {
          most = n
          best = r
        }
      }
      console.log(`[DEV-502] bearing ${deg}°: the band at ${best} m (${most} trees within 120 m)`)
      return [centre[0] + best * Math.cos(phi), y, centre[1] + best * Math.sin(phi)]
    }
    const around: V3[] = [onBand(-10), onBand(25), onBand(60), onBand(95), onBand(130)]
    for (const c of around) {
      for (let tries = 0; tries < 4; tries++) {
        const before = (await desk(page)).points.length
        // Each retry a little further out from the middle.
        const out = 1 + (tries * 40) / Math.max(1, Math.hypot(c[0] - centre[0], c[2] - centre[1]))
        const at = await screenOf(page, [
          centre[0] + (c[0] - centre[0]) * out,
          c[1],
          centre[1] + (c[2] - centre[1]) * out,
        ])
        if (!at) throw new Error('a point is off the screen')
        await clickCanvasAt(page, at.x, at.y)
        // A click on a point or the pad PICKS it rather than adding one
        // (DEV-475); wait for the desk to say which before trying further out.
        const added = await expect
          .poll(async () => (await desk(page)).points.length, { timeout: 2_000 })
          .toBeGreaterThan(before)
          .then(
            () => true,
            () => false,
          )
        if (added) break
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      }
    }
    {
      const d = await desk(page)
      console.log(`[DEV-502] laid ${d.points.length} points: ${JSON.stringify(d.points)}`)
    }
    await page.keyboard.press('Escape')
    // LIFT is one undo step when it presses; the undo below has to reach
    // past it to the last point, since a lift moves the line UP and a
    // clearing is unbounded in y.
    const lifted = await liftToFlyable(page, 'a course round the alpine pad')
    const steps = lifted ? 2 : 1
    const laid = await desk(page)
    expect(laid.valid, 'the course is valid').toBe(true)

    // ── settled: the line is cleared on the world as drawn ───────────────
    await expect
      .poll(async () => (await desk(page)).lineClearing?.level, { timeout: 10_000 })
      .toBe(laid.courseId)
    const afterLay = await world(page)
    expectMaskedGone(afterLay, 'the course laid')
    const r1 = (await desk(page)).lineClearing as Receipt
    console.log(
      `[DEV-502] laid: ${r1.masked} of ${r1.scatter} scatter props masked by ${r1.clearings} ` +
        `capsules, the last mask ${r1.ms.toFixed(2)} ms (hid ${r1.hidden}, showed ${r1.shown})`,
    )
    // DEV-503's cost on the densest island: the draft judged with the world's
    // props and without, the median of 21, in the page.
    const cost = (await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      return w.__ff2.editorDebug()?.evaluateCost(21) ?? null
    })) as { withProps: number; withoutProps: number; props: boolean } | null
    console.log(
      `[DEV-503] alpine: judging the draft costs ${cost?.withProps.toFixed(2)} ms with the ` +
        `props, ${cost?.withoutProps.toFixed(2)} ms without (median of 21)`,
    )
    expect(cost?.props, 'alpine judges against its forest').toBe(true)
    await page.waitForTimeout(1_000)
    await page.screenshot({ path: path.join(OUT, 'desk-after.png') })

    // ── an undo shortens the line: its stretch's trees come back ─────────
    // The panel's own Undo, as a person presses it (past the LIFT, above).
    const beforeUndo = (await desk(page)).courseId
    for (let i = 0; i < steps; i++) await page.locator('[data-editor="undo"]').click()
    await expect
      .poll(async () => (await desk(page)).courseId, { timeout: 10_000 })
      .not.toBe(beforeUndo)
    await expect
      .poll(async () => (await desk(page)).lineClearing?.level, { timeout: 10_000 })
      .toBe((await desk(page)).courseId)
    const undone = (await desk(page)).lineClearing as Receipt
    console.log(
      `[DEV-502] undo: showed ${undone.shown}, hid ${undone.hidden}, ` +
        `${undone.masked} masked, ${undone.ms.toFixed(2)} ms`,
    )
    expect(undone.shown, 'the undo gave trees back').toBeGreaterThan(0)
    expectMaskedGone(await world(page), 'after the undo')
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, 'desk-after-undo.png') })

    for (let i = 0; i < steps; i++) await page.locator('[data-editor="redo"]').click()
    await expect.poll(async () => (await desk(page)).courseId, { timeout: 10_000 }).toBe(beforeUndo)
    await expect
      .poll(async () => (await desk(page)).lineClearing?.level, { timeout: 10_000 })
      .toBe(beforeUndo)
    const redone = (await desk(page)).lineClearing as Receipt
    console.log(
      `[DEV-502] redo: hid ${redone.hidden}, showed ${redone.shown}, ` +
        `${redone.masked} masked, ${redone.ms.toFixed(2)} ms`,
    )
    // The redo's steps are the point, then the lift (which moves the line's
    // plan by a hair, as its 3D arc re-samples): judge the forest they leave.
    expect(redone.masked, 'the redo took them again').toBeGreaterThan(undone.masked)
    expect(redone.masked, 'the same forest as before the undo').toBe(r1.masked)

    // ── close: the cut through the band, then the same ground with no line ─
    // Pick the point the line enters the band by (a click on its handle picks
    // it) and frame it (F, DEV-472), out a notch; then Undo back to the draft
    // of one point — no line, so every tree comes back — and photograph the
    // same view; then Redo it all.
    const band = (await desk(page)).points[1] as V3
    const handle = await screenOf(page, band)
    if (!handle) throw new Error('point 2 is off the screen')
    await clickCanvasAt(page, handle.x, handle.y)
    await expect.poll(async () => (await desk(page)).selection, { timeout: 5_000 }).toBe(1)
    await page.keyboard.press('f')
    await page.waitForTimeout(1_000)
    await zoom(-1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, 'desk-after-close.png') })
    const depth = (await desk(page)).undoDepth
    for (let i = 0; i < depth; i++) await page.locator('[data-editor="undo"]').click()
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(1)
    await expect
      .poll(async () => (await desk(page)).lineClearing?.level, { timeout: 10_000 })
      .toBe('(no line)')
    const bare = (await desk(page)).lineClearing as Receipt
    console.log(
      `[DEV-502] no line: showed ${bare.shown}, ${bare.masked} masked, ${bare.ms.toFixed(2)} ms`,
    )
    expect(bare.masked, 'no line, no clearing').toBe(0)
    // Each undo gave some back (the line shortened a point at a time): the
    // last step, the rest.
    expect(bare.shown, 'the last trees back').toBeGreaterThan(0)
    expect((await world(page))?.masked).toBe(0)
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, 'desk-before-close.png') })
    for (let i = 0; i < depth; i++) await page.locator('[data-editor="redo"]').click()
    await expect.poll(async () => (await desk(page)).courseId, { timeout: 10_000 }).toBe(beforeUndo)
    await expect
      .poll(async () => (await desk(page)).lineClearing?.masked, { timeout: 10_000 })
      .toBe(r1.masked)

    // ── FLY: the course's own world, cleared the same way, swept ─────────
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    const flown = await world(page, 5)
    console.log(`[DEV-502] the flight's world: ${shown(flown)}`)
    expectMaskedGone(flown, 'the flight')
    expect(flown?.receipt?.level, 'cleared for the course flown').toBe(beforeUndo)
    // At least what the desk masked: the desk's world is the SKY's, whose own volumes
    // took some of the same ground out at load (alpine's launch corridor).
    expect(flown?.masked ?? 0, 'the flight clears what the desk cleared').toBeGreaterThanOrEqual(
      r1.masked,
    )
    expect(flown?.sweep?.samples ?? 0, 'the hull swept the line').toBeGreaterThan(100)
    expect(flown?.sweep?.touching, 'and touched no prop').toBe(0)
    // Nap of the earth over the line's plan, at the hover height: where the
    // trees are. The SEPARATING sample: with the masked colliders put back
    // the hull meets trees, and with the clearing it meets none.
    const low = flown?.low
    expect(low?.inLine ?? 0, 'trees stood in the line at hover height').toBeGreaterThan(0)
    expect(low?.touchingUncleared ?? 0, 'uncleared, the low sweep hits trees').toBeGreaterThan(0)
    expect(low?.touching, 'cleared, it hits none').toBe(0)

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
