/**
 * Hand-placed props, with real pointer events. DEV-504
 * (docs/plan/EDITOR-PROPS.md: Matt, *"ability to add hand-placed props (needs
 * a prop library prob?)"*).
 *
 * On Simonet, over int_01's own line: a small cactus garden and a palm beside
 * the run-in, and a spire beside the line, placed the way a hand places them —
 * the Props group opened, a name picked, the ground CLICKED where it should
 * stand. Then a cactus is picked by clicking the cactus itself, its X arrow
 * DRAGGED, R and its ring dragged, its size slider moved with the keys, Delete
 * pressed and undone: each an undo step.
 *
 * What is measured, and against what:
 *
 *  · GROUND CONTACT, against the desk's own render-surface probe: every prop's
 *    base (its drawn vertices' bottom tenth, measured off the mesh) stands on
 *    or under the ground all round it, less the preset's ground-snap sink —
 *    so a spire whose base is ~290 m across does not stand on air — and a
 *    cactus, whose base is its trunk, stands where the island stands one.
 *  · The draft survives a RELOAD (`readDraftCourse`) and the LINK (`#c=`) with
 *    its props, under the same id.
 *  · FLY: the world the GAME builds draws each prop — `level.props` through
 *    `buildLandmarkGroup` — at the world matrix the desk drew it at, read off
 *    the world's own `InstancedMesh`es, not off the course (place → expand →
 *    draw → read back). And each is solid: the world's LANDMARK colliders hold
 *    one per placed prop more than the sky's own world did.
 *  · Back to the editor, the world's copy of the props is hidden, and the
 *    desk's drawn.
 *
 * DEV-503 (the prop warning) was not on `main` when this was written; when it
 * lands, the warning firing on a placed prop belongs in this spec.
 *
 * `EDITOR_PHOTO_DIR=<dir>` keeps the photographs there too: the garden and the
 * spire from the desk, and from the ship on its pad. The tier is pinned
 * (`PINNED`), because the photos are looked at.
 */

import fs from 'node:fs'
import path from 'node:path'
import { playerCourseId } from '../../src/content/player-course'
import { courseTokenIn, readCourseToken } from '../../src/content/player-course-wire'
import { missionReady, switchGone } from './fixtures/boot'
import {
  captureCanvas,
  clickCanvasAt,
  dragCanvas,
  hoverCanvasAt,
  releasePointer,
} from './fixtures/canvas'
import {
  collectPageErrors,
  editorHold as hold,
  openEditor,
  openEditorFromTitle,
  waitForEditor,
} from './fixtures/editor-boot'
import { expectFlyable, liftToFlyable } from './fixtures/editor-course'
import { clearOfChrome, openMenu } from './fixtures/editor-menus'
import { photographer } from './fixtures/photo'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-props')
const INT01_ROUTE = (
  JSON.parse(fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8')) as {
    route: [number, number, number][]
  }
).route
// As editor-pad.spec.ts: the first pick past ring 1 lands where a click finds land.
const FIRST_PICKS = [30, 34, 38, 42, 46, 50] as const
const ROUTE_PICKS = [60, 100, 140] as const

/**
 * How near the ground a pivot must stand, metres. The course stores the pivot
 * on a 10 cm grid (`pointQuantumMetres`) in all three axes, so y is seated at
 * the click and then rounded by up to 5 cm, and x and z by up to 5 cm each,
 * which on a 40 % slope moves the ground under it by up to ~3 cm more.
 */
const SEAT_TOLERANCE = 0.1

type V3 = [number, number, number]
interface Prop {
  kind: string
  pos: V3
  yaw: number
  scale: number
}
interface DeskProbe {
  points: V3[]
  selection: number | null
  valid: boolean
  courseId: string | null
  groundReady: boolean
  placeHeight: number
  start: { pos: V3; yaw: number }
  startArrow: { tail: V3; tip: V3 } | null
  gizmoMode: string
  gizmo: { attached: boolean; axis: string | null; dragging: boolean }
  canUndo: boolean
  props: Prop[]
  propsDrawn: number
  propPicked: number | null
  propPlacing: string | null
  propSpin: boolean
  propSink: number
}
interface Debug {
  screenOf(x: number, y: number, z: number): { x: number; y: number } | null
  gizmoHandle(axis: 'X' | 'Y' | 'Z'): { x: number; y: number } | null
  gizmoRing(): { x: number; y: number } | null
  groundAt(x: number, z: number): number
  propMatrix(i: number): number[] | null
  propBase(i: number): { radius: number; seat: number | null } | null
}

