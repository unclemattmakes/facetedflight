/**
 * tests/e2e/smooth-sky.spec.ts — `render.smoothSky` reaches a mission, and the
 * world is still there around it (DEV-320, wishlist #22a).
 *
 * ── The two ways this row has already failed ─────────────────────────────
 *
 * DEV-307 built this flag twice. The first draft read it inside
 * `if (titleSky && liveSky)` in `boot/app.ts`, `titleSky` is null on every
 * mission load, and the flag was DEAD where a player flies while the menu said
 * "on" — caught only because two photographs came back identical. The second
 * put the dome's prefilter on `scene.background` and **the terrain vanished**
 * on Anniversary. three draws its background box first in every
 * `renderer.render` call, and bloom's UI pass is a second call over the
 * finished frame.
 *
 * (DEV-307's row blamed `renderOrder` for the second. Measured 2026-09-23: the
 * same `scene.background` arm with `?feature=render.bloom:off` leaves the
 * world drawn, so it is the second render call, not the sort.)
 *
 * So this photographs exactly those two things, on a MISSION load, on
 * ANNIVERSARY (bloom on):
 *
 *   · looking at the sky, the smooth arm moves pixels well past a control of
 *     the faceted frame taken twice — the flag is live;
 *   · looking steeply DOWN at the island, where no sky is in frame, the smooth
 *     arm moves almost nothing — the world is still drawn, and the lighting
 *     the re-prefiltered environment gives it has barely changed.
 *
 * ── The arms ─────────────────────────────────────────────────────────────
 *
 * Faceted, smooth, faceted again, flipped LIVE through `__ff2.edition` — the
 * same override the `?feature=` pin sets at boot, so it is the path a player's
 * toggle takes and it is proven to re-bake mid-mission rather than only at
 * load. The second faceted shot is the control: whatever differs between the
 * two faceted frames is noise, and the smooth arm is judged against it.
 *
 * ── Same build, same code path ───────────────────────────────────────────
 *
 * `?view=cam` is a boot viewpoint (placed once, left alone), and the stands
 * move `render.camera` through the dev handle exactly as
 * `draw-order-pixels.spec.ts` does. `@gpu`, and PINNED (DEV-245): a tier drop
 * between arms would be a difference between two builds. Frames go to
 * SMOOTH_SKY_DIR because Playwright wipes `test-results/` on every run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { compareDecoded, decodePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.SMOOTH_SKY_DIR ?? path.join('test-results', 'smooth-sky')
const MISSION = 'int_01_hoverJet'

type Vec = readonly [number, number, number]

interface Stand {
  readonly name: string
  readonly eye: Vec
  readonly look: Vec
}

/** `viewpoints.ts`'s `sky-only`: toward the sun, no terrain in frame. */
const SKY: Stand = { name: 'sky', eye: [0, 900, 0], look: [-962, 970, -263] }
/** 72 degrees down from 900 m: no sky in frame, so any sky here is the DEV-307 bug. */
const GROUND: Stand = { name: 'ground', eye: [0, 900, 0], look: [200, 0, 200] }

const aim = (page: Page, stand: Stand): Promise<void> =>
  page.evaluate(
    ([e, l]) => {
      const w = globalThis as unknown as {
        __ff2: {
          render: {
            camera: {
              position: { set: (x: number, y: number, z: number) => void }
              lookAt: (x: number, y: number, z: number) => void
              updateMatrixWorld: (force?: boolean) => void
            }
          }
        }
      }
      const c = w.__ff2.render.camera
      c.position.set(e[0], e[1], e[2])
      c.lookAt(l[0], l[1], l[2])
      c.updateMatrixWorld(true)
    },
    [stand.eye, stand.look] as const,
  )

