/**
 * tests/e2e/fixtures/life.ts — the life pass's shared measuring kit (DEV-448).
 * Written for the crowds, which DEV-463 cut; the leapers' spec (DEV-449) uses
 * every export, so it stays whole.
 *
 * A still camera over a course's start, a way to stand beside a thing and
 * look at it, and the three readings every life row reports: an exact
 * `renderer.info` delta on one frame (the group hidden, visible either side),
 * a frame time the same way, and the program count.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { firstPress } from './landing'

/** A still camera over the start of `mission`, the world built round it (`?view=cam`). */
export const bootStill = async (page: Page, mission: string, query: string): Promise<void> => {
  const level = JSON.parse(
    fs.readFileSync(path.join('content', 'levels', `${mission}.json`), 'utf8'),
  ) as { spawn: { pos: number[] } }
  const [x, , z] = level.spawn.pos as [number, number, number]
  await page.goto(
    `/?xr=off&ride=0&mission=${mission}&${query}` +
      `&view=cam&eye=${x.toFixed(1)},200,${z.toFixed(1)}&look=${(x + 100).toFixed(1)},116,${z.toFixed(1)}`,
  )
  await firstPress(page)
  await expect(page.locator('body')).toHaveAttribute('data-terrain-ready', 'true', {
    timeout: 240_000,
  })
}

/** Put the still camera at `eye` looking at `at`, THREE world. It stays put under `?view=cam`. */
export const stand = (
  page: Page,
  eye: readonly [number, number, number],
  at: readonly [number, number, number],
): Promise<void> =>
  page.evaluate(
    ({ eye: e, at: a }) => {
      const cam = (
        globalThis as unknown as {
          __ff2: {
            render: {
              camera: {
                position: { set: (x: number, y: number, z: number) => void }
                lookAt: (x: number, y: number, z: number) => void
                updateMatrixWorld: () => void
              }
            }
          }
        }
      ).__ff2.render.camera
      cam.position.set(e[0], e[1], e[2])
      cam.lookAt(a[0], a[1], a[2])
      cam.updateMatrixWorld()
    },
    { eye, at },
  )

/** `renderer.info.render` calls and triangles over `frames` frames, median. */
export const census = async (
  page: Page,
  frames: number,
): Promise<{ calls: number; tris: number }> => {
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

/**
 * What the object called `name` adds to one frame: shown, then hidden, on
 * ADJACENT frames, `pairs` times, and the median of the differences.
 *
 * `census` either side of a hide is exact only while nothing else moves, and
 * on a world with birds crossing the view and chunks settling it is not: one
 * load read 252 calls shown, 246 hidden, 247 shown again. Pairing neighbours
 * cancels whatever drifts slower than two frames — and each sample is
 * shown-hidden-shown, the hidden read against the MEAN of its two neighbours,
 * because shown-then-hidden alone read a steady ~50 triangles too many on two
 * worlds (a drift, always the same sign, entered every pair). Two frames per
 * state, so each read is of a frame drawn wholly after the switch.
 */
export const pairedDelta = (
  page: Page,
  name: string,
  pairs: number,
): Promise<{ calls: number; tris: number }> =>
  page.evaluate(
    async ({ name: n, pairs: count }) => {
      const w = globalThis as unknown as {
        __ff2: {
          render: {
            renderer: { info: { render: { calls: number; triangles: number } } }
            scene: { getObjectByName: (n: string) => { visible: boolean } | undefined }
          }
        }
      }
      const g = w.__ff2.render.scene.getObjectByName(n)
      if (!g) return { calls: Number.NaN, tris: Number.NaN }
      const info = w.__ff2.render.renderer.info.render
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      const calls: number[] = []
      const tris: number[] = []
      const read = async (v: boolean) => {
        g.visible = v
        await frame()
        await frame()
        return { c: info.calls, t: info.triangles }
      }
      for (let i = 0; i < count; i++) {
        const a = await read(true)
        const h = await read(false)
        const b = await read(true)
        calls.push((a.c + b.c) / 2 - h.c)
        tris.push((a.t + b.t) / 2 - h.t)
      }
      g.visible = true
      const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
      return { calls: mid(calls), tris: mid(tris) }
    },
    { name, pairs },
  )

/** Median frame interval over `frames` frames, ms. Only meaningful with vsync off. */
export const frameMs = (page: Page, frames: number): Promise<number> =>
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

/** Show or hide the scene object called `name`. */
export const setVisible = (page: Page, name: string, visible: boolean): Promise<void> =>
  page.evaluate(
    ({ name: n, visible: v }) => {
      const g = (
        globalThis as unknown as {
          __ff2: {
            render: {
              scene: { getObjectByName: (n: string) => { visible: boolean } | undefined }
            }
          }
        }
      ).__ff2.render.scene.getObjectByName(n)
      if (g) g.visible = v
    },
    { name, visible },
  )

/** Programs the renderer holds now. A count SO FAR — read it at the same point of every load. */
export const programCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { programs: unknown[] | null } } } }
        }
      ).__ff2.render.renderer.info.programs?.length ?? -1,
  )

/**
 * Which of `points` land on the canvas, and how many pixels `size` metres
 * spans at each, by the camera's own two matrices. Sorted biggest first.
 */
export const onScreen = (
  page: Page,
  points: readonly { x: number; y: number; z: number }[],
  size: number,
): Promise<{ px: number; dist: number }[]> =>
  page.evaluate(
    ({ points: pts, size: s }) => {
      const w = globalThis as unknown as {
        __ff2: {
          render: {
            camera: {
              matrixWorldInverse: { elements: number[] }
              projectionMatrix: { elements: number[] }
            }
            renderer: { domElement: { clientWidth: number } }
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
      const out: { px: number; dist: number }[] = []
      for (const p of pts) {
        const view = apply(cam.matrixWorldInverse.elements, p.x, p.y, p.z)
        const clip = apply(cam.projectionMatrix.elements, view.x, view.y, view.z)
        if (clip.w <= 0) continue
        if (Math.abs(clip.x / clip.w) > 0.9 || Math.abs(clip.y / clip.w) > 0.9) continue
        const px =
          Math.abs(((s * (cam.projectionMatrix.elements[0] as number)) / clip.w) * 0.5) * width
        out.push({ px, dist: Math.hypot(view.x, view.y, view.z) })
      }
      return out.sort((a, b) => b.px - a.px)
    },
    { points, size },
  )