const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2: { editor(): { desk: unknown } } }
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
      const w = globalThis as unknown as {
        __ff2: { editorDebug(): Record<string, (...x: unknown[]) => unknown> | null }
      }
      const d = w.__ff2.editorDebug()
      if (!d) throw new Error('no editor debug')
      return (d[n as string] as (...x: unknown[]) => unknown)(...(a as unknown[]))
    },
    [name, args] as const,
  ) as Promise<ReturnType<Debug[K]>>

const photo = photographer(OUT)

/**
 * Click the canvas at a projected point, having checked it IS on the canvas and
 * clear of the panel: a point off it is clicked on `<html>`, which Playwright
 * retries until the test times out (this spec's second run lost 15 minutes so).
 */
const clickAt = async (
  page: Page,
  p: { x: number; y: number } | null,
  what: string,
): Promise<void> => {
  const view = page.viewportSize() ?? { width: 1280, height: 720 }
  if (!p || !clearOfChrome(p, view)) {
    throw new Error(`${what} is off the canvas: ${JSON.stringify(p)}`)
  }
  await clickCanvasAt(page, p.x, p.y)
}

/**
 * Prop `i` (`p` as the draft holds it) stands on the ground by its base: its
 * pivot at the LOWEST ground under the base less `sink` — so the ground at
 * every point of the base's reach is at or above the base — to the pivot's
 * quantum. The ground and the reach are read off the page, the height
 * compared here.
 */
const expectSeated = async (page: Page, p: Prop, i: number, sink: number): Promise<void> => {
  const base = await debug(page, 'propBase', i)
  if (!base) throw new Error(`prop ${i}'s mesh has not loaded`)
  const at = [[p.pos[0], p.pos[2]] as const]
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4
    at.push([p.pos[0] + base.radius * Math.cos(a), p.pos[2] + base.radius * Math.sin(a)] as const)
  }
  const grounds: number[] = []
  for (const [x, z] of at) grounds.push((await debug(page, 'groundAt', x, z)) as number)
  const low = Math.min(...grounds)
  console.log(
    `[DEV-504] ${p.kind} at ${p.pos.map((v) => v.toFixed(1))} yaw ${p.yaw} scale ${p.scale}: ` +
      `base ${base.radius.toFixed(1)} m, ground ${(grounds[0] as number).toFixed(2)} at the pivot, ` +
      `${low.toFixed(2)} lowest under the base`,
  )
  expect(Math.abs(p.pos[1] - (low - sink)), `${p.kind} seated by its base`).toBeLessThan(
    SEAT_TOLERANCE,
  )
}

/**
 * The world's placed-prop meshes as the GAME drew them: every instance's
 * world matrix (column-major), in instance order per mesh, and whether the
 * mesh is visible. Read off the scene on screen, never off the course.
 */
const worldProps = (
  page: Page,
): Promise<{ name: string; visible: boolean; matrices: number[][] }[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        stage(): {
          traverse(f: (o: unknown) => void): void
        }
      }
    }
    const out: { name: string; visible: boolean; matrices: number[][] }[] = []
    w.__ff2.stage().traverse((o) => {
      const m = o as {
        name: string
        visible: boolean
        userData: Record<string, unknown>
        count: number
        matrixWorld: { elements: number[]; clone(): unknown }
        updateWorldMatrix(a: boolean, b: boolean): void
        getMatrixAt(i: number, into: unknown): void
      }
      if (m.userData?.placedProps !== true) return
      m.updateWorldMatrix(true, false)
      const matrices: number[][] = []
      const Ctor = (m.matrixWorld as unknown as { constructor: new () => unknown }).constructor
      for (let i = 0; i < m.count; i++) {
        const local = new Ctor() as {
          elements: number[]
          premultiply(x: unknown): { elements: number[] }
        }
        m.getMatrixAt(i, local)
        matrices.push([...local.premultiply(m.matrixWorld).elements])
      }
      // Drawn only if it AND every ancestor is visible.
      let shown = true
      for (let n: unknown = m; n; n = (n as { parent: unknown }).parent) {
        if ((n as { visible: boolean }).visible === false) shown = false
      }
      out.push({ name: m.name, visible: shown, matrices })
    })
    return out
  })

