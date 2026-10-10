/**
 * A line routed through a desert spire, and the editor saying so. DEV-503
 * (docs/plan/EDITOR-PROPS.md).
 *
 * Matt, 2026-09-28: *"a prop warning"*. In by `?edit=1&mission=adv_01_hoverJet`
 * — the desert canyon, whose sixteen spires collide (DEV-213's hulls) — a
 * course laid with real clicks (`fixtures/canvas.ts`) straight through the
 * spire nearest the pad. What it holds:
 *
 *  · the desk judges the line against the world's LIVE colliders: a
 *    `line-through-prop` warning, its marker on THAT spire, and its stretch
 *    drawn red where the line is (read back off the drawn buffer);
 *  · the panel lists it, in words that name the spire;
 *  · moving the line off the spire (Undo back past it) takes the warning away.
 *
 * It prints what judging the props costs per change (`[DEV-503]`), with and
 * without them. Photos go to `EDITOR_PHOTO_DIR` (default
 * `test-results/editor-prop-warning`). Tagged `@gpu`, tier pinned (`PINNED`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { clickCanvasAt } from './fixtures/canvas'
import { collectPageErrors, openEditor } from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-prop-warning')

type V3 = [number, number, number]

interface PropWarning {
  kind: string
  severity: string
  message: string
  ring: number | null
  props: V3[]
}

interface DeskProbe {
  points: V3[]
  groundReady: boolean
  selection: number | null
  pad: V3
  warnings: string[]
  propWarnings: PropWarning[]
  evaluateMs: number
  undoDepth: number
  landmarks: { at: V3; top: number; radius: number; kind: string }[]
  props: { kind: string; pos: V3 }[]
  propPlacing: string | null
  propsDrawn: number
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

interface Debug {
  screenOf(x: number, y: number, z: number): { x: number; y: number } | null
  groundMarks(): { propLine: V3[][]; propRings: V3[][] }
  evaluateCost(runs: number): { withProps: number; withoutProps: number; props: boolean }
}

const debug = <T>(page: Page, f: string, args: unknown[] = []): Promise<T> =>
  page.evaluate(
    ([name, a]) => {
      const w = globalThis as unknown as Ff2Global
      const d = w.__ff2.editorDebug() as unknown as Record<string, unknown> | null
      if (!d) throw new Error('no editor debug')
      return (d[name as string] as (...x: unknown[]) => unknown)(...(a as unknown[]))
    },
    [f, args] as const,
  ) as Promise<T>

const screenOf = (page: Page, p: V3) =>
  debug<ReturnType<Debug['screenOf']>>(page, 'screenOf', [p[0], p[1], p[2]])

test.describe('@gpu a line through a desert spire (DEV-503)', () => {
  test.setTimeout(420_000)

  test('warned, marked, drawn, listed, costed and photographed', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })

    await openEditor(page, { mission: 'adv_01_hoverJet' })
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(1_500)

    // ── the spire nearest the pad, and a line straight through it ────────
    const d0 = await desk(page)
    expect(d0.landmarks.length, 'the canyon has spires to hit').toBeGreaterThan(0)
    const pad = d0.pad
    // A spire standing on the ground it rises from (not on a mesa's top,
    // where a line at the new-point height would run through the mesa
    // instead): its base within 10 m of the render surface under it. The
    // nearest such to the pad.
    const grounded: DeskProbe['landmarks'] = []
    for (const l of d0.landmarks) {
      const g = await debug<number>(page, 'groundAt', [l.at[0], l.at[2]])
      console.log(
        `[DEV-503] ${l.kind} at ${l.at.map((v) => v.toFixed(0))}: base ${l.at[1].toFixed(0)}, top ${l.top.toFixed(0)}, ground ${g.toFixed(0)}`,
      )
      if (l.at[1] <= g + 10 && l.top > g + 60) grounded.push(l)
    }
    expect(grounded.length, 'a spire on the ground').toBeGreaterThan(0)
    // A bearing across one whose two ends stand on ground low enough that a
    // point at the new-point height (27 m over it) is under the spire's top
    // and over its base: the line between them runs through the rock, not
    // over it (the canyon's mesas stand higher than some spires). Nearest
    // the pad first.
    const byPad = [...grounded].sort(
      (a, b) =>
        Math.hypot(a.at[0] - pad[0], a.at[2] - pad[2]) -
        Math.hypot(b.at[0] - pad[0], b.at[2] - pad[2]),
    )
    let pick: { l: DeskProbe['landmarks'][number]; ux: number; uz: number; out: number } | null =
      null
    for (const l of byPad) {
      const out = l.radius * 0.5 + 150
      for (let deg = 0; deg < 180 && !pick; deg += 15) {
        const cx = Math.cos((deg * Math.PI) / 180)
        const cz = Math.sin((deg * Math.PI) / 180)
        const g1 = await debug<number>(page, 'groundAt', [l.at[0] - cx * out, l.at[2] - cz * out])
        const g2 = await debug<number>(page, 'groundAt', [l.at[0] + cx * out, l.at[2] + cz * out])
        if (Math.max(g1, g2) + 27 < l.top - 40 && Math.min(g1, g2) + 27 > l.at[1] + 10) {
          pick = { l, ux: cx, uz: cz, out }
        }
      }
      if (pick) break
    }
    if (!pick) throw new Error('no spire with low ground either side')
    const { l: spire, ux, uz, out: reachOut } = pick
    console.log(`[DEV-503] the spire: ${JSON.stringify(spire)} (the pad at ${JSON.stringify(pad)})`)
    const targets: V3[] = [
      [spire.at[0] - ux * reachOut, spire.at[1], spire.at[2] - uz * reachOut],
      [spire.at[0] + ux * reachOut, spire.at[1], spire.at[2] + uz * reachOut],
    ]
    for (const c of targets) {
      for (let tries = 0; tries < 4; tries++) {
        const before = (await desk(page)).points.length
        const out = tries * 60
        const at = await screenOf(page, [c[0] + uz * out, c[1], c[2] - ux * out])
        if (!at) throw new Error('a point is off the screen')
        await clickCanvasAt(page, at.x, at.y)
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
    await page.keyboard.press('Escape')

    // ── the warning, on that spire, drawn and listed ─────────────────────
    await page.waitForTimeout(1_000)
    {
      const d = await desk(page)
      console.log(
        `[DEV-503] after the clicks: ${JSON.stringify(d.warnings)} over ${JSON.stringify(d.points)}`,
      )
      const near = await debug<unknown>(page, 'propsNear', [d.points[1], d.points[2], 10])
      console.log(`[DEV-503] props near points 2-3: ${JSON.stringify(near)}`)
    }
    await expect
      .poll(async () => (await desk(page)).warnings, { timeout: 10_000 })
      .toContain('line-through-prop')
    const d1 = await desk(page)
    const through = d1.propWarnings.filter((w) => w.kind === 'line-through-prop')
    console.log(`[DEV-503] the warnings: ${JSON.stringify(d1.propWarnings)}`)
    expect(through.length).toBeGreaterThan(0)
    const onSpire = through.some((w) =>
      w.props.some((p) => Math.hypot(p[0] - spire.at[0], p[2] - spire.at[2]) < 1),
    )
    expect(onSpire, 'a marker on the spire the line runs through').toBe(true)
    expect(through.map((w) => w.message).join(' ')).toMatch(/spire/i)
    const marks = await debug<ReturnType<Debug['groundMarks']>>(page, 'groundMarks')
    expect(marks.propLine.length, 'the stretch is drawn').toBeGreaterThan(0)
    await expect(page.locator('[data-editor="warnings"]')).toContainText(/spire/i)

    // ── what it costs, per change, on this island ────────────────────────
    const cost = await debug<ReturnType<Debug['evaluateCost']>>(page, 'evaluateCost', [21])
    console.log(
      `[DEV-503] desert: judging the draft costs ${cost.withProps.toFixed(2)} ms with the props, ` +
        `${cost.withoutProps.toFixed(2)} ms without (median of 21; the desk's last ` +
        `${d1.evaluateMs.toFixed(2)} ms)`,
    )
    expect(cost.props).toBe(true)

    // ── photos: the island, then framed on the spire ─────────────────────
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, 'desk-line-through-spire.png') })
    const handle = await screenOf(page, d1.points[1] as V3)
    if (!handle) throw new Error('point 2 is off the screen')
    await clickCanvasAt(page, handle.x, handle.y)
    await expect.poll(async () => (await desk(page)).selection, { timeout: 5_000 }).toBe(1)
    await page.keyboard.press('f')
    await page.waitForTimeout(800)
    await page.mouse.move(480, 360)
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 240)
      await page.waitForTimeout(400)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: path.join(OUT, 'desk-line-through-spire-close.png') })

    // ── off the spire: back to the draft before the line, no warning ─────
    const depth = (await desk(page)).undoDepth
    for (let i = 0; i < depth; i++) await page.locator('[data-editor="undo"]').click()
    await expect
      .poll(async () => (await desk(page)).warnings, { timeout: 10_000 })
      .not.toContain('line-through-prop')

    // ── DEV-504: a PLACED spire in a clear line fires it too ─────────────
    // A straight from ring 1 (the pad's anchored point) on a bearing whose
    // line meets no prop, then a spire placed from the Props library on its
    // middle: the draft's own placed prop, judged as the flight will build it.
    const anchor = (await desk(page)).points[0] as V3
    // The whole island again, from above, so the new line is on the screen.
    await page.locator('[data-editor="frame"]').click()
    await page.waitForTimeout(1_500)
    let clear: V3 | null = null
    for (let deg = 0; deg < 360 && !clear; deg += 30) {
      const x = anchor[0] + 450 * Math.cos((deg * Math.PI) / 180)
      const z = anchor[2] + 450 * Math.sin((deg * Math.PI) / 180)
      const g = await debug<number>(page, 'groundAt', [x, z])
      const s = await screenOf(page, [x, g, z])
      if (!s || s.x < 20 || s.x > 940 || s.y < 20 || s.y > 700) continue
      const near = await debug<unknown[] | null>(page, 'propsNear', [anchor, [x, g + 27, z], 12])
      console.log(`[DEV-503] bearing ${deg}: ${near?.length ?? 'no props'} props near`)
      if (near && near.length === 0) clear = [x, g, z]
    }
    if (!clear) throw new Error('no clear bearing from ring 1')
    // As a person does: Escape any pick, click; a click that picks instead
    // of adding (DEV-475) tries a little further out.
    for (let tries = 0; tries < 4 && (await desk(page)).points.length < 2; tries++) {
      await page.keyboard.press('Escape')
      const f = 1 + tries * 0.15
      const at: V3 = [
        anchor[0] + (clear[0] - anchor[0]) * f,
        clear[1],
        anchor[2] + (clear[2] - anchor[2]) * f,
      ]
      const s2 = await screenOf(page, at)
      if (!s2) throw new Error('point 2 is off the screen')
      await clickCanvasAt(page, s2.x, s2.y)
      await expect
        .poll(async () => (await desk(page)).points.length, { timeout: 2_000 })
        .toBe(2)
        .catch(() => {})
    }
    expect((await desk(page)).points.length, 'point 2 added').toBe(2)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    const lineOnly = (await desk(page)).warnings
    console.log(`[DEV-503] the clear line: ${JSON.stringify(lineOnly)}`)
    expect(lineOnly, 'the new line meets no prop').not.toContain('line-through-prop')
    const p2 = (await desk(page)).points[1] as V3
    const mid: [number, number] = [(anchor[0] + p2[0]) / 2, (anchor[2] + p2[2]) / 2]
    await page.locator('[data-editor="props"]').click()
    await page.locator('[data-editor="prop-kind"][data-kind="spire-b"]').click()
    await expect.poll(async () => (await desk(page)).propPlacing).toBe('spire-b')
    const gm = await debug<number>(page, 'groundAt', [mid[0], mid[1]])
    const sm = await screenOf(page, [mid[0], gm, mid[1]])
    if (!sm) throw new Error('the middle of the line is off the screen')
    await clickCanvasAt(page, sm.x, sm.y)
    await expect.poll(async () => (await desk(page)).props.length, { timeout: 5_000 }).toBe(1)
    await page.locator('[data-editor="prop-stop"]').click()
    await expect.poll(async () => (await desk(page)).propsDrawn, { timeout: 60_000 }).toBe(1)
    // Judged once its mesh is in (the desk re-judges when a placed prop's
    // mesh arrives, `DeskProps.pending`).
    await expect
      .poll(async () => (await desk(page)).warnings, { timeout: 15_000 })
      .toContain('line-through-prop')
    const placedWarn = (await desk(page)).propWarnings.filter((w) => w.kind === 'line-through-prop')
    console.log(`[DEV-503] on the placed spire: ${JSON.stringify(placedWarn)}`)
    const pos = (await desk(page)).props[0]?.pos as V3
    expect(
      placedWarn.some((w) => w.props.some((p) => Math.hypot(p[0] - pos[0], p[2] - pos[2]) < 150)),
      'a marker on the placed spire',
    ).toBe(true)
    // Framed on point 2 (F), out two notches: the spire, the line, the mark.
    const h2 = await screenOf(page, (await desk(page)).points[1] as V3)
    if (h2) {
      await clickCanvasAt(page, h2.x, h2.y)
      await page.keyboard.press('f')
      await page.waitForTimeout(800)
      await page.mouse.move(480, 360)
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, 240)
        await page.waitForTimeout(400)
      }
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: path.join(OUT, 'desk-line-through-placed-spire.png') })

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
