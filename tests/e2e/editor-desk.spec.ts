/**
 * The desktop course editor, end to end. DEV-469 (docs/plan/EDITOR-DISPATCH.md).
 *
 * The one path a creator takes, with nothing stubbed: the title's COURSES →
 * MAKE A COURSE builds the island the ordinary way and opens the editor over
 * it; four clicks on the ground make a course; FLY switches into it through
 * the game's own switch; the autopilot flies it to the finish, and the results
 * panel's press brings the player back with the author lap; a "fly from here"
 * is left by the pause plate's Back to editor; COPY LINK and SAVE FILE go out
 * through DEV-467's wire; `?edit=1` reopens the same draft; and the saved file,
 * opened from the title's OPEN A COURSE FILE, flies the same id.
 *
 * What it asserts that no unit test can:
 *
 *  · the RINGS the editor draws come from the game's own ring path and face
 *    along the drawn line — GEOMETRY, not rotation: each ring's opening axis
 *    is the thinnest extent of the mesh as the instance matrix places it, and
 *    it must lie along the line's tangent there (the orientation lesson);
 *  · the round trip keeps the draft, the selection and the CAMERA as they were;
 *  · every program three holds afterwards LINKED — the editor's own materials
 *    and the playtest's — with draw calls and programs counted first, so a
 *    frame that drew nothing cannot pass (CLAUDE.md: no gate compiles a shader);
 *  · DEV-478: the four points sag through a hill (Matt watched the racers dive
 *    into it). The buried ring REFUSES the course and the panel says why; the
 *    red loop is drawn round the game's own ring, a circle, and the red line
 *    lies under the ground; LIFT CLEAR OF THE GROUND, pressed, clears it as one
 *    undo step; and in the playtest every racer flies the course without a
 *    crash (`__ff2.racers()`), photographed.
 *
 * Canvas clicks go through `fixtures/canvas.ts`. Keys are HELD, not tapped:
 * the game reads its keys once a frame (`pause.spec.ts` says why). Tagged
 * `@gpu`: it needs a real GPU to fly at a sane rate.
 */
import fs from 'node:fs'
import path from 'node:path'
import { playerCourseId } from '../../src/content/player-course'
import {
  courseTokenIn,
  readCourseFile,
  readCourseToken,
} from '../../src/content/player-course-wire'
import { bootReady, missionReady, switchGone, switchSettled } from './fixtures/boot'
import { clickCanvasAt, dropFocus } from './fixtures/canvas'
import { collectPageErrors, editorLinkUrl, editorHold as hold } from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import { openMenu } from './fixtures/editor-menus'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'
import { pressShelfAction, SHELF_ACTION, titleRowsUp } from './fixtures/title'

const OUT = path.join('test-results', 'editor-desk')
/** 2016's own racing line on int_01 (THREE space), and the four places on it the spec clicks. */
const INT01_ROUTE = (
  JSON.parse(fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8')) as {
    route: [number, number, number][]
  }
).route
const ROUTE_PICKS = [20, 60, 100, 140] as const

interface DeskProbe {
  active: boolean
  anchored: boolean // DEV-501
  busy: boolean
  slot: string
  sky: string
  courseId: string | null
  valid: boolean
  points: [number, number, number][]
  selection: number | null
  rings: number | null
  drawnRings: number
  warnings: string[]
  errors: string[]
  canLift: boolean
  authorLap: number | null
  canUndo: boolean
  canRedo: boolean
  camera: { position: number[]; target: number[] }
  groundReady: boolean
  placeHeight: number
}
interface EditorProbe {
  editing: boolean
  flying: string | null
  desk: DeskProbe | null
}
type V3 = [number, number, number]

const editor = (page: Page): Promise<EditorProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.editor()
  }) as Promise<EditorProbe>

const desk = async (page: Page): Promise<DeskProbe> => {
  const e = await editor(page)
  if (!e.desk) throw new Error('the desk has not loaded')
  return e.desk
}

/** The editor is up and its ground is in: the frame is the editor's. */
const editing = async (page: Page): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', { timeout: 180_000 })
  await expect.poll(async () => (await editor(page)).editing, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await desk(page)).groundReady, { timeout: 60_000 }).toBe(true)
}

/**
 * DEV-471: the far shore (`render/horizon-geo.ts`) as the stage holds it: null
 * when no world has one, else whether it is drawn and whether the worn preset
 * asks for it.
 */