/** How many LANDMARK colliders (a hull or the mesh's own triangles) the world holds. */
const landmarkColliders = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: { propColliders(): { landmarks: number } | null }
    }
    return w.__ff2.propColliders()?.landmarks ?? null
  })

test.describe('@gpu hand-placed props (DEV-504)', () => {
  test.setTimeout(900_000)

  test('a cactus garden and a spire: placed, moved, spun, sized, deleted, undone, flown', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    // One mesh arrives SLOWLY, as it would on a slow connection: the second
    // cactus is clicked onto the ground while its mesh is still on the wire.
    // The seat is measured off the mesh, so a desk that seated before the
    // mesh arrived stood the cactus on its pivot's ground alone — the flake
    // the lead gate saw ("cactus-tall-02 seated by its base"): out by however
    // far the ground falls within its base. The game is unchanged; only the network is slower.
    const SLOW_MESH = 'cactus-tall-02.glb'
    await page.route(`**/${SLOW_MESH}*`, async (route) => {
      await new Promise((r) => setTimeout(r, 2_500))
      await route.continue()
    })

    // ── in by the title's door: MAKE A COURSE, over Simonet ─────────────
    await openEditorFromTitle(page)

    // ── a course on 2016's own line (editor-pad.spec.ts's recipe) ───────
    await page.locator('[data-editor="top-down"]').click()
    await page.locator('[data-editor="height"]').fill('150')
    await page.locator('[data-editor="height"]').press('Enter')
    await expect.poll(async () => (await desk(page)).placeHeight).toBe(150)
    await page.waitForTimeout(1_500)
    for (const i of FIRST_PICKS) {
      const [wx, wy, wz] = INT01_ROUTE[i] as V3
      const at = await debug(page, 'screenOf', wx, wy, wz)
      if (!at) throw new Error(`route[${i}] is behind the eye`)
      await clickCanvasAt(page, at.x, at.y)
      await page.waitForTimeout(150)
      await page.keyboard.press('Escape')
      if ((await desk(page)).points.length === 2) break
    }
    for (const i of ROUTE_PICKS) {
      const [wx, wy, wz] = INT01_ROUTE[i] as V3
      const at = await debug(page, 'screenOf', wx, wy, wz)
      if (!at) throw new Error(`route[${i}] is behind the eye`)
      await clickCanvasAt(page, at.x, at.y)
      await page.waitForTimeout(150)
      await page.keyboard.press('Escape')
      await expect.poll(async () => (await desk(page)).selection).toBeNull()
    }
    await expect.poll(async () => (await desk(page)).points.length, { timeout: 10_000 }).toBe(5)
    await liftToFlyable(page, 'four points 150 m over int_01')
    const course = await desk(page)
    expect(course.props).toEqual([])

    // ── where the garden goes: beside the run-in, ahead of the pad ──────
    const pad = course.start.pos
    const arrow = course.startArrow
    if (!arrow) throw new Error('no start arrow')
    const fl = Math.hypot(arrow.tip[0] - arrow.tail[0], arrow.tip[2] - arrow.tail[2])
    const f = [(arrow.tip[0] - arrow.tail[0]) / fl, (arrow.tip[2] - arrow.tail[2]) / fl]
    const r = [-(f[1] as number), f[0] as number] // a right angle to it, in plan
    const at = (ahead: number, aside: number): [number, number] => [
      pad[0] + (f[0] as number) * ahead + (r[0] as number) * aside,
      pad[2] + (f[1] as number) * ahead + (r[1] as number) * aside,
    ]
    // The garden stands on LAND, 18–320 m from the pad and 15 m or more
    // off the run-in, found by asking the desk's ground probe round the pad,
    // nearest first.
    const around: { ahead: number; aside: number; g: number }[] = []
    const radii = [18, 22, 26, 30, 34, 38]
    for (let rad = 40; rad <= 320; rad += 10) radii.push(rad)
    for (const rad of radii) {
      for (let deg = 0; deg < 360; deg += 10) {
        const a = (deg * Math.PI) / 180
        const ahead = rad * Math.cos(a)
        const aside = rad * Math.sin(a)
        const [x, z] = at(ahead, aside)
        around.push({ ahead, aside, g: (await debug(page, 'groundAt', x, z)) as number })
      }
    }
    // The sea is the lowest thing round the pad; land stands clear of it.
    const sea = Math.min(...around.map((r) => r.g).filter((g) => Number.isFinite(g)))
    const spots: { ahead: number; aside: number }[] = []
    const flattest = { spread: Number.POSITIVE_INFINITY, ahead: 0, aside: 0, g: 0 }
    for (const r of around) {
      if (spots.length >= 5) break
      if (Math.abs(r.aside) < 15 && r.ahead > 0) continue
      // Land, clear of the sea: a tidal flat a metre over it is drawn under
      // the waves (the first garden stood there, and read as standing in the
      // sea). The pad the desk finds on int_01 is a sea stack's summit, 322 m
      // up, with nothing flat within 200 m of it.
      if (!(r.g > sea + 8)) continue
      if (spots.some((s) => Math.hypot(s.ahead - r.ahead, s.aside - r.aside) < 9)) continue
      // And not a cliff: within 6 m over 6 m round it (Simonet has nothing
      // flatter near this pad; a cliff face buries a cactus to its arms, which
      // is the seat working, not a garden).
      const [x, z] = at(r.ahead, r.aside)
      const near: number[] = []
      for (const [dx, dz] of [
        [6, 0],
        [-6, 0],
        [0, 6],
        [0, -6],
      ] as const) {
        near.push((await debug(page, 'groundAt', x + dx, z + dz)) as number)
      }
      const spread = Math.max(r.g, ...near) - Math.min(r.g, ...near)
      if (spread < flattest.spread) Object.assign(flattest, { spread, ...r })
      if (spread > 6) continue
      spots.push({ ahead: r.ahead, aside: r.aside })
    }
    const padGround = (await debug(page, 'groundAt', pad[0], pad[2])) as number
    const rings = [40, 80, 120, 160, 200, 240, 280, 320].map((rad) => {
      const gs = around
        .filter((a) => Math.abs(Math.hypot(a.ahead, a.aside) - rad) < 1)
        .map((a) => a.g)
      return `${rad} m ${Math.min(...gs).toFixed(0)}..${Math.max(...gs).toFixed(0)}`
    })
    console.log(
      `[DEV-504] the sea round the pad stands at ${sea.toFixed(2)} m; the pad at ` +
        `${pad.map((v) => v.toFixed(1))} over ground ${padGround.toFixed(1)}; ${rings.join(', ')}; ` +
        `the flattest land: ${JSON.stringify(flattest)}`,
    )
    // A SMALL garden: round the flattest land found, a few metres apart (the
    // sea stack has room for one cluster, not five spread spots).
    expect(spots.length, 'land for a garden near the pad').toBeGreaterThan(0)
    const centre = spots[0] as { ahead: number; aside: number }
    const OFFSETS = [
      [0, 0],
      [5, 3],
      [-4, 4],
      [3, -5],
      // The palm's crown is ~12 m across at its size: clear of the cactus a
      // crown click picks (it covered it, and the click picked the palm).
      [-16, 12],
    ] as const
    const kinds = [
      'cactus-tall-01',
      'cactus-tall-02',
      'cactus-short-02',
      'cactus-tall-03',
      'gl-palmtree-03',
    ]
    const GARDEN = kinds.map((kind, i) => ({
      kind,
      ahead: centre.ahead + (OFFSETS[i]?.[0] ?? 0),
      aside: centre.aside + (OFFSETS[i]?.[1] ?? 0),
    }))
    console.log(
      `[DEV-504] the garden: ${GARDEN.map((g) => `${g.kind} ${g.ahead.toFixed(0)} ahead ${g.aside.toFixed(0)} aside`).join('; ')}`,
    )
    const SPIRE = { kind: 'spire-b', ahead: 320, aside: -190 }

    // Framed on the pad, top-down, so a click is a metre or two, not ten.
    await clickAt(page, await debug(page, 'screenOf', ...pad), 'the pad')
    await page.keyboard.press('f')
    await page.waitForTimeout(1_500)
    await page.keyboard.press('Escape')

    // ── the Props group: pick a name, click the ground ──────────────────
    await page.locator('[data-editor="props"]').click()
    await expect(page.locator('[data-editor="prop-group"]')).toHaveAttribute('open', '')
    // The base's own island first: Simonet's palms head the list.
    const firstGroup = await page
      .locator('[data-editor="prop-library"] > .group')
      .first()
      .locator('.readout')
      .textContent()
    expect(firstGroup).toMatch(/Simonet/)
    const place = async (kind: string, xz: [number, number]): Promise<void> => {
      const button = page.locator(`[data-editor="prop-kind"][data-kind="${kind}"]`)
      await button.click()
      await expect.poll(async () => (await desk(page)).propPlacing).toBe(kind)
      const y = (await debug(page, 'groundAt', xz[0], xz[1])) as number
      // On the canvas and clear of the panel, or the camera draws back until it is.
      const view = page.viewportSize() ?? { width: 1280, height: 720 }
      const onCanvas = (p: { x: number; y: number } | null): boolean =>
        !!p && clearOfChrome(p, view)
      let s = await debug(page, 'screenOf', xz[0], y, xz[1])
      for (let i = 0; i < 8 && !onCanvas(s); i++) {
        await page.mouse.move((view.width - 324) / 2, view.height / 2)
        await page.mouse.wheel(0, 240)
        await page.waitForTimeout(400)
        s = await debug(page, 'screenOf', xz[0], y, xz[1])
      }
      if (!s || !onCanvas(s)) throw new Error(`${kind}'s spot is off screen`)
      const before = (await desk(page)).props.length
      await clickCanvasAt(page, s.x, s.y)
      await expect.poll(async () => (await desk(page)).props.length).toBe(before + 1)
    }
    for (const g of GARDEN) await place(g.kind, at(g.ahead, g.aside))
    await place(SPIRE.kind, at(SPIRE.ahead, SPIRE.aside))
    await page.locator('[data-editor="prop-stop"]').click()
    await expect.poll(async () => (await desk(page)).propPlacing).toBeNull()
    const placed = await desk(page)
    expect(placed.props.map((p) => p.kind)).toEqual([...GARDEN.map((g) => g.kind), SPIRE.kind])
    await expect
      .poll(async () => (await desk(page)).propsDrawn, { timeout: 60_000 })
      .toBe(placed.props.length)

    // GROUND CONTACT: seated by its base, never on air, against the ground probe.
    for (const [i, p] of placed.props.entries()) await expectSeated(page, p, i, placed.propSink)
    // Placing is not flying: the course still flies.
    await expectFlyable(page, 'the course, with its garden')

    // ── photographs from the desk: top-down, then oblique on the garden ─
    await photo(page, 'props-desk-top-down.png')

    // ── pick a cactus by clicking IT, zoomed in on the garden ───────────
    const cactus = placed.props[0] as Prop
    // Framed on the pad again (the spire drew the camera back), then in on the cactus.
    await clickAt(page, await debug(page, 'screenOf', ...pad), 'the pad')
    await expect.poll(async () => (await desk(page)).propPicked).toBeNull()
    await page.keyboard.press('f')
    await page.waitForTimeout(1_500)
    await page.keyboard.press('Escape')
    const zoomAt = await debug(page, 'screenOf', ...cactus.pos)
    if (!zoomAt) throw new Error('the cactus is off screen')
    await page.mouse.move(zoomAt.x, zoomAt.y)
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(1_000)
    // Its crown, from above: the pivot lifted most of the way up the cactus.
    const crown = await debug(page, 'screenOf', cactus.pos[0], cactus.pos[1] + 5, cactus.pos[2])
    await clickAt(page, crown, 'the cactus crown')
    await expect.poll(async () => (await desk(page)).propPicked).toBe(0)
    expect((await desk(page)).gizmoMode).toBe('translate')

    // DRAG its X arrow: it moves in x, and is seated again.
    const hx = await debug(page, 'gizmoHandle', 'X')
    if (!hx) throw new Error('no X arrow')
    await hoverCanvasAt(page, hx.x, hx.y)
    await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe('X')
    await dragCanvas(page, hx, { x: hx.x + 30, y: hx.y }, { steps: 16 })
    await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    const moved = (await desk(page)).props[0] as Prop
    expect(Math.abs(moved.pos[0] - cactus.pos[0]), 'it moved along X').toBeGreaterThan(1)
    expect(Math.abs(moved.pos[2] - cactus.pos[2]), 'and not along Z').toBeLessThan(0.11)
    await expectSeated(page, moved, 0, placed.propSink)
    expect(moved.yaw).toBe(cactus.yaw)

    // E (Maya's rotate, DEV-570; R until then), and its ring: it turns about
    // Y, and stands where it stood.
    await page.keyboard.press('e')
    await expect.poll(async () => (await desk(page)).gizmoMode).toBe('rotate')
    await page.waitForTimeout(400)
    const ring = await debug(page, 'gizmoRing')
    if (!ring) throw new Error('no Y ring')
    await hoverCanvasAt(page, ring.x, ring.y)
    await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe('Y')
    // 80 px, not 40: how far a drag turns the ring depends on where the prop sits
    // in the frame, and DEV-831's fixed diagonal seats it a little differently
    // (40 px turned it 8 degrees there). The claim is that the ring turns it.
    await dragCanvas(page, ring, { x: ring.x, y: ring.y - 80 }, { steps: 20 })
    await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    const spun = (await desk(page)).props[0] as Prop
    const turned = Math.abs(((spun.yaw - moved.yaw + 540) % 360) - 180)
    expect(turned, 'the ring turned it').toBeGreaterThan(10)
    expect(spun.pos, 'turning does not move it').toEqual(moved.pos)

    // DEV-570: R (Maya's scale), and a scale handle dragged OUT along X: the
    // prop grows as one (a prop has one size), and stands where it stood.
    await page.keyboard.press('r')
    await expect.poll(async () => (await desk(page)).gizmoMode).toBe('scale')
    await page.waitForTimeout(400)
    const sx = await debug(page, 'gizmoHandle', 'X')
    if (!sx) throw new Error('no X scale handle')
    const sc = await debug(page, 'screenOf', ...spun.pos)
    if (!sc) throw new Error('the cactus is off screen')
    await hoverCanvasAt(page, sx.x, sx.y)
    await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe('X')
    // Out, away from the prop's own centre on screen.
    const out = { x: sx.x - sc.x, y: sx.y - sc.y }
    const len = Math.hypot(out.x, out.y) || 1
    await dragCanvas(
      page,
      sx,
      { x: sx.x + (out.x / len) * 20, y: sx.y + (out.y / len) * 20 },
      { steps: 16 },
    )
    await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    const grown = (await desk(page)).props[0] as Prop
    console.log(`[DEV-570] R and a handle: scale ${spun.scale} -> ${grown.scale}`)
    expect(grown.scale, 'the scale handle grew it').toBeGreaterThan(spun.scale)
    expect(grown.pos[0], 'sizing does not move it in x').toBe(spun.pos[0])
    expect(grown.pos[2], 'or in z').toBe(spun.pos[2])
    expect(grown.yaw, 'or turn it').toBe(spun.yaw)
    await photo(page, 'props-desk-scale-gizmo.png')

    // SIZE: the slider too, moved with the keys.
    await page.locator('[data-editor="prop-scale"]').focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await page.locator('[data-editor="prop-scale"]').blur()
    const sized = (await desk(page)).props[0] as Prop
    expect(sized.scale, 'it grew').toBeGreaterThan(grown.scale)

    // DELETE, and UNDO, and REDO: one step each.
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await desk(page)).props.length).toBe(placed.props.length - 1)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).props.length).toBe(placed.props.length)
    expect((await desk(page)).props[0]).toEqual(sized)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await desk(page)).props.length).toBe(placed.props.length - 1)
    await page.keyboard.press('Control+z')
    // And back through the size, the turn and the move, to where it was placed.
    for (let i = 0; i < 12; i++) {
      if (JSON.stringify((await desk(page)).props[0]) === JSON.stringify(cactus)) break
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(100)
    }
    expect((await desk(page)).props[0], 'undo walks it back to where it was placed').toEqual(cactus)
    for (let i = 0; i < 12; i++) {
      if (JSON.stringify((await desk(page)).props[0]) === JSON.stringify(sized)) break
      await page.keyboard.press('Control+y')
      await page.waitForTimeout(100)
    }
    expect((await desk(page)).props[0], 'redo brings it all back').toEqual(sized)
    // The garden up close, in the orbit view: F frames the picked cactus (Delete
    // put it down, so it is picked again, by clicking it again).
    const again = (await desk(page)).props[0] as Prop
    await clickAt(
      page,
      await debug(page, 'screenOf', again.pos[0], again.pos[1] + 5, again.pos[2]),
      'the cactus crown, again',
    )
    await expect.poll(async () => (await desk(page)).propPicked).toBe(0)
    await page.keyboard.press('t')
    await page.waitForTimeout(300)
    await page.keyboard.press('f')
    await page.waitForTimeout(1_500)
    await photo(page, 'props-desk-garden-framed.png')
    // And in on it with the wheel, at the cactus, until the orbit is close.
    for (let i = 0; i < 20; i++) {
      const d = (await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2: { editor(): { desk: { camera: { distance: number } } } }
        }
        return w.__ff2.editor().desk.camera.distance
      })) as number
      if (i === 0) console.log(`[DEV-504] framed on the cactus: the orbit is ${d.toFixed(0)} m out`)
      if (d < 140) break
      const c = (await desk(page)).props[0] as Prop
      const s = await debug(page, 'screenOf', c.pos[0], c.pos[1] + 4, c.pos[2])
      if (s) await page.mouse.move(s.x, s.y)
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(1_200)
    await photo(page, 'props-desk-garden.png')
    await page.keyboard.press('t')
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await desk(page)).propPicked).toBeNull()

    // The oblique photograph: out of top-down, the garden and the line behind.
    await page.keyboard.press('t')
    await page.waitForTimeout(300)
    const g0 = at(70, 20)
    const gy = (await debug(page, 'groundAt', g0[0], g0[1])) as number
    const garden = await debug(page, 'screenOf', g0[0], gy, g0[1])
    if (garden) {
      await page.mouse.move(garden.x, garden.y)
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, 240)
        await page.waitForTimeout(120)
      }
    }
    await page.waitForTimeout(1_500)
    await photo(page, 'props-desk.png')
    const made = await desk(page)
    expect(made.valid, 'the course flies').toBe(true)

    // ── the draft survives a RELOAD ─────────────────────────────────────
    await page.waitForTimeout(1_000) // past the autosave
    await openEditor(page)
    await expect
      .poll(async () => (await desk(page)).props.length, { timeout: 30_000 })
      .toBe(made.props.length)
    const reopened = await desk(page)
    expect(reopened.props).toEqual(made.props)
    expect(reopened.courseId).toBe(made.courseId)

    // ── and the LINK ────────────────────────────────────────────────────
    await openMenu(page, 'share')
    await page.locator('[data-editor="copy-link"]').click()
    await expect(page.locator('#editor-panel')).toHaveAttribute('data-link', /#c=/, {
      timeout: 10_000,
    })
    const link = (await page.locator('#editor-panel').getAttribute('data-link')) as string
    const fromLink = await readCourseToken(courseTokenIn(new URL(link).hash) as string)
    expect(fromLink.ok).toBe(true)
    if (!fromLink.ok) return
    expect(fromLink.course.props?.length).toBe(made.props.length)
    expect(playerCourseId(fromLink.course)).toBe(made.courseId)
    console.log(`[DEV-504] the link with ${made.props.length} props: ${link.length} characters`)

    // What the desk drew, before it flies.
    await expect
      .poll(async () => (await desk(page)).propsDrawn, { timeout: 60_000 })
      .toBe(made.props.length)
    const deskDrawn: number[][] = []
    for (let i = 0; i < made.props.length; i++) {
      deskDrawn.push((await debug(page, 'propMatrix', i)) as number[])
    }

    // ── FLY: the world draws each where the desk drew it ────────────────
    const skyColliders = await landmarkColliders(page)
    await page.locator('[data-editor="fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    const world = await worldProps(page)
    const flown = world.flatMap((w) => w.matrices)
    expect(flown.length, 'the world draws every placed prop').toBe(made.props.length)
    expect(
      world.filter((w) => !w.visible).map((w) => w.name),
      'and every one of them is visible',
    ).toEqual([])
    // Each desk matrix has one world matrix it equals (the world groups by mesh).
    for (const [i, m] of deskDrawn.entries()) {
      const match = flown.some((w) => w.every((v, k) => Math.abs(v - (m[k] as number)) < 0.01))
      expect(match, `${made.props[i]?.kind} is drawn in flight where the desk drew it`).toBe(true)
    }
    const flyColliders = await landmarkColliders(page)
    console.log(
      `[DEV-504] landmark colliders: the sky's world ${skyColliders}, the course's ${flyColliders}`,
    )
    // Solid, as landmarks: one landmark collider each, over the island's own.
    expect(skyColliders).not.toBeNull()
    expect((flyColliders as number) - (skyColliders as number), 'one collider per prop').toBe(
      made.props.length,
    )

    // The ship on its pad, the garden ahead: the chase view, in the countdown.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await hold(page, 'v', 120)
    await page.waitForTimeout(1_500)
    await photo(page, 'props-flight-pad.png')
    await hold(page, 'Enter', 150)
    // In the countdown the chase camera LOOKS round and down, a burst of eight,
    // to the garden beside the pad's stack (the mouse turns the arm: DEV-070's
    // pointer lock, taken as a player takes it, and let go after). The garden
    // is in the last frames, low on the left.
    await page.waitForTimeout(600)
    await page.mouse.move(900, 360)
    await captureCanvas(page)
    // movementX is the difference between moves, so the pointer walks on
    // one way and never back (a move back would turn the arm back).
    let mx = 900
    let my = 360
    for (let k = 0; k < 8; k++) {
      for (let i = 0; i < 2; i++) {
        mx -= 20
        my += 12 // and down, over the stack's edge to the shore
        await page.mouse.move(mx, my)
      }
      await page.waitForTimeout(150)
      await photo(page, `props-flight-look-${k}.png`)
    }
    await releasePointer(page)
    await page.waitForTimeout(3_000)
    // Past the garden: a burst, since the frames lag the probe and the garden
    // is beside the run-in for about a second.
    await page.keyboard.down('Space')
    for (let k = 0; k < 4; k++) {
      await page.waitForTimeout(500)
      await photo(page, `props-flight-away-${k}.png`)
    }
    await page.keyboard.up('Space')

    // ── Back to editor: the world's copy hidden, the desk's drawn ───────
    await hold(page, 'Backspace')
    for (let i = 0; i < 10; i++) await hold(page, 'ArrowDown', 120)
    await hold(page, 'Enter', 300)
    await waitForEditor(page)
    await expect
      .poll(async () => (await worldProps(page)).filter((w) => w.visible).length, {
        timeout: 10_000,
      })
      .toBe(0)
    expect((await desk(page)).propsDrawn).toBe(made.props.length)
    expect(pageErrors).toEqual([])
  })
})
