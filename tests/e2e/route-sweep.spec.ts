/**
 * Twenty frames along the race, for looking at the game without a headset.
 *
 * Matt: *"let's keep rolling without the headset as much as possible."* The
 * named viewpoints in `viewpoints.spec.ts` answer "is the water specular
 * right?" — a question you already know to ask. This answers "what does the
 * course actually look like", which is how the skirt-normal bug was found: it
 * showed as a pale dashed line down distant mountains in exactly four of these
 * frames and in none of the named shots, because no named shot shoots a
 * mountain across a chunk seam at fog range.
 *
 * Each stop is a route point, looking thirty points further along — roughly
 * where the pilot's eyes are, roughly what they are aimed at.
 *
 *   E2E_ROUTE_SWEEP=1 pnpm exec playwright test tests/e2e/route-sweep.spec.ts
 *
 * Off by default: it is a minute of wall clock and nothing in it can fail, so
 * it is a tool rather than a test. `FOG_SWEEP_FOG=off` shoots the same stops
 * with `?fog=off` for an A/B, and `FOG_SWEEP_DIR` sends the PNGs somewhere
 * Playwright will not wipe between runs — it clears `test-results/` on start,
 * which silently ate the first half of the A/B the first time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { test } from './fixtures/test'

const SHOT_DIR = process.env.FOG_SWEEP_DIR ?? 'route-sweep-out'
const route = JSON.parse(fs.readFileSync('content/levels/int_01_hoverJet.json', 'utf8')).route as [
  number,
  number,
  number,
][]

const STEP = 20
const LEAD = 30
const stops: { i: number; eye: [number, number, number]; look: [number, number, number] }[] = []
for (let i = 0; i + LEAD < route.length; i += STEP) {
  stops.push({
    i,
    eye: route[i] as [number, number, number],
    look: route[i + LEAD] as [number, number, number],
  })
}

test.describe('@measure @gpu route sweep', () => {
  test.skip(
    process.env.E2E_ROUTE_SWEEP !== '1',
    'set E2E_ROUTE_SWEEP=1 — this is a tool, not a test',
  )
  test.setTimeout(600_000)

  test('walk the route', async ({ page }, testInfo) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const fog = process.env.FOG_SWEEP_FOG ?? 'on'
    let first = true
    for (const s of stops) {
      const q = new URLSearchParams({
        view: 'cam',
        eye: s.eye.join(','),
        look: s.look.join(','),
        // Do not start OpenXR — see capability-gate's `xrProbeDisabled`.
        xr: 'off',
      })
      if (fog === 'off') q.set('fog', 'off')
      await page.goto(`/?${q}`)
      await firstPress(page)
      await missionReady(page, first ? 180_000 : 120_000)
      first = false
      // The waves and the gate particles are not fixed even though the camera
      // is, so a shot taken immediately is of a first frame, not of the scene.
      await page.waitForTimeout(1_200)
      const shot = await page.locator('#viewport').screenshot()
      const file = path.join(SHOT_DIR, `r${String(s.i).padStart(3, '0')}-${fog}.png`)
      fs.writeFileSync(file, shot)
      await testInfo.attach(path.basename(file), { body: shot, contentType: 'image/png' })
    }
  })
})
