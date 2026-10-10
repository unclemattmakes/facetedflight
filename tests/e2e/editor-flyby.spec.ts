/**
 * The editor's fly-by, end to end. DEV-474
 * (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
 *
 * Matt: *"it'd be awesome of a ship could be sent along the spline every 4
 * seconds or so. to help visualize the race path"*.
 *
 * The creator's own path, nothing stubbed: the title's COURSES → MAKE A
 * COURSE, four clicks on the ground through `fixtures/canvas.ts`, and then:
 *
 *  · ships exist, stand ON the drawn line, and move ALONG it between two
 *    reads — the geometry, read off the scene graph (`__ff2.stage()`), not off
 *    the fly-by's own bookkeeping;
 *  · they are big enough to see from where the editor frames the island (a
 *    two-pixel ship has been rendered, not seen: CLAUDE.md, DEV-044);
 *  · the count stays bounded over 30 s;
 *  · they are gone while the course is flown, and fly again on the way back.
 *
 * Photographs go to `FLYBY_PHOTO_DIR` (default `test-results/editor-flyby`),
 * on a pinned tier (`PINNED`, DEV-245). Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt } from './fixtures/canvas'
import {
  collectPageErrors,
  editorHold as hold,
  openEditorFromTitle,
  waitForEditor,
} from './fixtures/editor-boot'
import { liftToFlyable } from './fixtures/editor-course'
import { photographer } from './fixtures/photo'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.FLYBY_PHOTO_DIR ?? path.join('test-results', 'editor-flyby')
/** 2016's own racing line on int_01 (THREE space): four places on it to click, as `editor-desk.spec.ts` does. */
const INT01_ROUTE = (
  JSON.parse(fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8')) as {
    route: [number, number, number][]
  }
).route
// DEV-501: from route[34], past ring 1 (anchored one gap, 497 m, ahead of the
// pad): route[20] (393 m) is BEHIND it, and a line clicked back behind its own
// first ring doubles over itself, where no dart can say which way it points.
// (route[30] is over the sea: a click there places nothing.)
const ROUTE_PICKS = [34, 60, 100, 140] as const

type V3 = [number, number, number]

interface FlybyState {
  launchSeconds: number
  spacingSeconds: number
  speed: number
  maxShips: number
  length: number
  inFlight: number
  /** DEV-487: how many are drawn as the hull, and how many as the dart. */
  hulls: number
  arrows: number
}
interface FlybyRead {
  /** Is the fly-by group in the scene and visible all the way up? */
  shown: boolean
  state: FlybyState | null
  /**
   * Every ship drawn: its world position, its on-screen length (CSS px) of
   * what is DRAWN (the hull's visible meshes, or its dart), and what it is
   * drawn as. For a dart, its two ends, world space, found from the dart's
   * own vertices by which end tapers (no axis assumed): DEV-487.
   */
  ships: { at: V3; pixels: number; lod: string; point: V3 | null; tail: V3 | null }[]
  /** DEV-487: the dart mesh's instance count. */
  arrowInstances: number
}

interface DeskProbe {
  points: V3[]
  valid: boolean
  rings: number | null
  drawnRings: number
  groundReady: boolean
  placeHeight: number
  warnings: string[]
  selection: number | null
}

const desk = async (page: Page): Promise<DeskProbe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as { __ff2: { editor(): { desk: unknown } } }
    return w.__ff2.editor().desk
  })) as DeskProbe

