/**
 * The forest floor is darker than the field, and the switch that says so works.
 *
 * DEV-295, wishlist #13. Matt: *"on alpine, the grass under thick forests is
 * the same color as an open field. my goal is to make it darker under the
 * thick forest."*
 *
 * ── Why this spec exists, stated as the failure it would have caught ─────
 *
 * The whole feature shipped DEAD once, with **nineteen green unit tests**
 * across `canopy.test.ts` and `canopy-patch.test.ts`. `canopyPatchFragment`
 * guarded on `#include <lights_fragment_begin>` — but it runs after
 * `sunHeightPatchFragment`, which REPLACES that include, so the guard was
 * false at the only call site that matters and the patch returned the shader
 * untouched. The unit tests fed it the raw shader, which is an input the call
 * site never produces.
 *
 * Nothing about the sweep was wrong. The field was built, uploaded and
 * correct; the multiply was simply never compiled in. So the claim this file
 * makes is the one no unit test could: **the frame is darker.**
 *
 * ── Three claims, and what each one is for ───────────────────────────────
 *
 *   1. **The sweep found the props** — `counted` large and `offGrid` zero.
 *      This is the FRAME check. The placements arrive in the terrain's mesh
 *      frame and the grid runs over the same one, so a mistake there produces
 *      an empty field and a picture identical to the build before it, which is
 *      the quietest possible failure.
 *   2. **The frame is darker with it on than with it off**, same camera, same
 *      tier. Not by how much: that is `strength` and `saturation`, which are
 *      art and are argued with against a frame.
 *   3. **The darkening is LOCAL.** Most of the frame must be untouched, or the
 *      term is a tint on the island rather than a forest floor. Asserted as a
 *      FRACTION, which is true whatever the preset's numbers are.
 *
 * Tagged `@gpu`. `?xr=off` so the OpenXR runtime is not started, and `PINNED`
 * because a quality-tier drop moves the prop LOD — which changes how many
 * props are drawn, and this spec counts them (DEV-245).
 */

import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

/** Alpine, over the launch valley: dense forest on both slopes, a clearing between. */
const MISSION = 'rookie_01_hoverJet'
const EYE = '300,320,-950'
const LOOK = '450,180,-800'

interface Receipt {
  readonly counted: number
  readonly offGrid: number
  readonly occludedPercent: number
  readonly p50: number
}

const RECEIPT =
  /canopy-shade: swept (\d+) props \((\d+) off-grid\).*?([\d.]+) % of the grid.*?p50 ([\d.]+)/

const luminance = (png: Buffer): Float64Array => {
  const { width, height, channels, data } = decodePngBuffer(png, 'canopy')
  const out = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    out[i] =
      0.2126 * (data[o] as number) +
      0.7152 * (data[o + 1] as number) +
      0.0722 * (data[o + 2] as number)
  }
  return out
}

