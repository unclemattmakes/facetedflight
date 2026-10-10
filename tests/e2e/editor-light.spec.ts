/**
 * A player course's sun and tint, set in the editor as a person sets them.
 * DEV-476 (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
 *
 * Matt: *"would love to change time-of-day and lighting tint settings"*, and
 * his answer, *"sun sliders plus a tint … saved in the course"*. Every step is
 * a GESTURE with real pointer events, never a call into the editor in place of
 * one (the brief's ground rule):
 *
 *  · in by the title's door (COURSES → MAKE A COURSE), to int_01's island;
 *  · a point clicked on the sea beside Simonet's one live rock
 *    (`Spire_B_w_Collision`), F to bring the eye to it, Escape to put the
 *    gizmo away — so the rock fills a patch of the frame; then Ctrl+Z takes
 *    the point back (the eye stays), so the course draws nothing there;
 *  · the LIGHT group opened with a click, and its SUN DIRECTION slider
 *    dragged, pressed on its thumb, to put the sun on the camera's left, and
 *    then on its right;
 *  · each time, the rock's two halves on screen are MEASURED in the picture:
 *    with the sun on the left the left half is the brighter, on the right the
 *    right half — a positive reading both ways, not an absence;
 *  · the release re-bakes the island's far-shadow and sky-visibility maps
 *    (the game says so, with what it cost), the drag is ONE undo step, and
 *    the course holds the light;
 *  · then dawn, noon and dusk over the whole island, photographed.
 *
 * Photographs go to `EDITOR_LIGHT_PHOTOS` (or test-results). The tier is
 * pinned in the URL (`fixtures/quality-pin.ts`). Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { clickCanvasAt } from './fixtures/canvas'
import { collectPageErrors, openEditorFromTitle } from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_LIGHT_PHOTOS ?? path.join('test-results', 'editor-light')

type V3 = [number, number, number]

interface LightProbe {
  light: { sunAzimuth: number; sunElevation: number; tint: V3; tintAmount: number } | null
  lightShown: { azimuth: number; elevation: number }
  lightHeld: boolean
  sky: string
  groundReady: boolean
  selection: number | null
  points: V3[]
  undoDepth: number
  camera: { position: V3; target: V3; direction: V3 }
}
interface EditorProbe {
  editing: boolean
  desk: LightProbe | null
  sunBake: { farShadowMs: number; skyVisibilityMs: number; skyMs: number } | null
}

const editor = (page: Page): Promise<EditorProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.editor()
  }) as Promise<EditorProbe>
const desk = async (page: Page): Promise<LightProbe> => {
  const e = await editor(page)
  if (!e.desk) throw new Error('the desk has not loaded')
  return e.desk
}

const screenOf = (page: Page, p: V3): Promise<{ x: number; y: number } | null> =>
  page.evaluate(([x, y, z]) => {
    const w = globalThis as unknown as Ff2Global
    return (w.__ff2.editorDebug()?.screenOf(x, y, z) ?? null) as { x: number; y: number } | null
  }, p)

/**
 * The rock's world box: its instanced mesh (`landmark:spire-b.glb`, the one
 * live landmark on Simonet), instance 0, its geometry's bounds through the
 * instance's matrix and the mesh's world matrix. Read off the drawn mesh.
 */
const rockCorners = (page: Page): Promise<V3[]> =>
  page.evaluate(() => {
    type M4 = { multiplyMatrices(a: M4, b: M4): M4; elements: number[] }
    type Mesh = {
      count: number
      geometry: {
        boundingBox: {
          min: { x: number; y: number; z: number }
          max: { x: number; y: number; z: number }
        } | null
        computeBoundingBox(): void
      }
      matrixWorld: M4 & { constructor: new () => M4 }
      getMatrixAt(i: number, m: M4): void
      updateWorldMatrix(p: boolean, c: boolean): void
    }
    const w = globalThis as unknown as Ff2Global
    const mesh = w.__ff2.stage().getObjectByName('landmark:spire-b.glb') as Mesh | undefined
    if (!mesh || mesh.count < 1) return []
    mesh.updateWorldMatrix(true, false)
    mesh.geometry.computeBoundingBox()
    const b = mesh.geometry.boundingBox
    if (!b) return []
    const M = mesh.matrixWorld.constructor
    const inst = new M()
    mesh.getMatrixAt(0, inst)
    const m = new M().multiplyMatrices(mesh.matrixWorld, inst).elements
    const out: [number, number, number][] = []
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const e = m as number[]
          out.push([
            (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number),
            (e[1] as number) * x + (e[5] as number) * y + (e[9] as number) * z + (e[13] as number),
            (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number),
          ])
        }
    return out
  })