/** The fly-by as the SCENE has it: the group, its ships' world positions and screen sizes. */
const flyby = (page: Page): Promise<FlybyRead> =>
  page.evaluate(() => {
    type O = {
      name: string
      visible: boolean
      parent: O | null
      children: O[]
      userData: Record<string, unknown>
      isMesh?: boolean
      geometry?: {
        boundingBox: { min: P; max: P } | null
        computeBoundingBox(): void
      }
      matrixWorld: unknown
      getObjectByName(n: string): O | undefined
      getWorldPosition(v: P): P
      traverse(f: (o: O) => void): void
      updateWorldMatrix(p: boolean, c: boolean): void
    }
    type P = {
      x: number
      y: number
      z: number
      set(x: number, y: number, z: number): P
      applyMatrix4(m: unknown): P
      clone(): P
    }
    const w = globalThis as unknown as {
      __ff2: {
        stage(): O
        editorDebug(): {
          screenOf(x: number, y: number, z: number): { x: number; y: number } | null
        }
      }
    }
    type M = { clone(): M; premultiply(m: M): M }
    type Arrows = O & {
      count: number
      matrixWorld: M
      geometry: NonNullable<O['geometry']> & {
        attributes: {
          position: {
            count: number
            getX(i: number): number
            getY(i: number): number
            getZ(i: number): number
          }
        }
      }
      getMatrixAt(i: number, m: M): void
    }
    const scene = w.__ff2.stage()
    const group = scene.getObjectByName('editor-flyby')
    if (!group) return { shown: false, state: null, ships: [], arrowInstances: 0 }
    let shown = true
    for (let o: O | null = group; o; o = o.parent) if (!o.visible) shown = false
    const debug = w.__ff2.editorDebug()
    group.updateWorldMatrix(true, true)
    const arrows = group.getObjectByName('editor-flyby-arrows') as Arrows | undefined
    const arrowInstances = arrows?.visible ? arrows.count : 0
    type Box = { min: P; max: P }
    const screenBox = (box: Box, matrix: unknown) => {
      let lo = { x: Infinity, y: Infinity }
      let hi = { x: -Infinity, y: -Infinity }
      const v = box.min.clone()
      for (let i = 0; i < 8; i++) {
        v.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        v.applyMatrix4(matrix)
        const s = debug.screenOf(v.x, v.y, v.z)
        if (!s) continue
        lo = { x: Math.min(lo.x, s.x), y: Math.min(lo.y, s.y) }
        hi = { x: Math.max(hi.x, s.x), y: Math.max(hi.y, s.y) }
      }
      return Number.isFinite(lo.x) ? Math.hypot(hi.x - lo.x, hi.y - lo.y) : 0
    }
    /** The dart's two ends in its own frame, the POINT being the end that tapers in plan. */
    const dartEnds = (() => {
      if (!arrows) return null
      const pos = arrows.geometry.attributes.position
      const vs: [number, number, number][] = []
      for (let i = 0; i < pos.count; i++) vs.push([pos.getX(i), pos.getY(i), pos.getZ(i)])
      const ext = (k: 0 | 2) => {
        const xs = vs.map((v) => v[k])
        return { lo: Math.min(...xs), hi: Math.max(...xs) }
      }
      const ex = ext(0)
      const ez = ext(2)
      const axis: 0 | 2 = ex.hi - ex.lo >= ez.hi - ez.lo ? 0 : 2
      const cross: 0 | 2 = axis === 0 ? 2 : 0
      const e = axis === 0 ? ex : ez
      const band = (e.hi - e.lo) * 0.15
      const at = (near: (v: [number, number, number]) => boolean) => {
        const pick = vs.filter(near)
        const xs = pick.map((v) => v[cross])
        const mean = (k: 0 | 1 | 2) => pick.reduce((s, v) => s + v[k], 0) / pick.length
        const centre: [number, number, number] = [mean(0), mean(1), mean(2)]
        return { width: Math.max(...xs) - Math.min(...xs), mean: centre }
      }
      const a = at((v) => v[axis] < e.lo + band)
      const b = at((v) => v[axis] > e.hi - band)
      return a.width < b.width ? { point: a.mean, tail: b.mean } : { point: b.mean, tail: a.mean }
    })()
    const ships: FlybyRead['ships'] = []
    let k = 0
    for (const ship of group.children) {
      if (!ship.visible || !ship.name.startsWith('editor-flyby-ship:')) continue
      const lod = String(ship.userData.lod ?? '')
      let scratch: P | null = null
      let pixels = 0
      let point: [number, number, number] | null = null
      let tail: [number, number, number] | null = null
      if (lod === 'arrow' && arrows && dartEnds) {
        // What is DRAWN: the dart mesh's k-th instance matrix (they are packed
        // in the ships' order), not the ship's own transform.
        const m = arrows.matrixWorld.clone()
        arrows.getMatrixAt(k++, m)
        m.premultiply(arrows.matrixWorld)
        arrows.geometry.computeBoundingBox()
        const box = arrows.geometry.boundingBox
        if (box) pixels = screenBox(box, m)
        scratch = box ? box.min.clone() : null
        if (scratch) {
          const p = scratch.set(...dartEnds.point).applyMatrix4(m)
          point = [p.x, p.y, p.z]
          const t = scratch.set(...dartEnds.tail).applyMatrix4(m)
          tail = [t.x, t.y, t.z]
        }
      } else {
        ship.traverse((node) => {
          if (!node.isMesh || !node.geometry) return
          // Only what is drawn: a hull hidden under its dart is not measured.
          for (let o: O | null = node; o && o !== group; o = o.parent) if (!o.visible) return
          node.geometry.computeBoundingBox()
          const box = node.geometry.boundingBox
          if (!box) return
          scratch ??= box.min.clone()
          pixels = Math.max(pixels, screenBox(box, node.matrixWorld))
        })
      }
      if (!scratch) continue
      const p = ship.getWorldPosition(scratch)
      ships.push({ at: [p.x, p.y, p.z], pixels, lod, point, tail })
    }
    return { shown, state: (group.userData.flyby as FlybyState) ?? null, ships, arrowInstances }
  }) as Promise<FlybyRead>

