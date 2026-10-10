/**
 * The lens opens with speed — in the real build, on the real camera (DEV-093).
 *
 * `flat-fov.test.ts` proves the arithmetic, the easing and the three places the
 * feature must not run, against a fake camera and a fake renderer. What it
 * cannot see is the WIRING, which is where every one of this port's real
 * findings has come from: that `boot/app.ts` constructs the thing, that it
 * hands it `forwardSpeedOf(flight)` and not something else, that the gate it
 * hands it is true during a live run, and that nothing downstream — the resize
 * handler, three, the quality controller — puts the lens back.
 *
 * So this reads `__ff2.render.camera.fov`, the property the frame is actually
 * drawn with, on a flying ship. Two runs of one URL:
 *
 *   · **anniversary** — the fov must RISE above the renderer's 70 as the
 *     autopilot's airspeed rises past the curve's floor;
 *   · **classic** — the same window, the same autopilot, and the fov must be
 *     EXACTLY 70 the whole way. Exactly, not approximately: the ease snaps to
 *     its target, so a Classic lens that is 70.0001 means something wrote to it.
 *
 * Tagged `@gpu` with the rest of the flying specs: it needs a real GPU to fly
 * at a sane rate.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/** `render/renderer.ts`'s camera, and both presets' `base: null`. */
const BASE_FOV = 70

interface Probe {
  elapsed: number
  edition: string
  fov: number
  /**
   * |velocity| in m/s.
   *
   * Not `ForwardSpeed` — that needs the body's orientation and a rotation, and
   * a spec should not reimplement a sim function to check a render one. In
   * level flight the two agree closely, and this is here to SAY what the
   * autopilot reached rather than to be asserted against: the assertion is on
   * the fov, which is the thing the frame is drawn with.
   */
  speed: number
}

const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        edition: { current: { id: string } }
        render: { camera: { fov: number } }
        flight: () => { jet: { body: { velocity: { x: number; y: number; z: number } } } } | null
      }
    }
    const v = w.__ff2?.flight()?.jet.body.velocity
    return {
      elapsed: w.__ff2?.mission.elapsed ?? 0,
      edition: w.__ff2?.edition.current.id ?? '',
      fov: w.__ff2?.render.camera.fov ?? -1,
      speed: v ? Math.hypot(v.x, v.y, v.z) : 0,
    }
  })) as Probe

/** Held, not tapped — `pause.spec.ts` says why, twice. */
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

/** Boot, launch, and wait for the clock to be genuinely moving. */
const flyUntilRunning = async (page: import('@playwright/test').Page, url: string) => {
  await page.goto(url)
  await firstPress(page)
  await missionReady(page, 180_000)
  await focusCanvas(page)
  await holdKey(page, 'Enter')
  await expect
    .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
    .toBeGreaterThan(2)
  const mark = (await probe(page)).elapsed
  await expect
    .poll(async () => (await probe(page)).elapsed, { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(mark)
}

/**
 * Watch the lens and the speed for `seconds`, at about 10 Hz.
 *
 * A poll rather than a single late sample: the whole feature is a thing that
 * MOVES, and the failure that would survive one sample is a lens that opened
 * once and stuck.
 */
const watch = async (
  page: import('@playwright/test').Page,
  seconds: number,
): Promise<{ fovs: number[]; speeds: number[] }> => {
  const fovs: number[] = []
  const speeds: number[] = []
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const p = await probe(page)
    fovs.push(p.fov)
    speeds.push(p.speed)
    await page.waitForTimeout(100)
  }
  return { fovs, speeds }
}

test.describe('@gpu the lens opens with speed, on the flat build', () => {
  test.setTimeout(300_000)

  test('anniversary: the fov rises above 70 as the autopilot gets going', async ({ page }) => {
    await flyUntilRunning(page, '/?autopilot=1&xr=off')
    expect((await probe(page)).edition).toBe('anniversary')

    const { fovs, speeds } = await watch(page, 40)
    const topFov = Math.max(...fovs)
    const topSpeed = Math.max(...speeds)
    // What the autopilot actually reaches, printed rather than assumed — the
    // curve was argued from `derived.hoverjet.terminalSpeedBoost` (179.6) and
    // this is where that argument meets the lap.
    console.info(
      `flat-fov: top |v| ${topSpeed.toFixed(1)} m/s, fov ${Math.min(...fovs).toFixed(2)}` +
        `..${topFov.toFixed(2)} over ${fovs.length} samples`,
    )

    // The autopilot boosts on the straights; if it never passed the curve's
    // floor the premise of this test is gone and the message should say so
    // rather than the fov assertion failing mysteriously.
    expect(topSpeed, 'the autopilot never got above the curve floor').toBeGreaterThan(95)
    expect(topFov, 'the lens never opened').toBeGreaterThan(BASE_FOV)
    // And it is a lens, not a fisheye: the curve tops out at +9°.
    expect(topFov).toBeLessThan(BASE_FOV + 12)
    // It never goes NARROWER than the base — the curve is non-negative and the
    // ease is one-sided about it.
    expect(Math.min(...fovs)).toBeGreaterThanOrEqual(BASE_FOV)
    // It MOVES. A lens that opened once and stuck would pass every assertion
    // above and be a bug.
    expect(new Set(fovs.map((f) => f.toFixed(3))).size).toBeGreaterThan(3)
  })

  test('classic: exactly 70 through the same window', async ({ page }) => {
    await flyUntilRunning(page, '/?autopilot=1&xr=off&edition=classic')
    expect((await probe(page)).edition).toBe('classic')

    const { fovs, speeds } = await watch(page, 40)
    console.info(`flat-fov classic: top |v| ${Math.max(...speeds).toFixed(1)} m/s`)
    // The same premise: if the ship never got fast, this proves nothing.
    expect(Math.max(...speeds), 'the autopilot never got above the curve floor').toBeGreaterThan(95)
    // EXACTLY. The ease snaps to its target, so 70.0001 means something wrote.
    for (const fov of fovs) expect(fov).toBe(BASE_FOV)
  })

  test('a fixed viewpoint keeps a fixed lens — ?view=cam is a photography tool', async ({
    page,
  }) => {
    // The fourth "no" this feature has and the cockpit shake does not. Two
    // screenshots of one viewpoint have to be the same screenshot, which is the
    // property `boot/viewpoints.ts` exists to give; a lens that breathed under
    // a fixed camera would quietly take that away from every A/B pair in the
    // repo. `?view=cam` does not fly, so there is no launch to wait for.
    await page.goto('/?autopilot=1&xr=off&view=cam&cam=island-lit')
    await firstPress(page)
    await missionReady(page, 180_000)
    const { fovs } = await watch(page, 8)
    expect(fovs.length).toBeGreaterThan(20)
    for (const fov of fovs) expect(fov).toBe(BASE_FOV)
  })
})