interface Decoded {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

/**
 * Mean absolute difference between each pixel and its right and lower
 * neighbours, over rows `y0..y1` (fractions of the height), in levels of 255.
 *
 * The facets ARE edges, so this reads "are the facets gone" off ONE frame. A
 * diff between two frames could not: the world's clouds drift between shots,
 * and a few cloud edges moving outweigh a whole sky of ±6 % steps in a mean
 * difference (measured: 1.05 of control against 2.0 of arm in the sky band).
 */
const edgeEnergy = (img: Decoded, y0: number, y1: number): number => {
  let sum = 0
  let n = 0
  const row = img.w * img.ch
  for (let y = Math.floor(y0 * img.h); y < Math.floor(y1 * img.h) - 1; y++) {
    for (let x = 0; x < img.w - 1; x++) {
      const i = y * row + x * img.ch
      for (let k = 0; k < 3; k++) {
        const c = img.data[i + k] as number
        sum += Math.abs(c - (img.data[i + img.ch + k] as number))
        sum += Math.abs(c - (img.data[i + row + k] as number))
        n += 2
      }
    }
  }
  return sum / n
}

/** The sky stand's band above the horizon: `sky-only` puts the sea in the lower half. */
const SKY_BAND = [0, 0.55] as const

/** Flip the flag the way `?feature=` and the Advanced page do: the override layer. */
const setSmooth = (page: Page, on: boolean): Promise<boolean> =>
  page.evaluate((value) => {
    const w = globalThis as unknown as {
      __ff2: {
        edition: {
          current: { render: { smoothSky: { enabled: boolean } } }
          featureOverrides: Readonly<Record<string, boolean>>
          setFeatureOverrides(o: Readonly<Record<string, boolean>>): void
        }
      }
    }
    const edition = w.__ff2.edition
    edition.setFeatureOverrides({ ...edition.featureOverrides, 'render.smoothSky': value })
    return edition.current.render.smoothSky.enabled
  }, on)

test.describe('@gpu the smooth sky (DEV-320)', () => {
  test.setTimeout(420_000)

  test('reaches a mission on Anniversary, and leaves the world drawn', async ({ page }) => {
    const problems = watchPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })
    await page.goto(
      `/?xr=off&ride=0&mission=${MISSION}&edition=anniversary&view=cam&cam=sky-only&${PINNED}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    // The streamer settles and the LOD ring stops moving; a chunk arriving
    // between two shots is a difference that has nothing to do with the arm.
    await page.waitForTimeout(6_000)

    const table: string[] = []
    const verdicts: Record<
      string,
      { smooth: number; control: number; edges: [number, number, number] }
    > = {}
    for (const stand of [SKY, GROUND]) {
      await aim(page, stand)
      await page.waitForTimeout(1_500)
      const shoot = async (arm: string, smooth: boolean) => {
        expect(await setSmooth(page, smooth)).toBe(smooth)
        // The re-bake happens on the next frame; a second is dozens of them.
        await page.waitForTimeout(1_000)
        const shot = await page.locator('#viewport').screenshot()
        fs.writeFileSync(path.join(OUT, `${MISSION}-${stand.name}-${arm}.png`), shot)
        return decodePng(shot)
      }
      const faceted = await shoot('faceted', false)
      const smooth = await shoot('smooth', true)
      const control = await shoot('faceted-again', false)
      const bySmooth = compareDecoded(faceted, smooth)
      const byControl = compareDecoded(faceted, control)
      if (!bySmooth || !byControl) throw new Error('smooth-sky: frames differ in size')
      const [y0, y1] = stand === SKY ? SKY_BAND : [0, 1]
      const edges: [number, number, number] = [
        edgeEnergy(faceted, y0, y1),
        edgeEnergy(smooth, y0, y1),
        edgeEnergy(control, y0, y1),
      ]
      verdicts[stand.name] = { smooth: bySmooth.mean, control: byControl.mean, edges }
      table.push(
        `${stand.name}: diff smooth ${bySmooth.mean.toFixed(3)} · control ${byControl.mean.toFixed(3)}` +
          ` | edges faceted ${edges[0].toFixed(4)} · smooth ${edges[1].toFixed(4)}` +
          ` · faceted again ${edges[2].toFixed(4)}`,
      )
    }
    console.log(`smooth-sky, ${MISSION}, anniversary, levels of 255:\n  ${table.join('\n  ')}`)

    const sky = verdicts.sky as (typeof verdicts)[string]
    const ground = verdicts.ground as (typeof verdicts)[string]
    // The premise: the two faceted frames agree, so a drop is the arm's.
    // Measured 0.6 % apart.
    expect(Math.abs(sky.edges[2] / sky.edges[0] - 1)).toBeLessThan(0.03)
    // The flag is LIVE in a mission: the facets' edges leave the sky band.
    // Measured a 20 % drop, band-wide, clouds and sun included (both unchanged).
    // With the seam made inert — DEV-307's dead flag — it read 0.997: red.
    expect(sky.edges[1] / sky.edges[0]).toBeLessThan(0.9)
    // And the world is still drawn. Measured, its edges moved 1.5 % and its
    // mean 0.9 of 255 past control — the sea reflecting a smoother sky. With
    // DEV-307's `scene.background` arm put back, the ground's edges fell from
    // 1.62 to 0.02 and its mean moved 27.9 of 255: the world gone, red twice.
    expect(Math.abs(ground.edges[1] / ground.edges[0] - 1)).toBeLessThan(0.1)
    expect(ground.smooth).toBeLessThan(ground.control + 3)
    expect(problems.list(), 'page errors — a failed shader compile lands here').toEqual([])
  })
})