/**
 * The line the fly-by flies: the drawn line's samples and, since DEV-475, the
 * run-in before them, from the ship on its start pad (the expanded level's
 * spawn, the racing line's first point) to the line's first point.
 */
const lineOf = async (page: Page): Promise<V3[]> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        editorDebug(): { lineSamples(): unknown[] }
        editor(): { desk: { spawn: unknown } | null }
      }
    }
    const spawn = w.__ff2.editor().desk?.spawn
    const line = w.__ff2.editorDebug().lineSamples()
    return spawn ? [spawn, ...line] : line
  })) as V3[]

const nearestOnLine = (line: readonly V3[], p: V3): { arc: number; distance: number } => {
  let best = { arc: 0, distance: Number.POSITIVE_INFINITY }
  let arc = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as V3
    const b = line[i] as V3
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
    const len = Math.sqrt(len2)
    const u =
      len2 > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2,
            ),
          )
        : 0
    const d = Math.hypot(a[0] + ab[0] * u - p[0], a[1] + ab[1] * u - p[1], a[2] + ab[2] * u - p[2])
    if (d < best.distance) best = { arc: arc + u * len, distance: d }
    arc += len
  }
  return best
}

const takePhoto = photographer(OUT)
const photo = async (page: Page, name: string): Promise<void> => {
  await takePhoto(page, `${name}.png`)
}

/** A 200 × 140 crop round each of the first `n` ships, at native pixels. */
const cropShips = async (
  page: Page,
  name: string,
  ships: readonly { at: V3 }[],
  n = 3,
): Promise<void> => {
  const view = page.viewportSize() ?? { width: 1280, height: 720 }
  fs.mkdirSync(OUT, { recursive: true })
  for (const [k, ship] of ships.slice(0, n).entries()) {
    const at = (await page.evaluate(([x, y, z]) => {
      const w = globalThis as unknown as {
        __ff2: { editorDebug(): { screenOf(x: number, y: number, z: number): unknown } }
      }
      return w.__ff2.editorDebug().screenOf(x, y, z)
    }, ship.at)) as { x: number; y: number } | null
    if (!at) continue
    const clip = {
      x: Math.max(0, Math.min(view.width - 200, at.x - 100)),
      y: Math.max(0, Math.min(view.height - 140, at.y - 70)),
      width: 200,
      height: 140,
    }
    await page.screenshot({ path: path.join(OUT, `${name}-${k}.png`), clip })
  }
}

