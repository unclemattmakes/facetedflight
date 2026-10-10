/**
 * Screenshots of specific things, from cameras that can be aimed.
 *
 * Matt: *"i'd like you to setup camera positions to specifically take
 * screenshots."* The orbit views cannot be pointed at anything, and half a
 * session went on not being able to see the sea's specular — a glint off a sun
 * four degrees above the horizon, visible only when you look along its bearing.
 *
 * `pnpm exec playwright test tests/e2e/viewpoints.spec.ts` writes one PNG per
 * viewpoint into `test-results/screenshots/`. Add a viewpoint in
 * `src/boot/viewpoints.ts` and it appears here; nothing needs editing twice.
 *
 * Tagged `@gpu` like the other screenshot specs: headless Chromium falls back to
 * SwiftShader and produces an image nobody should judge colour from.
 */
import fs from 'node:fs'
import path from 'node:path'
import { VIEWPOINTS } from '../../src/boot/viewpoints'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/**
 * Where the PNGs land. Point it somewhere else for an A/B.
 *
 * Playwright wipes `test-results/` at the start of every run, so a before/after
 * pair taken across two runs loses its first half — the fog-sweep trap in
 * CLAUDE.md, and `water-underside.spec.ts` already carries the same escape
 * hatch as `WATER_SHOT_DIR`.
 */
const SHOT_DIR = process.env.VIEWPOINT_SHOT_DIR ?? 'test-results/screenshots'

/**
 * Extra query parameters, `a=b&c=d` — a pin that can only be taken as a LOAD.
 *
 * `perf-scale.spec.ts`'s `SCALE_PARAMS`, for the same reason: `?ocean=<n>`
 * decides the mesh every chunk is built with, so it cannot be flipped on a
 * world that is already drawn. It is what makes an A/B of DEV-183's ladder two
 * runs of ONE build rather than a comparison across a rebuild.
 *
 * The switches below are still set here and win on a collision, because they
 * are what makes a viewpoint frame a viewpoint frame.
 */
const EXTRA = new URLSearchParams(process.env.VIEWPOINT_PARAMS ?? '')

test.describe('@measure @gpu viewpoints', () => {
  test.setTimeout(180_000)

  for (const [name, vp] of Object.entries(VIEWPOINTS)) {
    test(`${name} — ${vp.note}`, async ({ page }, testInfo) => {
      // `xr=off` keeps the boot probe from starting SteamVR on every shot.
      //
      // `ride=0` because the LAND is hidden while the lift is in the shaft
      // (DEV-106: nothing of the world is inside the launch room), and under
      // `?view=cam` the lift sits `waiting` at rise 0 for ever. From 2026-09-14
      // to DEV-115 every frame this spec took was sea and sky with the island
      // missing, and the spec was green, because it asserts where the camera
      // IS and said nothing about what was in front of it. `ride=0` is a
      // player's own switch (the platform starts at the top), not a test path.
      const query = new URLSearchParams(EXTRA)
      query.set('view', 'cam')
      query.set('xr', 'off')
      query.set('ride', '0')
      query.set('cam', name)
      await page.goto(`/?${query.toString()}`)
      await firstPress(page)
      await missionReady(page, 120_000)
      // The loud counterpart: the world is actually DRAWN. `world-terrain` is
      // the land group `app.ts` names; a hidden one is DEV-095's shape again.
      const landVisible = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2?: {
            render: {
              scene: { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
            }
          }
        }
        let visible: boolean | null = null
        w.__ff2?.render.scene.traverse((o) => {
          if (o.name === 'world-terrain') visible = o.visible === true
        })
        return visible
      })
      expect(landVisible, 'the land is drawn in a viewpoint frame').toBe(true)
      // The viewpoint is fixed, but the waves and the gate particles are not —
      // give them a moment so a shot is of a settled scene rather than of a
      // first frame.
      await page.waitForTimeout(2_000)

      const shot = await page.locator('#viewport').screenshot()
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      const file = path.join(SHOT_DIR, `cam-${name}.png`)
      fs.writeFileSync(file, shot)
      await testInfo.attach(`${name}.png`, { body: shot, contentType: 'image/png' })

      // The camera really did go where it was asked. Without this a typo in the
      // name silently gives you the default orbit and a plausible-looking
      // screenshot of the wrong thing.
      await expect(page.locator('body')).toHaveAttribute('data-viewpoint', vp.note)

      // ...and it is STILL there, in WORLD space, at the moment of the shot.
      //
      // The attribute above is set by the same code that applies the viewpoint,
      // so on its own it is trap 24: the test asserting what the code just
      // said. From 2026-09-11 (the title screen) to DEV-095 every one of these
      // frames was the alpine title valley with the logo in it, and this spec
      // was green throughout — the camera had been placed at the viewpoint and
      // then carried 30 km away by the rig the title parks. The world position
      // is a fact the title cannot agree with.
      const at = await page.evaluate(() => {
        // The translation column of `matrixWorld`, which is what
        // `getWorldPosition` reads — done by hand because the page has no
        // `THREE.Vector3` to hand it, and a plain object is not one.
        const w = globalThis as unknown as {
          __ff2?: {
            render: {
              camera: {
                updateWorldMatrix(parents: boolean, children: boolean): void
                matrixWorld: { elements: ArrayLike<number> }
              }
            }
          }
        }
        const cam = w.__ff2?.render.camera
        if (!cam) return [Number.NaN, Number.NaN, Number.NaN]
        cam.updateWorldMatrix(true, false)
        const e = cam.matrixWorld.elements
        return [e[12], e[13], e[14]]
      })
      for (let i = 0; i < 3; i++) expect(at[i], `eye[${i}]`).toBeCloseTo(vp.eye[i] as number, 3)
    })
  }
})
