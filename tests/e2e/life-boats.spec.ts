/**
 * tests/e2e/life-boats.spec.ts — DEV-447, the moored boats, in the real build.
 *
 * The unit tests hold the rule (where), the flotation arithmetic (how high)
 * and the rebuilt sea triangle against a soup built by the real functions.
 * What only the running game can say:
 *
 *   · the triangle a boat floats on is in the OCEAN'S OWN GEOMETRY — the chunk
 *     the terrain worker built, subdivided and jittered, looked up vertex by
 *     vertex in the live `world-ocean` group. That is the premise of the whole
 *     row (LOD 0, the 8x split, the frame), checked where it could be false. It
 *     holds for every boat on a LOD 0 chunk; a boat further off than the
 *     ocean's LOD band is on a coarser chunk and is not (see the row);
 *   · they are there on Anniversary, NOT on Classic (and Classic fetches
 *     nothing), and quality `low` drops them;
 *   · WHAT THEY COST: an exact `renderer.info` delta on one frame by hiding the
 *     group, twice visible either side (the traffic spec's method), a frame
 *     time the same way, and the program count against a load with the
 *     feature pinned off;
 *   · and what they LOOK like, from the cockpit on the route and from a stand
 *     beside one — a feature too small to see has been rendered, not shipped
 *     (DEV-044).
 *
 * The measurements stand at a fixed camera (`?view=cam`, moved by hand to a
 * stand over the start's boats) so every arm is the same frame; the cockpit
 * photographs fly the course under the autopilot.
 *
 * `@gpu`, hydrated assets (the two GLBs are `staged` until the R2 push).
 * Frames go to `LIFE_SHOT_DIR`, not `test-results/`, which Playwright wipes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const SHOT_DIR = process.env.LIFE_SHOT_DIR ?? 'test-results/life'
const PIN_TAG = PINNED.replace(/[=&]/g, '_')

interface BoatProbe {
  kind: string
  x: number
  z: number
  scale: number
  surface: number
  keel: number
  yaw: number
  bowFacet: number[]
}

interface LifeProbe {
  wanted: boolean
  built: boolean
  visible: boolean
  boats: BoatProbe[]
  drawCalls: number
  triangles: number
  seaRestY: number | null
}

const life = (page: Page): Promise<LifeProbe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2: { life: () => LifeProbe | null } }
    return w.__ff2.life()
  })

/** A still camera over the start of `mission`, the world built round it. */
const bootStill = async (page: Page, mission: string, query: string): Promise<void> => {
  const level = JSON.parse(
    fs.readFileSync(path.join('content', 'levels', `${mission}.json`), 'utf8'),
  ) as { spawn: { pos: number[] } }
  const [x, , z] = level.spawn.pos as [number, number, number]
  await page.goto(
    `/?xr=off&ride=0&mission=${mission}&${query}` +
      `&view=cam&eye=${x.toFixed(1)},200,${z.toFixed(1)}&look=${(x + 100).toFixed(1)},116,${z.toFixed(1)}`,
  )
  await firstPress(page)
  await missionReady(page, 240_000)
}

/** Stand `back` metres off boat `i` (toward the spawn side), `up` metres up, looking at it. */
const aimAt = (page: Page, i: number, back: number, up: number): Promise<void> =>
  page.evaluate(
    ({ idx, back: b, up: u }) => {
      const w = globalThis as unknown as {
        __ff2: {
          life: () => LifeProbe | null
          render: {
            camera: {
              position: { set: (a: number, b: number, c: number) => void }
              lookAt: (a: number, b: number, c: number) => void
              updateMatrixWorld: () => void
            }
          }
        }
      }
      const boat = w.__ff2.life()?.boats[idx]
      if (!boat) return
      // Broadside: the hull's long axis is (cos yaw, 0, -sin yaw).
      const sx = Math.sin(boat.yaw)
      const sz = Math.cos(boat.yaw)
      const cam = w.__ff2.render.camera
      cam.position.set(boat.x + sx * b, boat.surface + u, boat.z + sz * b)
      cam.lookAt(boat.x, boat.surface + 0.5, boat.z)
      cam.updateMatrixWorld()
    },
    { idx: i, back, up },
  )

/** `renderer.info.render` calls and triangles over `frames` frames, median. */
const census = async (page: Page, frames: number): Promise<{ calls: number; tris: number }> => {
  const s = await page.evaluate(async (n) => {
    const w = globalThis as unknown as {
      __ff2: { render: { renderer: { info: { render: { calls: number; triangles: number } } } } }
    }
    const calls: number[] = []
    const tris: number[] = []
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      calls.push(w.__ff2.render.renderer.info.render.calls)
      tris.push(w.__ff2.render.renderer.info.render.triangles)
    }
    return { calls, tris }
  }, frames)
  const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
  return { calls: mid(s.calls), tris: mid(s.tris) }
}