const horizonGeo = (page: Page): Promise<{ visible: boolean; preset: boolean } | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const mesh = w.__ff2.stage().getObjectByName('horizon-geo')
    return mesh
      ? { visible: mesh.visible, preset: w.__ff2.edition.current.render.horizonGeo.enabled }
      : null
  })

/**
 * DEV-471: every state the landing card passes through (since DEV-557, that
 * there is none at any point), recorded IN the page by
 * a MutationObserver from the first parse — so "it was shown, then it went" is
 * read off the states it took, not off when the spec happened to look.
 */
const recordCard = (): void => {
  const log: { boot: string; plate: string; card: string; start: string; live: boolean }[] = []
  ;(globalThis as unknown as { __cardLog: typeof log }).__cardLog = log
  const snap = (): void => {
    const overlay = document.getElementById('overlay')
    const entry = {
      boot: document.body?.dataset.editorBoot ?? '',
      plate: document.body?.dataset.editorPlate ?? '',
      card: !overlay
        ? 'none'
        : overlay.hidden || overlay.classList.contains('leaving')
          ? 'gone'
          : 'up',
      start: document.getElementById('start')?.textContent ?? '',
      live: (document.getElementById('start') as HTMLButtonElement | null)?.disabled === false,
    }
    const last = log[log.length - 1]
    if (
      !last ||
      last.boot !== entry.boot ||
      last.plate !== entry.plate ||
      last.card !== entry.card ||
      last.start !== entry.start ||
      last.live !== entry.live
    ) {
      log.push(entry)
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    snap()
    new MutationObserver(snap).observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
}

/** The title with its card gone and its rows up. */
const toTheTitle = async (page: Page): Promise<void> => {
  await page.goto(`/?xr=off&audio=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await dropFocus(page)
  await titleRowsUp(page)
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [
  (a[0] as number) - (b[0] as number),
  (a[1] as number) - (b[1] as number),
  (a[2] as number) - (b[2] as number),
]
const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A photograph into the run's folder, and into `EDITOR_PHOTO_DIR` too when it is set. */
const photo = async (page: Page, name: string): Promise<void> => {
  fs.mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: path.join(OUT, name) })
  if (process.env.EDITOR_PHOTO_DIR) {
    fs.mkdirSync(process.env.EDITOR_PHOTO_DIR, { recursive: true })
    fs.copyFileSync(path.join(OUT, name), path.join(process.env.EDITOR_PHOTO_DIR, name))
  }
}

/** DEV-478: the red geometry as the desk drew it, the game's rings, and the ground under each red point. */
const redMarks = (
  page: Page,
): Promise<{
  rings: V3[][]
  under: { at: V3; ground: number }[][]
  drawn: { centre: V3 }[]
}> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editorDebug()
    if (!d) throw new Error('no editor debug')
    const m = d.groundMarks()
    return {
      rings: m.rings,
      under: m.under.map((run) => run.map((at) => ({ at, ground: d.groundAt(at[0], at[2]) }))),
      drawn: d.ringGeometry(),
    }
  })

/** What every racer did: rings taken, finished, crashes (DEV-126's per-racer count). */
const racersFlown = (
  page: Page,
): Promise<
  | {
      gates: number
      finished: boolean
      crashes: number
      at: number[]
      along: number
      off: number
    }[]
  | null
> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const r = w.__ff2.racers()
    return r
      ? r.racers.map((x) => ({
          gates: x.gates,
          finished: x.finished,
          crashes: x.crash.count,
          // THREE space (the sim is Unity's, mirrored in z).
          at: [x.jet.body.position.x, x.jet.body.position.y, -x.jet.body.position.z].map((v) =>
            Math.round(v),
          ),
          along: Math.round(x.cursor.s),
          off: Math.round(x.cursor.offset),
        }))
      : null
  })

test.describe('@gpu the desktop course editor', () => {
  test.setTimeout(900_000)

  test('makes a course on simonet, flies it, comes back, shares it, and opens it again', async ({
    page,
    context,
  }) => {
    fs.mkdirSync(OUT, { recursive: true })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const pageErrors = collectPageErrors(page)

    // ── in by the title's door: COURSES, then MAKE A COURSE ─────────────
    await toTheTitle(page)
    await pressShelfAction(page, SHELF_ACTION.makeCourse)
    await missionReady(page)
    await editing(page)
    const first = await desk(page)
    expect(first.sky).toBe('int_01_hoverJet')
    // DEV-471: the far shore is in the world and NOT drawn while the editor is.
    const shoreEditing = await horizonGeo(page)
    expect(shoreEditing, 'the world has a far shore to hide').not.toBeNull()
    expect(shoreEditing?.visible, 'the far shore is hidden in the editor').toBe(false)
    // A fresh browser profile: a new draft, its one point the pad's (DEV-501).
    expect(first.points.length).toBe(1)
    expect(first.anchored).toBe(true)

    // ── four points, by clicking the ground ─────────────────────────────
    //
    // Top-down, so the four clicks land on a flat map of the island, spread
    // round the middle of the free viewport (the panel stands at the right).
    await page.locator('[data-editor="top-down"]').click()
    // Well clear of the hills between the points, so the autopilot can take
    // every ring and the flight back is an author lap (the field is the
    // panel's: typed, then Enter, as a creator sets it).
    await page.locator('[data-editor="height"]').fill('150')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await editor(page)).desk?.placeHeight).toBe(150)
    //
    // WHERE to click is named, not searched: four places on 2016's own int_01
    // line, which is inside the sky's boundary by construction, put on screen
    // by the desk's own projection. The ground under each is what a click
    // there hits, top-down.
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    for (const i of ROUTE_PICKS) {
      const [wx, wy, wz] = INT01_ROUTE[i] as V3
      const at = await page.evaluate(
        ([x, y, z]) => {
          const w = globalThis as unknown as Ff2Global
          return w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null
        },
        [wx, wy, wz] as V3,
      )
      const { x, y } = at as { x: number; y: number }
      expect(
        x > 0 && x < view.width - 320 && y > 0 && y < view.height,
        `route[${i}] on screen`,
      ).toBe(true)
      await clickCanvasAt(page, x, y)
      await page.waitForTimeout(150)
    }
    // DEV-501: the pad's point, and the four clicked.
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5)
    const placed = await desk(page)

    // ── undo and redo, from the keyboard ─────────────────────────────────
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).points.length).toBe(4)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await desk(page)).points.length).toBe(5)
    expect((await desk(page)).courseId).toBe(placed.courseId)

    // ── DEV-478: the four points sag through a hill, and a ring is in it ─
    //
    // Sparse points 150 m up make a Catmull-Rom that dips through the hill
    // between the middle two (Matt watched the racers dive into it). The
    // buried ring is an ERROR: FLY, SAVE FILE and COPY LINK are refused, and
    // the panel says why beside them.
    expect(placed.errors, 'a ring stands in the hill').toContain('ring-in-ground')
    expect(placed.valid, 'a buried ring refuses the course').toBe(false)
    expect(placed.canLift).toBe(true)
    for (const name of ['fly', 'save-file', 'copy-link']) {
      await expect(page.locator(`[data-editor="${name}"]`), `${name} is refused`).toBeDisabled()
    }
    // DEV-889: the banner says what the red rows below stop, once; the row says which.
    await expect(page.locator('[data-editor="refusal"]')).toContainText('red problem')
    const firstError = page.locator('[data-editor="problems-pop"] li.error').first()
    await expect(firstError).toContainText('Ring')
    await expect(firstError).toContainText('into its opening')
    // The rings still draw (the course expands): the red is drawn round THEM.
    await expect
      .poll(async () => (await desk(page)).drawnRings, { timeout: 30_000 })
      .toBe(placed.rings)
    const red = await redMarks(page)
    const buriedCount = placed.warnings.filter((k) => k === 'ring-in-ground').length
    expect(red.rings.length, 'one red loop per buried ring').toBe(buriedCount)
    for (const [i, loop] of red.rings.entries()) {
      // GEOMETRY: a circle (every point one radius from its centroid) standing
      // round one of the rings the GAME drew — not a belief about where it is.
      const c: V3 = [0, 1, 2].map(
        (k) => loop.reduce((t, p) => t + (p[k] as number), 0) / loop.length,
      ) as V3
      const radii = loop.map((p) => Math.hypot(...sub(p, c)))
      const r = radii.reduce((t, x) => t + x, 0) / radii.length
      for (const x of radii) expect(Math.abs(x - r), `loop ${i} is a circle`).toBeLessThan(0.05)
      const nearest = Math.min(...red.drawn.map((d) => Math.hypot(...sub(d.centre, c))))
      expect(nearest, `loop ${i} stands round a drawn ring`).toBeLessThan(r / 2)
    }
    expect(red.under.length, 'a red stretch where the line is in the hill').toBeGreaterThan(0)
    for (const run of red.under) {
      for (const p of run) expect(p.at[1], 'a red point is under the ground').toBeLessThan(p.ground)
    }
    // Look at it: zoomed a little toward the first buried ring's loop (the
    // wheel only: a pan's damping would still be settling when the spec
    // compares the camera across the playtest).
    const loop0 = red.rings[0] as V3[]
    const aim: V3 = [0, 1, 2].map(
      (k) => loop0.reduce((t, p) => t + (p[k] as number), 0) / loop0.length,
    ) as V3
    const onScreen = await page.evaluate(([x, y, z]) => {
      const w = globalThis as unknown as Ff2Global
      return w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null
    }, aim)
    if (onScreen) {
      const { x, y } = onScreen as { x: number; y: number }
      await page.mouse.move(x, y)
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -240)
        await page.waitForTimeout(120)
      }
    }
    await page.waitForTimeout(1_000)
    await photo(page, 'buried-in-editor.png')

    // ── LIFT CLEAR OF THE GROUND, pressed; one undo step ────────────────
    expect(await liftToFlyable(page, 'four points 150 m over int_01'), 'Lift was pressed').toBe(
      true,
    )
    await expect
      .poll(async () => {
        const m = await redMarks(page)
        return m.rings.length + m.under.length
      })
      .toBe(0)
    await expect(page.locator('[data-editor="refusal"]')).toHaveText('')
    await page.waitForTimeout(1_000)
    await photo(page, 'lifted-in-editor.png')
    const lifted = await desk(page)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).courseId).toBe(placed.courseId)
    expect((await desk(page)).errors).toContain('ring-in-ground')
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await desk(page)).courseId).toBe(lifted.courseId)
    await expectFlyable(page, 'the lift, redone')

    const made = await desk(page)
    expect(made.valid, `the four-point course validates (warnings: ${made.warnings})`).toBe(true)
    expect(made.rings ?? 0).toBeGreaterThan(0)
    // The rings arrive through the game's own `loadRings`, rebuilt after a pause.
    await expect
      .poll(async () => (await desk(page)).drawnRings, { timeout: 30_000 })
      .toBe(made.rings)

    // ── the rings face along the line: GEOMETRY ─────────────────────────
    const geometry = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      const d = w.__ff2.editorDebug()
      return d ? { rings: d.ringGeometry(), line: d.lineSamples() } : null
    })
    expect(geometry).not.toBeNull()
    const { rings, line } = geometry as { rings: { centre: V3; normal: V3 }[]; line: V3[] }
    expect(rings.length).toBe(made.rings)
    expect(line.length).toBeGreaterThan(10)
    for (const [i, ring] of rings.entries()) {
      // The line's tangent at the sample nearest the ring's centre.
      let best = 0
      let bestD = Number.POSITIVE_INFINITY
      line.forEach((p, k) => {
        const d = Math.hypot(...sub(p, ring.centre))
        if (d < bestD) {
          bestD = d
          best = k
        }
      })
      const a = line[Math.max(0, best - 1)] as V3
      const b = line[Math.min(line.length - 1, best + 1)] as V3
      const tangent = unit(sub(b, a))
      // On the line (within the ring's own size), and its opening along it.
      expect(bestD, `ring ${i} stands on the drawn line`).toBeLessThan(30)
      expect(
        Math.abs(dot(unit(ring.normal), tangent)),
        `ring ${i} faces along the line`,
      ).toBeGreaterThan(0.9)
    }

    // ── FLY, and the autopilot takes it to the finish ────────────────────
    const cameraBefore = (await desk(page)).camera
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await expect
      .poll(async () => (await editor(page)).flying, { timeout: 30_000 })
      .toBe(made.courseId)
    // The switch has landed when the switching flag is gone and the island is up.
    await switchGone(page)
    await missionReady(page)
    // DEV-471: and back for the flight, as the preset has it.
    const shoreFlying = await horizonGeo(page)
    expect(shoreFlying?.visible, 'the far shore is back for Fly').toBe(shoreFlying?.preset)
    // DEV-498: and the desk's far sea is not: a flight shows none, built or not.
    const farSeaFlying = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      return w.__ff2.stage().getObjectByName('far-sea')?.visible ?? false
    })
    expect(farSeaFlying, 'no far sea shows in the flight').toBe(false)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'p')
    // DEV-478: watch the racers fly the lifted course, from the chase view.
    await page.waitForTimeout(6_000)
    await hold(page, 'v', 120)
    await page.waitForTimeout(1_500)
    await photo(page, 'playtest-racers-1.png')
    console.log(`[DEV-478] racers at ~8 s: ${JSON.stringify(await racersFlown(page))}`)
    await page.waitForTimeout(8_000)
    await photo(page, 'playtest-racers-2.png')
    console.log(`[DEV-478] racers at ~16 s: ${JSON.stringify(await racersFlown(page))}`)
    await expect(page.locator('body')).toHaveAttribute('data-finished', 'true', {
      timeout: 240_000,
    })
    // The racers flew it and not one of them into the ground: no crash, and
    // the leader took every ring. And EVERY racer took a ring: on this course
    // the run-in from the pad meets the line in a hairpin at its first point,
    // where DEV-478 watched racer 2 stall and take none. DEV-494 keeps a
    // racer's aim 30 m out, and it rounds the fold (DEV-486 warns of that
    // hairpin in the editor, `run-in-turn`; this spec keeps it, on purpose).
    const racers = await racersFlown(page)
    console.log(`[DEV-478] the racers at the finish: ${JSON.stringify(racers)}`)
    expect(racers?.length ?? 0, 'racers flew the course').toBeGreaterThan(0)
    for (const [i, r] of (racers ?? []).entries()) {
      expect(r.crashes, `racer ${i + 1} crashed`).toBe(0)
    }
    expect(Math.max(...(racers ?? []).map((r) => r.gates)), 'the leader took every ring').toBe(
      made.rings,
    )
    const none = (racers ?? []).flatMap((r, i) => (r.gates === 0 ? [i + 1] : []))
    expect(none, 'every racer rounded the run-in hairpin and took a ring').toEqual([])
    const flown = await page.evaluate(() => ({
      rings: document.body.dataset.rings ?? '',
      best: document.body.dataset.best ?? '',
    }))
    // The results panel's press goes home, and home is the editor.
    await page.waitForTimeout(1_000)
    await hold(page, 'Enter', 300)
    await editing(page)
    const back = await desk(page)
    expect(back.courseId).toBe(made.courseId)
    expect(back.points).toEqual(made.points)
    expect(back.camera).toEqual(cameraBefore)
    // Every ring taken and the finish crossed is the author lap (DEV-468).
    console.log(`[DEV-469] the autopilot took ${flown.rings}; author lap ${back.authorLap}`)
    const [taken, total] = flown.rings.split('/').map(Number)
    if (taken !== undefined && taken === total) {
      expect(
        back.authorLap,
        `a clean autopilot lap (${flown.rings}) is the author lap`,
      ).not.toBeNull()
    } else {
      test.info().annotations.push({
        type: 'note',
        description: `the autopilot took ${flown.rings}; no author lap to check`,
      })
    }

    // ── FLY FROM a point, and the pause plate's Back to editor ──────────
    //
    // Pick the third point by its handle, where the desk draws it.
    const third = back.points[2] as V3
    const at = await page.evaluate(([x, y, z]) => {
      const w = globalThis as unknown as Ff2Global
      return w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null
    }, third)
    expect(at).not.toBeNull()
    const { x: hx, y: hy } = at as { x: number; y: number }
    await clickCanvasAt(page, hx, hy)
    await expect.poll(async () => (await desk(page)).selection).toBe(2)
    const selected = await desk(page)
    await page.locator('[data-editor="fly-here"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // Pause, then the bottom row — Back to editor stands where EXIT does.
    await hold(page, 'Backspace')
    for (let i = 0; i < 10; i++) await hold(page, 'ArrowDown', 120)
    await hold(page, 'Enter', 300)
    await editing(page)
    const again = await desk(page)
    expect(again.courseId).toBe(made.courseId)
    expect(again.selection).toBe(selected.selection)
    expect(again.camera).toEqual(selected.camera)
    // A part of a course keeps no lap: the author lap is what it was.
    expect(again.authorLap).toBe(back.authorLap)

    // ── every program linked, and something was drawn ────────────────────
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the editor frame drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(
      sweep.failed.map((f) => `#${f.id} ${f.type}`),
      'every program three holds linked',
    ).toEqual([])

    // ── COPY LINK and SAVE FILE, through DEV-467's wire ──────────────────
    await openMenu(page, 'share')
    await page.locator('[data-editor="copy-link"]').click()
    await expect(page.locator('#editor-panel')).toHaveAttribute('data-link', /#c=/, {
      timeout: 10_000,
    })
    const link = (await page.locator('#editor-panel').getAttribute('data-link')) as string
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)
    const fromLink = await readCourseToken(courseTokenIn(new URL(link).hash) as string)
    expect(fromLink.ok && playerCourseId(fromLink.course), 'the link is the course').toBe(
      made.courseId,
    )
    const download = page.waitForEvent('download')
    await openMenu(page, 'share')
    await page.locator('[data-editor="save-file"]').click()
    const saved = await download
    expect(saved.suggestedFilename()).toMatch(/\.ffcourse$/)
    const file = path.join(OUT, 'made.ffcourse')
    await saved.saveAs(file)
    const fromFile = await readCourseFile(new Uint8Array(fs.readFileSync(file)))
    expect(fromFile.ok && playerCourseId(fromFile.course), 'the file is the course').toBe(
      made.courseId,
    )

    // ── `?edit=1` reopens the same draft ────────────────────────────────
    //
    // DEV-471: with NO press. The loading scene stands while the island is
    // built (MAKE A COURSE's door), and the editor arrives over it. DEV-557
    // took the landing card that used to stand over that scene, counting,
    // and go by itself once the editor took a click: there is no card at any
    // point now, and the loading scene's plate is the loading screen.
    await page.addInitScript(recordCard)
    await page.goto(editorLinkUrl())
    await missionReady(page)
    await editing(page)
    await expect(page.locator('body')).toHaveAttribute('data-editor-boot', 'ready')
    const cardLog = (await page.evaluate(
      () => (globalThis as unknown as { __cardLog: unknown }).__cardLog,
    )) as { boot: string; plate: string; card: string; start: string; live: boolean }[]
    console.log(`[DEV-471] the card: ${JSON.stringify(cardLog)}`)
    expect(
      cardLog.every((e) => e.card === 'none'),
      'no landing card at any point (DEV-557)',
    ).toBe(true)
    const ready = cardLog.findIndex((e) => e.boot === 'ready')
    expect(ready, 'the editor came up with no press').toBeGreaterThanOrEqual(0)
    // The loading screen: the loading scene's plate (DEV-355) stood while the
    // island was built (read off the scene when the switch landed), and it
    // is down now that the editor draws.
    const plate = cardLog.findIndex((e) => e.plate === 'scene')
    expect(plate, 'the loading scene stood while the island was built').toBeGreaterThanOrEqual(0)
    expect(plate, 'before the editor was up').toBeLessThan(ready)
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.loading().place))
      .toBeNull()
    // Zoomed out over the island, the way Matt looked at the shoreline: the
    // wheel, over the canvas, as a person turns it. No far-shore band.
    const box = await page.locator('#viewport').boundingBox()
    if (box) await page.mouse.move(box.x + (box.width - 320) / 2, box.y + box.height / 2)
    for (let k = 0; k < 10; k++) {
      await page.mouse.wheel(0, 300)
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(1_500)
    expect((await horizonGeo(page))?.visible, 'no far shore over the island').toBe(false)
    await page.screenshot({ path: path.join(OUT, 'edit1-zoomed-out.png') })
    if (process.env.EDITOR_PHOTO_DIR) {
      fs.mkdirSync(process.env.EDITOR_PHOTO_DIR, { recursive: true })
      fs.copyFileSync(
        path.join(OUT, 'edit1-zoomed-out.png'),
        path.join(process.env.EDITOR_PHOTO_DIR, 'edit1-zoomed-out.png'),
      )
    }
    const reopened = await desk(page)
    expect(reopened.slot).toBe(again.slot)
    expect(reopened.courseId).toBe(made.courseId)
    expect(reopened.points).toEqual(made.points)

    // ── and the file, opened from the title, flies the same id ──────────
    await toTheTitle(page)
    const chooser = page.waitForEvent('filechooser')
    await pressShelfAction(page, SHELF_ACTION.openCourseFile, 0)
    await (await chooser).setFiles(file)
    await expect(page.locator('body')).toHaveAttribute(
      'data-player-course',
      made.courseId as string,
      { timeout: 30_000 },
    )
    await switchSettled(page, 240_000)

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
