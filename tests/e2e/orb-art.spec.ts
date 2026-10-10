/**
 * tests/e2e/orb-art.spec.ts — 2016's energy orb in the world, photographed and
 * counted (DEV-327).
 *
 * The unit suite owns the mesh (`orb-art.test.ts` against the real GLB) and the
 * placement (`pad-art.test.ts`). What it cannot say is that the running game
 * FETCHES the art and hangs it on — `attachOrbArt` is an unawaited GLB behind
 * `boot/app.ts` — nor what the orb looks like. So this boots the Free Flight
 * mission, stands a pinned camera beside an orb, and:
 *
 *  * photographs it twice, near and mid, for a human to look at (set
 *    `ORB_ART_SHOT_DIR`, and `ORB_ART_ARM` to name the run). The pictures are
 *    taken BEFORE the assertions, so a run on the old art leaves its frames
 *    behind while it fails;
 *  * counts what the orb field costs, per frame: every render of every mesh in
 *    the `orbs` group, caught by a temporary `onAfterRender`, times its passes
 *    (three draws a transparent double-sided material twice) and its
 *    instances. The first cut took the whole frame's `renderer.info` with the
 *    group shown and then hidden, and read -7 calls and -269,048 triangles for
 *    the orbs: the terrain was still streaming in under a fixed camera, and
 *    that difference was about the terrain. Counting the orbs' own renders
 *    cannot see the terrain. Counts of a frame survive a busy box; no duration
 *    is taken;
 *  * asserts the claim as a NAME and a COUNT: one instanced mesh, wearing the
 *    `energy-orb` geometry, one instance per live orb — and no `[orb-art]`
 *    warning, because a failed fetch flies a stand-in that would pass every
 *    count here.
 *
 * Same build, same code path: `?view=cam` is a viewpoint the game already
 * takes, and the census reads the group through `__ff2`, the dev handle every
 * screenshot spec reads, restoring each hook it borrows. `@gpu`, and PINNED
 * (DEV-245).
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const MISSION = 'hoverJet_kauai_beg'
const OUT = process.env.ORB_ART_SHOT_DIR ?? path.join('test-results', 'orb-art')
const ARM = process.env.ORB_ART_ARM ?? 'run'

type Vec = [number, number, number]
const level = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'content', 'levels', `${MISSION}.json`), 'utf8'),
) as { orbs: { live: boolean; pos: Vec; posFf2: Vec | null }[] }
const live = level.orbs.filter((o) => o.live)
/** The first live orb, where the sim collects it (`orbPos`: DEV-067's lift first). */
const ORB = ((live[0]?.posFf2 ?? live[0]?.pos) as Vec) ?? [0, 0, 0]

/** Beside the orb and a little below it, so sky is behind it. */
const VIEWS: readonly { name: string; offset: Vec }[] = [
  { name: 'near', offset: [10, -4, 10] },
  { name: 'mid', offset: [32, -10, 32] },
]
const triple = (v: Vec) => v.map((n) => n.toFixed(2)).join(',')
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

interface OrbMesh {
  readonly name: string
  /** `geometry.name` when it has one, else its three type. */
  readonly geometry: string
  readonly instances: number
  readonly trianglesEach: number
}

interface OrbFacts {
  readonly meshes: readonly OrbMesh[]
  /** Draw calls the orb field makes a frame: renders x passes. */
  readonly calls: number
  /** Triangles the orb field draws a frame: renders x passes x instances x triangles. */
  readonly triangles: number
  /** Renders of the world scene a frame — context for the two above. */
  readonly sceneRenders: number
  /** The whole frame's draw calls, and linked programs: the positive half of "no errors". */
  readonly frameCalls: number
  readonly programs: number
}

/** The orb meshes under the `orbs` group, as they are right now. Either arm. */
const orbMeshes = (page: Page): Promise<OrbMesh[] | null> =>
  page.evaluate(() => {
    interface Node {
      name: string
      isMesh?: boolean
      isInstancedMesh?: boolean
      count?: number
      geometry?: {
        name: string
        type: string
        index: { count: number } | null
        getAttribute: (n: string) => { count: number } | undefined
      }
      children: Node[]
      getObjectByName: (n: string) => Node | undefined
    }
    const w = globalThis as unknown as { __ff2?: { render: { scene: Node } } }
    const group = w.__ff2?.render.scene.getObjectByName('orbs')
    if (!group) return null
    return group.children
      .filter((o) => o.isMesh && o.geometry)
      .map((o) => {
        const g = o.geometry as NonNullable<Node['geometry']>
        return {
          name: o.name,
          geometry: g.name || g.type,
          instances: o.isInstancedMesh ? (o.count ?? 0) : 1,
          trianglesEach: (g.index?.count ?? g.getAttribute('position')?.count ?? 0) / 3,
        }
      })
  })

/**
 * Everything the claim and the census need. Each orb mesh's `onAfterRender` is
 * borrowed for `frames` frames to count how often three renders it — once per
 * scene pass it is in — and handed back after. One render of a transparent
 * double-sided material is TWO draws (`WebGLRenderer.renderObject`), which is
 * how the old shell drew.
 */