/**
 * Whether the desk draws the finish (`editor-finish-marker`: the hoop and its
 * label). The game's gate stands inside that hoop and comes and goes with the
 * same line, so a hidden marker is a frame with no finish in it.
 */
const finishDrawn = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    let o = w.__ff2.stage().getObjectByName('editor-finish-marker') ?? null
    if (!o) return false
    for (; o; o = o.parent) if (!o.visible) return false
    return true
  })

/** The rock's box on screen, CSS pixels, from its eight corners. */
const rockOnScreen = async (
  page: Page,
): Promise<{ x0: number; y0: number; x1: number; y1: number }> => {
  const corners = await rockCorners(page)
  expect(corners.length, "Simonet's rock is drawn").toBe(8)
  const pts = []
  for (const c of corners) {
    const s = await screenOf(page, c)
    expect(s, 'every corner of the rock is in front of the eye').not.toBeNull()
    pts.push(s as { x: number; y: number })
  }
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  }
}

type Png = { width: number; height: number; channels: number; data: Uint8Array }

/**
 * The rock's box as the browser composited it (a screenshot, decoded: a WebGL
 * readback without `preserveDrawingBuffer` would read an empty buffer).
 */
const shoot = async (
  page: Page,
  box: { x0: number; y0: number; x1: number; y1: number },
  file: string,
): Promise<Png> => {
  const clip = {
    x: Math.floor(box.x0),
    y: Math.floor(box.y0),
    width: Math.ceil(box.x1 - box.x0),
    height: Math.ceil(box.y1 - box.y0),
  }
  const buf = await page.screenshot({ clip })
  fs.writeFileSync(path.join(OUT, file), buf)
  return decodePngBuffer(buf, file) as Png
}

/**
 * Mean luma of the rock's LEFT and RIGHT halves in two pictures of it.
 *
 * The rock is told from the sea by colour: the sea is blue-violet (blue over
 * red) and the rock is brown, lit or not (red at or over blue). The mask is
 * the union over both pictures, inside the box's upper part (where the spire
 * stands above its own reflection) and right of its first sixth (where a
 * neighbouring island reaches in), so both pictures are measured over the SAME
 * pixels; and it is split at its own median column, so the halves are the
 * rock's.
 */
const rockHalves = (a: Png, b: Png): { left: number; right: number }[] => {
  const isRock = (p: Png, o: number): boolean =>
    (p.data[o] as number) >= (p.data[o + 2] as number) && (p.data[o] as number) > 20
  const lumaAt = (p: Png, o: number): number =>
    0.2126 * (p.data[o] as number) +
    0.7152 * (p.data[o + 1] as number) +
    0.0722 * (p.data[o + 2] as number)
  const cells: { x: number; o: number }[] = []
  for (let y = 0; y < Math.floor(a.height * 0.55); y++) {
    for (let x = Math.floor(a.width / 6); x < a.width; x++) {
      const o = (y * a.width + x) * a.channels
      const ob = (y * b.width + x) * b.channels
      if (isRock(a, o) || isRock(b, ob)) cells.push({ x, o })
    }
  }
  expect(cells.length, 'the rock is in the measured window').toBeGreaterThan(500)
  const xs = cells.map((c) => c.x).sort((p, q) => p - q)
  const mid = xs[Math.floor(xs.length / 2)] as number
  return [a, b].map((p) => {
    let l = 0
    let r = 0
    let nl = 0
    let nr = 0
    for (const c of cells) {
      const v = lumaAt(p, c.o)
      if (c.x < mid) {
        l += v
        nl++
      } else {
        r += v
        nr++
      }
    }
    return { left: l / nl, right: r / nr }
  })
}

