/**
 * The sun is a disc, and it is the same disc whatever the sky is made of.
 *
 * DEV-293, wishlist #22b. Matt: *"our 'sun' shows up oddly on the faceted sky.
 * maybe it should be a bloom instead?"* What `?view=cam&cam=sky-only` showed on
 * `int_01_hoverJet` was an angular, asymmetric SHARD — a blown-out region with
 * straight edges and a spike up-left and another right. It was the brightest
 * few TRIANGLES of the dome: the disc was a term inside a field sampled once
 * per 1.4-degree face, and the disc is 1.8 degrees across.
 *
 * ── Why this is an e2e spec and not one more unit test ───────────────────
 *
 * Because the bug was invisible to every kind of test this project already
 * had. `sky-dome.test.ts` pinned the dome's density, its watertightness, its
 * face directions and its determinism, and the sun was wrong under all of it;
 * the orientation lesson's §5c is the general form — *a thing that is too
 * small, too dark or too fast has not been reviewed, it has been rendered.*
 * The sun is 90 px of a 1280 x 720 frame, and was 30 before DEV-294. It needs
 * a measurement, and the measurement has to be of the picture.
 *
 * ── What is asserted, and why none of it is a pixel value ────────────────
 *
 * Three relationships, all true independently of resolution, driver and art:
 *
 *   1. **The blob is SQUARE.** A disc's bounding box has aspect 1; the shard's
 *      was 49 x 38 at luminance 240 and 48 x 29 at 245, because a spike is
 *      longer one way than the other. An aspect ratio is true whatever the
 *      sun's size is, which is what made it survive DEV-294 tripling that size
 *      without a line of this file changing: 30 x 30 became 90 x 89.
 *
 *   2. **It does not move with the sky's tessellation.** Drop the lookdev
 *      subdivisions slider from 5 to 3 — a 16x coarser dome — and the sun must
 *      not change. Before this landed it went from 614 px to 3,830, a factor of
 *      6.2, because the sun WAS the facets. This is the claim the fix makes,
 *      stated as the thing a player would see.
 *
 *   3. **It IS the size the constant says**, in degrees rather than in pixels
 *      (DEV-294). The saturated blob has to sit between the profile's plateau
 *      and its rim — wider than the core, narrower than where the falloff ends
 *      — measured through the camera's own live FOV. That is what catches a
 *      size dial that never reached the renderer, which a shape test cannot:
 *      a sun stuck at 1x is still perfectly round.
 *
 * (2) is the strongest of the three and the cheapest to trust: it compares two
 * frames from the same run rather than one frame against a number somebody
 * wrote down. (3) is the one that had to be a RANGE — the visible edge is
 * where the falloff crosses the tone curve, which is somewhere inside the
 * geometry and not a number this spec should be predicting.
 *
 * The blob is found with NO hand-placed window. Nothing else above the horizon
 * on this viewpoint reaches luminance 240 — checked at 240, 245 and 250 across
 * four frames, with and without a window, and the answers were identical — so
 * a window would have been a tuned constant standing in for a fact.
 *
 * Tagged `@gpu`. `?xr=off` so `isSessionSupported('immersive-vr')` does not
 * start this machine's OpenXR runtime, and `PINNED` because a quality-tier drop
 * moves MSAA and MSAA is exactly the edge pixels this counts (DEV-245).
 */
import fs from 'node:fs'
import { SKY_TUNING, sunDiscOuterRadians } from '@/render/sky'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const OUT = process.env.SUN_PHOTO_DIR ?? 'perf-out/dev293'

/**
 * Luminance above which a pixel is "the sun".
 *
 * Rec.709 on the 8-bit sRGB frame. 240 of 255 is deep into the clipped core:
 * the sky's brightest facet on this viewpoint is far below it, and so is the
 * brightest cloud, so this separates without a region of interest.
 */
const SUN_LUMINANCE = 240

/** The horizon on `cam=sky-only`, below which the sea's glint column lives. */
const HORIZON_Y = 455

interface Blob {
  readonly area: number
  readonly width: number
  readonly height: number
  readonly x: number
  readonly y: number
  /** The frame's own height, so the angular check divides by what it measured. */
  readonly frameHeight: number
}

