/**
 * The title screen's trees and flypast jets cast into the sun's map. DEV-359.
 *
 * Matt, 2026-09-24: *"titlescreen: trees and ai hoverjet needs shadows & bake
 * pass."* Until this row the map RAN on the title — `createSunShadows` turns
 * it and the sun's `castShadow` on at boot on Anniversary — and nothing was in
 * it: `sunShadows.attach` was only ever called by the MISSION builder, and the
 * flypast threw away the look that carries its jets' meshes.
 *
 * What this pins is the depth pass itself, not a flag: three calls an object's
 * `onBeforeShadow` immediately before it draws that object into a shadow map
 * (`WebGLShadowMap.renderObject`), after the layer test, the `castShadow`
 * test and the shadow camera's frustum cull. So a count above zero says the
 * forest was DRAWN into the map this frame, which is the thing a flag on a
 * `Group` once said and was wrong about (DEV-305). The hooks observe; nothing
 * in the game takes a different path for being watched.
 *
 * Two arms. Anniversary, pinned: the valley, its forest and both jets are
 * drawn into the map, and the forest and the land receive it. Classic: there
 * is no map at all and nothing is drawn into one — the title is 2016's there.
 *
 * Against the tree before DEV-359 the Anniversary arm fails on its first count:
 * the map runs every frame and draws nothing.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/title-shadows.spec.ts
 *
 * Tagged `@gpu`.
 */

import { bootReady } from './fixtures/boot'
import { knownRed } from './fixtures/known-red'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

interface Census {
  readonly mapOn: boolean
  readonly sunCasts: boolean
  readonly scatterMeshes: number
  readonly scatterReceive: number
  readonly chunkMeshes: number
  readonly chunkReceive: number
  readonly jetMeshes: number
  /** Depth draws observed over the sampling window, by class. */
  readonly drawn: { readonly scatter: number; readonly chunks: number; readonly jets: number }
}

/**
 * Hook every candidate caster's `onBeforeShadow`, let a second of frames go
 * by, and read what was drawn. The window is frames, not one frame, so the
 * jets — which fly a circuit — are counted wherever they are in it.
 */
const census = async (page: import('@playwright/test').Page): Promise<Census> =>
  page.evaluate(async () => {
    type O = {
      name?: string
      isMesh?: boolean
      isInstancedMesh?: boolean
      isDirectionalLight?: boolean
      castShadow?: boolean
      receiveShadow?: boolean
      children: O[]
      traverse: (f: (o: O) => void) => void
      onBeforeShadow?: () => void
    }
    const app = (
      globalThis as unknown as {
        __ff2: { stage: () => O; render: { renderer: { shadowMap: { enabled: boolean } } } }
      }
    ).__ff2
    const scene = app.stage()
    let valley: O | null = null
    let sunCasts = false
    const jets: O[] = []
    scene.traverse((o) => {
      if (o.name === 'title-valley') valley = o
      if (o.isDirectionalLight && o.castShadow) sunCasts = true
      if (o.name?.startsWith('title-jet:')) jets.push(o)
    })
    const drawn = { scatter: 0, chunks: 0, jets: 0 }
    const scatter: O[] = []
    const chunks: O[] = []
    const jetMeshes: O[] = []
    for (const child of (valley as O | null)?.children ?? []) {
      if (child.name?.startsWith('props:')) {
        child.traverse((o) => {
          if (o.isInstancedMesh) scatter.push(o)
        })
      } else if (child.isMesh) {
        chunks.push(child)
      }
    }
    for (const jet of jets) {
      jet.traverse((o) => {
        if (o.isMesh) jetMeshes.push(o)
      })
    }
    const hook = (list: O[], key: keyof typeof drawn) => {
      for (const o of list) {
        o.onBeforeShadow = () => {
          drawn[key]++
        }
      }
    }
    hook(scatter, 'scatter')
    hook(chunks, 'chunks')
    hook(jetMeshes, 'jets')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    return {
      mapOn: app.render.renderer.shadowMap.enabled,
      sunCasts,
      scatterMeshes: scatter.length,
      scatterReceive: scatter.filter((o) => o.receiveShadow).length,
      chunkMeshes: chunks.length,
      chunkReceive: chunks.filter((o) => o.receiveShadow).length,
      jetMeshes: jetMeshes.length,
      drawn: { ...drawn },
    }
  })

const settle = async (page: import('@playwright/test').Page, edition: string): Promise<void> => {
  await page.goto(`/?xr=off&edition=${edition}&${PINNED}`)
  await firstPress(page)
  await bootReady(page, 180_000)
  // The flypast is held out of the valley until the curtain has lifted.
  await page.waitForFunction(() => document.body.dataset.titleCurtain !== 'held', null, {
    timeout: 60_000,
  })
  await page.waitForTimeout(1_500)
}

test.describe('@gpu the title casts (DEV-359)', () => {
  test.setTimeout(300_000)

  test('Anniversary: the forest, the land and both jets are drawn into the sun map', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await settle(page, 'anniversary')
    const c = await census(page)
    console.info(`title-shadows anniversary: ${JSON.stringify(c)}`)
    expect(c.mapOn, 'the renderer has a shadow map').toBe(true)
    expect(c.sunCasts, 'the sun casts').toBe(true)
    // The premise first: there IS a forest and there ARE jets to count, or a
    // zero below would be a missing asset rather than a missing caster.
    expect(c.scatterMeshes, 'the title forest loaded').toBeGreaterThan(0)
    expect(c.jetMeshes, 'the flypast jets loaded').toBeGreaterThan(0)
    expect(c.drawn.scatter, "the title's trees are drawn into the sun map").toBeGreaterThan(0)
    expect(c.drawn.jets, 'the flypast jets are drawn into the sun map').toBeGreaterThan(0)
    expect(c.drawn.chunks, "the valley's own land is drawn into the sun map").toBeGreaterThan(0)
    // And they RECEIVE: every tree and every chunk, as a mission's do.
    expect(c.scatterReceive, 'every tree receives').toBe(c.scatterMeshes)
    expect(c.chunkReceive, 'every chunk receives').toBe(c.chunkMeshes)
    expect(problems.list(), 'page errors (a shader that failed to compile lands here)').toEqual([])
  })

  test('Classic: no map, and nothing is drawn into one', async ({ page }) => {
    knownRed('KR-09')
    const problems = watchPageErrors(page)
    await settle(page, 'classic')
    const c = await census(page)
    console.info(`title-shadows classic: ${JSON.stringify(c)}`)
    expect(c.scatterMeshes, 'the title forest loaded').toBeGreaterThan(0)
    expect(c.mapOn, 'no shadow map on Classic').toBe(false)
    expect(c.sunCasts, 'the sun casts nothing on Classic').toBe(false)
    expect(c.drawn, 'nothing drawn into a map').toEqual({ scatter: 0, chunks: 0, jets: 0 })
    expect(c.scatterReceive, 'no tree was given a receive flag').toBe(0)
    expect(problems.list(), 'page errors (a shader that failed to compile lands here)').toEqual([])
  })
})