const orbFacts = async (page: Page, frames = 40): Promise<OrbFacts> => {
  const meshes = (await orbMeshes(page)) ?? []
  const cost = await page.evaluate(async (n) => {
    interface Node {
      name: string
      isMesh?: boolean
      isInstancedMesh?: boolean
      count?: number
      geometry: {
        index: { count: number } | null
        getAttribute: (n: string) => { count: number } | undefined
      }
      material: { transparent: boolean; side: number; forceSinglePass?: boolean }
      onAfterRender: (...args: unknown[]) => void
      children: Node[]
      getObjectByName: (n: string) => Node | undefined
    }
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          scene: Node
          renderer: { info: { render: { calls: number }; programs?: unknown[] | null } }
        }
      }
    }
    const scene = w.__ff2.render.scene
    const group = scene.getObjectByName('orbs') as Node
    const meshes = group.children.filter((o) => o.isMesh)
    // Per FRAME, rounded. The first cut divided by renders of the world scene
    // and read 0.5: the scene renders TWICE a frame (40 renders over 20 rAFs)
    // and the orbs are in one of the two. So the scene's count is reported
    // beside the orbs' own, and the denominator is frames; rounding absorbs
    // the one frame either end that a rAF window can gain or lose.
    let sceneRenders = 0
    const keptScene = scene.onAfterRender
    scene.onAfterRender = (...args: unknown[]) => {
      sceneRenders++
      keptScene.apply(scene, args)
    }
    const renders = meshes.map(() => 0)
    const kept = meshes.map((m) => m.onAfterRender)
    meshes.forEach((m, i) => {
      const own = kept[i] as Node['onAfterRender']
      m.onAfterRender = (...args: unknown[]) => {
        renders[i] = (renders[i] ?? 0) + 1
        own.apply(m, args)
      }
    })
    for (let f = 0; f < n; f++) await new Promise((r) => requestAnimationFrame(() => r(null)))
    meshes.forEach((m, i) => {
      m.onAfterRender = kept[i] as Node['onAfterRender']
    })
    scene.onAfterRender = keptScene
    let calls = 0
    let triangles = 0
    meshes.forEach((m, i) => {
      const passes =
        m.material.transparent && m.material.side === 2 && !m.material.forceSinglePass ? 2 : 1
      const instances = m.isInstancedMesh ? (m.count ?? 0) : 1
      const tris = (m.geometry.index?.count ?? m.geometry.getAttribute('position')?.count ?? 0) / 3
      const each = Math.round((renders[i] ?? 0) / n)
      calls += each * passes
      triangles += each * passes * instances * tris
    })
    return {
      calls,
      triangles,
      sceneRenders: Math.round(sceneRenders / n),
      frameCalls: w.__ff2.render.renderer.info.render.calls,
      programs: w.__ff2.render.renderer.info.programs?.length ?? 0,
    }
  }, frames)
  return { meshes, ...cost }
}

test.describe('@gpu 2016’s energy orb, in the world (DEV-327)', () => {
  test.setTimeout(420_000)

  test(`${MISSION}: the orbs wear energy-orb.glb, one draw for the field`, async ({ page }) => {
    const errors = watchPageErrors(page)
    const orbWarnings: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('[orb-art]')) orbWarnings.push(msg.text())
    })
    fs.mkdirSync(OUT, { recursive: true })

    let pinAtStart: Awaited<ReturnType<typeof drawState>> | null = null
    let facts: OrbFacts | null = null
    for (const view of VIEWS) {
      const eye = add(ORB, view.offset)
      await page.goto(
        `/?xr=off&ride=0&mission=${MISSION}&view=cam&eye=${triple(eye)}&look=${triple(ORB)}&${PINNED}`,
      )
      await firstPress(page)
      await missionReady(page, 180_000)
      // Either arm's orbs, then a beat for a GLB that lands on its own.
      await expect
        .poll(async () => (await orbMeshes(page))?.length ?? 0, {
          timeout: 60_000,
          message: 'orbs in the scene',
        })
        .toBeGreaterThan(0)
      await page.waitForTimeout(3_000)
      const state = await drawState(page)
      pinAtStart ??= state
      const shot = await page.locator('#viewport').screenshot()
      fs.writeFileSync(path.join(OUT, `orb-${view.name}-${ARM}-adaptive0-qualityhigh.png`), shot)
      if (view.name === 'near') facts = await orbFacts(page)
      console.info(`orb-art ${ARM} ${view.name}: eye ${triple(eye)} · ${drawStateLine(state)}`)
    }
    const f = facts as unknown as OrbFacts
    console.info(
      `[DEV-327] ${ARM} ${MISSION}: meshes ${JSON.stringify(f.meshes)} · orb field ` +
        `${f.calls} calls, ${f.triangles} triangles a frame · the world scene renders ` +
        `${f.sceneRenders}x a frame · frame ${f.frameCalls} calls · ${f.programs} programs`,
    )
    expect(f.sceneRenders, 'the census saw the scene render').toBeGreaterThan(0)

    // ── the claim ────────────────────────────────────────────────────────
    // The positive half first: a frame that drew nothing reports no errors too.
    expect(f.frameCalls, 'the frame drew').toBeGreaterThan(0)
    expect(f.programs, 'programs linked').toBeGreaterThan(0)
    expect(orbWarnings, 'the orb GLB loaded').toEqual([])
    expect(f.meshes, 'one instanced mesh for the whole field').toHaveLength(1)
    const mesh = f.meshes[0] as OrbMesh
    expect(mesh.geometry, '2016’s orb, not the stand-in or the old shell').toBe('energy-orb')
    expect(mesh.instances).toBe(live.length)
    expect(mesh.trianglesEach, 'sphere_fancy_lod_01: 116 triangles').toBe(116)
    expect(f.calls, 'the field is one draw').toBe(1)
    expect(f.triangles).toBe(116 * live.length)

    const pinAtEnd = await drawState(page)
    const drift = drawStateDiff(pinAtStart as NonNullable<typeof pinAtStart>, pinAtEnd)
    expect(drift, `the tier moved mid-run: ${drift.join(', ')}`).toEqual([])
    expect(errors.list(), 'console errors, page errors or failed requests').toEqual([])
  })
})
