/**
 * The screenshot. M0.6's real exit criterion.
 *
 * Everything up to here proved the terrain is right in numbers: 256 chunks
 * matching the 2016 bake on vertex count, skirt topology and placement exactly,
 * and on mean height to 5 cm rms. None of that proves it is right on screen. A
 * mirrored world, a mis-signed normal, a colour attribute read as linear when
 * it is sRGB — all of those survive every unit test in the repo and are obvious
 * the moment you look.
 *
 * So this spec looks. It drives the real app against the real maps, waits for
 * generation of ~1.8 M vertices to finish, and saves a PNG.
 *
 * ── @gpu, and why ────────────────────────────────────────────────────────
 *
 * Tagged `@gpu` because it is exactly the kind of spec playwright.config.ts's
 * tag mechanism was built for: headless Chromium falls back to SwiftShader, and
 * a software rasteriser both takes minutes over 2,312 triangles x 256 chunks
 * and produces an image nobody should be judging colour from. CI runs
 * `E2E_SKIP_GPU=1` and skips it; a human runs it headed on a real GPU.
 *
 * This is the first `@gpu` spec in the repo, which means it is also the first
 * exercise of that mechanism.
 *
 * ── What it asserts, and what it does not ────────────────────────────────
 *
 * It does NOT do a pixel diff against a golden image. Not yet: the lighting is
 * still placeholder (DEV-008), so a golden would pin down values we already
 * know are wrong and would have to be re-blessed the moment the shader lands.
 * Pixel diffing arrives with the shader it is meant to protect.
 *
 * What it asserts is the set of things that are cheap, stable, and catch a
 * catastrophic render: the terrain actually loaded, the scene is not a single
 * flat colour, and the frame is not mostly sky.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

/** Where the milestone screenshot lands. Gitignored; it is a build artifact. */
const SHOT_DIR = 'test-results/screenshots'

test.describe('@measure @gpu terrain', () => {
  // Generating every chunk at LOD 0 up front is a placeholder (see
  // load-terrain.ts) and takes a few seconds on top of two megapixel PNGs.
  test.setTimeout(120_000)

  for (const view of ['wide', 'low'] as const) {
    test(`renders Simonet Islands (${view}) and saves the screenshot`, async ({
      page,
    }, testInfo) => {
      const problems = watchPageErrors(page)

      // `xr=off` keeps the boot probe from starting SteamVR on every shot.
      // `menu=0` boots the MISSION world. Since DEV-281 a plain load boots the
      // title and builds no island, and an orbit view (`wide`, `low`) is not a
      // viewpoint, so without it `data-terrain-ready` never came.
      await page.goto(`/?view=${view}&menu=0&xr=off`)
      // Dismiss the landing overlay — it covers the canvas.
      await firstPress(page)

      // `data-terrain-ready` is set by boot/app.ts once the group is in the
      // scene. There is no way to know from out here when 1.8 M vertices have
      // finished generating, and a fixed sleep would be a flake generator.
      await missionReady(page, 90_000)
      await expect(page.locator('body')).not.toHaveAttribute('data-terrain-error', /.*/)

      // Let the orbit advance a little and the first frames settle.
      await page.waitForTimeout(1_500)

      const shot = await page.locator('#viewport').screenshot()
      await testInfo.attach(`simonet-islands-${view}.png`, { body: shot, contentType: 'image/png' })
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      const shotPath = path.join(SHOT_DIR, `simonet-islands-${view}.png`)
      fs.writeFileSync(shotPath, shot)
      testInfo.annotations.push({ type: 'screenshot', description: shotPath })

      // ── Is there actually a world in the frame? ──────────────────────────
      //
      // Analysed from the PNG the browser produced, NOT by reading the canvas
      // back in-page. Without `preserveDrawingBuffer` the WebGL drawing buffer is
      // cleared after compositing, so an in-page `drawImage(glCanvas)` samples an
      // empty surface and reports one flat colour for a perfectly good frame.
      // That is exactly what the first version of this spec did, and it "failed"
      // against a correct render.
      const img = decodePngBuffer(shot, 'viewport')
      const seen = new Set<string>()
      let lit = 0
      let skyish = 0
      const pixels = img.width * img.height
      for (let i = 0; i < pixels; i++) {
        const o = i * img.channels
        const r = img.data[o] as number
        const g = img.data[o + 1] as number
        const b = img.data[o + 2] as number
        // Quantise to 5 bits per channel: counting exact colours would mostly
        // measure dithering, and the faceted look means real variety is coarse.
        seen.add(`${r >> 3},${g >> 3},${b >> 3}`)
        if (r + g + b > 24) lit++
        // The sky is a flat fill of SKY.top (0x93c4f0). Terrain is warmer, so a
        // frame that is ALL sky has the island off-camera.
        if (b > r && b > g && b > 180) skyish++
      }

      // ── A deliberate floor, not a fingerprint ──────────────────────────
      //
      // The exact colour count moves every time the lighting gets more
      // faithful, and chasing it teaches nothing: it read 200+ under an
      // invented noon sun, 86 once the real 4-degree sunset landed, and ~183
      // once the fog stopped being three's `FogExp2` stand-in. Re-tuning a
      // threshold after each of those is just re-blessing whatever rendered.
      //
      // So this asserts the thing that actually stays true — the frame is not
      // uniform. A blank canvas, a solid sky, or a cleared drawing buffer all
      // score 1 to 5. Anything with terrain in it clears 60 by a wide margin.
      // Judging whether it looks RIGHT is what the attached PNG is for; the
      // golden-image diff waits for the shader (DEV-008).
      expect(seen.size, `distinct colours in ${img.width}x${img.height}`).toBeGreaterThan(60)
      // Almost the whole frame should be painted. A dark frame is a failed
      // render, not a dark scene.
      expect(lit / pixels).toBeGreaterThan(0.9)
      // And the island has to be IN it — not merely somewhere in the scene graph.
      expect(skyish / pixels, 'fraction of the frame that is flat sky').toBeLessThan(0.9)

      expect(problems.list(), problems.list().join('\n')).toEqual([])
    })
  }
})
