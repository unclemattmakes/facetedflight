/**
 * Twelve frames aimed INTO the sun, for measuring what a terrain-material
 * change is worth in pixels.
 *
 * Written for DEV-008's last open line — `_SpecColor` on the land, which
 * `MeshStandardMaterial` cannot carry — where the whole question is *is the
 * term it tints big enough to see*. The answer has to be a number, and the
 * only honest way to get one is to shoot the same frames twice and diff them.
 *
 *   SPEC_SWEEP=1 SPEC_SWEEP_TAG=a pnpm exec playwright test tests/e2e/spec-sweep.spec.ts
 *   ...edit the material...
 *   SPEC_SWEEP=1 SPEC_SWEEP_TAG=b pnpm exec playwright test tests/e2e/spec-sweep.spec.ts
 *
 * and diff the two tags with `decodePngBuffer` from `tools/terrain/png.mjs` —
 * mean |delta| per channel in 8-bit sRGB, and the fraction of pixels that moved
 * by 2 or more.
 *
 * Off by default: it is a tool, not a test, and nothing in it can fail.
 *
 * ── Three choices worth stating ──────────────────────────────────────────
 *
 * **Aimed at the sun**, not along the route. A specular lobe is brightest where
 * the eye, the normal and the light line up, so a sweep that shoots the course
 * the way `route-sweep.spec.ts` does measures the specular where it is smallest
 * and would flatter any answer. `sun.direction` is where the light TRAVELS, so
 * the camera looks along `-direction`.
 *
 * **All four environments.** The thing being measured is per-terrain and the
 * four land terrains disagree about it by a factor of eight — Simonet and Kauai
 * author `_SpecInt` 0.05, alpine 0.2, desert 0.4. Measuring on Simonet alone is
 * the agreement lesson in miniature: the one environment everybody looks at is
 * also the one where the term is weakest.
 *
 * **A noise floor, taken the same way.** The waves and the gate particles run
 * off a wall clock, so two runs of this spec are not the same image even with
 * no code change at all. Shoot tag `a` twice before believing any `a` vs `b`
 * number; a delta under the floor is not a result.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { test } from './fixtures/test'

const SHOT_DIR = process.env.SPEC_SWEEP_DIR ?? 'spec-sweep-out'
const TAG = process.env.SPEC_SWEEP_TAG ?? 'a'

/** One mission per environment, and the route stops to stand at. */
const MISSIONS: { id: string; env: string; stops: number[] }[] = [
  { id: 'int_01_hoverJet', env: 'simonet', stops: [40, 180, 320] },
  { id: 'rookie_01_hoverJet', env: 'alpine', stops: [40, 180, 320] },
  { id: 'rookie_02_hoverJet', env: 'desert', stops: [40, 180, 320] },
  { id: 'hoverJet_kauai_beg', env: 'kauai', stops: [40, 180, 320] },
]

type Level = {
  route: [number, number, number][]
  lighting?: { sun?: { direction?: number[] } | null } | null
}

/** How far down the sightline the look-at point sits. Any distance does. */
const LOOK_METRES = 400

/**
 * Metres above the route point the eye stands.
 *
 * Not cosmetic. Simonet and Kauai are lit from **4 degrees above the horizon**,
 * so "stand on the racing line and look at the sun" aims along a nearly
 * horizontal line through a valley — and the first run put three of Kauai's
 * frames flat against a hillside twenty metres away, which renders as vertical
 * stripes and measures nothing. DEV-041's rule applies to a measurement rig as
 * much as to a title camera: **prefer a placement that cannot be wrong over a
 * score that is usually right.** Above the ridges, occlusion is impossible
 * rather than unlikely.
 */
const EYE_LIFT = 120

test.describe('@measure @gpu spec sweep', () => {
  test.skip(process.env.SPEC_SWEEP !== '1', 'set SPEC_SWEEP=1 — this is a tool, not a test')
  test.setTimeout(900_000)

  test('shoot every environment into the sun', async ({ page }, testInfo) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    let first = true
    for (const m of MISSIONS) {
      const level = JSON.parse(fs.readFileSync(`content/levels/${m.id}.json`, 'utf8')) as Level
      const d = level.lighting?.sun?.direction ?? [0, -1, 0]
      // TOWARD the sun: `direction` is where the light travels.
      const toSun = [-(d[0] as number), -(d[1] as number), -(d[2] as number)]
      for (const i of m.stops) {
        const p = level.route[Math.min(i, level.route.length - 1)] as [number, number, number]
        const eye: [number, number, number] = [p[0], p[1] + EYE_LIFT, p[2]]
        // `SPEC_SWEEP_AIM=route` looks thirty route points ahead instead —
        // "what does the course look like" rather than "where is the specular
        // biggest". Two different questions, and only the second one wants the
        // camera pointed at the sun.
        const ahead = level.route[Math.min(i + 30, level.route.length - 1)] as [
          number,
          number,
          number,
        ]
        // `SPEC_SWEEP_AIM=overview` stands 3 km up and looks straight down —
        // the one framing where occlusion is impossible rather than unlikely
        // (DEV-041), for answering "is this environment placed correctly at
        // all" before asking anything subtler about it.
        if (process.env.SPEC_SWEEP_AIM === 'overview') {
          eye[1] = p[1] + 3000
        }
        const look: [number, number, number] =
          process.env.SPEC_SWEEP_AIM === 'overview'
            ? [p[0] + 1, p[1], p[2]]
            : process.env.SPEC_SWEEP_AIM === 'route'
              ? ahead
              : [
                  eye[0] + (toSun[0] as number) * LOOK_METRES,
                  eye[1] + (toSun[1] as number) * LOOK_METRES,
                  eye[2] + (toSun[2] as number) * LOOK_METRES,
                ]
        const q = new URLSearchParams({
          mission: m.id,
          view: 'cam',
          eye: eye.join(','),
          look: look.join(','),
          // Do not start OpenXR — see capability-gate's `xrProbeDisabled`.
          xr: 'off',
          // The title and the hangar ride are not what is being measured.
          title: '0',
          menu: '0',
          ride: '0',
        })
        await page.goto(`/?${q}`)
        await firstPress(page)
        await missionReady(page, first ? 180_000 : 120_000)
        first = false
        await page.waitForTimeout(1_200)
        const shot = await page.locator('#viewport').screenshot()
        const file = path.join(SHOT_DIR, `${m.env}-${String(i).padStart(3, '0')}-${TAG}.png`)
        fs.writeFileSync(file, shot)
        await testInfo.attach(path.basename(file), { body: shot, contentType: 'image/png' })
      }
    }
  })
})
