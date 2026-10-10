/**
 * A mission reached the way a player reaches one draws sun shadows. DEV-363.
 *
 * Found by DEV-359: `createSunShadows` and `createCockpitSelfShadow` were handed
 * the light the BOOT world built, and every course switch built a new one. After
 * the first switch both cast from a light no longer in the scene, and the
 * mission's own sun cast nothing — 0 shadow-pass draws. Since DEV-281 the boot
 * world is the title, so that was every mission a player could reach. Nothing
 * saw it because every spec that looks at a shadow boots `?mission=`, the one
 * path where the boot sun IS the mission's.
 *
 * So this one starts where a player starts — the title — and takes the two
 * routes off it: one fade into DEV-355's loading scene (Quick Race's route,
 * DEV-353, until DEV-558 took that row off the title; a shared course's link
 * takes it now, `fixtures/course-link.ts`) and the hangar's aimed presses
 * (`fixtures/hangar.ts`). On the mission it asks the
 * frame, positively:
 *
 *   1. there is exactly ONE directional light in the scene, it is visible and it
 *      casts;
 *   2. it is aimed along THIS mission's sun (`lighting.sun.direction` out of the
 *      level JSON, read off disk here), not the title's — a light that casts
 *      from the wrong direction is the other half of the same bug;
 *   3. the shadow pass DRAWS: three calls `onBeforeShadow` immediately before
 *      it draws an object into a shadow map, after the layer, cast and frustum
 *      tests, so a count above zero is a caster in the map this frame. A frame
 *      that drew nothing reports no errors too; this counts what was drawn.
 *
 * The hooks observe; nothing in the game takes a different path for being
 * watched. Pinned `adaptive=0&quality=high` (quality `low` has no map at all).
 * The counts it prints are the price of the fix, per frame, on the route a
 * player takes — counts of a frame, which survive a shared box.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/sun-switch.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import {
  LINK_COURSE_ID,
  LINK_COURSE_ROW,
  LINK_COURSE_SKY,
  linkCourseFragment,
} from './fixtures/course-link'
import { board, type Course, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/**
 * An extra query for a pricing arm — `SUN_SWITCH_QUERY=feature=props.scatterShadows:off`
 * is the caster set a headset gets (`vr.disable`). Empty is the shipped flat build.
 */
const ARM = process.env.SUN_SWITCH_QUERY ? `&${process.env.SUN_SWITCH_QUERY}` : ''

/** `rookie_01_hoverJet` — HoverJet, Ring Attack, Beginner. */
const ROOKIE_01_HOVERJET: Course = {
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  rank: 'beginner',
  id: 'rookie_01_hoverJet',
}

interface SunCensus {
  readonly course: string
  readonly lights: readonly {
    readonly castShadow: boolean
    readonly visible: boolean
    readonly towardSun: readonly [number, number, number]
  }[]
  readonly mapOn: boolean
  /** Shadow-pass draws and triangles, per frame, averaged over the window. */
  readonly depth: { readonly draws: number; readonly triangles: number }
  /** The same, by the scene child each drawn mesh hangs under. */
  readonly byRoot: Record<string, { draws: number; triangles: number }>
}

