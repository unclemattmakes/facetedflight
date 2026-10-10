/**
 * The world seen from far above: the sea runs on past the game's far plane,
 * and the islands' long shadows run on past the far-shadow field.
 * DEV-497, DEV-498.
 *
 * The course editor frames the island from 3–10 km up. From there it showed
 * two seams that were in the world before the editor was:
 *
 *  · DEV-498: the ocean is built only inside the game's own 6 km far plane, a
 *    16 km square, and the desk's far plane reaches 14–22 km — so the sea
 *    ended in a straight edge with the sky beyond it. The desk now has the
 *    rest of the plate (`farSea` on the ocean's terrain), which a mission
 *    never builds.
 *  · DEV-497: the far-shadow field covers the LAND terrain only, and off it
 *    everything was lit — so a 4° sun's island shadows, 7 km long, stopped in
 *    a straight line at the field's edge: the "darker square" round the
 *    islands. The term now carries the ray on past the edge.
 *
 * Every reading is positive:
 *
 *  · a mission boot has no far sea (`far-sea` is not in the scene);
 *  · the editor has one, visible, and its far plane reaches it;
 *  · wheeled out, the TOP of the frame is sea, not sky: bluer than red;
 *  · top-down, the sea just past the field's DOWN-SUN edge is darker than the
 *    sea the same distance past its UP-SUN edge — in the islands' shadow;
 *  · every program three holds linked, with draw calls and programs > 0.
 *
 * Photographs go to `FAR_SEA_PHOTOS` (or test-results). Pinned tier. `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.FAR_SEA_PHOTOS ?? path.join('test-results', 'far-sea')

type Png = { width: number; height: number; channels: number; data: Uint8Array }

interface FarSea {
  present: boolean
  visible: boolean
  meshes: number
  triangles: number
  far: number
  reach: number
}

/** The far sea as the scene holds it, and the desk camera's far plane beside it. */
const farSea = (page: Page): Promise<FarSea> =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: a probe over three's own objects
    const w = globalThis as any
    const far = w.__ff2.stage().getObjectByName('far-sea')
    const out = { present: !!far, visible: false, meshes: 0, triangles: 0, far: 0, reach: 0 }
    if (!far) return out
    out.visible = far.visible
    const desk = w.__ff2.editor?.()?.desk
    if (desk) out.far = desk.camera.far
    let cx = 0
    let cz = 0
    // biome-ignore lint/suspicious/noExplicitAny: as above
    far.traverse((o: any) => {
      if (!o.isMesh) return
      out.meshes++
      out.triangles += o.geometry.getAttribute('position').count / 3
      o.geometry.computeBoundingBox()
    })
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
    // biome-ignore lint/suspicious/noExplicitAny: as above
    far.traverse((o: any) => {
      if (!o.isMesh) return
      o.updateWorldMatrix(true, false)
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
      box.minX = Math.min(box.minX, b.min.x)
      box.maxX = Math.max(box.maxX, b.max.x)
      box.minZ = Math.min(box.minZ, b.min.z)
      box.maxZ = Math.max(box.maxZ, b.max.z)
    })
    cx = (box.minX + box.maxX) / 2
    cz = (box.minZ + box.maxZ) / 2
    out.reach = Math.hypot(box.maxX - cx, box.maxZ - cz) // half the plate's diagonal
    return out
  })

const desk = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2: { editor(): { desk: Record<string, unknown> } } }
    return w.__ff2.editor().desk
  })

/** The LAND field's footprint, from the land chunks as drawn (the field is marched from them). */
const landBox = (
  page: Page,
): Promise<{ minX: number; maxX: number; minZ: number; maxZ: number; y: number }> =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const w = globalThis as any
    const land = w.__ff2.stage().getObjectByName('world-terrain')
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, y: 0 }
    // biome-ignore lint/suspicious/noExplicitAny: as above
    land.traverse((o: any) => {
      if (!o.isMesh || !/^chunk_/.test(o.name)) return
      o.geometry.computeBoundingBox()
      o.updateWorldMatrix(true, false)
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
      box.minX = Math.min(box.minX, b.min.x)
      box.maxX = Math.max(box.maxX, b.max.x)
      box.minZ = Math.min(box.minZ, b.min.z)
      box.maxZ = Math.max(box.maxZ, b.max.z)
    })
    return box
  })