/** A range's thumb, CSS pixels (as `editor-panel.spec.ts` finds one). */
const thumbAt = async (
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; box: { x: number; width: number } }> => {
  await page.locator(selector).scrollIntoViewIfNeeded()
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const frac = await page.locator(selector).evaluate((el) => {
    const i = el as HTMLInputElement
    const min = Number.parseFloat(i.min)
    const max = Number.parseFloat(i.max)
    return (Number.parseFloat(i.value) - min) / (max - min)
  })
  const thumb = 16
  return {
    x: box.x + thumb / 2 + frac * (box.width - thumb),
    y: box.y + box.height / 2,
    box: { x: box.x, width: box.width },
  }
}
const trackX = (box: { x: number; width: number }, f: number): number =>
  box.x + 8 + f * (box.width - 16)

/** Drag a range from its thumb to `value`, pressed, moved, released. */
const dragRangeTo = async (
  page: Page,
  selector: string,
  value: number,
  min: number,
  max: number,
): Promise<void> => {
  const t = await thumbAt(page, selector)
  await page.mouse.move(t.x, t.y)
  await page.mouse.down()
  await page.mouse.move(trackX(t.box, (value - min) / (max - min)), t.y, { steps: 12 })
  await page.mouse.up()
}

/**
 * The sun azimuth (the pad's heading convention: 0 toward −z, positive toward
 * −x) that stands the sun on the camera's LEFT or RIGHT, from its direction.
 */
const azimuthBeside = (dir: V3, side: 'left' | 'right'): number => {
  // right = dir × up, horizontal.
  const rx = -dir[2]
  const rz = dir[0]
  const s = side === 'right' ? 1 : -1
  const tx = s * rx
  const tz = s * rz
  return (Math.atan2(-tx, -tz) * 180) / Math.PI
}