/** Every pixel above `SUN_LUMINANCE` in the sky, as one bounding box. */
const sunBlob = (png: Buffer): Blob => {
  const { width, height, channels, data } = decodePngBuffer(png, 'sun')
  let area = 0
  let minX = Number.POSITIVE_INFINITY
  let maxX = -1
  let minY = Number.POSITIVE_INFINITY
  let maxY = -1
  for (let y = 0; y < HORIZON_Y; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const lum =
        0.2126 * (data[i] as number) +
        0.7152 * (data[i + 1] as number) +
        0.0722 * (data[i + 2] as number)
      if (lum <= SUN_LUMINANCE) continue
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (area === 0) return { area: 0, width: 0, height: 0, x: -1, y: -1, frameHeight: height }
  return {
    area,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    x: minX,
    y: minY,
    frameHeight: height,
  }
}

test.describe('@gpu the sun disc — DEV-293', () => {
  test.setTimeout(300_000)

  test('is round, and is the same disc at two sky densities', async ({ page }) => {
    fs.mkdirSync(OUT, { recursive: true })
    const watcher = watchPageErrors(page)

    await page.goto(`/?view=cam&cam=sky-only&xr=off&lookdev=1&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 180_000)
    await page.waitForTimeout(2500)

    const shipped = sunBlob(await page.locator('#viewport').screenshot({ path: `${OUT}/sun.png` }))
    console.info(
      `DEV-293 sun at subdivision 5: area ${shipped.area} px, box ${shipped.width}x${shipped.height} at (${shipped.x}, ${shipped.y})`,
    )

    // It exists and it has not eaten the sky. A wide band on purpose — the
    // claims worth making are the two below, and this one is here so they
    // cannot both pass on an empty frame.
    expect(shipped.area, 'the sun is drawn at all').toBeGreaterThan(100)
    expect(shipped.area, 'the sun has not become the whole sky').toBeLessThan(20_000)

    // 1. Round. The shard was 49 x 38 here; a disc is square to within the
    //    handful of edge pixels MSAA moves.
    expect(
      Math.max(shipped.width, shipped.height) / Math.min(shipped.width, shipped.height),
      `the sun's bounding box is ${shipped.width}x${shipped.height} — a spike is longer one way`,
    ).toBeLessThan(1.15)

    // 3. The size the constant says, in DEGREES. Read the camera's live FOV
    //    rather than assuming one: `render/flat-fov.ts` moves it with airspeed,
    //    so a hard-coded 70 would be a number this spec quietly disagreed with
    //    the build about. `?view=cam` puts the camera at the scene root, so
    //    `camera` here is the one that rendered (trap 18 — in the cockpit it
    //    would be a head pose inside a rig).
    const view = await page.evaluate(() => {
      const w = window as unknown as {
        __ff2?: { render: { camera: { fov: number } } }
      }
      return { fov: w.__ff2?.render.camera.fov ?? 0 }
    })
    expect(view.fov, 'could not read the live FOV').toBeGreaterThan(1)
    const pxPerDegree = shipped.frameHeight / view.fov
    const rimDeg = (sunDiscOuterRadians(SKY_TUNING.sunSize) * 180) / Math.PI
    // The plateau is the inner 31.6 % of the radius — `sun-disc.test.ts` pins
    // that fraction across the whole slider, so it is a property here and not
    // a second copy of a number.
    const coreDeg = rimDeg * 0.3163
    const measuredDeg = Math.max(shipped.width, shipped.height) / pxPerDegree / 2
    console.info(
      `DEV-294 sun radius: ${measuredDeg.toFixed(2)} deg measured, core ${coreDeg.toFixed(2)}, rim ${rimDeg.toFixed(2)} (fov ${view.fov}, ${pxPerDegree.toFixed(2)} px/deg)`,
    )
    expect(measuredDeg, 'the saturated sun is smaller than its own plateau').toBeGreaterThan(
      coreDeg,
    )
    expect(measuredDeg, 'the saturated sun spills past the rim of its cap').toBeLessThan(rimDeg)

    // 2. Independent of the sky's tessellation. The panel is behind `L`, and
    //    the canvas holds the pointer lock until Escape — which is what pointer
    //    lock MEANS and is true for a player too, so pressing it is the harness
    //    doing what a person does rather than the build taking another path.
    await focusCanvas(page)
    await page.keyboard.press('KeyL')
    const panel = page.locator('.ff2-lookdev')
    await expect(panel).toBeVisible()
    const subdiv = panel
      .locator('label')
      .filter({ hasText: 'subdivisions' })
      .locator('input[type=range]')
    // By LABEL, not by index — `lookdev.spec.ts` paid for that lesson: `.nth(3)`
    // is the sun-intensity slider, and dragging it here would move the very
    // thing under test.
    expect(Number(await subdiv.inputValue()), 'the panel starts where the build is').toBe(5)
    await subdiv.fill('3')
    await subdiv.dispatchEvent('input')
    await page.waitForTimeout(2000)
    await page.keyboard.press('KeyL')
    await expect(panel).toBeHidden()
    await page.waitForTimeout(500)

    const coarse = sunBlob(
      await page.locator('#viewport').screenshot({ path: `${OUT}/sun-subdiv3.png` }),
    )
    console.info(
      `DEV-293 sun at subdivision 3: area ${coarse.area} px, box ${coarse.width}x${coarse.height} at (${coarse.x}, ${coarse.y})`,
    )

    // A 16x coarser dome. Before DEV-293 this frame's blob was 6.2x the
    // shipped one's area and 103 x 74 — one facet, lit. The tolerance is for
    // the facet BEHIND the disc changing brightness under it, which can move a
    // boundary pixel; it is not for the disc changing size, which it must not.
    expect(coarse.area / shipped.area, 'the sun grew or shrank with the sky').toBeCloseTo(1, 1)
    expect(Math.abs(coarse.width - shipped.width), 'the sun widened with the sky').toBeLessThan(3)
    expect(
      Math.abs(coarse.height - shipped.height),
      'the sun grew taller with the sky',
    ).toBeLessThan(3)

    expect(watcher.list(), 'the page threw while the dome was rebuilt').toEqual([])
  })
})