const screenOf = (
  page: Page,
  x: number,
  y: number,
  z: number,
): Promise<{ x: number; y: number } | null> =>
  page.evaluate(
    ([a, b, c]) => {
      const w = globalThis as unknown as {
        __ff2: { editorDebug(): { screenOf(x: number, y: number, z: number): unknown } | null }
      }
      return (w.__ff2.editorDebug()?.screenOf(a as number, b as number, c as number) ?? null) as {
        x: number
        y: number
      } | null
    },
    [x, y, z],
  )

const lumaAround = (p: Png, x: number, y: number, r = 3): number => {
  let s = 0
  let n = 0
  for (let j = Math.round(y) - r; j <= Math.round(y) + r; j++) {
    for (let i = Math.round(x) - r; i <= Math.round(x) + r; i++) {
      if (i < 0 || j < 0 || i >= p.width || j >= p.height) continue
      const o = (j * p.width + i) * p.channels
      s +=
        0.2126 * (p.data[o] as number) +
        0.7152 * (p.data[o + 1] as number) +
        0.0722 * (p.data[o + 2] as number)
      n++
    }
  }
  return n ? s / n : Number.NaN
}

const wheelOut = async (page: Page, ticks: number): Promise<void> => {
  const v = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.mouse.move((v.width - 320) / 2, v.height / 2)
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(900)
}