/** The title is up, its valley is in, and the card is gone. */
const toTheTitle = async (page: Page, fragment = ''): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}${ARM}${fragment}`)
  await firstPress(page)
  await bootReady(page, 240_000)
  await dropFocus(page)
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __ff2?: { titleMenu?: () => { up: boolean } | null }
              }
            ).__ff2?.titleMenu?.()?.up ?? false,
        ),
      { message: 'the title offers its rows', timeout: 60_000 },
    )
    .toBe(true)
}

const census = async (page: Page, frames = 10): Promise<SunCensus> =>
  page.evaluate(async (frames) => {
    type O = {
      name?: string
      type?: string
      isMesh?: boolean
      isInstancedMesh?: boolean
      isDirectionalLight?: boolean
      castShadow?: boolean
      visible?: boolean
      count?: number
      parent?: O | null
      geometry?: {
        index?: { count: number } | null
        attributes: { position: { count: number } }
        drawRange: { count: number }
      }
      matrixWorld?: { elements: number[] }
      updateWorldMatrix?: (parents: boolean, children: boolean) => void
      target?: O
      traverse: (f: (o: O) => void) => void
      onBeforeShadow?: () => void
    }
    const app = (
      globalThis as unknown as {
        __ff2: {
          stage: () => O
          course: () => { id: string }
          render: { renderer: { shadowMap: { enabled: boolean } } }
        }
      }
    ).__ff2
    const scene = app.stage()
    const lights: { castShadow: boolean; visible: boolean; towardSun: [number, number, number] }[] =
      []
    const depth = { draws: 0, triangles: 0 }
    const byRoot: Record<string, { draws: number; triangles: number }> = {}
    const rootOf = (o: O): string => {
      let p: O = o
      while (p.parent && p.parent !== scene) p = p.parent
      return p.name || p.type || '?'
    }
    const tris = (o: O): number => {
      const g = o.geometry
      if (!g) return 0
      const n = g.index ? g.index.count : g.attributes.position.count
      const range = Number.isFinite(g.drawRange.count) ? Math.min(n, g.drawRange.count) : n
      return (range / 3) * (o.isInstancedMesh ? (o.count ?? 1) : 1)
    }
    const hooked: O[] = []
    scene.traverse((o) => {
      if (o.isDirectionalLight && o.target) {
        // World positions off the matrices, refreshed first: three does not
        // recompute a matrix until it renders.
        o.updateWorldMatrix?.(true, false)
        o.target.updateWorldMatrix?.(true, false)
        const p = o.matrixWorld?.elements ?? []
        const t = o.target.matrixWorld?.elements ?? []
        const d = [
          (p[12] ?? 0) - (t[12] ?? 0),
          (p[13] ?? 0) - (t[13] ?? 0),
          (p[14] ?? 0) - (t[14] ?? 0),
        ]
        const len = Math.hypot(d[0] as number, d[1] as number, d[2] as number) || 1
        lights.push({
          castShadow: o.castShadow === true,
          visible: o.visible !== false,
          towardSun: [(d[0] as number) / len, (d[1] as number) / len, (d[2] as number) / len],
        })
      }
      if (!o.isMesh) return
      const key = rootOf(o)
      o.onBeforeShadow = () => {
        const t = tris(o)
        depth.draws++
        depth.triangles += t
        byRoot[key] ??= { draws: 0, triangles: 0 }
        ;(byRoot[key] as { draws: number; triangles: number }).draws++
        ;(byRoot[key] as { draws: number; triangles: number }).triangles += t
      }
      hooked.push(o)
    })
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve))
    // One frame to let the hooks land, then zero and count a window.
    await raf()
    depth.draws = 0
    depth.triangles = 0
    for (const k of Object.keys(byRoot)) delete byRoot[k]
    for (let i = 0; i < frames; i++) await raf()
    // Hand the hooks back: a spec that leaves closures on every mesh is a spec
    // that changed what the next one measures.
    for (const o of hooked) delete o.onBeforeShadow
    const per: Record<string, { draws: number; triangles: number }> = {}
    for (const [k, v] of Object.entries(byRoot)) {
      per[k] = { draws: v.draws / frames, triangles: Math.round(v.triangles / frames) }
    }
    return {
      course: app.course().id,
      lights,
      mapOn: app.render.renderer.shadowMap.enabled,
      depth: { draws: depth.draws / frames, triangles: Math.round(depth.triangles / frames) },
      byRoot: per,
    }
  }, frames)

/** This course's sun, TOWARD the sun (three space), out of the level JSON. */
const levelTowardSun = (id: string): [number, number, number] => {
  const file = path.join(process.cwd(), 'content', 'levels', `${id}.json`)
  const level = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    lighting: { sun: { direction: [number, number, number] } | null }
  }
  const d = level.lighting.sun?.direction
  if (!d) throw new Error(`${id} has no sun`)
  const len = Math.hypot(d[0], d[1], d[2])
  return [-d[0] / len, -d[1] / len, -d[2] / len]
}

const expectTheMissionSunCasts = (
  c: SunCensus,
  label: string,
  /** The level whose sun it is; a player course's is its sky's (DEV-558). */
  sunOf: string = c.course,
): void => {
  console.info(
    `sun-switch ${label} ${c.course}: ${c.lights.length} directional light(s) ` +
      `${JSON.stringify(c.lights)}; map ${c.mapOn}; shadow pass ` +
      `${c.depth.draws} draws, ${c.depth.triangles.toLocaleString()} triangles a frame; ` +
      `by root ${JSON.stringify(c.byRoot)}`,
  )
  expect(c.mapOn, `${label}: the renderer has a shadow map`).toBe(true)
  expect(c.lights.length, `${label}: exactly one sun in the scene`).toBe(1)
  const sun = c.lights[0]
  expect(sun?.visible, `${label}: the sun is visible`).toBe(true)
  expect(sun?.castShadow, `${label}: the mission's sun casts`).toBe(true)
  const want = levelTowardSun(sunOf)
  const dot =
    (sun?.towardSun[0] ?? 0) * want[0] +
    (sun?.towardSun[1] ?? 0) * want[1] +
    (sun?.towardSun[2] ?? 0) * want[2]
  expect(dot, `${label}: the casting light is aimed along ${c.course}'s own sun`).toBeGreaterThan(
    0.9999,
  )
  expect(c.depth.draws, `${label}: the shadow pass draws casters`).toBeGreaterThan(0)
  expect(c.depth.triangles, `${label}: ...and they have triangles`).toBeGreaterThan(0)
}

test.describe('@gpu the sun follows a course switch (DEV-363)', () => {
  test.setTimeout(360_000)

  test('a shared course’s link: the mission it boards from the title casts from its own sun', async ({
    page,
  }) => {
    // DEV-558: the title's one-fade route into the loading scene, which Quick
    // Race took until the row left the title. The course flies int_01's sky.
    const problems = watchPageErrors(page)
    await toTheTitle(page, await linkCourseFragment())
    await page.waitForSelector(`body[data-course-link="${LINK_COURSE_ID}"]`, { timeout: 60_000 })
    await pressTitleRow(page, LINK_COURSE_ROW, 0)
    await switchSettled(page, 240_000)
    await page.waitForTimeout(3_000)
    expectTheMissionSunCasts(await census(page), 'course link', LINK_COURSE_SKY)
    expect(problems.list(), 'page errors').toEqual([])
  })

  for (const course of [INT_01_HOVERJET, ROOKIE_01_HOVERJET]) {
    test(`the hangar: ${course.id} casts from its own sun`, async ({ page }) => {
      const problems = watchPageErrors(page)
      await toTheTitle(page)
      // Title -> the room (DEV-441: Single Player, then Hangar), then the
      // four aimed presses and the load.
      await pressTitleRow(page, TITLE_ROW.hangar)
      await board(page, course, 1_000)
      await page.waitForTimeout(3_000)
      expectTheMissionSunCasts(await census(page), 'hangar')
      expect(problems.list(), 'page errors').toEqual([])
    })
  }
})