test.describe('@gpu the course editor light', () => {
  test.setTimeout(600_000)

  test('the sun slider moves the lit side of a rock, re-bakes on release, and dawn, noon and dusk are photographed', async ({
    page,
  }) => {
    fs.mkdirSync(OUT, { recursive: true })
    const pageErrors = collectPageErrors(page)
    const bakes: string[] = []
    page.on('console', (m) => {
      if (m.text().includes('re-baked')) bakes.push(m.text())
    })

    // ── in by the title's door ─────────────────────────────────────────────
    await openEditorFromTitle(page)
    const start = await desk(page)
    expect(start.sky, 'the island with the rock').toBe('int_01_hoverJet')
    expect(start.light, 'a new course has no light of its own').toBeNull()

    // ── a point on the sea beside the rock, and F to go to it ──────────────
    await page.locator('[data-editor="top-down"]').click()
    const corners = await rockCorners(page)
    expect(corners.length).toBe(8)
    const foot = corners.reduce<V3>(
      (a, c) => [a[0] + c[0] / 8, Math.min(a[1], c[1]), a[2] + c[2] / 8],
      [0, Number.POSITIVE_INFINITY, 0],
    )
    // 120 m to the side of the rock: a point near it, not on it.
    const beside: V3 = [foot[0] + 120, foot[1], foot[2] + 120]
    const at = await screenOf(page, beside)
    expect(at, 'the sea beside the rock is on screen').not.toBeNull()
    // DEV-501: a new draft already holds the pad's anchored point, so the
    // click appends the NEXT point rather than the first.
    const before = (await desk(page)).points.length
    await clickCanvasAt(page, (at as { x: number }).x, (at as { y: number }).y)
    await expect.poll(async () => (await desk(page)).selection).toBe(before)
    await page.locator('[data-editor="top-down"]').click() // back to the orbit
    await page.keyboard.press('f')
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape') // the gizmo away, off the rock
    await expect.poll(async () => (await desk(page)).selection).toBeNull()
    // The point was only there to aim the eye: take it back. Since DEV-501 it
    // is the course's LAST point, so the finish stands on it (the game's gate,
    // the desk's orange hoop and its label) at the middle of the frame, inside
    // the window `rockHalves` measures — and that mask tells rock from sea by
    // colour, so it read the gate as rock and the right half as lit whichever
    // side the sun stood (bisected to DEV-501's core, a9946b5a; the rock
    // itself rendered the same). One undo step, and the eye does not move.
    // Checked, not assumed: nothing of the finish is drawn.
    await expect.poll(() => finishDrawn(page), 'the finish stands on the point').toBe(true)
    const eye = (await desk(page)).camera.position
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).points.length).toBe(before)
    await expect.poll(() => finishDrawn(page)).toBe(false)
    expect((await desk(page)).camera.position, 'the undo leaves the eye where F put it').toEqual(
      eye,
    )
    await page.waitForTimeout(400)
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    // The rock is a spire hundreds of metres tall: at the focus distance its
    // top runs off the frame. What is measured is the part of its box that is
    // on screen and left of the panel.
    const whole = await rockOnScreen(page)
    const box = {
      x0: Math.max(1, whole.x0),
      y0: Math.max(1, whole.y0),
      x1: Math.min(view.width - 321, whole.x1),
      y1: Math.min(view.height - 1, whole.y1),
    }
    console.info(
      `editor-light: the rock on screen ${JSON.stringify(box)} in ${view.width}x${view.height}; ` +
        `camera ${JSON.stringify((await desk(page)).camera)}`,
    )
    await page.screenshot({ path: path.join(OUT, 'rock-framed.png') })
    expect(box.x1 - box.x0, 'the rock is wide enough to measure').toBeGreaterThan(24)
    expect(box.y1 - box.y0, 'and tall enough').toBeGreaterThan(24)
    expect(box.x0 > 0 && box.y0 > 0 && box.x1 < view.width - 320 && box.y1 < view.height).toBe(true)

    // ── open the LIGHT group, as a person does ────────────────────────────
    await page.locator('[data-editor="light"]').click()
    await expect(page.locator('[data-editor="sun-direction"]')).toBeVisible()
    const dir = (await desk(page)).camera.direction
    // Up out of the long dawn shadows first: at 2016's 4° the islands round
    // the rock shade it from most headings, and a shadowed side is not a lit
    // one. The height slider, dragged like the rest.
    await dragRangeTo(page, '[data-editor="sun-height"]', 30, 0.5, 90)
    await expect.poll(async () => (await desk(page)).light?.sunElevation ?? 0).toBeGreaterThan(20)

    // ── the sun on the camera's LEFT ──────────────────────────────────────
    const leftAz = azimuthBeside(dir, 'left')
    await dragRangeTo(page, '[data-editor="sun-direction"]', leftAz, -180, 180)
    await expect.poll(async () => (await desk(page)).light).not.toBeNull()
    const lit1 = await desk(page)
    const key1 = await page.locator('body').getAttribute('data-editor-sun-baked')
    expect(key1, 'the release re-baked the sun maps').not.toBeNull()
    await page.waitForTimeout(500)
    const shotLeft = await shoot(page, box, 'rock-sun-left.png')

    // ── and on its RIGHT ──────────────────────────────────────────────────
    const rightAz = azimuthBeside(dir, 'right')
    await dragRangeTo(page, '[data-editor="sun-direction"]', rightAz, -180, 180)
    await expect
      .poll(async () => (await desk(page)).light?.sunAzimuth)
      .not.toBe(lit1.light?.sunAzimuth)
    const lit2 = await desk(page)
    await expect
      .poll(() => page.locator('body').getAttribute('data-editor-sun-baked'))
      .not.toBe(key1)
    await page.waitForTimeout(500)
    const shotRight = await shoot(page, box, 'rock-sun-right.png')
    const [left, right] = rockHalves(shotLeft, shotRight) as [
      { left: number; right: number },
      { left: number; right: number },
    ]
    console.info(
      `editor-light: rock halves, sun left az ${lit1.light?.sunAzimuth} → L ${left.left.toFixed(1)} ` +
        `R ${left.right.toFixed(1)}; sun right az ${lit2.light?.sunAzimuth} → L ${right.left.toFixed(1)} ` +
        `R ${right.right.toFixed(1)}`,
    )
    // Positive readings, both ways. With the sun on the left the left half is
    // the brighter; brought round to the right, the right half brightens and
    // the balance swings toward it. (The spire is not symmetric: its right
    // flank is a ridge that catches a right-hand sun on its upper faces, so
    // the halves come to about even rather than reversing; first run: L 61.5
    // R 41.8, then L 64.4 R 64.6.)
    expect(left.left - left.right, 'sun on the left: the left half is lit').toBeGreaterThan(8)
    expect(right.right - left.right, 'sun on the right: the right half brightens').toBeGreaterThan(
      8,
    )
    expect(
      right.right - right.left - (left.right - left.left),
      'the balance swings toward the sun',
    ).toBeGreaterThan(12)

    // ── the drag is ONE undo step, and the release re-baked with a cost ───
    const probe = await editor(page)
    expect(probe.sunBake, 'the game timed the re-bake').not.toBeNull()
    console.info(`editor-light: re-bake ${JSON.stringify(probe.sunBake)}; ${bakes.join(' | ')}`)
    const depth = (await desk(page)).undoDepth
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).undoDepth).toBe(depth - 1)
    await expect.poll(async () => (await desk(page)).light?.sunAzimuth).toBe(lit1.light?.sunAzimuth)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await desk(page)).light?.sunAzimuth).toBe(lit2.light?.sunAzimuth)

    // ── the tint, picked and dragged ──────────────────────────────────────
    await page.locator('[data-editor="tint-colour"]').fill('#ff8040')
    await dragRangeTo(page, '[data-editor="tint-amount"]', 0.4, 0, 1)
    await expect.poll(async () => (await desk(page)).light?.tintAmount ?? 0).toBeGreaterThan(0.3)
    const tinted = await desk(page)
    expect(tinted.light?.tint[0]).toBe(1)
    await page.locator('#editor-panel').screenshot({ path: path.join(OUT, 'panel-light.png') })

    // ── dawn, noon and dusk over the whole island ─────────────────────────
    await dragRangeTo(page, '[data-editor="tint-amount"]', 0, 0, 1)
    await expect.poll(async () => (await desk(page)).light?.tintAmount).toBe(0)
    await page.locator('[data-editor="frame"]').click()
    await page.waitForTimeout(800)
    const own = start.lightShown
    const shots: [string, number, number][] = [
      // Dawn well round the other way (150°, inside SkyJ's band); noon high
      // over 2016's own heading (its band reaches 58° there); dusk is 2016's.
      ['dawn', own.azimuth + 150, 3],
      ['noon', own.azimuth, 50],
      ['dusk', own.azimuth, 3],
    ]
    for (const [name, az, el] of shots) {
      const wrapped = ((((az + 180) % 360) + 360) % 360) - 180
      // The heading first, then the height: the sky's band is narrower high up,
      // and a height asked for at a heading on its edge is held down to it.
      await dragRangeTo(page, '[data-editor="sun-direction"]', wrapped, -180, 180)
      await dragRangeTo(page, '[data-editor="sun-height"]', el, 0.5, 90)
      await page.waitForTimeout(800)
      const d = await desk(page)
      console.info(
        `editor-light: ${name} at az ${d.light?.sunAzimuth} el ${d.light?.sunElevation}` +
          (d.lightHeld ? ' (held by the sky)' : ''),
      )
      await page.screenshot({ path: path.join(OUT, `island-${name}.png`) })
    }

    // ── the sky's own light, back ─────────────────────────────────────────
    await page.locator('[data-editor="sky-light"]').click()
    await expect.poll(async () => (await desk(page)).light).toBeNull()

    // ── every program linked ──────────────────────────────────────────────
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the editor frame drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(
      sweep.failed.map((x) => `#${x.id} ${x.type}`),
      'every program three holds linked',
    ).toEqual([])

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