test.describe('@gpu the editor fly-by (DEV-474)', () => {
  test.setTimeout(600_000)

  test('ships fly the race line every few seconds, bounded, and stand down while it is flown', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)

    // ── in by the title's door, and four points on the ground ────────────
    await openEditorFromTitle(page)
    expect((await desk(page)).points.length).toBe(1) // DEV-501: the pad's point

    await page.locator('[data-editor="top-down"]').click()
    await page.locator('[data-editor="height"]').fill('150')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).placeHeight).toBe(150)
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    for (const i of ROUTE_PICKS) {
      const [wx, wy, wz] = INT01_ROUTE[i] as V3
      const at = (await page.evaluate(
        ([x, y, z]) => {
          const w = globalThis as unknown as {
            __ff2: { editorDebug(): { screenOf(x: number, y: number, z: number): unknown } | null }
          }
          return w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null
        },
        [wx, wy, wz] as V3,
      )) as { x: number; y: number }
      expect(at.x > 0 && at.x < view.width - 320 && at.y > 0 && at.y < view.height).toBe(true)
      await clickCanvasAt(page, at.x, at.y)
      await page.waitForTimeout(150)
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5) // DEV-501: the pad's, and four
    // DEV-478: the ships fly the author's line exactly, as the racers do: lift
    // it clear of the hill the four points sag through, pressed.
    await liftToFlyable(page, 'four points 150 m over int_01')
    const made = await desk(page)
    expect(made.valid, `the course validates (warnings: ${made.warnings})`).toBe(true)

    // The expanded level (and with it the route) arrives with the rings.
    await expect
      .poll(async () => (await desk(page)).drawnRings, { timeout: 30_000 })
      .toBe(made.rings)

    // ── ships exist, on the line ─────────────────────────────────────────
    await expect
      .poll(async () => (await flyby(page)).ships.length, { timeout: 60_000 })
      .toBeGreaterThan(0)
    const first = await flyby(page)
    const state = first.state as FlybyState
    expect(state.inFlight).toBe(first.ships.length)
    expect(state.launchSeconds).toBe(4)
    expect(state.length).toBeGreaterThan(500)
    console.log(
      `[DEV-474] line ${state.length.toFixed(0)} m at ${state.speed.toFixed(1)} m/s: ` +
        `${(state.length / state.speed).toFixed(1)} s end to end, a ship every ${state.spacingSeconds.toFixed(1)} s`,
    )
    await page.waitForTimeout(state.launchSeconds * 1000 * 2)
    await photo(page, 'flyby-top-down')
    await cropShips(page, 'flyby-dart-top-down', (await flyby(page)).ships)

    // ── they move ALONG the line between two reads ──────────────────────
    const line = await lineOf(page)
    const a = await flyby(page)
    await page.waitForTimeout(500)
    const b = await flyby(page)
    expect(a.ships.length).toBeGreaterThan(0)
    for (const ship of [...a.ships, ...b.ships]) {
      // The centre of a ship stands on the line (the art hangs round it, and the
      // drawn line is the same curve the route is sampled from).
      expect(nearestOnLine(line, ship.at).distance, 'a ship stands on the line').toBeLessThan(3)
    }
    const arcsA = a.ships.map((s) => nearestOnLine(line, s.at).arc)
    const arcsB = b.ships.map((s) => nearestOnLine(line, s.at).arc)
    let moved = 0
    for (const s of arcsA) {
      // Half a second at cruise is ~45 m: some ship is that much further on.
      if (arcsB.some((t) => t - s > 10 && t - s < 120)) moved++
    }
    expect(moved, `ships moved forward (${arcsA} → ${arcsB})`).toBeGreaterThanOrEqual(
      Math.max(1, arcsA.length - 1),
    )

    // ── visible from where the editor frames the island ─────────────────
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(1_500)
    await photo(page, 'flyby-oblique')
    const seen = await flyby(page)
    const px = seen.ships.map((s) => s.pixels)
    console.log(`[DEV-474] ship sizes on screen, px: ${px.map((p) => p.toFixed(0)).join(' ')}`)
    expect(Math.min(...px), 'every ship is big enough to see').toBeGreaterThan(12)

    // ── DEV-487: from the framing, every ship is a dart pointing ALONG the line ──
    // The geometry, not the rotation: each drawn dart's tapering end (found
    // from its own vertices through the mesh's own instance matrix) lies
    // further along the line than its tail.
    expect(
      seen.ships.map((s) => s.lod),
      'every ship is small from the framing, so every one is a dart',
    ).toEqual(seen.ships.map(() => 'arrow'))
    expect(seen.arrowInstances, 'one instance per dart, in ONE mesh').toBe(seen.ships.length)
    expect(seen.state?.hulls).toBe(0)
    for (const ship of seen.ships) {
      expect(ship.point && ship.tail, 'a dart has two ends').toBeTruthy()
      const ahead = nearestOnLine(line, ship.point as V3).arc
      const behind = nearestOnLine(line, ship.tail as V3).arc
      expect(ahead, 'the dart points the way it flies').toBeGreaterThan(behind)
    }

    // ── bounded over 30 s ────────────────────────────────────────────────
    let most = 0
    let least = Number.POSITIVE_INFINITY
    for (let t = 0; t < 30_000; t += 500) {
      const n = (await flyby(page)).ships.length
      most = Math.max(most, n)
      least = Math.min(least, n)
      await page.waitForTimeout(500)
    }
    console.log(`[DEV-474] in flight over 30 s: ${least} to ${most}`)
    expect(most).toBeLessThanOrEqual(state.maxShips)
    expect(most, 'several in flight at once').toBeGreaterThanOrEqual(3)
    // A closer look: a little zoom, and a crop round the ships at native pixels.
    const box = await page.locator('#viewport').boundingBox()
    if (box) {
      await page.mouse.move(box.x + (box.width - 320) / 2, box.y + box.height / 2)
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, -200)
        await page.waitForTimeout(120)
      }
      await page.waitForTimeout(1_500)
      await photo(page, 'flyby-closer')
      await cropShips(page, 'flyby-ship', (await flyby(page)).ships)
    }

    // ── DEV-487: up close, the hull ──────────────────────────────────────
    // As a person gets there: pick the second point by its handle, F to frame
    // it, Escape to put the gizmo away, and the wheel in over it. The line
    // runs through that point, so every ship passes within the orbit's
    // distance of the eye, and one close enough is drawn as its hull.
    const second = (await desk(page)).points[1] as V3
    const screenOfPoint = async (p: V3) =>
      (await page.evaluate(([x, y, z]) => {
        const w = globalThis as unknown as {
          __ff2: { editorDebug(): { screenOf(x: number, y: number, z: number): unknown } }
        }
        return w.__ff2.editorDebug().screenOf(x, y, z)
      }, p)) as { x: number; y: number } | null
    const handle = await screenOfPoint(second)
    expect(handle, 'the second point is on screen').not.toBeNull()
    await clickCanvasAt(page, (handle as { x: number }).x, (handle as { y: number }).y)
    await expect.poll(async () => (await desk(page)).selection).toBe(1)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('f')
    await page.waitForTimeout(1_500)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await desk(page)).selection).toBeNull()
    const framed = (await screenOfPoint(second)) as { x: number; y: number }
    await page.mouse.move(framed.x, framed.y)
    for (let i = 0; i < 24; i++) {
      await page.mouse.wheel(0, -200)
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(1_000)
    // A ship at cruise crosses this view in about a second, so the photograph
    // is taken the moment a hull is IN the frame, not after a poll that only
    // knew one existed (the first run photographed empty ground).
    let close: FlybyRead | null = null
    const inFrame = async (s: { at: V3 }): Promise<boolean> => {
      const at = await screenOfPoint(s.at)
      return !!at && at.x > 40 && at.x < view.width - 360 && at.y > 40 && at.y < view.height - 40
    }
    for (const until = Date.now() + 30_000; Date.now() < until; ) {
      const read = await flyby(page)
      const hull = read.ships.find((s) => s.lod === 'hull')
      if (hull && (await inFrame(hull))) {
        const at = (await screenOfPoint(hull.at)) as { x: number; y: number }
        await page.screenshot({
          path: path.join(OUT, 'flyby-hull-close-crop.png'),
          clip: {
            x: Math.max(0, Math.min(view.width - 400, at.x - 200)),
            y: Math.max(0, Math.min(view.height - 280, at.y - 140)),
            width: 400,
            height: 280,
          },
        })
        await photo(page, 'flyby-hull-close')
        close = read
        break
      }
      await page.waitForTimeout(30)
    }
    expect(close, 'a ship passing the framed point was drawn as its hull, in frame').not.toBeNull()
    if (!close) return
    const hulls = close.ships.filter((s) => s.lod === 'hull')
    console.log(
      `[DEV-487] up close: ${hulls.length} hull(s) at ${hulls.map((s) => s.pixels.toFixed(0)).join(' ')} px, ` +
        `${close.ships.length - hulls.length} dart(s)`,
    )
    expect(hulls.length).toBe(close.state?.hulls)
    expect(close.arrowInstances, 'the rest are darts').toBe(close.ships.length - hulls.length)

    // ── gone while the course is flown, back on the way home ─────────────
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    const inFlight = await flyby(page)
    expect(inFlight.shown && inFlight.ships.length > 0, 'no fly-by while flying').toBe(false)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'Backspace')
    for (let i = 0; i < 10; i++) await hold(page, 'ArrowDown', 120)
    await hold(page, 'Enter', 300)
    await waitForEditor(page)
    await expect
      .poll(
        async () => {
          const r = await flyby(page)
          return r.shown && r.ships.length > 0
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    // ── every program linked, and something was drawn ────────────────────
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the editor frame drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(
      sweep.failed.map((f) => `#${f.id} ${f.type}`),
      'every program three holds linked',
    ).toEqual([])
    expect(pageErrors).toEqual([])
  })
})
