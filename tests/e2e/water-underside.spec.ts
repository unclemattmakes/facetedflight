/**
 * The ocean, seen from under it — the launch-shaft ride.
 *
 * The platform starts at y = 19.8 and rises 106.65 m (`int_01_hoverJet.json`'s
 * `spawn.pos` and `spawn.launch.rise`) while the ocean surfaces around 116 m, so
 * the eye spends some 96 m of a 106 m climb **below the water** and then
 * breaches.
 * Nothing in the suite had ever looked at that: every screenshot spec stands
 * above the water.
 *
 * Six shots, all from the same spot over open sea north-west of the island —
 * `water-glint`'s x/z, where the seabed is 130 m down and nothing but water is
 * in frame — so the only variable between them is the eye's ALTITUDE relative
 * to the surface.
 *
 * Output goes to `WATER_SHOT_DIR`, NOT to `test-results/`: Playwright wipes
 * that at the start of every run, which loses the first half of any before/after
 * pair (CLAUDE.md, the fog-sweep trap).
 *
 *   WATER_SHOT_DIR=.../before pnpm exec playwright test tests/e2e/water-underside.spec.ts
 *
 * Tagged `@gpu`: headless Chromium falls back to SwiftShader, and every
 * judgement this spec exists to support is a judgement about shaded pixels.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

const SHOT_DIR = process.env.WATER_SHOT_DIR ?? 'test-results/screenshots/water'

/** `water-glint`'s stand: open sea, seabed 130 m down, no land in frame. */
const X = -563
const Z = 1889
/**
 * The ocean's BASE surface at this stand, read off the built geometry.
 *
 * Not 116.6. `src/boot/viewpoints.ts` quotes that and it is right near the map
 * origin (116.56 measured), but the ocean is a `FacetedTerrain` with its own
 * height map and carries 5,244 distinct base heights — 115.29 here, 117.63 off
 * the massif. Two oscillations then ride on top and they add: the whole-plate
 * bob, +/- 3.459 m at Simonet's plate origin, and the per-vertex wave, +/- 4 m.
 *
 * So the instantaneous surface here lives between about **107.8 and 122.8 m**,
 * and every altitude between those has water above the eye AND below it. Shots
 * 4 and 5 are inside that band on purpose: they are the breach, not a clean
 * "just under" and "at the surface", and the horizon line across them is the
 * waterline rather than an artifact.
 */
const SEA_LEVEL = 115.29

interface Shot {
  readonly name: string
  readonly y: number
  /** Where to look, absolute. */
  readonly look: readonly [number, number, number]
  readonly note: string
}

// Toward the sun, THREE space — `INT01_SUN_BEARING`, 4 degrees above the
// horizon. Every shot looks along it, because that is the bearing anything
// specular or transmitted is brightest on.
const SHOTS: readonly Shot[] = [
  {
    name: '1-deep-zenith',
    y: 60,
    look: [X, 60 + 200, Z],
    note: '55 m under, straight up: the ceiling, and Snell’s window if there is one',
  },
  {
    name: '2-deep-sunward',
    y: 60,
    look: [X - 692, 60 + 141, Z - 189],
    note: '55 m under, 45 degrees up toward the sun: the bright half of the window',
  },
  {
    name: '3-deep-along',
    y: 60,
    look: [X - 962, 60 + 70, Z - 263],
    note: "55 m under, along the sun's bearing: DEV-050's speckle shot",
  },
  {
    name: '4-just-under',
    y: SEA_LEVEL - 2.69,
    look: [X - 962, SEA_LEVEL - 2.69 + 70, Z - 263],
    note: '2.7 m under the base surface, inside the wave band: the breach, from below',
  },
  {
    name: '5-at-surface',
    y: SEA_LEVEL + 1.31,
    look: [X - 962, SEA_LEVEL + 1.31 + 70, Z - 263],
    note: '1.3 m above the base surface, still inside the wave band: the breach',
  },
  {
    name: '6-above',
    y: 150,
    look: [X - 962, 220, Z - 263],
    note: 'the control: 35 m above, which is where every other spec stands',
  },
]

test.describe('@measure @gpu water from below', () => {
  test.setTimeout(180_000)

  for (const shot of SHOTS) {
    test(`${shot.name} — ${shot.note}`, async ({ page }, testInfo) => {
      const eye = `${X},${shot.y},${Z}`
      const look = shot.look.join(',')
      // `xr=off` keeps the boot probe from starting SteamVR on every shot;
      // `ride=0` leaves the ship parked so the camera is the only thing moving;
      // `menu=0` implies `title=0` and puts the mission's world on screen —
      // without it the fixed camera is applied to a scene still showing the
      // title valley 30 km away, and every shot comes back as the logo.
      await page.goto(
        `/?view=cam&xr=off&ride=0&menu=0&eye=${encodeURIComponent(eye)}&look=${encodeURIComponent(look)}`,
      )
      await firstPress(page)
      await missionReady(page, 120_000)
      // The wave cycles every 3.14 s; let it settle so a shot is of the sea
      // rather than of a first frame.
      await page.waitForTimeout(2_000)

      // ── and put the overlay back down ───────────────────────────────────
      //
      // Vite watches the whole repo, so ANY write under it during a run — the
      // Playwright output directory most of all — is an HMR full reload, and a
      // reload puts the landing page back over the canvas. The first run of
      // this spec produced six screenshots of the marketing copy with the game
      // faintly visible behind it, and one hard failure ("Element is not
      // attached to the DOM") from a reload landing mid-screenshot.
      //
      // `--output` outside the repo removes the cause; this removes the
      // symptom, and it is idempotent, so it costs nothing when the cause is
      // already gone. The viewpoint comes from the URL, so a reload rebuilds
      // exactly the same scene.
      await page.evaluate(() => {
        const overlay = document.getElementById('overlay')
        if (overlay) overlay.hidden = true
      })

      const png = await page.locator('#viewport').screenshot()
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      fs.writeFileSync(path.join(SHOT_DIR, `${shot.name}.png`), png)
      await testInfo.attach(`${shot.name}.png`, { body: png, contentType: 'image/png' })

      // The camera really did go where it was asked. Without this a bad
      // parameter silently gives the default orbit and a plausible picture of
      // the wrong thing.
      await expect(page.locator('body')).toHaveAttribute('data-viewpoint', 'ad hoc')
    })
  }
})