test.describe('@gpu the world from far above', () => {
  test.setTimeout(600_000)

  test('a mission builds no far sea; the editor has one to its far plane, and the long shadows run past the field', async ({
    page,
  }) => {
    fs.mkdirSync(OUT, { recursive: true })
    const watcher = watchPageErrors(page)

    // ── a mission: no far sea ──────────────────────────────────────────────
    await page.goto(`/?xr=off&audio=off&ride=0&menu=0&mission=int_01_hoverJet&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    const sea = await page.evaluate(
      () =>
        !!(
          globalThis as unknown as {
            __ff2: { stage(): { getObjectByName(n: string): unknown } }
          }
        ).__ff2
          .stage()
          .getObjectByName('world-ocean'),
    )
    expect(sea, 'the mission has its ocean').toBe(true)
    expect
      .soft((await farSea(page)).present, 'and no far sea: the game never builds it')
      .toBe(false)

    // ── the editor: a far sea, shown, and the far plane out to it ──────────
    await page.goto(`/?edit=1&xr=off&audio=off&${PINNED}`)
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', {
      timeout: 240_000,
    })
    await expect.poll(async () => (await desk(page)).groundReady, { timeout: 120_000 }).toBe(true)
    await expect
      .poll(async () => (await farSea(page)).present, { timeout: 30_000 })
      .toBe(true)
      .catch(() => {})
    await page.locator('[data-editor="frame"]').click()
    await page.waitForTimeout(1500)
    await wheelOut(page, 10)
    const fs1 = await farSea(page)
    console.info(`far-sea: ${JSON.stringify(fs1)}`)
    expect.soft(fs1.visible, 'shown while the editor draws').toBe(true)
    expect.soft(fs1.meshes, 'one mesh per LOD, a handful of draws').toBeGreaterThan(0)
    expect.soft(fs1.meshes).toBeLessThanOrEqual(6)
    // The plate is 262 km; half its diagonal is ~185 km.
    expect.soft(fs1.reach).toBeGreaterThan(100_000)
    expect
      .soft(fs1.far, 'the far plane reaches past the plate centre by its radius')
      .toBeGreaterThan(fs1.reach)

    // ── wheeled out: the top of the frame is sea, not sky ─────────────────
    const view = page.viewportSize() ?? { width: 1280, height: 720 }
    const outBuf = await page.screenshot({ path: path.join(OUT, 'zoomed-out.png') })
    const out = decodePngBuffer(outBuf, 'zoomed-out.png') as Png
    let seaPx = 0
    let all = 0
    for (let y = 4; y < 60; y++) {
      for (let x = 4; x < view.width - 330; x++) {
        const o = (y * out.width + x) * out.channels
        // The sea is blue over red at this sky; the sky here is red over blue.
        if ((out.data[o + 2] as number) > (out.data[o] as number)) seaPx++
        all++
      }
    }
    console.info(`far-sea: the frame's top band is ${((100 * seaPx) / all).toFixed(1)} % sea`)
    // Base (DEV-497/498 absent), same steps: 0.0 % sea. After: 87.4 %; the
    // rest is the top-left corner, where from 12 km up the frame looks almost
    // level and sees the PLATE's own far edge, 131 km out (2016's sea, shown
    // only because the editor's fog is off). See DEV-498.
    expect.soft(seaPx / all, "the frame's top band is sea").toBeGreaterThan(0.75)

    // ── top-down: the long shadows run on past the field (DEV-497) ────────
    await page.locator('[data-editor="frame"]').click()
    await page.waitForTimeout(1200)
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(1500)
    const d = await desk(page)
    const light = d.lightShown as { azimuth: number; elevation: number }
    const box = await landBox(page)
    const seaY = 116
    const topBuf = await page.screenshot({ path: path.join(OUT, 'top-down.png') })
    const top = decodePngBuffer(topBuf, 'top-down.png') as Png
    // int_01's sun stands to −x (its light TRAVELS toward +x), so the field's
    // +x edge is down-sun. 300 m past each edge, along the field's z span.
    const rows: { z: number; east: number; west: number; inside: number }[] = []
    for (let k = 1; k < 10; k++) {
      const z = box.minZ + ((box.maxZ - box.minZ) * k) / 10
      const e = await screenOf(page, box.maxX + 300, seaY, z)
      const wv = await screenOf(page, box.minX - 300, seaY, z)
      const i = await screenOf(page, box.maxX - 300, seaY, z)
      if (!e || !wv || !i) continue
      if (e.x > view.width - 330 || wv.x < 4) continue
      rows.push({
        z,
        east: lumaAround(top, e.x, e.y),
        west: lumaAround(top, wv.x, wv.y),
        inside: lumaAround(top, i.x, i.y),
      })
    }
    console.info(
      `far-sea: sun az ${light.azimuth} el ${light.elevation}; field x ${box.minX.toFixed(0)}..${box.maxX.toFixed(0)}; ` +
        rows
          .map(
            (r) =>
              `z ${r.z.toFixed(0)} E ${r.east.toFixed(1)} W ${r.west.toFixed(1)} in ${r.inside.toFixed(1)}`,
          )
          .join(' | '),
    )
    expect(rows.length, 'both edges on screen').toBeGreaterThan(5)
    const mean = (f: (r: (typeof rows)[number]) => number): number =>
      rows.reduce((a, r) => a + f(r), 0) / rows.length
    // Positive: down-sun of the field is darker than up-sun of it, by more
    // than the sea's own variation. Base, same stand: 4.6 levels (the view's
    // own east-west drift); after: 20.6, and the east reading meets the sea
    // just inside the field's edge (108.0 against 107.5 at z -1410).
    expect
      .soft(
        mean((r) => r.west - r.east),
        'the sea past the down-sun edge is in shadow',
      )
      .toBeGreaterThan(8)

    // ── every program linked ──────────────────────────────────────────────
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the editor frame drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(
      sweep.failed.map((x) => `#${x.id} ${x.type}`),
      'every program three holds linked',
    ).toEqual([])
    expect(watcher.list(), 'no page errors, console errors or failed requests').toEqual([])
  })
})
