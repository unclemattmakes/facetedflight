/**
 * A mission reached the way a player reaches one is hazed. DEV-552.
 *
 * `attachEditionHaze` was called once, on the BOOT fog, and `switchMission`
 * built a fresh fog that every material in the new world was fogged through.
 * `createUnityFog` builds its haze uniforms at zero, so the mission drew no
 * aerial perspective (DEV-082) on Anniversary. Since DEV-281 the boot world is
 * the title, so that was every mission a player could reach. Nothing saw it for
 * the reason nothing saw DEV-363: every spec that looks at the haze boots
 * `?mission=`, the one path where the boot fog IS the mission's.
 *
 * So this one starts where a player starts, the title, and takes both of its
 * routes into a mission, as `sun-switch.spec.ts` does: the hangar, and one
 * fade into the loading scene (Quick Race's route until DEV-558 took that row
 * off the title; a shared course's link takes it now, `fixtures/course-link.ts`). On the mission it reads
 * `uHaze` out of every compiled program in the scene that has one: three keeps
 * the uniforms `onBeforeCompile` was handed in `renderer.properties`, and the
 * fog's patch puts its own block there (`Object.assign(shader.uniforms, …)`),
 * so this is the value the shader reads, not a copy of the fog's intent.
 *
 * Positive, not an absence: it asserts programs WERE found before asserting
 * what they hold, and it compares against the live preset's own numbers, so a
 * world that compiled nothing cannot pass by reporting no zeroes.
 *
 * The hooks observe; nothing in the game takes a different path for being
 * watched.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/haze-switch.spec.ts
 *
 * Tagged `@gpu`.
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { LINK_COURSE_ID, LINK_COURSE_ROW, linkCourseFragment } from './fixtures/course-link'
import { board, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

interface HazeCensus {
  readonly course: string
  readonly look: string
  /** The live preset's haze: on, and its four packed numbers' source. */
  readonly preset: {
    readonly enabled: boolean
    readonly startDistance: number
    readonly range: number
    readonly strength: number
    readonly desaturate: number
  }
  /** Compiled materials in the scene that carry a `uHaze`. */
  readonly programs: number
  /** Each distinct `uHaze` they hold, as `x,y,z,w`. */
  readonly values: readonly string[]
}

/** The title is up, its valley is in, and the card is gone. */
const toTheTitle = async (page: Page, fragment = ''): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}${fragment}`)
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

const census = async (page: Page): Promise<HazeCensus> =>
  page.evaluate(async () => {
    type Uniform = { value: { x: number; y: number; z: number; w: number } }
    type Mat = object
    type O = { material?: Mat | Mat[]; traverse: (f: (o: O) => void) => void }
    const app = (
      globalThis as unknown as {
        __ff2: {
          stage: () => O
          course: () => { id: string }
          edition: {
            current: {
              id: string
              render: { haze: HazeCensus['preset'] }
            }
          }
          render: {
            renderer: {
              properties: { get: (m: Mat) => { uniforms?: Record<string, Uniform> } }
            }
          }
        }
      }
    ).__ff2
    // Two frames, so everything the switch built has compiled and drawn.
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve))
    await raf()
    await raf()
    const seen = new Set<Mat>()
    const values = new Set<string>()
    let programs = 0
    app.stage().traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) {
        if (seen.has(m)) continue
        seen.add(m)
        const h = app.render.renderer.properties.get(m).uniforms?.uHaze?.value
        if (!h) continue
        programs++
        values.add([h.x, h.y, h.z, h.w].join(','))
      }
    })
    const h = app.edition.current.render.haze
    return {
      course: app.course().id,
      look: app.edition.current.id,
      preset: {
        enabled: h.enabled,
        startDistance: h.startDistance,
        range: h.range,
        strength: h.strength,
        desaturate: h.desaturate,
      },
      programs,
      values: [...values],
    }
  })

const expectTheMissionIsHazed = (c: HazeCensus, label: string): void => {
  console.info(
    `haze-switch ${label} ${c.course} (${c.look}): ${c.programs} hazed program(s), ` +
      `uHaze ${JSON.stringify(c.values)}; preset ${JSON.stringify(c.preset)}`,
  )
  expect(c.look, `${label}: the mission is worn on Anniversary`).toBe('anniversary')
  expect(c.preset.enabled, `${label}: the preset has the haze on`).toBe(true)
  expect(c.programs, `${label}: the world compiled fogged materials`).toBeGreaterThan(0)
  // `hazePack`: (startDistance, 1 / range, strength, desaturate). Every fogged
  // material shares the fog's one block, so there is exactly one value.
  const want = [c.preset.startDistance, 1 / c.preset.range, c.preset.strength, c.preset.desaturate]
  expect(c.values.length, `${label}: one uniform block, shared`).toBe(1)
  const got = (c.values[0] ?? '').split(',').map(Number)
  for (let i = 0; i < 4; i++) {
    expect(got[i], `${label}: uHaze[${i}] is the preset's`).toBeCloseTo(want[i] as number, 6)
  }
  expect(got[2], `${label}: the haze has strength`).toBeGreaterThan(0)
}

test.describe('@gpu the haze follows a course switch (DEV-552)', () => {
  test.setTimeout(360_000)

  test('a shared course’s link: the mission it boards from the title is hazed', async ({
    page,
  }) => {
    // DEV-558: the title's one-fade route into the loading scene, which Quick
    // Race took until the row left the title.
    const problems = watchPageErrors(page)
    await toTheTitle(page, await linkCourseFragment())
    await expect(page.locator('body')).toHaveAttribute('data-course-link', LINK_COURSE_ID, {
      timeout: 60_000,
    })
    await pressTitleRow(page, LINK_COURSE_ROW, 0)
    await switchSettled(page, 240_000)
    await page.waitForTimeout(3_000)
    expectTheMissionIsHazed(await census(page), 'course link')
    expect(problems.list(), 'page errors').toEqual([])
  })

  test(`the hangar: ${INT_01_HOVERJET.id} is hazed`, async ({ page }) => {
    const problems = watchPageErrors(page)
    await toTheTitle(page)
    await pressTitleRow(page, TITLE_ROW.hangar)
    await board(page, INT_01_HOVERJET, 1_000)
    await page.waitForTimeout(3_000)
    expectTheMissionIsHazed(await census(page), 'hangar')
    expect(problems.list(), 'page errors').toEqual([])
  })
})