test.describe('@gpu the canopy shade — DEV-295', () => {
  test.setTimeout(300_000)

  test('darkens the forest floor, leaves most of the frame alone, and switches off', async ({
    page,
  }) => {
    const shoot = async (
      extra: string,
    ): Promise<{ pixels: Float64Array; receipt: Receipt | null }> => {
      let receipt: Receipt | null = null
      const onConsole = (m: { text(): string }): void => {
        const hit = RECEIPT.exec(m.text())
        if (hit) {
          receipt = {
            counted: Number(hit[1]),
            offGrid: Number(hit[2]),
            occludedPercent: Number(hit[3]),
            p50: Number(hit[4]),
          }
        }
      }
      page.on('console', onConsole)
      await page.goto(
        `/?xr=off&ride=0&mission=${MISSION}&view=cam&${PINNED}${extra}&eye=${EYE}&look=${LOOK}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      await page.waitForTimeout(3500)
      const pixels = luminance(await page.locator('#viewport').screenshot())
      page.off('console', onConsole)
      return { pixels, receipt }
    }

    const on = await shoot('')
    const off = await shoot('&feature=render.canopyShade:off')

    // 1. The sweep found the props, in the frame it was handed.
    expect(on.receipt, 'no canopy-shade receipt on the console').not.toBeNull()
    const receipt = on.receipt as unknown as Receipt
    console.info(
      `DEV-295 alpine: ${receipt.counted} props, ${receipt.offGrid} off-grid, ` +
        `${receipt.occludedPercent} % occluded, p50 ${receipt.p50}`,
    )
    // Alpine draws twelve thousand; the band is wide because the prop LOD and
    // DEV-287's volumes both move it, and the claim is "it found the forest".
    expect(receipt.counted).toBeGreaterThan(5_000)
    // ZERO. Not "few": every placement is inside the terrain it was scattered
    // on, so a single one off the grid means the frame is wrong, not that a
    // tree is in the sea.
    expect(receipt.offGrid, 'placements landed outside the grid — the FRAME is wrong').toBe(0)
    expect(receipt.p50, 'the occluded ground is not actually occluded').toBeGreaterThan(0)

    // 2. The switch really switches: no sweep at all on the off arm.
    expect(off.receipt, 'the feature pin did not turn the sweep off').toBeNull()

    // 2b. BOTH roles reached a material (DEV-296). The two paths are chosen by
    //     define, and a role that never arrived is invisible in the pixels —
    //     the ground alone already darkens the frame, so claim 3 would pass
    //     with the prop half entirely missing.
    const roles = await page.evaluate(() => {
      const w = window as unknown as {
        __ff2?: { render: { scene: { traverse(f: (o: unknown) => void): void } } }
      }
      const out = { ground: 0, prop: 0 }
      w.__ff2?.render.scene.traverse((o) => {
        const node = o as { material?: unknown }
        const mats = Array.isArray(node.material)
          ? node.material
          : node.material
            ? [node.material]
            : []
        for (const m of mats as { defines?: Record<string, unknown> }[]) {
          if (m.defines?.FF2_SUN_GROUND !== undefined) out.ground++
          if (m.defines?.FF2_CANOPY_OBJECT !== undefined) out.prop++
        }
      })
      return out
    })
    console.info(`DEV-296 roles: ${roles.ground} ground materials, ${roles.prop} prop materials`)
    expect(roles.ground, 'the LAND never got the ground role').toBeGreaterThan(0)
    expect(roles.prop, 'no prop material got the canopy role').toBeGreaterThan(0)

    // 3. The frame is darker, and MOST of it is untouched.
    expect(on.pixels.length).toBe(off.pixels.length)
    let darker = 0
    let same = 0
    let total = 0
    for (let i = 0; i < on.pixels.length; i++) {
      const d = (off.pixels[i] as number) - (on.pixels[i] as number)
      total += d
      if (d > 0.5) darker++
      else if (d > -0.5) same++
    }
    const mean = total / on.pixels.length
    console.info(
      `DEV-295 pixels: mean darkening ${mean.toFixed(2)} of 255, ` +
        `${((100 * darker) / on.pixels.length).toFixed(1)} % darker, ` +
        `${((100 * same) / on.pixels.length).toFixed(1)} % unchanged`,
    )
    // The frame moved. This is the assertion the dead build would have failed
    // and every unit test passed.
    expect(mean, 'the canopy term reached no pixel — is it spliced in?').toBeGreaterThan(0.5)
    // And it is a forest term and not a tint — but that claim is made about
    // the FIELD and not about this frame. DEV-297 raised the term until a
    // camera pointed at a forest left only 15 % of its pixels untouched, and
    // a pixel fraction cannot tell "the term is everywhere" from "the camera
    // is looking at trees". The world's own number can: `occludedPercent` is
    // how much of the GRID has any canopy over it, and it is the same number
    // whatever the camera does.
    expect(
      receipt.occludedPercent,
      'the canopy covers the whole map — this is a tint, not a forest',
    ).toBeLessThan(80)
    expect(receipt.occludedPercent, 'no ground is occluded at all').toBeGreaterThan(1)
    // Some pixels ARE untouched, which is the weakest useful form of the same
    // idea and survives any camera: a term with no locality at all leaves none.
    expect(same, 'not one pixel was left alone').toBeGreaterThan(0)
    // Nothing got BRIGHTER. A multiply by 1 - occlusion cannot, so this is a
    // sign check on the whole pipeline rather than a taste one.
    let brighter = 0
    for (let i = 0; i < on.pixels.length; i++) {
      if ((on.pixels[i] as number) - (off.pixels[i] as number) > 2) brighter++
    }
    expect(brighter / on.pixels.length, 'the canopy made pixels BRIGHTER').toBeLessThan(0.01)
  })
})