/** Median frame interval over `frames` frames, ms. Only meaningful with vsync off. */
const frameMs = (page: Page, frames: number): Promise<number> =>
  page.evaluate(async (n) => {
    const t: number[] = []
    let last = performance.now()
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      const now = performance.now()
      t.push(now - last)
      last = now
    }
    t.sort((a, b) => a - b)
    return t[Math.floor(t.length / 2)] as number
  }, frames)

const setLifeVisible = (page: Page, visible: boolean): Promise<void> =>
  page.evaluate((v) => {
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          scene: { getObjectByName: (n: string) => { visible: boolean } | undefined }
        }
      }
    }
    const g = w.__ff2.render.scene.getObjectByName('life:boats')
    if (g) g.visible = v
  }, visible)

const programCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { programs: unknown[] | null } } } }
        }
      ).__ff2.render.renderer.info.programs?.length ?? -1,
  )

/**
 * Where each boat lands on the canvas, and how many pixels its hull spans —
 * by the camera's own two matrices, as `ambient-traffic.spec.ts` does it.
 */
const boatsOnScreen = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        life: () => LifeProbe | null
        render: {
          camera: {
            matrixWorldInverse: { elements: number[] }
            projectionMatrix: { elements: number[] }
          }
          renderer: { domElement: { clientWidth: number; clientHeight: number } }
        }
      }
    }
    const cam = w.__ff2.render.camera
    const width = w.__ff2.render.renderer.domElement.clientWidth
    const apply = (m: number[], x: number, y: number, z: number) => ({
      x: (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
      y: (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
      z: (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
      w: (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number),
    })
    const out: { kind: string; px: number; dist: number }[] = []
    for (const b of w.__ff2.life()?.boats ?? []) {
      const view = apply(cam.matrixWorldInverse.elements, b.x, b.surface, b.z)
      const clip = apply(cam.projectionMatrix.elements, view.x, view.y, view.z)
      if (clip.w <= 0) continue
      const ndcX = clip.x / clip.w
      const ndcY = clip.y / clip.w
      if (Math.abs(ndcX) > 0.9 || Math.abs(ndcY) > 0.9) continue
      // A hull's LENGTH at this range, in pixels: ~3 m of mesh times its scale.
      const len = 3 * b.scale
      const px =
        Math.abs(((len * (cam.projectionMatrix.elements[0] as number)) / clip.w) * 0.5) * width
      out.push({ kind: b.kind, px, dist: Math.hypot(view.x, view.y, view.z) })
    }
    return out.sort((a, b) => b.px - a.px)
  })

test.describe('@gpu the life pass — DEV-447, the boats', () => {
  test.setTimeout(600_000)

  test('they float on a triangle the OCEAN drew, and they cost what they cost', async ({
    page,
  }) => {
    // `oceanRings=0`: the premise below searches the plate's chunk vertex arrays
    // for the bow's triangle. DEV-339's rings displace on the GPU and keep no such
    // array, but every ring vertex IS the plate's at the same wave time, bit for
    // bit (`tests/unit/ocean-ring-lattice.test.ts`), so a boat on the plate's
    // triangle is on the rings' too. Edit that oracle and this pin stops holding.
    await bootStill(page, 'int_01_hoverJet', `edition=anniversary&oceanRings=0&${PINNED}`)
    await expect.poll(async () => (await life(page))?.built, { timeout: 60_000 }).toBe(true)
    const p = (await life(page)) as LifeProbe
    console.log(
      `DEV-447 int_01_hoverJet: ${p.boats.length} boats, ${p.drawCalls} draws, ${p.triangles} tris`,
    )
    for (const b of p.boats) {
      console.log(
        `  ${b.kind.padEnd(9)} x ${b.x.toFixed(0).padStart(6)} z ${b.z.toFixed(0).padStart(6)}  ` +
          `scale ${b.scale.toFixed(2)}  surface ${b.surface.toFixed(2)}  keel ${b.keel.toFixed(2)}`,
      )
    }
    expect(p.wanted).toBe(true)
    expect(p.visible).toBe(true)
    expect(p.boats.length).toBeGreaterThanOrEqual(6)
    // Two kinds, one draw each (a kind with no boat placed draws nothing).
    expect(p.drawCalls).toBe(new Set(p.boats.map((b) => b.kind)).size)
    for (const b of p.boats) {
      // The keel sits UNDER the drawn surface by its draft; the surface is the
      // sea's, 116 m give or take its bob and chop (viewpoints.ts: 108-123).
      expect(b.keel).toBeLessThan(b.surface)
      // The draft is in MESH metres (0.25–0.3 in the preset), so it scales with
      // the hull; half a metre of chop and tilt on top. DEV-532 grew the boats,
      // and a flat 1.5 m bound then read a 6.5x yacht's 1.6 m keel as sunk.
      expect(b.surface - b.keel).toBeLessThan(0.3 * b.scale + 0.5)
      expect(b.surface).toBeGreaterThan(100)
      expect(b.surface).toBeLessThan(130)
    }

    // ── the premise: the bow's triangle is one the ocean chunk DREW ──────
    const found = await page.evaluate((probe) => {
      interface Obj {
        name: string
        position: { x: number; y: number; z: number }
        scale: { x: number; y: number; z: number }
        geometry?: { getAttribute: (n: string) => { array: Float32Array } | undefined }
        traverse: (f: (o: Obj) => void) => void
      }
      const w = globalThis as unknown as {
        __ff2: {
          render: {
            scene: { getObjectByName: (n: string) => Obj | undefined }
            camera: { position: { x: number; z: number } }
          }
        }
      }
      const ocean = w.__ff2.render.scene.getObjectByName('world-ocean')
      if (!ocean) return null
      const chunks: { name: string; arr: Float32Array }[] = []
      ocean.traverse((o) => {
        const a = o.geometry?.getAttribute('position')
        if (a) chunks.push({ name: o.name, arr: a.array })
      })
      const cam = w.__ff2.render.camera.position
      return probe.boats.map((b) => {
        let hits = 0
        for (let k = 0; k < 3; k++) {
          // World at rest -> the chunk's own frame (the plate's transform).
          const lx = ((b.bowFacet[k * 3] as number) - ocean.position.x) / ocean.scale.x
          const ly =
            ((b.bowFacet[k * 3 + 1] as number) - (probe.seaRestY as number)) / ocean.scale.y
          const lz = ((b.bowFacet[k * 3 + 2] as number) - ocean.position.z) / ocean.scale.z
          search: for (const c of chunks) {
            for (let i = 0; i < c.arr.length; i += 3) {
              if (
                Math.abs((c.arr[i] as number) - lx) < 1e-3 &&
                Math.abs((c.arr[i + 2] as number) - lz) < 1e-3 &&
                Math.abs((c.arr[i + 1] as number) - ly) < 1e-3
              ) {
                hits++
                break search
              }
            }
          }
        }
        return { hits, distance: Math.hypot(b.x - cam.x, b.z - cam.z) }
      })
    }, p)
    expect(found).not.toBeNull()
    const rows = found as { hits: number; distance: number }[]
    console.log(
      `  bow triangle in the ocean's own chunks: ${rows.map((r) => `${r.hits}/3 @${r.distance.toFixed(0)} m`).join(', ')}`,
    )
    // Every boat within the ocean's LOD band of the eye is on its LOD 0 chunk
    // (lodDistance 1800 m on both plates), and must be found there.
    const near = rows.filter((r) => r.distance < 1500)
    expect(near.length).toBeGreaterThan(0)
    expect(near.every((r) => r.hits === 3)).toBe(true)

    // ── the cost, at a stand where the start's boats are in the frame ────
    const spawn = (
      JSON.parse(
        fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
      ) as { spawn: { pos: number[] } }
    ).spawn.pos as [number, number, number]
    const nearest = p.boats
      .map((b, i) => ({ i, d: Math.hypot(b.x - spawn[0], b.z - spawn[2]) }))
      .sort((a, b) => a.d - b.d)[0] as { i: number }
    await aimAt(page, nearest.i, 90, 40)
    await page.waitForTimeout(500)
    const inFrame = await boatsOnScreen(page)
    console.log(`  cost stand: ${inFrame.length} boat(s) in frame`)
    const withA = await census(page, 40)
    await setLifeVisible(page, false)
    const without = await census(page, 40)
    await setLifeVisible(page, true)
    const withB = await census(page, 40)
    console.log(`  with boats   ${withA.calls} calls, ${withA.tris} tris`)
    console.log(`  boats hidden ${without.calls} calls, ${without.tris} tris`)
    console.log(`  with boats   ${withB.calls} calls, ${withB.tris} tris (repeat)`)
    console.log(
      `  DELTA        ${withA.calls - without.calls} calls, ${withA.tris - without.tris} tris`,
    )
    expect(Math.abs(withA.calls - withB.calls)).toBeLessThanOrEqual(2)
    expect(withA.calls - without.calls).toBeGreaterThan(0)
    expect(withA.calls - without.calls).toBeLessThanOrEqual(p.drawCalls)

    // Frame time A/B/A — meaningful only with vsync off (E2E_NO_VSYNC=1).
    const fA = await frameMs(page, 300)
    await setLifeVisible(page, false)
    const fOff = await frameMs(page, 300)
    await setLifeVisible(page, true)
    const fB = await frameMs(page, 300)
    console.log(
      `  frame ms (median of 300, vsync ${process.env.E2E_NO_VSYNC === '1' ? 'off' : 'ON'}): ` +
        `with ${fA.toFixed(2)} · hidden ${fOff.toFixed(2)} · with ${fB.toFixed(2)}`,
    )
    console.log(`  programs after the world, boats on: ${await programCount(page)}`)
  })

  test('the programs with the boats pinned off, for the delta', async ({ page }) => {
    await bootStill(page, 'int_01_hoverJet', `edition=anniversary&feature=life.boats:off&${PINNED}`)
    await page.waitForTimeout(3_000)
    const p = await life(page)
    expect(p?.built).toBe(false)
    expect(p?.drawCalls).toBe(0)
    console.log(`DEV-447 programs after the world, boats pinned OFF: ${await programCount(page)}`)
  })

  test('Classic places none and fetches none; quality low drops them', async ({ page }) => {
    const lifeFetches: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/assets/life/')) lifeFetches.push(r.url())
    })
    await bootStill(page, 'int_01_hoverJet', `edition=classic&${PINNED}`)
    await page.waitForTimeout(3_000)
    const c = await life(page)
    expect(c?.wanted).toBe(false)
    expect(c?.built).toBe(false)
    expect(c?.drawCalls).toBe(0)
    expect(lifeFetches).toEqual([])

    await bootStill(page, 'int_01_hoverJet', 'edition=anniversary&adaptive=0&quality=low')
    await page.waitForTimeout(3_000)
    const low = await life(page)
    expect(low?.wanted).toBe(false)
    expect(low?.drawCalls).toBe(0)
  })

  for (const mission of ['int_01_hoverJet', 'hoverJet_kauai_beg']) {
    test(`photographs: from the cockpit on ${mission}, and from beside a boat`, async ({
      page,
    }) => {
      test.setTimeout(900_000)
      fs.mkdirSync(SHOT_DIR, { recursive: true })

      // Beside one first, at a still camera: the look, close.
      await bootStill(page, mission, `edition=anniversary&${PINNED}`)
      await expect.poll(async () => (await life(page))?.built, { timeout: 60_000 }).toBe(true)
      const p = (await life(page)) as LifeProbe
      console.log(`DEV-447 ${mission}: ${p.boats.length} boats`)
      const kinds = [...new Set(p.boats.map((b) => b.kind))]
      for (const kind of kinds) {
        const i = p.boats.findIndex((b) => b.kind === kind)
        // Both broadsides: a moored boat is metres off a cliff, and a stand on
        // the landward side is inside the rock. One of the two is on the water.
        for (const [label, back, up] of [
          ['close-a', 16, 1.5],
          ['close-b', -16, 1.5],
          ['stand-a', 70, 25],
          ['stand-b', -70, 25],
        ] as const) {
          await aimAt(page, i, back, up)
          await page.waitForTimeout(600)
          const file = path.join(SHOT_DIR, `boats-${label}-${kind}-${mission}-${PIN_TAG}.png`)
          await page.screenshot({ path: file })
          console.log(`  ${label} shot ${file}`)
        }
      }

      // From the cockpit: fly the course and keep the frames where a boat is
      // biggest on the canvas, sampled every half second.
      await page.goto(
        `/?xr=off&title=0&menu=0&edition=anniversary&autopilot=1&mission=${mission}&${PINNED}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
      await focusCanvas(page)
      await expect.poll(async () => (await life(page))?.built, { timeout: 60_000 }).toBe(true)
      const held = await drawState(page)
      console.log(`  ${drawStateLine(held)}`)
      let taken = 0
      let best = 0
      for (let t = 0; t < 240 && taken < 3; t++) {
        await page.waitForTimeout(500)
        // Not past the finish: the results plate stands in the frame there.
        if ((await page.getAttribute('body', 'data-finished')) === 'true') break
        const on = await boatsOnScreen(page)
        const top = on[0]
        if (!top || top.px < Math.max(8, best * 1.4)) continue
        best = top.px
        expect(drawStateDiff(held, await drawState(page))).toEqual([])
        const file = path.join(SHOT_DIR, `boats-cockpit-${mission}-${taken}-${PIN_TAG}.png`)
        await page.screenshot({ path: file })
        console.log(
          `  cockpit shot ${file}: ${on.length} boat(s) in frame, nearest ${top.kind} ` +
            `${top.dist.toFixed(0)} m, ~${top.px.toFixed(0)} px long`,
        )
        taken++
      }
      console.log(
        `  ${taken} cockpit frame(s) with a boat in them (largest ~${best.toFixed(0)} px)`,
      )
    })
  }
})
